import AppKit
import Combine
import DesktopKit
import LiveKit
import UserNotifications

@MainActor final class DesktopAppModel: ObservableObject {
    @Published var connected = false
    @Published private(set) var sending = false
    @Published var connectionLabel = "未连接"
    @Published var pairing: RealtimeDevicePairing?
    @Published private(set) var unpairing = false
    var canUnpair: Bool { pairing != nil && !unpairing }
    @Published private(set) var unpairStatus: String?
    @Published var error: String?
    @Published var toolLockReason: String?
    @Published private(set) var desktopReady = false
    @Published var inFlight = 0
    @Published var pause = PauseState(reasons: [])
    @Published var timeline: [YimiItem] = []
    @Published var terminals: [CentralTerminal] = []
    @Published var confirmations: [CentralPendingConfirmation] = []
    @Published private(set) var voiceConfirmations: [CentralVoiceConfirmation] = []
    @Published private(set) var confirmingVoice = Set<String>()
    @Published private(set) var voiceConfirmationError: String?
    var canConfirmVoice: Bool { pairing?.capabilities?.contains("owner_unlock") == true }
    private let authenticateOwner: @Sendable () async throws -> Void
    @Published var errands: [CentralErrand] = [] { didSet { syncAndroidErrandActivity() } }
    @Published private(set) var activities: [ActivityPresentation] = []
    @Published var auditEntries: [AuditEntry] = []
    @Published var grants: [FileGrant] = []
    @Published var folders: [AuthorizedFolder] = []
    @Published var listening = false
    @Published private(set) var callEngine: DesktopCallEngine?
    @Published private(set) var callSnapshot: AssistantSessionSnapshot?
    @Published private(set) var call = CentralCall()
    var voiceStatus: AssistantVoiceStatus {
        callSnapshot?.voiceStatus ?? AssistantVoiceStatus(call: call, media: AssistantMediaSnapshot())
    }
    var voiceStatusTitle: String {
        voiceStatus.phase == .standby ? "等你唤醒 · 仅本机" : voiceStatus.title
    }
    @Published private(set) var voiceEnrollment = CentralVoiceEnrollment()
    @Published private(set) var voiceEnrollmentBusy = false
    let callPreview = AssistantVideoPreviewModel()
    @Published private(set) var screenSharing: DesktopScreenSharing?
    @Published var listeningText = ""
    @Published var voiceFeedback = "已发给依米"
    static let voiceNotSent = "语音没发出去，可在对话里重发这段文字"
    static let voiceUnconfirmed = "不确定语音是否送到，可在对话里重发这段文字"
    var presenceLabel: String {
        if !connected { return connectionLabel }
        if pause.paused { return "已暂停操作电脑" }
        if listening { return "在听你说" }
        if inFlight > 0 || !errands.isEmpty { return "正在电脑上做事" }
        if canConfirmVoice && voiceConfirmations.contains(where: { $0.deadline > Date() }) { return "等你确认" }
        if !confirmations.isEmpty { return "等你在手机上确认" }
        return "在呢"
    }
    private let windowSharing: WindowSharing
    let desktop: any DesktopControl
    let composer: DesktopComposer
    let modelSettings = AssistantModelSettingsModel()
    let wechatPreview: DesktopWeChatPreview
    let pairingController: DesktopPairingController?
    private var revocationError: String?
    private var ownerSSH: DesktopOwnerSSH?
    private(set) var androidHost: DesktopAndroidHost?
    var sshAuditURL: URL? { ownerSSH?.auditURL }
    private let storeURL: URL
    private let cacheWriter = CentralTerminalCacheWriter()
    private var cacheVersion: UInt64 = 0
    private var session: AssistantSessionCoordinator?
    private var transport: DesktopSessionTransport?
    private var desktopTransition: Task<Void, Never>?
    private var terminalTransition: Task<Void, Never>?
    private var terminalHistoryGeneration: UInt64 = 0
    private var bag = Set<AnyCancellable>()
    private var observation: Task<Void, Never>?
    private var press: UInt64 = 0
    private var autoSend = false
    /// The press window as central reports it: speech is captured only once it is `.recording`.
    @Published private(set) var lastVoicePhase: CentralVoiceTurn.Phase?
    /// The hold-to-talk turn has its outcome (sent, 没听清 or a failure), or none is running.
    var voiceSettled: Bool { !listening && !CentralVoiceTurn.activePhases.contains(lastVoicePhase ?? .idle) }
    /// The released turn's progress or unsent outcome, shown where the owner spoke (the HUD or the composer).
    var voiceNote: String? { !listening && (!voiceSettled || lastVoicePhase == .failed) ? voiceFeedback : nil }
    private var connectionInProgress = false
    private var snapshotRevision: UInt64 = 0
    private var avatarError: String?
    private var conversation = CentralTerminalState()
    /// The chat renders only the newest rows; "older" first widens this window over rows already loaded.
    @Published private(set) var chatWindow = YimiChatWindow()
    var canLoadOlder: Bool { chatWindow.hides(timeline.count) || connected && conversation.hasOlderHistory && conversation.requestID == nil }
    private var lastTerminalReceiptID: String?
    private var unacknowledged: [String: CentralTextPresentation] = [:]
    private var shownTexts: [String: String] = [:]
    private var outgoing: [String: AssistantPromptEnvelope] = [:]
    private var central = AssistantCentralTextConsumer()
    private var connectionID = UUID()
    /// The one pending automatic retry of a failed connection. connect() still owns every attempt (connectionInProgress),
    /// so retries never overlap or supersede one; each failure waits longer, a connection resets it, a tap skips the wait.
    private(set) var reconnect: Task<Void, Never>?
    private var reconnectAttempt = 0
    private let sleep: @Sendable (Duration) async throws -> Void
    private let notifications: DesktopNotifications?

