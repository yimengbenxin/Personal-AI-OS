import Foundation
import CoreImage.CIFilterBuiltins

enum QRCode {
    private static let context = CIContext()
    static func image(_ data: Data) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = data; filter.correctionLevel = "M"
        guard let code = filter.outputImage else { return nil }
        let padded = code.composited(over: CIImage(color: .white).cropped(to: code.extent.insetBy(dx: -4, dy: -4)))
        let output = padded.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        return context.createCGImage(output, from: output.extent)
    }
}

struct YimiItem: Codable, Identifiable, Equatable {
    enum Kind: String, Codable { case me, her, call }
    enum RecordKind: Equatable { case call, ambient, message }
    enum Delivery: String, Codable {
        case sending, unconfirmed, failed
        /// How a request row shows Core's submissionDelivery; nil is delivered.
        static func row(_ delivery: CentralSubmissionDelivery) -> Delivery? {
            switch delivery {
            case .accepted: nil
            case .pending, .queued: .sending
            case .rejected: .failed
            case .unconfirmed: .unconfirmed
            }
        }
    }
    /// Kept only to decode the previous folded call records.
    struct CallLine: Codable, Equatable { var role: String; var text: String; var turn: Int? = nil }

    let id: String
    var kind: Kind
    var text: String
    var lines: [CallLine] = []
    var date: Date
    var endedAt: Date?
    var delivery: Delivery? = nil
    var via: String? = nil
    var callID: String? = nil
    var turn: Int? = nil
    var role: String? = nil
    var privacy: AssistantReplyPrivacy? = nil
    var seq: Int? = nil
    var attachments: [CentralTimelineAttachment]? = nil
    /// The paired owner who supplied this local presentation; old unscoped history stays phone-only.
    var ownerIdentity: String? = nil
    /// Additive cache metadata: legacy clients still read the delivery value as `sending`.
    var queued: Bool? = nil
    var submissionEventID: String? = nil
    var submissionProcessedID: String? = nil

    var processedEventID: String? {
        if let submissionProcessedID { return submissionProcessedID }
        if kind == .her && id.hasPrefix("her-") { return String(id.dropFirst(4)) }
        if kind == .me && id.hasPrefix("me-ambient-") { return String(id.dropFirst(11)) }
        if kind == .her && callID == nil && id.hasPrefix("call-") { return String(id.dropFirst(5)) }
        if kind == .me && id.hasPrefix("task-") { return String(id.dropFirst(5)) }
        return nil
    }

    func activityProcessedEventID(consumer: AssistantCentralTextConsumer?) -> String? {
        if let processedEventID { return processedEventID }
        guard kind == .me else { return nil }
        let event = submissionEventID ?? (id.hasPrefix("me-") ? String(id.dropFirst(3)) : "")
        return consumer?.submissionProcessedID(eventID: event)
    }

    var isVoiceInput: Bool { via == "ptt" || via == "ambient" || via == "call" }

    var isQueued: Bool { queued == true && delivery == .sending }
    var deliveryStatus: String? {
        if isQueued { return "排队中 · 她处理完上一句就发" }
        if queued == true { return "已接收 · 等待同步处理状态" }
        switch delivery {
        case .sending: return "发送中"
        case .unconfirmed: return "未确认是否送达"
        case .failed: return "没发出去"
        case nil: return nil
        }
    }
    mutating func setSubmissionDelivery(_ state: CentralSubmissionDelivery, processedID: String? = nil) {
        if let processedID { submissionProcessedID = processedID }
        delivery = Delivery.row(state)
        queued = state == .queued ? true : nil
    }

