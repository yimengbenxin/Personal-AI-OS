import Combine
import CoreLocation
import Foundation
import LiveKit
import UIKit

enum AssistantPromptComposerState: Equatable, Sendable {
    case inactive
    case ready
    case submitting
    case partial
    case final
    case unavailable
}

@MainActor
final class AssistantViewModel: ObservableObject {
    lazy var conversation = YimiConversation(vm: self)
    @Published private(set) var ownerProjectionIdentity: String?
    @Published private(set) var notificationOpenURL: URL?
    @Published private(set) var notificationOpenRevision: UInt64 = 0
    private var answeringQuestion = false
    private var answeredQuestion: AssistantQuestionSelection?
    let ownerOverride = YimiOwnerOverrideModel()
    private var ownerOverrideObservation: AnyCancellable?
    let payment: YimiPaymentModel
    let modelSettings = AssistantModelSettingsModel()
    private var paymentObservation: AnyCancellable?
    private var avatarLoadedObservation: AnyCancellable?
    private var avatarObservation: AnyCancellable?
    private var avatarError: String?
    var appearanceState: AssistantAppearanceState { terminalState.appearance }
    var avatarPrice: AssistantAvatarPrice? { appearanceState.options?.call_quote }
    func refreshAppearance() async {
        do { try await coordinator.requestAppearanceOptions() }
        catch { lastError = Self.message(for: error) }
    }
    func prepareAppearance(lookID: String, focus: CentralAvatarProfile.Focus, expectedVersion: Int, quote: AssistantAppearanceQuote) async {
        do { try await coordinator.prepareAppearance(lookID: lookID, focus: focus, expectedVersion: expectedVersion, quote: quote) }
        catch { lastError = Self.message(for: error) }
    }
    func uploadAppearance(_ data: Data) async throws -> AssistantAppearanceLook {
        guard let pairing = try PairedRealtimeRequestBodyProvider().pairing() else { throw RealtimeDevicePairingError.unavailable }
        let identity = ownerSessionIdentity.snapshot()
        let look = try await AssistantAppearanceImageUpload.upload(data, pairing: pairing)
        guard ownerSessionIdentity.snapshot() == identity,
              try PairedRealtimeRequestBodyProvider().pairing() == pairing else { throw CentralTextError.contextChanged() }
        try await coordinator.registerUploadedAppearance(look, owner: identity.identity)
        return look
    }
    func reconcileAppearance() async {
        do { try await coordinator.reconcileAppearance() }
        catch { lastError = Self.message(for: error) }
    }

    func cancelAppearance() async {
        do { try await coordinator.cancelAppearance() } catch { lastError = Self.message(for: error) }
    }
    func reuseAppearance(_ version: Int) async {
        do { try await coordinator.reuseAppearance(version: version, expectedVersion: terminalState.avatarVersion) } catch { lastError = Self.message(for: error) }
    }
    private func acknowledgeLoadedAppearance() {
        guard let version = YimiAvatarStore.shared.loadedVersion, let owner = YimiAvatarStore.shared.pairingIdentity else { return }
        Task { do { try await coordinator.acknowledgeAppearanceLoaded(version: version, owner: owner) } catch { lastError = Self.message(for: error) } }
    }
    @Published private var sessionSnapshot: AssistantSessionSnapshot?

    var sessionState: AssistantSessionState { sessionSnapshot?.state ?? .idle }
    var watchSessionChanges: AnyPublisher<Void, Never> {
        Publishers.MergeMany([
            $sessionSnapshot.map { $0?.state.isActive ?? false }.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            $sessionSnapshot.map { $0?.rideOwnerIdentity }.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            $sessionSnapshot.map { $0?.rideMetrics }.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            $sessionSnapshot.map { $0?.rideFeedback }.removeDuplicates().map { _ in () }.eraseToAnyPublisher()
        ]).eraseToAnyPublisher()
    }
    var watchRideMetrics: WatchYimiRideMetrics? {
        guard let identity = sessionSnapshot?.rideOwnerIdentity, identity == ownerProjectionIdentity,
              ownerSessionIdentity.matches(identity) else { return nil }
        return sessionSnapshot?.rideMetrics
    }
    var watchRideFeedback: CentralRideFeedback? {
        guard let identity = sessionSnapshot?.rideOwnerIdentity, identity == ownerProjectionIdentity,
              ownerSessionIdentity.matches(identity) else { return nil }
        return sessionSnapshot?.rideFeedback
    }
    @Published private(set) var mediaPermissions =
        AssistantMediaPermissionSnapshot.initial
    @Published private(set) var locationPermission:
        AssistantPermissionStatus = .notDetermined
    /// Projections of the coordinator's media intent (the one owner for this UI and the Watch): `enabled` is the
    /// user's current intent (opening or on); the phase is the honest capture state.
    @Published private(set) var cameraRequestCamera = "back"
    @Published private(set) var cameraRequestVisible = false
    func endCameraRequest() async { await coordinator.endCameraRequest() }
    func sceneActivityChanged(_ active: Bool) async { await coordinator.setAppActive(active) }
    @Published private(set) var cameraEnabled = false
    @Published private(set) var videoCallRequested = false
    @Published private(set) var microphoneEnabled = false
    @Published private(set) var cameraPhase = AssistantMediaPhase.off
    @Published private(set) var microphonePhase = AssistantMediaPhase.off
    var callMuteState: AssistantCallMuteState { AssistantCallMuteState(microphonePhase) }
    // Errands (外卖地址、打车起点) follow the phone's live location, so sharing it is on unless the user turned it off.
    private static let locationChoiceKey = "paios.location.enabled"
    @Published private(set) var locationEnabled = UserDefaults.standard.object(forKey: locationChoiceKey) as? Bool ?? true
    @Published private(set) var latestLocation: AssistantLocationObservation?
    private var latestLocationConsent: UInt64?
    private var locationLossAt: Date?
    @Published private(set) var locationQuality: AssistantLocationQuality = .unavailable
    @Published private(set) var lastError: String?
    @Published private(set) var resultText = ""
    @Published private(set) var resultIsFinal = false
    @Published private(set) var networkState: AssistantNetworkPathState?
    @Published private(set) var startupWarning: String?
    @Published private(set) var watchBindingStatus = "Watch 未登记或状态未同步"
    @Published private(set) var watchBindingBusy = false
    @Published private(set) var canManageWatchBinding = false
    private var registerWatchAction: (@Sendable () async throws -> String)?
    private var revokeWatchAction: (@Sendable () async throws -> String)?

    func configureWatchBindingActions(register: @escaping @Sendable () async throws -> String,
        revoke: @escaping @Sendable () async throws -> String) {
        registerWatchAction = register
        revokeWatchAction = revoke
        canManageWatchBinding = true
    }

    func manageWatchBinding(revoke: Bool) async {
        guard !watchBindingBusy, let action = revoke ? revokeWatchAction : registerWatchAction else { return }
        watchBindingBusy = true
        defer { watchBindingBusy = false }
        do { watchBindingStatus = try await action() }
        catch { watchBindingStatus = "Watch 登记未确认；请检查配对、服务端版本和授权后重试" }
    }

    @Published private(set) var textOwner = AssistantTextOwner.legacy
    @Published private(set) var centralPresentation: CentralTextPresentation?
    /// The latest projected central snapshot: Core's submissionDelivery for the conversation's request rows.
    @Published private(set) var centralSnapshot: AssistantCentralTextConsumer?
    @Published private(set) var centralStatus = "等待明确提交"
    @Published private(set) var centralCanCancelPlayback = false
    @Published private(set) var centralCanRequest = false
    @Published private(set) var centralCanCancelRun = false
    @Published private(set) var centralCanRequestSealed = false
    @Published private(set) var centralCanRetrySubmission = false
    @Published private(set) var centralCanRetryACK = false
    @Published private(set) var typedRecoveryNeedsDecision = false
    @Published private(set) var typedRecoveryEventID: String?
    @Published private(set) var typedRecoveryStatus: String?
    @Published private(set) var centralCanRetryVoiceGeneration = false
    @Published private(set) var centralRetainedVoiceResultIDs: [String] = []
    @Published private(set) var voiceTurn = CentralVoiceTurn()
    @Published private(set) var call = CentralCall()
    @Published private(set) var callPortrait: YimiCallPortraitSnapshot?
    private var portraitCallID: String?
    private var pendingPortraitStart: UUID?
    @Published private(set) var voiceStatus = AssistantVoiceStatus()
    @Published var openVoiceCallRequested = false
    private let callActivity = CallActivityController()
    private var activityEndedCallID: String?
    private var activityRefresh: Task<Void, Never>?
    @Published private(set) var callFailure: String?
    @Published private(set) var componentVideoFailure = false
    @Published private(set) var isDialing = false
    @Published var callSilenceTimeout = CallSilenceTimeout.load() {
        didSet { UserDefaults.standard.set(callSilenceTimeout.rawValue, forKey: CallSilenceTimeout.preferenceKey) }
    }
    @Published private(set) var errands: [CentralErrand] = []
    @Published private(set) var activities: [ActivityPresentation] = []
    /// 随身模式: the user's standing choice (kept across launches) and its honest capture state.
    private static let wakeChoiceKey = "paios.wake.enabled"
    @Published private(set) var wakeEnabled = UserDefaults.standard.bool(forKey: wakeChoiceKey)
    @Published private(set) var wakeStatus = "本地唤醒已关闭"
    private static let ambientChoiceKey = "paios.ambient.enabled"
    @Published private(set) var ambientEnabled = UserDefaults.standard.bool(forKey: ambientChoiceKey)
    @Published private(set) var ambientPhase = AssistantAmbientPhase.off
    /// 录入我的声音 (the formal channel's view of it), pending "确认是我" prompts and 随身模式 replies.
    @Published private(set) var voiceprint = CentralVoiceprint()
    @Published private(set) var voiceEnrollment = CentralVoiceEnrollment()
    @Published private(set) var voiceEnrollmentBusy = false
    @Published private(set) var voiceEnrollmentError: String?
    @Published private(set) var voiceConfirmations: [CentralVoiceConfirmation] = []
    @Published private(set) var authenticatingVoice = Set<String>()
    @Published private(set) var confirmingVoice: Set<String> = []
    @Published private(set) var careCheckins: [CentralAmbientReply] = []
    @Published private(set) var careCheckinIdentity: String?
    @Published private(set) var careAnswering = false
    @Published private(set) var careOutcome: String?
    @Published private(set) var ambientReplies: [CentralAmbientReply] = []
    @Published private(set) var questionCard: CentralQuestion?
    private var centralCanSubmit = true
    private var latestCentralGeneration: UInt64 = 0
    private var latestCentralRevision: UInt64 = 0
    @Published private(set) var centralMemoryProposals: [CentralMemoryProposal] = []
    @Published private(set) var centralMemoryStatus = "待批记录尚未读取"
    @Published private(set) var centralMemoryRetryControls: [String] = []
    @Published private(set) var centralMemoryDecisionIDs: Set<String> = []

