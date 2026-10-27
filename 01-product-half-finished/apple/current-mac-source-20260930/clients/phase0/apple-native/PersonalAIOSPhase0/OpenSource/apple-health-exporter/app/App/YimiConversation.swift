import Combine
import Foundation
import UIKit

/// The conversation timeline. The session facade (AssistantViewModel) only keeps the current reply and the last call
/// in memory, so the UI layer turns its published state into durable items: typed and spoken requests, her replies
/// (one item per processed event, updated in place while it streams), and every call turn in the same timeline.
/// Items are stored on the device only (Application Support, file protection until first unlock).
@MainActor
final class YimiConversation: ObservableObject {
    @Published private var timeline = YimiConversationTimeline()
    var items: [YimiItem] { timeline.items }
    var watchItems: [YimiItem] {
        let owner = vm.ownerProjectionIdentity
        return timeline.latestAssistantItem(ownerIdentity: owner).map { [$0] } ?? []
    }
    var watchChanges: AnyPublisher<Void, Never> {
        $timeline.combineLatest(vm.$ownerProjectionIdentity)
            .map { $0.latestAssistantItem(ownerIdentity: $1) }
            .removeDuplicates().map { _ in () }.eraseToAnyPublisher()
    }
    var chatItems: [YimiItem] { timeline.chatItems }
    func callLines(_ callID: String?) -> [YimiItem] { timeline.callLines(callID) }
    @Published private(set) var unread = 0
    /// Local sends return chat to the latest row; remote timeline updates preserve the reading position.
    @Published private(set) var sendRevision: UInt64 = 0
    @Published private(set) var listeningText = ""
    var chatVisible = false { didSet { if chatVisible { unread = 0; Task { await acknowledgeShown() } } } }

    private unowned let vm: AssistantViewModel
    private var bag = Set<AnyCancellable>()
    private let renderedACKs = YimiRenderedACKQueue()
#if DEBUG
    private var activityFixturePackets: [Data] = []
    var hasActivityFixture: Bool { !activityFixturePackets.isEmpty }
    private(set) var hasChatFixture = false
#endif
    private var autoSendVoice = false
    /// The spoken request whose delivery the current voice turn reports.
    private var sendingVoiceItem: String?
    /// The press window as central reports it: speech is captured only once it is `.recording`.
    @Published private(set) var lastVoicePhase: CentralVoiceTurn.Phase?
    private var saveTask: Task<Void, Never>?
    private let store: YimiConversationStore?
    private let writer = YimiTimelineWriter()
    private var saveVersion: UInt64 = 0
    /// False while the file exists but cannot be read (device locked since boot, I/O error): nothing is written
    /// over history that was never loaded; the load is retried when protected data becomes available.
    private var storeReadable = true
    private var historyEpoch: String?
    private var historyGeneration: UInt64 = 0

    init(vm: AssistantViewModel) {
        self.vm = vm
        let folder = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                   appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        store = YimiConversationStore(folder: folder, pairing: try? PairedRealtimeRequestBodyProvider().pairing())
        historyEpoch = store?.historyEpoch()
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"),
           let json = ProcessInfo.processInfo.environment["YIMI_CHAT_FIXTURES"] {
            do {
                struct Fixture: Decodable { let count: Int; let hugeHistory: Bool; let oldCompanion: Bool? }
                let fixture = try JSONDecoder().decode(Fixture.self, from: Data(json.utf8))
                let now = Date()
                let longRows = [fixture.count - 100: 72_256, fixture.count - 50: 29_165]
                let rows = (0..<fixture.count).map { index in
                    let companion = fixture.oldCompanion == true && index == 0
                    let text: String
                    if companion { text = "10-18 随身回复" }
                    else if fixture.hugeHistory, let length = longRows[index] {
                        text = String(String(repeating: "历史中的完整长回复。", count: length / 10 + 1).prefix(length))
                    } else { text = index == fixture.count - 1 ? "最近一条历史" : "历史 \(index)：这是一条完整保留的历史消息，用于验证聊天窗口。" }
                    return YimiItem(id: "fixture-history-\(index)", kind: .her, text: text,
                                    date: now.addingTimeInterval(companion ? -8 * 86_400 : Double(index - fixture.count) * 60),
                                    via: companion ? "ambient" : nil)
                }
                timeline = YimiConversationTimeline(items: rows)
                hasChatFixture = true
            } catch { fatalError("Invalid chat UI fixture: \(error)") }
        }
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"),
           let json = ProcessInfo.processInfo.environment["YIMI_ACTIVITY_FIXTURES"] {
            do {
                let packets = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]]
                activityFixturePackets = try packets.map { try JSONSerialization.data(withJSONObject: $0) }
                if hasChatFixture {
                    for packet in activityFixturePackets { _ = try vm.receiveActivityFixture(packet) }
                } else {
                    let update = try vm.receiveActivityFixture(activityFixturePackets[0])
                    timeline.upsert(YimiItem(id: "me-activity-fixture", kind: .me, text: "打开云手机，顺便把这几件事一起办。",
                        date: Date(), submissionProcessedID: update.processed_event_id))
                }
            } catch { fatalError("Invalid activity UI fixture: \(error)") }
        } else if !hasChatFixture { loadStore() }