    /// QR URLs use the durable text reply; the phone generates the image without fetching the URL.
    /// Only https, plus WeChat's own PC-login form (`http://weixin.qq.com/x/…`), which must stay byte-exact.
    var replyContent: (text: String, qr: CGImage?) {
        guard kind == .her,
              let range = text.range(of: #"!\[[^\]]*\]\(qr:[^\s)]+\)"#, options: .regularExpression),
              let marker = text[range].range(of: "](qr:") else { return (text, nil) }
        let payload = String(text[marker.upperBound..<text.index(before: range.upperBound)])
        guard payload.utf8.count <= 2048, let url = URL(string: payload, encodingInvalidCharacters: false),
              url.scheme?.lowercased() == "https" || payload.hasPrefix("http://weixin.qq.com/x/"),
              let host = url.host, !host.isEmpty,
              let image = QRCode.image(Data(payload.utf8)) else { return (text, nil) }
        return (text.replacingCharacters(in: range, with: "").trimmingCharacters(in: .whitespacesAndNewlines), image)
    }

    /// A request that failed or whose delivery is unknown can be sent again as text: a new request, which may
    /// duplicate one that did arrive.
    var offersTextResend: Bool { kind == .me && queued != true && (delivery == .unconfirmed || delivery == .failed) }

    /// Classification comes from the persisted source and call membership, independent of the speaker.
    var recordKind: RecordKind {
        if via == "ambient" { return .ambient }
        return kind == .call || callID != nil ? .call : .message
    }
}

/// Local history belongs to a provisioned pairing, just like the shared terminal cache.
/// A server history generation also retires legacy and previously paired owners' caches.
struct YimiConversationStore: Sendable {
    let url: URL
    private var epochURL: URL { url.appendingPathExtension("epoch") }
    func historyEpoch() -> String? { try? String(contentsOf: epochURL, encoding: .utf8) }
    func retireHistory(for epoch: String, generation: UInt64 = 0) throws {
        try AssistantHistoryFiles.locked {
            let directory = url.deletingLastPathComponent()
            let retired = try AssistantHistoryFiles.retire(epoch, generation: generation, in: directory)
            guard retired || historyEpoch() != epoch else { return }
            try write([], historyEpoch: epoch)
            try Data(epoch.utf8).write(to: epochURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    init?(folder: URL, pairing: RealtimeDevicePairing?) {
        guard let pairing else { return nil }
        url = folder.appendingPathComponent("yimi-conversation-" + CentralOwnerDataIdentity.pairing(pairing) + ".json")
    }

    func load() throws -> [YimiItem] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try JSONDecoder().decode([YimiItem].self, from: Data(contentsOf: url))
    }

    func write(_ items: [YimiItem], historyEpoch: String? = nil) throws {
        try AssistantHistoryFiles.locked {
            guard AssistantHistoryFiles.permits(historyEpoch, in: url.deletingLastPathComponent()) else { throw CocoaError(.fileWriteNoPermission) }
            try JSONEncoder().encode(items).write(to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}

/// Published/cache snapshots share storage. Updating an ID copies one small dictionary, not the entire history index.
private struct YimiItemPositions {
    private var buckets = Array(repeating: [String: Int](), count: 32)
    subscript(id: String) -> Int? {
        get { buckets[Int(UInt(bitPattern: id.hashValue) % UInt(buckets.count))][id] }
        set { buckets[Int(UInt(bitPattern: id.hashValue) % UInt(buckets.count))][id] = newValue }
    }
}

/// The durable conversation used by chat and call captions. Call records keep metadata, never a second transcript.
struct YimiConversationTimeline {
    private(set) var items: [YimiItem] = []
    private var positions = YimiItemPositions()
    private var positionBase = 0
    private var callMembers: [String: [String]] = [:]
    private var latestAssistantByOwner: [String: String] = [:]
    private var unsettled = Set<String>()
    private var serverCount = 0, recordCount = 0
    private var newestSeq = 0
    private var newestLocalDate = Date.distantPast
    private(set) var revision = UUID()
    private var previousRevision: UUID?
    private var changedIDs = Set<String>(), removedIDs = Set<String>()
    private var mergedRevision: UUID?
    private var mergedOwner: String?
    var chatItems: [YimiItem] { items.filter { $0.kind == .call ? $0.recordKind == .call : $0.recordKind != .call } }

    private func position(_ id: String) -> Int? { positions[id].map { $0 - positionBase } }
    func item(id: String) -> YimiItem? { position(id).map { items[$0] } }

    /// Watch displays one latest assistant row, in the same order as the conversation.
    func latestAssistantItem(ownerIdentity: String?) -> YimiItem? {
        guard let ownerIdentity, let id = latestAssistantByOwner[ownerIdentity] else { return nil }
        return item(id: id)
    }

    /// A terminal snapshot is a source revision, independent of local sends and call captions.
    /// Live one-item packets use their delta; missed revisions and restored pages reconcile by ID.
    @discardableResult
    mutating func merge(_ incoming: YimiConversationTimeline, ownerIdentity: String?, includeLocal: Bool = true) -> Bool {
        guard mergedRevision != incoming.revision || mergedOwner != ownerIdentity else { return false }
        let before = revision
        let incremental = mergedOwner == ownerIdentity && mergedRevision == incoming.previousRevision
        let removed = incremental ? incoming.removedIDs : Set(items.compactMap { item in
            item.seq != nil && item.delivery == nil && item.ownerIdentity == ownerIdentity &&
                incoming.positions[item.id] == nil ? item.id : nil
        })
        remove(ids: Set(removed.filter { id in
            guard let item = item(id: id) else { return false }
            return item.seq != nil && item.delivery == nil && item.ownerIdentity == ownerIdentity
        }))
        let updates = incremental ? incoming.changedIDs.compactMap { incoming.item(id: $0) }
            .sorted { incoming.positions[$0.id]! < incoming.positions[$1.id]! } : incoming.items
        for item in updates where includeLocal || item.seq != nil { upsert(item, preserveDelivery: item.seq != nil) }
        mergedRevision = incoming.revision; mergedOwner = ownerIdentity
        return revision != before
    }

    init(items: [YimiItem] = []) {
        let ambientReplies = Set(items.filter { $0.id.hasPrefix("me-ambient-") }.map { "her-" + $0.id.dropFirst("me-ambient-".count) })
        let ambientCalls = Set(items.filter { $0.via == "ambient" }.compactMap(\.callID))
        for var item in items {
            let callID = item.kind == .call ? String(item.id.dropFirst("call-".count)) : item.callID
            // The gateway's ambient call IDs predate persisted mode; paired wake requests identify older replies.
            if callID.map({ $0.hasPrefix("ambient-") || ambientCalls.contains($0) }) == true ||
                ambientReplies.contains(item.id) || item.id.hasPrefix("her-care:") { item.via = "ambient" }
            let lines = item.lines
            item.lines = []
            upsert(item, preserveDelivery: item.seq != nil)
            if item.kind == .call {
                let callID = String(item.id.dropFirst("call-".count))
                for (index, line) in lines.enumerated() {
                    // Older saved call records predate the turn field; their stored sequence is authoritative.
                    let turn = line.turn ?? index
                    upsert(YimiItem(id: "call-\(callID)/\(turn)-\(line.role)", kind: line.role == "user" ? .me : .her,
                        text: line.text, date: item.date, via: item.recordKind == .ambient ? "ambient" : "call", callID: callID, turn: turn, role: line.role))
                }
            }
        }
    }

    mutating func upsert(_ incoming: YimiItem, preserveDelivery: Bool = false) {
        if let index = position(incoming.id), items[index] == incoming {
            if incoming.seq != nil {
                let settled = settleReply(incoming)
                if !settled.isEmpty { changed(settled) }
            }
            return
        }
        var item = incoming
        if let index = position(item.id) {
            let old = items[index]
            item.date = old.date
            item.submissionEventID = item.submissionEventID ?? old.submissionEventID
            item.submissionProcessedID = item.submissionProcessedID ?? old.submissionProcessedID
            if preserveDelivery, old.delivery != nil {
                item.delivery = old.delivery
                item.queued = old.queued
                item.submissionEventID = old.submissionEventID
                item.submissionProcessedID = old.submissionProcessedID
            }
            guard item != old else { return }
            // A server item's unique sequence and retained timestamp fix its position.
            if item.seq == old.seq {
                items[index] = item
                if item.kind != old.kind || item.ownerIdentity != old.ownerIdentity {
                    updateLatestAssistant(old: old, item: item, at: index)
                }
                if item.callID != old.callID || item.turn != old.turn || item.role != old.role { reindex() }
                updateUnsettled(item)
                changed(item.seq == nil ? [item.id] : settleReply(item).union([item.id]))
                return
            }
            items.remove(at: index)
            reindex()
        }
        var insertion: Int?
        if let callID = item.callID, item.turn != nil {
            let members = callMembers[callID] ?? []
            if let last = members.last, Self.follows(items[position(last)!], item) {
                if let next = members.first(where: { Self.follows(items[position($0)!], item) }) { insertion = position(next) }
            }
        }
        if insertion == nil, let seq = item.seq, seq < newestSeq || item.date < newestLocalDate {
            insertion = items.firstIndex { $0.seq.map { $0 > seq } ?? ($0.date > item.date) }
        }
        if let insertion {
            items.insert(item, at: insertion); reindex()
        } else {
            items.append(item); index(item, at: items.count - 1)
        }
        let touched = settleReply(item).union([item.id])
        // Server history follows its 5000-item retention; local calls keep their existing record budget.
        var retired = Set<String>()
        if serverCount > 5000 {
            retired.formUnion(items.lazy.filter { $0.seq != nil }.prefix(serverCount - 5000).map(\.id))
        }
        if recordCount > 600 {
            let records = Set(items.lazy.filter { $0.seq == nil && $0.callID == nil }.prefix(recordCount - 600).map(\.id))
            retired.formUnion(items.compactMap { records.contains($0.id) || $0.callID.map { records.contains("call-" + $0) } == true ? $0.id : nil })
        }
        if !retired.isEmpty { discard(retired) }
        changed(touched.subtracting(retired), removed: retired)
    }

    private mutating func updateUnsettled(_ item: YimiItem) {
        if item.delivery == .sending || item.queued == true { unsettled.insert(item.id) }
        else { unsettled.remove(item.id) }
    }
    private mutating func settleReply(_ item: YimiItem) -> Set<String> {
        guard item.kind == .her else { return [] }
        var settled = Set<String>()
        for id in unsettled {
            let index = position(id)!
            if items[index].queued == true && items[index].submissionProcessedID.map({ item.id == "her-" + $0 }) == true {
                items[index].delivery = nil; items[index].queued = nil
                unsettled.remove(id); settled.insert(id)
            }
        }
        return settled
    }
    private mutating func index(_ item: YimiItem, at index: Int) {
        positions[item.id] = index + positionBase
        if item.kind == .her, let owner = item.ownerIdentity { latestAssistantByOwner[owner] = item.id }
        if let callID = item.callID { callMembers[callID, default: []].append(item.id) }
        if let seq = item.seq { serverCount += 1; newestSeq = max(newestSeq, seq) }
        else {
            newestLocalDate = max(newestLocalDate, item.date)
            if item.callID == nil { recordCount += 1 }
        }
        updateUnsettled(item)
    }
    private mutating func updateLatestAssistant(old: YimiItem, item: YimiItem, at index: Int) {
        if let owner = old.ownerIdentity, latestAssistantByOwner[owner] == old.id {
            latestAssistantByOwner[owner] = items.last { $0.kind == .her && $0.ownerIdentity == owner }?.id
        }
        if item.kind == .her, let owner = item.ownerIdentity,
           latestAssistantByOwner[owner].flatMap({ position($0) }).map({ $0 > index }) != true {
            latestAssistantByOwner[owner] = item.id
        }
    }
    private mutating func reindex() {
        positions = YimiItemPositions(); positionBase = 0; callMembers = [:]; unsettled = []; latestAssistantByOwner = [:]
        serverCount = 0; recordCount = 0; newestSeq = 0; newestLocalDate = .distantPast
        for (offset, item) in items.enumerated() { index(item, at: offset) }
    }
    private mutating func changed(_ ids: Set<String>, removed: Set<String> = []) {
        previousRevision = revision; revision = UUID()
        changedIDs = ids; removedIDs = removed
    }
    mutating func remove(ids: Set<String>) {
        let removed = ids.filter { positions[$0] != nil }
        guard !removed.isEmpty else { return }
        discard(removed)
        changed([], removed: removed)
    }
    private mutating func discard(_ removed: Set<String>) {
        // Advancing server retention removes the oldest prefix. Its surviving ID positions stay valid.
        if items.prefix(removed.count).allSatisfy({ removed.contains($0.id) && $0.callID == nil }) {
            for item in items.prefix(removed.count) {
                positions[item.id] = nil; unsettled.remove(item.id)
                if let owner = item.ownerIdentity, latestAssistantByOwner[owner] == item.id {
                    latestAssistantByOwner[owner] = nil
                }
                if item.seq != nil { serverCount -= 1 } else { recordCount -= 1 }
            }
            items.removeFirst(removed.count); positionBase += removed.count
        } else {
            items.removeAll { removed.contains($0.id) }; reindex()
        }
    }

    mutating func removeServerItems(seqs: Set<Int>, before: Int) {
        remove(ids: Set(items.compactMap { item in item.seq.map { seqs.contains($0) || $0 < before } == true ? item.id : nil }))
    }

    private static func roleOrder(_ role: String?) -> Int { role == "user" ? 0 : role == "assistant" ? 1 : 2 }
    private static func follows(_ existing: YimiItem, _ incoming: YimiItem) -> Bool {
        guard let turn = existing.turn else { return false }
        return turn > incoming.turn! || (turn == incoming.turn! && roleOrder(existing.role) > roleOrder(incoming.role))
    }

    mutating func accept(_ call: CentralCall, at date: Date = Date(), ownerIdentity: String? = nil) {
        guard let callID = call.id else { return }
        let id = "call-" + callID
        let lines = call.lines.filter { $0.callID == callID }
        if let record = item(id: id) {
            var record = record
            record.via = call.isAmbient ? "ambient" : "call"
            record.ownerIdentity = ownerIdentity
            if !call.isActive, record.endedAt == nil { record.endedAt = date }
            upsert(record)
        } else if call.isActive || !lines.isEmpty {
            upsert(YimiItem(id: id, kind: .call, text: "", date: date, endedAt: call.isActive ? nil : date,
                via: call.isAmbient ? "ambient" : "call", ownerIdentity: ownerIdentity))
        }
        let via = call.isAmbient ? "ambient" : "call"
        for line in lines {
            let id = "call-" + line.id
            // The ID fixes call, turn and role. A growing live window changes only some retained lines.
            if let saved = item(id: id), saved.text == line.text, saved.via == via,
               saved.privacy == line.privacy, saved.ownerIdentity == ownerIdentity { continue }
            upsert(YimiItem(id: id, kind: line.role == "user" ? .me : .her, text: line.text,
                date: date, via: via, callID: callID, turn: line.turn, role: line.role, privacy: line.privacy,
                ownerIdentity: ownerIdentity))
        }
    }

    mutating func accept(_ reply: CentralAmbientReply, at date: Date = Date(), ownerIdentity: String? = nil) {
        let mine = "me-ambient-" + reply.id, hers = "her-" + reply.id
        let heard = reply.heard.trimmingCharacters(in: .whitespacesAndNewlines)
        if !heard.isEmpty, positions[mine] == nil {
            let item = YimiItem(id: mine, kind: .me, text: heard, date: date, via: "ambient", ownerIdentity: ownerIdentity)
            if let index = position(hers) { items.insert(item, at: index); reindex(); changed([mine]) }
            else { upsert(item) }
        }
        upsert(YimiItem(id: hers, kind: .her, text: QwenHandoff.split(reply.text).display, date: date, via: "ambient", privacy: reply.privacy,
            ownerIdentity: ownerIdentity))
        if var heard = item(id: mine) { heard.ownerIdentity = ownerIdentity; upsert(heard) }
    }

    /// Server admission settles both typed and spoken rows, including a queued row merged into shared history.
    @discardableResult mutating func settleTypedSends(_ consumer: AssistantCentralTextConsumer) -> Bool {
        let before = revision
        for id in unsettled {
            let item = item(id: id)!
            guard item.kind == .me else { continue }
            guard item.via == nil || item.via == "text" || item.submissionEventID != nil else { continue }
            var settled = item
            let event = item.submissionEventID ?? String(item.id.dropFirst("me-".count))
            if let known = consumer.submissionDelivery(eventID: event) {
                settled.setSubmissionDelivery(known, processedID: consumer.submissionProcessedID(eventID: event))
            } else { settled.delivery = .unconfirmed }
            if settled != item { upsert(settled) }
        }
        return revision != before
    }

    mutating func accept(_ candidate: CentralVoiceCandidate, eventID: String? = nil, at date: Date = Date()) -> String {
        let id = "me-voice-" + candidate.id
        if var item = item(id: id) {
            if item.submissionEventID == nil, let eventID {
                item.submissionEventID = eventID; item.delivery = .sending; upsert(item)
            }
        } else {
            upsert(YimiItem(id: id, kind: .me, text: candidate.transcript, date: date, delivery: .sending, via: "ptt",
                submissionEventID: eventID))
        }
        return id
    }

    func callLines(_ callID: String?) -> [YimiItem] {
        guard let callID else { return [] }
        return (callMembers[callID] ?? []).compactMap { item(id: $0) }.filter { $0.kind != .call }
    }
}


/// Whether the chat list follows its newest content. `pinned` means the owner is at the bottom: a list that only grows or
/// resizes under them (a reply from another device, streaming text, cards, typing dots, the keyboard) keeps them there, a
/// drag toward history or a notification anchor releases them, and scrolling that settles near the bottom pins again.
struct YimiChatScrollState {
    struct Metrics: Equatable, Sendable {
        var top: CGFloat
        var bottom: CGFloat
        var viewport: CGFloat
        var height: CGFloat { bottom - top }
        var nearBottom: Bool { bottom <= viewport + 72 }
        var nearTop: Bool { top >= -44 }
    }
    private let tracksHistoryGestures: Bool
    private(set) var pinned = true
    private var metrics: Metrics?
    private var historyGesture = false
    private var requestedHistory = false

    init(tracksHistoryGestures: Bool = false) {
        self.tracksHistoryGestures = tracksHistoryGestures
    }

    mutating func drag(towardHistory: Bool, began: Bool) -> Bool {
        if began { requestedHistory = false }
        historyGesture = towardHistory
        if towardHistory { pinned = false }
        return takeHistoryRequest()
    }

    /// Returns whether this layout asks for one older page. Offset changes during programmatic positioning or keyboard
    /// adjustment are not reading intent for consumers that report history gestures. Geometry-only consumers infer
    /// reading from stable-size offset changes, including AppKit clip-view scrolling.
    mutating func update(_ next: Metrics) -> Bool {
        let previous = metrics
        metrics = next
        let resized = previous.map { abs(next.height - $0.height) > 1 || next.viewport != $0.viewport } ?? true
        if !resized, !requestedHistory, !tracksHistoryGestures || historyGesture || !pinned { pinned = next.nearBottom }
        return takeHistoryRequest()
    }

    mutating func endDrag() {
        if !requestedHistory { pinned = metrics?.nearBottom == true }
    }

    mutating func showLatest() {
        pinned = true
        historyGesture = false
        requestedHistory = false
    }

    mutating func readingHistory() {
        pinned = false
        historyGesture = false
    }

    private mutating func takeHistoryRequest() -> Bool {
        guard historyGesture, !requestedHistory, metrics?.nearTop == true else { return false }
        requestedHistory = true
        return true
    }
}

/// The newest rows a chat renders. The timeline keeps every loaded row (the cache restores all of them, the server retains
/// up to 5000). The surface keeps a bounded tail of lazy message containers. The older-history action first
/// widens the tail over rows that are already loaded and asks the server only when none is hidden.
struct YimiChatWindow: Equatable {
    static let tail = 150
    static let step = 100
    private(set) var limit = tail

    func rows(_ items: [YimiItem]) -> [YimiItem] { Array(items.suffix(limit)) }
    func hides(_ loaded: Int) -> Bool { loaded > limit }

    /// Widens by one step; true when every loaded row was already shown, so older rows must come from the server
    /// (and the widened window has room for the page that arrives).
    mutating func older(loaded: Int) -> Bool {
        let allShown = !hides(loaded)
        limit += Self.step
        return allShown
    }
}

/// How much of one message a chat surface lays out. SwiftUI measures and draws a Text whole, on the main thread, several
/// times per layout, so a 70k-character reply (receipt facts dumped into replies on N13) held the history push past the
/// 10 s watchdog. A longer message shows a prefix here and opens in full on its own page.
enum YimiLongText {
    static let characters = 2_000
    static let lines = 40

    /// The prefix a chat row renders, or nil when the whole text fits. Reads at most `characters` characters.
    static func preview(_ text: String) -> String? {
        var end = text.startIndex, count = 0, breaks = 0
        while end < text.endIndex {
            if count == characters { break }
            if text[end].isNewline { breaks += 1; if breaks == lines { break } }
            count += 1
            end = text.index(after: end)
        }
        guard !text[end...].allSatisfy(\.isWhitespace) else { return nil }
        return text[..<end].trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }
}

/// Replies wait here until their durable timeline is visible. Owned by the conversation's MainActor.
@MainActor final class YimiRenderedACKQueue {
    private var acked = Set<String>()
    private(set) var pending: [String: CentralTextPresentation] = [:]
    func enqueue(_ presentation: CentralTextPresentation, id: String) {
        if presentation.isFinal, !acked.contains(id) { pending[id] = presentation }
    }
    func drain(visible: Bool, save: () async -> Bool, send: (CentralTextPresentation) async -> Void) async {
        let batch = pending
        guard visible, !batch.isEmpty, await save() else { return }
        for (id, presentation) in batch where pending[id] == presentation {
            pending.removeValue(forKey: id)
            guard acked.insert(id).inserted else { continue }
            await send(presentation)
        }
    }
}