    func requestCentralControl(_ operation: String, eventID: String? = nil) async {
        do { try await coordinator.requestCentralControl(operation, eventID: eventID) }
        catch { lastError = Self.message(for: error) }
    }

    // Push-to-talk takes the microphone itself (the coordinator holds it for the window only).
    var canUseVoiceTurn: Bool {
        guard textOwner == .centralCandidate, activeSessionFence != nil,
              case .active(let encryptionActive) = sessionState else { return false }
        return encryptionActive
    }

    /// Opens a call on the current session. The coordinator owns the attempt: a hang-up during permission,
    /// location or publish cancels it. Returns whether the call was opened.
    @discardableResult
    func startCall(video: Bool = false) async -> Bool {
        let portraitAttempt = UUID()
        if !call.isActive {
            pendingPortraitStart = portraitAttempt
            callPortrait = captureCallPortrait()
        }
        do {
            lastError = nil
            let cameraOn = try await coordinator.startCall(video: false, camera: video,
                startIntent: AssistantStartIntent(locationEnabled: locationEnabled, userInitiated: true)) { [weak self] in
                await self?.callLocation()
            }
            if video && !cameraOn { lastError = "摄像头没打开" }
            return true
        } catch AssistantSessionCoordinatorError.superseded {
            clearFailedCallPortrait(portraitAttempt)
            return false
        } catch {
            clearFailedCallPortrait(portraitAttempt)
            lastError = Self.message(for: error)
            return false
        }
    }

    private func captureCallPortrait() -> YimiCallPortraitSnapshot {
        let avatar = YimiAvatarStore.shared
        guard ownerSessionIdentity.matches(avatar.pairingIdentity) else {
            return YimiCallPortraitSnapshot(ownerIdentity: ownerProjectionIdentity, profile: nil, imageData: nil)
        }
        return YimiCallPortraitSnapshot(ownerIdentity: avatar.pairingIdentity, profile: avatar.profile, imageData: avatar.imageData)
    }

    private func clearFailedCallPortrait(_ attempt: UUID) {
        guard pendingPortraitStart == attempt else { return }
        pendingPortraitStart = nil; callPortrait = nil
    }

    private func clearCallPortraitForOwner(_ identity: String?) {
        guard let portrait = callPortrait, portrait.ownerIdentity != identity else { return }
        callPortrait = nil; pendingPortraitStart = nil; portraitCallID = nil
    }

    func endCall() async {
        activityEndedCallID = sessionSnapshot?.voiceActivityCallID ?? call.id
        activityRefresh?.cancel(); activityRefresh = nil
        callActivity.end()
        do { try await coordinator.endCall() } catch { lastError = Self.message(for: error) }
    }

    private var voicePressCounter: UInt64 = 0

    /// A new hold-to-talk press id, minted synchronously when the finger goes down.
    func nextVoicePress() -> UInt64 {
        voicePressCounter &+= 1
        return voicePressCounter
    }

    /// Opens the window for `press`; false when it could not (not connected, refused, or already released).
    func pressVoice(_ press: UInt64) async -> Bool {
        do {
            try await coordinator.pressVoiceTurn(press,
                startIntent: AssistantStartIntent(locationEnabled: locationEnabled, userInitiated: true))
            return true
        }
        catch AssistantSessionCoordinatorError.superseded { return false }
        catch { lastError = Self.message(for: error); return false }
    }

    /// Ends `press`: commits its window, or cancels it (also when it never opened). Returns whether it committed.
    @discardableResult
    func releaseVoice(_ press: UInt64, cancel: Bool) async -> Bool {
        do { return try await coordinator.releaseVoiceTurn(press, cancel: cancel) }
        catch { lastError = Self.message(for: error); return true }
    }

    func voicePressed() async {
        _ = await pressVoice(nextVoicePress())
    }

    func voiceReleased() async {
        await releaseVoice(voicePressCounter, cancel: false)
    }

    /// Sends the chosen transcript; false when it was refused locally. An unknown outcome is not a failure: the
    /// turn ends `unconfirmed` and its line offers a text resend.
    @discardableResult
    func sendVoiceCandidate(_ candidate: CentralVoiceCandidate) async -> Bool {
        do { try await coordinator.sendVoiceTurn(candidate); return true }
        catch { lastError = Self.message(for: error); return false }
    }

    func cancelErrand(_ id: String) async {
        do { try await coordinator.cancelErrand(id) }
        catch { lastError = Self.message(for: error) }
    }

    func cancelErrand(_ id: String, identity: String) async -> Bool {
        guard ownerSessionIdentity.matches(identity), ownerProjectionIdentity == identity else { return false }
        do { try await coordinator.cancelErrand(id, identity: identity); return true }
        catch { lastError = Self.message(for: error); return false }
    }

    /// Chat and Watch share one selection admission and the owner's existing timeline.
    func answerQuestion(cardID: String, optionID: String) async -> Bool {
        guard !answeringQuestion, canAcceptPrompt, let identity = ownerProjectionIdentity,
              ownerSessionIdentity.matches(identity), let card = questionCard else { return false }
        let selection = AssistantQuestionSelection(identity: identity, cardID: cardID, optionID: optionID)
        guard !(answeredQuestion?.identity == identity && answeredQuestion?.cardID == cardID),
              let text = try? selection.text(for: card, now: Date()) else { return false }
        answeringQuestion = true
        defer { answeringQuestion = false }
        let result = await conversation.send(text, question: selection)
        if result == .submitted { answeredQuestion = selection; return true }
        return false
    }

    func cancelVoiceTurn() async {
        do { try await coordinator.closeVoiceTurn() }
        catch { lastError = Self.message(for: error) }
    }

    func requestCentralResult(sealed: Bool = false) async {
        do { try await coordinator.requestCentralResult(sealed: sealed) }
        catch {
            let source = await coordinator.centralTextSnapshot()
            do { lastError = try sealed && !source.canRequestSealedResult ? source.status : "结果尚未确认；保留原提交，稍后可主动取得结果。" }
            catch { lastError = Self.message(for: error) }
        }
    }

    func requestCentralRetainedResult(_ processedID: String) async {
        do { try await coordinator.requestCentralRetainedResult(processedID: processedID) }
        catch { lastError = Self.message(for: error) }
    }

    func requestCentralMemoryProposals() async {
        let id = UUID().uuidString.lowercased(), generation = latestCentralGeneration, revision = latestCentralRevision
        do { try await coordinator.requestCentralMemoryProposals(controlID: id) }
        catch { await centralMemoryRequestFailed(controlID: id, generation: generation, revision: revision) }
    }

    func decideCentralMemory(_ proposal: CentralMemoryProposal, choice: CentralMemoryDecision.Choice) async {
        let id = UUID().uuidString.lowercased(), generation = latestCentralGeneration, revision = latestCentralRevision
        do { try await coordinator.decideCentralMemory(proposal, choice: choice, controlID: id) }
        catch { await centralMemoryRequestFailed(controlID: id, generation: generation, revision: revision) }
    }

    func retryCentralMemoryControl(_ controlID: String) async {
        let generation = latestCentralGeneration, revision = latestCentralRevision
        do { try await coordinator.retryCentralMemoryControl(controlID) }
        catch { await centralMemoryRequestFailed(controlID: controlID, generation: generation, revision: revision) }
    }

    private func centralMemoryRequestFailed(controlID: String, generation: UInt64, revision: UInt64) async {
        let source = await coordinator.centralTextSnapshot()
        guard source.generation == generation, canProjectCentralSnapshot(source) else { return }
        consumeCentralState(source)
        if source.pendingMemoryControls.contains(controlID) {
            lastError = "待批请求仍未确认；重试会发送原控制包，不创建新决定。"
        } else if source.revision == revision, source.binding != nil {
            lastError = "待批请求未发送；请重读原记录后再决定。"
        }
    }

    func retryCentralSubmission() async {
        do { try await coordinator.retryCentralSubmission() }
        catch { lastError = "原提交接纳尚未确认；没有创建新事件。" }
    }

    func centralTextSurfaceConsumed(_ presentation: CentralTextPresentation) async {
        guard isActivePromptSessionForResult() else { return }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        do { try await coordinator.centralTextConsumed(presentation, observedAt: formatter.string(from: Date())) }
        catch {
            if presentation == centralPresentation { lastError = "界面已消费文字，显示回执尚未确认。" }
        }
    }

    func retryCentralRenderedACK() async {
        do { try await coordinator.retryCentralRenderedACK() }
        catch {
            let source = await coordinator.centralTextSnapshot()
            guard canProjectCentralSnapshot(source) else { return }
            consumeCentralState(source)
            if !source.pendingRenderedACKs.isEmpty { lastError = "显示回执仍未确认；保留原回执等待重发。" }
        }
    }