#else
        loadStore()
#endif
#if DEBUG
        // A UI-test reply of this many characters, shaped like the N13 receipt-fact flood (one fact per line).
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"),
           let count = ProcessInfo.processInfo.environment["YIMI_LONG_REPLY_CHARACTERS"].flatMap(Int.init) {
            let line = "directories[0].path：/Users/fixture/Desktop，来源 desktop relay。\n"
            timeline.upsert(YimiItem(id: "her-long-fixture", kind: .her,
                text: String(repeating: line, count: count / line.count + 1), date: Date()))
        }
#endif
        vm.$centralPresentation.compactMap { $0 }.map { [unowned vm] in ($0, vm.ownerProjectionIdentity) }
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.reply($0.0, identity: $0.1) }.store(in: &bag)
        // Synchronous, in projection order: a row is never settled by a snapshot older than its own send.
        vm.$centralSnapshot.compactMap { $0 }
            .sink { [weak self] in self?.settleTypedSends($0) }.store(in: &bag)
        vm.$terminalState.removeDuplicates { $0.ownerIdentity == $1.ownerIdentity && $0.timeline.revision == $1.timeline.revision && $0.historyEpochConfirmed == $1.historyEpochConfirmed && $0.historyResetID == $1.historyResetID }
            .receive(on: RunLoop.main)
            .sink { [weak self] state in
                guard let self else { return }
                guard state.historyGeneration >= self.historyGeneration else { return }
                if state.historyEpochConfirmed { self.historyGeneration = state.historyGeneration }
                if state.historyEpochConfirmed, let epoch = state.historyEpoch, epoch != self.historyEpoch {
                    self.historyEpoch = epoch
                    self.timeline = YimiConversationTimeline()
                    self.storeReadable = true
                    self.scheduleSave()
                }
                if self.timeline.merge(state.timeline, ownerIdentity: state.ownerIdentity) { self.scheduleSave() }
            }.store(in: &bag)
        vm.$call.map { [unowned vm] in ($0, vm.ownerProjectionIdentity) }
            .removeDuplicates { (left: (CentralCall, String?), right: (CentralCall, String?)) -> Bool in
                left.0 == right.0 && left.1 == right.1
            }.receive(on: RunLoop.main)
            .sink { [weak self] in self?.callChanged($0.0, identity: $0.1) }.store(in: &bag)
        vm.$voiceTurn.removeDuplicates().receive(on: RunLoop.main)
            .sink { [weak self] in self?.voiceChanged($0) }.store(in: &bag)
        vm.$ambientReplies.map { [unowned vm] in ($0, vm.ownerProjectionIdentity) }
            .removeDuplicates { (left: ([CentralAmbientReply], String?), right: ([CentralAmbientReply], String?)) -> Bool in
                left.0 == right.0 && left.1 == right.1
            }.receive(on: RunLoop.main)
            .sink { [weak self] in self?.ambientReplied($0.0, identity: $0.1) }.store(in: &bag)
        vm.$careCheckins.map { [unowned vm] in ($0, vm.ownerProjectionIdentity) }
            .removeDuplicates { (left: ([CentralAmbientReply], String?), right: ([CentralAmbientReply], String?)) -> Bool in
                left.0 == right.0 && left.1 == right.1
            }.receive(on: RunLoop.main)
            .sink { [weak self] in self?.ambientReplied($0.0, identity: $0.1) }.store(in: &bag)
        NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.loadStore() }.store(in: &bag)
    }

    var last: YimiItem? { chatItems.last }

    // MARK: requests

    /// Sends typed text through the facade. The line joins the timeline only once the session took it, so a
    /// refused or failed send stays in the composer instead of looking sent.
    func send(_ text: String, question: AssistantQuestionSelection? = nil) async -> AssistantViewModel.PromptSubmission {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .unavailable }
#if DEBUG
        if hasChatFixture {
            let id = UUID().uuidString
            timeline.upsert(YimiItem(id: "me-" + id, kind: .me, text: text, date: Date()))
            sendRevision &+= 1
            Task { @MainActor [weak self] in
                try await Task.sleep(for: .seconds(2))
                self?.timeline.upsert(YimiItem(id: "her-" + id, kind: .her, text: "回复：" + text, date: Date()))
            }
            return .submitted
        }
        if hasActivityFixture {
            do {
                let update = try vm.receiveActivityFixture(activityFixturePackets.last!)
                timeline.upsert(YimiItem(id: "her-" + update.processed_event_id, kind: .her, text: "云手机已打开。", date: Date()))
                sendRevision &+= 1
                return .submitted
            } catch { fatalError("Invalid activity completion fixture: \(error)") }
        }
