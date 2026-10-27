import Foundation
import LiveKit
import VoiceWake
import Security
import HealthKit
import Contacts
import os

/// The one retry cadence for re-establishing a lost connection (credential refresh, fresh bootstrap) on every
/// client: 0.5–1 s, doubling to a 30 s cap, jittered so clients that lost one gateway never retry in lockstep.
enum AssistantReconnectBackoff {
    static func delay(attempt: Int, jitter: Double = .random(in: 0...1)) -> Duration {
        .seconds(min(30, Double(1 << min(attempt, 5))) * (0.5 + 0.5 * jitter))
    }
}

enum AssistantSessionState: Equatable, Sendable {
    case idle
    case requestingPermissions
    case bootstrapping
    case encryptionPreparing
    case connecting
    case active(encryptionActive: Bool)
    case reconnecting
    case stopping
    case stopped(remoteStopConfirmed: Bool)
    case failed(code: String)

    var displayName: String {
        switch self {
        case .idle: return "就绪"
        case .requestingPermissions: return "正在请求权限"
        case .bootstrapping: return "正在取得连接材料"
        case .encryptionPreparing: return "正在准备 E2EE"
        case .connecting: return "正在连接"
        case .active(let encryptionActive):
            return encryptionActive ? "运行中 · E2EE" : "运行中 · E2EE 校验中"
        case .reconnecting: return "正在恢复网络连接"
        case .stopping: return "正在停止"
        case .stopped(let confirmed):
            return confirmed ? "已停止" : "本地已停止 · 远端未确认"
        case .failed: return "失败"
        }
    }

    /// Terminal binding loss needs a fresh connection. Revocation alone requires pairing again.
    var needsFreshConnection: Bool {
        switch self {
        case .failed(let code): return code != "realtime_pairing_revoked"
        case .stopped: return true
        default: return false
        }
    }

    var canStart: Bool {
        switch self {
        case .idle, .stopped, .failed:
            return true
        default:
            return false
        }
    }

    var canStop: Bool {
        switch self {
        case .requestingPermissions, .bootstrapping,
             .encryptionPreparing, .connecting, .active,
             .reconnecting, .stopping:
            return true
        case .idle, .stopped, .failed:
            return false
        }
    }
}

/// Who publishes a capture source. The coordinator owns these intents for the app and Watch.
/// 随身模式 restores its standing publication choice. Local wake has a separate device-only capture intent.
enum AssistantMediaHolder: Hashable, Sendable {
    case call        // a live call, including its in-call mute / camera choices
    case voiceTurn   // one hold-to-talk window
    case ambient     // 随身模式: the microphone stays published (the iPhone as the glasses' stand-in), also in the background
    case cameraRequest
    case voiceprint  // one 录入我的声音 sentence window
}

/// 随身模式 as the UI shows it: not chosen, being opened, capturing, or chosen but paused (no running session, a muted
/// call, or the microphone was refused).
enum AssistantAmbientPhase: Equatable, Sendable { case off, starting, on, paused }

enum AssistantMediaPhase: Equatable, Sendable {
    case off      // input disabled; a call may retain a muted track; local wake has its own phase
    case opening  // an explicit intent waits on permission or publish
    case on       // published
    case closing  // intent withdrawn, disable/unpublish in flight
    case unknown  // disable/unpublish unconfirmed: retried on the next reconcile, settled by Stop
}

/// Call UI projection of the media reconciler's confirmed phase; it owns no separate mute intent.
enum AssistantCallMuteState: Equatable, Sendable {
    case muting, confirmed, failed, unmuting, unmuted

    init(_ phase: AssistantMediaPhase) {
        switch phase {
        case .closing: self = .muting
        case .opening: self = .unmuting
        case .off: self = .confirmed
        case .unknown: self = .failed
        case .on: self = .unmuted
        }
    }

    var statusText: String {
        switch self {
        case .muting: return "正在静音"
        case .failed: return "静音未确认"
        case .confirmed: return "已静音"
        case .unmuting: return "正在取消静音"
        case .unmuted: return "麦克风已开"
        }
    }

    var actionText: String {
        switch self {
        case .muting, .unmuting: return statusText
        case .failed: return "重试静音"
        case .confirmed: return "取消静音"
        case .unmuted: return "静音"
        }
    }

    /// Announce only when this projection changes. The view owns polite delivery, not mute state.
    var announcementText: String {
        switch self {
        case .muting: return "正在静音，请稍候。"
        case .failed: return "静音未确认。你仍可能被听到。重试静音，或结束通话。"
        case .confirmed: return "已静音。按钮，取消静音。"
        case .unmuting: return "正在取消静音，请稍候。"
        case .unmuted: return "麦克风已开。"
        }
    }
}

struct AssistantMediaSnapshot: Equatable, Sendable {
    var microphone: AssistantMediaPhase = .off
    var callMicrophone: AssistantMediaPhase = .off
    var callAudioPlaying = false
    var camera: AssistantMediaPhase = .off
    var ambient: AssistantAmbientPhase = .off
    var wakeArmed = false
    var wake: WakeListeningPhase = .off
    var wakeFailure: String?
    /// Set when held media was withdrawn without the user asking (app background, remote call close, session stop).
    var revokedReason: String?

    func phase(_ source: AssistantMediaSource) -> AssistantMediaPhase {
        source == .camera ? camera : microphone
    }
}

enum ComponentVideoFailureCode: String, Sendable {
    case createFailed = "VIDU_COMPONENT_CREATE_FAILED", ended = "VIDU_COMPONENT_ENDED"
    case quoteChanged = "CALL_AVATAR_QUOTE_CHANGED", requestRejected = "CALL_AVATAR_REQUEST_REJECTED"
    case disabled = "VIDEO_CALL_DISABLED"
    case rtcFailed = "VIDU_COMPONENT_RTC_FAILED", stopFailed = "VIDU_COMPONENT_STOP_FAILED"
    var message: String {
        switch self {
        case .quoteChanged: return "费用或使用范围已变化，请重新确认。数字人保持关闭。"
        case .requestRejected: return "数字人开启未被接受，通话和镜头继续。"
        case .createFailed: return "视频生成失败，语音通话继续。"
        case .disabled: return "当前服务未开启视频，语音通话继续。"
        case .ended: return "视频已停止，语音通话继续。"
        case .rtcFailed: return "视频连接失败，语音通话继续。"
        case .stopFailed: return "视频停止未完成，语音通话未挂断。"
        }
    }
}

// One projection of the coordinator's existing Stop ownership. No UI-owned retry state.
struct AssistantSessionSnapshot: Equatable, Sendable {
    let state: AssistantSessionState
    let revision: UInt64
    let isRestoringPendingStop: Bool
    let hasPendingStop: Bool
    let pendingStopRecoveryFailed: Bool
    /// The live session generation (nil when no session is running), whoever started it: the app or the Watch.
    var sessionGeneration: UInt64? = nil
    var textOwner: AssistantTextOwner = .legacy
    var media = AssistantMediaSnapshot()
    var callFailure: String? = nil
    var cameraRequestVisible = false
    var cameraRequestCamera = "back"
    var componentVideoFailure = false
    var isDialing = false
    var videoCallRequested = false
    var careSafePending = false
    var careSafeStatus: String?
    var rideMetrics: WatchYimiRideMetrics?
    var rideFeedback: CentralRideFeedback?
    var rideOwnerIdentity: String?
    var voiceStatus = AssistantVoiceStatus()
    var voiceActivityCallID: String?

    var canStart: Bool {
        state.canStart && !isRestoringPendingStop && !pendingStopRecoveryFailed
    }

    var canRetryRemoteStop: Bool {
        state.canStart && !isRestoringPendingStop && (hasPendingStop || pendingStopRecoveryFailed)
    }
}

enum AssistantSessionCoordinatorError: LocalizedError, Equatable, Sendable {
    case alreadyRunning
    case requestWasNotUserInitiated
    case notActive
    case invalidConnectionDetails
    case superseded

    var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            return "已有助手会话正在运行。"
        case .requestWasNotUserInitiated:
            return "会话只能由明确的用户操作启动。"
        case .notActive:
            return "当前没有可更新媒体的活动会话。"
        case .invalidConnectionDetails:
            return "Bootstrap 连接材料未通过本地校验。"
        case .superseded:
            return "会话启动已被停止或替代。"
        }
    }
}

/// App-local injection seam for the server-authoritative paired Watch
/// identity. Workout IDs, iPhone IDs, and locally generated UUIDs are never
/// accepted as substitutes for this binding.
struct CyclingWatchOriginBinding: Equatable, Sendable {
    let deviceID: String
    let clientInstanceID: String

    init?(
        serverAuthoritativeDeviceID: String,
        serverAuthoritativeClientInstanceID: String,
        serverAuthoritativeDeviceClass: String
    ) {
        guard serverAuthoritativeDeviceClass == "apple_watch",
              Self.isScopedID(serverAuthoritativeDeviceID),
              Self.isScopedID(serverAuthoritativeClientInstanceID)
        else {
            return nil
        }
        self.deviceID = serverAuthoritativeDeviceID
        self.clientInstanceID = serverAuthoritativeClientInstanceID
    }

    private static func isScopedID(_ value: String) -> Bool {
        if value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil { return true }
        let bytes = Array(value.utf8)
        guard (3...64).contains(bytes.count),
              let first = bytes.first,
              (97...122).contains(first)
        else {
            return false
        }
        return bytes.dropFirst().allSatisfy {
            (97...122).contains($0)
                || (48...57).contains($0)
                || $0 == 45
                || $0 == 95
        }
    }
}

enum AssistantUUIDv7Error: Error, Equatable, Sendable {
    case invalidTimestamp
    case invalidEntropy
    case secureRandomUnavailable
}

/// App-local RFC 9562 UUIDv7 source. Identity data is never an input: the
/// first 48 bits are current Unix epoch milliseconds and the remaining 74
/// payload bits come from the platform secure random source.
struct AssistantUUIDv7Generator: Sendable {
    typealias Clock = @Sendable () -> Date
    typealias RandomBytes = @Sendable (Int) throws -> [UInt8]

    private let clock: Clock
    private let randomBytes: RandomBytes

    init() {
        self.clock = { Date() }
        self.randomBytes = { count in
            try Self.secureRandomBytes(count: count)
        }
    }

    init(
        clock: @escaping Clock,
        randomBytes: @escaping RandomBytes
    ) {
        self.clock = clock
        self.randomBytes = randomBytes
    }

    func generate() throws -> String {
        let millisecondsValue = floor(
            clock().timeIntervalSince1970 * 1_000
        )
        guard millisecondsValue.isFinite,
              millisecondsValue >= 0,
              millisecondsValue <= Double(0xFFFF_FFFF_FFFF)
        else {
            throw AssistantUUIDv7Error.invalidTimestamp
        }
        let milliseconds = UInt64(millisecondsValue)
        let entropy = try randomBytes(10)
        guard entropy.count == 10 else {
            throw AssistantUUIDv7Error.invalidEntropy
        }

        var bytes = [UInt8](repeating: 0, count: 16)
        bytes[0] = UInt8(truncatingIfNeeded: milliseconds >> 40)
        bytes[1] = UInt8(truncatingIfNeeded: milliseconds >> 32)
        bytes[2] = UInt8(truncatingIfNeeded: milliseconds >> 24)
        bytes[3] = UInt8(truncatingIfNeeded: milliseconds >> 16)
        bytes[4] = UInt8(truncatingIfNeeded: milliseconds >> 8)
        bytes[5] = UInt8(truncatingIfNeeded: milliseconds)
        bytes[6] = 0x70 | (entropy[0] & 0x0F)
        bytes[7] = entropy[1]
        bytes[8] = 0x80 | (entropy[2] & 0x3F)
        for index in 9..<16 {
            bytes[index] = entropy[index - 6]
        }

        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        )).uuidString.lowercased()
    }

    private static func secureRandomBytes(
        count: Int
    ) throws -> [UInt8] {
        guard count > 0 else {
            throw AssistantUUIDv7Error.invalidEntropy
        }
        var bytes = [UInt8](repeating: 0, count: count)
        let status = bytes.withUnsafeMutableBytes { buffer -> OSStatus in
            guard let baseAddress = buffer.baseAddress else {
                return errSecParam
            }
            return SecRandomCopyBytes(
                kSecRandomDefault,
                count,
                baseAddress
            )
        }
        guard status == errSecSuccess else {
            throw AssistantUUIDv7Error.secureRandomUnavailable
        }
        return bytes
    }
}

private struct AssistantRealtimeDataSequenceProgress: Sendable {
    let streamID: String
    private(set) var lastNumber: UInt64 = 0
    private(set) var previousEventID: String?

    var next: AssistantRealtimeDataSequence {
        AssistantRealtimeDataSequence(
            streamID: streamID,
            number: lastNumber + 1,
            previousEventID: previousEventID
        )
    }

    mutating func commit(eventID: String) {
        lastNumber += 1
        previousEventID = eventID
    }

    mutating func reset() {
        lastNumber = 0
        previousEventID = nil
    }
}

enum AssistantWatchControlDeliveryStatus: Equatable, Sendable {
    case accepted
    case duplicate
    case rejected
    case unreachable
}

protocol AssistantWatchControlSending: AnyObject, Sendable {
    func sendCyclingControl(
        _ command: AssistantCyclingControlCommand
    ) async -> AssistantWatchControlDeliveryStatus
}

/// Actor-owned admission state for the one active realtime generation.
/// Commands are committed before the Watch send so callback failure can never
/// become an implicit retry or a second workout invocation.
private struct AssistantCyclingControlSequenceLedger: Sendable {
    private struct Entry: Sendable {
        let action: AssistantCyclingControlAction
        let sequence: UInt64
    }

    private var lastSequence: UInt64 = 0
    private var entries: [String: Entry] = [:]

    mutating func accept(
        _ command: AssistantCyclingControlCommand
    ) -> Bool {
        guard command.sequence > lastSequence,
              !command.requestID.isEmpty,
              entries[command.requestID] == nil
        else {
            return false
        }
        entries[command.requestID] = Entry(
            action: command.action,
            sequence: command.sequence
        )
        lastSequence = command.sequence
        return true
    }

    mutating func reset() {
        lastSequence = 0
        entries.removeAll(keepingCapacity: true)
    }
}

// One FIFO preserves callback order. Only replayable text consumes the bounded text budget;
// lifecycle, call controls and acknowledgements must remain deliverable when text overflows.
final class AssistantRealtimeEventIngress: @unchecked Sendable {
    static let maximumQueuedEvents = 260
    let stream: AsyncStream<AssistantRealtimeEvent>
    private let continuation: AsyncStream<AssistantRealtimeEvent>.Continuation
    private let lock = NSLock()
    private let capacity: Int
    private var queuedText = 0
    private var overflow = false
    private var closed = false
    init(capacity: Int = maximumQueuedEvents) {
        precondition((1...Self.maximumQueuedEvents).contains(capacity))
        self.capacity = capacity
        let pair = AsyncStream.makeStream(of: AssistantRealtimeEvent.self, bufferingPolicy: .unbounded)
        stream = pair.stream
        continuation = pair.continuation
    }
    private func isReplayableText(_ event: AssistantRealtimeEvent) -> Bool {
        switch event {
        case .result: return true
        case .centralText(let packet):
            let operation = try? packet.fields.value("operation", as: String.self)
            return operation == "text_chunk" || operation == "result_header"
        default: return false
        }
    }
    @discardableResult
    func yield(_ event: AssistantRealtimeEvent) -> Bool {
        lock.withLock {
            guard !closed else { return false }
            let text = isReplayableText(event)
            if text && queuedText == capacity { overflow = true; return false }
            if text { queuedText += 1 }
            // Admission, yield and finish share this lock, so controls cannot overtake admitted text.
            if case .terminated = continuation.yield(event) {
                if text { queuedText -= 1 }
                return false
            }
            return true
        }
    }
    func didDequeue(_ event: AssistantRealtimeEvent) {
        if isReplayableText(event) { lock.withLock { queuedText -= 1 } }
    }
    func takeOverflow() -> Bool { lock.withLock { let value = overflow; overflow = false; return value } }
    func close() {
        lock.withLock { closed = true; continuation.finish() }
    }
}