    @Published var promptText = ""
    @Published private(set) var promptID: String?
    @Published private(set) var promptState = AssistantPromptComposerState.inactive

    @Published private(set) var terminalState = CentralTerminalState()
    private let terminalCacheWriter = CentralTerminalCacheWriter()
    private var terminalCacheVersion: UInt64 = 0
    func revokeTerminal(_ id: String) async {
        do { try await coordinator.revokeTerminal(deviceID: id) } catch { lastError = Self.message(for: error) }
    }
    func pauseDesktop(_ id: String, paused: Bool) async {
        do { try await coordinator.pauseDesktop(deviceID: id, paused: paused) } catch { lastError = Self.message(for: error) }
    }
    func olderTimeline(before: Int) async {
        do { try await coordinator.loadOlderTimeline(beforeSeq: before) } catch { lastError = Self.message(for: error) }
    }
    private let coordinator: AssistantSessionCoordinator
    private let permissionProvider: any MediaPermissionProviding
    private let locationService: LocationService
    private let ambientLocation: AssistantAmbientLocationFeed
    private var navigationCredentialAccess: Bool?
    private var lastAmbientGeocode = Date.distantPast
    private let resultStreaming: any AssistantResultStreaming
    private let mediaLifecycle: AssistantMediaLifecycle
    private let networkMonitor: any AssistantNetworkPathMonitoring
    private var reminderSyncError: String?
    private var reminderSnapshot: [AssistantReminder]?
    private var reminderPairingIdentity: String?
    private let ownerSessionIdentity = RealtimePairingSessionIdentity.shared
    private var appliedReminderSnapshot: [AssistantReminder]?
    private var reminderRetryGeneration = 0
    @Published private(set) var notificationPermission: AssistantNotificationAuthorizationStatus = .notDetermined
    private var reminderSyncTask: Task<Void, Never>?
    private let notificationCenter: AssistantNotificationCenter
    let videoPreviewModel: AssistantVideoPreviewModel
    private var networkTask: Task<Void, Never>?
    private var gatewayReconnect: Task<Void, Never>?
    private var gatewayReconnectAttempt = 0
    private var lifecycleObserver: AssistantMediaLifecycleObserver?
    /// The coordinator's live session generation: whoever started the session (this UI or the Watch), every
    /// projection follows it, and a failed concurrent start can never clear it.
    private var activeSessionFence: UInt64? { sessionSnapshot?.sessionGeneration }
    private var projectedSessionGeneration: UInt64?
    private var pendingPromptIDs = Set<String>()

    init(
        coordinator: AssistantSessionCoordinator? = nil,
        permissionProvider: any MediaPermissionProviding =
            MediaPermissionCoordinator(),
        locationService: LocationService,
        resultStreaming: (any AssistantResultStreaming)? = nil,
        mediaLifecycle: AssistantMediaLifecycle? = nil,
        networkMonitor: (any AssistantNetworkPathMonitoring)? = nil,
        notificationCenter: AssistantNotificationCenter? = nil,
        videoPreviewModel: AssistantVideoPreviewModel? = nil,
        startupWarning: String? = nil
    ) {
        let resolvedVideoPreviewModel =
            videoPreviewModel ?? AssistantVideoPreviewModel()
        self.permissionProvider = permissionProvider
        self.locationService = locationService
        self.ambientLocation = AssistantAmbientLocationFeed(locationService: locationService)
        self.resultStreaming = resultStreaming ?? AssistantResultStreamReducer()
        self.mediaLifecycle = mediaLifecycle ?? AssistantMediaLifecycle()
        self.networkMonitor = networkMonitor ?? NetworkPathMonitor()
        self.notificationCenter =
            notificationCenter ?? AssistantNotificationCenter()
        self.payment = YimiPaymentModel(notifications: self.notificationCenter,
            timeout: (Bundle.main.object(forInfoDictionaryKey: "PaymentResponseTimeoutSeconds") as? NSNumber)?.doubleValue)
        self.videoPreviewModel = resolvedVideoPreviewModel
        self.startupWarning = startupWarning

        if let coordinator {
            self.coordinator = coordinator
        } else {
            let roomOperator = SystemLiveKitRoomOperator(
                encryptionProvider:
                    UnavailableLiveKitEncryptionOptionsProvider(),
                videoTrackObserver: { [weak resolvedVideoPreviewModel] update in
                    resolvedVideoPreviewModel?.update(update)
                }
            )
            self.coordinator = AssistantSessionCoordinator(
                bootstrapProvider:
                    UnconfiguredAssistantBootstrapProvider(),
                realtime: LiveKitSessionAdapter(
                    roomOperator: roomOperator
                ),
                mediaPermissions: permissionProvider,
                locationService: locationService,
                receipts: AppleReceiptStore()
            )
        }

        let appLock = payment.appLock
        self.notificationCenter.paymentPrivacyRequired = { [weak appLock] in
            guard let appLock else { return true }
            return appLock.covered || appLock.obscured || UIApplication.shared.applicationState != .active
        }
        self.avatarLoadedObservation = YimiAvatarStore.shared.$loadedVersion.dropFirst().sink { [weak self] _ in Task { @MainActor in self?.acknowledgeLoadedAppearance() } }
        self.avatarObservation = YimiAvatarStore.shared.$error.sink { [weak self] error in
            guard let self else { return }
            if let error { self.lastError = error }
            else if self.lastError == self.avatarError { self.lastError = nil }
            self.avatarError = error
        }
        self.ownerOverrideObservation = ownerOverride.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        self.paymentObservation = payment.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        self.notificationCenter.onPaymentOpen = { [weak self] in
            await MainActor.run { self?.openPaymentRequested = true }
        }
        self.notificationCenter.onCardOpen = { [weak self] url in
            await MainActor.run {
                self?.notificationOpenURL = url
                self?.notificationOpenRevision &+= 1
            }
        }
        self.coordinator.setLocationConsent(self.locationEnabled)
        locationService.onAuthorizationChange = { [weak self] in self?.syncAmbientLocation() }
        Task { [weak self] in
            guard let self else {
                return
            }
            let identity = (try? PairedRealtimeRequestBodyProvider().pairing()).map(CentralOwnerDataIdentity.pairing)
            YimiAvatarStore.shared.bind(identity)
            let cacheURL = identity.flatMap { id in FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("yimi-terminal-" + id + ".json") }
            var cacheReadable = true
            if let cacheURL, FileManager.default.fileExists(atPath: cacheURL.path) {
                do { try await self.coordinator.setTerminalCache(data: Data(contentsOf: cacheURL)) }
                catch { cacheReadable = false; self.lastError = "共享对话缓存无法读取：" + Self.message(for: error) }
            }
            let writableCache = cacheReadable ? cacheURL : nil
            await self.coordinator.setTerminalObserver { [weak self] state in
                Task { @MainActor in
                    guard state.historyGeneration >= (self?.terminalState.historyGeneration ?? 0) else { return }
                    if let reset = state.historyResetID, reset != self?.terminalState.historyResetID {
                        self?.call = CentralCall(); self?.voiceTurn = CentralVoiceTurn()
                        self?.errands = []; self?.activities = []; self?.ambientReplies = []
                        self?.questionCard = nil; self?.careCheckins = []; self?.centralMemoryProposals = []
                        self?.centralPresentation = nil
                    }
                    self?.terminalState = state
                    self?.syncAmbientLocation()
                    await self?.requestGlassesStandbyAuthorization()
                    if let owner = state.ownerIdentity, RealtimePairingSessionIdentity.shared.matches(owner) {
                        YimiAvatarStore.shared.bind(owner)
                        if state.avatarReceived { YimiAvatarStore.shared.accept(state.avatar, ownerIdentity: state.ownerIdentity, eventID: state.avatarEventID, profileVersion: state.avatarVersion); self?.acknowledgeLoadedAppearance() }
                    }
                    if let writableCache, let self {
                        self.terminalCacheVersion &+= 1
                        let version = self.terminalCacheVersion
                        Task(priority: .utility) {
                            do { try await self.terminalCacheWriter.write(state, version: version, to: writableCache) }
                            catch { self.lastError = "共享对话缓存未保存：" + Self.message(for: error) }
                        }
                    }
                }
            }
            let restoreWake = self.wakeEnabled
            await self.coordinator.setObserver { [weak self] state in
                Task { @MainActor in
                    self?.apply(state)
                }
            }
            if restoreWake {
                do { try await self.coordinator.setWakeEnabled(true) }
                catch { self.lastError = "本地唤醒未启动：" + Self.message(for: error) }
            }
            try? await self.coordinator.setAmbient(self.ambientEnabled)
            await self.coordinator.setAppActive(UIApplication.shared.applicationState == .active)
            await self.refreshPermissions()
            await self.configureObservers()
            // Runs during location-triggered process launch too, without waiting for a SwiftUI scene task.
            self.syncAmbientLocation()
        }
    }

    var canStart: Bool {
        sessionSnapshot?.canStart ?? false
    }

    var canStop: Bool {
        sessionState.canStop
    }

    /// Whether the session can take a new request right now (independent of any composer's text).
    var canAcceptPrompt: Bool {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"), ProcessInfo.processInfo.environment["YIMI_ACTIVITY_FIXTURES"] != nil { return true }
#endif
        guard (textOwner == .centralCandidate ? centralCanSubmit : pendingPromptIDs.isEmpty),
              activeSessionFence != nil,
              case .active(let encryptionActive) = sessionState
        else {
            return false
        }
        return encryptionActive
    }

    var canSubmitPrompt: Bool {
        !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && canAcceptPrompt
    }

    var promptStatusText: String {
        if textOwner == .centralCandidate { return centralStatus }
        switch promptState {
        case .inactive:
            return "启动 E2EE 会话后可发送"
        case .ready:
            return "可发送到当前会话"
        case .submitting:
            return "正在生成本次回答"
        case .partial:
            return "已收到部分回答"
        case .final:
            return "回答已完成"
        case .unavailable:
            return "生产环境尚未配置助手会话"
        }
    }