#endif
        let identity = vm.ownerProjectionIdentity
        let eventID = UUID().uuidString.lowercased()
        let result = await vm.submit(text, question: question, eventID: eventID)
        if result == .submitted {
            // Central rows start sending; Core's submissionDelivery then settles them.
            append(YimiItem(id: "me-" + eventID, kind: .me, text: text, date: Date(),
                delivery: vm.textOwner == .centralCandidate ? .sending : nil), identity: identity)
            if let snapshot = vm.centralSnapshot { settleTypedSends(snapshot) }
            sendRevision &+= 1
        }
        return result
    }

    var canTalk: Bool { vm.sessionState.isActive }

    /// Hold to talk, press `press`: the coordinator takes the microphone for this window only and opens it; a
    /// release that already happened (or happens meanwhile) wins and nothing records.
    func beginVoice(press: UInt64) async -> Bool {
        listeningText = ""
        return await vm.pressVoice(press)
    }

    /// Release: send the best transcript automatically (the prototype's one-gesture flow); slide-up cancels. A
    /// press released before its window opened is cancelled. Returns whether the window was committed.
    func endVoice(press: UInt64, cancel: Bool) async -> Bool {
        autoSendVoice = !cancel
        let committed = await vm.releaseVoice(press, cancel: cancel)
        if !committed { autoSendVoice = false }
        return committed
    }

    /// The resend is a new request; the new line replaces the old one.
    func canResend(_ item: YimiItem) -> Bool { item.offersTextResend }

    func resent(_ item: YimiItem) {
        if sendingVoiceItem == item.id { sendingVoiceItem = nil }
        timeline.remove(ids: [item.id])
        scheduleSave()
    }

    // MARK: facade state -> items

    private func reply(_ presentation: CentralTextPresentation, identity: String?) {
        let key = ((try? presentation.packet.fields.value("processed_event_id", as: String.self)) ?? nil)
            ?? "text-" + String(presentation.text.prefix(24))
        let text = QwenHandoff.split(presentation.text).display
        guard !text.isEmpty else { return }
        let id = "her-" + key
        let before = timeline.revision
        if var item = timeline.item(id: id) {
            item.text = text
            item.privacy = presentation.privacy ?? item.privacy
            item.ownerIdentity = identity
            if timeline.item(id: id) != item { timeline.upsert(item) }
        } else {
            append(YimiItem(id: id, kind: .her, text: text, date: Date(), privacy: presentation.privacy), identity: identity)
            if !chatVisible { unread += 1 }
        }
        if timeline.revision != before { scheduleSave() }
        // "Rendered" means shown and kept: the ACK waits until the chat is on screen and the timeline is saved.
        if presentation.isFinal {
            renderedACKs.enqueue(presentation, id: id)
            Task { await acknowledgeShown() }
        }
    }

    private func acknowledgeShown() async {
        await renderedACKs.drain(visible: chatVisible, save: { await self.saveNow() },
            send: { await self.vm.centralTextSurfaceConsumed($0) })
    }

    /// A wake turn heard in 随身模式 and her answer: the request as said aloud, then the reply (once per processed event).
    private func ambientReplied(_ replies: [CentralAmbientReply], identity: String?) {
        for reply in replies {
            let isNew = timeline.item(id: "her-" + reply.id) == nil
            timeline.accept(reply, ownerIdentity: identity)
            if isNew && !chatVisible { unread += 1 }
        }
        scheduleSave()
    }

    /// Call turns were heard aloud, so they never count as unread.
    private func callChanged(_ call: CentralCall, identity: String?) {
        guard call.id != nil else { return }
        timeline.accept(call, ownerIdentity: identity)
        scheduleSave()
    }

    /// The facade republishes voiceTurn with every central snapshot, so side effects follow phase transitions only.
    /// The temporary microphone is the coordinator's: it closes when the window is cut, whatever the send does.
    private func voiceChanged(_ turn: CentralVoiceTurn) {
        listeningText = turn.preview
        let previous = lastVoicePhase
        lastVoicePhase = turn.phase
        guard turn.phase != previous else { return }
        if let candidate = turn.selectedCandidate {
            sendingVoiceItem = timeline.accept(candidate, eventID: turn.eventID)
            scheduleSave()
        }
        switch turn.phase {
        case .ready:
            // Core makes a window ready only with a spoken transcript; an empty one already ended as 没听清.
            guard autoSendVoice, let best = turn.candidates.first else { return }
            autoSendVoice = false
            let id = timeline.accept(best, eventID: turn.eventID)
            scheduleSave()
            sendingVoiceItem = id
            Task {
                let sent = await vm.sendVoiceCandidate(best)
                if !sent { self.setDelivery(id, .failed); if self.sendingVoiceItem == id { self.sendingVoiceItem = nil } }
            }
        case .sending:
            sendRevision &+= 1
            if let id = sendingVoiceItem { setDelivery(id, .sending) }
        case .unconfirmed:
            if let id = sendingVoiceItem { setDelivery(id, .unconfirmed) }
        case .sent:
            if let id = sendingVoiceItem {
                if let event = turn.eventID, let delivery = vm.centralSnapshot?.submissionDelivery(eventID: event),
                   var item = timeline.item(id: id) {
                    item.setSubmissionDelivery(delivery, processedID: vm.centralSnapshot?.submissionProcessedID(eventID: event))
                    timeline.upsert(item); scheduleSave()
                } else { setDelivery(id, nil) }
                sendingVoiceItem = nil
            }
        case .failed:
            if let id = sendingVoiceItem { setDelivery(id, .failed); sendingVoiceItem = nil }
        default:
            // A new window replaced an unconfirmed turn: its item keeps saying so, without a resend.
            sendingVoiceItem = nil
        }
    }

    private func settleTypedSends(_ consumer: AssistantCentralTextConsumer) {
        if timeline.settleTypedSends(consumer) { scheduleSave() }
    }

    private func setDelivery(_ id: String, _ delivery: YimiItem.Delivery?) {
        guard var item = timeline.item(id: id), item.delivery != delivery else { return }
        item.delivery = delivery
        item.queued = nil
        timeline.upsert(item)
        scheduleSave()
    }

    // MARK: storage

    private func append(_ item: YimiItem, identity: String?) {
        var item = item
        item.ownerIdentity = identity
        timeline.upsert(item)
        scheduleSave()
    }

    /// Loads the timeline. A missing file is an empty history; an unreadable one blocks writes until a later load
    /// succeeds (items added meanwhile are kept after it); a corrupt one is moved aside, never silently replaced.
    private func loadStore() {
        guard let store, storeReadable == false || items.isEmpty else { return }
        let path = store.url.path
        guard FileManager.default.fileExists(atPath: path) else { storeReadable = true; return }
        let saved: [YimiItem]
        do {
            saved = try store.load()
        } catch is DecodingError {
            let aside = store.url.deletingPathExtension()
                .appendingPathExtension("corrupt-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: store.url, to: aside)
            storeReadable = true
            scheduleSave()
            return
        } catch { storeReadable = false; return }
        // A send interrupted by the app ending has no known outcome.
        let restored = saved.map { item -> YimiItem in
            var item = item
            if item.delivery == .sending { item.delivery = .unconfirmed }
            return item
        }
        let known = Set(restored.map(\.id))
        timeline = YimiConversationTimeline(items: restored + items.filter { !known.contains($0.id) })
        storeReadable = true
        if items != saved { scheduleSave() }
    }

    private func scheduleSave() {
#if DEBUG
        if hasActivityFixture { return }
#endif
        guard let store, storeReadable else { return }
        saveTask?.cancel()
        saveVersion &+= 1
        let snapshot = items, version = saveVersion, writer = writer, epoch = historyEpoch, generation = historyGeneration
        saveTask = Task.detached(priority: .utility) {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            _ = await writer.write(snapshot, version: version, to: store, historyEpoch: epoch, historyGeneration: generation)
        }
    }

    /// Writes the timeline now; true once it is on disk.
    @discardableResult
    func saveNow() async -> Bool {
#if DEBUG
        if hasActivityFixture { return true }
#endif
        guard let store, storeReadable else { return false }
        saveTask?.cancel()
        saveVersion &+= 1
        return await writer.write(items, version: saveVersion, to: store, historyEpoch: historyEpoch, historyGeneration: historyGeneration)
    }
}

/// Serial timeline writer: writes happen one at a time and an older snapshot never lands after a newer one.
private actor YimiTimelineWriter {
    private var written: UInt64 = 0

    func write(_ items: [YimiItem], version: UInt64, to store: YimiConversationStore, historyEpoch: String? = nil, historyGeneration: UInt64 = 0) -> Bool {
        guard version > written else { return true }
        do {
            if let historyEpoch { try store.retireHistory(for: historyEpoch, generation: historyGeneration) }
            try store.write(items, historyEpoch: historyEpoch)
        } catch { return false }
        written = version
        return true
    }
}

extension AssistantSessionState {
    var isActive: Bool { if case .active = self { return true } else { return false } }
}