    init(desktop: (any DesktopControl)? = nil, pairingController: DesktopPairingController? = nil, storeURL: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/依米/desktop", isDirectory: true),
        ownerSSH: DesktopOwnerSSH? = nil,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        ownerUnlockEnabled: Bool = false,
        authenticateOwner: @escaping @Sendable () async throws -> Void = { try await DesktopOwnerAuthentication.touchID() }) throws {
        let windowSharing = WindowSharing(); self.windowSharing = windowSharing
        self.storeURL = storeURL; self.sleep = sleep; self.authenticateOwner = authenticateOwner
        self.desktop = try desktop ?? Desktop(store: storeURL, resources: Bundle.main.resourceURL!, windowSharing: windowSharing)
        composer = DesktopComposer(desktop: self.desktop)
        wechatPreview = try DesktopWeChatPreview(file: storeURL.appendingPathComponent("wechat-preview.json"))
        notifications = desktop == nil ? DesktopNotifications(isChatFront: {
            NSApp?.isActive == true && NSApp?.keyWindow?.title == "依米"
        }, openChat: { NotificationCenter.default.post(name: Notification.Name("desktop.openChat"), object: nil) }) : nil
        self.pairingController = try pairingController ?? (desktop == nil ? DesktopPairingController(store: DesktopPairingStore(), ownerUnlockEnabled: ownerUnlockEnabled) : nil)
        self.ownerSSH = ownerSSH ?? (desktop == nil ? DesktopOwnerSSH(directory: storeURL.appendingPathComponent("owner-ssh")) : nil)
        androidHost = desktop == nil ? DesktopAndroidHost() : nil
        NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification).sink { [weak self] _ in self?.ownerSSH?.shutdown() }.store(in: &bag)
        pairing = self.pairingController?.pairing
        YimiAvatarStore.shared.bind(pairing.map(CentralOwnerDataIdentity.pairing))
        YimiAvatarStore.shared.$loadedVersion.dropFirst().sink { [weak self] _ in Task { @MainActor in self?.acknowledgeLoadedAppearance() } }.store(in: &bag)
        YimiAvatarStore.shared.$error.sink { [weak self] error in
            guard let self else { return }
            if let error { self.error = error }
            else if self.error == self.avatarError { self.error = nil }
            self.avatarError = error
        }.store(in: &bag)
        self.pairingController?.$pairing.dropFirst().sink { [weak self] value in
                self?.pairing = value
                YimiAvatarStore.shared.bind(value.map(CentralOwnerDataIdentity.pairing))
                self?.syncOwnerSSH()
                if value != nil { Task { await self?.connect() } }
            }.store(in: &bag)
        modelSettings.signer = { [weak self] bytes, deviceID in
            guard let self, let pairing = self.pairing, pairing.deviceID == deviceID else { throw ModelSettingsError.changed }
            let context = try await DesktopModelSettingsIdentity.context(reason: "确认模型与密钥设置")
            defer { context.invalidate() }
            guard self.pairing == pairing else { throw ModelSettingsError.changed }
            return try AssistantPaymentKeys(deviceID: deviceID).sign(bytes, role: .modelSettings, context: context)
        }
    }
    func activate() async {
        do {
            if let pairing, try ownerSSH?.hasPendingRevocation(pairing) == true { await clearPairing() }
        } catch { self.error = DesktopUserFacingError.message(error); return }
        resumeRevocations()
        wechatPreview.activate { [weak self] in
            let reason = self?.call.isActive == true ? "通话中，结束后继续整理" : self?.pause.reasons.contains(.manual) == true ? "已手动暂停，恢复电脑操作后继续整理" : nil
            return (self?.pairing, self?.connected == true, reason)
        }
        if observation == nil {
            do { try androidHost?.activate() } catch { self.error = error.localizedDescription }
            pause = await desktop.pauseState(); syncOwnerSSH()
            let events = desktop.subscribe()
            observation = Task { [weak self] in
                for await event in events {
                    guard let self else { break }
                    switch event {
                    case .ready(let ready): desktopReady = ready
                    case .pause(let state): pause = state; syncOwnerSSH()
                    case .activity(let count): inFlight = count
                    case .audit: await refreshActivity()
                    case .permissionRequired(let folder): error = "这件事要先在电脑上允许依米访问“\(folder)”"
                    case .foldersChanged: await refreshFolders()
                    case .grantsChanged: grants = await desktop.grants()
                    }
                }
            }
        }
        toolLockReason = await desktop.toolLockReason()
        pause = await desktop.pauseState()
        await refreshFolders(); await refreshActivity(); await connect()
    }
    func connect() async {
        reconnect?.cancel(); reconnect = nil
        guard !connectionInProgress, !connected, let controller = pairingController, pairing != nil else { return }
        if let pairing {
            do { if try ownerSSH?.hasPendingRevocation(pairing) == true { await clearPairing(); return } }
            catch { self.error = DesktopUserFacingError.message(error); return }
        }
        let generation = UUID(); connectionID = generation; terminalHistoryGeneration = 0
        connectionInProgress = true
        defer {
            connectionInProgress = false
            if connectionID != generation, pairing != nil, !connected { Task { [weak self] in await self?.connect() } }
        }
        await screenSharing?.stop()
        guard connectionID == generation else { return }
        screenSharing = nil
        beginCentralSession()
        let old = session, oldWire = transport; session = nil; transport = nil; oldWire?.finish()
        let stopped = transitionDesktop(active: false)
        do {
            if let old { _ = await old.stop(reasonCode: "desktop_reconnect") }
            await stopped.value
            try await oldWire?.removeTemporaryFiles()
            guard connectionID == generation else { return }
            let pairing = try await controller.declareCapabilities()
            guard connectionID == generation else { return }
            let settings = UserDefaultsSettingsStore()
            try await settings.saveSettings(AppSettings(endpoint: pairing.origin))
            guard connectionID == generation else { return }
            let identity = DesktopIdentity(store: controller.store)
            let control = ProductionRealtimePublicControlProvider(settingsStore: settings,
                credentialStore: PairedRealtimeCredentialStore(store: controller.store, identity: identity),
                canonicalBodyProvider: PairedRealtimeRequestBodyProvider(store: controller.store), recipientKeyStore: controller.store)
            let room = SystemLiveKitRoomOperator(encryptionProvider: ProductionLiveKitEncryptionOptionsProvider(control: control),
                videoTrackObserver: { [weak callPreview] update in callPreview?.update(update) })
            let wire = try DesktopSessionTransport(room: room, temporary: storeURL.appendingPathComponent("incoming"))
            let media = DesktopMediaPermissionProvider()
            let coordinator = AssistantSessionCoordinator(bootstrapProvider: control, realtime: LiveKitSessionAdapter(roomOperator: room),
                mediaPermissions: media, locationService: DesktopLocationProvider(), receipts: AppleReceiptStore(),
                artc: AliyunARTCCallClient(preview: callPreview),
                voiceIdentityAuth: "touch_id", authenticateVoiceIdentity: authenticateOwner,
                careIdentity: { (CentralOwnerDataIdentity.pairing(pairing), pairing.deviceID) })
            session = coordinator; transport = wire; snapshotRevision = 0
            modelSettings.connect(coordinator)
            callEngine = DesktopCallEngine(coordinator: coordinator)
            screenSharing = DesktopScreenSharing(grant: windowSharing)
            let cache = storeURL.appendingPathComponent("conversation.json")
            if FileManager.default.fileExists(atPath: cache.path) { try await coordinator.setTerminalCache(data: Data(contentsOf: cache)) }
            await coordinator.setObserver { [weak self] snapshot in Task { @MainActor in guard self?.connectionID == generation else { return }; await self?.accept(snapshot) } }
            await coordinator.setCentralTextObserver { [weak self] consumer in Task { @MainActor in guard self?.connectionID == generation else { return }; await self?.accept(consumer) } }
            await coordinator.setTerminalObserver { [weak self] state in Task { @MainActor in self?.enqueueTerminal(state, connection: generation) } }
            guard connectionID == generation else { return }
            await transitionDesktop(active: true).value
            guard connectionID == generation else { return }
            try await coordinator.start(AssistantStartIntent(userInitiated: true))
            guard connectionID == generation else { return }
        } catch {
            guard connectionID == generation else { return }
            connected = false; connectionLabel = "未连接"; self.error = DesktopUserFacingError.message(error)
            await transitionDesktop(active: false).value
            guard connectionID == generation else { return }
            let failedWire = transport; transport = nil; failedWire?.finish()
            do { try await failedWire?.removeTemporaryFiles() } catch { self.error = DesktopUserFacingError.message(error) }
            guard connectionID == generation else { return }
            if (error as? RealtimePublicControlAdapterError)?.isPairingRevoked == true { await clearPairing() }
            else { scheduleReconnect() }
        }
    }
    /// One pending retry at a time, on the shared AssistantReconnectBackoff (0.5–1 s doubling to 30 s, jittered).
    private func scheduleReconnect() {
        guard reconnect == nil else { return }
        let delay = AssistantReconnectBackoff.delay(attempt: reconnectAttempt); reconnectAttempt += 1
        reconnect = Task { [weak self, sleep] in
            do { try await sleep(delay) } catch { return }
            guard let self, !Task.isCancelled else { return }
            reconnect = nil
            await connect()
        }
    }
    func accept(_ snapshot: AssistantSessionSnapshot) async {
        let generation = connectionID
        guard snapshot.revision >= snapshotRevision else { return }; snapshotRevision = snapshot.revision
        callSnapshot = snapshot
        if case .active(true) = snapshot.state {
            let attach = !connected
            // Only a new connection clears the error: any later snapshot (a microphone settling) must not wipe one.
            if attach { error = nil }
            reconnect?.cancel(); reconnect = nil; reconnectAttempt = 0
            connected = true; connectionLabel = "已连接 · " + (pairing.flatMap { URL(string: $0.origin)?.host } ?? "")
            return
        }
        connected = false; desktopReady = false; connectionLabel = "未连接"
        if case .failed(let code) = snapshot.state {
            transport?.finish()
            await transitionDesktop(active: false).value
            guard connectionID == generation, snapshot.revision == snapshotRevision else { return }
            error = code == "realtime_pairing_revoked" ? "这台电脑已解除配对" : "连接已中断，请重新连接。"
            if code == "realtime_pairing_revoked" { await clearPairing() }
        }
        if snapshot.state.needsFreshConnection { scheduleReconnect() }
    }
    /// Every connection starts a new source session: Core's request state never crosses it. A send still waiting in
    /// the old session has an unknown outcome; its row says so and a retry sends the text as a new request. The
    /// server timeline, not this client, is the delivery authority.
    func beginCentralSession() {
        central = AssistantCentralTextConsumer(); activities = []; lastVoicePhase = nil; autoSend = false
        voiceConfirmations = []; confirmingVoice = []; voiceConfirmationError = nil
        voiceEnrollment = CentralVoiceEnrollment()
        callEngine = nil; callSnapshot = nil; call = CentralCall(); callPreview.update(.cleared)
        settleOrphanedSends(Set(timeline.map(\.id)))
    }
    private func settleOrphanedSends(_ ids: Set<String>) {
        for var item in timeline where ids.contains(item.id) && item.delivery == .sending {
            item.delivery = .unconfirmed; conversation.timeline.upsert(item)
        }
        timeline = conversation.timeline.chatItems
        persistConversation()
    }
    var conversationAvatarVersion: Int { conversation.avatarVersion }
    var appearanceLoadedReceipts: [AssistantAppearanceLoadedReceipt] { conversation.avatarLoadedReceipts }
    var appearanceState: AssistantAppearanceState { conversation.appearance }
    func refreshAppearance() async {
        do { guard let session else { throw CentralTextError.unavailable }; try await session.requestAppearanceOptions() }
        catch { self.error = DesktopUserFacingError.message(error) }
    }
    func prepareAppearance(lookID: String, focus: CentralAvatarProfile.Focus, version: Int, quote: AssistantAppearanceQuote) async {
        do { guard let session else { throw CentralTextError.unavailable }; try await session.prepareAppearance(lookID: lookID, focus: focus, expectedVersion: version, quote: quote) }
        catch { self.error = DesktopUserFacingError.message(error) }
    }
    func uploadAppearance(_ jpeg: Data) async throws -> AssistantAppearanceLook {
        guard let pairing, let session else { throw CentralTextError.unavailable }
        let owner = CentralOwnerDataIdentity.pairing(pairing)
        let look = try await AssistantAppearanceImageUpload.upload(jpeg, pairing: pairing)
        guard self.pairing == pairing else { throw CentralTextError.contextChanged() }
        try await session.registerUploadedAppearance(look, owner: owner)
        return look
    }
    func reconcileAppearance() async {
        do { guard let session else { throw CentralTextError.unavailable }; try await session.reconcileAppearance() }
        catch { self.error = DesktopUserFacingError.message(error) }
    }
    func cancelAppearance() async {
        do { guard let session else { throw CentralTextError.unavailable }; try await session.cancelAppearance() }
        catch { self.error = DesktopUserFacingError.message(error) }
    }
    func reuseAppearance(_ version: Int) async {
        do { guard let session else { throw CentralTextError.unavailable }; try await session.reuseAppearance(version: version, expectedVersion: conversation.avatarVersion) }
        catch { self.error = DesktopUserFacingError.message(error) }
    }
    private func acknowledgeLoadedAppearance() {
        guard let version = YimiAvatarStore.shared.loadedVersion, let owner = YimiAvatarStore.shared.pairingIdentity, let session else { return }
        Task { do { try await session.acknowledgeAppearanceLoaded(version: version, owner: owner) } catch { self.error = DesktopUserFacingError.message(error) } }
    }
    private func enqueueTerminal(_ state: CentralTerminalState, connection: UUID) {
        let previous = terminalTransition
        terminalTransition = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, self.connectionID == connection else { return }
            await self.accept(state)
        }
    }
    private func accept(_ state: CentralTerminalState) async {
        guard state.historyGeneration >= terminalHistoryGeneration else { return }
        terminalHistoryGeneration = state.historyGeneration
        let connection = connectionID
        if let reset = state.historyResetID, reset != conversation.historyResetID {
            do {
                if let epoch = state.historyEpoch {
                    try await ownerSSH?.acceptTrustedHistoryEpoch(epoch)
                    try await transport?.retireHistoryFiles()
                    try await (desktop as? Desktop)?.acceptTrustedHistoryEpoch(epoch)
                    try await wechatPreview.acceptTrustedHistoryEpoch(epoch)
                    syncOwnerSSH()
                }
            } catch { self.error = DesktopUserFacingError.message(error); return }
            guard connectionID == connection else { return }
            timeline = []; conversation.timeline = YimiConversationTimeline()
            outgoing = [:]; unacknowledged = [:]; shownTexts = [:]
            auditEntries = []; errands = []; activities = []; lastTerminalReceiptID = nil
            central.discardProductHistory()
        }
        if state.avatarReceived { YimiAvatarStore.shared.accept(state.avatar, ownerIdentity: state.ownerIdentity, eventID: state.avatarEventID, profileVersion: state.avatarVersion) }
        terminals = state.terminals; confirmations = state.confirmations
        // This model owns its local rows; the coordinator only echoes the cache it was handed at connect, so its copies
        // restore a launch and never overwrite (or bring back) rows changed here since.
        let mine = timeline.filter { $0.seq == nil || $0.delivery != nil }
        let local = mine.isEmpty ? state.timeline.items.filter { $0.seq == nil } : mine
        acknowledgeLoadedAppearance()
        var merged = conversation.timeline
        if mine.isEmpty, !local.isEmpty { merged = YimiConversationTimeline(items: local) }
        let changed = merged.merge(state.timeline, ownerIdentity: state.ownerIdentity, includeLocal: false) || (mine.isEmpty && !local.isEmpty)
        conversation = state
        conversation.timeline = merged
        if changed { timeline = merged.chatItems }
        // Rows restored from a previous run were never sent by this one.
        if mine.isEmpty, !local.isEmpty { settleOrphanedSends(Set(local.map(\.id))) }
        persistConversation()
        if let receipt = state.receipt, receipt.control_id != lastTerminalReceiptID {
            lastTerminalReceiptID = receipt.control_id
            error = receipt.ok ? nil : DesktopUserFacingError.code(receipt.error_code)
        }
        let generation = connectionID
        Task {
            guard connectionID == generation else { return }
            do { try await notifications?.confirmations(state.confirmations) }
            catch { self.error = DesktopUserFacingError.message(error) }
        }
    }
    func voiceConfirmationPending(_ id: String) -> Bool {
        confirmingVoice.contains(id) || central.ownerVoice.confirming[id] != nil
    }
    func confirmVoice(_ id: String, choice: CentralVoiceConfirmationChoice? = nil) async {
        guard canConfirmVoice, connected, !voiceConfirmationPending(id), let session,
              central.ownerVoice.confirmable(id) != nil else { return }
        let generation = connectionID
        confirmingVoice.insert(id); voiceConfirmationError = nil
        defer { if connectionID == generation { confirmingVoice.remove(id) } }
        do { try await session.confirmVoice(id, choice: choice) }
        catch {
            guard connectionID == generation else { return }
            voiceConfirmationError = error is CentralVoiceprintFailure ? DesktopUserFacingError.message(error)
                : "没能完成确认。请重试，或在已配对的手机上打字告诉她。"
        }
    }
    @discardableResult private func persistConversation() -> Task<Bool, Never> {
        cacheVersion &+= 1
        let snapshot = conversation, version = cacheVersion, url = storeURL.appendingPathComponent("conversation.json")
        return Task {
            do { try await cacheWriter.write(snapshot, version: version, to: url); return true }
            catch { self.error = DesktopUserFacingError.message(error); return false }
        }
    }
    func controlVoiceEnrollment(_ action: String) async {
        guard let session, connected, !voiceEnrollmentBusy else { return }
        voiceEnrollmentBusy = true
        defer { voiceEnrollmentBusy = false }
        do { try await session.voiceEnrollmentControl(action); error = nil }
        catch { self.error = DesktopUserFacingError.message(error) }
    }

    func accept(_ consumer: AssistantCentralTextConsumer) async {
        let generation = connectionID
        guard consumer.revision >= central.revision else { return }
        central = consumer
        voiceConfirmations = canConfirmVoice ? consumer.ownerVoice.confirmations : []
        if let code = consumer.ownerVoice.confirmationError { voiceConfirmationError = DesktopUserFacingError.code(code) }
        voiceEnrollment = consumer.ownerVoice.enrollment
        call = consumer.call
        updateDeliveries(consumer)
        errands = consumer.errands
        activities = consumer.activities.cards
        if let presentation = consumer.presentation,
           let key = try? presentation.packet.fields.value("processed_event_id", as: String.self) {
            let id = "her-" + key, text = QwenHandoff.split(presentation.text).display
            if !text.isEmpty {
                var item = timeline.first { $0.id == id } ?? YimiItem(id: id, kind: .her, text: text, date: Date())
                item.text = text; item.privacy = presentation.privacy ?? item.privacy
                conversation.timeline.upsert(item); timeline = conversation.timeline.chatItems
                persistConversation()
                if presentation.isFinal {
                    unacknowledged[id] = presentation
                    if shownTexts[id] == text { await shown(item) }
                }
            }
            if presentation.isFinal, consumer.isLocallySubmitted,
               let processed = try? presentation.packet.fields.value("processed_event_id", as: String.self) {
                do { try await notifications?.reply(id: processed) } catch { self.error = DesktopUserFacingError.message(error) }
            }
        }
        guard connectionID == generation else { return }
        let turn = consumer.voiceTurn
        listeningText = turn.preview
        guard turn.phase != lastVoicePhase else { return }; lastVoicePhase = turn.phase
        // A failed window before any send has no chat row; a sent turn's outcome is on its row (updateDeliveries).
        if let outcome = turn.unsentOutcome { autoSend = false; voiceFeedback = outcome }
        // Core makes a window ready only with a spoken transcript; an empty one already ended as 没听清.
        if turn.phase == .ready, autoSend, let candidate = turn.candidates.first, let eventID = turn.eventID {
            autoSend = false
            await sendVoice(candidate, eventID: eventID)
        }
    }
    func sendVoice(_ candidate: CentralVoiceCandidate, eventID: String) async {
        let generation = connectionID
        let prompt = AssistantPromptEnvelope(promptID: eventID, text: candidate.transcript)
        let rowID = "me-voice-" + candidate.id
        addOutgoing(prompt, via: "ptt", rowID: rowID)
        do {
            guard let session else { throw CentralTextError.unavailable }
            try await session.sendVoiceTurn(candidate)
            _ = await acceptCurrentSnapshot(from: session, generation: generation)
        } catch {
            guard connectionID == generation else { return }
            if let session, !(await acceptCurrentSnapshot(from: session, generation: generation)) { return }
            failUnsubmitted(prompt)
            if timeline.first(where: { $0.id == rowID })?.delivery == .failed { voiceFeedback = Self.voiceNotSent }
        }
    }
    @discardableResult private func acceptCurrentSnapshot(from source: AssistantSessionCoordinator, generation: UUID) async -> Bool {
        let snapshot = await source.centralTextSnapshot()
        guard connectionID == generation else { return false }
        await accept(snapshot)
        return connectionID == generation
    }
    private func addOutgoing(_ prompt: AssistantPromptEnvelope, via: String = "text", rowID: String? = nil) {
        let id = rowID ?? "me-" + prompt.promptID
        outgoing[id] = prompt
        conversation.timeline.upsert(YimiItem(id: id, kind: .me, text: prompt.text, date: Date(), delivery: .sending, via: via,
            attachments: prompt.attachments.map { CentralTimelineAttachment(name: $0.name, kind: $0.kind, size: Int($0.size)) }, submissionEventID: prompt.promptID))
        timeline = conversation.timeline.chatItems
        let visible = Set(timeline.map(\.id)); outgoing = outgoing.filter { visible.contains($0.key) }
        persistConversation()
    }
    @discardableResult private func setDelivery(_ id: String, _ delivery: YimiItem.Delivery?) -> Bool {
        guard var item = timeline.first(where: { $0.id == id }), item.seq == nil || item.delivery != nil else { return false }
        guard item.delivery != delivery else { return false }
        item.delivery = delivery; item.queued = nil; conversation.timeline.upsert(item)
        timeline = conversation.timeline.chatItems
        return true
    }
    /// Core's submissionDelivery is the one delivery authority for this session's rows.
    private func updateDeliveries(_ consumer: AssistantCentralTextConsumer) {
        let before = timeline
        for (id, prompt) in outgoing {
            guard let delivery = consumer.submissionDelivery(eventID: prompt.promptID) else { continue }
            guard var item = timeline.first(where: { $0.id == id }) else { continue }
            let before = item
            item.setSubmissionDelivery(delivery, processedID: consumer.submissionProcessedID(eventID: prompt.promptID))
            conversation.timeline.upsert(item); timeline = conversation.timeline.chatItems
            if delivery == .accepted { outgoing[id] = nil }
            guard item != before, consumer.voiceTurn.eventID == prompt.promptID else { continue }
            switch delivery {
            case .accepted: voiceFeedback = "已发给依米"
            case .rejected: voiceFeedback = Self.voiceNotSent
            case .unconfirmed: voiceFeedback = Self.voiceUnconfirmed
            case .queued: voiceFeedback = "排队中 · 她处理完上一句就发"
            case .pending: break
            }
        }
        conversation.timeline.settleTypedSends(consumer); timeline = conversation.timeline.chatItems
        if timeline != before { persistConversation() }
    }
    private func failUnsubmitted(_ prompt: AssistantPromptEnvelope) {
        guard let id = outgoing.first(where: { $0.value.promptID == prompt.promptID })?.key else { return }
        // Once Core owns a packet, its delivery state decides the row, even if the caller throws later.
        if central.submissionDelivery(eventID: prompt.promptID) == nil {
            setDelivery(id, .failed); persistConversation()
        }
    }
    /// A row restored from an earlier run keeps only its text; one with files needs its original envelope.
    private func retryPrompt(_ item: YimiItem) -> AssistantPromptEnvelope? {
        outgoing[item.id] ?? (item.kind == .me && item.offersTextResend && (item.attachments ?? []).isEmpty
            ? AssistantPromptEnvelope(promptID: String(item.id.dropFirst("me-".count)), text: item.text) : nil)
    }
    func canRetry(_ item: YimiItem) -> Bool {
        item.offersTextResend && retryPrompt(item) != nil && timeline.first(where: { $0.id == item.id })?.delivery == item.delivery && (item.delivery == .failed || item.delivery == .unconfirmed)
    }
    func retry(_ item: YimiItem) async {
        guard !sending, canRetry(item), let prompt = retryPrompt(item) else { return }
        let generation = connectionID
        sending = true; defer { sending = false }
        do {
            guard let session else { throw CentralTextError.unavailable }
            guard await acceptCurrentSnapshot(from: session, generation: generation) else { return }
            guard canRetry(item) else { return }
            // Within its own session an unconfirmed voice turn resends its identical packet; anything else (a rejected
            // request, or one from an earlier session) is sent again as a new request.
            if item.delivery == .unconfirmed, central.canResendVoice(eventID: prompt.promptID) {
                try await session.retryVoiceSend()
            } else {
                let replacement = AssistantPromptEnvelope(promptID: RealtimeUUIDv7.make(), text: prompt.text, attachments: prompt.attachments)
                conversation.timeline.remove(ids: [item.id])
                outgoing[item.id] = nil
                addOutgoing(replacement, via: item.via ?? "text")
                await submit(replacement, session: session)
            }
            _ = await acceptCurrentSnapshot(from: session, generation: generation)
        } catch { if connectionID == generation { self.error = DesktopUserFacingError.message(error) } }
    }
    func shown(_ item: YimiItem) async {
        let generation = connectionID
        shownTexts[item.id] = item.text
        guard NSApp?.isActive == true, NSApp?.keyWindow?.title == "依米",
              let presentation = unacknowledged[item.id], item.text == QwenHandoff.split(presentation.text).display,
              await persistConversation().value, connectionID == generation,
              conversation.timeline.item(id: item.id)?.text == item.text, let session else { return }
        do {
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try await session.centralTextConsumed(presentation, observedAt: formatter.string(from: Date()))
            unacknowledged[item.id] = nil
        } catch { self.error = DesktopUserFacingError.message(error) }
    }
    func shownTimeline() async { for item in timeline where shownTexts[item.id] == item.text { await shown(item) } }
    func send() async {
        guard !sending else { return }
        let text = composer.text.trimmingCharacters(in: .whitespacesAndNewlines), attachments = composer.prepare()
        guard !text.isEmpty || !attachments.isEmpty else { return }
        sending = true; defer { sending = false }
        let prompt = AssistantPromptEnvelope(promptID: RealtimeUUIDv7.make(), text: text.isEmpty ? "请处理这些文件。" : text, attachments: attachments)
        addOutgoing(prompt)
        composer.submitted(text: composer.text, files: Set(composer.files.map(\.id)))
        guard let session else { failUnsubmitted(prompt); return }
        await submit(prompt, session: session)
    }
    private func submit(_ prompt: AssistantPromptEnvelope, session: AssistantSessionCoordinator) async {
        let generation = connectionID
        do {
            try await session.submitPrompt(prompt)
            guard connectionID == generation else { return }
            error = nil
        } catch {
            // The publish can throw after the server accepted it. Read authority before marking a failure.
            guard await acceptCurrentSnapshot(from: session, generation: generation) else { return }
            failUnsubmitted(prompt)
            return
        }
        _ = await acceptCurrentSnapshot(from: session, generation: generation)
    }
    func setWakeEnabled(_ enabled: Bool) async {
        guard let session else { return }
        let generation = connectionID
        do {
            try await session.setWakeEnabled(enabled)
            _ = await acceptCurrentSnapshot(from: session, generation: generation)
        } catch {
            guard await acceptCurrentSnapshot(from: session, generation: generation) else { return }
            self.error = DesktopUserFacingError.message(error)
        }
    }
    func holdStart() async {
        guard connected, !listening, let session else { return }
        let generation = connectionID
        press &+= 1; let current = press; listening = true; autoSend = false; error = nil; listeningText = ""; voiceFeedback = "已发给依米"
        do { try await session.pressVoiceTurn(current) } catch { if connectionID == generation { self.error = DesktopUserFacingError.message(error); voiceFeedback = DesktopUserFacingError.message(error); listening = false } }
    }
    func holdEnd() async {
        guard listening, let session else { return }
        let generation = connectionID
        listening = false; autoSend = true; voiceFeedback = "正在识别…"; error = nil
        do {
            let committed = try await session.releaseVoiceTurn(press, cancel: false)
            guard connectionID == generation else { return }
            if !committed { autoSend = false; voiceFeedback = "没听清，请按住再说一次" }
        } catch {
            guard connectionID == generation else { return }
            self.error = DesktopUserFacingError.message(error); autoSend = false; voiceFeedback = "未能发送，请再试一次"
        }
    }
    func holdCancel() async {
        let generation = connectionID
        listening = false; autoSend = false; voiceFeedback = "已取消"
        do { _ = try await session?.releaseVoiceTurn(press, cancel: true) } catch { if connectionID == generation { self.error = DesktopUserFacingError.message(error) } }
    }
    private func syncOwnerSSH() { ownerSSH?.update(pairing: pairing, paused: pause.paused) { [weak self] in self?.error = $0 } }
    func togglePause() async { if (await desktop.pauseState()).paused { await desktop.resume(.manual) } else { ownerSSH?.shutdown(); await desktop.pause(.manual) } }
    var chatEntries: [DesktopChatEntry] {
        let shown = chatWindow.rows(timeline)
        let floor = shown.count < timeline.count ? shown.first?.date : nil
        let messages = shown.map(DesktopChatEntry.message)
        let files = auditEntries.filter { $0.result == "ok" && $0.undoneAt == nil && $0.reveal != nil && ["save_from_workshop", "write_file"].contains($0.tool) && $0.at >= (floor ?? .distantPast) }.map(DesktopChatEntry.file)
        var entries = (messages + files).sorted { $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date }
        let layout = YimiActivityLayout(items: timeline, activities: activities, consumer: central)
        for activity in activities {
            let collapsed = activity.collapsed(replyProcessedIDs: layout.replyProcessedIDs)
            let entry = DesktopChatEntry.activity(activity, collapsed: collapsed)
            if let anchor = layout.anchor(for: activity) {
                // An activity anchored above the window is older history and stays hidden with it.
                if let index = entries.firstIndex(where: { $0.id == "message-" + anchor }) { entries.insert(entry, at: index + 1) }
            } else { entries.append(entry) }
        }
        return entries
    }
    func authorizeOnboardingFolders(suggestions: Set<String>, output: Bool,
                                    home: URL = FileManager.default.homeDirectoryForCurrentUser) async throws {
        for name in suggestions.sorted() { _ = try await desktop.authorize(folder: home.appendingPathComponent(name), write: true) }
        if output {
            let folder = home.appendingPathComponent("Documents/依米", isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            _ = try await desktop.authorize(folder: folder, write: true)
        }
        await refreshFolders()
    }
    func refreshFolders() async { folders = await desktop.folders() }
    func refreshActivity() async {
        do { auditEntries = try await desktop.audit(before: nil, limit: 100); grants = await desktop.grants() }
        catch { self.error = DesktopUserFacingError.message(error) }
    }
    func loadOlderActivity() async {
        guard let before = auditEntries.last?.at else { return }
        do { auditEntries += try await desktop.audit(before: before, limit: 100) } catch { self.error = DesktopUserFacingError.message(error) }
    }
    func loadOlder() async {
        guard chatWindow.older(loaded: timeline.count) else { return }
        guard let seq = timeline.compactMap(\.seq).min() else { return }
        do { try await session?.loadOlderTimeline(beforeSeq: seq) } catch { self.error = DesktopUserFacingError.message(error) }
    }
    func cancelErrand(_ id: String) async { do { try await session?.cancelErrand(id) } catch { self.error = DesktopUserFacingError.message(error) } }
    func terminalRevoke(_ id: String) async { do { try await session?.revokeTerminal(deviceID: id) } catch { self.error = DesktopUserFacingError.message(error) } }
    func terminalPause(_ id: String, paused: Bool) async { do { try await session?.pauseDesktop(deviceID: id, paused: paused) } catch { self.error = DesktopUserFacingError.message(error) } }
    func unpair() async {
        guard canUnpair, let pairing else { return }
        unpairing = true
        defer { unpairing = false }
        ownerSSH?.shutdown()
        if let ownerSSH {
            do { try ownerSSH.rememberRevocation(pairing) }
            catch {
                await clearPairing()
                self.error = "这台电脑已停止连接；云端解绑意图未能保存：" + DesktopUserFacingError.message(error)
                return
            }
            await clearPairing()
            resumeRevocations()
        } else {
            let coordinator = session
            await clearPairing()
            do { try await coordinator?.revokeTerminal(deviceID: pairing.deviceID) }
            catch { self.error = DesktopUserFacingError.message(error) }
        }
    }
    private func resumeRevocations() {
        do {
            if try ownerSSH?.hasPendingRevocations() == true { unpairStatus = "已在本机解除；服务器端待同步" }
        } catch { self.error = DesktopUserFacingError.message(error) }
        ownerSSH?.resumeRevocations { [weak self] message in
            guard let self else { return }
            if let message { error = message }
            else {
                if error == revocationError { error = nil }
                if unpairStatus != nil { unpairStatus = "这台电脑已解除配对" }
            }
            revocationError = message
        }
    }
    private func transitionDesktop(active: Bool) -> Task<Void, Never> {
        if !active { desktopReady = false }
        let previous = desktopTransition, generation = connectionID, wire = transport
        let next = Task { [desktop] in
            await previous?.value
            if active {
                guard connectionID == generation, let wire else { return }
                await desktop.start(transport: wire)
            } else {
                await desktop.stop()
                do { try await wire?.removeTemporaryFiles() } catch { self.error = DesktopUserFacingError.message(error) }
            }
        }
        desktopTransition = next
        return next
    }
    func prepareForTermination() async throws {
        wechatPreview.stop()
        if pairing != nil { _ = await persistConversation().value }
        guard await androidHost?.requiresShutdown() == true else { return }
        connectionID = UUID(); reconnect?.cancel(); reconnect = nil
        ownerSSH?.shutdown(); transport?.finish()
        let stopped = transitionDesktop(active: false)
        await screenSharing?.stop()
        _ = await session?.stop(reasonCode: "user_stop"); await stopped.value
        try await androidHost?.shutdown()
    }
    private func clearPairing() async {
        wechatPreview.stop(); ownerSSH?.shutdown()
        let clearing = UUID(); connectionID = clearing
        reconnect?.cancel(); reconnect = nil; reconnectAttempt = 0
        let old = session, oldWire = transport, oldScreen = screenSharing
        session = nil; transport = nil; screenSharing = nil; oldWire?.finish()
        YimiAvatarStore.shared.bind(nil)
        composer.clear(); conversation = CentralTerminalState(); unacknowledged = [:]; shownTexts = [:]; outgoing = [:]; central = AssistantCentralTextConsumer(); lastTerminalReceiptID = nil
        listening = false; listeningText = ""; autoSend = false; lastVoicePhase = nil
        callEngine = nil; callSnapshot = nil; call = CentralCall(); callPreview.update(.cleared)
        voiceEnrollment = CentralVoiceEnrollment()
        connected = false; pairing = nil; connectionLabel = "这台电脑已解除配对"
        timeline = []; terminals = []; confirmations = []; errands = []; activities = []
        voiceConfirmations = []; confirmingVoice = []; voiceConfirmationError = nil
        do { try pairingController?.clearPairing() } catch { self.error = DesktopUserFacingError.message(error) }
        do {
            let cache = storeURL.appendingPathComponent("conversation.json")
            cacheVersion &+= 1
            try await cacheWriter.remove(version: cacheVersion, at: cache)
        } catch { self.error = DesktopUserFacingError.message(error) }
        let stopped = transitionDesktop(active: false)
        let teardown = Task { [weak self] in
            await oldScreen?.stop()
            _ = await old?.stop(reasonCode: "desktop_unpaired"); await stopped.value
            do { try await oldWire?.removeTemporaryFiles() } catch { self?.error = DesktopUserFacingError.message(error) }
            guard let self, connectionID == clearing else { return }
            do { try await wechatPreview.reset() } catch { self.error = error.localizedDescription }
            guard connectionID == clearing else { return }
            do { try await notifications?.confirmations([]) } catch { self.error = DesktopUserFacingError.message(error) }
            guard connectionID == clearing else { return }
            do { try await androidHost?.shutdown() } catch { self.error = error.localizedDescription }
        }
        desktopTransition = teardown
        await teardown.value
    }

}

private struct DesktopIdentity: DeviceIdentityStoring {
    let store: DesktopPairingStore
    func deviceID() throws -> UUID {
        guard let data = try store.loadPairingData(), let id = UUID(uuidString: try RealtimeDevicePairing.decode(data).deviceID) else { throw RealtimeDevicePairingError.invalidPairing }
        return id
    }
}

/// Local file outcomes share the conversation's chronology; the audit remains their authority.
enum DesktopChatEntry: Identifiable {
    case message(YimiItem), file(AuditEntry), activity(ActivityPresentation, collapsed: Bool)
    var id: String { switch self { case .message(let item): "message-" + item.id; case .file(let entry): "file-" + entry.id; case .activity(let activity, _): "activity-" + activity.id } }
    var date: Date { switch self { case .message(let item): item.date; case .file(let entry): entry.at; case .activity(let activity, _): activity.arrivedAt } }
}