    var e2eeSummary: String {
        switch sessionState {
        case .active(let encryptionActive):
            return encryptionActive ? "已启用" : "正在验证"
        case .encryptionPreparing:
            return "正在准备"
        case .failed(let code) where code.contains("e2ee"):
            return "失败并已关闭媒体"
        default:
            return "连接时强制启用"
        }
    }

    func refreshPermissions() async {
        mediaPermissions = await permissionProvider.snapshot()
        locationPermission = await locationService.authorizationStatus()
        await refreshNotificationPermissions()
    }

    func refreshNotificationPermissions(retryDirty: Bool = false) async {
        let status = await notificationCenter.authorizationStatus()
        let changed = status != notificationPermission
        notificationPermission = status
        if changed { appliedReminderSnapshot = nil }
        if changed || retryDirty {
            reminderRetryGeneration += 1
            if let reminders = reminderSnapshot { syncReminders(reminders) }
        }
    }

    /// Explicit reminder consent does not acquire a microphone or start ambient capture.
    func requestReminderAuthorization() async {
        do {
            _ = try await notificationCenter.requestAuthorization(userInitiated: true)
            await refreshNotificationPermissions(retryDirty: true)
        } catch { lastError = error.localizedDescription }
    }

    /// Connects the session as a media-free control connection (text, results, call/voice controls). Media is
    /// only ever opened later by an explicit call or hold-to-talk, so reconnecting on return to the app can never
    /// resume capture. Single-flight: concurrent callers (launch, foreground, Qwen callback) share one start.
    func start() async {
        lastError = startupWarning
        do {
            try await coordinator.ensureActive(AssistantStartIntent(locationEnabled: locationEnabled, userInitiated: true))
            apply(await coordinator.presentationSnapshot())
            if locationEnabled { await captureLocation() }
        } catch AssistantSessionCoordinatorError.alreadyRunning {
            // Another starter (the Watch) owns this session; the snapshot projects it.
        } catch {
            lastError = Self.message(for: error)
        }
    }