actor AssistantSessionCoordinator {
    typealias StateObserver =
        @Sendable (AssistantSessionSnapshot) -> Void
    typealias ResultObserver =
        @Sendable (AssistantResultEnvelope) -> Void

    private enum StopFinalization: Sendable {
        case stopped
        case failed(code: String, receiptStatus: String)
    }

    private let bootstrapProvider: any AssistantBootstrapProviding
    private let realtime: any AssistantRealtimeTransporting
    private let mediaPermissions: any MediaPermissionProviding
    private let locationService: any AssistantLocationProviding
    private let receipts: any AppleReceiptRecording
    private let moveSensors: MoveSessionSensors?
    private let watchControl: (any AssistantWatchControlSending)?
    private let realtimeEventCapacity: Int
    private let localDatabase: AssistantLocalOperationDatabase?
    private let careIdentity: @Sendable () throws -> (identity: String, deviceID: String)?
    private let authenticateVoiceIdentity: @Sendable () async throws -> Void
    private let voiceIdentityAuth: String
    private var voiceIdentityAuthenticating = Set<String>()
    private var careDelivery: Task<Void, Never>?
    private var pendingCareSafe: AssistantLocalCareSafe?
    private var careSafeStatus: String?

    private var state: AssistantSessionState = .idle
    private var observer: StateObserver?
    private var resultObserver: ResultObserver?
    private var terminalState = CentralTerminalState()
    private var terminalObserver: (@Sendable (CentralTerminalState) -> Void)?
    func setTerminalObserver(_ observer: (@Sendable (CentralTerminalState) -> Void)?) {
        terminalObserver = observer; observer?(terminalState)
    }
    func terminalSnapshot() -> CentralTerminalState { terminalState }
    func requestAppearanceOptions() async throws {
        try await publishAppearanceRequest(terminalState.appearance.requestOptions())
    }
    func prepareAppearance(lookID: String, focus: CentralAvatarProfile.Focus, expectedVersion: Int, quote: AssistantAppearanceQuote) async throws {
        try await publishAppearanceRequest(terminalState.appearance.prepare(lookID: lookID, focus: focus,
            expectedVersion: expectedVersion, confirmedQuote: quote))
    }
    func registerUploadedAppearance(_ look: AssistantAppearanceLook, owner: String?) throws {
        guard let owner, terminalState.ownerIdentity == owner, RealtimePairingSessionIdentity.shared.matches(owner) else { throw CentralTextError.contextChanged() }
        try terminalState.appearance.registerUploadedLook(look)
        terminalObserver?(terminalState)
    }
    func reconcileAppearance() async throws {
        try await publishAppearanceRequest(terminalState.appearance.reconcile())
    }
    func cancelAppearance() async throws {
        try await publishAppearanceRequest(terminalState.appearance.cancel())
    }
    func reuseAppearance(version: Int, expectedVersion: Int) async throws {
        try await publishAppearanceRequest(terminalState.appearance.reuse(version: version, expectedVersion: expectedVersion))
    }
    private var acknowledgedAppearanceVersion: Int?
    private var appearanceAcknowledgementID: UUID?
    func acknowledgeAppearanceLoaded(version: Int, owner: String) async throws {
        guard terminalState.ownerIdentity == owner, terminalState.avatarVersion == version, acknowledgedAppearanceVersion != version else { return }
        let requestID = UUID()
        acknowledgedAppearanceVersion = version; appearanceAcknowledgementID = requestID
        do { try await publishCentralRequest(AssistantCentralTextWire.encode("avatar_loaded", fields: ["profile_version": version]), identity: owner) }
        catch {
            if appearanceAcknowledgementID == requestID { acknowledgedAppearanceVersion = nil; appearanceAcknowledgementID = nil }
            throw error
        }
    }
    private func publishAppearanceRequest(_ bytes: Data) async throws {
        guard let owner = terminalState.ownerIdentity else { throw CentralTextError.contextChanged() }
        terminalObserver?(terminalState)
        do { try await publishCentralRequest(bytes, identity: owner) }
        catch {
            if terminalState.ownerIdentity == owner {
                terminalState.appearance.fail(Self.errorCode(error)); terminalObserver?(terminalState)
            }
            throw error
        }
    }

    func setTerminalCache(data: Data) throws {
        var restored = CentralTerminalState()
        try restored.restore(data)
        if centralConsumer.binding != nil { restored.bindOwner(centralConsumer.ownerPairingIdentity) }
        terminalState = restored
        terminalObserver?(terminalState)
    }
    func terminalCache() throws -> Data { try terminalState.encodedCache() }
    func revokeTerminal(deviceID: String) async throws {
        try await publishCentralRequest(AssistantCentralTextWire.encode("terminal_revoke", fields: ["control_id": UUID().uuidString, "device_id": deviceID]))
    }
    func pauseDesktop(deviceID: String? = nil, paused: Bool) async throws {
        var fields: [String: Any] = ["control_id": UUID().uuidString, "paused": paused]
        if let deviceID { fields["device_id"] = deviceID }
        try await publishCentralRequest(AssistantCentralTextWire.encode("desktop_pause", fields: fields))
    }
    func loadOlderTimeline(beforeSeq: Int) async throws {
        if let request = try terminalState.loadOlder(before: beforeSeq) {
            terminalObserver?(terminalState)
            try await publishTerminalRequest(request)
        }
    }

    private func publishTerminalRequest(_ request: Data) async throws {
        let pending = terminalState.requestID
        do { try await publishCentralRequest(request) }
        catch {
            if terminalState.failSync(requestID: pending) { terminalObserver?(terminalState) }
            throw error
        }
    }

    private var centralObserver: (@Sendable (AssistantCentralTextConsumer) -> Void)?
    private(set) var textOwner = AssistantTextOwner.legacy
    private let contactsSync: AssistantContactsSync
    private let ownerDataPairing: @Sendable () throws -> RealtimeDevicePairing?
    private var contactsTask: Task<Void, Never>?
    private var contactsTaskID: UUID?
    private var contactsDirty = false
    private var contactsStatus = "尚未开启联系人同步"
    private var contactsChangeObserver: NSObjectProtocol?
    func contactsSnapshot() async -> (enabled: Bool, status: String) {
        guard let pairing = try? ownerDataPairing() else { return (false, "请先配对你的 Mac") }
        return ((try? await contactsSync.isEnabled(identity: CentralOwnerDataIdentity.pairing(pairing))) ?? false, contactsStatus)
    }
    func setContactsEnabled(_ enabled: Bool) async throws {
        guard let pairing = try ownerDataPairing() else { throw CentralTextError.unavailable }
        cancelContactsRun()
        try await contactsSync.setEnabled(enabled, identity: CentralOwnerDataIdentity.pairing(pairing))
        contactsStatus = enabled ? "读取已开启。连接 Mac 后同步。" : "联系人同步已关闭"
        if enabled { scheduleContactsSync() }
    }
    func syncContactsNow() { scheduleContactsSync() }
    private func scheduleContactsSync() {
        if contactsChangeObserver == nil {
            contactsChangeObserver = NotificationCenter.default.addObserver(forName: .CNContactStoreDidChange, object: nil, queue: nil) { [weak self] _ in
                Task { await self?.contactsStoreChanged() }
            }
        }
        guard case .active(true) = state, let binding = centralConsumer.binding else { return }
        if contactsTask != nil { contactsDirty = true; return }
        contactsDirty = false
        let id = UUID(); contactsTaskID = id
        contactsTask = Task { [weak self] in await self?.runContactsSync(binding: binding, taskID: id) }
    }
    private func contactsStoreChanged() async {
        await contactsSync.invalidateSnapshot()
        contactsDirty = true
        scheduleContactsSync()
    }
    private func runContactsSync(binding: CentralTransportBinding, taskID: UUID) async {
        defer {
            if contactsTaskID == taskID {
                contactsTask = nil; contactsTaskID = nil
                if contactsDirty { scheduleContactsSync() }
            }
        }
        do {
            guard let pairing = try ownerDataPairing(), pairing.deviceID == binding.deviceID else { return }
            let identity = CentralOwnerDataIdentity.pairing(pairing)
            guard try await contactsSync.isEnabled(identity: identity) else { return }
            var repeatRun = true
            var limited = false
            contactsStatus = "正在同步联系人"
            while repeatRun || contactsDirty {
                contactsDirty = false; try Task.checkCancellation()
                guard centralConsumer.binding == binding, case .active(true) = state else { throw CancellationError() }
                let outcome = try await contactsSync.sync(identity: identity, maximumBytes: binding.maxPacketBytes) { [weak self] batch in
                    guard let self else { throw CancellationError() }
                    try await self.sendOwnerDataChunk(batch, binding: binding, identity: identity, contactsRunID: taskID)
                }
                switch outcome {
                case .busy: repeatRun = true; try await Task.sleep(nanoseconds: 200_000_000)
                case .complete(let partial): repeatRun = false; limited = partial
                }
            }
            contactsStatus = limited ? "Mac 已确认。仅同步你选中的联系人，移出授权范围的联系人会从 Mac 移除。" : "Mac 已确认收到联系人变化。"
        } catch is CancellationError {
            guard contactsTaskID == taskID else { return }
            contactsStatus = "同步已暂停。连接恢复后继续。"
        } catch AssistantContactsFailure.permission {
            guard contactsTaskID == taskID else { return }
            contactsStatus = "没有通讯录读取权限。没有发送删除。请在系统设置中调整权限。"
        } catch AssistantContactsFailure.invalidCard {
            guard contactsTaskID == taskID else { return }
            contactsStatus = "有联系人字段超出同步上限。没有截断。请缩短字段或减少号码与关系后重试。"
        } catch {
            guard contactsTaskID == taskID else { return }
            contactsStatus = "同步未完成。保留待确认批次，重连或点同步后重试。"
        }
    }
    private func cancelContactsRun() {
        contactsTask?.cancel(); contactsTask = nil; contactsTaskID = nil; contactsDirty = false
        if let pending = ownerDataReceipts["contacts_batch"] {
            finishOwnerDataReceipt(operation: "contacts_batch", controlID: pending.chunk.controlID, error: CancellationError())
        }
    }

    // HEALTH uses the same encrypted formal transport, with one durable-receipt wait at a time.
    private let healthStore = HKHealthStore()
    private lazy var healthSync = AssistantHealthSync(query: HealthQueryService(healthStore: healthStore))
    private lazy var healthObservers = AssistantHealthObservers(store: healthStore)
    private var healthTask: Task<Void, Never>?
    private var healthTaskID: UUID?
    private var healthDirty = false
    private var healthFallDirty = false
    private var healthWasPaused = false
    private var healthObserverWake: Task<Void, Never>?
    private var ownerDataReceipts: [String: (chunk: CentralOwnerDataBatch, binding: CentralTransportBinding,
        continuation: CheckedContinuation<Void, Error>, timeout: Task<Void, Never>, publisher: Task<Void, Never>?)] = [:]
    private var healthStatus = "尚未开启健康同步"
    private var healthObserverIdentity: String?

    func healthSnapshot() async -> (enabled: Bool, status: String) {
        guard let pairing = try? PairedRealtimeRequestBodyProvider().pairing() else {
            return (false, "请先配对你的 Mac")
        }
        return (await healthSync.isEnabled(identity: CentralOwnerDataIdentity.pairing(pairing)), healthStatus)
    }
    func setHealthEnabled(_ enabled: Bool) async throws {
        guard let pairing = try PairedRealtimeRequestBodyProvider().pairing() else { throw CentralTextError.unavailable }
        let identity = CentralOwnerDataIdentity.pairing(pairing)
        if enabled {
            _ = try await HealthAuthorizationService(healthStore: healthStore).requestReadAuthorization(for: AssistantHealthSync.metrics)
        }
        cancelHealthRun()
        await healthSync.setEnabled(enabled, identity: identity)
        healthStatus = enabled ? "授权请求已完成。读取权限由健康 App 管理。" : "健康同步已关闭"
        if enabled { await prepareHealthObservers(identity: identity); scheduleHealthSync() }
        else { healthObservers.stop(); healthObserverIdentity = nil }
    }
    func syncHealthNow() { scheduleHealthSync() }
    private func prepareHealthObservers(identity: String) async {
        guard healthObserverIdentity != identity else { return }
        healthObserverIdentity = identity
        await healthObservers.start { [weak self] metric in await self?.healthObserverChanged(identity: identity, metric: metric) }
        // A revocation during registration must not leave observers active.
        if healthObserverIdentity != identity { healthObservers.stop() }
    }
    private var healthBulkPaused: Bool { ringing || recoveryCallID != nil || callEnding != nil }
    private func syncHealthCallState() {
        let paused = healthBulkPaused
        defer { healthWasPaused = paused }
        if healthWasPaused, !paused, healthDirty { scheduleHealthSync() }
    }
    private func healthObserverChanged(identity: String, metric: HealthMetric) async {
        // Mark before HK completion. Falls bypass both the debounce and a stalled ordinary receipt/query.
        guard healthObserverIdentity == identity else { return }
        await healthSync.markObserverDirty(identity: identity)
        guard healthObserverIdentity == identity else { return }
        if metric == .numberOfTimesFallen {
            await healthSync.interruptForFall()
            guard healthObserverIdentity == identity else { return }
            cancelHealthRun()
            healthDirty = true; healthFallDirty = true
            scheduleHealthSync()
            return
        }
        healthDirty = true
        guard healthObserverWake == nil, !healthBulkPaused else { return }
        healthObserverWake = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            await self?.flushHealthObserverWake()
        }
    }
    private func flushHealthObserverWake() {
        healthObserverWake = nil
        scheduleHealthSync()
    }
    private func scheduleHealthSync() {
        guard case .active(true) = state, let binding = centralConsumer.binding else { return }
        if healthTask != nil { healthDirty = true; return }
        if healthBulkPaused, !healthFallDirty { healthDirty = true; return }
        let taskID = UUID(); healthTaskID = taskID
        healthTask = Task { [weak self] in
            await self?.runHealthSync(binding: binding, taskID: taskID)
        }
    }
    private func runHealthSync(binding: CentralTransportBinding, taskID: UUID) async {
        var resumeAfterCancellation = false
        defer {
            if healthTaskID == taskID {
                healthTask = nil; healthTaskID = nil
                if resumeAfterCancellation, healthDirty, !healthBulkPaused { scheduleHealthSync() }
            }
        }
        do {
            guard let pairing = try PairedRealtimeRequestBodyProvider().pairing(), pairing.deviceID == binding.deviceID else { return }
            let identity = CentralOwnerDataIdentity.pairing(pairing)
            guard await healthSync.isEnabled(identity: identity) else { return }
            await prepareHealthObservers(identity: identity)
            healthStatus = "正在同步健康记录"
            var more = true
            while more || healthDirty || healthFallDirty {
                let urgent = healthFallDirty
                if healthBulkPaused, !urgent { healthDirty = true; return }
                healthFallDirty = false
                if !urgent { healthDirty = false }
                try Task.checkCancellation()
                guard centralConsumer.binding == binding, case .active(true) = state else { throw CancellationError() }
                more = try await healthSync.sync(identity: identity, maximumBytes: binding.maxPacketBytes,
                    urgentOnly: urgent, allowBulk: { [weak self] in await self?.healthBulkPaused == false }) { [weak self] chunk in
                    guard let self else { throw CancellationError() }
                    try await self.sendOwnerDataChunk(chunk, binding: binding, identity: identity, healthUrgent: urgent)
                }
                if healthBulkPaused, !healthFallDirty { healthDirty = true; return }
                if !healthFallDirty, more || healthDirty { try await Task.sleep(nanoseconds: 2_000_000_000) }
            }
            healthStatus = "Mac 已确认收到可读取的健康记录。没有记录也可能是未授权。"
        } catch is CancellationError {
            guard healthTaskID == taskID else { return }
            resumeAfterCancellation = healthDirty
            healthStatus = "同步已暂停。连接恢复后继续。"
        } catch let failure as AssistantHealthFailure where failure.code == "HEALTH_PARTIAL" {
            guard healthTaskID == taskID else { return }
            healthStatus = "部分健康指标未完成。已确认的记录保留，其他指标会在重试时继续。"
        } catch {
            guard healthTaskID == taskID else { return }
            // Do not print HealthKit errors or packet values.
            healthStatus = "同步未完成。保留读取进度，重连或点同步后重试。"
        }
    }
    func sendOwnerDataChunk(_ chunk: CentralOwnerDataBatch, binding: CentralTransportBinding, identity: String, healthUrgent: Bool = false, contactsRunID: UUID? = nil) async throws {
        try Task.checkCancellation()
        if chunk.operation == "contacts_batch" {
            guard let contactsRunID, contactsTaskID == contactsRunID else { throw CancellationError() }
        }
        guard let pairing = try ownerDataPairing(), CentralOwnerDataIdentity.pairing(pairing) == identity,
              pairing.deviceID == binding.deviceID else { throw CancellationError() }
        guard ["health_batch", "contacts_batch"].contains(chunk.operation), ownerDataReceipts[chunk.operation] == nil, centralConsumer.binding == binding else { throw CentralTextError.contextChanged() }
        let publisher = try centralPublisher()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let timeout = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 20_000_000_000) } catch { return }
                await self?.finishOwnerDataReceipt(operation: chunk.operation, controlID: chunk.controlID, error: AssistantHealthFailure(code: "HEALTH_ACK_TIMEOUT"))
            }
            ownerDataReceipts[chunk.operation] = (chunk, binding, continuation, timeout, nil)
            let publication = Task { [weak self] in
                do {
                    guard let self else { throw CancellationError() }
                    try await self.publishOwnerDataChunk(chunk, binding: binding, publisher: publisher, healthUrgent: healthUrgent)
                }
                catch is CancellationError { await self?.finishOwnerDataReceipt(operation: chunk.operation, controlID: chunk.controlID, error: CancellationError()) }
                catch { await self?.finishOwnerDataReceipt(operation: chunk.operation, controlID: chunk.controlID, error: CentralTextError.unavailable) }
            }
            ownerDataReceipts[chunk.operation]?.publisher = publication
        }
    }
    private func publishOwnerDataChunk(_ chunk: CentralOwnerDataBatch, binding: CentralTransportBinding,
                                       publisher: any AssistantCentralTextPublishing, healthUrgent: Bool) async throws {
        guard ownerDataReceipts[chunk.operation]?.chunk.controlID == chunk.controlID,
              centralConsumer.binding == binding else { throw CancellationError() }
        if chunk.operation == "health_batch", !healthUrgent, healthBulkPaused {
            healthDirty = true
            throw CancellationError()
        }
        try await publisher.publishCentralTextData(chunk.bytes, binding: binding)
    }
    private func finishOwnerDataReceipt(operation: String, controlID: String, error: Error?) {
        guard let pending = ownerDataReceipts[operation], pending.chunk.controlID == controlID else { return }
        ownerDataReceipts.removeValue(forKey: operation); pending.timeout.cancel(); pending.publisher?.cancel()
        if let error { pending.continuation.resume(throwing: error) }
        else { pending.continuation.resume() }
    }
    private func acceptOwnerDataReceipt(_ fields: CentralBody) throws -> Bool {
        let operation = try fields.value("operation", as: String.self)
        let request = operation == "rejected" ? try fields.value("request_operation", as: String.self)
            : operation?.replacingOccurrences(of: "_ack", with: "_batch")
        guard let request, ["health_batch", "contacts_batch"].contains(request) else { return false }
        guard let pending = ownerDataReceipts[request], try fields.value("control_id", as: String.self) == pending.chunk.controlID,
              centralConsumer.binding == pending.binding else { return true }
        if operation == "rejected" {
            finishOwnerDataReceipt(operation: request, controlID: pending.chunk.controlID, error: AssistantHealthFailure(code: "OWNER_DATA_REJECTED"))
        } else {
            guard try pending.chunk.matchesReceipt(fields, sessionID: pending.binding.sessionID) else { throw CentralTextError.invalidPacket }
            finishOwnerDataReceipt(operation: request, controlID: pending.chunk.controlID, error: nil)
        }
        return true
    }
    private func cancelHealthRun() {
        healthObserverWake?.cancel(); healthObserverWake = nil
        healthTask?.cancel(); healthTask = nil; healthTaskID = nil; healthDirty = false; healthFallDirty = false
        if let pending = ownerDataReceipts["health_batch"] {
            finishOwnerDataReceipt(operation: "health_batch", controlID: pending.chunk.controlID, error: CancellationError())
        }
    }

    private var centralConsumer = AssistantCentralTextConsumer() { didSet { cancelSupersededVoiceRelease(); syncEchoGuard(); syncRingback(); syncHealthCallState() } }
    private var realtimeEventIngress: AssistantRealtimeEventIngress?
    private var realtimeEventTask: Task<Void, Never>?
    private var transportRecovery: (id: UUID, task: Task<Void, Never>)?
    private var callRecoveryExpiry: Task<Void, Never>?
    private var callRecoveryBudget: (call: UInt64, callID: String, loss: UUID, deadline: Date, qualified: Bool)?
    private var callLossDeadline: Date? { callRecoveryBudget?.deadline }
    private var activeIntent: AssistantStartIntent?
    private var activeDetails: AssistantConnectionDetails?
    private var lastStopResult: AssistantRemoteStopResult?
    private(set) var pendingStopContext: AssistantStopContext?
    private var pendingStopRecoveryFailed = false
    private var pendingStopRestored = false
    private var pendingStopRestoration: (id: UUID, generation: UInt64, task: Task<AssistantStopContext?, Error>)?
    private var snapshotRevision: UInt64 = 0
    private var encryptionActive = false
    private var encryptionFailureCode: String?
    private var connectionEpochCounter: UInt64 = 0
    private var activeConnectionEpoch: UInt64?
    private var activeLogicalSessionID: String?
    private var pendingPromptGenerations: [String: UInt64] = [:]
    private var completedPromptGenerations: [String: UInt64] = [:]

    private var cyclingWatchOriginBinding: CyclingWatchOriginBinding?
    private var moveEventQueue: [MoveLifecycleRecord] = []
    private var moveEventRetry: Task<Void, Never>?
    private var moveEventDrainActive = false
    private var cyclingControlLedger =
        AssistantCyclingControlSequenceLedger()

    private var generationCounter: UInt64 = 0
    private var activeGeneration: UInt64?
    private var sessionStart: Task<Void, Error>?
    private var sessionStartID: UUID?
    private var connectionWaiters: [CheckedContinuation<Void, Error>] = []
    private var inFlightBootstrap:
        Task<AssistantConnectionDetails, Error>?
    private var inFlightBootstrapGeneration: UInt64?
    private var stopRequestedGeneration: UInt64?
    private var inFlightStop:
        Task<AssistantRemoteStopResult, Never>?
    private var stopFinalization: StopFinalization?

    // Media intent (see AssistantMediaHolder). Actual publish state converges to the holders through one
    // single-flight reconciler per source that re-checks the intent and the session generation after every await.
    private var mediaHolders: [AssistantMediaSource: Set<AssistantMediaHolder>] = [:] { didSet { syncEchoGuard() } }
    private var mediaPublished: Set<AssistantMediaSource> = [] {
        // An unpublished track is gone; the next publication starts unmuted.
        didSet { if !mediaPublished.contains(.microphone) { echoMuted = false }; syncEchoGuard() }
    }
    private var mediaUnknown: Set<AssistantMediaSource> = []
    /// A call's microphone off left the LiveKit track published and muted (see publishMedia); once no call is active
    /// the next pass unpublishes it.
    private var microphoneParked = false
    private var mediaFailures: [AssistantMediaSource: Error] = [:]
    private var mediaReconcilers: [AssistantMediaSource: (id: UInt64, task: Task<Void, Never>)] = [:]
    private var mediaReconcilerCounter: UInt64 = 0
    private var mediaRevokedReason: String?
    /// Bumped by every call start, hang-up, remote close and stop: an opening call checks it after each await.
    private var callRecoveryRevision: UInt64 = 0
    private var wakeCallReadyWaiters: [(UInt64, CheckedContinuation<Void, Error>)] = []
    private var wakeCallGeneration: UInt64?
    /// Server receipt confirms its capture gate exists; local opening state is not an acknowledgement.
    private var wakeCallReadyReceiptGeneration: UInt64?
    private var callGeneration: UInt64 = 0 {
        didSet {
            artc?.setInputMonitoring(false)
            if wakeCallGeneration == oldValue { wakeListening.finishWakeCall() }
            wakeCallReadyReceiptGeneration = nil; syncRingback(); settleWakeCallReadiness()
        }
    }
    /// One tap owns its deadline. The call generation is bound after previous cleanup (see `ringing`).
    private var dial: (id: UUID, generation: UInt64?, baseCallID: String?)? {
        didSet {
            if oldValue?.id != dial?.id { dialExpiry?.cancel(); dialExpiry = nil }
            syncRingback(); publishSnapshot()
        }
    }
    private var dialExpiry: Task<Void, Never>?
    private let callDialTimeout: UInt64
    private let ringback: (any CallRingbackPlaying)?
    private var ringbackOn = false
    private var componentVideoFailure: Bool { centralConsumer.call.isActive && callFailure.flatMap(ComponentVideoFailureCode.init(rawValue:)) != nil }
    private var callFailure: String?
    private let artc: (any ARTCCallClient)?
    private var gatewayCallAudio = false
    private var videoModeChange: (id: UUID, task: Task<Void, Error>, enabled: Bool)?
    private var artcCallID: String?
    private var artcRendererID: UUID?
    private var artcJoinTask: Task<Void, Never>?
    private var callEnding: Task<Void, Error>?
    // Local presentation can end while this original logical call still requires a terminal ACK.
    private var pendingCallClose: (call: UInt64, id: String, binding: CentralTransportBinding, reason: String, sentRevision: UInt64?, stop: AssistantStopContext?)?
    private var callCloseReconciliation = false // Session resolution after the call rejoin budget ends; never renew that budget.
    private var callCloseRetiring = false
    private var callCloseSend: (id: UUID, task: Task<Void, Error>)?
    private var callCloseReady: Bool { pendingCallClose == nil || pendingCallClose?.sentRevision == callRecoveryRevision && callCloseSend == nil }
    private var recoveryCallID: String? { pendingCallClose?.id ?? (centralConsumer.call.isActive ? centralConsumer.call.id : nil) }
    private var recoveryCallGeneration: UInt64 { pendingCallClose?.call ?? callGeneration }
    private var avatarQuote: AssistantAppearanceQuote?
    private var avatarControl = false
    private var videoCallRequested = false
    /// The current call owner increments before any asynchronous video work.
    private var videoRevision: UInt64 = 0
    private var videoOffRetry: Task<Void, Never>?
    /// Cleared only by a matching server ACK, a new intent, or teardown.
    private var pendingVideoOffCallID: String? {
        didSet { if pendingVideoOffCallID == nil { videoOffRetry?.cancel(); videoOffRetry = nil } }
    }
    private var callCameraWanted = false
    private var independentCallCamera = false
    /// The hold-to-talk press being served; `open` once its window was opened.
    private var voicePress: (id: UInt64, open: Bool, operationID: String?)?
    private var voiceRelease: (operationID: String, generation: UInt64, task: Task<Void, Error>)?
    /// Highest press already released: a begin that arrives late (or is still awaiting) ends without recording.
    private var releasedVoicePress: UInt64 = 0
    /// The user's current choice to share location (revocable mid-session); the version fences late GPS fixes.
    private nonisolated let locationChoiceState = OSAllocatedUnfairLock(initialState: (enabled: false, version: UInt64(0)))
    private var locationConsent: Bool { locationChoice().enabled }
    private var locationConsentVersion: UInt64 { locationChoice().version }
    /// New capture starts in foreground; an already running call microphone continues in background.
    private var appActive = true
    private var cameraRequest: (frameID: String, camera: String, deadline: Date)?
    private var cameraRequestVisible = false
    private var cameraRequestUploaded = false
    private var cameraRequestTask: Task<Void, Never>?
    private var cameraRequestExpiry: Task<Void, Never>?
    private var navigationStandby = false
    func setNavigationStandby(_ enabled: Bool) { navigationStandby = enabled }
    private var foregroundCaptureWaiters: [CheckedContinuation<Void, Never>] = []
    private let voiceTurnSleep: @Sendable (UInt64) async throws -> Void
    /// How long a voice_send waits for its confirmation (or the D's admission) before the one resend of the original.
    private let voiceSendConfirmationWait: UInt64
    private var callAudioPlaying = false
    private var wakeWanted = false
    private var wakePhase: WakeListeningPhase = .off
    private var wakeFailure: String?
    private var wakePcmPublishedGeneration: UInt64?
    private var wakePcmSending = false
    private var wakePcmClosing = false
    private var wakePcmDrainWaiters: [CheckedContinuation<Void, Never>] = []
    private let localWakeCapture: (start: @Sendable () throws -> Void, stop: @Sendable () throws -> Void)
    private lazy var wakeListening = AssistantWakeListening(onWake: { [weak self] generation in
        Task { await self?.wakeFromKeyword(generation) }
    }, onState: { [weak self] phase, error in
        Task { await self?.wakeStateChanged(phase, error: error) }
    }, onPcmReady: { [weak self] in
        Task { await self?.drainWakePcm() }
    }, onPcmFailure: { [weak self] code in
        Task { await self?.wakePcmCaptureFailed(code) }
    }, startCapture: localWakeCapture.start, stopCapture: localWakeCapture.stop)
    /// 随身模式 (see AssistantMediaHolder.ambient), and whether the live call is muted: 静音 silences the ambient hold too.
    private var ambientWanted = false
    private var callMuted = false
    /// The 录入我的声音 press being served; `open` once its window was opened.
    private var voiceprintPress: (id: UInt64, open: Bool)?
    private var releasedVoiceprintPress: UInt64 = 0
    /// Capture muted by the echo guard (see syncEchoGuard), and its single in-flight application.
    private var echoMuted = false
    private var echoGuard: Task<Void, Never>?

    init(
        bootstrapProvider: any AssistantBootstrapProviding,
        realtime: any AssistantRealtimeTransporting,
        mediaPermissions: any MediaPermissionProviding,
        locationService: any AssistantLocationProviding,
        receipts: any AppleReceiptRecording,
        cyclingWatchOriginBinding: CyclingWatchOriginBinding? = nil,
        watchControl: (any AssistantWatchControlSending)? = nil,
        moveSensors: MoveSessionSensors? = nil,
        contactsSync: AssistantContactsSync = AssistantContactsSync(),
        ownerDataPairing: @escaping @Sendable () throws -> RealtimeDevicePairing? = { try PairedRealtimeRequestBodyProvider().pairing() },
        localWakeCapture: (start: @Sendable () throws -> Void, stop: @Sendable () throws -> Void) =
            ({ try AudioManager.shared.startLocalRecording() }, { try AudioManager.shared.stopLocalRecording() }),
        realtimeEventCapacity: Int = AssistantRealtimeEventIngress.maximumQueuedEvents,
        voiceSendConfirmationWait: UInt64 = 10_000_000_000,
        voiceTurnSleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) },
        callDialTimeout: UInt64 = 20_000_000_000,
        ringback: (any CallRingbackPlaying)? = nil,
        artc: (any ARTCCallClient)? = nil,
        localDatabase: AssistantLocalOperationDatabase? = nil,
        voiceIdentityAuth: String = "face_id",
        authenticateVoiceIdentity: @escaping @Sendable () async throws -> Void = { try await CentralVoiceBiometrics.faceID() },
        careIdentity: @escaping @Sendable () throws -> (identity: String, deviceID: String)? = {
            guard let pairing = try PairedRealtimeRequestBodyProvider().pairing() else { return nil }
            return (CentralOwnerDataIdentity.pairing(pairing), pairing.deviceID)
        }
    ) {
        self.contactsSync = contactsSync; self.ownerDataPairing = ownerDataPairing; self.localWakeCapture = localWakeCapture
        self.callDialTimeout = callDialTimeout
        self.ringback = ringback
        self.artc = artc
        self.voiceSendConfirmationWait = voiceSendConfirmationWait
        self.voiceTurnSleep = voiceTurnSleep
        self.bootstrapProvider = bootstrapProvider
        self.localDatabase = localDatabase
        self.careIdentity = careIdentity
        self.authenticateVoiceIdentity = authenticateVoiceIdentity
        self.voiceIdentityAuth = voiceIdentityAuth
        self.realtimeEventCapacity = realtimeEventCapacity
        self.realtime = realtime
        self.mediaPermissions = mediaPermissions
        self.locationService = locationService
        self.receipts = receipts
        self.cyclingWatchOriginBinding = cyclingWatchOriginBinding
        self.watchControl = watchControl
        self.moveSensors = moveSensors
    }

    private func restorePendingStopIfNeeded(explicitRetry: Bool = false, updateState: Bool = true) async {
        guard !pendingStopRestored,
              !pendingStopRecoveryFailed || explicitRetry else { return }
        let restoration: (id: UUID, generation: UInt64, task: Task<AssistantStopContext?, Error>)
        if let existing = pendingStopRestoration {
            restoration = existing
        } else {
            restoration = (UUID(), generationCounter, Task { [bootstrapProvider] in
                try await bootstrapProvider.restorePendingStop()
            })
            pendingStopRestoration = restoration
            publishSnapshot()
        }
        let outcome = await restoration.task.result
        guard pendingStopRestoration?.id == restoration.id else { return }
        pendingStopRestoration = nil
        guard restoration.generation == generationCounter else {
            publishSnapshot()
            return
        }
        switch outcome {
        case .success(let context):
            pendingStopRestored = true
            pendingStopRecoveryFailed = false
            pendingStopContext = context
            if context != nil {
                lastStopResult = AssistantRemoteStopResult(confirmed: false, opaqueReference: nil)
                if updateState { transition(.stopped(remoteStopConfirmed: false)) }
                else { publishSnapshot() }
            } else if updateState {
                transition(.idle)
            } else {
                publishSnapshot()
            }
        case .failure:
            pendingStopRecoveryFailed = true
            if updateState { transition(.failed(code: "pending_stop_storage_unavailable")) }
            else { publishSnapshot() }
        }
    }

    func setObserver(_ observer: StateObserver?) async {
        self.observer = observer
        publishSnapshot()
        await restorePendingStopIfNeeded()
        resumeCareSafeDelivery()
    }

    func presentationSnapshot() -> AssistantSessionSnapshot {
        var snapshot = AssistantSessionSnapshot(
            state: state,
            revision: snapshotRevision,
            isRestoringPendingStop: pendingStopRestoration != nil
                || (!pendingStopRestored && !pendingStopRecoveryFailed),
            hasPendingStop: pendingStopContext != nil,
            pendingStopRecoveryFailed: pendingStopRecoveryFailed,
            sessionGeneration: state.canStop ? activeGeneration : nil,
            textOwner: textOwner,
            media: AssistantMediaSnapshot(microphone: mediaPhase(.microphone), camera: mediaPhase(.camera),
                                          ambient: ambientPhase, wakeArmed: wakeWanted, wake: wakePhase, wakeFailure: wakeFailure, revokedReason: mediaRevokedReason),
            callFailure: callFailure, componentVideoFailure: componentVideoFailure, isDialing: ringing,
            videoCallRequested: videoCallRequested,
            careSafePending: pendingCareSafe != nil, careSafeStatus: careSafeStatus,
            rideMetrics: watchRideMetrics(), rideFeedback: moveSession.feedback, rideOwnerIdentity: centralConsumer.ownerPairingIdentity
        )
        snapshot.cameraRequestCamera = cameraRequest?.camera ?? "back"
        snapshot.cameraRequestVisible = cameraRequestVisible
        snapshot.media.callAudioPlaying = callAudioPlaying && centralConsumer.call.isActive
        snapshot.media.callMicrophone = (centralConsumer.call.isActive || centralConsumer.call.state == "closing")
            ? mediaPhase(.microphone) : centralConsumer.call.id != nil && mediaHolders[.microphone]?.contains(.ambient) != true ? mediaPhase(.microphone) : .off
        if wakeCallGeneration == callGeneration, centralConsumer.call.isActive, !callMuted,
           wakePcmPublishedGeneration == callGeneration, !wakeListening.pcm.hasFailed {
            snapshot.media.callMicrophone = .on
        }
        snapshot.voiceStatus = AssistantVoiceStatus(call: centralConsumer.call, media: snapshot.media, isDialing: ringing || (centralConsumer.call.isActive && !encryptionActive), isEnding: callEnding != nil)
        snapshot.voiceActivityCallID = centralConsumer.call.isActive && !centralConsumer.call.isAmbient && callEnding == nil
            ? centralConsumer.call.id : nil
        return snapshot
    }

    private func publishSnapshot() {
        if !centralConsumer.call.isActive { callAudioPlaying = false }
        syncHealthCallState()
        snapshotRevision &+= 1
        observer?(presentationSnapshot())
    }

    func snapshot() -> AssistantSessionState {
        state
    }

    func setResultObserver(_ observer: ResultObserver?) {
        resultObserver = observer
    }

    func setTextOwner(_ owner: AssistantTextOwner) throws {
        guard state.canStart, pendingStopContext == nil else { throw CentralTextError.contextChanged() }
        textOwner = owner
        moveSession.clearFeedback()
        do { try centralConsumer.reset(binding: nil, generation: generationCounter) }
        catch { centralConsumer.reportWireFailure(error) }
        centralObserver?(centralConsumer)
    }

    let paymentChannel = AssistantPaymentChannel()

    private func attachPaymentChannel() async {
        guard case .active(true) = state, encryptionActive,
              let binding = centralConsumer.binding else { return }
        await paymentChannel.attach(binding: binding) { [weak self] bytes, binding, dispatch in
            guard let self else { throw AssistantPaymentChannelError.notDispatched(AssistantPaymentChannelError.detached) }
            try await self.publishPayment(bytes, binding: binding, dispatch: dispatch)
        }
    }

    private func publishPayment(_ bytes: Data, binding: CentralTransportBinding, dispatch: AssistantPaymentDispatch) async throws {
        if Task.isCancelled { throw AssistantPaymentChannelError.notDispatched(CancellationError()) }
        guard case .active(true) = state, encryptionActive, centralConsumer.binding == binding,
              activeDetails?.capabilities.canPublishData == true,
              let publisher = realtime as? any AssistantCentralTextPublishing else {
            throw AssistantPaymentChannelError.notDispatched(CentralTextError.unavailable)
        }
        try dispatch.begin()
        try await publisher.publishCentralTextData(bytes, binding: binding)
        guard case .active(true) = state, encryptionActive,
              centralConsumer.binding == binding else { throw CentralTextError.contextChanged() }
    }

    func setCentralTextObserver(_ observer: (@Sendable (AssistantCentralTextConsumer) -> Void)?) {
        centralObserver = observer
        observer?(centralConsumer)
    }

    private func centralPublisher() throws -> any AssistantCentralTextPublishing {
        guard textOwner == .centralCandidate, case .active(true) = state, encryptionActive,
              activeDetails?.capabilities.canPublishData == true,
              centralConsumer.binding != nil, callCloseReady,
              let publisher = realtime as? any AssistantCentralTextPublishing else { throw CentralTextError.unavailable }
        return publisher
    }

    func centralTextSnapshot() -> AssistantCentralTextConsumer { centralConsumer }

    private func publishCentralRequest(_ bytes: Data, identity: String? = nil, jobID: String? = nil, notifyObserver: Bool = true, call: UInt64? = nil, isResultPoll: Bool = false) async throws {
        try await drainPendingCallClose()
        if let call { try requireCall(call) }
        if let identity { try requireOwner(identity) }
        if let jobID, !centralConsumer.errands.contains(where: { $0.id == jobID }) { throw CentralTextError.contextChanged() }
        let publisher = try centralPublisher()
        let generation = activeGeneration
        if notifyObserver { centralObserver?(centralConsumer) }
        try await publisher.publishCentralTextData(bytes, binding: centralConsumer.binding!)
        guard activeGeneration == generation else {
            if isResultPoll { throw AssistantSessionCoordinatorError.superseded }
            throw CentralTextError.contextChanged()
        }
    }

    private func drainPendingCallClose() async throws {
        if let sending = callCloseSend {
            try await sending.task.value
            if callCloseSend?.id == sending.id { callCloseSend = nil }
        }
        guard var close = pendingCallClose, close.sentRevision != callRecoveryRevision else { return }
        guard encryptionActive, activeDetails?.capabilities.canPublishData == true,
              close.binding == centralConsumer.binding, let publisher = realtime as? any AssistantCentralTextPublishing else { throw CentralTextError.unavailable }
        let generation = activeGeneration, recovery = callRecoveryRevision, sendID = UUID()
        let bytes = try AssistantCentralTextWire.call("call_close", callID: close.id, reason: close.reason)
        close.sentRevision = recovery; pendingCallClose = close
        let sending = Task { try await publisher.publishCentralTextData(bytes, binding: close.binding) }
        callCloseSend = (sendID, sending)
        defer {
            if callCloseSend?.id == sendID { callCloseSend = nil }
            if isActiveState, callCloseReady { reconcilePublishedMedia() }
        }
        do {
            try await sending.value
            guard activeGeneration == generation, encryptionActive, callRecoveryRevision == recovery, centralConsumer.binding == close.binding else { throw CentralTextError.contextChanged() }
        } catch {
            if pendingCallClose?.call == close.call, pendingCallClose?.id == close.id, pendingCallClose?.sentRevision == recovery {
                pendingCallClose?.sentRevision = nil
                if let generation, isCurrentGeneration(generation), encryptionActive,
                   callRecoveryRevision == recovery, centralConsumer.binding == close.binding {
                    // A failed write is an observed transport loss; reuse the same bounded recovery owner.
                    encryptionActive = false; transition(.reconnecting, reason: "call_close_publish_failed")
                    let lossRecovery = callRecoveryRevision
                    await freezeCallLossDeadline(); scheduleCallRecoveryExpiry(generation: generation)
                    await paymentChannel.detach()
                    guard isCurrentGeneration(generation), !encryptionActive,
                          callRecoveryRevision == lossRecovery, centralConsumer.binding == close.binding else { throw error }
                    transportRecovery?.task.cancel(); transportRecovery = nil
                    beginTransportRecovery(generation: generation)
                }
            }
            throw error // Intent remains owned; publication failure is not acknowledgement.
        }
    }

    private func acknowledgeCallClose() async {
        pendingCallClose = nil; callCloseReconciliation = false
        callRecoveryExpiry?.cancel(); callRecoveryExpiry = nil; callRecoveryBudget = nil
        await realtime.setCallRejoinDeadline(nil, callActive: centralConsumer.call.isActive)
    }

    private func playPendingCentralVoice() async throws {
        guard let playback = try centralConsumer.takeVoicePlayback(), let binding = centralConsumer.binding else { return }
        let generation = activeGeneration
        do { try await centralPublisher().playCentralVoice(playback, binding: binding) }
        catch {
            guard activeGeneration == generation else { playback.resource.remove(); return }
            _ = try? centralConsumer.voiceCompleted(playback, successfully: false, observedAt: "")
            try? await centralPublisher().prepareCentralVoice(eventID: nil)
        }
    }
    func requestCentralResult(sealed: Bool = false) async throws {
        let generation = activeGeneration
        if centralConsumer.canRetryVoicePlayback {
            try centralConsumer.retryVoicePlayback()
            try await centralPublisher().prepareCentralVoice(eventID: centralConsumer.eventID)
            guard activeGeneration == generation else { throw AssistantSessionCoordinatorError.superseded }
        }
        let bytes = try centralConsumer.requestResult(sealed: sealed)
        try await publishCentralRequest(bytes, isResultPoll: true)
    }

    func requestCentralRetainedResult(processedID: String) async throws {
        let bytes = try centralConsumer.requestRetainedResult(processedID: processedID)
        try await publishCentralRequest(bytes, isResultPoll: true)
    }

    func setCallConversationMode(_ mode: CallConversationMode) async throws {
        let id = UUID().uuidString.lowercased()
        let bytes = try centralConsumer.setCallConversationMode(mode, controlID: id)
        try await publishCallControl(bytes, controlID: id)
    }

    func resendCallConversationMode() async throws {
        let bytes = try centralConsumer.resendCallConversationMode()
        try await publishCallControl(bytes, controlID: centralConsumer.call.conversationModeControlID!)
    }

    func retryCallThinking() async throws {
        let bytes = try centralConsumer.retryCallThinking(controlID: UUID().uuidString.lowercased())
        try await publishCallControl(bytes, controlID: centralConsumer.call.thinkingRetryControlID!)
    }

    private func publishCallControl(_ bytes: Data, controlID: String) async throws {
        do { try await publishCentralRequest(bytes, call: callGeneration) }
        catch {
            centralConsumer.reportCallControlFailure(error, controlID: controlID)
            centralObserver?(centralConsumer)
            throw error
        }
    }

    func requestCentralControl(_ operation: String, eventID: String? = nil) async throws {
        let generation = activeGeneration
        guard eventID == nil || centralConsumer.eventID == eventID else { throw CentralTextError.contextChanged() }
        let bytes = try centralConsumer.requestControl(operation, controlID: UUID().uuidString.lowercased())
        if operation == "retry_voice" {
            try await centralPublisher().prepareCentralVoice(eventID: centralConsumer.eventID)
        }
        if operation == "cancel_playback" {
            centralObserver?(centralConsumer)
            try await centralPublisher().prepareCentralVoice(eventID: nil)
        }
        guard activeGeneration == generation else { throw CentralTextError.contextChanged() }
        try await publishCentralRequest(bytes)
    }

    func requestCentralMemoryProposals(controlID: String) async throws {
        let bytes = try centralConsumer.requestMemoryProposals(controlID: controlID)
        try await publishCentralRequest(bytes)
    }

    func decideCentralMemory(_ proposal: CentralMemoryProposal, choice: CentralMemoryDecision.Choice, controlID: String) async throws {
        let bytes = try centralConsumer.decideMemory(proposal, choice: choice, controlID: controlID)
        try await publishCentralRequest(bytes)
    }

    func retryCentralMemoryControl(_ controlID: String) async throws {
        try await publishCentralRequest(centralConsumer.retryMemoryControl(controlID))
    }

    func retryCentralSubmission() async throws {
        try await publishCentralRequest(centralConsumer.retryTypedSubmission())
    }

    private var centralTextRecoveryTask: Task<Void, Never>?
    private var centralTextRecoveryID: UUID?
    func cancelCentralTextRecovery() {
        centralTextRecoveryTask?.cancel()
        centralTextRecoveryTask = nil
        centralTextRecoveryID = nil
    }
    func scheduleCentralTextRecovery() {
        guard centralTextRecoveryTask == nil, (try? centralConsumer.needsTypedRecovery) == true,
              case .active(true) = state, textOwner == .centralCandidate else { return }
        let generation = activeGeneration
        let recoveryID = UUID()
        centralTextRecoveryID = recoveryID
        centralTextRecoveryTask = Task { [weak self] in
            await self?.runCentralTextRecovery(generation: generation, recoveryID: recoveryID)
        }
    }

    private func runCentralTextRecovery(generation: UInt64?, recoveryID: UUID) async {
        defer {
            if centralTextRecoveryID == recoveryID {
                centralTextRecoveryTask = nil; centralTextRecoveryID = nil
            }
        }
        while !Task.isCancelled, activeGeneration == generation {
            do {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                guard !Task.isCancelled, activeGeneration == generation,
                      try centralConsumer.needsTypedRecovery else { return }
                if !centralConsumer.pendingRenderedACKs.isEmpty {
                    try await retryCentralRenderedACK()
                }
                for bytes in try centralConsumer.typedRecoveryRequests() {
                    guard !Task.isCancelled, activeGeneration == generation else { return }
                    try await publishCentralRequest(bytes)
                }
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled, activeGeneration == generation else { return }
                centralConsumer.reportTypedRecoveryFailure(error)
                centralObserver?(centralConsumer)
            }
        }
    }

    // MARK: media intent

    /// Takes `source` for `holder` on the live session (an explicit user action: a call, its camera, a hold-to-talk
    /// window) and returns once it is published. A release, hang-up, revocation or Stop during any await ends the
    /// attempt with `superseded`, and whatever was published meanwhile is unpublished by the same reconciler.
    func acquireMedia(_ source: AssistantMediaSource, for holder: AssistantMediaHolder) async throws {
        guard !videoCallRequested || holder == .call || holder == .cameraRequest else { throw CentralTextError.unavailable }
        guard case .active = state, let generation = activeGeneration else {
            throw AssistantSessionCoordinatorError.notActive
        }
        guard encryptionActive else { throw LiveKitSessionError.e2eeUnavailable }
        mediaFailures[source] = nil
        mediaRevokedReason = nil
        mediaHolders[source, default: []].insert(holder)
        if source == .microphone, holder == .call {
            artc?.setInputMuted(false)
            resumeAmbientAfterMute()
            if wakeCallGeneration == callGeneration { wakeListening.setWireMuted(false) }
        }
        publishSnapshot()
        await reconcileMedia(source).value
        if mediaHolders[source]?.contains(holder) == true, mediaPublished.contains(source) { return }
        guard isCurrentGeneration(generation) else { throw AssistantSessionCoordinatorError.superseded }
        if let failure = mediaFailures[source] { throw failure }
        throw AssistantSessionCoordinatorError.superseded
    }

    /// Gives up `holder`'s claim; the source closes once no holder is left. Allowed in every state (a mute during
    /// a reconnect is not dropped); a failed unpublish leaves the source `unknown` and is retried on the next
    /// reconcile (another release, the end of a reconnect) or settled by Stop.
    @discardableResult
    func releaseMedia(_ source: AssistantMediaSource, for holder: AssistantMediaHolder) async -> Bool {
        // 静音 in a call silences the microphone, so 随身模式 pauses with it until unmute or hang-up.
        if source == .microphone, holder == .call, centralConsumer.call.isActive {
            artc?.setInputMuted(true)
            callMuted = true
            if wakeCallGeneration == callGeneration { wakeListening.setWireMuted(true) }
            mediaHolders[.microphone]?.remove(.ambient)
        }
        dropMediaHolder(source, holder)
        await reconcileMedia(source).value
        return mediaPhase(source) == .off
    }

    private func dropMediaHolder(_ source: AssistantMediaSource, _ holder: AssistantMediaHolder) {
        guard mediaHolders[source]?.remove(holder) != nil || mediaUnknown.contains(source) else { return }
        resumeForegroundCapture()
        publishSnapshot()
        _ = reconcileMedia(source)
    }

    /// Withdraws holders without a user request (hang-up, remote close, background); nothing restores them.
    private func revokeMedia(_ holders: Set<AssistantMediaHolder>, reason: String?) {
        for source in [AssistantMediaSource.microphone, .camera] {
            let held = mediaHolders[source] ?? []
            guard !held.isDisjoint(with: holders) else { continue }
            mediaHolders[source] = held.subtracting(holders)
            if let reason { mediaRevokedReason = reason }
            _ = reconcileMedia(source)
        }
        resumeForegroundCapture()
        publishSnapshot()
    }

    /// A new or ended session starts with nothing held or published (Stop already tore the room down).
    private func resetMedia(reason: String?) {
        cameraRequestTask?.cancel(); cameraRequestExpiry?.cancel()
        cameraRequest = nil; cameraRequestVisible = false; cameraRequestUploaded = false
        if let reason, mediaHolders.values.contains(where: { !$0.isEmpty }) { mediaRevokedReason = reason }
        callMuted = false; voiceprintPress = nil; pendingVideoOffCallID = nil
        mediaHolders.removeAll(keepingCapacity: true)
        mediaPublished.removeAll(keepingCapacity: true)
        mediaUnknown.removeAll(keepingCapacity: true)
        microphoneParked = false
        mediaFailures.removeAll(keepingCapacity: true)
        mediaReconcilers.removeAll(keepingCapacity: true)
        resumeForegroundCapture()
    }

    private func wantsMedia(_ source: AssistantMediaSource) -> Bool {
        if source == .camera && !appActive { return false }
        if videoCallRequested && !independentCallCamera && artcCallID == nil && source == .camera { return false }
        return !(mediaHolders[source]?.isEmpty ?? true)
    }

    // Call opening acquires the microphone before creating a logical call. Its existing audio path can resume
    // after mute in the background, including ambient restoration during hang-up; new capture still waits.
    private func canCaptureMedia(_ source: AssistantMediaSource) -> Bool {
        appActive || mediaPublished.contains(source) ||
            source == .microphone && (recoveryCallID != nil || callEnding != nil || wakeWanted)
    }

    private var ambientPhase: AssistantAmbientPhase {
        guard ambientWanted else { return .off }
        if videoCallRequested { return .paused }
        guard mediaHolders[.microphone]?.contains(.ambient) == true else {
            return sessionStart != nil && !state.canStart ? .starting : .paused
        }
        return mediaPublished.contains(.microphone) ? .on : .starting
    }

    private func mediaPhase(_ source: AssistantMediaSource) -> AssistantMediaPhase {
        let published = mediaPublished.contains(source)
        if wantsMedia(source) { return published ? .on : .opening }
        if mediaUnknown.contains(source) { return .unknown }
        return published ? .closing : .off
    }

    /// Whether the real state of `source` differs from its holders: published or not, an unconfirmed unpublish, or
    /// the muted track a call left on LiveKit after the call ended.
    private func mediaDiverged(_ source: AssistantMediaSource) -> Bool {
        let wanted = wantsMedia(source)
        return wanted != mediaPublished.contains(source) || mediaUnknown.contains(source) || !wanted && source == .microphone &&
            microphoneParked && !centralConsumer.call.isActive && (artcCallID == nil || gatewayCallAudio)
    }

    private func reconcilePublishedMedia() {
        for source in [AssistantMediaSource.microphone, .camera] where mediaDiverged(source) {
            _ = reconcileMedia(source)
        }
    }

    private func reconcileMedia(_ source: AssistantMediaSource) -> Task<Void, Never> {
        if let running = mediaReconcilers[source] { return running.task }
        mediaReconcilerCounter &+= 1
        let id = mediaReconcilerCounter
        let task = Task { await self.convergeMedia(source, reconciler: id) }
        mediaReconcilers[source] = (id, task)
        return task
    }

    private func resumeForegroundCapture() {
        let waiting = foregroundCaptureWaiters
        foregroundCaptureWaiters.removeAll()
        waiting.forEach { $0.resume() }
    }

    /// Converges the published state of `source` to its holders. Each pass re-reads the intent after its await, so
    /// a change made while a publish/unpublish was in flight is applied by the next pass; a pass that finds the
    /// session generation changed stops (Stop/start reset the media state).
    private func convergeMedia(_ source: AssistantMediaSource, reconciler: UInt64) async {
        defer {
            if mediaReconcilers[source]?.id == reconciler { mediaReconcilers[source] = nil }
            publishSnapshot()
        }
        while mediaReconcilers[source]?.id == reconciler {
            guard mediaDiverged(source) else { return }
            let wanted = wantsMedia(source)
            guard let generation = activeGeneration, state == .reconnecting || isActiveState else {
                if wanted { failMedia(source, AssistantSessionCoordinatorError.notActive) }
                return
            }
            if wanted && (!encryptionActive || !callCloseReady) { return } // Recovery must not revoke standing ambient intent.
            let liveKitCapture = artcCallID == nil || gatewayCallAudio
            if wanted {
                if !canCaptureMedia(source) {
                    await withCheckedContinuation { foregroundCaptureWaiters.append($0) }
                    continue // Re-read holders, provider and generation after foreground or revocation.
                }
                do {
                    _ = try await mediaPermissions.authorize(source: source, userInitiated: true)
                } catch {
                    guard isCurrentGeneration(generation), (artcCallID == nil || gatewayCallAudio) == liveKitCapture else { return }
                    failMedia(source, error)
                    continue
                }
                guard isCurrentGeneration(generation), (artcCallID == nil || gatewayCallAudio) == liveKitCapture else { return }
                guard wantsMedia(source), canCaptureMedia(source) else { continue }
                guard encryptionActive, callCloseReady else { return }
                let recovery = callRecoveryRevision
                do {
                    let parked = try await publishMedia(source, enabled: true)
                    guard isCurrentGeneration(generation), (artcCallID == nil || gatewayCallAudio) == liveKitCapture else { return }
                    // An old-room result cannot settle the replacement room's media state.
                    if recovery != callRecoveryRevision { if encryptionActive { continue }; return }
                    mediaPublished.insert(source)
                    mediaUnknown.remove(source)
                    if let parked { microphoneParked = parked }
                } catch {
                    guard isCurrentGeneration(generation), (artcCallID == nil || gatewayCallAudio) == liveKitCapture else { return }
                    // An old-room result cannot settle the replacement room's media state.
                    if recovery != callRecoveryRevision { if encryptionActive { continue }; return }
                    failMedia(source, error)
                    mediaUnknown.insert(source) // a half-done publish is closed by the next pass
                }
            } else {
                let recovery = callRecoveryRevision
                do {
                    let parked = try await publishMedia(source, enabled: false)
                    guard isCurrentGeneration(generation), (artcCallID == nil || gatewayCallAudio) == liveKitCapture else { return }
                    // An old-room result cannot settle the replacement room's media state.
                    if recovery != callRecoveryRevision { if encryptionActive { continue }; return }
                    mediaPublished.remove(source)
                    mediaUnknown.remove(source)
                    if let parked { microphoneParked = parked }
                } catch {
                    guard isCurrentGeneration(generation), (artcCallID == nil || gatewayCallAudio) == liveKitCapture else { return }
                    // An old-room result cannot settle the replacement room's media state.
                    if recovery != callRecoveryRevision { if encryptionActive { continue }; return }
                    mediaPublished.remove(source)
                    mediaUnknown.insert(source)
                    if source == .microphone, wakeWanted, !wantsMedia(.microphone) {
                        do { try wakeListening.stop() } catch { wakeFailure = Self.errorCode(error) }
                        wakePhase = .unavailable
                        wakeFailure = wakeFailure ?? "microphone_stop_unconfirmed"
                    }
                    return
                }
            }
            publishSnapshot()
        }
    }

    private var isActiveState: Bool { if case .active = state { return true } else { return false } }

    private func failMedia(_ source: AssistantMediaSource, _ error: Error) {
        mediaFailures[source] = error
        mediaHolders[source] = []
    }

    /// The video-avatar (ARTC) call flips its own camera; LiveKit calls flip their capturer in the call view.
    func switchARTCCamera() async throws -> Bool {
        guard artcCallID != nil, let artc else { throw CentralTextError.unavailable }
        return try await artc.switchCamera()
    }

    /// Off inside a call mutes the LiveKit microphone and keeps it published (unmute resumes the same capture and the
    /// call's reader stays attached); anywhere else off unpublishes it, so the device stops recording (A6: outside a
    /// call there is no published microphone without a holder). Armed local wake restores device-only input afterwards.
    /// Returns whether that microphone is now parked muted.
    private func publishMedia(_ source: AssistantMediaSource, enabled: Bool) async throws -> Bool? {
        if artcCallID != nil && !gatewayCallAudio {
            guard let artc else { throw CentralTextError.unavailable }
            try await artc.setMedia(source, enabled: enabled)
            return nil
        }
        let park = source == .microphone && !enabled && centralConsumer.call.isActive
        try await realtime.setMedia(source: source, enabled: enabled, userInitiated: true, keepPublished: park)
        if source == .microphone, !enabled, !park { restoreLocalWakeCapture() }
        return source == .microphone ? park : nil
    }

    /// Camera capture and avatar output can be selected independently on the existing call.
    func setCallCamera(_ enabled: Bool) async throws {
        guard centralConsumer.call.isActive else { throw CentralTextError.unavailable }
        independentCallCamera = true
        callCameraWanted = enabled
        if enabled {
            let call = callGeneration
            try await acquireMedia(.camera, for: .call)
            try requireCall(call)
        } else {
            await releaseMedia(.camera, for: .call)
        }
    }

    /// Uses the same serialized output authority while the camera keeps its independent media holder.
    func setCallAvatar(_ enabled: Bool, quote: AssistantAppearanceQuote? = nil) async throws {
        avatarQuote = quote
        if !enabled, componentVideoFailure { callFailure = nil }
        avatarControl = true
        independentCallCamera = true
        try await setCallVideo(enabled)
    }

    /// Changes the output of the existing call. No new call, transport or microphone capture is created.
    func setCallVideo(_ enabled: Bool) async throws { try await enqueueCallVideo(enabled).value }

    private func enqueueCallVideo(_ enabled: Bool, serverConfirmedOff: Bool = false) -> Task<Void, Error> {
        if !serverConfirmedOff {
            guard videoRevision < 9_007_199_254_740_991 else { return Task { throw CentralTextError.invalidPacket } }
            videoRevision += 1 // Only a new owner intent advances the command fence.
        }
        let revision = videoRevision
        pendingVideoOffCallID = nil
        let previous = videoModeChange, id = UUID(), call = callGeneration
        let task = Task {
            defer { if self.videoModeChange?.id == id { self.videoModeChange = nil } }
            // OFF must not wait for an older ON permission/publication. Its revision fences the late result.
            if let previous, enabled || !previous.enabled { _ = await previous.task.result }
            guard self.callGeneration == call, self.videoRevision == revision, self.centralConsumer.call.isActive else { throw AssistantSessionCoordinatorError.superseded }
            try await self.changeCallVideo(enabled, modeID: id, revision: revision, serverConfirmedOff: serverConfirmedOff)
        }
        videoModeChange = (id, task, enabled)
        return task
    }

    private func changeCallVideo(_ enabled: Bool, modeID: UUID, revision: UInt64, serverConfirmedOff: Bool) async throws {
        guard let id = centralConsumer.call.id, centralConsumer.call.isActive,
              !enabled || appActive else { throw CentralTextError.unavailable }
        let call = callGeneration
        let legacy = centralConsumer.call.media.map { $0.audio_input != "gateway" } ?? (artcCallID != nil && !gatewayCallAudio)
        if !enabled {
            videoCallRequested = false
            if !independentCallCamera { callCameraWanted = false }
            pendingVideoOffCallID = serverConfirmedOff ? nil : id
            if !serverConfirmedOff { scheduleVideoOffRetry(call: call, revision: revision) }
            centralConsumer.stopCallVideo(id); centralObserver?(centralConsumer); syncRingback()
            if !independentCallCamera { dropMediaHolder(.camera, .call) }
            // Start the server downgrade before waiting for a joining renderer to leave.
            let downgrade = Task { try await self.reconcileVideoOff() }
            await leaveARTC(preservingVoice: true)
            await reconcileMedia(.camera).value
            if !callMuted { await reconcileMedia(.microphone).value }
            try await downgrade.value
        } else {
            if !independentCallCamera { _ = try await mediaPermissions.authorize(source: .camera, userInitiated: true) }
            try await waitForCallRecovery(call)
            guard appActive, videoModeChange?.id == modeID else { throw AssistantSessionCoordinatorError.superseded }
            pendingVideoOffCallID = nil
            videoCallRequested = true
            if !independentCallCamera { callCameraWanted = true }
            if componentVideoFailure { callFailure = nil }
            if legacy { try await acquireMedia(.camera, for: .call) }
        }
        guard callGeneration == call else { throw AssistantSessionCoordinatorError.superseded }
        if !legacy && enabled {
            try await publishCentralRequest(AssistantCentralTextWire.call(avatarControl ? "call_avatar" : "call_video", callID: id, video: enabled, videoRevision: revision, confirmedQuote: avatarControl ? avatarQuote : nil))
        }
        publishSnapshot()
    }

    private func reconcileVideoOff() async throws {
        guard let id = pendingVideoOffCallID, centralConsumer.call.id == id, centralConsumer.call.isActive else { return }
        try await publishCentralRequest(AssistantCentralTextWire.call(avatarControl ? "call_avatar" : "call_video", callID: id, video: false, videoRevision: videoRevision))
        // Publication is not an ACK. The same revision is retried until its matching state arrives.
    }

    private func scheduleVideoOffRetry(call: UInt64, revision: UInt64) {
        videoOffRetry?.cancel()
        videoOffRetry = Task { [weak self] in await self?.runVideoOffRetry(call: call, revision: revision) }
    }

    private func runVideoOffRetry(call: UInt64, revision: UInt64) async {
        while !Task.isCancelled {
            do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
            guard callGeneration == call, videoRevision == revision,
                  pendingVideoOffCallID != nil, centralConsumer.call.isActive else { return }
            guard isActiveState, encryptionActive else { continue }
            do { try await reconcileVideoOff() }
            catch {
                guard callGeneration == call, centralConsumer.call.isActive else { return }
                callFailure = ComponentVideoFailureCode.stopFailed.rawValue; publishSnapshot()
            }
        }
    }

    private func detachVideoForConnectionLoss() async {
        // An existing OFF already owns its revision and presentation cleanup.
        guard centralConsumer.call.isActive, videoCallRequested, videoModeChange?.enabled != false else { return }
        let call = callGeneration
        do { try await setCallVideo(false) }
        catch {
            guard callGeneration == call, centralConsumer.call.isActive else { return }
            callFailure = ComponentVideoFailureCode.stopFailed.rawValue; publishSnapshot()
        }
    }

    // MARK: calls

    /// Opens a live call for an explicit user action (the app or the Watch) on the current session. The call holds
    /// the microphone, and the camera for video, under one call generation: a hang-up, remote close or Stop during
    /// any await ends this attempt and releases what it already opened. A refused camera leaves a voice call.
    /// Returns whether the requested camera is on.
    @discardableResult
    func startCall(video: Bool, camera: Bool? = nil, startIntent: AssistantStartIntent = AssistantStartIntent(userInitiated: true),
                   location: (@Sendable () async -> AssistantLocationObservation?)? = nil, wakeWord: Bool = false,
                    enrollment: (sessionID: String, callID: String)? = nil) async throws -> Bool {
        guard !Task.isCancelled, !wakeWord || wakeWanted else {
            logCallStartFailure(step: "admission", error: AssistantSessionCoordinatorError.superseded)
            throw AssistantSessionCoordinatorError.superseded
        }
        if centralConsumer.call.isActive, callEnding == nil { return !video || mediaPublished.contains(.camera) }
        let attempt = UUID()
        callFailure = nil
        dial = (attempt, nil, centralConsumer.call.id)
        // One deadline covers previous cleanup, connection, capture and the authoritative live receipt.
        dialExpiry = Task { [callDialTimeout] in
            do { try await Task.sleep(nanoseconds: callDialTimeout) } catch { return }
            guard self.dial?.id == attempt, self.ringing else { return }
            self.callFailure = "连接超时，请重试"
            self.dial = nil
            // A stalled capture cannot be drained by endCall. Retire its room through the existing Stop owner.
            let stop = self.beginStopOperation(reasonCode: "call_dial_timeout", finalization: .stopped)
            _ = await stop.value
            self.finishStopOperationIfNeeded()
        }
        var step = "previous_call_end"
        do {
            if let callEnding { try await callEnding.value }
            guard dial?.id == attempt else { throw AssistantSessionCoordinatorError.superseded }
            step = "pending_call_close"
            try await drainPendingCallClose()
            // Publication is not the terminal receipt. Keep this dial under its existing deadline until it arrives.
            while pendingCallClose != nil, dial?.id == attempt, !Task.isCancelled {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            guard dial?.id == attempt, !Task.isCancelled else { throw AssistantSessionCoordinatorError.superseded }
        } catch {
            logCallStartFailure(step: step, error: error)
            if dial?.id == attempt {
                callFailure = Self.errorCode(error)
                dial = nil
            }
            throw error
        }
        if wakeWanted { wakeListening.controller.setCallPhase(.opening) }
        callFailure = nil
        callGeneration &+= 1
        let call = callGeneration
        callAudioPlaying = false
        wakePcmPublishedGeneration = nil
        wakeCallGeneration = wakeWord ? call : nil
        videoRevision = 0
        pendingVideoOffCallID = nil
        avatarControl = false; avatarQuote = nil
        videoCallRequested = video; callCameraWanted = false
        independentCallCamera = camera != nil
        dial = (attempt, call, isActiveState ? centralConsumer.call.id : nil)
        do {
            step = "ensure_active"
            try await ensureActive(startIntent)
            try await waitForCallRecovery(call)
            step = "central_publisher"
            _ = try centralPublisher()
            if !wakeWord {
                step = "microphone"
                artc?.setInputMonitoring(true)
                try await recoverCallOpening(call) { try await self.acquireMedia(.microphone, for: .call) }
            }
            try await waitForCallRecovery(call)
            let wantsCamera = camera ?? videoCallRequested
            var cameraOn = !wantsCamera
            if wantsCamera && appActive {
                do { _ = try await mediaPermissions.authorize(source: .camera, userInitiated: true); cameraOn = true }
                catch AssistantSessionCoordinatorError.superseded { throw AssistantSessionCoordinatorError.superseded }
                catch { cameraOn = false }
                try await waitForCallRecovery(call)
            }
            callCameraWanted = wantsCamera && appActive && cameraOn
            let consent = locationConsentVersion
            step = "location"
            let place = await location?()
            try await waitForCallRecovery(call)
            step = "open_call"
            let opening = try centralConsumer.openCall(location: acceptsLocation(consent) ? place : nil, silenceTimeout: CallSilenceTimeout.load(), video: videoCallRequested, wakeWord: wakeWord, enrollment: enrollment)
            step = "call_playback"
            await realtime.setCallPlaybackID(centralConsumer.call.id)
            await realtime.setCallRejoinDeadline(nil, callActive: true)
            step = "publish_call_open"
            try await recoverCallOpening(call) { try await self.publishCentralRequest(opening, call: call) }
            try await waitForCallRecovery(call)
            if wakeWord {
                step = "wake_call_ready"
                try await waitForWakeCallReady(call)
                step = "microphone"
                artc?.setInputMonitoring(true)
                try await recoverCallOpening(call) { try await self.acquireMedia(.microphone, for: .call) }
            }
            try await waitForCallRecovery(call)
            if independentCallCamera && callCameraWanted {
                do {
                    step = "camera"
                    try await acquireMedia(.camera, for: .call)
                    try requireCall(call)
                } catch AssistantSessionCoordinatorError.superseded where callGeneration == call && !callCameraWanted {
                    return false // Camera OFF withdraws capture without hanging up the existing voice call.
                }
            }
            return cameraOn
        } catch {
            logCallStartFailure(step: step, error: error)
            let superseded = Task.isCancelled || callGeneration != call
            if callGeneration == call {
                callFailure = Self.errorCode(error)
                try? await endCall(reason: "error", cancelPendingDial: false)
            }
            if superseded { throw AssistantSessionCoordinatorError.superseded }
            throw error
        }
    }

    private func logCallStartFailure(step: String, error: Error) {
        let code = (error as? CentralTextError)?.description ?? Self.errorCode(error)
        let native = error as NSError
        let rejoinPolicy = centralConsumer.binding?.callRejoinWindowS != nil
        Logger(subsystem: "ai.paios.personal.phase0", category: "call").error(
            "CALL_START_FAILED step=\(step, privacy: .public) error_code=\(code, privacy: .public) error_domain=\(native.domain, privacy: .public) error_number=\(native.code, privacy: .public) rejoin_policy=\(rejoinPolicy, privacy: .public)")
    }

    /// Hangs up: invalidates any opening attempt, closes an opening/live call and releases the call's media.
    func endCall(reason: String = "button", cancelPendingDial: Bool = true) async throws {
        if cancelPendingDial, let dial, dial.generation == nil { self.dial = nil }
        artc?.setInputMonitoring(false)
        if dial?.generation != nil, ringing, !centralConsumer.call.isActive, mediaReconcilers[.microphone] != nil {
            // Opening capture may not return. Cancel it through the same room owner as dial expiry.
            if reason == "button" { callFailure = nil }
            _ = await stop(reasonCode: "call_open_cancelled")
            return
        }
        if let callEnding { try await callEnding.value; return }
        if pendingCallClose != nil {
            if encryptionActive { try await drainPendingCallClose() }
            else if callCloseReconciliation, let generation = activeGeneration { beginTransportRecovery(generation: generation) }
            return // A repeated offline hang-up cannot replace its binding, reason or recovery budget.
        }
        let ending = Task {
            await self.realtime.setCallPlaybackID(nil)
            self.callAudioPlaying = false
            let endingGeneration = self.callGeneration
            if self.wakeCallGeneration == self.callGeneration, self.wakeListening.pcm.isCapturingCall {
                self.wakePcmClosing = true
                self.wakeListening.sealWakeCall()
                if self.wakeCallReadyReceiptGeneration == self.callGeneration {
                    if self.wakePcmSending {
                        await withCheckedContinuation { self.wakePcmDrainWaiters.append($0) }
                    }
                    await self.drainWakePcm()
                } else {
                    self.wakeFailure = "wake_pcm_closed_before_receipt"
                }
                self.wakePcmClosing = false
            }
            guard self.callGeneration == endingGeneration else { return }
            let id = self.centralConsumer.call.id, wasVideo = self.videoCallRequested
            if self.centralConsumer.call.isActive, let id, let binding = self.centralConsumer.binding {
                self.pendingCallClose = (self.callGeneration, id, binding, reason, nil, nil)
                _ = try self.centralConsumer.closeCall(reason: reason)
            }
            self.callGeneration &+= 1 // Fence opening/media work, not the retained logical recovery identity.
            if self.pendingCallClose == nil {
                if !self.encryptionActive { self.transportRecovery?.task.cancel() }; self.transportRecovery = nil
                self.callRecoveryExpiry?.cancel(); self.callRecoveryExpiry = nil; self.callRecoveryBudget = nil
                await self.realtime.setCallRejoinDeadline(nil, callActive: false)
            }
            self.pendingVideoOffCallID = nil
            if !["error", "artc_join_failed"].contains(reason) { self.callFailure = nil }
            self.revokeMedia([.call], reason: nil)
            self.centralObserver?(self.centralConsumer); self.publishSnapshot()
            // A renderer leave/join cannot delay the gateway's authoritative close and paid retirement.
            let delivery = self.encryptionActive ? Task { try await self.drainPendingCallClose() } : nil
            await self.leaveARTC()
            self.resumeAmbientAfterMute()
            if self.mediaDiverged(.microphone) { _ = self.reconcileMedia(.microphone) } // unpublishes a muted call's track
            defer {
                if wasVideo { self.centralConsumer.finishCall(id) }
                self.centralObserver?(self.centralConsumer); self.publishSnapshot()
            }
            let closeResult = await delivery?.result // Publishing close can schedule the final microphone restore.
            for source in [AssistantMediaSource.microphone, .camera] { await self.mediaReconcilers[source]?.task.value }
            if wasVideo && self.ambientWanted { try await self.applyAmbient() }
            if self.wakeWanted { self.wakeListening.controller.setCallPhase(.closed) }
            try closeResult?.get()
        }
        callEnding = ending
        publishSnapshot()
        defer {
            callEnding = nil; syncHealthCallState(); publishSnapshot()
            if wakeWanted { wakeListening.controller.setCallPhase(.closed) }
        }
        try await ending.value
    }

    private func stopComponentVideo(failure: ComponentVideoFailureCode? = nil, notifyGateway: Bool) {
        guard let id = centralConsumer.call.id, centralConsumer.call.isActive else { return }
        let call = callGeneration
        callFailure = failure?.rawValue; videoCallRequested = false
        if !independentCallCamera { callCameraWanted = false }
        centralConsumer.stopCallVideo(id); centralObserver?(centralConsumer); syncRingback()
        if !independentCallCamera { dropMediaHolder(.camera, .call) }
        let cleanup = enqueueCallVideo(false, serverConfirmedOff: !notifyGateway)
        let revision = videoRevision
        publishSnapshot()
        Task {
            do { try await cleanup.value }
            catch {
                guard self.callGeneration == call, self.videoRevision == revision else { return }
                self.callFailure = ComponentVideoFailureCode.stopFailed.rawValue; self.publishSnapshot()
                #if DEBUG
                print("PAIOS_COMPONENT_STOP_FAILED domain=\((error as NSError).domain) code=\((error as NSError).code)")
                #endif
            }
        }
    }

    private func connectCallMedia(errorCode: String?) {
        if centralConsumer.call.isActive, (avatarControl ? centralConsumer.call.avatar == false : centralConsumer.call.video == false) {
            guard (avatarControl ? centralConsumer.call.avatarRevision : centralConsumer.call.videoRevision) == videoRevision else { return }
            if let failure = errorCode.flatMap(ComponentVideoFailureCode.init(rawValue:)) {
                stopComponentVideo(failure: failure, notifyGateway: false)
            } else if artcCallID != nil || !videoCallRequested && callCameraWanted && !independentCallCamera {
                stopComponentVideo(notifyGateway: false)
            }
            return
        }
        guard appActive, centralConsumer.call.isActive, artcJoinTask == nil, artcCallID == nil else { return }
        if avatarControl, centralConsumer.call.avatarRevision != videoRevision { return }
        let call = callGeneration
        guard let id = centralConsumer.call.id else { return }
        if let media = centralConsumer.call.media {
            guard videoCallRequested else { return }
            guard media.audio_input == "gateway" else {
                // Legacy hardware ownership cannot keep a foreground-started microphone through backgrounding.
                // Preserve LiveKit's existing graph and ask the server for the supported voice-only route.
                stopComponentVideo(failure: .rtcFailed, notifyGateway: true)
                return
            }
            artcJoinTask = Task { await self.joinARTC(media, call: call, id: id) }
        } else if !avatarControl, videoCallRequested, centralConsumer.call.state == "live" {
            // The gateway has no video provider: use its existing LiveKit call.
            videoCallRequested = false
            artcJoinTask = Task {
                defer { if self.callGeneration == call { self.artcJoinTask = nil } }
                do {
                    try self.requireCall(call)
                    try await self.acquireMedia(.microphone, for: .call)
                    try self.requireCall(call)
                    if !self.independentCallCamera, self.callCameraWanted { try await self.acquireMedia(.camera, for: .call) }
                } catch {
                    guard self.callGeneration == call else { return }
                    self.callFailure = Self.errorCode(error); try? await self.endCall(reason: "error", cancelPendingDial: false)
                }
            }
        }
    }

    private func joinARTC(_ media: CentralCall.Media, call: UInt64, id: String) async {
        defer { if callGeneration == call { artcJoinTask = nil } }
        do {
            try requireCall(call)
            guard let artc else { throw CentralTextError.unavailable }
            gatewayCallAudio = media.audio_input == "gateway"
            if !gatewayCallAudio {
                revokeMedia([.ambient, .call], reason: nil)
                for source in [AssistantMediaSource.microphone, .camera] { await reconcileMedia(source).value }
            }
            try requireCall(call)
            guard mediaUnknown.isEmpty else { throw CentralTextError.unavailable }
            if gatewayCallAudio && !callMuted { try await acquireMedia(.microphone, for: .call) }
            try requireCall(call)
            guard appActive, videoCallRequested else { return }
            let rendererID = UUID()
            artcRendererID = rendererID
            artcCallID = id
            try await artc.join(media, camera: callCameraWanted && !gatewayCallAudio) { [weak self] event in
                Task { await self?.artcEvent(event, call: call, id: id, rendererID: rendererID) }
            }
            try requireCall(call)
            if gatewayCallAudio, !independentCallCamera, callCameraWanted { try await acquireMedia(.camera, for: .call) }
            try requireCall(call)
            if !gatewayCallAudio {
                mediaHolders[.microphone, default: []].insert(.call); mediaPublished.insert(.microphone)
                if callCameraWanted { mediaHolders[.camera, default: []].insert(.call); mediaPublished.insert(.camera) }
            }
            publishSnapshot()
        } catch {
            guard !Task.isCancelled, callGeneration == call else { return }
            artcJoinTask = nil // Cleanup must not await the join task that requested it.
            if media.audio_input == "gateway" {
                if videoCallRequested { stopComponentVideo(failure: .rtcFailed, notifyGateway: true) }
                return
            }
            callFailure = "artc_join_failed"; try? await endCall(reason: "artc_join_failed", cancelPendingDial: false)
        }
    }

    private func artcEvent(_ event: ARTCCallEvent, call: UInt64, id: String, rendererID: UUID) async {
        guard callGeneration == call, artcCallID == id, artcRendererID == rendererID,
              centralConsumer.call.isActive else { return }
        if gatewayCallAudio && !videoCallRequested { return }
        switch event {
        case .firstFrame:
            guard appActive, videoCallRequested else { return }
            centralConsumer.renderedCallFrame(id); syncRingback(); centralObserver?(centralConsumer); publishSnapshot()
        case .failed:
            if gatewayCallAudio { stopComponentVideo(failure: .rtcFailed, notifyGateway: true); return }
            let reason = centralConsumer.call.videoFrameRendered ? "error" : "artc_join_failed"
            callFailure = reason; try? await endCall(reason: reason, cancelPendingDial: false)
        }
    }

    private func leaveARTC(preservingVoice: Bool = false) async {
        artcRendererID = nil
        let joining = artcJoinTask
        joining?.cancel(); artcJoinTask = nil
        await joining?.value
        let hadARTC = artcCallID != nil
        if hadARTC {
            do { try await artc?.leave() }
            catch { callFailure = gatewayCallAudio && preservingVoice ? ComponentVideoFailureCode.stopFailed.rawValue : "artc_audio_restore_failed" }
            if !preservingVoice && !gatewayCallAudio {
                mediaPublished.remove(.microphone); mediaUnknown.remove(.microphone)
            }
            if !gatewayCallAudio {
                mediaPublished.remove(.camera); mediaUnknown.remove(.camera)
            }
        }
        artcCallID = nil; gatewayCallAudio = preservingVoice; videoCallRequested = false
    }

    private func recoverCallOpening(_ call: UInt64, operation: () async throws -> Void) async throws {
        while true {
            try await waitForCallRecovery(call)
            let recovery = callRecoveryRevision
            do { try await operation(); return }
            catch {
                // Recovery is an observed transport state. Reuse the operation/id after it recovers.
                guard callGeneration == call, !Task.isCancelled,
                      state == .reconnecting || state == .encryptionPreparing || callRecoveryRevision != recovery else { throw error }
            }
        }
    }

    private func waitForCallRecovery(_ call: UInt64) async throws {
        while callGeneration == call, !Task.isCancelled,
              state == .reconnecting || state == .encryptionPreparing {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try requireCall(call)
    }

    private func requireCall(_ call: UInt64) throws {
        guard !Task.isCancelled, callGeneration == call, isActiveState else { throw AssistantSessionCoordinatorError.superseded }
    }

    private func requireOwner(_ identity: String) throws {
        guard try careIdentity()?.identity == identity,
              centralConsumer.ownerPairingIdentity == identity else { throw CentralTextError.contextChanged() }
    }

    func cancelErrand(_ id: String, identity: String? = nil) async throws {
        if let identity { try requireOwner(identity) }
        try await publishCentralRequest(centralConsumer.cancelErrand(id), identity: identity, jobID: id)
    }

    func setAppActive(_ active: Bool) {
        appActive = active
        if active {
            if cameraRequest != nil, !cameraRequestVisible { resumeCameraRequest() }
            if wakeWanted, wakePhase == .unavailable {
                Task {
                    do { try await self.setWakeEnabled(true) }
                    catch { self.wakeFailure = Self.errorCode(error); self.publishSnapshot() }
                }
            }
            resumeForegroundCapture()
#if os(iOS)
            scheduleHealthSync(); scheduleContactsSync()
#endif
        }
    }

    /// Dialing and live calls retain the voice session; component video is detached on backgrounding.
    func retainsSession(for reasonCode: String) -> Bool {
        if reasonCode == "network_unavailable" {
            return navigationStandby || ringing || recoveryCallID != nil ||
                (mediaHolders[.microphone]?.contains(.ambient) == true && (isActiveState || state == .reconnecting))
        }
        if reasonCode == "audio_interruption" {
            // LiveKit pauses and resumes its existing engine; legacy ARTC recovery is not established.
            let liveKitOwned = centralConsumer.call.media.map { $0.audio_input == "gateway" } ?? (artcCallID == nil || gatewayCallAudio)
            return (ringing || centralConsumer.call.isActive || wakeWanted) && liveKitOwned
        }
        return reasonCode == "app_background" && (navigationStandby || wakeWanted || ringing || recoveryCallID != nil || moveSession.isActive ||
            (mediaHolders[.microphone]?.contains(.ambient) == true && (isActiveState || state == .reconnecting)))
    }

    // MARK: Local wake

    func setWakeEnabled(_ enabled: Bool) async throws {
        wakeWanted = enabled
        if !enabled {
            wakeListening.controller.setEnabled(false)
            wakePhase = .off; wakeFailure = nil; publishSnapshot()
            if wakeCallGeneration == callGeneration, ringing { try await endCall(reason: "button", cancelPendingDial: false) }
            if let pending = mediaReconcilers[.microphone]?.task { await pending.value }
            guard !wakeWanted else { return }
            do { try wakeListening.stop(captureInUse: mediaPublished.contains(.microphone) || mediaUnknown.contains(.microphone)) }
            catch {
                wakePhase = .unavailable; wakeFailure = Self.errorCode(error); publishSnapshot()
                throw error
            }
            return
        }
        do {
            _ = try await mediaPermissions.authorize(source: .microphone, userInitiated: true)
            guard wakeWanted else { return }
            if mediaUnknown.contains(.microphone) {
                await reconcileMedia(.microphone).value
                guard wakeWanted else { return }
                guard !mediaUnknown.contains(.microphone) else { throw CentralTextError.unavailable }
            }
            try wakeListening.start(usingPublishedCapture: mediaPublished.contains(.microphone))
            wakeListening.controller.setCallPhase(ringing ? .opening : centralConsumer.call.isActive ? .active : .closed)
        } catch {
            wakePhase = .unavailable; wakeFailure = Self.errorCode(error); publishSnapshot()
            throw error
        }
    }

    private func restoreLocalWakeCapture() {
        guard wakeWanted else { return }
        do { try wakeListening.restoreCapture() }
        catch {
            try? wakeListening.stop(captureInUse: true)
            wakePhase = .unavailable; wakeFailure = Self.errorCode(error); publishSnapshot()
        }
    }

    private func waitForWakeCallReady(_ generation: UInt64) async throws {
        try requireCall(generation)
        if wakeCallReadyReceiptGeneration == generation { return }
        try await withCheckedThrowingContinuation { wakeCallReadyWaiters.append((generation, $0)) }
        try requireCall(generation)
    }

    private func settleWakeCallReadiness() {
        let waiting = wakeCallReadyWaiters
        wakeCallReadyWaiters.removeAll()
        for (generation, continuation) in waiting {
            if generation != callGeneration || !wakeWanted || !centralConsumer.call.isActive {
                continuation.resume(throwing: AssistantSessionCoordinatorError.superseded)
            } else if wakeCallReadyReceiptGeneration == generation { continuation.resume() }
            else { wakeCallReadyWaiters.append((generation, continuation)) }
        }
    }

    private func wakeStateChanged(_ phase: WakeListeningPhase, error: String?) {
        guard wakeWanted, wakeListening.isRecording, wakeListening.controller.phase != .off else { return }
        wakePhase = wakeListening.controller.phase
        wakeFailure = wakeListening.controller.failure
        publishSnapshot()
    }

    private func wakeFromKeyword(_ generation: UInt64) async {
        guard wakeWanted, wakeListening.controller.isCurrentWake(generation) else {
            wakeListening.pcm.discard(generation: generation)
            return
        }
        guard !centralConsumer.call.isActive, !ringing, voicePress == nil, voiceprintPress == nil else {
            wakeListening.controller.discardWake(generation)
            wakeListening.pcm.discard(generation: generation)
            return
        }
        wakeListening.controller.setCallPhase(.opening)
        do { _ = try await startCall(video: false, wakeWord: true) }
        catch {
            if !centralConsumer.call.isActive, !ringing {
                wakeListening.finishWakeCall()
                wakeListening.controller.setCallPhase(.closed)
            }
            wakeFailure = Self.errorCode(error); publishSnapshot()
        }
    }

    /// One ordered audio drain uses the existing reliable control publisher. A send
    /// retains its PCM budget until completion; a source error closes the call.
    private func drainWakePcm() async {
        guard !wakePcmSending, wakeCallGeneration == callGeneration,
              wakeCallReadyReceiptGeneration == callGeneration,
              centralConsumer.call.isActive, let callID = centralConsumer.call.id,
              let sessionID = centralConsumer.binding?.sessionID else { return }
        let generation = callGeneration
        wakePcmSending = true
        defer {
            wakePcmSending = false
            let waiting = wakePcmDrainWaiters; wakePcmDrainWaiters.removeAll()
            for continuation in waiting { continuation.resume() }
            if wakeListening.pcm.hasReadyFrames { Task { await self.drainWakePcm() } }
        }
        do {
            while let frame = wakeListening.pcm.next() {
                try requireCall(generation)
                guard centralConsumer.call.id == callID, centralConsumer.call.isActive else {
                    throw AssistantSessionCoordinatorError.superseded
                }
                let bytes = try AssistantCentralTextWire.callPcm(callID: callID, sessionID: sessionID, frame: frame)
                try await publishCentralRequest(bytes, notifyObserver: false)
                try requireCall(generation)
                wakeListening.pcm.acknowledge(sequence: frame.sequence)
                if wakePcmPublishedGeneration != generation {
                    wakePcmPublishedGeneration = generation
                    publishSnapshot()
                }
            }
        } catch {
            if callGeneration == generation {
                let code = Self.errorCode(error)
                wakeListening.pcm.fail(code)
                // Retire only after this sender returns and its defer releases the
                // in-flight drain. endCall may wait for that same drain to finish.
                Task {
                    guard self.callGeneration == generation else { return }
                    await self.wakePcmFailed(code)
                }
            }
        }
    }

    private func wakePcmCaptureFailed(_ code: String) async {
        guard wakeListening.pcm.hasFailed else { return } // A closed capture cannot fail a replacement call.
        await wakePcmFailed(code)
    }

    private func wakePcmFailed(_ code: String) async {
        guard wakeListening.pcm.isCapturingCall else { return }
        wakeFailure = code; callFailure = code; publishSnapshot()
        if wakePcmClosing { return } // The existing close owns failure retirement while draining its tail.
        if wakeCallGeneration == callGeneration { try? await endCall(reason: "error", cancelPendingDial: false) }
        else { wakeListening.finishWakeCall() }
    }

    // MARK: 随身模式

    /// The user's 随身模式 choice. On: the running session (and every later one) holds the microphone for it, beside
    /// calls and hold-to-talk. Off: released at once. Throws only for the running session's acquisition (permission
    /// refused, publish failed); the choice itself stands and shows as paused.
    func setAmbient(_ on: Bool, startIntent: AssistantStartIntent? = nil) async throws {
        ambientWanted = on
        publishSnapshot()
        if on, let startIntent { try await ensureActive(startIntent) }
        try await applyAmbient()
    }

    private func applyAmbient() async throws {
        if ambientWanted && !callMuted && !videoCallRequested && isActiveState { try await acquireMedia(.microphone, for: .ambient) }
        else { await releaseMedia(.microphone, for: .ambient) }
    }

    /// A call that was muted ends or unmutes: 随身模式, still chosen, holds the microphone again.
    private func resumeAmbientAfterMute() {
        guard callMuted else { return }
        callMuted = false
        guard ambientWanted, !videoCallRequested, isActiveState else { return }
        mediaHolders[.microphone, default: []].insert(.ambient)
        _ = reconcileMedia(.microphone)
    }

    /// 依米's own replies play outside WebRTC (AVAudioPlayer), so the platform echo canceller cannot take them out of the
    /// microphone. While one plays and only 随身模式 holds the microphone, the published track is muted; any other holder
    /// (a call, hold-to-talk, enrollment) unmutes it at once. A call's own audio is WebRTC's and is cancelled there.
    private func syncEchoGuard() {
        guard artcCallID == nil || gatewayCallAudio else { return }
        // RTP calls suppress ringback through capture mute. Wake PCM must keep recording the
        // buffered question during setup; explicit user mute still zeros its tap frames.
        let wanted = (ringing && wakeCallGeneration != callGeneration || centralConsumer.playingVoice != nil && mediaHolders[.microphone] == [.ambient]) && mediaPublished.contains(.microphone)
        guard wanted != echoMuted, echoGuard == nil, let publisher = realtime as? any AssistantCentralTextPublishing else { return }
        echoGuard = Task {
            let applied = (try? await publisher.setCaptureMuted(wanted)) != nil
            // A failed attempt waits a second before the guard looks again (a stuck mute must not silence 随身模式).
            if !applied { try? await Task.sleep(nanoseconds: 1_000_000_000) }
            self.echoGuard = nil
            if applied { self.echoMuted = wanted }
            self.syncEchoGuard()
        }
    }

    /// Dialing: from the tap until central reports the call live (or failed, closed, hung up). Before call_open is sent the
    /// consumer still shows the previous call (same id); afterwards only "opening" keeps it ringing.
    private var ringing: Bool {
        guard let dial else { return false }
        guard let generation = dial.generation else { return true }
        guard generation == callGeneration else { return false }
        if !isActiveState { return true }
        let call = centralConsumer.call
        return call.id == dial.baseCallID || call.isActive && call.state != "live"
    }

    private func syncRingback() {
        let wanted = ringing
        if !wanted, dial != nil, dial?.generation != callGeneration || centralConsumer.call.id != dial?.baseCallID { dial = nil }
        guard wanted != ringbackOn else { return }
        ringbackOn = wanted
        if wanted { ringback?.start() } else { ringback?.stop() }
        syncEchoGuard()
    }

    // MARK: 录入我的声音

    /// Press `press` on a sentence: takes the microphone for one enrollment window and opens it. A release that arrived
    /// first, or during any await, wins and nothing records.
    func pressVoiceprintSample(_ press: UInt64) async throws {
        guard press > releasedVoiceprintPress else { throw AssistantSessionCoordinatorError.superseded }
        guard isActiveState, activeGeneration != nil else { throw AssistantSessionCoordinatorError.notActive }
        voiceprintPress = (press, false)
        do {
            try await acquireMedia(.microphone, for: .voiceprint)
            try requireVoiceprintPress(press)
            try await publishCentralRequest(centralConsumer.beginVoiceprint(operationID: "voiceprint-" + UUID().uuidString.lowercased()))
            try requireVoiceprintPress(press)
            voiceprintPress = (press, true)
        } catch {
            if voiceprintPress?.id == press { voiceprintPress = nil; await closeVoiceprintWindow() }
            settleVoiceprintMicrophone()
            throw error
        }
    }

    /// The finger lifted: a cancel (or a release before the window opened) closes the window; a release commits it and
    /// returns central's measurement of the sentence.
    func releaseVoiceprintSample(_ press: UInt64, cancel: Bool) async throws -> CentralVoiceprintSample? {
        releasedVoiceprintPress = max(releasedVoiceprintPress, press)
        guard let current = voiceprintPress, current.id == press else { return nil }
        guard current.open, !cancel else {
            voiceprintPress = nil
            dropMediaHolder(.microphone, .voiceprint)
            if centralConsumer.ownerVoice.voiceprint.phase == .measuring {
                _ = expireVoiceprint("VOICEPRINT_CANCELLED")
            } else { await closeVoiceprintWindow() }
            return nil
        }
        defer {
            if voiceprintPress?.id == press { voiceprintPress = nil }
            settleVoiceprintMicrophone()
        }
        var waited = 0
        while centralConsumer.ownerVoice.voiceprint.phase == .opening && waited < 100 {
            try await Task.sleep(nanoseconds: 50_000_000)
            waited += 1
            try requireVoiceprintPress(press)
        }
        try requireVoiceprintPress(press)
        guard centralConsumer.ownerVoice.voiceprint.phase == .recording else { throw expireVoiceprint("VOICEPRINT_OPEN_TIMEOUT") }
        // The trailing delay lets the last frames reach the reader.
        try await Task.sleep(nanoseconds: 300_000_000)
        try requireVoiceprintPress(press)
        try await publishCentralRequest(centralConsumer.commitVoiceprint())
        try requireVoiceprintPress(press)
        dropMediaHolder(.microphone, .voiceprint)
        for _ in 0..<300 where centralConsumer.ownerVoice.voiceprint.phase == .measuring {
            try await Task.sleep(nanoseconds: 50_000_000)
            try requireVoiceprintPress(press)
        }
        try requireVoiceprintPress(press)
        let state = centralConsumer.ownerVoice.voiceprint
        switch state.phase {
        case .measured: return state.sample
        case .measuring: throw expireVoiceprint("VOICEPRINT_MEASURE_TIMEOUT")
        default: throw CentralVoiceprintFailure(code: state.errorCode ?? "VOICEPRINT_SAMPLE_FAILED")
        }
    }

    /// Read the profile, commit measured samples (the registry judges the set), or forget it; waits for the answer.
    @discardableResult
    func voiceEnrollmentControl(_ action: String) async throws {
        let opening = action == "start" || action == "resume"
        if opening {
            guard !ringing, !centralConsumer.call.isActive else { throw CentralTextError.unavailable }
            try await ensureActive(AssistantStartIntent(userInitiated: true))
        }
        if action == "check", centralConsumer.call.isActive,
           centralConsumer.call.id == centralConsumer.ownerVoice.enrollment.callID { try await endCall(reason: "button", cancelPendingDial: false) }
        let callID = opening ? "call-" + UUID().uuidString.lowercased() : nil
        let id = UUID().uuidString.lowercased()
        do {
            try await publishCentralRequest(centralConsumer.voiceEnrollmentControl(action, id: id, callID: callID))
            publishSnapshot()
            for _ in 0..<400 where centralConsumer.ownerVoice.enrollment.pending == id { try await Task.sleep(nanoseconds: 50_000_000) }
            if centralConsumer.ownerVoice.enrollment.pending == id {
                centralConsumer.expireVoiceEnrollment(id, code: "VOICE_ENROLLMENT_ACK_TIMEOUT"); publishSnapshot()
            }
            let state = centralConsumer.ownerVoice.enrollment
            if let code = state.controlError { throw CentralVoiceprintFailure(code: code) }
            if opening, let session = state.sessionID, let callID, state.phase == .collecting {
                try await startCall(video: false, enrollment: (session, callID))
            } else if action != "status", centralConsumer.call.id == state.callID {
                try await endCall(reason: "button", cancelPendingDial: false)
            }
        } catch {
            centralConsumer.expireVoiceEnrollment(id, code: Self.errorCode(error)); publishSnapshot()
            if opening, centralConsumer.ownerVoice.enrollment.phase == .collecting {
                do { try await voiceEnrollmentControl("pause") }
                catch { callFailure = Self.errorCode(error); publishSnapshot() }
            }
            throw error
        }
    }

    func voiceprintControl(_ operation: String, sampleIDs: [String]? = nil, sourceDeviceID: String? = nil) async throws -> CentralVoiceprint {
        let id = "voiceprint-" + UUID().uuidString.lowercased()
        try await publishCentralRequest(centralConsumer.voiceprintControl(operation, controlID: id, sampleIDs: sampleIDs, sourceDeviceID: sourceDeviceID))
        for _ in 0..<400 where centralConsumer.ownerVoice.voiceprint.pending?.id == id { try await Task.sleep(nanoseconds: 50_000_000) }
        if centralConsumer.ownerVoice.voiceprint.pending?.id == id {
            centralConsumer.expireVoiceprintControl(id, code: "VOICEPRINT_CONTROL_TIMEOUT")
            centralObserver?(centralConsumer)
        }
        let state = centralConsumer.ownerVoice.voiceprint
        if let code = state.controlError { throw CentralVoiceprintFailure(code: code) }
        return state
    }

    private func requireVoiceprintPress(_ press: UInt64) throws {
        guard voiceprintPress?.id == press, isActiveState else { throw AssistantSessionCoordinatorError.superseded }
    }

    private func expireVoiceprint(_ code: String) -> CentralVoiceprintFailure {
        centralConsumer.expireVoiceprint(code)
        centralObserver?(centralConsumer)
        return CentralVoiceprintFailure(code: code)
    }

    private func closeVoiceprintWindow() async {
        if let bytes = try? centralConsumer.cancelVoiceprint() { try? await publishCentralRequest(bytes) }
        centralObserver?(centralConsumer)
    }

    /// The enrollment microphone closes once no press is open and no window is opening or recording.
    private func settleVoiceprintMicrophone() {
        guard voiceprintPress == nil, mediaHolders[.microphone]?.contains(.voiceprint) == true,
              ![.opening, .recording].contains(centralConsumer.ownerVoice.voiceprint.phase) else { return }
        dropMediaHolder(.microphone, .voiceprint)
    }

    // MARK: 确认是我

    /// Confirms one pending prompt; the confirmed request is followed like any observation. Waits a bounded time for
    /// central's answer (the prompt leaves the pushed set, or the tap is refused).
    func confirmVoice(_ id: String, choice: CentralVoiceConfirmationChoice? = nil) async throws {
        guard let item = centralConsumer.ownerVoice.confirmable(id), !voiceIdentityAuthenticating.contains(id) else { throw CentralTextError.unavailable }
        let binding = centralConsumer.binding
        if !item.isNativeApproval {
            guard choice == nil else { throw CentralTextError.unavailable }
            voiceIdentityAuthenticating.insert(id)
            defer { voiceIdentityAuthenticating.remove(id) }
            try await authenticateVoiceIdentity()
            try Task.checkCancellation()
            guard centralConsumer.binding == binding, centralConsumer.ownerVoice.confirmable(id) != nil else { throw CentralTextError.unavailable }
        }
        try await sendVoiceConfirmation(id, choice: choice, auth: item.isNativeApproval ? nil : voiceIdentityAuth)
    }

    func trustVoiceWindow(sourceDeviceID: String) async throws {
        let binding = centralConsumer.binding
        try await authenticateVoiceIdentity()
        try Task.checkCancellation()
        guard centralConsumer.binding == binding else { throw CentralTextError.contextChanged() }
        let state = try await voiceprintControl("voice_trust_window_open", sourceDeviceID: sourceDeviceID)
        guard let id = state.trustConfirmationID else { throw CentralTextError.invalidPacket }
        for _ in 0..<200 where centralConsumer.ownerVoice.confirmable(id) == nil { try await Task.sleep(nanoseconds: 50_000_000) }
        guard centralConsumer.binding == binding else { throw CentralTextError.contextChanged() }
        guard centralConsumer.ownerVoice.confirmable(id) != nil else { throw CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_TIMEOUT") }
        try await sendVoiceConfirmation(id, auth: voiceIdentityAuth)
    }

    private func sendVoiceConfirmation(_ id: String, choice: CentralVoiceConfirmationChoice? = nil, auth: String?) async throws {
        try await publishCentralRequest(centralConsumer.confirmVoice(id, choice: choice, auth: auth))
        for _ in 0..<200 where centralConsumer.ownerVoice.confirming[id] != nil { try await Task.sleep(nanoseconds: 50_000_000) }
        if centralConsumer.ownerVoice.confirming[id] != nil {
            centralConsumer.expireVoiceConfirm(id)
            centralObserver?(centralConsumer)
            throw CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_TIMEOUT")
        }
        if let code = centralConsumer.ownerVoice.confirmationError { throw CentralVoiceprintFailure(code: code) }
    }

    /// Admit durably before readiness. A notification never borrows the identity of a later pairing.
    func careSafe(identity: String) throws -> String {
        guard let owner = try careIdentity(), identity == owner.identity,
              let localDatabase else { throw CentralTextError.unavailable }
        let control = try localDatabase.preserveCareSafe(identity: owner.identity, deviceID: owner.deviceID)
        if let previous = centralConsumer.ownerVoice.careControl, previous != control.controlID { centralConsumer.expireCare(previous) }
        pendingCareSafe = control
        _ = try centralConsumer.careSafe(controlID: pendingCareSafe!.controlID)
        careSafeStatus = "正在告诉依米你没事…仍在送达"
        publishSnapshot()
        resumeCareSafeDelivery()
        return careSafeStatus!
    }

    private func resumeCareSafeDelivery() {
        guard careDelivery == nil, let localDatabase else { return }
        do {
            guard let owner = try careIdentity() else { return }
            pendingCareSafe = try localDatabase.pendingCareSafe(identity: owner.identity)
            if let pendingCareSafe { _ = try centralConsumer.careSafe(controlID: pendingCareSafe.controlID) }
        } catch {
            careSafeStatus = "“我没事”的送达记录暂时无法读取"
            publishSnapshot()
            return
        }
        guard pendingCareSafe != nil else { return }
        careSafeStatus = "正在告诉依米你没事…仍在送达"
        publishSnapshot()
        careDelivery = Task { [weak self] in await self?.deliverCareSafe() }
    }

    private func deliverCareSafe() async {
        defer { careDelivery = nil }
        while let control = pendingCareSafe, !Task.isCancelled {
            do {
                guard let owner = try careIdentity(), owner.identity == control.identity, owner.deviceID == control.deviceID else {
                    pendingCareSafe = nil; careSafeStatus = nil; publishSnapshot(); return
                }
                if centralConsumer.binding != nil, centralConsumer.ownerPairingIdentity != control.identity {
                    _ = await stop(reasonCode: "pairing_changed")
                }
                try await ensureActive(AssistantStartIntent(locationEnabled: locationConsent, userInitiated: true))
                guard pendingCareSafe?.controlID == control.controlID else { continue }
                guard try careIdentity()?.identity == control.identity,
                      centralConsumer.ownerPairingIdentity == control.identity,
                      centralConsumer.binding?.deviceID == control.deviceID else { throw CentralTextError.contextChanged() }
                if centralConsumer.ownerVoice.careControl == nil,
                   centralConsumer.ownerVoice.careOutcome != nil || centralConsumer.ownerVoice.careError != nil {
                    try finishCareSafeDelivery()
                } else {
                    try await publishCentralRequest(centralConsumer.careSafe(controlID: control.controlID))
                    try finishCareSafeDelivery()
                }
            } catch {
                careSafeStatus = "正在告诉依米你没事…仍在送达"
                publishSnapshot()
            }
            if pendingCareSafe == nil { return }
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
        }
    }

    private func finishCareSafeDelivery() throws {
        guard let control = pendingCareSafe, centralConsumer.ownerPairingIdentity == control.identity,
              centralConsumer.ownerVoice.careControl == nil,
              centralConsumer.ownerVoice.careOutcome != nil || centralConsumer.ownerVoice.careError != nil else { return }
        try localDatabase?.markCompleted(operationID: control.controlID)
        careSafeStatus = centralConsumer.ownerVoice.careOutcome ?? "依米未接受“我没事”：\(centralConsumer.ownerVoice.careError!)"
        pendingCareSafe = nil
        publishSnapshot()
    }

    // MARK: hold-to-talk

    /// Hold-to-talk press `press` (an increasing id minted when the finger goes down): takes the microphone for one
    /// window and opens it. A release that arrived first, or during any await, wins and the press ends unrecorded.
    func pressVoiceTurn(_ press: UInt64,
                        startIntent: AssistantStartIntent = AssistantStartIntent(userInitiated: true)) async throws {
        guard press > releasedVoicePress, voicePress == nil else { throw AssistantSessionCoordinatorError.superseded }
        guard !centralConsumer.voiceTurn.isActive || centralConsumer.voiceTurn.phase == .ready else { throw CentralTextError.unavailable }
        voicePress = (press, false, nil)
        var operationID: String?
        do {
            try await ensureActive(startIntent)
            try requireVoicePress(press)
            // Pressing again over unsent candidates replaces them with a new window.
            if centralConsumer.voiceTurn.phase == .ready { try? await closeVoiceTurn() }
            try requireVoicePress(press)
            try await acquireMedia(.microphone, for: .voiceTurn)
            try requireVoicePress(press)
            let operation = "voice-" + UUID().uuidString.lowercased()
            operationID = operation
            voicePress = (press, false, operation)
            try await openVoiceTurn(operationID: operation)
            try requireVoicePress(press)
            voicePress = (press, true, operation)
        } catch {
            if voicePress?.id == press {
                voicePress = nil
                await closeOwnVoiceWindow(operationID: operationID)
            }
            settleVoiceMicrophone()
            throw error
        }
    }

    /// Closes a window this press opened (opening/recording) and leaves an earlier turn's send state untouched.
    private func closeOwnVoiceWindow(operationID: String?) async {
        if let operationID, centralConsumer.voiceTurn.operationID == operationID,
           [.opening, .recording].contains(centralConsumer.voiceTurn.phase) { try? await closeVoiceTurn() }
        settleVoiceMicrophone()
    }

    /// The finger lifted (or slid away to cancel). Before the window opened the press is cancelled outright; after
    /// it, cancel closes the window and a release commits it. Returns whether the window was committed.
    @discardableResult
    func releaseVoiceTurn(_ press: UInt64, cancel: Bool) async throws -> Bool {
        releasedVoicePress = max(releasedVoicePress, press)
        guard let current = voicePress, current.id == press else { return false }
        voicePress = nil
        guard current.open, !cancel else {
            await closeOwnVoiceWindow(operationID: current.operationID)
            return false
        }
        defer { settleVoiceMicrophone() }
        try await commitVoiceTurn()
        return true
    }

    private func requireVoicePress(_ press: UInt64) throws {
        try Task.checkCancellation()
        guard voicePress?.id == press, isActiveState else { throw AssistantSessionCoordinatorError.superseded }
    }

    /// The temporary hold-to-talk microphone closes as soon as no press is open and the window is no longer
    /// recording (cut, failed, closed): the send and its receipt never keep it open.
    private func settleVoiceMicrophone() {
        guard voicePress == nil, mediaHolders[.microphone]?.contains(.voiceTurn) == true,
              ![.opening, .recording, .committing].contains(centralConsumer.voiceTurn.phase) else { return }
        dropMediaHolder(.microphone, .voiceTurn)
    }

    // Push-to-talk over the published microphone: open/commit name the window, central cuts it.
    func openVoiceTurn(operationID: String = "voice-" + UUID().uuidString.lowercased()) async throws {
        let generation = centralConsumer.generation
        let bytes = try centralConsumer.beginVoice(operationID: operationID)
        try await publishVoiceRequest(bytes, operationID: operationID, generation: generation)
    }

    private func isCurrentVoiceTurn(_ operationID: String, generation: UInt64) -> Bool {
        centralConsumer.voiceTurn.operationID == operationID && centralConsumer.generation == generation
    }

    private func requireVoiceTurn(_ operationID: String, generation: UInt64) throws {
        try Task.checkCancellation()
        guard isCurrentVoiceTurn(operationID, generation: generation) else { throw AssistantSessionCoordinatorError.superseded }
    }

    private func cancelSupersededVoiceRelease() {
        guard let release = voiceRelease, !isCurrentVoiceTurn(release.operationID, generation: release.generation) else { return }
        release.task.cancel()
        voiceRelease = nil
    }

    private func publishVoiceRequest(_ bytes: Data, operationID: String, generation: UInt64) async throws {
        try await drainPendingCallClose()
        try requireVoiceTurn(operationID, generation: generation)
        let publisher = try centralPublisher(), binding = centralConsumer.binding!
        centralObserver?(centralConsumer)
        try await publisher.publishCentralTextData(bytes, binding: binding)
        try requireVoiceTurn(operationID, generation: generation)
    }

    /// Commits the window and waits for its outcome. It returns only once the turn is `ready` (a spoken transcript to
    /// send) or terminal; whatever else ends the wait fails the turn with its reason, so no exit leaves it waiting.
    func commitVoiceTurn() async throws {
        guard let operationID = centralConsumer.voiceTurn.operationID, voiceRelease == nil else { throw CentralTextError.unavailable }
        let generation = centralConsumer.generation
        let task = Task { try await finishVoiceTurn(operationID: operationID, generation: generation) }
        voiceRelease = (operationID, generation, task)
        defer {
            if voiceRelease?.operationID == operationID, voiceRelease?.generation == generation { voiceRelease = nil }
        }
        try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    private func finishVoiceTurn(operationID: String, generation: UInt64) async throws {
        defer { settleVoiceMicrophone() }
        do {
            try requireVoiceTurn(operationID, generation: generation)
            // Open must be acknowledged first; the trailing delay lets the last frames reach the reader.
            var waited = 0
            while centralConsumer.voiceTurn.phase == .opening && waited < 100 {
                try await voiceTurnSleep(50_000_000)
                try requireVoiceTurn(operationID, generation: generation)
                waited += 1
            }
            guard centralConsumer.voiceTurn.phase == .recording else { return try await expireVoiceTurn("VOICE_OPEN_TIMEOUT", operationID: operationID, generation: generation) }
            try await voiceTurnSleep(300_000_000)
            try requireVoiceTurn(operationID, generation: generation)
            try await publishVoiceRequest(centralConsumer.commitVoice(), operationID: operationID, generation: generation)
            let deadline = ContinuousClock.now.advanced(by: .seconds(30))
            while ContinuousClock.now < deadline {
                try await voiceTurnSleep(500_000_000)
                try requireVoiceTurn(operationID, generation: generation)
                settleVoiceMicrophone()
                switch centralConsumer.voiceTurn.phase {
                case .committing: continue
                case .transcribing:
                    // A poll the transport refused (e.g. right after the microphone is unpublished) is retried next tick.
                    do { try await publishVoiceRequest(centralConsumer.voiceCandidatesRequest(), operationID: operationID, generation: generation) }
                    catch is CancellationError { throw CancellationError() }
                    catch {
                        try requireVoiceTurn(operationID, generation: generation)
                        voiceTurnLog.error("PAIOS_VOICE_POLL_FAILED \(String(describing: error), privacy: .public)") }
                case .failed:
                    // A window that heard nothing is still open on central until it is closed.
                    if let bytes = try centralConsumer.voiceTurn.closeRequest() { try? await publishVoiceRequest(bytes, operationID: operationID, generation: generation) }
                    return
                default: return
                }
            }
            try await expireVoiceTurn(centralConsumer.voiceTurn.phase == .committing ? "VOICE_COMMIT_TIMEOUT" : "VOICE_TRANSCRIBE_TIMEOUT", operationID: operationID, generation: generation)
        } catch {
            voiceTurnLog.error("PAIOS_VOICE_COMMIT_FAILED \(String(describing: error), privacy: .public)")
            try? await expireVoiceTurn("VOICE_COMMIT_FAILED", operationID: operationID, generation: generation)
            throw error
        }
    }

    // Only a turn still waiting on central expires; a failed, ready or closed turn keeps its state.
    private func expireVoiceTurn(_ code: String, operationID: String, generation: UInt64) async throws {
        guard isCurrentVoiceTurn(operationID, generation: generation) else { return }
        let bytes = try centralConsumer.expireVoice(code)
        centralObserver?(centralConsumer)
        settleVoiceMicrophone()
        voiceTurnLog.error("PAIOS_VOICE_TURN_EXPIRED code=\(code, privacy: .public) sent_close=\(bytes != nil)")
        if let bytes {
            // Cancellation ends the wait, but its own close must still reach central with the same identity fence.
            let close = Task { try await publishVoiceRequest(bytes, operationID: operationID, generation: generation) }
            try? await close.value
        }
    }
    private let voiceTurnLog = Logger(subsystem: "ai.paios.personal.phase0", category: "voice")

    /// Sends the chosen transcript once and waits a bounded time for the D's admission (which proves it landed).
    /// Without it, the identical original packet is resent once; still nothing leaves the turn `unconfirmed`: terminal
    /// and visible, never a new event, and within this session retryable with the same bytes (retryVoiceSend).
    func sendVoiceTurn(_ candidate: CentralVoiceCandidate) async throws {
        try await ensureActive(AssistantStartIntent(locationEnabled: locationConsent, userInitiated: true))
        let publisher = try centralPublisher()
        let generation = activeGeneration
        guard let eventID = centralConsumer.voiceTurn.eventID else { throw CentralTextError.unavailable }
        if centralConsumer.binding?.voiceTransport == AssistantCentralTextWire.voiceTransport, try centralConsumer.canStartForegroundSubmission {
            do { try centralConsumer.cancelVoice() }
            catch { centralConsumer.reportWireFailure(error) }
            try await publisher.prepareCentralVoice(eventID: eventID)
            guard activeGeneration == generation else { throw CentralTextError.contextChanged() }
        }
        let data = try centralConsumer.sendVoice(candidate)
        if centralConsumer.binding?.voiceTransport == AssistantCentralTextWire.voiceTransport {
            try await publisher.observeCentralVoice(eventIDs: centralConsumer.observedVoiceEventIDs)
            guard activeGeneration == generation else { throw CentralTextError.contextChanged() }
        }
        centralObserver?(centralConsumer)
        settleVoiceMicrophone()
        try await deliverVoiceSend(data, eventID: eventID, attempts: 2)
    }

    /// Resends an unconfirmed turn's original voice_send unchanged (one more bounded attempt).
    func retryVoiceSend() async throws {
        _ = try centralPublisher()
        guard let eventID = centralConsumer.voiceTurn.eventID else { throw CentralTextError.unavailable }
        let data = try centralConsumer.resendVoice()
        centralObserver?(centralConsumer)
        try await deliverVoiceSend(data, eventID: eventID, attempts: 1)
    }

    /// Once the consumer owns the packet the turn reports the outcome; a session reset already ended it unconfirmed.
    private func deliverVoiceSend(_ data: Data, eventID: String, attempts: Int) async throws {
        let publisher = try centralPublisher()
        let generation = activeGeneration
        guard let binding = centralConsumer.binding else { throw CentralTextError.unavailable }
        func waiting() -> Bool { activeGeneration == generation && centralConsumer.voiceTurn.phase == .sending && centralConsumer.voiceTurn.eventID == eventID }
        for _ in 0..<attempts {
            // A failed publish may still have left: the outcome is unknown either way, so both wait the same.
            do { try await publisher.publishCentralTextData(data, binding: binding) } catch { }
            var waited: UInt64 = 0
            while waiting(), waited < voiceSendConfirmationWait {
                try await Task.sleep(nanoseconds: 50_000_000)
                waited += 50_000_000
            }
            guard waiting() else { return }
        }
        centralConsumer.voiceSendUnconfirmed()
        centralObserver?(centralConsumer)
    }

    func closeVoiceTurn() async throws {
        defer { settleVoiceMicrophone() }
        guard let bytes = try centralConsumer.closeVoice() else { centralObserver?(centralConsumer); return }
        try await publishCentralRequest(bytes)
    }

    func centralTextConsumed(_ presentation: CentralTextPresentation, observedAt: String) async throws {
        defer { scheduleCentralTextRecovery() }
        guard let bytes = try centralConsumer.consumedByUI(presentation, observedAt: observedAt) else { return }
        let publisher = try centralPublisher()
        centralObserver?(centralConsumer)
        try await publisher.publishCentralTextData(bytes, binding: presentation.binding)
    }

    func retryCentralRenderedACK() async throws {
        let publisher = try centralPublisher()
        let pending = centralConsumer.pendingRenderedACKs
        guard !pending.isEmpty else { throw CentralTextError.unavailable }
        let generation = activeGeneration
        let binding = centralConsumer.binding!
        for bytes in pending {
            guard activeGeneration == generation, centralConsumer.binding == binding,
                  textOwner == .centralCandidate else { throw CentralTextError.contextChanged() }
            try await publisher.publishCentralTextData(bytes, binding: binding)
        }
    }

    func bindCyclingWatchOrigin(
        _ binding: CyclingWatchOriginBinding?
    ) {
        cyclingWatchOriginBinding = binding
    }

    /// The user's location choice, applied to the running session at once: turning it off stops every further
    /// GPS request and drops a fix that is still in flight (the version fences it).
    @discardableResult
    nonisolated func setLocationConsent(_ enabled: Bool, replacing: UInt64? = nil) -> UInt64 {
        locationChoiceState.withLock { choice in
            if let replacing, choice.version != replacing { return choice.version }
            choice.enabled = enabled; choice.version &+= 1
            return choice.version
        }
    }

    nonisolated func locationChoice() -> (enabled: Bool, version: UInt64) { locationChoiceState.withLock { $0 } }
    nonisolated func acceptsLocation(_ version: UInt64) -> Bool { locationChoiceState.withLock { $0.enabled && $0.version == version } }

    /// A new fix of the phone (随身模式's feed, or one taken for a request) for central's per-device location authority,
    /// which locates calls and the wake turns heard on this phone. Only while sharing is on; a session that cannot
    /// publish drops it (the next fix goes instead).
    func reportLocation(_ fix: AssistantLocationObservation?, unavailable: AssistantLocationUnavailableReason? = nil,
                        consent: UInt64? = nil) async throws {
        guard acceptsLocation(consent ?? locationConsentVersion) else { return }
        let publisher = try centralPublisher()
        try await publisher.publishCentralTextData(AssistantCentralTextWire.locationUpdate(fix, unavailable: unavailable),
                                                   binding: centralConsumer.binding!)
    }

    private func acceptCameraRequest(_ packet: CentralTextPacket) async throws {
        guard let binding = centralConsumer.binding,
              try packet.fields.value("session_id", as: String.self) == binding.sessionID,
              let frameID = try packet.fields.value("frame_id", as: String.self),
              let expiresAt = try packet.fields.value("expires_at_ms", as: Int64.self) else { throw CentralTextError.invalidPacket }
        if cameraRequest?.frameID == frameID { return }
        let deadline = Date(timeIntervalSince1970: Double(expiresAt) / 1000)
        guard deadline > Date() else {
            try await cameraRequestFailed(frameID, code: "CAMERA_REQUEST_TIMEOUT")
            return
        }
        if cameraRequest != nil {
            try await cameraRequestFailed(frameID, code: "CAMERA_REQUEST_BUSY")
            return
        }
        cameraRequest = (frameID, try packet.fields.value("camera", as: String.self) ?? "back", deadline)
        cameraRequestUploaded = false
        cameraRequestExpiry = Task {
            do { try await Task.sleep(nanoseconds: UInt64(max(0, deadline.timeIntervalSinceNow) * 1_000_000_000)) } catch { return }
            self.cameraRequestExpiry = nil
            await self.endCameraRequest(code: "CAMERA_REQUEST_TIMEOUT")
        }
        if appActive { resumeCameraRequest() }
        else { try await cameraRequestFailed(frameID, code: "CAMERA_APP_INACTIVE") }
    }

    private func cameraRequestFailed(_ frameID: String, code: String) async throws {
        try await publishCentralRequest(AssistantCentralTextWire.encode("camera_capture_failed", fields: ["frame_id": frameID, "error_code": code]))
    }

    private func resumeCameraRequest() {
        guard appActive, state == .active(encryptionActive: true), encryptionActive,
              !cameraRequestVisible, let request = cameraRequest, Date() < request.deadline else { return }
        cameraRequestVisible = true
        publishSnapshot()
        cameraRequestTask = Task {
            do {
                guard let camera = realtime as? any AssistantCameraRequestTransport else { throw CentralTextError.unavailable }
                try await acquireMedia(.camera, for: .cameraRequest)
                try Task.checkCancellation()
                try await camera.captureRequestedFrame(frameID: request.frameID, camera: request.camera)
                guard cameraRequest?.frameID == request.frameID else { return }
                cameraRequestUploaded = true
            } catch is CancellationError { return }
            catch {
                guard cameraRequest?.frameID == request.frameID else { return }
                cameraRequestTask = nil
                await endCameraRequest(code: error as? MediaPermissionError == .cameraDenied ? "CAMERA_CAPTURE_UNAVAILABLE" : "CAMERA_CAPTURE_FAILED")
            }
        }
    }

    func endCameraRequest(code: String = "CAMERA_CAPTURE_CANCELLED", reportFailure: Bool = true) async {
        guard let request = cameraRequest else { return }
        let notify = reportFailure && !cameraRequestUploaded
        cameraRequest = nil; cameraRequestVisible = false
        cameraRequestTask?.cancel(); cameraRequestTask = nil
        cameraRequestExpiry?.cancel(); cameraRequestExpiry = nil
        dropMediaHolder(.camera, .cameraRequest)
        publishSnapshot()
        if notify {
            do { try await cameraRequestFailed(request.frameID, code: code) }
            catch { callFailure = Self.errorCode(error); publishSnapshot() }
        }
        await reconcileMedia(.camera).value
    }

    private func acceptLocationRequest(_ packet: CentralTextPacket, generation: UInt64) throws -> Bool {
        guard try packet.fields.value("operation", as: String.self) == "location_request" else { return false }
        guard let binding = centralConsumer.binding,
              try packet.fields.value("session_id", as: String.self) == binding.sessionID,
              let requestID = try packet.fields.value("request_id", as: String.self) else { throw CentralTextError.invalidPacket }
        let consent = locationConsentVersion
        Task { [weak self] in
            await self?.respondToLocationRequest(requestID, binding: binding, generation: generation, consent: consent)
        }
        return true
    }

    /// What stops a fix right now: the user's sharing choice, then the system permission; nil when a fix may be taken.
    private func locationBlock(_ consent: UInt64) async -> AssistantLocationUnavailableReason? {
        if !acceptsLocation(consent) { return .sharingOff }
        return AssistantLocationUnavailableReason.blocking(await locationService.authorizationStatus())
    }

    private func respondToLocationRequest(_ requestID: String, binding: CentralTransportBinding,
                                         generation: UInt64, consent: UInt64) async {
        var fix: AssistantLocationObservation?
        var reason = await locationBlock(consent)
        if reason == nil, isCurrentGeneration(generation), centralConsumer.binding == binding {
            do { fix = try await locationService.requestOneShot(userInitiated: false) }
            catch { reason = AssistantLocationUnavailableReason(error) }
        }
        guard isCurrentGeneration(generation), centralConsumer.binding == binding else { return }
        let cachedAge = fix == nil && acceptsLocation(consent) ? await locationService.cachedFixAgeMilliseconds() : nil
        if let blocked = await locationBlock(consent) { fix = nil; reason = blocked }
        guard isCurrentGeneration(generation), centralConsumer.binding == binding else { return }
        do {
            let publisher = try centralPublisher()
            try await publisher.publishCentralTextData(
                AssistantCentralTextWire.locationUpdate(fix, requestID: requestID, unavailable: reason,
                    cachedFixAgeMs: acceptsLocation(consent) ? cachedAge : nil), binding: binding)
        } catch {
            #if DEBUG
            print("PAIOS_LOCATION_RESPONSE_FAILED error=\(String(reflecting: error))")
            #endif
        }
    }

    func watchPairingChanged() {
        cyclingWatchOriginBinding = nil
        moveSession.loseWatch()
        moveSession.clearFeedback()
        publishSnapshot()
    }

    /// Apply local workout state before any transport await. Start/end messages stay ordered
    /// independently, so an end during connection startup stops sensors immediately.
    func handleCyclingMetric(_ next: WatchCyclingMetricEnvelope) async {
        do { try restoreMoveCheckpoint() } catch { reportMoveFailure(error); await moveSensors?.stop(); return }
        if next.workoutState == .failed {
            reportMoveFailure(CentralTextError.unavailable)
            return
        }
        do { try applyMoveEvents { $0.watchMetric(next, at: Date()) } }
        catch {
            reportMoveFailure(error)
            await updateMoveSensors()
            if next.workoutState == .started, moveSession.watchWorkoutID != next.workoutID {
                Task { await self.stopWatchRide(workoutID: next.workoutID) }
            }
            return
        }
        let needsWatchStop = next.workoutState == .started && moveSession.watchWorkoutID != next.workoutID
        await updateMoveSensors()
        if needsWatchStop { Task { await self.stopWatchRide(workoutID: next.workoutID) } }
        publishMoveStates()
    }

    private func watchRideMetrics() -> WatchYimiRideMetrics? {
        guard let state = moveSession.lastRideState else { return nil }
        let metrics = moveSession.ride?.metrics(at: Date(), cadence: nil)
        let summary = state.summary
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return WatchYimiRideMetrics(ride_id: state.ride_id,
            workout_id: moveSession.watchWorkoutID ?? moveSession.lastRideWorkoutID, ended: summary != nil,
            speed_kmh: metrics?.speed_kmh, avg_kmh: metrics?.avg_kmh ?? summary!.avg_kmh,
            max_kmh: metrics?.max_kmh ?? summary!.max_kmh, distance_m: metrics?.distance_m ?? summary!.distance_m,
            elapsed_s: metrics?.elapsed_s ?? summary!.elapsed_s,
            moving_s: metrics?.moving_s ?? summary!.moving_s, hr_bpm: metrics?.hr_bpm,
            hr_avg: summary?.hr_avg, hr_max: summary?.hr_max, kcal: metrics?.kcal ?? summary?.kcal,
            elev_gain_m: metrics?.elev_gain_m ?? summary?.elev_gain_m,
            hr_sample_at: (metrics?.hr_sample_at).map { formatter.string(from: $0) },
            speed_sample_at: (metrics?.speed_sample_at).map { formatter.string(from: $0) })
    }

    private var moveSession = MoveSession()
    private var moveSessionOwner: String?
    private var moveCheckpointLoaded = false

    private func restoreMoveCheckpoint() throws {
        let identity = try careIdentity()?.identity
        guard !moveCheckpointLoaded || moveSessionOwner != identity else { return }
        moveCheckpointLoaded = false
        moveSessionOwner = nil
        moveSession = MoveSession()
        moveEventQueue.removeAll { $0.identity != identity }
        let restored = try identity.flatMap { try localDatabase?.moveCheckpoint(identity: $0) }
            .map { try MoveSession(checkpoint: $0) } ?? MoveSession()
        let pending = try identity.flatMap { try localDatabase?.pendingMoveEvents(identity: $0) } ?? []
        let ids = Set(moveEventQueue.map(\.id))
        moveEventQueue.insert(contentsOf: pending.filter { !ids.contains($0.id) }, at: 0)
        moveSession = restored
        moveSessionOwner = identity
        moveCheckpointLoaded = true
    }
    private func saveMoveCheckpoint() throws {
        guard let identity = try careIdentity()?.identity, identity == moveSessionOwner else { return }
        let pending = moveEventQueue.filter { $0.identity == identity }
        if pending.isEmpty { try localDatabase?.saveMoveCheckpoint(data: moveSession.checkpoint(), identity: identity) }
        else { try localDatabase?.preserveMoveEvents(pending, checkpoint: moveSession.checkpoint()) }
    }
    func handleCyclingWorkoutSnapshot(_ snapshot: WatchCyclingWorkoutSnapshot, identity: String) async {
        do {
            guard try careIdentity()?.identity == identity else { throw CentralTextError.contextChanged() }
            try restoreMoveCheckpoint()
            try applyMoveEvents { $0.reconcileWatchWorkout(snapshot, at: Date()) }
            try saveMoveCheckpoint()
            await updateMoveSensors()
            publishMoveStates()
        } catch { reportMoveFailure(error); await moveSensors?.stop() }
    }

    func watchBecameUnreachable() { moveSession.loseWatch() }

    private func acceptMoveRequest(_ packet: CentralTextPacket) async throws -> Bool {
        guard let operation = try packet.fields.value("operation", as: String.self),
              ["ride_control", "nav_route", "nav_control", "ride_feedback", "move_ack"].contains(operation) else { return false }
        guard let binding = centralConsumer.binding,
              try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.invalidPacket }
        if operation == "move_ack" {
            let id = try packet.fields.value("lifecycle_id", as: String.self)!
            let identity = try careIdentity()?.identity
            guard let pending = moveEventQueue.first(where: { $0.id == id }), pending.identity == identity else { return true }
            if let identity { try localDatabase?.acknowledgeMoveEvent(id: id, identity: identity) }
            moveEventQueue.removeAll { $0.id == id }
            if moveEventQueue.isEmpty { moveEventRetry?.cancel(); moveEventRetry = nil }
            else { publishMoveStates() }
            publishSnapshot()
            return true
        }
        if operation == "ride_feedback" {
            let feedback = try JSONDecoder().decode(CentralRideFeedback.self, from: packet.bytes)
            if moveSession.acceptFeedback(feedback) { publishSnapshot() }
            return true
        }
        try restoreMoveCheckpoint()
        var nextMove = moveSession
        var events: [MoveEvent] = []
        var stopWatchID: String?
        var startWatchAt: Date?
        switch operation {
        case "ride_control":
            if try packet.fields.value("action", as: String.self) == "start" {
                events = nextMove.startRide(by: try packet.fields.value("requested_by", as: String.self)!, at: Date())
                if !events.isEmpty {
                    startWatchAt = nextMove.ride!.startedAt
                }
            } else {
                stopWatchID = nextMove.watchWorkoutID
                events = nextMove.endRide(at: Date())
            }
        case "nav_route":
            events = nextMove.follow(try JSONDecoder().decode(NavRoute.self, from: packet.bytes), at: Date())
        default:
            if try packet.fields.value("nav_id", as: String.self) == nextMove.navigation?.route.nav_id {
                events = nextMove.stopNavigation(at: Date())
            }
        }
        do { try commitMoveEvents(events, next: nextMove) }
        catch {
            await updateMoveSensors()
            if let stopWatchID { Task { await self.stopWatchRide(workoutID: stopWatchID) } }
            throw error
        }
        await updateMoveSensors()
        if let startWatchAt { Task { [weak self] in await self?.launchWatchRide(startedAt: startWatchAt) } }
        if let stopWatchID { Task { await self.stopWatchRide(workoutID: stopWatchID) } }
        publishMoveStates()
        return true
    }
    private func updateMoveSensors() async {
        if !moveSession.isActive {
            await moveSensors?.stop()
            do { try saveMoveCheckpoint() } catch { reportMoveFailure(error) }
            return
        }
        do { try saveMoveCheckpoint() } catch { reportMoveFailure(error); return }
        await moveSensors?.start(ride: moveSession.ride != nil) { [weak self] event in await self?.handleMoveSensor(event) }
    }
    func handleMoveSensor(_ event: MoveSensorEvent) async {
        do { try restoreMoveCheckpoint() } catch { reportMoveFailure(error); await moveSensors?.stop(); return }
        guard moveSession.isActive else { await moveSensors?.stop(); return }
        switch event {
        case .fix(let fix):
            guard Date().timeIntervalSince(fix.at) <= 5 else { return }
            do { try applyMoveEvents { $0.observe(fix) } } catch { reportMoveFailure(error); await updateMoveSensors(); return }
        case .altitude(let altitude): moveSession.recordAltitude(altitude)
        case .tick(let at):
            let cadence = await moveSensors?.estimatedCadence(speedKmh: moveSession.ride?.speedKmh ?? 0)
            if let frame = moveSession.frame(at: at, cadence: cadence) {
                do { try await publishCentralRequest(AssistantCentralTextWire.move(frame), identity: moveSessionOwner) }
                catch { reportMoveFailure(error) }
            }
        case .failure(let error, let location):
            if location { moveSession.loseFix() }; reportMoveFailure(error)
        }
        await updateMoveSensors()
        publishMoveStates()
    }
    private func applyMoveEvents(_ mutate: (inout MoveSession) -> [MoveEvent]) throws {
        var next = moveSession
        let events = mutate(&next)
        try commitMoveEvents(events, next: next)
    }
    private func commitMoveEvents(_ events: [MoveEvent], next: MoveSession) throws {
        let identity = try careIdentity()?.identity
        guard identity == moveSessionOwner else { throw CentralTextError.contextChanged() }
        let records = try events.map { try MoveLifecycleRecord(event: $0, identity: identity, sourceSession: centralConsumer.binding?.sessionID) }
        let terminalSlots = (next.ride == nil ? 0 : 1) + (next.navigation == nil ? 0 : 1)
        guard moveEventQueue.count + records.count + terminalSlots <= 256 else { throw CentralTextError.unavailable }
        moveSession = next
        moveEventQueue += records
        do { try localDatabase?.preserveMoveEvents(moveEventQueue, checkpoint: next.checkpoint()) }
        catch { scheduleMoveRetry(); throw error }
    }
    private func publishMoveStates() {
        publishSnapshot()
        guard !moveEventDrainActive else { return }
        moveEventDrainActive = true
        Task {
            defer {
                moveEventDrainActive = false
                scheduleMoveRetry()
            }
            do {
                try restoreMoveCheckpoint()
                let identity = try careIdentity()?.identity
                if let identity, let localDatabase {
                    let restored = try localDatabase.pendingMoveEvents(identity: identity)
                    let ids = Set(moveEventQueue.map(\.id))
                    moveEventQueue.insert(contentsOf: restored.filter { !ids.contains($0.id) }, at: 0)
                }
                // A changed pairing never replays another owner's outbox on the new session.
                let pending = moveEventQueue.filter { $0.identity == identity }
                guard !pending.isEmpty else { return }
                try localDatabase?.preserveMoveEvents(pending, checkpoint: moveSession.checkpoint())
                await updateMoveSensors()
                if !isActiveState { try await ensureActive(AssistantStartIntent(userInitiated: true)) }
                for record in pending {
                    guard try careIdentity()?.identity == record.identity else { throw CentralTextError.contextChanged() }
                    guard moveEventQueue.contains(where: { $0.id == record.id }) else { continue }
                    try await publishCentralRequest(record.bytes, identity: record.identity)
                    if moveEventQueue.contains(where: { $0.id == record.id }) { break }
                }
            } catch { reportMoveFailure(error) }
        }
    }
    private func scheduleMoveRetry() {
        guard moveEventRetry == nil, !moveEventQueue.isEmpty else { return }
        moveEventRetry = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            guard let self else { return }
            await self.retryMoveEvents()
        }
    }
    private func retryMoveEvents() {
        moveEventRetry = nil
        publishMoveStates()
    }
    private func reportMoveFailure(_ error: Error) {
        Logger(subsystem: "ai.paios.personal.phase0", category: "move").error("Move session failed: \(String(describing: error))")
    }
    private func launchWatchRide(startedAt: Date) async {
        guard moveSession.ride?.startedAt == startedAt else { return }
        #if os(iOS)
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .cycling; configuration.locationType = .outdoor
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                HKHealthStore().startWatchApp(with: configuration) { success, error in
                    if let error { continuation.resume(throwing: error) }
                    else if success { continuation.resume() }
                    else { continuation.resume(throwing: CentralTextError.unavailable) }
                }
            }
        } catch { reportMoveFailure(error) }
        #endif
    }
    private func stopWatchRide(workoutID: String) async {
        guard let watchControl else { return }
        let command = AssistantCyclingControlCommand(action: .stop, requestID: UUID().uuidString.lowercased(), sequence: 1, workoutID: workoutID)
        _ = await watchControl.sendCyclingControl(command)
    }

    func handleNetworkPath(_ path: AssistantNetworkPathState) async {
        guard path.status != .satisfied else {
            if pendingCallClose != nil, callCloseReconciliation, let generation = activeGeneration {
                beginTransportRecovery(generation: generation)
            }
            if isActiveState {
                do { try await reconcileVideoOff() }
                catch { callFailure = ComponentVideoFailureCode.stopFailed.rawValue; publishSnapshot() }
            }
            publishMoveStates()
            if moveSession.isActive || navigationStandby {
                do { try await ensureActive(AssistantStartIntent(locationEnabled: locationConsent, userInitiated: true)) }
                catch { reportMoveFailure(error) }
            }
            return
        }
        switch state {
        case .connecting, .active, .reconnecting:
            guard retainsSession(for: "network_unavailable") else {
                _ = await stop(reasonCode: "network_unavailable"); return
            }
            // Retained call/continuous capture uses the existing transport recovery owner.
            await detachVideoForConnectionLoss()
        default:
            return
        }
    }

    func handleLifecycleSignal(
        _ signal: AssistantMediaLifecycleSignal
    ) async {
        switch signal {
        case .appDidEnterBackground:
            appActive = false
            if cameraRequestVisible { await endCameraRequest() }
            if independentCallCamera {
                callCameraWanted = false
                await releaseMedia(.camera, for: .call)
            }
            if centralConsumer.call.isActive, videoCallRequested {
                do { try await setCallVideo(false) } catch { callFailure = Self.errorCode(error); publishSnapshot() }
            } else {
                // A pending dial opens as voice after foreground; an existing voice call needs no server mode action.
                videoCallRequested = false; callCameraWanted = false
                dropMediaHolder(.camera, .call)
            }
            if retainsSession(for: "app_background") { return }
            _ = await stop(reasonCode: "app_background")
        case .incomingCall, .audioRouteChanged:
            if centralConsumer.ownerVoice.enrollment.phase == .collecting {
                do { try await voiceEnrollmentControl("pause") } catch { callFailure = Self.errorCode(error); publishSnapshot() }
            }
        case .audioInterruptionBegan:
            if centralConsumer.ownerVoice.enrollment.phase == .collecting {
                do { try await voiceEnrollmentControl("pause") } catch { callFailure = Self.errorCode(error); publishSnapshot() }
            }
            if wakeWanted {
                do { try wakeListening.stop(captureInUse: true) } catch { wakeFailure = Self.errorCode(error) }
                wakePhase = .unavailable; publishSnapshot()
            }
            if retainsSession(for: "audio_interruption") { return }
            _ = await stop(reasonCode: "audio_interruption")
        case .networkPath(let path):
            await handleNetworkPath(path)
        case .appBecameActive:
            setAppActive(true)
        case .audioInterruptionEnded(let shouldResume):
            if shouldResume, wakeWanted {
                do { try await setWakeEnabled(true) }
                catch { wakeFailure = Self.errorCode(error); publishSnapshot() }
            }
            return
        }
    }

    func start(_ intent: AssistantStartIntent) async throws {
        try await beginStart(intent).value
    }

    private func beginStart(_ intent: AssistantStartIntent) throws -> Task<Void, Error> {
        guard sessionStart == nil else { throw AssistantSessionCoordinatorError.alreadyRunning }
        let admissionGeneration = generationCounter
        let id = UUID()
        sessionStartID = id
        let task = Task {
            defer { if self.sessionStartID == id { self.sessionStart = nil; self.sessionStartID = nil } }
            do { try await self.performStart(intent, admissionGeneration: admissionGeneration) }
            catch {
                if self.sessionStartID == id { self.completeConnectionWaiters(error) }
                throw error
            }
        }
        sessionStart = task
        return task
    }

    /// Launch, foreground, a call and a submitted message share the coordinator's one connection attempt.
    func ensureActive(_ intent: AssistantStartIntent) async throws {
        if isActiveState { return }
        if pendingCallClose != nil, callCloseReconciliation, let generation = activeGeneration { beginTransportRecovery(generation: generation) }
        if sessionStart == nil, state.canStart { _ = try beginStart(intent) }
        if sessionStart != nil || [.reconnecting, .encryptionPreparing, .connecting].contains(state) {
            try await withCheckedThrowingContinuation { connectionWaiters.append($0) }
        }
        guard isActiveState else { throw AssistantSessionCoordinatorError.notActive }
    }

    private func performStart(_ intent: AssistantStartIntent, admissionGeneration: UInt64) async throws {
        await restorePendingStopIfNeeded()
        guard admissionGeneration == generationCounter else { throw AssistantSessionCoordinatorError.superseded }
        guard !pendingStopRecoveryFailed else {
            throw AssistantBootstrapError.remoteStopUnconfirmed
        }
        guard state.canStart else {
            throw AssistantSessionCoordinatorError.alreadyRunning
        }
        guard intent.userInitiated else {
            throw AssistantSessionCoordinatorError.requestWasNotUserInitiated
        }

        generationCounter &+= 1
        let generation = generationCounter
        activeGeneration = generation
        connectionEpochCounter &+= 1
        activeConnectionEpoch = connectionEpochCounter
        activeLogicalSessionID =
            "assistant-logical-session-" + String(connectionEpochCounter)
        activeIntent = intent
        await paymentChannel.detach()
        try requireCurrentGeneration(generation)
        activeDetails = nil
        resetMedia(reason: nil)
        mediaRevokedReason = nil
        setLocationConsent(intent.locationEnabled, replacing: 0)
        pendingPromptGenerations.removeAll(keepingCapacity: true)
        completedPromptGenerations.removeAll(keepingCapacity: true)
        moveSession.clearFeedback()
        do { try centralConsumer.reset(binding: nil, generation: generationCounter) }
        catch { centralConsumer.reportWireFailure(error) }
        centralObserver?(centralConsumer)
        cyclingControlLedger.reset()
        lastStopResult = nil
        encryptionActive = false
        encryptionFailureCode = nil
        transition(.requestingPermissions)

        do {
            if intent.microphoneEnabled {
                _ = try await mediaPermissions.authorize(
                    source: .microphone,
                    userInitiated: true
                )
                try requireCurrentGeneration(generation)
            }
            if intent.cameraEnabled {
                _ = try await mediaPermissions.authorize(
                    source: .camera,
                    userInitiated: true
                )
                try requireCurrentGeneration(generation)
            }
            if locationConsent {
                // Location only enriches requests: a refusal shares nothing and never blocks the session.
                let consent = locationConsentVersion
                let status = try? await locationService
                    .requestWhenInUseAuthorization(userInitiated: true)
                try requireCurrentGeneration(generation)
                if status != .authorized { setLocationConsent(false, replacing: consent) }
            }

            transition(.bootstrapping)
            let sessionOwner = try careIdentity()
            let bootstrapTask = beginBootstrapTask(
                intent: intent,
                generation: generation
            )
            let details: AssistantConnectionDetails
            do {
                details = try await bootstrapTask.value
            } catch {
                clearBootstrapTaskIfCurrent(generation: generation)
                throw error
            }
            clearBootstrapTaskIfCurrent(generation: generation)
            try requireCurrentGeneration(generation)
            guard Self.isValid(details) else {
                throw AssistantSessionCoordinatorError
                    .invalidConnectionDetails
            }
            // The provider returns only after authoritative bootstrap acceptance has superseded the old Stop.
            pendingStopContext = nil
            activeDetails = details
            let sourceCentralBinding = try await bootstrapProvider.centralTransportBinding()
            // The gateway names the text transport in its bootstrap response; the device follows it (a local
            // choice could only contradict the server and fail every Start).
            textOwner = sourceCentralBinding != nil ? .centralCandidate : .legacy
            let centralBinding = sourceCentralBinding
            try requireCurrentGeneration(generation)
            guard try careIdentity()?.identity == sessionOwner?.identity,
                  sessionOwner == nil || centralBinding?.deviceID == sessionOwner?.deviceID else {
                throw CentralTextError.contextChanged()
            }
            moveSession.clearFeedback()
            try centralConsumer.reset(binding: centralBinding, generation: generationCounter, ownerPairingIdentity: sessionOwner?.identity)
            terminalState.bindOwner(sessionOwner?.identity)
            terminalObserver?(terminalState)
            centralObserver?(centralConsumer)

            transition(.encryptionPreparing)
            transition(.connecting)
            let ingress = openRealtimeEvents(generation: generation)
            do {
                try await realtime.connect(
                    AssistantRealtimeConnectRequest(
                        details: details,
                        intent: intent,
                        autoSubscribe: true,
                        centralBinding: centralBinding,
                        retainsLogicalCall: ringing || centralConsumer.call.isActive
                    )
                ) { event in ingress.yield(event) }
            } catch {
                guard isCurrentGeneration(generation), textOwner == .centralCandidate,
                      LiveKitSessionAdapter.isTransientConnectionFailure(error),
                      isActiveState || state == .reconnecting || transportRecovery != nil || centralBinding?.deviceClass == "mac" else { throw error }
                // Mac launch also recovers its accepted bootstrap before the first room activation.
                // Keep the accepted binding; then continue the requested media setup after recovery.
                if transportRecovery == nil { await handleRealtimeEvent(.disconnected(errorCode: "network"), generation: generation) }
                if !isActiveState {
                    try await withCheckedThrowingContinuation { connectionWaiters.append($0) }
                }
                try requireCurrentGeneration(generation)
                guard isActiveState else { throw AssistantSessionCoordinatorError.notActive }
            }
            try requireCurrentGeneration(generation)
            try await waitForEncryptionActive(generation: generation)

            // Media named by an explicit start intent is held by a call like any later acquisition (the app's own
            // starts are media-free control connections).
            if intent.microphoneEnabled {
                try await realtime.setMedia(
                    source: .microphone,
                    enabled: true,
                    userInitiated: true,
                    keepPublished: false
                )
                try requireCurrentGeneration(generation)
                mediaHolders[.microphone, default: []].insert(.call)
                mediaPublished.insert(.microphone)
            }
            if intent.cameraEnabled {
                try await realtime.setMedia(
                    source: .camera,
                    enabled: true,
                    userInitiated: true,
                    keepPublished: false
                )
                try requireCurrentGeneration(generation)
                mediaHolders[.camera, default: []].insert(.call)
                mediaPublished.insert(.camera)
            }

            switch state {
            case .connecting, .encryptionPreparing:
                transition(.active(encryptionActive: true))
                publishMoveStates()
            default:
                break
            }
            await attachPaymentChannel()
            try requireCurrentGeneration(generation)
            await record(
                operationID: intent.operationID,
                kind: .start,
                localCleanup: false,
                remoteConfirmed: false,
                status: "connected",
                remoteReference: nil
            )
            try requireCurrentGeneration(generation)
            // 随身模式 is the one standing media choice: a running session holds the microphone for it. A refusal leaves
            // the session running and shows the choice as paused.
            if ambientWanted { try? await applyAmbient() }
        } catch {
            guard isCurrentGeneration(generation) else {
                throw AssistantSessionCoordinatorError.superseded
            }
            await cleanupAfterFailedStart(generation: generation)
            guard isCurrentGeneration(generation) else {
                throw AssistantSessionCoordinatorError.superseded
            }
#if DEBUG
            // DEBUG console only: the exact start failure (typed error, never credentials) for device bring-up.
            print("PAIOS_SESSION_START_FAILED code=\(Self.errorCode(error)) error=\(String(reflecting: error))")
#endif
            transition(.failed(code: Self.errorCode(error)))
            throw error
        }
    }

    @discardableResult
    func stop(reasonCode: String = "user_stop") async
        -> AssistantRemoteStopResult {
        if ["user_stop", "pairing_changed", "desktop_unpaired"].contains(reasonCode), let dial, dial.generation == nil { self.dial = nil }
        if wakeWanted, ["user_stop", "pairing_changed", "desktop_unpaired"].contains(reasonCode) { try? await setWakeEnabled(false) }
        if state.canStart, pendingStopRestoration != nil || sessionStart != nil {
            generationCounter &+= 1
            callGeneration &+= 1
            voicePress = nil
        }
        if let task = inFlightStop {
            let result = await task.value
            finishStopOperationIfNeeded()
            return result
        }
        if case .stopped = state, let lastStopResult {
            return lastStopResult
        }
        if case .failed = state, let lastStopResult {
            return lastStopResult
        }
        if case .idle = state {
            let result = AssistantRemoteStopResult(
                confirmed: false,
                opaqueReference: nil
            )
            lastStopResult = result
            return result
        }
        if case .stopping = state {
            return lastStopResult ?? AssistantRemoteStopResult(
                confirmed: false,
                opaqueReference: nil
            )
        }

        let task = beginStopOperation(
            reasonCode: reasonCode,
            finalization: .stopped
        )
        let result = await task.value
        finishStopOperationIfNeeded()
        return result
    }

    // Explicit user reconciliation retries the original operation, never a new
    // start/Stop identity. Production provider retains exact canonical bytes.
    func retryPendingStop() async -> AssistantRemoteStopResult {
        await restorePendingStopIfNeeded(explicitRetry: true)
        if let task = inFlightStop { return await task.value }
        guard let context = pendingStopContext else {
            return lastStopResult ?? AssistantRemoteStopResult(confirmed: false, opaqueReference: nil)
        }
        transition(.stopping)
        let task = Task { [bootstrapProvider] in
            (try? await bootstrapProvider.stop(context))
                ?? AssistantRemoteStopResult(confirmed: false, opaqueReference: nil)
        }
        inFlightStop = task
        let response = await task.value
        let result = AssistantRemoteStopResult(
            confirmed: response.confirmed,
            opaqueReference: response.opaqueReference ?? lastStopResult?.opaqueReference
        )
        inFlightStop = nil
        lastStopResult = result
        if result.confirmed { pendingStopContext = nil }
        await record(operationID: context.operationID, kind: .stop,
                     localCleanup: true, remoteConfirmed: result.confirmed,
                     status: result.confirmed ? "cleanup_complete" : "remote_stop_unconfirmed",
                     remoteReference: result.opaqueReference)
        transition(.stopped(remoteStopConfirmed: result.confirmed))
        return result
    }

    func submitPrompt(_ prompt: AssistantPromptEnvelope, location: AssistantLocationObservation? = nil, consent: UInt64? = nil,
                      retained: AssistantRetainedPrompt? = nil, question: AssistantQuestionSelection? = nil) async throws {
        defer { scheduleCentralTextRecovery() }
        let locationVersion = consent ?? locationConsentVersion
        try await ensureActive(AssistantStartIntent(locationEnabled: locationConsent, userInitiated: true))
        if let retained {
            guard textOwner == .centralCandidate, retained.identity == centralConsumer.ownerPairingIdentity,
                  retained.eventID == prompt.promptID, retained.text == prompt.text else { throw CentralTextError.contextChanged() }
        }
        if textOwner == .centralCandidate {
            let publisher = try centralPublisher()
            let generation = activeGeneration
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if centralConsumer.binding?.voiceTransport == AssistantCentralTextWire.voiceTransport, try centralConsumer.canStartForegroundSubmission {
                do { try centralConsumer.cancelVoice() }
                catch { centralConsumer.reportWireFailure(error) }
                try await publisher.prepareCentralVoice(eventID: prompt.promptID)
                guard activeGeneration == generation else { throw CentralTextError.contextChanged() }
            }
            if let question {
                try requireOwner(question.identity)
                guard let card = centralConsumer.ownerVoice.questionCard,
                      try question.text(for: card, now: Date()) == prompt.text else { throw CentralTextError.contextChanged() }
            }
            let data = try centralConsumer.beginSubmit(eventID: prompt.promptID,
                capturedAt: retained?.capturedAt ?? formatter.string(from: Date()), text: prompt.text,
                location: retained != nil ? retained?.location?.observation : (acceptsLocation(locationVersion) ? location : nil), attachments: prompt.attachments)
            if centralConsumer.binding?.voiceTransport == AssistantCentralTextWire.voiceTransport {
                try await publisher.observeCentralVoice(eventIDs: centralConsumer.observedVoiceEventIDs)
                guard activeGeneration == generation else { throw CentralTextError.contextChanged() }
            }
            centralObserver?(centralConsumer)
            try await publisher.publishCentralTextData(data, binding: centralConsumer.binding!)
            guard activeGeneration == generation else { throw CentralTextError.contextChanged() }
            return
        }
        if question != nil { throw CentralTextError.unavailable }
        guard case .active(let stateEncryptionActive) = state,
              stateEncryptionActive,
              encryptionActive
        else {
            throw AssistantSessionCoordinatorError.notActive
        }
        guard let generation = activeGeneration,
              activeDetails?.capabilities.canPublishData == true,
              let publisher = realtime
                as? any AssistantRealtimePromptPublishing
        else {
            throw LiveKitSessionError.dataNotGranted
        }
        guard pendingPromptGenerations[prompt.promptID] == nil else {
            throw AssistantSessionCoordinatorError.alreadyRunning
        }

        pendingPromptGenerations[prompt.promptID] = generation
        do {
            try await publisher.publishPrompt(prompt)
            try requireCurrentGeneration(generation)
        } catch {
            pendingPromptGenerations.removeValue(forKey: prompt.promptID)
            throw error
        }
    }

    private func openRealtimeEvents(generation: UInt64) -> AssistantRealtimeEventIngress {
        closeRealtimeEvents()
        let ingress = AssistantRealtimeEventIngress(capacity: realtimeEventCapacity)
        realtimeEventIngress = ingress
        realtimeEventTask = Task { [weak self] in
            for await event in ingress.stream {
                ingress.didDequeue(event)
                guard !Task.isCancelled else { break }
                await self?.consumeRealtimeEvent(event, ingress: ingress, generation: generation)
            }
        }
        return ingress
    }

    private func consumeRealtimeEvent(_ event: AssistantRealtimeEvent,
        ingress: AssistantRealtimeEventIngress, generation: UInt64) async {
        guard isCurrentGeneration(generation), realtimeEventIngress === ingress else { return }
        if ingress.takeOverflow() {
            if textOwner == .legacy {
                await terminalFailure(generation: generation, code: "realtime_event_queue_overflow",
                    reasonCode: "realtime_event_queue_overflow", receiptStatus: "realtime_event_queue_overflow")
                return
            }
            centralConsumer.requireExplicitReread()
            centralObserver?(centralConsumer)
        }
        await handleRealtimeEvent(event, generation: generation)
    }

    private func closeRealtimeEvents() {
        realtimeEventIngress?.close()
        realtimeEventIngress = nil
        realtimeEventTask?.cancel()
        realtimeEventTask = nil
    }

    private func handleRealtimeEvent(
        _ event: AssistantRealtimeEvent,
        generation: UInt64
    ) async {
        guard isCurrentGeneration(generation) else {
            return
        }
        guard canHandleRealtimeEvent else {
            return
        }

        switch event {
        case .connected:
            switch state {
            case .connecting, .encryptionPreparing:
                transition(.encryptionPreparing, reason: "sdk_connected")
            default:
                return
            }
        case .callRejoinBudget(let deadline):
            guard recoveryCallID != nil || ringing else { return }
            pendingCallClose?.sentRevision = nil
            encryptionActive = false
            transition(.reconnecting, reason: "call_rejoin_budget")
            await acceptCallRecoveryBudget(estimate: deadline,
                announced: callRecoveryBudget == nil ? centralConsumer.call.rejoinDeadline : nil)
            guard isCurrentGeneration(generation) else { return }
            await paymentChannel.detach()
        case .reconnecting, .resuming:
            switch state {
            case .active, .reconnecting, .connecting, .encryptionPreparing:
                // Fence recovery before OFF publication or media cleanup can suspend this event.
                pendingCallClose?.sentRevision = nil
                encryptionActive = false
                transition(.reconnecting, reason: event == .resuming ? "sdk_resuming" : "sdk_reconnecting")
            default:
                return
            }
            await freezeCallLossDeadline()
            scheduleCallRecoveryExpiry(generation: generation)
            await paymentChannel.detach()
            guard isCurrentGeneration(generation) else { return }
            await detachVideoForConnectionLoss()
            do { try centralConsumer.cancelVoice() }
                catch { centralConsumer.reportWireFailure(error) }
        case .reconnected:
            switch state {
            case .reconnecting, .active:
                encryptionActive = false
                transition(.encryptionPreparing, reason: "sdk_reconnected")
            default:
                return
            }
            await paymentChannel.detach()
            guard isCurrentGeneration(generation) else { return }
        case .encryptionPreparing:
            switch state {
            case .active where encryptionActive:
                return
            case .encryptionPreparing, .connecting, .active:
                transition(.encryptionPreparing, reason: "e2ee_preparing")
            default:
                return
            }
        case .encryptionActive:
            let recovery = callRecoveryRevision
            encryptionActive = true
            if pendingCallClose != nil {
                do { try await drainPendingCallClose() }
                catch { centralConsumer.reportWireFailure(error) }
                guard isCurrentGeneration(generation), encryptionActive, callRecoveryRevision == recovery else { return }
            }
            callRecoveryExpiry?.cancel(); callRecoveryExpiry = nil
            callRecoveryBudget = nil
            centralConsumer.setCallRejoinDeadline(nil)
            encryptionActive = true
            encryptionFailureCode = nil
            switch state {
            case .encryptionPreparing, .connecting, .active, .reconnecting:
                transition(.active(encryptionActive: true), reason: "e2ee_ready")
                publishMoveStates()
                do { try await reconcileVideoOff() }
                catch {
                    guard isCurrentGeneration(generation), centralConsumer.call.isActive else { return }
                    callFailure = ComponentVideoFailureCode.stopFailed.rawValue; publishSnapshot()
                }
                await attachPaymentChannel()
                guard isCurrentGeneration(generation) else { return }
                guard callCloseReady else { return }
                if pendingCallClose != nil, ambientWanted { try? await applyAmbient() }
                // After a reconnect the real tracks are reconciled to the intent (a mute made meanwhile holds).
                reconcilePublishedMedia()
            default:
                return
            }
        case .encryptionFailed:
            encryptionActive = false
            encryptionFailureCode = "e2ee_failed"
            await paymentChannel.detach()
            guard isCurrentGeneration(generation) else { return }
            await terminalFailure(
                generation: generation,
                code: "e2ee_failed",
                reasonCode: "e2ee_failed",
                receiptStatus: "e2ee_fail_closed"
            )
        case .centralText(let packet):
            let operation = try? packet.fields.value("operation", as: String.self)
            if textOwner == .centralCandidate, operation == "camera_capture_once" {
                do { try await acceptCameraRequest(packet) }
                catch { centralConsumer.reportWireFailure(error); centralObserver?(centralConsumer) }
                return
            }
            if operation?.hasPrefix("payment_") == true || operation == "owner_override_status" || operation?.hasPrefix("model_settings_") == true,
               case .active(true) = state, encryptionActive, await paymentChannel.accept(packet) { return }
            guard textOwner == .centralCandidate, case .active(true) = state, encryptionActive else {
                #if DEBUG
                print("PAIOS_CENTRAL_PACKET_IGNORED owner=\(textOwner) state=\(state) encryption=\(encryptionActive)")
                #endif
                return
            }
            if operation == "call_state", !avatarControl,
               pendingCallClose?.id != (try? packet.fields.value("call_id", as: String.self)),
               (try? packet.fields.value("call_id", as: String.self)) == centralConsumer.call.id,
               let nextState = try? packet.fields.value("state", as: String.self), CentralCall.activeStates.contains(nextState),
               let revision = try? packet.fields.value("video_revision", as: UInt64.self), revision < videoRevision { return }
            if operation == "call_avatar_state", avatarControl,
               (try? packet.fields.value("avatar_revision", as: UInt64.self)) != videoRevision { return }
            if operation == "rejected", avatarControl, let id = centralConsumer.call.id,
               (try? packet.fields.value("request_operation", as: String.self)) == "call_avatar",
               (try? packet.fields.value("control_id", as: String.self)) == "\(videoRevision):\(id)" {
                let code = try? packet.fields.value("error_code", as: String.self)
                stopComponentVideo(failure: code == ComponentVideoFailureCode.quoteChanged.rawValue ? .quoteChanged : .requestRejected,
                    notifyGateway: true)
            }
            if operation == "rejected", (try? packet.fields.value("request_operation", as: String.self)) == "turns_sync" { return }
            let callWasActive = centralConsumer.call.isActive
            do {
                let operation = try packet.fields.value("operation", as: String.self)
                if operation == "camera_ack" { return }
                if operation == "rejected", try packet.fields.value("request_operation", as: String.self) == "camera_frame" {
                    guard let frameID = try packet.fields.value("frame_id", as: String.self),
                          frameID == cameraRequest?.frameID,
                          try packet.fields.value("session_id", as: String.self) == centralConsumer.binding?.sessionID else { return }
                    await endCameraRequest(reportFailure: false)
                    return
                }
                if operation == "ready" {
                    guard try packet.fields.value("session_id", as: String.self) == centralConsumer.binding?.sessionID else { throw CentralTextError.contextChanged() }
                    let epoch = try packet.fields.value("history_epoch", as: String.self)
                    if let epoch, epoch != terminalState.historyEpoch {
                        try localDatabase?.discardProductHistory(epoch: epoch)
                        careDelivery?.cancel(); careDelivery = nil; pendingCareSafe = nil
                        moveEventQueue = []; moveSession = MoveSession()
                        centralConsumer.discardProductHistory()
                    }
                    terminalState.applyHistoryEpoch(epoch)
                    acknowledgedAppearanceVersion = nil; appearanceAcknowledgementID = nil
                    terminalState.attach()
                    try await publishCentralRequest(AssistantCentralTextWire.encode("avatar_sync", fields: [:]))
                    try await publishTerminalRequest(terminalState.sync())
                    terminalObserver?(terminalState)
                    try await publishCentralRequest(AssistantCentralTextWire.encode("turns_sync", fields: ["request_id": UUID().uuidString.lowercased()]))
                    return
                }
                if ["avatar_state", "avatar_options_state", "avatar_preparation", "terminals", "confirmations", "terminal_receipt", "timeline_items", "timeline_removed", "timeline_reset", "timeline_resync"].contains(operation ?? "") {
                    guard try packet.fields.value("session_id", as: String.self) == centralConsumer.binding?.sessionID else { throw CentralTextError.contextChanged() }
                }
                let terminal: (handled: Bool, request: Data?)
                do { terminal = try terminalState.accept(packet) }
                catch {
                    if operation?.hasPrefix("timeline_") == true { terminalObserver?(terminalState) }
                    throw error
                }
                if terminal.handled {
                    if operation == "avatar_preparation",
                       terminalState.appearance.preparation?.status == .ready || terminalState.appearance.preparation?.status == .superseded,
                       terminalState.appearance.optionsRequestID == nil {
                        try await publishAppearanceRequest(terminalState.appearance.requestOptions())
                    }
                    if let request = terminal.request { try await publishTerminalRequest(request) }
                    terminalObserver?(terminalState)
                    return
                }
                if try await acceptMoveRequest(packet) { return }
                if try acceptLocationRequest(packet, generation: generation) { return }
                if try acceptOwnerDataReceipt(packet.fields) { return }
                try centralConsumer.accept(packet)
                if centralConsumer.binding?.voiceTransport == AssistantCentralTextWire.voiceTransport {
                    try await centralPublisher().observeCentralVoice(eventIDs: centralConsumer.observedVoiceEventIDs)
                    guard isCurrentGeneration(generation) else { return }
                }
                if let close = pendingCallClose, close.binding == centralConsumer.binding,
                   operation == "call_state",
                   (try? packet.fields.value("call_id", as: String.self)) == close.id {
                    let phase = try packet.fields.value("state", as: String.self)
                    if phase == "closed" || phase == "failed" { await acknowledgeCallClose() }
                    else if CentralCall.activeStates.contains(phase ?? ""), callCloseSend == nil {
                        pendingCallClose?.sentRevision = nil; try await drainPendingCallClose()
                    }
                }
                if operation == "call_state" {
                    await realtime.setCallPlaybackID(centralConsumer.call.isActive ? centralConsumer.call.id : nil)
                    if callRecoveryBudget != nil {
                        let announced = try packet.fields.value("rejoin_deadline", as: String.self).flatMap(RealtimeControlValidation.parseTimestamp)
                        await acceptCallRecoveryBudget(announced: announced)
                    } else {
                        await realtime.setCallRejoinDeadline(centralConsumer.call.isActive ? centralConsumer.call.rejoinDeadline : nil,
                            callActive: recoveryCallID != nil)
                    }
                }
                if gatewayCallAudio, centralConsumer.call.isActive,
                   (try? packet.fields.value("call_id", as: String.self)) == centralConsumer.call.id,
                   operation == "call_playback_reset",
                   (try? packet.fields.value("target", as: String.self)) == "avatar" {
                    await artc?.flushPlayback()
                }
                try finishCareSafeDelivery()
                scheduleCentralTextRecovery()
            } catch {
                #if DEBUG
                print("PAIOS_CENTRAL_PACKET_REJECTED error=\(String(reflecting: error))")
                #endif
                return
            }
            if !callWasActive, centralConsumer.call.isActive, centralConsumer.call.isAmbient,
               mediaHolders[.microphone]?.contains(.ambient) == true {
                // Reuse the ambient microphone; the call hold permits full-duplex speech under WebRTC AEC.
                callGeneration &+= 1
                mediaHolders[.microphone, default: []].insert(.call)
            }
            if (operation == "call_state" || operation == "call_avatar_state"),
               (try? packet.fields.value("call_id", as: String.self)) == centralConsumer.call.id {
                if wakeCallGeneration == callGeneration, centralConsumer.call.isActive,
                   let phase = try? packet.fields.value("state", as: String.self),
                   CentralCall.activeStates.contains(phase) {
                    wakeCallReadyReceiptGeneration = callGeneration
                    wakeListening.pcm.unlock()
                }
                settleWakeCallReadiness()
                if wakeWanted { wakeListening.controller.setCallPhase(ringing ? .opening : centralConsumer.call.isActive ? .active : .closed) }
                if pendingVideoOffCallID == centralConsumer.call.id,
                   (try? packet.fields.value(avatarControl ? "avatar" : "video", as: Bool.self)) == false,
                   (try? packet.fields.value(avatarControl ? "avatar_revision" : "video_revision", as: UInt64.self)) == videoRevision {
                    pendingVideoOffCallID = nil
                }
                connectCallMedia(errorCode: try? packet.fields.value("error_code", as: String.self))
            }
            if operation == "call_state", centralConsumer.call.state == "failed",
               (try? packet.fields.value("call_id", as: String.self)) == centralConsumer.call.id,
               dial == nil || centralConsumer.call.id != dial?.baseCallID {
                callFailure = centralConsumer.call.failureMessage
            }
            if callWasActive, !centralConsumer.call.isActive {
                // The call ended remotely (closed/failed): its media intent ends with it, nothing keeps capturing.
                let failed = centralConsumer.call.state == "failed"
                revokeMedia([.call], reason: "call_" + centralConsumer.call.state)
                try? await endCall(reason: failed ? "error" : "button", cancelPendingDial: false)
            }
            settleVoiceMicrophone()
            do { try await playPendingCentralVoice() } catch {
                guard isCurrentGeneration(generation) else { return }
                do { try centralConsumer.cancelVoice() }
                catch { centralConsumer.reportWireFailure(error) }
                try? await (realtime as? any AssistantCentralTextPublishing)?.prepareCentralVoice(eventID: nil)
            }
            guard isCurrentGeneration(generation) else { return }
            publishSnapshot()
            centralObserver?(centralConsumer)
        case .callAudioPlaying(let callID, let playing):
            guard case .active(true) = state, encryptionActive, centralConsumer.call.id == callID, centralConsumer.call.isActive else { return }
            callAudioPlaying = playing
            publishSnapshot()
        case .centralVoice(let playback):
            guard textOwner == .centralCandidate, case .active(true) = state, encryptionActive else {
                playback.resource.remove()
                try? await (realtime as? any AssistantCentralTextPublishing)?.prepareCentralVoice(eventID: nil)
                return
            }
            do {
                try centralConsumer.receiveVoice(playback)
                try await playPendingCentralVoice()
                guard isCurrentGeneration(generation) else { return }
                centralObserver?(centralConsumer)
            } catch {
                playback.resource.remove()
                guard isCurrentGeneration(generation) else { return }
                do { try centralConsumer.cancelVoice() }
                catch { centralConsumer.reportWireFailure(error) }
                try? await (realtime as? any AssistantCentralTextPublishing)?.prepareCentralVoice(eventID: nil)
            }
        case .centralVoiceFinished(let playback, let success):
            guard textOwner == .centralCandidate, case .active(true) = state, encryptionActive else { return }
            defer { scheduleCentralTextRecovery() }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            do {
                if let ack = try centralConsumer.voiceCompleted(playback, successfully: success, observedAt: formatter.string(from: Date())) {
                    do { try await publishCentralRequest(ack) }
                    catch {
                        guard isCurrentGeneration(generation) else { return }
                        centralConsumer.reportPlayedACKDeliveryFailure(error)
                    }
                    guard isCurrentGeneration(generation) else { return }
                }
                try await playPendingCentralVoice()
                guard isCurrentGeneration(generation) else { return }
                centralObserver?(centralConsumer)
            } catch { return }
        case .centralVoiceFailed(let packet):
            do { try centralConsumer.voiceFailed(packet) }
            catch { centralConsumer.reportWireFailure(error) }
            centralObserver?(centralConsumer)
        case .result(let envelope):
            guard textOwner == .legacy else { return }
            guard let sessionID = activeLogicalSessionID,
                  let epoch = activeConnectionEpoch
            else {
                return
            }
            if let promptGeneration =
                pendingPromptGenerations[envelope.streamID]
            {
                guard promptGeneration == generation else {
                    return
                }
                resultObserver?(
                    envelope.injectingLocalContext(
                        sessionID: sessionID,
                        epoch: epoch
                    )
                )
                if envelope.isFinal {
                    pendingPromptGenerations.removeValue(
                        forKey: envelope.streamID
                    )
                    completedPromptGenerations[envelope.streamID] = generation
                }
                return
            }
            guard completedPromptGenerations[envelope.streamID] == nil else {
                return
            }
            // The transport envelope is wire-only. Attach the current local
            // session and connection epoch only after the generation fence.
            resultObserver?(
                envelope.injectingLocalContext(
                    sessionID: sessionID,
                    epoch: epoch
                )
            )
        case .cyclingControl(let command):
            guard case .active(let stateEncryptionActive) = state,
                  stateEncryptionActive,
                  encryptionActive,
                  activeGeneration == generation,
                  activeDetails != nil,
                  let watchControl,
                  cyclingControlLedger.accept(command)
            else {
                return
            }
            _ = await watchControl.sendCyclingControl(command)
        case .disconnected(let errorCode):
            if errorCode == LiveKitSessionAdapter.gatewayLeftCode {
                // The gateway left this binding's room: a refresh would only rejoin a room no gateway serves. End the
                // call as a network loss and fail the binding; its session owner then starts fresh with a bootstrap.
                if pendingCallClose == nil, centralConsumer.call.isActive {
                    callFailure = nil
                    centralConsumer.finishCall(centralConsumer.call.id, reason: "network")
                    centralObserver?(centralConsumer); publishSnapshot()
                }
                await terminalFailure(generation: generation, code: LiveKitSessionAdapter.gatewayLeftCode, reasonCode: "realtime_disconnected",
                                      receiptStatus: "disconnected_cleanup")
                return
            }
            if recoveryCallID != nil || (textOwner == .centralCandidate && LiveKitSessionAdapter.isRecoverableDisconnection(errorCode)) {
                pendingCallClose?.sentRevision = nil
                // SDK reconnect exhaustion ends a room, not the server-owned call.
                encryptionActive = false
                mediaUnknown.formUnion(mediaPublished)
                mediaUnknown.formUnion(mediaReconcilers.keys)
                if state == .reconnecting { callRecoveryRevision &+= 1 }
                transition(.reconnecting, reason: errorCode ?? "disconnected")
                await freezeCallLossDeadline()
                scheduleCallRecoveryExpiry(generation: generation)
                beginTransportRecovery(generation: generation)
                await paymentChannel.detach()
                guard isCurrentGeneration(generation) else { return }
                await detachVideoForConnectionLoss()
                do { try centralConsumer.cancelVoice() }
                catch { centralConsumer.reportWireFailure(error) }
                return
            }
            await terminalFailure(
                generation: generation,
                code: errorCode ?? "disconnected",
                reasonCode: "realtime_disconnected",
                receiptStatus: "disconnected_cleanup"
            )
        }
    }

    /// Sole acceptance boundary for this call/loss. Estimates never become authoritative by being projected.
    private func acceptCallRecoveryBudget(estimate: Date? = nil, announced: Date? = nil, loss: UUID? = nil) async {
        guard !callCloseReconciliation, let generation = activeGeneration, let callID = recoveryCallID else { return }
        if callRecoveryBudget == nil {
            guard loss == nil, let estimate else { return }
            callRecoveryBudget = (recoveryCallGeneration, callID, UUID(), estimate, false)
        }
        guard var budget = callRecoveryBudget, budget.call == recoveryCallGeneration, budget.callID == callID,
              loss == nil || budget.loss == loss else { return }
        if let announced {
            if budget.qualified && announced > budget.deadline {
                Logger(subsystem: "ai.paios.personal.phase0", category: "call").error("CALL_REJOIN_DEADLINE_EXTENSION_REJECTED")
            } else { budget.deadline = announced; budget.qualified = true }
        }
        let changed = callLossDeadline != budget.deadline
        callRecoveryBudget = budget
        centralConsumer.setCallRejoinDeadline(budget.deadline)
        if changed { callRecoveryExpiry?.cancel(); callRecoveryExpiry = nil }
        scheduleCallRecoveryExpiry(generation: generation)
        await realtime.setCallRejoinDeadline(budget.deadline, callActive: true)
    }

    private func freezeCallLossDeadline() async {
        guard !callCloseReconciliation, recoveryCallID != nil, let window = centralConsumer.binding?.callRejoinWindowS else { return }
        await acceptCallRecoveryBudget(estimate: Date().addingTimeInterval(TimeInterval(window)),
            announced: callRecoveryBudget == nil ? centralConsumer.call.rejoinDeadline : nil)
    }

    private func scheduleCallRecoveryExpiry(generation: UInt64) {
        guard callRecoveryExpiry == nil, recoveryCallID != nil, callLossDeadline != nil else { return }
        let call = recoveryCallGeneration
        callRecoveryExpiry = Task {
            while self.recoveryCallGeneration == call, !Task.isCancelled, !self.encryptionActive {
                guard let deadline = AssistantCallRejoinBudget.deadline(self.callLossDeadline) else { return }
                do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch { return }
                guard self.recoveryCallGeneration == call, !Task.isCancelled, !self.encryptionActive,
                      let latest = AssistantCallRejoinBudget.deadline(self.callLossDeadline) else { return }
                if latest > Date() { continue }
                await self.finishNetworkCall(generation: generation)
                return
            }
        }
    }

    private func finishNetworkCall(generation: UInt64) async {
        guard isCurrentGeneration(generation), recoveryCallID != nil else { return }
        if pendingCallClose != nil {
            // Expiry/auth failure cannot acknowledge a close after a successful server refresh.
            // Retire the failed room, then keep the same close intent on a control connection.
            // The existing recovery owner retries without another network event or call rejoin budget.
            callCloseReconciliation = true; callCloseRetiring = true; encryptionActive = false
            callRecoveryExpiry?.cancel(); callRecoveryExpiry = nil
            transportRecovery?.task.cancel(); transportRecovery = nil
            mediaUnknown.formUnion(mediaPublished)
            closeRealtimeEvents()
            await realtime.setCallRejoinDeadline(nil, callActive: false)
            await realtime.stop()
            restoreLocalWakeCapture()
            callCloseRetiring = false
            guard isCurrentGeneration(generation), pendingCallClose != nil else { return }
            _ = openRealtimeEvents(generation: generation)
            transition(.reconnecting, reason: "call_close_room_retired")
            completeConnectionWaiters(AssistantSessionCoordinatorError.notActive)
            beginTransportRecovery(generation: generation)
            return
        }
        callFailure = nil
        centralConsumer.finishCall(centralConsumer.call.id, reason: "network")
        centralObserver?(centralConsumer); publishSnapshot()
        _ = await stop(reasonCode: "network")
    }

    private func reconcileCallStop(generation: UInt64) async -> Bool {
        guard let close = pendingCallClose, let context = close.stop else { return true }
        let stopped = try? await bootstrapProvider.stop(context)
        guard isCurrentGeneration(generation), pendingCallClose?.call == close.call, pendingCallClose?.id == close.id else { return true }
        guard stopped?.confirmed == true else { return false }
        await releaseGoneCallBinding(generation: generation)
        return true
    }

    private func releaseGoneCallBinding(generation: UInt64) async {
        guard isCurrentGeneration(generation), pendingCallClose != nil else { return }
        transition(.stopping)
        await acknowledgeCallClose()
        callRecoveryExpiry?.cancel(); callRecoveryExpiry = nil
        transportRecovery?.task.cancel(); transportRecovery = nil
        encryptionActive = false; generationCounter &+= 1; activeGeneration = nil
        closeRealtimeEvents()
        await realtime.stop()
        restoreLocalWakeCapture()
        activeDetails = nil; activeIntent = nil; activeConnectionEpoch = nil; activeLogicalSessionID = nil
        mediaPublished.removeAll(); mediaUnknown.removeAll(); mediaReconcilers.removeAll()
        moveSession.clearFeedback()
        do { try centralConsumer.reset(binding: nil, generation: generationCounter) }
        catch { centralConsumer.reportWireFailure(error) }
        centralObserver?(centralConsumer)
        // No remote/global Stop: the server proved this binding gone; ambientWanted and unrelated owners survive.
        transition(.stopped(remoteStopConfirmed: true))
    }

    private func beginTransportRecovery(generation: UInt64) {
        if callCloseRetiring { return }
        guard transportRecovery == nil, let details = activeDetails, let intent = activeIntent,
              let ingress = realtimeEventIngress else { return }
        let id = UUID(), call = recoveryCallGeneration, binding = pendingCallClose?.binding ?? centralConsumer.binding, callID = recoveryCallID
        let reconcileClose = callCloseReconciliation
        let connectionDeadline = Date().addingTimeInterval(60)
        let task = Task {
            defer { if self.transportRecovery?.id == id { self.transportRecovery = nil } }
            var attempt = 0
            while self.isCurrentGeneration(generation), self.recoveryCallGeneration == call,
                  self.recoveryCallID == callID, !Task.isCancelled {
                // Refresh only this accepted binding. No bootstrap, dial or call_open.
                let deadline = callID == nil ? connectionDeadline : (reconcileClose ? nil : AssistantCallRejoinBudget.deadline(self.callLossDeadline))
                if let deadline, deadline <= Date() {
                    if callID == nil { await self.terminalFailure(generation: generation, code: "reconnect_timeout", reasonCode: "realtime_disconnected", receiptStatus: "disconnected_cleanup") }
                    else { await self.finishNetworkCall(generation: generation) }
                    return
                }
                let backoff = AssistantReconnectBackoff.delay(attempt: attempt); attempt += 1
                let pause = deadline.map { min(backoff, .seconds(max(0, $0.timeIntervalSinceNow))) } ?? backoff
                do { try await Task.sleep(for: pause) } catch { return }
                guard self.isCurrentGeneration(generation), self.recoveryCallGeneration == call,
                      self.recoveryCallID == callID, !Task.isCancelled else { return }
                if let deadline, deadline <= Date() { continue }
                do {
                    if self.pendingCallClose?.stop != nil {
                        if await self.reconcileCallStop(generation: generation) { return }
                        continue
                    }
                    let loss = self.callRecoveryBudget?.loss
                    let refreshed = try await self.bootstrapProvider.reconnectDetails(details, for: intent, callID: callID)
                    guard self.isCurrentGeneration(generation), self.recoveryCallGeneration == call,
                          self.recoveryCallID == callID, !Task.isCancelled else { return }
                    self.activeDetails = refreshed
                    // A reply from an earlier loss still refreshes credentials, but cannot install its old budget.
                    guard self.callRecoveryBudget?.loss == loss else {
                        if self.callRecoveryBudget == nil { return }; continue
                    }
                    if !reconcileClose { await self.acceptCallRecoveryBudget(announced: refreshed.callRejoinDeadline, loss: loss) }
                    guard self.callRecoveryBudget?.loss == loss else {
                        if self.callRecoveryBudget == nil { return }; continue
                    }
                    let recovery = self.callRecoveryRevision
                    try await self.realtime.connect(AssistantRealtimeConnectRequest(
                        details: refreshed, intent: intent, autoSubscribe: true,
                        centralBinding: binding, retainsLogicalCall: callID != nil && !reconcileClose, rejoinDeadline: reconcileClose ? nil : self.callLossDeadline
                    )) { event in ingress.yield(event) }
                    if self.callRecoveryRevision != recovery { continue }
                    return
                } catch {
                    if Task.isCancelled { return }
                    if (error as? RealtimePublicControlAdapterError)?.isPairingRevoked == true {
                        await self.terminalFailure(generation: generation, code: "realtime_pairing_revoked",
                            reasonCode: "realtime_pairing_revoked", receiptStatus: "disconnected_cleanup")
                        return
                    }
                    if (error as? AssistantCallRecoveryError) == .bindingMissing, self.pendingCallClose != nil {
                        // Missing runtime attachment is not a call ACK. Existing media_stop proves closure of
                        // this retained binding only; its provider owns durable replay and exact-scope verification.
                        self.pendingCallClose?.stop = AssistantStopContext(operationID: intent.operationID,
                            roomName: details.roomName, reasonCode: "network")
                        if await self.reconcileCallStop(generation: generation) { return }
                        if reconcileClose { continue }
                        await self.finishNetworkCall(generation: generation)
                        return
                    }
                    if case .bindingGone = error as? AssistantCallRecoveryError, self.pendingCallClose != nil {
                        await self.releaseGoneCallBinding(generation: generation); return
                    }
                    if reconcileClose { continue }
                    if error is AssistantCallRecoveryError {
                        if callID == nil { await self.terminalFailure(generation: generation, code: "reconnect_rejected", reasonCode: "realtime_disconnected", receiptStatus: "disconnected_cleanup") }
                        else { await self.finishNetworkCall(generation: generation) }
                        return
                    }
                    // Unavailable transport remains recoverable within the announced lease budget.
                }
            }
        }
        transportRecovery = (id, task)
    }

    private var canHandleRealtimeEvent: Bool {
        switch state {
        case .requestingPermissions, .bootstrapping,
             .encryptionPreparing, .connecting, .active, .reconnecting:
            return true
        case .idle, .stopping, .stopped, .failed:
            return false
        }
    }

    private func terminalFailure(
        generation: UInt64,
        code: String,
        reasonCode: String,
        receiptStatus: String
    ) async {
        guard isCurrentGeneration(generation), inFlightStop == nil else {
            return
        }
        let task = beginStopOperation(
            reasonCode: reasonCode,
            finalization: .failed(
                code: code,
                receiptStatus: receiptStatus
            )
        )
        _ = await task.value
        finishStopOperationIfNeeded()
    }

    private func beginBootstrapTask(
        intent: AssistantStartIntent,
        generation: UInt64
    ) -> Task<AssistantConnectionDetails, Error> {
        let provider = bootstrapProvider
        let task = Task {
            try Task.checkCancellation()
            let details = try await provider.bootstrap(for: intent)
            try Task.checkCancellation()
            return details
        }
        inFlightBootstrap = task
        inFlightBootstrapGeneration = generation
        return task
    }

    private func clearBootstrapTaskIfCurrent(generation: UInt64) {
        guard inFlightBootstrapGeneration == generation else {
            return
        }
        inFlightBootstrap = nil
        inFlightBootstrapGeneration = nil
    }

    private func beginStopOperation(
        reasonCode: String,
        finalization: StopFinalization
    ) -> Task<AssistantRemoteStopResult, Never> {
        if let inFlightStop {
            return inFlightStop
        }

        let generationBeingStopped = activeGeneration
        pendingCallClose = nil; callCloseReconciliation = false; callCloseSend?.task.cancel(); callCloseSend = nil
        transportRecovery?.task.cancel(); transportRecovery = nil
        callRecoveryExpiry?.cancel(); callRecoveryExpiry = nil
        callRecoveryBudget = nil
        callGeneration &+= 1
        voicePress = nil
        voiceRelease?.task.cancel(); voiceRelease = nil
        stopRequestedGeneration = generationBeingStopped
        let shouldInvalidateBootstrap = inFlightBootstrap != nil
        // Task cancellation is immediate. The separate provider hook below
        // releases provider-owned waiters before generation storage is cleared.
        inFlightBootstrap?.cancel()
        sessionStart?.cancel()
        sessionStart = nil; sessionStartID = nil

        let operationID = activeIntent?.operationID
            ?? AssistantOperationID()
        let details = activeDetails
        transition(.stopping, reason: reasonCode)
        stopFinalization = finalization

        let task = Task { [weak self] in
            guard let self else {
                return AssistantRemoteStopResult(
                    confirmed: false,
                    opaqueReference: nil
                )
            }
            return await self.prepareAndPerformStopOperation(
                operationID: operationID,
                details: details,
                reasonCode: reasonCode,
                finalization: finalization,
                shouldInvalidateBootstrap: shouldInvalidateBootstrap
            )
        }
        inFlightStop = task
        return task
    }

    private func prepareAndPerformStopOperation(
        operationID: AssistantOperationID,
        details: AssistantConnectionDetails?,
        reasonCode: String,
        finalization: StopFinalization,
        shouldInvalidateBootstrap: Bool
    ) async -> AssistantRemoteStopResult {
        if shouldInvalidateBootstrap {
            await (bootstrapProvider as? any AssistantBootstrapInvalidating)?.invalidatePendingBootstrap()
        }
        inFlightBootstrap = nil
        inFlightBootstrapGeneration = nil
        generationCounter &+= 1
        activeGeneration = nil
        stopRequestedGeneration = nil
        return await performStopOperation(
            operationID: operationID,
            details: details,
            reasonCode: reasonCode,
            finalization: finalization
        )
    }

    private func performStopOperation(
        operationID: AssistantOperationID,
        details: AssistantConnectionDetails?,
        reasonCode: String,
        finalization: StopFinalization
    ) async -> AssistantRemoteStopResult {
        await paymentChannel.detach()
        closeRealtimeEvents()
        await leaveARTC()
        await realtime.stop()
        restoreLocalWakeCapture()
        resetMedia(reason: reasonCode)
        encryptionActive = false
        encryptionFailureCode = nil
        activeConnectionEpoch = nil
        activeLogicalSessionID = nil
        pendingPromptGenerations.removeAll(keepingCapacity: true)
        completedPromptGenerations.removeAll(keepingCapacity: true)
        moveSession.clearFeedback()
        do { try centralConsumer.reset(binding: nil, generation: generationCounter) }
        catch { centralConsumer.reportWireFailure(error) }
        centralObserver?(centralConsumer)

        var result = AssistantRemoteStopResult(
            confirmed: false,
            opaqueReference: nil
        )
        if let details {
            let context = AssistantStopContext(
                operationID: operationID,
                roomName: details.roomName,
                reasonCode: reasonCode
            )
            pendingStopContext = context
            do {
                result = try await bootstrapProvider.stop(context)
            } catch {
                result = AssistantRemoteStopResult(
                    confirmed: false,
                    opaqueReference: nil
                )
            }
        }

        if result.confirmed { pendingStopContext = nil }
        if details == nil {
            pendingStopRestored = false
            await restorePendingStopIfNeeded(explicitRetry: true, updateState: false)
        }
        activeDetails = nil
        activeIntent = nil
        cyclingWatchOriginBinding = nil
        moveSession.loseWatch()
        cyclingControlLedger.reset()
        lastStopResult = result
        await record(
            operationID: operationID,
            kind: .stop,
            localCleanup: true,
            remoteConfirmed: result.confirmed,
            status: result.confirmed
                ? "cleanup_complete"
                : "remote_stop_unconfirmed",
            remoteReference: result.opaqueReference
        )

        if case .failed(_, let receiptStatus) = finalization {
            await record(
                operationID: operationID,
                kind: .encryptionFailure,
                localCleanup: true,
                remoteConfirmed: false,
                status: receiptStatus,
                remoteReference: nil
            )
        }
        return result
    }

    private func finishStopOperationIfNeeded() {
        guard inFlightStop != nil else {
            return
        }
        let finalization = stopFinalization ?? .stopped
        inFlightStop = nil
        stopFinalization = nil

        switch finalization {
        case .stopped:
            transition(
                .stopped(
                    remoteStopConfirmed: lastStopResult?.confirmed ?? false
                )
            )
        case .failed(let code, _):
            transition(.failed(code: code))
        }
    }

    private func cleanupAfterFailedStart(generation: UInt64) async {
        guard isCurrentGeneration(generation) else {
            return
        }
        await paymentChannel.detach()
        guard isCurrentGeneration(generation) else { return }
        closeRealtimeEvents()
        // The dialing caller reports this failure after the shared connection attempt settles.
        voicePress = nil
        await realtime.stop()
        restoreLocalWakeCapture()
        resetMedia(reason: nil)
        clearBootstrapTaskIfCurrent(generation: generation)
        encryptionActive = false
        encryptionFailureCode = nil
        activeConnectionEpoch = nil
        activeLogicalSessionID = nil
        pendingPromptGenerations.removeAll(keepingCapacity: true)
        completedPromptGenerations.removeAll(keepingCapacity: true)
        moveSession.clearFeedback()
        do { try centralConsumer.reset(binding: nil, generation: generationCounter) }
        catch { centralConsumer.reportWireFailure(error) }
        centralObserver?(centralConsumer)
        cyclingWatchOriginBinding = nil
        moveSession.loseWatch()
        cyclingControlLedger.reset()
        guard isCurrentGeneration(generation) else {
            return
        }

        guard let details = activeDetails else {
            pendingStopRestored = false
            await restorePendingStopIfNeeded(explicitRetry: true, updateState: false)
            guard isCurrentGeneration(generation) else { return }
            activeIntent = nil
            lastStopResult = AssistantRemoteStopResult(
                confirmed: false,
                opaqueReference: nil
            )
            return
        }
        let operationID = activeIntent?.operationID
            ?? AssistantOperationID()
        _ = try? await bootstrapProvider.stop(
            AssistantStopContext(
                operationID: operationID,
                roomName: details.roomName,
                reasonCode: "start_failed"
            )
        )
        guard isCurrentGeneration(generation) else {
            return
        }
        pendingStopRestored = false
        await restorePendingStopIfNeeded(explicitRetry: true, updateState: false)
        guard isCurrentGeneration(generation) else { return }
        activeDetails = nil
        activeIntent = nil
        lastStopResult = AssistantRemoteStopResult(
            confirmed: false,
            opaqueReference: nil
        )
    }

    private func waitForEncryptionActive(
        generation: UInt64
    ) async throws {
        var attempts = 0
        while attempts < 100 || ringing || centralConsumer.call.isActive {
            attempts += 1
            try requireCurrentGeneration(generation)
            if encryptionActive {
                return
            }
            if encryptionFailureCode != nil {
                throw LiveKitSessionError.e2eeUnavailable
            }
            switch state {
            case .stopping, .stopped, .failed:
                throw LiveKitSessionError.e2eeUnavailable
            default:
                break
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw LiveKitSessionError.e2eeUnavailable
    }

    private func requireCurrentGeneration(_ generation: UInt64) throws {
        guard isCurrentGeneration(generation) else {
            throw AssistantSessionCoordinatorError.superseded
        }
    }

    private func isCurrentGeneration(_ generation: UInt64) -> Bool {
        activeGeneration == generation
            && stopRequestedGeneration != generation
    }

    private func transition(_ newState: AssistantSessionState, reason: String = #function) {
        if state != newState {
            Logger(subsystem: "ai.paios.personal.phase0", category: "connection").notice(
                "PAIOS_CONNECTION from=\(String(describing: self.state), privacy: .public) to=\(String(describing: newState), privacy: .public) reason=\(reason, privacy: .public)")
        }
        if newState == .reconnecting, state != .reconnecting { callRecoveryRevision &+= 1 }
        state = newState
        if wakeWanted, !ringing, !centralConsumer.call.isActive { wakeListening.controller.setCallPhase(.closed) }
        if case .active(true) = newState { scheduleCentralTextRecovery() } else { cancelCentralTextRecovery() }
        if isActiveState || (state.canStart && sessionStart == nil) || state == .stopping {
            completeConnectionWaiters(isActiveState ? nil : AssistantSessionCoordinatorError.notActive)
        }
        if case .active(true) = newState {
            if cameraRequest != nil { resumeCameraRequest() }
#if os(iOS)
            scheduleHealthSync(); scheduleContactsSync()
#endif
            resumeCareSafeDelivery()
        } else {
            cancelHealthRun(); cancelContactsRun()
            for (operation, pending) in ownerDataReceipts {
                finishOwnerDataReceipt(operation: operation, controlID: pending.chunk.controlID, error: CancellationError())
            }
        }
        publishSnapshot()
    }

    private func completeConnectionWaiters(_ error: Error?) {
        let waiters = connectionWaiters
        connectionWaiters.removeAll()
        for waiter in waiters {
            if let error { waiter.resume(throwing: error) } else { waiter.resume() }
        }
    }

    private func record(
        operationID: AssistantOperationID,
        kind: AppleLocalOperationReceipt.Kind,
        localCleanup: Bool,
        remoteConfirmed: Bool,
        status: String,
        remoteReference: String?
    ) async {
        try? await receipts.append(
            AppleLocalOperationReceipt(
                operationID: operationID.rawValue,
                kind: kind,
                recordedAt: Date(),
                localCleanupComplete: localCleanup,
                remoteConfirmationPresent: remoteConfirmed,
                statusCode: status,
                opaqueRemoteReference: remoteReference
            )
        )
    }

    private static func isValid(
        _ details: AssistantConnectionDetails
    ) -> Bool {
        details.serverURL.scheme?.lowercased() == "wss"
            && details.serverURL.host != nil
            && !details.roomName.isEmpty
            && !details.participantToken.isEmpty
    }

    private static func errorCode(_ error: Error) -> String {
        switch error {
        case AssistantBootstrapError.notConfigured:
            return "bootstrap_not_configured"
        case LiveKitSessionError.e2eeUnavailable:
            return "e2ee_unavailable"
        case LiveKitSessionError.superseded:
            return "realtime_superseded"
        case MediaPermissionError.cameraDenied:
            return "camera_denied"
        case MediaPermissionError.microphoneDenied:
            return "microphone_denied"
        case AssistantLocationError.permissionDenied:
            return "location_denied"
        case let error as RealtimePublicControlAdapterError:
            switch error {
            case .missingCanonicalContext:
                return "realtime_missing_canonical_context"
            case .missingCanonicalBody:
                return "realtime_missing_canonical_body"
            case .canonicalBodyTooLarge:
                return "realtime_canonical_body_too_large"
            case .invalidPublicOrigin:
                return "realtime_invalid_public_origin"
            case .invalidEndpointURL:
                return "realtime_invalid_endpoint"
            case .missingBearerCredential:
                return "realtime_missing_bearer"
            case .invalidBearerCredential:
                return "realtime_invalid_bearer"
            case .transportFailure:
                return "realtime_transport_failure"
            case .invalidHTTPResponse:
                return "realtime_http_response_invalid"
            case .unexpectedHTTPStatus where error.isPairingRevoked:
                return "realtime_pairing_revoked"
            case .unexpectedHTTPStatus(_):
                return "realtime_http_rejected"
            case .responseTooLarge:
                return "realtime_response_too_large"
            case .bootstrapCancelled:
                return "realtime_bootstrap_cancelled"
            case .bootstrapSuperseded:
                return "realtime_bootstrap_superseded"
            case .staleBinding:
                return "realtime_stale_binding"
            case .e2eeOpenFailed:
                return "realtime_e2ee_open_failed"
            case .malformedFixture,
                 .unexpectedOperation,
                 .unsupportedFirstSliceOperation,
                 .invalidCommittedStop,
                 .invalidConnectionDetails:
                return "realtime_response_mapping_failed"
            }
        default:
            return "start_failed"
        }
    }
}