    /// Terminal connection loss gets a fresh media-free bootstrap on the shared backoff; revocation stops retries.
    private func reconnectAfterConnectionLoss() {
        guard gatewayReconnect == nil else { return }
        let delay = AssistantReconnectBackoff.delay(attempt: gatewayReconnectAttempt); gatewayReconnectAttempt += 1
        gatewayReconnect = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self, !Task.isCancelled else { return }
            await self.start()
            guard !Task.isCancelled else { return }
            self.gatewayReconnect = nil
            if self.sessionState.needsFreshConnection { self.reconnectAfterConnectionLoss() }
        }
    }

    /// Every new session generation, whoever started it, gets the same clean projection and lifecycle guard.
    private func beginSessionProjection() {
        pendingPromptIDs.removeAll(keepingCapacity: true)
        promptID = nil
        promptState = .inactive
        resultText = ""
        resultIsFinal = false
        videoPreviewModel.update(.cleared)
        latestLocation = nil
        locationQuality = .unavailable
        let lifecycle = mediaLifecycle, results = resultStreaming, notifications = notificationCenter
        Task {
            await lifecycle.resetForNextSession()
            await results.reset()
            await notifications.resetForNextSession()
        }
    }

    func stop() async {
        guard canStop else {
            return
        }
        pendingPromptIDs.removeAll(keepingCapacity: true)
        promptState = .inactive
        gatewayReconnect?.cancel(); gatewayReconnect = nil
        _ = await coordinator.stop()
        await mediaLifecycle.stop(reasonCode: "user_stop")
        videoPreviewModel.update(.cleared)
        apply(await coordinator.presentationSnapshot())
    }

    var canRetryRemoteStop: Bool {
        sessionSnapshot?.canRetryRemoteStop ?? false
    }

    func retryRemoteStop() async {
        guard canRetryRemoteStop else { return }
        _ = await coordinator.retryPendingStop()
        apply(await coordinator.presentationSnapshot())
    }

    private var qwenHandedOff = Set<Data>()
    /// Set when iOS refused the automatic hand-off; the result card then offers a one-tap retry.
    @Published private(set) var qwenPendingURL: URL?

    private var qwenOutbox: AssistantLocalOperationDatabase?
    private var qwenSubmitting = false

    private func qwenDatabase() throws -> AssistantLocalOperationDatabase {
        if let qwenOutbox { return qwenOutbox }
        let database = try AssistantLocalOperationDatabase(url: AssistantLocalOperationDatabase.defaultURL())
        qwenOutbox = database
        return database
    }

    private func handOffToQwenIfNeeded(_ presentation: CentralTextPresentation, identity: String?) {
        guard let task = QwenHandoff.split(presentation.text).task, let identity, ownerSessionIdentity.matches(identity),
              !qwenHandedOff.contains(presentation.packet.bytes) else { return }
        do {
            guard let sourceID = try presentation.packet.fields.value("processed_event_id", as: String.self),
                  let pending = try qwenDatabase().preserveQwenHandoff(identity: identity, sourceID: sourceID),
                  let url = QwenHandoff.runURL(task: task, nonce: pending.nonce) else { return }
            qwenHandedOff.insert(presentation.packet.bytes)
            openQwen(url)
        } catch { lastError = Self.message(for: error) }
    }

    func openQwen(_ url: URL? = nil) {
        guard let url = url ?? qwenPendingURL else { return }
        UIApplication.shared.open(url) { [weak self] opened in
#if DEBUG
            print("PAIOS_QWEN_HANDOFF opened", opened, "state=\(UIApplication.shared.applicationState.rawValue)")
#endif
            self?.qwenPendingURL = opened ? nil : url
        }
    }

    /// paios://qwen-result/<nonce>?result=… → send 千问's reply to Hermes as the next turn. Only the callback of
    /// the hand-off this app started is accepted (once); forged, late or repeated callbacks change nothing.
    func receiveQwenCallback(_ url: URL) async {
        do {
            let identity = ownerSessionIdentity.matches(careCheckinIdentity) ? careCheckinIdentity : nil
            guard try qwenDatabase().consumeQwenReply(url, identity: identity, location: identity != nil ? cachedLocation() : nil) != nil else {
                if let data = UserDefaults.standard.data(forKey: "paios.qwen.pending-handoff.v1"),
                   let pending = try? JSONDecoder().decode(QwenHandoff.Pending.self, from: data),
                   QwenHandoff.reply(from: url, pending: pending) != nil {
                    lastError = "旧版千问交接缺少配对身份；原记录已保留，请重新发起交接。"
                }
                return
            }
            if canStart { await start() }
            await sendPendingQwenReply()
        } catch { lastError = Self.message(for: error) }
    }

    private func sendPendingQwenReply() async {
        guard !qwenSubmitting, textOwner == .centralCandidate, let identity = careCheckinIdentity,
              ownerSessionIdentity.matches(identity) else { return }
        do {
            guard let reply = try qwenDatabase().pendingQwenReply(identity: identity) else { return }
            // An allocated submission already belongs to the coordinator's retry path.
            guard typedRecoveryEventID != reply.eventID else { return }
            guard canAcceptPrompt else { lastError = "千问回复已保存；连接恢复、对话空闲后继续发送。"; return }
            qwenSubmitting = true
            defer { qwenSubmitting = false }
            switch await submit(reply.text, retained: reply) {
            case .submitted:
                consumeCentralState(await coordinator.centralTextSnapshot())
            case .unavailable: lastError = "千问回复已保存；对话空闲后继续发送。"
            case .failed(let reason): lastError = "千问回复已保存，尚未接纳：" + reason
            }
        } catch { lastError = Self.message(for: error) }
    }

    func submitPrompt() async {
        await submit(promptText)
    }

    enum PromptSubmission: Equatable { case submitted, unavailable, failed(String) }

    /// Submits exactly this text (the caller's composer owns it); the result says whether the session took it.
    @discardableResult
    func submit(_ text: String, retained: AssistantRetainedPrompt? = nil, question: AssistantQuestionSelection? = nil, eventID: String? = nil) async -> PromptSubmission {
        let prompt = text.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard !prompt.isEmpty else { return .unavailable }
        if !sessionState.isActive {
            do {
                try await coordinator.ensureActive(AssistantStartIntent(locationEnabled: locationEnabled, userInitiated: true))
                apply(await coordinator.presentationSnapshot())
                consumeCentralState(await coordinator.centralTextSnapshot())
            } catch {
                lastError = Self.message(for: error)
                return .failed(Self.message(for: error))
            }
        }
        guard canAcceptPrompt, let fence = activeSessionFence else {
            return .unavailable
        }

        let id = retained?.eventID ?? eventID ?? UUID().uuidString.lowercased()
        let envelope = AssistantPromptEnvelope(
            promptID: id,
            text: prompt
        )
        promptID = id
        promptState = .submitting
        pendingPromptIDs.insert(id)

        do {
            if let retained {
                try await coordinator.submitPrompt(envelope, retained: retained)
            } else {
                let place = await currentLocation()
                try await coordinator.submitPrompt(envelope, location: place.fix, consent: place.consent, question: question)
            }
            if !isActivePromptSession(fence) { pendingPromptIDs.remove(id) }
            // The request's row is added on return; the snapshot it reads must already hold this request.
            consumeCentralState(await coordinator.centralTextSnapshot())
            return .submitted
        } catch {
            let source = await coordinator.centralTextSnapshot()
            if source.submissionDelivery(eventID: id) != nil {
                consumeCentralState(source)
                return .submitted
            }
            pendingPromptIDs.remove(id)
            guard isActivePromptSession(fence) else {
                promptState = .inactive
                return .failed(Self.message(for: error))
            }
            promptState = .ready
            lastError = Self.message(for: error)
            return .failed(Self.message(for: error))
        }
    }

    /// The call's camera / microphone (mute) as an explicit user choice; true once it is in the asked state.
    @discardableResult
    func setCameraEnabled(_ enabled: Bool) async -> Bool {
#if DEBUG
        let tappedAt = ProcessInfo.processInfo.systemUptime
#endif
        let changed = await setMedia(source: .camera, enabled: enabled)
#if DEBUG
        print("PAIOS_CAMERA_CONTROL enabled=\(enabled) completed=\(changed) elapsed_ms=\(Int((ProcessInfo.processInfo.systemUptime - tappedAt) * 1_000))")
#endif
        return changed
    }

    @discardableResult
    func setCallVideo(_ enabled: Bool) async -> Bool {
        do { try await coordinator.setCallVideo(enabled); lastError = nil; return true }
        catch { lastError = Self.message(for: error); return false }
    }

    func setCallConversationMode(_ mode: CallConversationMode) async {
        do { try await coordinator.setCallConversationMode(mode) }
        catch { lastError = Self.message(for: error) }
    }

    func resendCallConversationMode() async {
        do { try await coordinator.resendCallConversationMode() }
        catch { lastError = Self.message(for: error) }
    }

    func retryCallThinking() async {
        do { try await coordinator.retryCallThinking() }
        catch { lastError = Self.message(for: error) }
    }

    @discardableResult
    func setCallAvatarEnabled(_ enabled: Bool, confirmedQuote: AssistantAvatarPrice? = nil) async -> Bool {
        guard !enabled || confirmedQuote != nil && confirmedQuote == avatarPrice else {
            lastError = "收费信息未取得或已变化，请重新确认。数字人保持关闭。"; return false
        }
        do { try await coordinator.setCallAvatar(enabled, quote: confirmedQuote); lastError = nil; return true }
        catch { lastError = Self.message(for: error); return false }
    }

    @discardableResult
    func setCallCameraEnabled(_ enabled: Bool) async -> Bool {
        do { try await coordinator.setCallCamera(enabled); lastError = nil; return true }
        catch { lastError = Self.message(for: error); return false }
    }

    /// Flips the video-avatar call camera; nil when it did not switch. Returns whether the back camera is live.
    func switchARTCCamera() async -> Bool? { try? await coordinator.switchARTCCamera() }

    @discardableResult
    func setMicrophoneEnabled(_ enabled: Bool) async -> Bool {
        await setMedia(source: .microphone, enabled: enabled)
    }

    /// The user's location choice. It applies to the running session at once (the coordinator stops every further
    /// GPS request and drops a fix still in flight when it is turned off).
    func setLocationEnabled(_ enabled: Bool) async {
        UserDefaults.standard.set(enabled, forKey: Self.locationChoiceKey)
        locationEnabled = enabled
        latestLocation = nil
        latestLocationConsent = nil
        ambientLocation.stop()
        let consent = coordinator.setLocationConsent(enabled)
        guard enabled else {
            locationQuality = .unavailable
            syncAmbientLocation()
            return
        }
        do {
            let permission = try await locationService
                .requestWhenInUseAuthorization(userInitiated: true)
            guard coordinator.acceptsLocation(consent), locationEnabled else { return }
            locationPermission = permission
            if locationPermission == .authorized {
                await captureLocation(consent: consent)
                guard coordinator.acceptsLocation(consent), locationEnabled else { return }
                locationEnabled = locationQuality != .unavailable
            } else {
                locationEnabled = false
                locationQuality = .degraded
            }
        } catch {
            guard coordinator.acceptsLocation(consent), locationEnabled else { return }
            locationEnabled = false
            locationQuality = .degraded
            lastError = Self.message(for: error)
        }
        if !locationEnabled { coordinator.setLocationConsent(false, replacing: consent) }
        syncAmbientLocation()
    }

    private var glassesPaired: Bool { terminalState.terminals.contains { $0.device_class == "glasses" } }
    var backgroundLocationNeeded: Bool { locationEnabled && (ambientEnabled || glassesPaired) }

    private func requestGlassesStandbyAuthorization() async {
        guard UIApplication.shared.applicationState == .active, glassesPaired, locationEnabled else { return }
        do { try await locationService.requestAlwaysAuthorization(userInitiated: true, glassesPaired: true) }
        catch { lastError = Self.message(for: error) }
        syncAmbientLocation()
    }

    /// One sensor owner union: 随身模式, or paired glasses with Always, subject to the existing sharing choice.
    private func syncAmbientLocation() {
        let consent = coordinator.locationChoice().version
        ambientLocation.syncOwners(ambient: ambientPhase == .starting || ambientPhase == .on,
            glassesPaired: glassesPaired, locationEnabled: locationEnabled, consent: consent,
            report: { [weak self] fix, moved, lost in self?.ambientFix(fix, moved: moved, lost: lost, consent: consent) },
            reconnect: { [weak self] in Task { await self?.resumeNavigationStandby() } })
        let standby = ambientLocation.navigationStandby
        if UIApplication.shared.applicationState == .active, navigationCredentialAccess != standby {
            do {
                try KeychainRealtimeDevicePairingStore().setNavigationStandbyAccess(enabled: standby)
                try KeychainE2EERecipientKeyStore().setNavigationStandbyAccess(enabled: standby)
                navigationCredentialAccess = standby
            } catch {
                lastError = "后台连接凭据未就绪：" + Self.message(for: error)
            }
        }
        Task { await coordinator.setNavigationStandby(ambientLocation.navigationStandby) }
    }

    private func resumeNavigationStandby() async {
        await coordinator.setNavigationStandby(ambientLocation.navigationStandby)
        guard ambientLocation.navigationStandby else { return }
        do { try await coordinator.ensureActive(AssistantStartIntent(locationEnabled: locationEnabled, userInitiated: true)) }
        catch { lastError = Self.message(for: error) }
    }

    private func ambientFix(_ fix: AssistantLocationObservation?, moved: Bool, lost: AssistantLocationUnavailableReason?, consent: UInt64) {
        Task { [weak self] in
            guard let self else { return }
            guard coordinator.acceptsLocation(consent), locationEnabled else { return }
            guard var fix else {
                locationLossAt = Date(); latestLocation = nil; latestLocationConsent = nil
                locationQuality = .unavailable
                await reportLocation(nil, unavailable: lost, consent: consent)
                return
            }
            if moved {
                // Reverse geocoding at most once a minute (the platform throttles it); a fix without a place is still a fix.
                if Date().timeIntervalSince(lastAmbientGeocode) > 60 { lastAmbientGeocode = Date(); fix.place = await Self.place(of: fix) }
                guard coordinator.acceptsLocation(consent), locationEnabled,
                      locationLossAt.map({ fix.observedAt > $0 }) ?? true,
                      latestLocation.map({ fix.observedAt >= $0.observedAt }) ?? true else { return }
                locationLossAt = nil
                latestLocation = fix
                latestLocationConsent = consent
                locationQuality = fix.quality
            } else if let known = latestLocation, known.latitude == fix.latitude, known.longitude == fix.longitude {
                fix.place = known.place
            }
            guard locationLossAt.map({ fix.observedAt > $0 }) ?? true else { return }
            await reportLocation(fix, consent: consent)
        }
    }

    /// Every fix the phone takes goes to central's per-device location authority.
    private func reportLocation(_ fix: AssistantLocationObservation?, unavailable: AssistantLocationUnavailableReason? = nil,
                                consent: UInt64) async {
        guard locationEnabled else { return }
        try? await coordinator.reportLocation(fix, unavailable: unavailable, consent: consent)
    }

    /// A call never waits on GPS: a fix under 10 minutes old rides on call_open; otherwise one is taken meanwhile and goes
    /// to central on its own (the call's turns are located by the phone's latest fix there).
    private func callLocation() -> AssistantLocationObservation? {
        if let fix = cachedLocation() { return fix }
        if locationEnabled { Task { await captureLocation() } }
        return nil
    }

    private func cachedLocation() -> AssistantLocationObservation? {
        guard locationEnabled else { return nil }
        if let fix = latestLocation, fix.quality != .unavailable, Date().timeIntervalSince(fix.observedAt) < 600 { return fix }
        return nil
    }

    /// Where the user is for this turn: a fix under 10 minutes old is sent at once (refreshed in the background after
    /// 2 minutes, so typing never waits on GPS); only a missing or older fix is taken before sending.
    private func currentLocation() async -> (fix: AssistantLocationObservation?, consent: UInt64) {
        let choice = coordinator.locationChoice()
        guard locationEnabled, choice.enabled else { return (nil, choice.version) }
        if let fix = latestLocation, latestLocationConsent == choice.version, fix.quality != .unavailable {
            let age = Date().timeIntervalSince(fix.observedAt)
            if age < 600 {
                if age > 120 { Task { await captureLocation() } }
                return (fix, choice.version)
            }
        }
        await captureLocation(consent: choice.version)
        return (coordinator.acceptsLocation(choice.version) && locationEnabled ? latestLocation : nil, choice.version)
    }

    private static func place(of fix: AssistantLocationObservation) async -> String? {
        let geocoder = CLGeocoder()
        let timeout = Task { try? await Task.sleep(nanoseconds: 2_000_000_000); geocoder.cancelGeocode() }
        defer { timeout.cancel() }
        guard let mark = try? await geocoder.reverseGeocodeLocation(
            CLLocation(latitude: fix.latitude, longitude: fix.longitude), preferredLocale: Locale(identifier: "zh_CN")).first
        else { return nil }
        var place = ""
        for part in [mark.locality, mark.subLocality, mark.name ?? mark.thoroughfare].compactMap({ $0 })
        where !part.isEmpty && !place.contains(part) { place += part }
        return place.isEmpty ? nil : place
    }

    private func captureLocation(consent expected: UInt64? = nil) async {
        let choice = coordinator.locationChoice()
        let consent = expected ?? choice.version
        guard coordinator.acceptsLocation(consent), locationEnabled else { return }
        do {
            var observation = try await locationService.requestOneShot(
                userInitiated: true
            )
            observation.place = await Self.place(of: observation)
            guard coordinator.acceptsLocation(consent), locationEnabled,
                  locationLossAt.map({ observation.observedAt > $0 }) ?? true,
                  latestLocation.map({ observation.observedAt >= $0.observedAt }) ?? true else { return }
            locationLossAt = nil
            latestLocation = observation
            latestLocationConsent = consent
            locationQuality = observation.quality
            if observation.quality != .unavailable { await reportLocation(observation, consent: consent) }
            if observation.quality == .unavailable {
                lastError = "Location is degraded."
            }
        } catch {
            guard coordinator.acceptsLocation(consent), locationEnabled else { return }
            locationLossAt = Date(); latestLocation = nil; latestLocationConsent = nil
            locationQuality = .degraded
            await reportLocation(nil, unavailable: AssistantLocationUnavailableReason(error), consent: consent)
            lastError = "Location is degraded: " + Self.message(for: error)
        }
    }

    /// One path for every media change: the coordinator holds it for the call. A release is applied in any state
    /// (a mute during a reconnect is not dropped); the projection follows the coordinator's snapshot.
    private func setMedia(source: AssistantMediaSource, enabled: Bool) async -> Bool {
        defer { Task { [weak self] in await self?.refreshPermissions() } }
        guard enabled else {
            return await coordinator.releaseMedia(source, for: .call)
        }
        do {
            try await coordinator.acquireMedia(source, for: .call)
            return true
        } catch AssistantSessionCoordinatorError.superseded {
            return false
        } catch {
            lastError = Self.message(for: error)
            return false
        }
    }

    func setWakeEnabled(_ enabled: Bool) async {
        wakeEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: Self.wakeChoiceKey)
        do { try await coordinator.setWakeEnabled(enabled) }
        catch { lastError = "本地唤醒未启动：" + Self.message(for: error) }
    }

    /// Turns 随身模式 on or off for this and every later session. A refused microphone turns it back off and says so.
    func setAmbientEnabled(_ enabled: Bool) async {
        ambientEnabled = enabled
        UserDefaults.standard.set(enabled, forKey: Self.ambientChoiceKey)
        // Replies to what she hears while the app is in the background arrive as notifications.
        do {
            try await coordinator.setAmbient(enabled, startIntent: enabled
                ? AssistantStartIntent(locationEnabled: locationEnabled, userInitiated: true) : nil)
            if enabled && ambientEnabled {
                await requestReminderAuthorization()
            }
        }
        catch MediaPermissionError.microphoneDenied {
            ambientEnabled = false
            UserDefaults.standard.set(false, forKey: Self.ambientChoiceKey)
            try? await coordinator.setAmbient(false)
            lastError = "麦克风权限没打开，随身模式用不了。可以在系统设置里打开。"
        } catch AssistantSessionCoordinatorError.superseded {
            return
        } catch {
            lastError = Self.message(for: error)
        }
    }

    // MARK: 录入我的声音 / 确认是我

    @discardableResult
    func controlVoiceEnrollment(_ action: String) async -> Bool {
        guard !voiceEnrollmentBusy else { return false }
        voiceEnrollmentBusy = true; voiceEnrollmentError = nil
        defer { voiceEnrollmentBusy = false }
        do { try await coordinator.voiceEnrollmentControl(action == "read" ? "status" : action); return true }
        catch { voiceEnrollmentError = Self.voiceprintMessage(error); return false }
    }

    /// Reads the owner's voiceprint status (the 她了解你 page asks when it appears).
    func refreshVoiceprint() async {
        do { try await coordinator.voiceprintControl("voiceprint_read") }
        catch { voiceprintError = Self.voiceprintMessage(error) }
    }

    @Published private(set) var voiceprintError: String?
    private var voiceprintPressCounter: UInt64 = 0
    func nextVoiceprintPress() -> UInt64 { voiceprintPressCounter &+= 1; return voiceprintPressCounter }

    /// Opens the window for one sentence; false when it could not (not connected, refused, already released).
    func beginVoiceprintSample(_ press: UInt64) async -> Bool {
        voiceprintError = nil
        do { try await coordinator.pressVoiceprintSample(press); return true }
        catch AssistantSessionCoordinatorError.superseded { return false }
        catch { voiceprintError = Self.voiceprintMessage(error); return false }
    }

    /// Ends the sentence: central's measurement of it, or nil when cancelled or failed (the error says why).
    func endVoiceprintSample(_ press: UInt64, cancel: Bool) async -> CentralVoiceprintSample? {
        do { return try await coordinator.releaseVoiceprintSample(press, cancel: cancel) }
        catch { voiceprintError = Self.voiceprintMessage(error); return nil }
    }

    /// Commits the measured sentences; the result names any that did not sound like the rest.
    func enrollVoiceprint(_ sampleIDs: [String]) async -> CentralVoiceprint.Enrollment? {
        voiceprintError = nil
        do { return try await coordinator.voiceprintControl("voiceprint_enroll", sampleIDs: sampleIDs).enrollment }
        catch { voiceprintError = Self.voiceprintMessage(error); return nil }
    }

    /// "忘记我的声音".
    func forgetVoiceprint() async -> Bool {
        voiceprintError = nil
        do { try await coordinator.voiceprintControl("voiceprint_forget"); return true }
        catch { voiceprintError = Self.voiceprintMessage(error); return false }
    }

    func trustVoiceWindow(sourceDeviceID: String) async -> Bool {
        voiceprintError = nil
        do { try await coordinator.trustVoiceWindow(sourceDeviceID: sourceDeviceID); return true }
        catch { voiceprintError = Self.voiceprintMessage(error); return false }
    }

    /// "确认是我" for one prompt; false (with a reason) when central refused it or it already expired.
    func confirmVoice(_ id: String, choice: CentralVoiceConfirmationChoice? = nil) async -> Bool {
        guard !authenticatingVoice.contains(id) else { return false }
        authenticatingVoice.insert(id)
        defer { authenticatingVoice.remove(id) }
        lastError = nil
        do { try await coordinator.confirmVoice(id, choice: choice); return true }
        catch { lastError = Self.voiceprintMessage(error); return false }
    }

    func careSafe(identity: String) async -> Bool {
        do {
            _ = try await coordinator.careSafe(identity: identity)
            apply(await coordinator.presentationSnapshot())
            return true
        } catch {
            apply(await coordinator.presentationSnapshot())
            lastError = Self.voiceprintMessage(error)
            return false
        }
    }

    private static func voiceprintMessage(_ error: Error) -> String {
        guard let failure = error as? CentralVoiceprintFailure else {
            if case AssistantSessionCoordinatorError.notActive = error { return "这次操作没完成，请再试一次" }
            if case CentralTextError.unavailable = error { return "现在还不能操作，稍等一下再试" }
            return message(for: error)
        }
        switch failure.code {
        case "VOICE_CONFIRMATION_FACE_ID_UNAVAILABLE": return "Face ID 不可用，这句话还未确认。请先在系统设置中启用 Face ID"
        case "VOICE_CONFIRMATION_FACE_ID_FAILED": return "Face ID 未通过，这句话还未确认"
        case "VOICE_CONFIRMATION_APP_UPDATE_REQUIRED": return "需要 Face ID 或 Touch ID 确认，请更新客户端后重试"
        case "VOICE_CONFIRMATION_BIOMETRIC_INVALID": return "这次身份验证不适用于当前设备，请更新客户端后重试"
        case "FORMAL_VOICE_CONFIRM_INPUT_INVALID": return "服务器尚不支持生物识别确认，请更新服务器后重试"
        case "VOICE_CONFIRMATION_TIMEOUT": return "确认结果还未收到，请先查看对话中的处理结果"
        case "VOICE_CONFIRMATION_EXPIRED": return "这句已经过了确认时间"
        case "VOICE_CONFIRMATION_NOT_FOUND", "VOICE_CONFIRMATION_ALREADY_DECIDED": return "这句已经处理过了"
        case "VOICEPRINT_SAMPLE_NOT_FOUND": return "录音已过期，请重新录这几句"
        case "VOICEPRINT_ENROLLMENT_TOO_FEW_SAMPLES": return "至少要 5 句读得清楚的录音"
        case "VOICEPRINT_NOT_CONFIGURED", "VOICEPRINT_ENROLLMENT_NOT_CONFIGURED": return "服务器上的声纹服务还没开启"
        case "FORMAL_PCM_VOICE_WINDOW_EMPTY": return "没录到声音，按住时再读一遍"
        case "FORMAL_PCM_VOICE_SOURCE_REQUIRED": return "麦克风还没准备好，再按一次试试"
        case let code where code.hasSuffix("_TIMEOUT"): return "网络有点慢，没等到回应，再试一次"
        case let code where code.hasPrefix("SPEECH_"): return "服务器上的语音模型暂时不可用"
        default: return "没成功，请再试一次"
        }
    }

    @Published private(set) var contactsEnabled = false
    @Published private(set) var contactsStatus = "尚未开启联系人同步"
    @Published private(set) var contactsChanging = false
    func refreshContactsStatus() async {
        let value = await coordinator.contactsSnapshot()
        contactsEnabled = value.enabled; contactsStatus = value.status
    }
    func setContactsEnabled(_ enabled: Bool) async {
        guard !contactsChanging else { return }
        contactsChanging = true; defer { contactsChanging = false }
        do { try await coordinator.setContactsEnabled(enabled) }
        catch { contactsStatus = "未能开启通讯录读取。请检查系统授权或 Mac 配对。"; return }
        await refreshContactsStatus()
    }
    func syncContactsNow() async { await coordinator.syncContactsNow(); await refreshContactsStatus() }

    @Published private(set) var healthEnabled = false
    @Published private(set) var healthStatus = "尚未开启健康同步"
    func refreshHealthStatus() async {
        let value = await coordinator.healthSnapshot()
        healthEnabled = value.enabled; healthStatus = value.status
    }
    func setHealthEnabled(_ enabled: Bool) async {
        do { try await coordinator.setHealthEnabled(enabled) }
        catch { healthStatus = "未能开启健康读取。请检查健康 App 的授权或 Mac 配对。"; return }
        await refreshHealthStatus()
    }
    func syncHealthNow() async {
        await coordinator.syncHealthNow()
        await refreshHealthStatus()
    }

    func appDidEnterBackground() async {
        await coordinator.setNavigationStandby(ambientLocation.navigationStandby)
        await coordinator.handleLifecycleSignal(.appDidEnterBackground)
        await mediaLifecycle.handle(.appDidEnterBackground)
    }

    func appBecameActive() async {
        await requestGlassesStandbyAuthorization()
        await coordinator.setAppActive(true)
        await mediaLifecycle.handle(.appBecameActive)
        await refreshHealthStatus()
        await refreshContactsStatus()
    }

    @Published var openPaymentRequested = false

    private func configureObservers() async {
        payment.connect(coordinator)
        modelSettings.signer = { [weak self] bytes, deviceID in
            guard let self else { throw ModelSettingsError.changed }
            return try await self.payment.signModelSettings(bytes, deviceID: deviceID)
        }
        modelSettings.connect(coordinator)
        ownerOverride.connect(coordinator)
        await coordinator.setCentralTextObserver { [weak self] consumer in
            Task { @MainActor in self?.consumeCentralState(consumer) }
        }
        await coordinator.setResultObserver { [weak self] envelope in
            Task { @MainActor in
                self?.consumeResult(envelope)
            }
        }
        await mediaLifecycle.setStopHandler { [weak self] reason in
            guard let self else {
                return
            }
            _ = await self.coordinator.stop(reasonCode: reason)
        }
        let coordinator = coordinator
        await mediaLifecycle.setRetainer { reason in await coordinator.retainsSession(for: reason) }
        lifecycleObserver = AssistantMediaLifecycleObserver(lifecycle: mediaLifecycle) { signal in
            await coordinator.handleLifecycleSignal(signal)
        }
        networkTask = Task { [weak self] in
            guard let self else {
                return
            }
            for await path in networkMonitor.updates() {
                await self.handleNetworkPath(path)
            }
        }
    }

    private func handleNetworkPath(
        _ path: AssistantNetworkPathState
    ) async {
        networkState = path
        await coordinator.handleNetworkPath(path)
    }

    private func isActivePromptSession(_ fence: UInt64) -> Bool {
        guard activeSessionFence == fence,
              case .active(let encryptionActive) = sessionState
        else {
            return false
        }
        return encryptionActive
    }

    private func canProjectCentralSnapshot(_ consumer: AssistantCentralTextConsumer) -> Bool {
        consumer.generation > latestCentralGeneration ||
            (consumer.generation == latestCentralGeneration && consumer.revision >= latestCentralRevision)
    }

#if DEBUG
    /// The existing UI-test launch argument gates synthetic formal packets; no network or pairing is used.
    func receiveActivityFixture(_ bytes: Data) throws -> CentralActivityUpdate {
        let packet = try AssistantCentralTextWire.decode(bytes)
        let update = try JSONDecoder().decode(CentralActivityUpdate.self, from: bytes)
        var consumer = centralSnapshot ?? AssistantCentralTextConsumer()
        if consumer.binding?.sessionID != update.session_id {
            try consumer.reset(binding: CentralTransportBinding(sessionID: update.session_id, deviceID: "fixture-device",
                connectionEpoch: "fixture-epoch", expectedGatewayIdentity: "fixture-gateway", maxPacketBytes: 12288))
        }
        try consumer.accept(packet)
        centralSnapshot = consumer
        activities = consumer.activities.cards
        return update
    }
#endif

    private func consumeCentralState(_ consumer: AssistantCentralTextConsumer) {
#if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-testing"), ProcessInfo.processInfo.environment["YIMI_ACTIVITY_FIXTURES"] != nil { return }
#endif
        guard canProjectCentralSnapshot(consumer) else { return }
        latestCentralGeneration = consumer.generation
        latestCentralRevision = consumer.revision
        guard textOwner == .centralCandidate else { return }
        centralSnapshot = consumer
        ownerProjectionIdentity = ownerSessionIdentity.matches(consumer.ownerPairingIdentity) ? consumer.ownerPairingIdentity : nil
        clearCallPortraitForOwner(ownerProjectionIdentity)
        centralStatus = consumer.status
        voiceTurn = consumer.voiceTurn
        if consumer.call.isActive, consumer.call.id != portraitCallID {
            if pendingPortraitStart == nil { callPortrait = captureCallPortrait() }
            pendingPortraitStart = nil; portraitCallID = consumer.call.id
        }
        call = consumer.call

        if errands != consumer.errands { errands = consumer.errands }
        activities = consumer.activities.cards
        projectOwnerVoice(consumer.ownerVoice, identity: consumer.ownerPairingIdentity)
        do {
            typedRecoveryEventID = consumer.eventID
            let admission = try consumer.accepted?.fields.value("admission", as: CentralBody.self)?.value("state", as: String.self)
            typedRecoveryNeedsDecision = consumer.submission != nil && admission == "reconcile_required"
            typedRecoveryStatus = try consumer.needsTypedRecovery ? "正在补齐这句话的结果…" : nil
            centralCanSubmit = try consumer.canBeginSubmit
            centralRetainedVoiceResultIDs = try consumer.retainedVoiceResultIDs
            centralCanRequest = consumer.accepted != nil
            centralCanCancelRun = try consumer.canCancelRun
            centralCanCancelPlayback = try consumer.header?.fields.value("reply_phase", as: String.self) == "sealed" && (consumer.header?.fields.value("reply_epoch", as: Int.self) ?? 0) > 0
            centralCanRetryVoiceGeneration = try consumer.canRetryVoiceGeneration
            centralCanRequestSealed = try consumer.canRequestSealedResult
            centralCanRetrySubmission = consumer.canRetryTypedSubmission
            centralCanRetryACK = !consumer.pendingRenderedACKs.isEmpty
            if !centralCanRetryACK && (lastError == "显示回执仍未确认；保留原回执等待重发。" ||
                lastError == "界面已消费文字，显示回执尚未确认。") { lastError = nil }
            centralMemoryProposals = consumer.memoryProposals
            centralMemoryStatus = consumer.memoryStatus
            if !centralMemoryRetryControls.isEmpty && consumer.pendingMemoryControls.isEmpty,
               lastError == "待批请求仍未确认；重试会发送原控制包，不创建新决定。" { lastError = nil }
            centralMemoryRetryControls = consumer.pendingMemoryControls
            centralMemoryDecisionIDs = Set(try consumer.memoryProposals.filter(consumer.canDecideMemory).map(\.id))
            centralPresentation = consumer.presentation
            resultText = QwenHandoff.split(consumer.presentation?.text ?? "").display
            if let presentation = consumer.presentation, presentation.isFinal { handOffToQwenIfNeeded(presentation, identity: consumer.ownerPairingIdentity) }
            resultIsFinal = consumer.presentation?.isFinal ?? false
            if consumer.accepted != nil { pendingPromptIDs.removeAll(keepingCapacity: true) }
            if consumer.presentation?.isFinal == true { promptState = .final }
        } catch {
            centralCanSubmit = false; centralCanRequest = false; centralCanCancelPlayback = false
            centralCanRequestSealed = false; centralCanRetryVoiceGeneration = false
            centralRetainedVoiceResultIDs = []
            centralMemoryDecisionIDs = []; lastError = Self.message(for: error)
        }
        do { try qwenDatabase().acknowledgeQwenReply(consumer) }
        catch { lastError = Self.message(for: error) }
        if canAcceptPrompt { Task { await self.sendPendingQwenReply() } }
    }

    /// Owner-voice state from the consumer; while the app is not on screen a new prompt or a 随身模式 reply also becomes a
    /// notification (the session keeps running in the background only in 随身模式).
    private func syncReminders(_ reminders: [AssistantReminder]) {
        guard reminders != appliedReminderSnapshot, reminderSyncTask == nil else { return }
        reminderSyncTask = Task { [weak self] in
            guard let self else { return }
            defer { reminderSyncTask = nil }
            while let desired = reminderSnapshot, desired != appliedReminderSnapshot {
                guard let identity = reminderPairingIdentity, ownerSessionIdentity.matches(identity) else { break }
                let retryGeneration = reminderRetryGeneration
                do {
                    try await notificationCenter.syncReminders(desired)
                    if identity != reminderPairingIdentity || retryGeneration != reminderRetryGeneration { continue }
                    guard ownerSessionIdentity.matches(identity) else { break }
                    appliedReminderSnapshot = desired
                    if let reminderSyncError, lastError == reminderSyncError { lastError = nil }
                    reminderSyncError = nil
                } catch {
                    if identity != reminderPairingIdentity { continue }
                    reminderSyncError = error.localizedDescription
                    lastError = reminderSyncError
                    if desired == reminderSnapshot && retryGeneration == reminderRetryGeneration { break }
                }
            }
        }
    }

    private func projectOwnerVoice(_ owner: CentralOwnerVoice, identity: String?) {
        let currentOwner = ownerSessionIdentity.matches(identity)
        let newQuestion = currentOwner ? owner.questionCard : nil
        let questionChanged = questionCard?.id != newQuestion?.id
        ownerProjectionIdentity = currentOwner ? identity : nil
        clearCallPortraitForOwner(ownerProjectionIdentity)
        questionCard = newQuestion
        // nil is a transient reset, not an authoritative cancellation of the owner's reminders.
        if let reminders = owner.reminders, let identity, currentOwner {
            if identity != reminderPairingIdentity {
                reminderPairingIdentity = identity
                appliedReminderSnapshot = nil
                reminderRetryGeneration += 1
            }
            reminderSnapshot = reminders
            syncReminders(reminders)
        }
        if voiceprint != owner.voiceprint { voiceprint = owner.voiceprint }
        if voiceEnrollment != owner.enrollment { voiceEnrollment = owner.enrollment }
        let background = UIApplication.shared.applicationState != .active
        let newPrompts = owner.confirmations.filter { item in !voiceConfirmations.contains { $0.id == item.id } }
        let care = currentOwner ? owner.careCheckins : []
        let newCare = care.filter { item in !careCheckins.contains { $0.id == item.id } }
        careCheckins = care
        careCheckinIdentity = currentOwner ? identity : nil
        let newReplies = owner.ambientReplies.filter { item in !ambientReplies.contains { $0.id == item.id } }
        if voiceConfirmations != owner.confirmations { voiceConfirmations = owner.confirmations }
        let confirming = Set(owner.confirming.keys)
        if confirmingVoice != confirming { confirmingVoice = confirming }
        if ambientReplies != owner.ambientReplies { ambientReplies = owner.ambientReplies }
        guard background else { return }
        let notifications = notificationCenter
        if questionChanged, let card = newQuestion, card.deadline > Date() {
            Task { _ = await notifications.deliver(.question(card)) }
        }
        for prompt in newPrompts {
            Task { _ = await notifications.deliver(AssistantNotificationMessage(identifier: "confirm-" + prompt.id, title: "依米",
                body: prompt.isNativeApproval ? (prompt.text ?? "") : (prompt.text.map { "「\($0)」" } ?? "刚才这句") + "不太确定是你说的，打开依米确认")) }
        }
        for item in newCare {
            guard let identity else { continue }
            Task { _ = await notifications.deliver(AssistantNotificationMessage(identifier: "care-" + item.id,
                title: "依米", body: item.text, careIdentity: identity, deepLink: .care(item.id))) }
        }
        for reply in newReplies {
            Task {
                if let id = reply.reminderID, await notifications.hasReminder(id) { return }
                _ = await notifications.deliver(.assistantReply(identifier: "ambient-" + reply.id, text: reply.text,
                    privacy: reply.privacy, locked: payment.appLock.covered || payment.appLock.obscured,
                    active: UIApplication.shared.applicationState == .active))
            }
        }
    }

    private func consumeResult(_ envelope: AssistantResultEnvelope) {
        Task { [weak self] in
            guard let self else {
                return
            }
            await self.consumeResultOnReducer(envelope)
        }
    }

    private func consumeResultOnReducer(
        _ envelope: AssistantResultEnvelope,
        notifyFinal: Bool = true
    ) async {
        let decision = await resultStreaming.accept(envelope)
        guard decision == .acceptedPartial
                || decision == .acceptedFinal
        else {
            return
        }
        let snapshot = await resultStreaming.snapshot()
        if let errorCode = envelope.errorCode {
            pendingPromptIDs.remove(envelope.streamID)
            if envelope.streamID == promptID,
               isActivePromptSessionForResult()
            {
                promptState = .ready
            }
            lastError = Self.message(forResultErrorCode: errorCode)
            return
        }

        resultText = snapshot.text
        resultIsFinal = snapshot.isFinal
        if envelope.streamID == promptID,
           isActivePromptSessionForResult()
        {
            promptState = envelope.isFinal ? .final : .partial
        }
        if envelope.isFinal {
            pendingPromptIDs.remove(envelope.streamID)
        }
        if notifyFinal && decision == .acceptedFinal {
            _ = await notificationCenter.deliver(
                AssistantNotificationMessage.assistantReply(
                    identifier: envelope.sessionID
                        + "-"
                        + String(envelope.epoch)
                        + "-"
                        + envelope.streamID
                        + "-"
                        + String(envelope.sequence),
                    title: "Assistant result",
                    text: snapshot.text, privacy: snapshot.privacy,
                    locked: payment.appLock.covered || payment.appLock.obscured,
                    active: UIApplication.shared.applicationState == .active
                )
            )
        }
    }

    private func apply(_ snapshot: AssistantSessionSnapshot) {
        if let current = sessionSnapshot, snapshot.revision <= current.revision { return }
        let previous = sessionSnapshot
        sessionSnapshot = snapshot
        voiceStatus = snapshot.voiceStatus
        updateCallActivity(snapshot)
        careAnswering = snapshot.careSafePending
        careOutcome = snapshot.careSafeStatus
        componentVideoFailure = snapshot.componentVideoFailure
        callFailure = snapshot.callFailure.map { Self.message(forCode: $0, fallbackMessage: $0) }
        isDialing = snapshot.isDialing
        videoCallRequested = snapshot.videoCallRequested
        let state = snapshot.state
        if let generation = snapshot.sessionGeneration, generation != projectedSessionGeneration {
            projectedSessionGeneration = generation
            beginSessionProjection()
        }
        if textOwner != snapshot.textOwner { textOwner = snapshot.textOwner } // named by the gateway at bootstrap
        wakeEnabled = snapshot.media.wakeArmed
        UserDefaults.standard.set(wakeEnabled, forKey: Self.wakeChoiceKey)
        wakeStatus = snapshot.media.wake.displayName
        cameraRequestCamera = snapshot.cameraRequestCamera
        cameraRequestVisible = snapshot.cameraRequestVisible
        cameraPhase = snapshot.media.camera
        microphonePhase = snapshot.media.microphone
        cameraEnabled = cameraPhase == .opening || cameraPhase == .on
        microphoneEnabled = microphonePhase == .opening || microphonePhase == .on
        if ambientPhase != snapshot.media.ambient { ambientPhase = snapshot.media.ambient; syncAmbientLocation() }
        switch state {
        case .active(true):
            gatewayReconnect?.cancel(); gatewayReconnect = nil; gatewayReconnectAttempt = 0
            if promptState == .inactive { promptState = .ready }
            if previous?.state != state {
                let lifecycle = mediaLifecycle
                Task {
                    await lifecycle.markRunning()
                    self.consumeCentralState(await self.coordinator.centralTextSnapshot())
                }
            }
        case .stopped, .failed:
            projectedSessionGeneration = nil
            pendingPromptIDs.removeAll(keepingCapacity: true)
            promptState = .inactive
            videoPreviewModel.update(.cleared)
        default:
            break
        }
        if case .failed(let code) = state {
            if state.needsFreshConnection { reconnectAfterConnectionLoss() }
            else {
                gatewayReconnect?.cancel(); gatewayReconnect = nil
                YimiAvatarStore.shared.bind(nil)
            }
            lastError = Self.message(forCode: code)
        } else if snapshot.pendingStopRecoveryFailed {
            lastError = Self.message(forCode: "pending_stop_storage_unavailable")
        } else if case .stopped(let confirmed) = state {
            lastError = confirmed ? nil : snapshot.hasPendingStop
                ? "远端 Stop 仍未确认；保留原操作等待对账。"
                : "本地媒体已关闭；远端 Stop 尚未确认。"
        } else if case .idle = state,
                  previous?.pendingStopRecoveryFailed == true,
                  !snapshot.isRestoringPendingStop {
            lastError = nil
        }
    }

    private func updateCallActivity(_ snapshot: AssistantSessionSnapshot, refreshExistingOnly: Bool = false) {
        let id = snapshot.voiceActivityCallID != activityEndedCallID ? snapshot.voiceActivityCallID : nil
        let status = snapshot.voiceStatus
        callActivity.update(callID: id, title: status.title, compactTitle: status.compactTitle,
                            detail: status.detail, symbol: status.symbol, refreshExistingOnly: refreshExistingOnly)
        if id == nil {
            activityRefresh?.cancel(); activityRefresh = nil
        } else if activityRefresh == nil {
            activityRefresh = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(30)) } catch { return }
                    guard let coordinator = self?.coordinator else { return }
                    let current = await coordinator.presentationSnapshot()
                    guard let self, !Task.isCancelled else { return }
                    if current.revision >= (self.sessionSnapshot?.revision ?? 0) {
                        self.updateCallActivity(current, refreshExistingOnly: true)
                    }
                }
            }
        }
    }

    private static func message(for error: Error) -> String {
        if let localized = error as? LocalizedError,
           let description = localized.errorDescription {
            return description
        }
        return String(describing: error)
    }

    private static func message(forCode code: String, fallbackMessage: String? = nil) -> String {
        if let failure = ComponentVideoFailureCode(rawValue: code) { return failure.message }
        switch code {
        case "pending_stop_storage_unavailable":
            return "停止记录读取失败；请重试读取。"
        case "bootstrap_not_configured":
            return "Cloud bootstrap 尚未配置；A3 未绑定任何公网 URL。"
        case "e2ee_unavailable", "e2ee_failed":
            return "E2EE 未就绪，媒体会话已 fail-closed。"
        case "camera_denied":
            return "摄像头权限未允许。"
        case "microphone_denied":
            return "麦克风权限未允许。"
        case "location_denied":
            return "位置权限未允许。"
        case "disconnected":
            return "LiveKit 连接已断开。"
        default:
            return fallbackMessage ?? "助手会话失败（\(code)）。"
        }
    }

    private func isActivePromptSessionForResult() -> Bool {
        guard activeSessionFence != nil,
              case .active(let encryptionActive) = sessionState
        else {
            return false
        }
        return encryptionActive
    }

    private static func message(forResultErrorCode code: String) -> String {
        switch code {
        case "MODEL_UNAVAILABLE":
            return "模型当前不可用，请稍后重试。"
        case "MODEL_FAILED":
            return "模型生成失败，请重试。"
        case "BUSY":
            return "助手正忙，请稍后重试。"
        default:
            return "助手返回了未知错误。"
        }
    }
}
