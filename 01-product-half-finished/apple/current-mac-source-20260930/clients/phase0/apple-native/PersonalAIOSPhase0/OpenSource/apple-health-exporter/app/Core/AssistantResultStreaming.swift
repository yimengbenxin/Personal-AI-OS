import Foundation
import CryptoKit

// These structures are client-local projections. They are deliberately not
// canonical session, continuity, result, Observation, or receipt objects.
enum AssistantResultEnvelopeError: Error, Equatable, Sendable {
    case invalidEnvelope
    case packetTooLarge
    case malformed
    case unsupportedKey(String)
}

struct AssistantResultEnvelope: Codable, Equatable, Sendable {
    static let topic = "paios.assistant.result.local.v1"
    static let maxWireBytes = 12_288
    private static let allowedErrorCodes: Set<String> = [
        "MODEL_UNAVAILABLE",
        "MODEL_FAILED",
        "BUSY"
    ]

    let streamID: String
    // These fields are local reducer context only. They are never encoded on
    // the LiveKit wire; the coordinator injects them after transport decode.
    let sessionID: String
    let epoch: UInt64
    let sequence: UInt64
    let text: String
    let isFinal: Bool
    let sentAt: Date?
    let errorCode: String?
    let privacy: AssistantReplyPrivacy?

    init(
        streamID: String,
        sequence: UInt64,
        text: String,
        isFinal: Bool,
        sessionID: String? = nil,
        epoch: UInt64 = 0,
        sentAt: Date? = nil,
        errorCode: String? = nil,
        privacy: AssistantReplyPrivacy? = nil
    ) {
        self.streamID = streamID
        self.sessionID = sessionID ?? streamID
        self.epoch = epoch
        self.sequence = sequence
        self.text = text
        self.isFinal = isFinal
        self.sentAt = sentAt
        self.errorCode = errorCode
        self.privacy = privacy
    }

    private enum CodingKeys: String, CodingKey {
        case streamID = "stream_id"
        case sequence
        case text
        case isFinal = "is_final"
        case finalValue = "final"
        case sentAt = "sent_at"
        case errorCode = "error_code"
        case privacy = "private"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        streamID = try container.decode(String.self, forKey: .streamID)
        // A raw transport frame has no local session/epoch. The coordinator
        // replaces these defaults with its current connection context.
        sessionID = streamID
        epoch = 0
        sequence = try container.decode(UInt64.self, forKey: .sequence)
        text = try container.decode(String.self, forKey: .text)
        if let value = try container.decodeIfPresent(
            Bool.self,
            forKey: .isFinal
        ) {
            isFinal = value
        } else {
            isFinal = try container.decodeIfPresent(
                Bool.self,
                forKey: .finalValue
            ) ?? false
        }
        sentAt = try container.decodeIfPresent(Date.self, forKey: .sentAt)
        errorCode = try container.decodeIfPresent(
            String.self,
            forKey: .errorCode
        )
        privacy = try container.decodeIfPresent(AssistantReplyPrivacy.self, forKey: .privacy)
        guard isWellFormed else {
            throw AssistantResultEnvelopeError.invalidEnvelope
        }
    }

    // Keep local reducer context out of the real LiveKit wire schema.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(streamID, forKey: .streamID)
        try container.encode(sequence, forKey: .sequence)
        try container.encode(text, forKey: .text)
        try container.encode(isFinal, forKey: .isFinal)
        try container.encodeIfPresent(sentAt, forKey: .sentAt)
        try container.encodeIfPresent(errorCode, forKey: .errorCode)
        try container.encodeIfPresent(privacy, forKey: .privacy)
    }

    func injectingLocalContext(
        sessionID: String,
        epoch: UInt64
    ) -> AssistantResultEnvelope {
        AssistantResultEnvelope(
            streamID: streamID,
            sequence: sequence,
            text: text,
            isFinal: isFinal,
            sessionID: sessionID,
            epoch: epoch,
            sentAt: sentAt,
            errorCode: errorCode,
            privacy: privacy
        )
    }

    func encoded() -> Data? {
        try? encodedStrict()
    }

    func encodedStrict() throws -> Data {
        guard isWellFormed else {
            throw AssistantResultEnvelopeError.invalidEnvelope
        }
        let data = try JSONEncoder().encode(self)
        guard data.count <= Self.maxWireBytes else {
            throw AssistantResultEnvelopeError.packetTooLarge
        }
        return data
    }

    static func decode(_ data: Data) -> AssistantResultEnvelope? {
        guard data.count <= Self.maxWireBytes,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any]
        else {
            return nil
        }
        let allowed = Set([
            "stream_id", "sequence", "text", "is_final", "final",
            "sent_at", "error_code", "private"
        ])
        let required = Set(["stream_id", "sequence", "text"])
        let keys = Set(dictionary.keys)
        guard keys.isSubset(of: allowed),
              required.isSubset(of: keys),
              keys.contains("is_final") || keys.contains("final")
        else {
            return nil
        }
        guard let envelope = try? JSONDecoder().decode(
            AssistantResultEnvelope.self,
            from: data
        ), envelope.isWellFormed else {
            return nil
        }
        return envelope
    }

    var isWellFormed: Bool {
        let streamBytes = Array(streamID.utf8)
        guard !streamBytes.isEmpty,
              streamBytes.count <= 64,
              sequence > 0,
              !sessionID.isEmpty,
              text.utf8.count <= Self.maxWireBytes
        else {
            return false
        }
        if let errorCode {
            return Self.allowedErrorCodes.contains(errorCode)
                && isFinal
                && text.isEmpty
        }
        return !text.isEmpty
    }
}

enum AssistantResultStreamDecision: Equatable, Sendable {
    case acceptedPartial
    case acceptedFinal
    case duplicateFinal
    case stale
    case malformed
}

struct AssistantResultStreamSnapshot: Equatable, Sendable {
    let streamID: String?
    let sessionID: String?
    let epoch: UInt64
    let sequence: UInt64
    let text: String
    let isFinal: Bool
    var privacy: AssistantReplyPrivacy? = nil

    static let empty = AssistantResultStreamSnapshot(
        streamID: nil,
        sessionID: nil,
        epoch: 0,
        sequence: 0,
        text: "",
        isFinal: false
    )
}

protocol AssistantResultStreaming: Sendable {
    func accept(
        _ envelope: AssistantResultEnvelope
    ) async -> AssistantResultStreamDecision
    func snapshot() async -> AssistantResultStreamSnapshot
    func reset() async
}

actor AssistantResultStreamReducer: AssistantResultStreaming {
    private struct StreamState: Sendable {
        let sessionID: String
        let epoch: UInt64
        var latestSequence: UInt64
        var latestText: String
        var finalized: Bool
        var privacy: AssistantReplyPrivacy?
    }

    private var activeStreamID: String?
    private var activeSessionID: String?
    private var activeEpoch: UInt64 = 0
    private var minimumEpoch: UInt64 = 0
    private var streams: [String: StreamState] = [:]

    func accept(
        _ envelope: AssistantResultEnvelope
    ) -> AssistantResultStreamDecision {
        guard envelope.isWellFormed else {
            return .malformed
        }
        guard envelope.epoch >= minimumEpoch else {
            return .stale
        }

        if let activeSessionID {
            if envelope.epoch > activeEpoch {
                activeEpoch = envelope.epoch
                self.activeSessionID = envelope.sessionID
                streams.removeAll(keepingCapacity: true)
            } else {
                guard envelope.epoch == activeEpoch,
                      envelope.sessionID == activeSessionID
                else {
                    return .stale
                }
            }
            if envelope.epoch < activeEpoch {
                return .stale
            }
        } else {
            activeSessionID = envelope.sessionID
            activeEpoch = envelope.epoch
        }

        guard envelope.epoch == activeEpoch,
              envelope.sessionID == activeSessionID
        else {
            return .stale
        }

        if var stream = streams[envelope.streamID] {
            guard stream.sessionID == envelope.sessionID,
                  stream.epoch == envelope.epoch
            else {
                return .stale
            }
            if stream.finalized {
                if envelope.isFinal,
                   envelope.sequence == stream.latestSequence,
                   envelope.text == stream.latestText,
                   envelope.errorCode == nil
                {
                    return .duplicateFinal
                }
                return .stale
            }
            guard envelope.sequence > stream.latestSequence else {
                return .stale
            }
            stream.latestSequence = envelope.sequence
            stream.latestText = envelope.text
            stream.finalized = envelope.isFinal
            stream.privacy = envelope.privacy ?? stream.privacy
            streams[envelope.streamID] = stream
        } else {
            streams[envelope.streamID] = StreamState(
                sessionID: envelope.sessionID,
                epoch: envelope.epoch,
                latestSequence: envelope.sequence,
                latestText: envelope.text,
                finalized: envelope.isFinal,
                privacy: envelope.privacy
            )
        }

        activeStreamID = envelope.streamID
        return envelope.isFinal ? .acceptedFinal : .acceptedPartial
    }

    func snapshot() -> AssistantResultStreamSnapshot {
        guard let activeStreamID,
              let stream = streams[activeStreamID]
        else {
            return .empty
        }
        return AssistantResultStreamSnapshot(
            streamID: activeStreamID,
            sessionID: stream.sessionID,
            epoch: stream.epoch,
            sequence: stream.latestSequence,
            text: stream.latestText,
            isFinal: stream.finalized,
            privacy: stream.privacy
        )
    }

    func reset() {
        minimumEpoch &+= 1
        activeStreamID = nil
        activeSessionID = nil
        activeEpoch = 0
        streams.removeAll(keepingCapacity: true)
    }
}

// Local presentation owns contiguous text consumption, never native execution or OUT truth.
struct CentralTextPresentation: Equatable, Sendable {
    let binding: CentralTransportBinding
    let packet: CentralTextPacket
    let text: String
    let isFinal: Bool
    var privacy: AssistantReplyPrivacy? = nil
}

struct CentralVoicePlayback: Equatable, Sendable {
    var privacy: AssistantReplyPrivacy? { get throws { try packet.fields.value("private", as: AssistantReplyPrivacy.self) } }
    let packet: CentralTextPacket
    let resource: CentralVoiceFile
}

enum CallSilenceTimeout: Int, CaseIterable, Hashable, Sendable {
    case threeMinutes = 180000, tenMinutes = 600000, thirtyMinutes = 1800000, never = 0
    static let preferenceKey = "paios.call.silence_timeout_ms"
    static func load(from defaults: UserDefaults = .standard) -> Self {
        guard defaults.object(forKey: preferenceKey) != nil else { return .threeMinutes }
        return Self(rawValue: defaults.integer(forKey: preferenceKey)) ?? .threeMinutes
    }
    var label: String {
        switch self {
        case .threeMinutes: return "3 分钟"
        case .tenMinutes: return "10 分钟"
        case .thirtyMinutes: return "30 分钟"
        case .never: return "永不挂断"
        }
    }
}

enum CallConversationMode: String, Codable, CaseIterable, Sendable {
    case chat, thinking
    var label: String { self == .chat ? "聊天模式" : "思考模式" }
}

struct CallThinkingStatus: Decodable, Equatable, Sendable {
    let state: String
    let text: String
    let actions: [String]
    private enum CodingKeys: String, CodingKey { case state, text, actions }
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        state = try fields.decode(String.self, forKey: .state)
        text = try fields.decode(String.self, forKey: .text)
        actions = try fields.decodeIfPresent([String].self, forKey: .actions) ?? []
    }
}

/// One live limited-F call: central state plus the running transcript (user, front, main agent).
struct CentralCall: Equatable, Sendable {
    static let activeStates = ["opening", "connecting", "live"]
    struct Media: Decodable, Equatable, Sendable {
        let provider: String; let app_id: String; let channel_id: String
        let user_id: String; let token: String; let token_expire_at: String
        var audio_input: String? = nil
    }
    struct Line: Equatable, Sendable, Identifiable {
        let callID: String; let turn: Int; let role: String; let text: String; let interrupted: Bool
        var privacy: AssistantReplyPrivacy? = nil
        // Turns restart at 0 in every call; without the call id a second call overwrote the first call's lines.
        var id: String { "\(callID)/\(turn)-\(role)" }
    }
    var id: String?
    var foregroundReplyInFlight: Bool?
    var backgroundWorkCount: Int?
    private var receivedState = "idle"
    var state: String {
        get { avatar == nil && media != nil && Self.activeStates.contains(receivedState) ? (videoFrameRendered ? "live" : "connecting") : receivedState }
        set {
            receivedState = newValue
            if !Self.activeStates.contains(newValue) {
                modeControl = nil; retryControl = nil
                conversationModeFailure = nil; thinkingRetryFailure = nil; thinkingStatus = nil
            }
        }
    }
    var voiceIsLive: Bool { receivedState == "live" }
    var mode = "manual"
    var isAmbient: Bool { mode == "ambient" }
    private(set) var conversationMode: CallConversationMode?
    private(set) var thinkingStatus: CallThinkingStatus?
    private(set) var processedEventID: String?
    private struct CallControl: Equatable, Sendable {
        let id: String
        let bytes: Data
        var mode: CallConversationMode?
        var processedID: String?
    }
    private var modeControl: CallControl?
    private var retryControl: CallControl?
    private(set) var conversationModeFailure: String?
    private(set) var thinkingRetryFailure: String?
    var pendingConversationMode: CallConversationMode? { modeControl?.mode }
    var conversationModeControlID: String? { modeControl?.id }
    var thinkingRetryPending: Bool { retryControl != nil }
    var thinkingRetryControlID: String? { retryControl?.id }
    var avatarAllowed: Bool { conversationMode != .thinking }
    var canRetryThinking: Bool {
        conversationMode != nil && thinkingStatus?.actions.contains("retry") == true && processedEventID != nil && !thinkingRetryPending
    }
    mutating func setConversationMode(_ mode: CallConversationMode, controlID: String) throws -> Data {
        guard let id, isActive, conversationMode != nil, modeControl == nil, mode != conversationMode else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.callConversationMode(callID: id, controlID: controlID, mode: mode)
        modeControl = CallControl(id: controlID, bytes: bytes, mode: mode)
        conversationModeFailure = nil
        return bytes
    }
    mutating func resendConversationMode() throws -> Data {
        guard let modeControl, isActive else { throw CentralTextError.unavailable }
        conversationModeFailure = nil
        return modeControl.bytes
    }
    mutating func retryThinking(controlID: String) throws -> Data {
        if let retryControl { thinkingRetryFailure = nil; return retryControl.bytes }
        guard let id, isActive, canRetryThinking, let processedEventID else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.callRetry(callID: id, controlID: controlID, processedEventID: processedEventID)
        retryControl = CallControl(id: controlID, bytes: bytes, processedID: processedEventID)
        thinkingRetryFailure = nil
        return bytes
    }
    mutating func reportControlFailure(_ error: Error, controlID: String) {
        if modeControl?.id == controlID { conversationModeFailure = "切换尚未确认：" + String(describing: error) }
        if retryControl?.id == controlID { thinkingRetryFailure = "重试尚未确认：" + String(describing: error) }
    }
    mutating func acceptControl(_ fields: CentralBody) throws -> Bool {
        let operation = try fields.value("operation", as: String.self)
        let requested = try fields.value(operation == "rejected" ? "request_operation" : "requested_operation", as: String.self)
        guard ["control_receipt", "rejected"].contains(operation ?? ""),
              requested == "call_set_conversation_mode" || requested == "call_retry" else { return false }
        let control = requested == "call_set_conversation_mode" ? modeControl : retryControl
        guard let control, try fields.value("control_id", as: String.self) == control.id else { return true }
        if operation == "rejected" {
            let error = try fields.value("error_code", as: String.self)
            if control.mode != nil { conversationModeFailure = error; modeControl = nil }
            else { thinkingRetryFailure = error; retryControl = nil }
        } else if control.mode != nil {
            guard try fields.value("call_id", as: String.self) == id else { throw CentralTextError.contextChanged() }
            let receipt = try fields.value("receipt", as: CentralBody.self)
            guard let confirmed = try receipt?.value("conversation_mode", as: CallConversationMode.self) else { throw CentralTextError.invalidPacket }
            conversationMode = confirmed
            if confirmed == .chat { thinkingStatus = nil; retryControl = nil; thinkingRetryFailure = nil }
            modeControl = nil; conversationModeFailure = nil
        } else {
            guard try fields.value("processed_event_id", as: String.self) == control.processedID else { throw CentralTextError.contextChanged() }
            retryControl = nil; thinkingRetryFailure = nil
        }
        return true
    }
    var lines: [Line] = []
    var media: Media?
    var avatar: Bool?
    var avatarRevision: UInt64 = 0
    var videoRevision: UInt64 = 0
    var rejoinDeadline: Date?
    var reason: String?
    var errorCode: String?
    var failureMessage: String? {
        guard state == "failed" else { return nil }
        switch errorCode {
        case "VOICE_CALL_BUSY": return "已有通话正在进行，请先挂断后重试"
        case "MEDIA_CAPTURE_NOT_CONNECTED": return "麦克风未连接，请重试"
        case "VOICE_CALL_OPEN_FAILED", "VOICE_CALL_CONNECT_FAILED": return "通话连接失败，请重试"
        case "VOICE_CALL_RECONNECT_FAILED": return "通话重新连接失败，请重拨"
        case .some(let code): return "通话失败（\(code)）"
        case nil:
            switch reason {
            case "network", "disconnected", "ws_closed": return "通话连接已断开，请重拨"
            case "artc_frame_timeout": return "视频连接超时，请重试"
            case "error", "artc_join_failed", nil: return "通话连接失败，请重试"
            default: return reason
            }
        }
    }
    var video: Bool?
    var videoFrameRendered = false
    var isActive: Bool { id != nil && Self.activeStates.contains(state) }
    init(id: String? = nil, state: String = "idle", mode: String = "manual", lines: [Line] = []) {
        self.id = id; receivedState = state; self.mode = mode; self.lines = lines
    }
    mutating func stopVideoPresentation() { media = nil; video = false; videoFrameRendered = false; if avatar != nil { avatar = false } }
    mutating func accept(_ fields: CentralBody) throws {
        guard let callID = try fields.value("call_id", as: String.self) else { return }
        if try fields.value("operation", as: String.self) == "call_avatar_state" {
            guard callID == id, isActive,
                  let revision = try fields.value("avatar_revision", as: UInt64.self), revision >= avatarRevision,
                  let enabled = try fields.value("avatar", as: Bool.self) else { return }
            avatarRevision = revision; avatar = enabled
            if enabled { media = try fields.value("media", as: Media.self) ?? media }
            else { media = nil; videoFrameRendered = false }
            return
        }
        if try fields.value("operation", as: String.self) == "call_state" {
            let nextState = try fields.value("state", as: String.self) ?? receivedState
            let nextMode = try fields.value("mode", as: String.self) ?? "manual"
            guard callID == id || (!isActive && nextMode == "ambient" && Self.activeStates.contains(nextState)) else { return }
            if callID == id, ["closing", "closed", "failed"].contains(state), Self.activeStates.contains(nextState) { return }
            if id != callID { media = nil; videoFrameRendered = false; videoRevision = 0; avatar = nil; avatarRevision = 0 }
            if let revision = try fields.value("video_revision", as: UInt64.self) {
                guard revision >= videoRevision || !Self.activeStates.contains(nextState) else { return }
                videoRevision = max(videoRevision, revision)
            }
            if id != callID { rejoinDeadline = nil }
            id = callID
            if let timestamp = try fields.value("rejoin_deadline", as: String.self) {
                guard let deadline = RealtimeControlValidation.parseTimestamp(timestamp) else { throw CentralTextError.invalidPacket }
                rejoinDeadline = max(rejoinDeadline ?? deadline, deadline)
            }
            reason = try fields.value("reason", as: String.self)
            errorCode = try fields.value("error_code", as: String.self)
            if let requestedVideo = try fields.value("video", as: Bool.self) {
                video = requestedVideo
                if !requestedVideo, avatar != true { media = nil; videoFrameRendered = false }
            }
            if video != false, let credentials = try fields.value("media", as: Media.self) { media = credentials }
            state = nextState
            mode = nextMode
            conversationMode = try fields.value("conversation_mode", as: CallConversationMode.self)
            thinkingStatus = conversationMode == nil ? nil : try fields.value("thinking_status", as: CallThinkingStatus.self)
            processedEventID = try fields.value("processed_event_id", as: String.self)
            if let retryControl, retryControl.processedID != processedEventID {
                self.retryControl = nil; thinkingRetryFailure = nil
            }
            if conversationMode == modeControl?.mode { modeControl = nil; conversationModeFailure = nil }
            if conversationMode == nil || !isActive {
                modeControl = nil; retryControl = nil
                conversationModeFailure = nil; thinkingRetryFailure = nil; thinkingStatus = nil
            }
            return
        }
        guard callID == id else { return }
        guard let role = try fields.value("role", as: String.self), let text = try fields.value("text", as: String.self),
              let turn = try fields.value("turn", as: Int.self) else { throw CentralTextError.invalidPacket }
        var line = Line(callID: callID, turn: turn, role: role, text: text, interrupted: (try fields.value("interrupted", as: Bool.self)) ?? false,
            privacy: try fields.value("private", as: AssistantReplyPrivacy.self))
        if let index = lines.firstIndex(where: { $0.id == line.id }) {
            line.privacy = line.privacy ?? lines[index].privacy
            lines[index] = line
        } else { lines.append(line) }
        if lines.count > 60 { lines.removeFirst(lines.count - 60) }
    }
}

/// SID-scoped retirement: only the old output track is muted. A fresh SID plays normally.
struct CallPlaybackRetirement: Sendable {
    private(set) var callID: String?
    private(set) var retiredSIDs: Set<String> = []
    private var retirementOrder: [String] = []
    static let retainedSIDLimit = 256
    mutating func accept(_ packet: CentralTextPacket, sessionID: String) throws -> String? {
        let fields = packet.fields
        guard try fields.value("session_id", as: String.self) == sessionID else { return nil }
        let operation = try fields.value("operation", as: String.self)
        let id = try fields.value("call_id", as: String.self)
        if operation == "call_state" {
            let state = try fields.value("state", as: String.self)
            if CentralCall.activeStates.contains(state ?? "") {
                if callID != id { retiredSIDs.removeAll(); retirementOrder.removeAll() }
                callID = id
            } else if id == callID { callID = nil }
            return nil
        }
        guard operation == "call_playback_reset", try fields.value("target", as: String.self) != "avatar", let id, id == callID,
              let sid = try fields.value("track_sid", as: String.self), !sid.isEmpty else { return nil }
        if retiredSIDs.insert(sid).inserted {
            retirementOrder.append(sid)
            if retirementOrder.count > Self.retainedSIDLimit {
                retiredSIDs.remove(retirementOrder.removeFirst())
            }
        }
        return sid
    }
}

/// One errand 依米 is running on the executor phone, from the central errand_progress snapshot.
struct CentralErrand: Equatable, Sendable, Identifiable {
    let id: String; let title: String; let app: String; let state: String; let startedAt: Date?; let step: Int; let maxSteps: Int
    init(_ fields: CentralBody) throws {
        guard let id = try fields.value("job_id", as: String.self), let title = try fields.value("title", as: String.self),
              let app = try fields.value("app", as: String.self), let state = try fields.value("state", as: String.self),
              let started = try fields.value("started_at", as: String.self), let step = try fields.value("step", as: Int.self),
              let maxSteps = try fields.value("max_steps", as: Int.self) else { throw CentralTextError.invalidPacket }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.id = id; self.title = title; self.app = app; self.state = state; startedAt = formatter.date(from: started)
        self.step = step; self.maxSteps = maxSteps
    }
}

/// `pending`: Core is still waiting on (or recovering) this request. `unconfirmed`: terminal, outcome unknown.
enum CentralSubmissionDelivery: Equatable, Sendable {
    case pending, unconfirmed, rejected, queued, accepted
}

struct AssistantCentralTextConsumer: Sendable {
    mutating func discardProductHistory() {
        let source = binding, owner = ownerPairingIdentity, current = generation, next = revision &+ 1
        releaseQueuedVoice()
        self = AssistantCentralTextConsumer()
        binding = source; ownerPairingIdentity = owner; generation = current; revision = next
    }
    private(set) var generation: UInt64 = 0
    private(set) var revision: UInt64 = 0
    private(set) var binding: CentralTransportBinding?
    private(set) var ownerPairingIdentity: String?
    private var typedScope: (binding: CentralTransportBinding, ownerIdentity: String?)?
    private var typedRecoveryRejected = false
    /// A typed request whose wait ended outside its own session: left behind by a reset into another source session
    /// (admitted, or unknown), or an identical resend the gateway refuses because an earlier session admitted it
    /// (D_SESSION_CONFLICT). It never holds the next request; the server timeline is the delivery authority.
    private var endedTyped: (eventID: String, delivery: CentralSubmissionDelivery)?
    /// The current voice submission ended without a known outcome: terminal, so it never holds the next request.
    private var submissionUnconfirmed = false
    var isLocallySubmitted: Bool { submission != nil || (voiceTurn.eventID != nil && voiceTurn.eventID == eventID) }
    private(set) var submission: Data?
    private(set) var eventID: String?
    private(set) var accepted: CentralTextPacket?
    private(set) var header: CentralTextPacket?
    private(set) var presentation: CentralTextPresentation?
    private(set) var status = "等待明确提交"
    private(set) var renderedACK: Data?
    private(set) var ackConfirmed = false
    private(set) var pendingVoice: CentralVoicePlayback?
    private(set) var playingVoice: CentralVoicePlayback?
    private var voiceQueue: [CentralVoicePlayback] = []
    private var voiceReceived: [Int: CentralTextPacket] = [:]
    private var voicePlayed = 0
    private struct VoiceReceipt: Sendable { let packet: CentralTextPacket; let observedAt: String }
    private var voiceReceipts: [Int: VoiceReceipt] = [:]
    private var voicePacket: CentralTextPacket?
    private var voiceACK: Data?
    private var voiceObservedAt: String?
    private var voiceConfirmed = false
    private var cancelledVoiceEpoch: Int?
    private var voiceRetryRequired = false
    private var voiceBinding: (binding: CentralTransportBinding, ownerIdentity: String?)?
    private struct Control: Sendable {
        let operation: String
        let processedID: String
        let epoch: Int?
        let bytes: Data
        let proposal: CentralMemoryProposal?
        let choice: CentralMemoryDecision.Choice?
    }
    private var controls: [String: Control] = [:]
    private(set) var memoryProposals: [CentralMemoryProposal] = []
    private var memoryOriginD: String?
    private var memoryBinding: CentralTransportBinding?
    private(set) var memoryStatus = "待批记录尚未读取"
    private(set) var memoryDecision: CentralMemoryOutcome?
    private(set) var voiceTurn = CentralVoiceTurn()
    private(set) var call = CentralCall()
    mutating func setCallConversationMode(_ mode: CallConversationMode, controlID: String) throws -> Data {
        defer { revision &+= 1 }
        return try call.setConversationMode(mode, controlID: controlID)
    }
    mutating func resendCallConversationMode() throws -> Data {
        defer { revision &+= 1 }
        return try call.resendConversationMode()
    }
    mutating func retryCallThinking(controlID: String) throws -> Data {
        defer { revision &+= 1 }
        return try call.retryThinking(controlID: controlID)
    }
    mutating func reportCallControlFailure(_ error: Error, controlID: String) {
        call.reportControlFailure(error, controlID: controlID); revision &+= 1
    }
    /// Errands running on the executor phone; the gateway sends the whole set on connect and on every change.
    private(set) var errands: [CentralErrand] = []
    private(set) var activities = CentralActivityStore()
    mutating func cancelErrand(_ id: String) throws -> Data {
        guard binding != nil, errands.contains(where: { $0.id == id }) else { throw CentralTextError.unavailable }
        return try AssistantCentralTextWire.errandCancel(jobID: id)
    }
    /// 录入我的声音, "确认是我" and 随身模式 replies (see CentralOwnerVoice).
    private(set) var ownerVoice = CentralOwnerVoice()
    mutating func voiceEnrollmentControl(_ action: String, id: String, callID: String?) throws -> Data {
        guard binding != nil else { throw CentralTextError.unavailable }
        defer { revision &+= 1 }
        return try ownerVoice.enrollment.control(action, id: id, callID: callID)
    }
    mutating func expireVoiceEnrollment(_ id: String, code: String) {
        ownerVoice.enrollment.expire(id, code: code); revision &+= 1
    }
    mutating func beginVoiceprint(operationID: String) throws -> Data {
        guard binding != nil else { throw CentralTextError.unavailable }
        defer { revision &+= 1 }
        return try ownerVoice.voiceprint.open(operationID: operationID)
    }
    mutating func commitVoiceprint() throws -> Data {
        defer { revision &+= 1 }
        return try ownerVoice.voiceprint.commit()
    }
    mutating func cancelVoiceprint() throws -> Data? {
        defer { revision &+= 1 }
        return try ownerVoice.voiceprint.cancel()
    }
    mutating func expireVoiceprint(_ code: String) { ownerVoice.voiceprint.expire(code); revision &+= 1 }
    mutating func voiceprintControl(_ operation: String, controlID: String, sampleIDs: [String]? = nil, sourceDeviceID: String? = nil) throws -> Data {
        guard binding != nil else { throw CentralTextError.unavailable }
        defer { revision &+= 1 }
        return try ownerVoice.voiceprint.control(operation, controlID: controlID, sampleIDs: sampleIDs, sourceDeviceID: sourceDeviceID)
    }
    mutating func expireVoiceprintControl(_ controlID: String, code: String) {
        ownerVoice.voiceprint.expireControl(controlID, code: code); revision &+= 1
    }
    /// Identity confirmation follows a new observation; native approval resumes its existing run.
    mutating func confirmVoice(_ id: String, choice: CentralVoiceConfirmationChoice? = nil, auth: String? = nil, now: Date = Date()) throws -> Data {
        guard binding != nil, let item = ownerVoice.confirmable(id, now: now) else { throw CentralTextError.unavailable }
        guard item.isNativeApproval == (choice != nil) else { throw CentralTextError.unavailable }
        guard item.isNativeApproval || auth == "face_id" || auth == "touch_id" else {
            throw CentralVoiceprintFailure(code: "VOICE_CONFIRMATION_APP_UPDATE_REQUIRED")
        }
        if !item.isNativeApproval, item.purpose == nil { try beginObservation(eventID: item.eventID) }
        defer { revision &+= 1 }
        return try ownerVoice.confirm(id, choice: choice, auth: auth, now: now)
    }
    mutating func careSafe(controlID: String) throws -> Data {
        defer { revision &+= 1 }
        return try ownerVoice.careSafe(controlID: controlID)
    }
    mutating func expireCare(_ controlID: String) { ownerVoice.expireCare(controlID); revision &+= 1 }
    mutating func expireVoiceConfirm(_ id: String) {
        if let event = ownerVoice.expireConfirm(id), pending[event]?.accepted == nil { pending.removeValue(forKey: event) }
        revision &+= 1
    }
    mutating func openCall(location: AssistantLocationObservation? = nil, silenceTimeout: CallSilenceTimeout = .threeMinutes, video: Bool = false, wakeWord: Bool = false, enrollment: (sessionID: String, callID: String)? = nil) throws -> Data {
        guard binding?.callRejoinWindowS != nil else { throw CentralTextError.unavailable }
        let id = enrollment?.callID ?? "call-" + UUID().uuidString.lowercased()
        let background = call.backgroundWorkCount
        call = CentralCall(id: id, state: "opening", lines: call.lines)
        call.backgroundWorkCount = background
        revision &+= 1
        return try AssistantCentralTextWire.call("call_open", callID: id, location: location, silenceTimeout: silenceTimeout, video: video, wakeWord: wakeWord, enrollmentSessionID: enrollment?.sessionID)
    }
    mutating func setCallRejoinDeadline(_ deadline: Date?) {
        call.rejoinDeadline = deadline
    }

    mutating func renderedCallFrame(_ id: String) {
        guard call.id == id, call.isActive, call.media != nil else { return }
        call.videoFrameRendered = true; revision &+= 1
    }
    mutating func stopCallVideo(_ id: String) {
        guard call.id == id, call.isActive else { return }
        call.stopVideoPresentation(); revision &+= 1
    }
    mutating func finishCall(_ id: String?, reason: String? = nil) {
        guard call.id == id else { return }
        call.state = "closed"
        if let reason { call.reason = reason }
        revision &+= 1
    }
    mutating func closeCall(reason: String = "button") throws -> Data? {
        guard let id = call.id, call.isActive else { return nil }
        call.state = "closing"
        revision &+= 1
        return try AssistantCentralTextWire.call("call_close", callID: id, reason: reason)
    }
    private struct RetainedDelivery: Sendable {
        let accepted: CentralTextPacket
        var header: CentralTextPacket
        let displayed: CentralTextPacket?
        let textDigest: Data?
        var renderedACK: Data?
        var renderedPacket: CentralTextPacket?
        var observedAt: String?
        var sequence: Int
        var confirmed: Bool
        var voicePacket: CentralTextPacket?
        var voiceACK: Data?
        var voiceObservedAt: String?
        var voiceConfirmed: Bool
        var voiceReceipts: [Int: VoiceReceipt]
        var unsettled: Bool {
            get throws {
                return try header.fields.value("reply_phase", as: String.self) == "sealed" &&
                    ((voicePacket != nil && !voiceConfirmed) ||
                     ["pending", "reconcile_required"].contains(try header.fields.value("voice_status", as: String.self) ?? "") ||
                     (!confirmed && (try header.fields.value("rendered_text_through_seq", as: Int.self) ?? 0) <
                        (try header.fields.value("text_chunk_count", as: Int.self) ?? 0)))
            }
        }
        var canReleaseUnknownAfterNewSubmit: Bool {
            get throws {
                guard voicePacket != nil, voiceACK == nil, !voiceConfirmed,
                      renderedACK == nil || confirmed,
                      !["pending", "reconcile_required"].contains(try header.fields.value("voice_status", as: String.self) ?? "") else { return false }
                return try confirmed || (header.fields.value("rendered_text_through_seq", as: Int.self) ?? 0) >=
                    (header.fields.value("text_chunk_count", as: Int.self) ?? 0)
            }
        }
    }

    private var retained: [String: RetainedDelivery] = [:]
    // The same submission/OUT state owner handles bounded pending observations.
    private var pending: [String: AssistantCentralTextConsumer] = [:]
    /// Submission acceptance is independent of later result, playback and control failures.
    func submissionDelivery(eventID: String) -> CentralSubmissionDelivery? {
        if let ended = endedTyped, ended.eventID == eventID { return ended.delivery }
        if self.eventID == eventID {
            if let accepted {
                let state = try? accepted.fields.value("admission", as: CentralBody.self)?.value("state", as: String.self)
                if state == "pending", header == nil { return .queued }
                if state == "expired" { return .rejected }
                return .accepted
            }
            if typedRecoveryRejected { return .rejected }
            return submissionUnconfirmed ? .unconfirmed : .pending
        }
        if let submitted = pending[eventID] { return submitted.submissionDelivery(eventID: eventID) }
        if retained.values.contains(where: { (try? $0.accepted.fields.value("event_id", as: String.self)) == eventID }) { return .accepted }
        return nil
    }
    func submissionProcessedID(eventID: String) -> String? {
        if self.eventID == eventID { return try? accepted?.fields.value("processed_event_id", as: String.self) }
        return pending[eventID]?.submissionProcessedID(eventID: eventID)
    }
    mutating func beginObservation(eventID: String, localSubmission: Bool = false) throws {
        guard let binding else { throw CentralTextError.unavailable }
        if self.eventID == eventID || pending[eventID] != nil { return }
        if endedTyped?.eventID == eventID { endedTyped = nil }
        guard localSubmission || pending.count < 16 else { throw CentralTextError.unavailable }
        var submitted = AssistantCentralTextConsumer()
        try submitted.reset(binding: binding, generation: generation, ownerPairingIdentity: ownerPairingIdentity)
        submitted.eventID = eventID
        if localSubmission { submitted.typedScope = (binding, ownerPairingIdentity) }
        submitted.resultRequested = true
        submitted.status = "观察发送中；接纳尚未确认"
        pending[eventID] = submitted
        revision &+= 1
    }
    private var observedRunOrder = 0
    private var runningSubmission: CentralTextPacket? {
        get throws {
            let candidates = [self] + Array(pending.values)
            let active = try candidates.filter {
                if ["completed", "cancelled", "expired", "failed"].contains(try $0.header?.fields.value("run_status", as: String.self) ?? "") { return false }
                let admission = try $0.accepted?.fields.value("admission", as: CentralBody.self)
                return try admission?.value("run_id", as: String.self) != nil &&
                    ["accepted", "running", "reconcile_required"].contains(admission?.value("state", as: String.self) ?? "")
            }
            if observedRunOrder == 0, submission != nil, active.count == 1,
               active.first?.eventID == eventID { return accepted }
            let versioned = try active.filter { try $0.accepted?.fields.value("admission", as: CentralBody.self)?.value("run_order", as: Int.self) == observedRunOrder && observedRunOrder > 0 }
            guard versioned.count <= 1 else { throw CentralTextError.contextChanged() }
            return versioned.first?.accepted
        }
    }
    var canCancelRun: Bool { get throws { try binding != nil && runningSubmission != nil } }

    private var hasPendingDecision: Bool { controls.values.contains { $0.operation == "memory_decide" } }
    private var needsRetention: Bool {
        get throws {
            return try header?.fields.value("reply_phase", as: String.self) == "sealed" &&
                ((voicePacket != nil && !voiceConfirmed) ||
                 ["pending", "reconcile_required"].contains(try header?.fields.value("voice_status", as: String.self) ?? "") ||
                 (!ackConfirmed && (try header?.fields.value("rendered_text_through_seq", as: Int.self) ?? 0) <
                    (try header?.fields.value("text_chunk_count", as: Int.self) ?? 0)))
        }
    }
    private var canRetain: Bool {
        get throws {
            try !needsRetention || retained.count < 16 || retained.values.contains { try $0.canReleaseUnknownAfterNewSubmit }
        }
    }
    var pendingMemoryControls: [String] { controls.filter { $0.value.operation.hasPrefix("memory_") }.keys.sorted() }
    var pendingRenderedACKs: [Data] {
        var packets = pending.keys.sorted().flatMap { pending[$0]?.pendingRenderedACKs ?? [] }
        if !ackConfirmed, let renderedACK { packets.append(renderedACK) }
        if !voiceConfirmed, let voiceACK { packets.append(voiceACK) }
        for id in retained.keys.sorted() {
            guard let old = retained[id] else { continue }
            if !old.confirmed, let ack = old.renderedACK { packets.append(ack) }
            if !old.voiceConfirmed, let ack = old.voiceACK { packets.append(ack) }
        }
        return packets
    }

    private(set) var controlReceipt: CentralTextPacket?
    private var resultRequested = false
    private var requestedReplay = "pending"
    // Nonempty chunk text bounds this cache to the existing UTF8 body budget.
    private var chunks: [String] = []
    private var renderedPacket: CentralTextPacket?
    private var renderedObservedAt: String?
    private var renderedSequence = 0

    mutating func reset(binding: CentralTransportBinding?, generation: UInt64? = nil, ownerPairingIdentity: String? = nil, preserveObservation: Bool = false) throws {
        let typed = self
        let preserveTyped = try generation != nil && (preserveObservation || hasUnsettledTypedRequest || pendingVoice != nil || !voiceQueue.isEmpty || voiceRetryRequired)
        let priorTypedScope = typedScope ?? self.binding.map { ($0, self.ownerPairingIdentity) }
        // No binding yet (a reconnect) keeps the request for its own session; any other session or owner ends its wait.
        let typedMoved = binding.map { next in
            priorTypedScope?.binding.sessionID != next.sessionID || priorTypedScope?.binding.deviceID != next.deviceID ||
                priorTypedScope?.binding.expectedGatewayIdentity != next.expectedGatewayIdentity || priorTypedScope?.ownerIdentity != ownerPairingIdentity
        } ?? false
        // voice_send is bound to its source session, so a session reset ends a sent turn's wait: it stays on its own
        // message as unconfirmed (display only) and never holds or resends into the next session.
        let unsettledVoice = generation != nil && voiceTurn.sentPacket != nil && [.sending, .unconfirmed].contains(voiceTurn.phase) ? voiceTurn : nil
        let nextRevision = revision &+ 1
        let currentGeneration = generation ?? self.generation
        let pending = controls.filter { $0.value.operation.hasPrefix("memory_") }
        let scope = memoryBinding
        let sameScope = binding.map { next in
            scope?.sessionID == next.sessionID && scope?.deviceID == next.deviceID &&
                scope?.expectedGatewayIdentity == next.expectedGatewayIdentity
        } ?? true
        let keep = !pending.isEmpty && sameScope
        let savedProposals = memoryProposals, savedOrigin = memoryOriginD, savedDecision = memoryDecision
        let savedAccepted = accepted, savedEvent = eventID
        let savedVoiceACK = voiceACK, savedVoicePacket = voicePacket, savedVoiceObservedAt = voiceObservedAt
        let savedVoiceConfirmed = voiceConfirmed, savedHeader = header
        let savedReceived = voiceReceived, savedPlayed = voicePlayed, savedReceipts = voiceReceipts
        let discardedBufferedVoice = pendingVoice != nil || !voiceQueue.isEmpty
        releaseQueuedVoice()
        let savedRetained = retained
        let priorBinding = voiceBinding ?? self.binding.map { ($0, self.ownerPairingIdentity) }
        let sameVoiceScope = binding.map { next in priorBinding?.binding.sessionID == next.sessionID &&
            priorBinding?.binding.deviceID == next.deviceID && priorBinding?.binding.expectedGatewayIdentity == next.expectedGatewayIdentity &&
            priorBinding?.ownerIdentity == ownerPairingIdentity } ?? true
        let savedActivities = activities
        let sameActivityScope = binding?.sessionID == self.binding?.sessionID && binding?.deviceID == self.binding?.deviceID &&
            binding?.expectedGatewayIdentity == self.binding?.expectedGatewayIdentity && ownerPairingIdentity == self.ownerPairingIdentity
        self = AssistantCentralTextConsumer()
        if sameActivityScope { activities = savedActivities }
        self.generation = currentGeneration
        self.revision = nextRevision
        self.binding = binding
        self.ownerPairingIdentity = ownerPairingIdentity
        if sameVoiceScope {
            retained = savedRetained
            if !retained.isEmpty { voiceBinding = priorBinding }
        }
        if savedVoicePacket != nil && sameVoiceScope {
            voiceACK = savedVoiceACK; voicePacket = savedVoicePacket; voiceObservedAt = savedVoiceObservedAt
            voiceReceived = savedReceived; voicePlayed = savedPlayed; voiceReceipts = savedReceipts
            voiceConfirmed = savedVoiceConfirmed; voiceBinding = priorBinding; accepted = savedAccepted; eventID = savedEvent; header = savedHeader
            resultRequested = true
            cancelledVoiceEpoch = (try savedHeader?.fields.value("reply_epoch", as: Int.self))
            status = "原播放事实已保留；重连不自动播放"
        }
        if var turn = unsettledVoice { turn.markUnconfirmed(); voiceTurn = turn }
        if preserveTyped, typedMoved, let event = typed.eventID {
            // Same rule as a voice turn: the old session's request ends terminal and its unsent display ACKs are dropped.
            endedTyped = (event, typed.accepted == nil ? .unconfirmed : .accepted)
            status = typed.accepted == nil ? "上一段会话的请求未确认是否送达；可重发这段文字" : "上一段会话的请求已送达；回复以对话记录为准"
        } else if preserveTyped {
            typedScope = priorTypedScope
            submission = typed.submission; eventID = typed.eventID; accepted = typed.accepted
            header = typed.header; chunks = typed.chunks; presentation = typed.presentation
            renderedACK = typed.renderedACK; renderedPacket = typed.renderedPacket
            renderedObservedAt = typed.renderedObservedAt; renderedSequence = typed.renderedSequence
            ackConfirmed = typed.ackConfirmed; resultRequested = typed.resultRequested
            requestedReplay = typed.requestedReplay; typedRecoveryRejected = typed.typedRecoveryRejected
            voiceRetryRequired = typed.voiceRetryRequired || discardedBufferedVoice
            if let binding, let displayed = presentation {
                presentation = CentralTextPresentation(binding: binding, packet: displayed.packet,
                    text: displayed.text, isFinal: displayed.isFinal, privacy: displayed.privacy)
            }
            status = binding == nil ? "原提交已保留；等待原来源会话恢复" : "正在恢复原提交与显示确认"
        }
        for (id, var observed) in typed.pending {
            if generation != nil && !typedMoved && observed.typedScope != nil {
                try observed.reset(binding: binding, generation: currentGeneration, ownerPairingIdentity: ownerPairingIdentity, preserveObservation: true)
                self.pending[id] = observed
            } else {
                observed.releaseDiscardedVoice()
            }
        }
        if keep {
            controls = pending; memoryBinding = binding ?? scope
            memoryProposals = savedProposals; memoryOriginD = savedOrigin; memoryDecision = savedDecision
            accepted = savedAccepted; eventID = savedEvent
            memoryStatus = binding == nil ? "原待批请求未确认；连接不可发送，原控制包保留" : "原待批请求未确认；可重发原控制包"
            status = "原结果需主动重读；没有恢复模型正文"
        } else if !pending.isEmpty {
            memoryStatus = "原待批请求状态未知；新来源会话不能重发"
        }
    }

    mutating func beginSubmit(eventID: String, capturedAt: String, text: String,
                              location: AssistantLocationObservation? = nil, attachments: [CentralAttachment] = []) throws -> Data {
        guard binding != nil, try (try canBeginSubmit) else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.submit(eventID: eventID, capturedAt: capturedAt, text: text, location: location, attachments: attachments)
        if try !canStartForegroundSubmission {
            try beginObservation(eventID: eventID, localSubmission: true)
            pending[eventID]?.submission = bytes
            pending[eventID]?.typedScope = binding.map { ($0, ownerPairingIdentity) }
            return bytes
        }
        try retireCurrent()
        try clearActive()
        self.eventID = eventID
        resultRequested = true
        status = "原文发送中；接纳尚未确认"
        submission = bytes
        typedScope = binding.map { ($0, ownerPairingIdentity) }
        return bytes
    }

    // Push-to-talk shares this binding; a confirmed voice turn becomes the current submission.
    mutating func beginVoice(operationID: String) throws -> Data {
        guard binding != nil else { throw CentralTextError.unavailable }
        let bytes = try voiceTurn.open(operationID: operationID)
        revision &+= 1
        return bytes
    }
    mutating func commitVoice() throws -> Data {
        let bytes = try voiceTurn.commit()
        revision &+= 1
        return bytes
    }
    func voiceCandidatesRequest() throws -> Data { try voiceTurn.candidatesRequest() }
    mutating func expireVoice(_ code: String) throws -> Data? {
        let bytes = try voiceTurn.expire(code)
        revision &+= 1
        return bytes
    }
    mutating func closeVoice() throws -> Data? {
        let bytes = try voiceTurn.close()
        revision &+= 1
        return bytes
    }
    mutating func voiceSendUnconfirmed() {
        voiceTurn.markUnconfirmed()
        settleVoiceSubmission()
        revision &+= 1
    }
    /// Only the current submission's unconfirmed turn, in its own source session, can resend its identical packet.
    func canResendVoice(eventID: String) -> Bool {
        binding != nil && (self.eventID == eventID || pending[eventID] != nil) && voiceTurn.eventID == eventID && voiceTurn.phase == .unconfirmed
    }
    mutating func resendVoice() throws -> Data {
        guard canResendVoice(eventID: voiceTurn.eventID ?? "") else { throw CentralTextError.unavailable }
        let bytes = try voiceTurn.resend()
        settleVoiceSubmission()
        revision &+= 1
        return bytes
    }
    /// A sent turn's terminal outcome belongs to the submission it started, so a later window cannot reopen it.
    private mutating func settleVoiceSubmission() {
        if let event = voiceTurn.eventID, pending[event] != nil, voiceTurn.sentPacket != nil {
            if pending[event]?.accepted == nil {
                if voiceTurn.phase == .failed { pending[event]?.typedRecoveryRejected = true }
                pending[event]?.submissionUnconfirmed = voiceTurn.phase == .unconfirmed
            }
            return
        }
        guard eventID != nil, voiceTurn.eventID == eventID, voiceTurn.sentPacket != nil, accepted == nil else { return }
        if voiceTurn.phase == .failed { typedRecoveryRejected = true }
        submissionUnconfirmed = voiceTurn.phase == .unconfirmed
    }
    mutating func sendVoice(_ candidate: CentralVoiceCandidate) throws -> Data {
        guard binding != nil, try canBeginSubmit else { throw CentralTextError.unavailable }
        var turn = voiceTurn
        let (bytes, event) = try turn.send(candidate)
        if try !canStartForegroundSubmission {
            try beginObservation(eventID: event, localSubmission: true)
            voiceTurn = turn
            return bytes
        }
        try retireCurrent()
        try clearActive()
        voiceTurn = turn
        eventID = event
        resultRequested = true
        status = "语音原文已确认发送；接纳尚未确认"
        revision &+= 1
        return bytes
    }

    var canBeginSubmit: Bool {
        get throws { !hasPendingDecision }
    }

    // Replacing the displayed reply is separate from admitting another network submission.
    var observedVoiceEventIDs: Set<String> { Set(pending.keys).union(eventID.map { [$0] } ?? []) }
    var canStartForegroundSubmission: Bool { get throws { try canPromotePending && pending.isEmpty } }
    var canPromotePending: Bool {
        get throws {
            if binding?.voiceTransport == AssistantCentralTextWire.voiceTransport, !voiceRetryRequired,
               cancelledVoiceEpoch == nil,
               !["failed", "none"].contains(try header?.fields.value("voice_status", as: String.self) ?? ""),
               !["failed", "interrupted"].contains(try header?.fields.value("reply_phase", as: String.self) ?? ""),
               ["voice", "text_and_voice"].contains(try header?.fields.value("reply_mode", as: String.self) ?? "") {
                if playingVoice != nil || pendingVoice != nil || !voiceQueue.isEmpty { return false }
                if ["pending", "reconcile_required"].contains(try header?.fields.value("voice_status", as: String.self) ?? "") { return false }
                if !voiceConfirmed, (try header?.fields.value("pending_voice_chunk_count", as: Int.self) ?? 0) > 0 || voicePacket != nil { return false }
            }
            return try !hasPendingDecision && (try canRetain) && (typedRecoveryRejected || submissionUnconfirmed || eventID == nil || presentation?.isFinal == true
            || ["expired", "cancelled", "failed"].contains((try accepted?.fields.value("admission", as: CentralBody.self)?.value("state", as: String.self)) ?? "")
            || ["failed", "interrupted"].contains((try header?.fields.value("reply_phase", as: String.self)) ?? "")
            || ["none", "voice"].contains((try header?.fields.value("reply_mode", as: String.self)) ?? ""))
        }
    }

    var canRequestSealedResult: Bool {
        get throws {
            try accepted != nil && (try header?.fields.value("reply_phase", as: String.self)) != "interrupted"
        }
    }

    mutating func reportWireFailure(_ error: Error) {
        revision &+= 1
        pendingVoice = nil; playingVoice = nil
        status = "正式结果合同读取失败；没有生成播放确认：" + String(describing: error)
    }

    mutating func reportPlayedACKDeliveryFailure(_ error: Error) {
        revision &+= 1
        status = "播放确认尚未送达；保留原确认并继续播放：" + String(describing: error)
    }

    mutating func requireExplicitReread() {
        revision &+= 1
        resultRequested = false
        status = "回调队列已超限；请主动重读原提交结果"
    }

    mutating func reportTypedRecoveryFailure(_ error: Error) {
        revision &+= 1
        status = "原提交恢复尚未确认；继续保留原请求：" + String(describing: error)
    }

    private var hasUnsettledTypedRequest: Bool {
        get throws {
            guard submission != nil, !typedRecoveryRejected else { return false }
            if accepted == nil || !pendingRenderedACKs.isEmpty { return true }
            if presentation?.isFinal == true { return !ackConfirmed }
            guard let header else { return true }
            let phase = try header.fields.value("reply_phase", as: String.self)
            let mode = try header.fields.value("reply_mode", as: String.self)
            return !["failed", "interrupted"].contains(phase ?? "") && !["none", "voice"].contains(mode ?? "")
        }
    }
    private var needsOwnResultRecovery: Bool {
        get throws {
            guard binding != nil, !typedRecoveryRejected, submission != nil || accepted != nil else { return false }
            let state = try accepted?.fields.value("admission", as: CentralBody.self)?.value("state", as: String.self)
            if ["expired", "cancelled", "failed"].contains(state ?? ""), header == nil { return false }
            if presentation?.isFinal == true { return false }
            let phase = try header?.fields.value("reply_phase", as: String.self)
            let mode = try header?.fields.value("reply_mode", as: String.self)
            return !["failed", "interrupted"].contains(phase ?? "") && !["none", "voice"].contains(mode ?? "")
        }
    }
    var needsTypedRecovery: Bool {
        get throws {
            try binding != nil && (needsOwnResultRecovery || !pendingRenderedACKs.isEmpty || pending.values.contains { try $0.needsTypedRecovery })
        }
    }
    /// The existing recovery loop visits the same observed submissions; accepted turns only reattach to results.
    mutating func typedRecoveryRequests() throws -> [Data] {
        var requests: [Data] = []
        if try needsOwnResultRecovery {
            if accepted == nil {
                if canRetryTypedSubmission { requests.append(try retryTypedSubmission()) }
            } else {
                let sealed = try header?.fields.value("reply_phase", as: String.self) == "sealed"
                requests.append(try requestResult(sealed: sealed))
            }
        }
        for id in pending.keys.sorted() {
            guard var observed = pending[id] else { continue }
            requests += try observed.typedRecoveryRequests()
            pending[id] = observed
        }
        return requests
    }

    var canRetryTypedSubmission: Bool {
        binding != nil && !typedRecoveryRejected && submission != nil && accepted == nil
    }
    func retryTypedSubmission() throws -> Data {
        guard canRetryTypedSubmission, let submission else { throw CentralTextError.unavailable }
        return submission
    }

    mutating func requestResult(sealed: Bool = false) throws -> Data {
        guard let processedID = (try accepted?.fields.value("processed_event_id", as: String.self)),
              try !sealed || (try canRequestSealedResult) else { throw CentralTextError.unavailable }
        revision &+= 1
        resultRequested = true
        requestedReplay = sealed ? "sealed" : "pending"
        status = sealed ? "已请求重读封存结果" : "已请求本次结果"
        return try AssistantCentralTextWire.result(processedID: processedID, sealed: sealed)
    }

    var retainedVoiceResultIDs: [String] {
        get throws {
            guard let binding else { return [] }
            return try retained.keys.sorted().filter { id in
                guard let old = retained[id],
                      try old.accepted.fields.value("session_id", as: String.self) == binding.sessionID,
                      try old.header.fields.value("output_plan", as: [CentralBody].self)?.first?.value("target_device_id", as: String.self) == binding.deviceID else { return false }
                return try ["pending", "reconcile_required"].contains(old.header.fields.value("voice_status", as: String.self) ?? "")
            }
        }
    }
    mutating func requestRetainedResult(processedID: String) throws -> Data {
        guard try retainedVoiceResultIDs.contains(processedID) else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.result(processedID: processedID)
        revision &+= 1
        status = "已请求较早语音状态；原终态尚未确认"
        return bytes
    }

    mutating func requestControl(_ operation: String, controlID: String) throws -> Data {
        let selected = operation == "cancel_run" ? try (runningSubmission ?? (submission != nil ? accepted : nil)) : accepted
        guard let processedID = (try selected?.fields.value("processed_event_id", as: String.self)), controls.count < 16 else { throw CentralTextError.unavailable }
        if operation == "retry_voice" {
            guard try canRetryVoiceGeneration else { throw CentralTextError.unavailable }
            voiceRetryRequired = false; voicePacket = voiceReceipts[voicePlayed]?.packet
            voiceReceived = voiceReceived.filter { $0.key <= voicePlayed }; releaseQueuedVoice()
        }
        let epoch = operation == "cancel_playback" ? (try header?.fields.value("reply_epoch", as: Int.self)) : nil
        if operation == "cancel_playback" { try cancelVoice() }
        let bytes = try AssistantCentralTextWire.control(operation: operation, controlID: controlID, processedID: processedID, replyEpoch: epoch)
        controls[controlID] = Control(operation: operation, processedID: processedID, epoch: epoch, bytes: bytes, proposal: nil, choice: nil)
        revision &+= 1
        status = "控制请求已发出；原状态等待收据"
        return bytes
    }

    mutating func accept(_ packet: CentralTextPacket) throws {
        if try ["control_receipt", "rejected"].contains(packet.fields.value("operation", as: String.self) ?? "") {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            if try call.acceptControl(packet.fields) { revision &+= 1; return }
        }
        if try packet.fields.value("operation", as: String.self) == "turns_state" {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            let foreground = try packet.fields.value("foreground_replies", as: [CentralBody].self) ?? []
            call.foregroundReplyInFlight = try foreground.contains { try $0.value("call_id", as: String.self) == call.id }
            call.backgroundWorkCount = try packet.fields.value("background_work_count", as: Int.self)
            revision &+= 1
            return
        }
        if let operation = try packet.fields.value("operation", as: String.self), ["call_state", "call_avatar_state", "call_transcript", "call_playback_reset"].contains(operation) {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            if operation == "call_state", let state = try packet.fields.value("state", as: String.self),
               CentralCall.activeStates.contains(state), binding.callRejoinWindowS == nil { throw CentralTextError.unavailable }
            if operation != "call_playback_reset" { try call.accept(packet.fields) }
            revision &+= 1
            return
        }
        if try packet.fields.value("operation", as: String.self) == "activity_update" {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            activities.accept(try JSONDecoder().decode(CentralActivityUpdate.self, from: packet.bytes))
            revision &+= 1
            return
        }
        if try packet.fields.value("operation", as: String.self) == "errand_progress" {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            errands = try (packet.fields.value("errands", as: [CentralBody].self) ?? []).map(CentralErrand.init)
            revision &+= 1
            return
        }
        if try CentralOwnerVoice.handles(packet.fields) {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            for event in try ownerVoice.accept(packet.fields) where pending[event]?.accepted == nil { pending.removeValue(forKey: event) }
            revision &+= 1
            return
        }
        if try packet.fields.value("operation", as: String.self) == "voice_status" {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            var turn = voiceTurn
            try turn.accept(packet.fields)
            voiceTurn = turn
            settleVoiceSubmission()
            revision &+= 1
            return
        }
        var next = self
        let event = try packet.fields.value("event_id", as: String.self)
        let processed = try packet.fields.value("processed_event_id", as: String.self)
        let operation = try packet.fields.value("operation", as: String.self) ?? ""
        // Server errands arrive without a local submit. They use the same bounded observation queue.
        if operation == "accepted", let event, event.hasPrefix("errand:"),
           event != eventID, pending[event] == nil {
            guard let binding, try packet.fields.value("session_id", as: String.self) == binding.sessionID else { throw CentralTextError.contextChanged() }
            try next.beginObservation(eventID: event)
        }
        let key = try next.pending.keys.first { id in
            try id == event || (processed != nil && next.pending[id]?.accepted?.fields.value("processed_event_id", as: String.self) == processed)
        }
        let controlID = try packet.fields.value("control_id", as: String.self)
        if let key, var submitted = next.pending[key], operation != "control_receipt", controlID == nil {
            try submitted.acceptPacket(packet)
            if operation == "rejected", submitted.accepted == nil, try packet.fields.value("error_code", as: String.self) == "ADMISSION_CAPACITY_EXCEEDED" {
                next.pending.removeValue(forKey: key)
                next.endedTyped = (key, .rejected)
                next.status = submitted.status
            } else { next.pending[key] = submitted }
        } else { try next.acceptPacket(packet) }
        if try next.canPromotePending, self.presentation?.isFinal == true || next.presentation?.isFinal != true,
           let ready = try next.pending.keys.filter({ next.pending[$0]?.header != nil }).sorted(by: { lhs, rhs in
               let left = try next.pending[lhs]?.accepted?.fields.value("admission", as: CentralBody.self)?.value("run_order", as: Int.self) ?? Int.max
               let right = try next.pending[rhs]?.accepted?.fields.value("admission", as: CentralBody.self)?.value("run_order", as: Int.self) ?? Int.max
               return left == right ? lhs < rhs : left < right
           }).first,
           let submitted = next.pending.removeValue(forKey: ready) {
            try next.retireCurrent()
            let waiting = next.pending, deliveries = next.retained, controls = next.controls
            // Session projections live beside the submission they replace; a new D never ends them.
            let liveCall = next.call, liveVoice = next.voiceTurn, liveErrands = next.errands, liveOwner = next.ownerVoice, liveActivities = next.activities
            next = submitted
            next.pending = waiting; next.retained = deliveries; next.controls = controls
            next.call = liveCall; next.voiceTurn = liveVoice; next.errands = liveErrands; next.ownerVoice = liveOwner; next.activities = liveActivities
        }
        if operation == "accepted", let event {
            next.voiceTurn.admissionObserved(eventID: event)
        }
        if try packet.fields.value("operation", as: String.self) == "accepted",
           let order = try packet.fields.value("admission", as: CentralBody.self)?.value("run_order", as: Int.self) {
            next.observedRunOrder = max(observedRunOrder, order)
        } else { next.observedRunOrder = observedRunOrder }
        next.revision = revision &+ 1
        self = next
    }

    private mutating func acceptPacket(_ packet: CentralTextPacket) throws {
        let fields = packet.fields
        guard let binding, (try fields.value("session_id", as: String.self)) == binding.sessionID else { throw CentralTextError.contextChanged() }
        if try (try fields.value("operation", as: String.self)) == "memory_proposals" || (try fields.value("operation", as: String.self)) == "memory_decision" {
            try acceptMemory(packet)
            return
        }
        if try (try fields.value("operation", as: String.self)) == "accepted", let decision = memoryDecision?.decision,
           memoryDecision?.execution?.status == .accepted, let next = memoryDecision?.accepted,
           (try fields.value("event_id", as: String.self)) == decision.event_id {
            guard try (try fields.value("processed_event_id", as: String.self)) == next.processed_event.processed_event_id else { throw CentralTextError.contextChanged() }
            if try (try accepted?.fields.value("processed_event_id", as: String.self)) != (try fields.value("processed_event_id", as: String.self)) {
                try retireCurrent()
                try clearActive(preserveMemory: true)
                eventID = decision.event_id
                resultRequested = true
            }
            controls.removeValue(forKey: decision.control_id)
        }
        if let dID = (try fields.value("processed_event_id", as: String.self)), dID != (try accepted?.fields.value("processed_event_id", as: String.self)), retained[dID] != nil,
           try (try fields.value("operation", as: String.self)) == "ack_receipt" || (try fields.value("operation", as: String.self)) == "result_header" {
            try acceptRetained(packet, processedID: dID)
            return
        }
        if try fields.value("operation", as: String.self) == "rejected",
           let oldID = try fields.value("processed_event_id", as: String.self), retained[oldID] != nil,
           try fields.value("request_operation", as: String.self) == "result" {
            status = "较早语音状态查询失败：" + (try fields.value("error_code", as: String.self) ?? "unknown")
            return
        }
        if try (try fields.value("operation", as: String.self)) == "rejected" {
            if let controlID = (try fields.value("control_id", as: String.self)) {
                guard let control = controls[controlID], control.operation == (try fields.value("request_operation", as: String.self)),
                      control.processedID == (try fields.value("processed_event_id", as: String.self)) else { throw CentralTextError.contextChanged() }
                if control.operation == "memory_decide", memoryDecision?.decision?.control_id == controlID {
                    memoryStatus = "决定已记录；接纳通知未知，可重发原控制包：" + ((try fields.value("error_code", as: String.self)) ?? "unknown")
                    return
                }
                controls.removeValue(forKey: controlID)
                if control.operation.hasPrefix("memory_") {
                    memoryStatus = "待批请求被拒绝：" + ((try fields.value("error_code", as: String.self)) ?? "unknown")
                    return
                }
                if control.processedID != (try accepted?.fields.value("processed_event_id", as: String.self)) { return }
            } else {
                guard try (try fields.value("event_id", as: String.self)) == eventID || (try fields.value("processed_event_id", as: String.self)) == (try accepted?.fields.value("processed_event_id", as: String.self)) else { throw CentralTextError.contextChanged() }
            }
            if accepted == nil,
               (try fields.value("request_operation", as: String.self)) == "submit",
               (try fields.value("error_code", as: String.self)) != "FORMAL_TEXT_REQUEST_FAILED" {
                typedRecoveryRejected = true
                if try fields.value("error_code", as: String.self) == "D_SESSION_CONFLICT", let eventID { endedTyped = (eventID, .accepted) }
            }
            status = "请求被拒绝：" + ((try fields.value("error_code", as: String.self)) ?? "unknown")
            return
        }
        if try (try fields.value("operation", as: String.self)) == "control_receipt" {
            guard let controlID = (try fields.value("control_id", as: String.self)), let requested = controls[controlID],
                  requested.operation == (try fields.value("requested_operation", as: String.self)),
                  (try fields.value("processed_event_id", as: String.self)) == requested.processedID,
                  let receipt = (try fields.value("receipt", as: CentralBody.self)) else { throw CentralTextError.contextChanged() }
            let notice: String
            if requested.operation == "cancel_playback" {
                guard try (try receipt.value("playback_status", as: String.self)) == "unknown", let cancellation = (try receipt.value("receipt", as: CentralBody.self)),
                      (try cancellation.value("status", as: String.self)) == "interrupted", (try cancellation.value("reply_epoch", as: Int.self)) == requested.epoch else { throw CentralTextError.invalidPacket }
                notice = "播放取消收据已收到；实际播放状态未知"
            } else if requested.operation == "retry_voice" {
                guard try (try receipt.value("reply_epoch", as: Int.self)) == (try header?.fields.value("reply_epoch", as: Int.self)), (try receipt.value("voice_status", as: String.self)) != nil else { throw CentralTextError.contextChanged() }
                notice = "原 OUT 语音重试结果：" + ((try receipt.value("voice_status", as: String.self)) ?? "unknown")
            } else {
                notice = requested.operation == "cancel_run" ? "运行取消回执：" + ((try receipt.value("status", as: String.self)) ?? "unknown") : "运行对账回执：" + ((try receipt.value("state", as: String.self)) ?? "unknown")
            }
            controls.removeValue(forKey: controlID)
            if try requested.operation == "cancel_run" || requested.processedID == (try accepted?.fields.value("processed_event_id", as: String.self)) { status = notice; controlReceipt = packet }
            return
        }
        guard let eventID else { throw CentralTextError.contextChanged() }
        if try (try fields.value("operation", as: String.self)) == "accepted" {
            guard try (try fields.value("event_id", as: String.self)) == eventID else { throw CentralTextError.contextChanged() }
            if let accepted {
                let priorState = try accepted.fields.value("admission", as: CentralBody.self)?.value("state", as: String.self)
                let nextState = try fields.value("admission", as: CentralBody.self)?.value("state", as: String.self)
                if ["completed", "cancelled", "expired", "failed"].contains(priorState ?? "") && nextState != priorState { throw CentralTextError.contextChanged() }
                if let priorOrder = try accepted.fields.value("admission", as: CentralBody.self)?.value("run_order", as: Int.self) {
                    guard try fields.value("admission", as: CentralBody.self)?.value("run_order", as: Int.self) == priorOrder else { throw CentralTextError.contextChanged() }
                }
                guard try (try fields.value("processed_event_id", as: String.self)) == (try accepted.fields.value("processed_event_id", as: String.self)),
                      (try fields.value("admission", as: CentralBody.self)?.value("idempotency_key", as: String.self)) == (try accepted.fields.value("admission", as: CentralBody.self)?.value("idempotency_key", as: String.self)),
                      try (try accepted.fields.value("admission", as: CentralBody.self)?.value("run_id", as: String.self)).map({ $0 == (try fields.value("admission", as: CentralBody.self)?.value("run_id", as: String.self)) }) ?? true else { throw CentralTextError.contextChanged() }
            }
            if let header, let runID = (try fields.value("admission", as: CentralBody.self)?.value("run_id", as: String.self)),
               runID != (try header.fields.value("run_id", as: String.self)) { throw CentralTextError.contextChanged() }
            guard try (try fields.value("processed_event_id", as: String.self)) != nil, let admission = (try fields.value("admission", as: CentralBody.self)),
                  (try admission.value("idempotency_key", as: String.self)) != nil, (try admission.value("state", as: String.self)) != nil else { throw CentralTextError.invalidPacket }
            accepted = packet
            typedRecoveryRejected = false
            submissionUnconfirmed = false
            if header == nil {
                status = try admission.value("state", as: String.self) == "pending" ? "原文已接纳；服务端排队中" : "原文已接纳；等待本次结果"
            }
            return
        }
        guard let accepted, resultRequested,
              (try fields.value("processed_event_id", as: String.self)) == (try accepted.fields.value("processed_event_id", as: String.self)) else { throw CentralTextError.contextChanged() }
        switch (try fields.value("operation", as: String.self)) {
        case "result_header":
            guard try (try fields.value("text_replay", as: String.self)) == requestedReplay
                    || (header == nil && (try fields.value("text_replay", as: String.self)) == "pending"),
                  let total = (try fields.value("text_chunk_count", as: Int.self)), let watermark = (try fields.value("rendered_text_through_seq", as: Int.self)),
                  watermark <= total, (try fields.value("pending_text_chunk_count", as: Int.self)) == total - watermark,
                  (try fields.value("event_id", as: String.self)) == eventID,
                  try (try accepted.fields.value("admission", as: CentralBody.self)?.value("run_id", as: String.self)).map({ $0 == (try fields.value("run_id", as: String.self)) }) ?? true else { throw CentralTextError.contextChanged() }
            if let header { try Self.checkHeader(fields, prior: header.fields) }
            let mode = (try fields.value("reply_mode", as: String.self))
            if total > 0 {
                guard ["text", "text_and_voice"].contains(mode ?? ""),
                      let plans = (try fields.value("output_plan", as: [CentralBody].self)), plans.count == 1,
                      (try plans[0].value("target_device_id", as: String.self)) == binding.deviceID,
                      (try plans[0].value("output_modes", as: [String].self))?.contains("text") == true else { throw CentralTextError.contextChanged() }
                if let header {
                    guard try (try plans[0].value("route_version", as: String.self)) == (try header.fields.value("output_plan", as: [CentralBody].self)?.first?.value("route_version", as: String.self)) else { throw CentralTextError.contextChanged() }
                }
            }
            if try (try fields.value("reply_phase", as: String.self)) == "failed" {
                guard total == 0, (try fields.value("output_plan", as: [CentralBody].self))?.isEmpty == true else { throw CentralTextError.invalidPacket }
                status = try fields.value("failure_notice", as: String.self) ?? "本次结果失败；没有可显示的文字"
            } else if (try fields.value("reply_phase", as: String.self)) == "interrupted" {
                guard try total > 0 || (try fields.value("output_plan", as: [CentralBody].self))?.isEmpty == true else { throw CentralTextError.invalidPacket }
                status = try fields.value("failure_notice", as: String.self) ?? (presentation == nil ? "本次结果已中断；没有显示文字" : "本次结果已中断；已显示文字保留")
            } else if mode == "none" {
                guard total == 0, (try fields.value("output_plan", as: [CentralBody].self))?.isEmpty == true else { throw CentralTextError.invalidPacket }
                status = "本次回复为静默"
            } else if mode == "voice" {
                guard total == 0 else { throw CentralTextError.invalidPacket }
                status = binding.voiceTransport == AssistantCentralTextWire.voiceTransport ? "原语音已就绪；不显示字幕" : "当前文字通道不支持语音播放"
            } else {
                guard total > 0, (try fields.value("reply_phase", as: String.self)) == "sealed", (try fields.value("reply_status", as: String.self)) == "complete" else { throw CentralTextError.contextChanged() }
                status = mode == "text_and_voice" ? "密封文字已就绪；语音状态独立记录" : "密封文字已就绪"
            }
            header = packet
            if total > 0 { status += (try resultNotice) }
            if try (try fields.value("reply_phase", as: String.self)) != "sealed" || watermark >= renderedSequence { renderedACK = nil }
        case "text_chunk":
            guard let header, (try header.fields.value("reply_phase", as: String.self)) == "sealed",
                  ["text", "text_and_voice"].contains((try header.fields.value("reply_mode", as: String.self)) ?? ""),
                  let chunk = (try fields.value("chunk", as: CentralBody.self)), let seq = (try chunk.value("seq", as: Int.self)),
                  let plan = (try header.fields.value("output_plan", as: [CentralBody].self))?.first,
                  (try chunk.value("run_id", as: String.self)) == (try header.fields.value("run_id", as: String.self)),
                  (try chunk.value("event_id", as: String.self)) == eventID,
                  (try chunk.value("reply_id", as: String.self)) == (try header.fields.value("reply_id", as: String.self)),
                  (try chunk.value("reply_epoch", as: Int.self)) == (try header.fields.value("reply_epoch", as: Int.self)),
                  (try chunk.value("target_device_id", as: String.self)) == binding.deviceID,
                  (try chunk.value("route_version", as: String.self)) == (try plan.value("route_version", as: String.self)),
                  (try chunk.value("output_id", as: String.self))?.hasPrefix("output:") == true,
                  try (try presentation?.packet.fields.value("chunk", as: CentralBody.self)?.value("output_id", as: String.self)).map({ $0 == (try chunk.value("output_id", as: String.self)) }) ?? true,
                  // Shape is the contract's (validated at decode); the producer names a native message or the native final.
                  (try chunk.value("message_ref", as: String.self)) != nil else { throw CentralTextError.contextChanged() }
            guard let total = (try header.fields.value("text_chunk_count", as: Int.self)), total > 0,
                  seq <= total, (try chunk.value("final", as: Bool.self)) == (seq == total) else { throw CentralTextError.contextChanged() }
            if seq <= chunks.count {
                guard chunks[seq - 1] == (try chunk.value("text", as: String.self)) else { throw CentralTextError.contextChanged() }
                return
            }
            guard seq == chunks.count + 1, presentation?.isFinal != true,
                  let text = (try chunk.value("text", as: String.self)) else { throw CentralTextError.contextChanged() }
            let combined = (presentation?.text ?? "") + text
            guard combined.utf8.count <= 262_144 else { throw CentralTextError.invalidPacket }
            chunks.append(text)
            let privacy = try fields.value("private", as: AssistantReplyPrivacy.self)
                ?? header.fields.value("private", as: AssistantReplyPrivacy.self) ?? presentation?.privacy
            presentation = CentralTextPresentation(binding: binding, packet: packet, text: combined,
                isFinal: (try chunk.value("final", as: Bool.self)) == true, privacy: privacy)
            status = (presentation?.isFinal == true ? "密封文字接收完整；显示确认独立记录" : "密封文字分片接收中") + (try resultNotice)
        case "ack_receipt":
            if try (try fields.value("receipt", as: CentralBody.self)?.value("status", as: String.self)) == "played" {
                guard let seq = try fields.value("receipt", as: CentralBody.self)?.value("highest_contiguous_seq", as: Int.self),
                      let fact = voiceReceipts[seq] else { throw CentralTextError.contextChanged() }
                try Self.checkACK(fields, header: header, expected: fact.packet, sequence: seq,
                    observedAt: fact.observedAt, status: "played")
                voiceConfirmed = try voiceConfirmed || seq == (voicePacket?.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self))
                status = "服务端已记录原生播放完成"
                return
            }
            try Self.checkACK(fields, header: header, expected: renderedPacket,
                sequence: renderedSequence, observedAt: renderedObservedAt)
            ackConfirmed = true
            status = "服务端已记录文字显示确认" + (try resultNotice)
        default: throw CentralTextError.invalidPacket
        }
    }

    mutating func receiveVoice(_ playback: CentralVoicePlayback) throws {
        if let id = try playback.packet.fields.value("event_id", as: String.self), var observed = pending[id] {
            try observed.receiveVoice(playback)
            pending[id] = observed
            revision &+= 1
            return
        }
        guard let binding, binding.voiceTransport == AssistantCentralTextWire.voiceTransport,
              (try playback.packet.fields.value("session_id", as: String.self)) == binding.sessionID,
              (try playback.packet.fields.value("operation", as: String.self)) == "voice_chunk", eventID != nil else { throw CentralTextError.contextChanged() }
        guard try playback.packet.fields.value("event_id", as: String.self) == eventID,
              let activeID = try accepted?.fields.value("processed_event_id", as: String.self),
              try playback.packet.fields.value("processed_event_id", as: String.self) == activeID else {
            playback.resource.remove()
            return // A queued older D cannot change the current playback owner.
        }
        guard let seq = try playback.packet.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self) else { throw CentralTextError.invalidPacket }
        if let prior = voiceReceived[seq] {
            if playback.resource != playingVoice?.resource && playback.resource != pendingVoice?.resource && !voiceQueue.contains(where: { $0.resource == playback.resource }) { playback.resource.remove() }
            // Generation closure changes only final; replay cannot change the original chunk or restart it.
            var original = try JSONSerialization.jsonObject(with: prior.bytes) as! [String: Any]
            var replay = try JSONSerialization.jsonObject(with: playback.packet.bytes) as! [String: Any]
            var originalChunk = original["chunk"] as! [String: Any], replayChunk = replay["chunk"] as! [String: Any]
            originalChunk.removeValue(forKey: "final"); replayChunk.removeValue(forKey: "final")
            original["chunk"] = originalChunk; replay["chunk"] = replayChunk
            guard NSDictionary(dictionary: original).isEqual(to: replay) else { throw CentralTextError.contextChanged() }
            return
        }
        guard seq == (voiceReceived.keys.max() ?? voicePlayed) + 1 else { playback.resource.remove(); throw CentralTextError.contextChanged() }
        guard voiceReceived.count < 1024,
              try voiceReceived.values.reduce((try playback.packet.fields.value("chunk", as: CentralBody.self)?.value("audio", as: CentralBody.self)?.value("bytes", as: Int.self)) ?? 0, { total, packet in
                  total + ((try packet.fields.value("chunk", as: CentralBody.self)?.value("audio", as: CentralBody.self)?.value("bytes", as: Int.self)) ?? 0)
              }) <= 33_554_432 else { playback.resource.remove(); throw CentralTextError.invalidPacket }
        voiceReceived[seq] = playback.packet
        if pendingVoice == nil { pendingVoice = playback } else { voiceQueue.append(playback) }
        voiceBinding = (binding, ownerPairingIdentity)
    }
    mutating func takeVoicePlayback() throws -> CentralVoicePlayback? {
        guard !voiceRetryRequired, playingVoice == nil, let playback = pendingVoice, let header, let accepted else { return nil }
        if try (try header.fields.value("reply_mode", as: String.self)) == "text_and_voice", presentation?.isFinal != true { return nil }
        let fields = header.fields, chunk = (try playback.packet.fields.value("chunk", as: CentralBody.self))
        guard let binding, (try fields.value("reply_phase", as: String.self)) == "sealed", ["voice", "text_and_voice"].contains((try fields.value("reply_mode", as: String.self)) ?? ""),
              (try fields.value("voice_transport", as: String.self)) == AssistantCentralTextWire.voiceTransport,
              (try fields.value("reply_epoch", as: Int.self)) != cancelledVoiceEpoch,
              eventID == (try playback.packet.fields.value("event_id", as: String.self)),
              (try fields.value("processed_event_id", as: String.self)) == (try playback.packet.fields.value("processed_event_id", as: String.self)),
              (try fields.value("processed_event_id", as: String.self)) == (try accepted.fields.value("processed_event_id", as: String.self)),
              (try fields.value("output_plan", as: [CentralBody].self))?.count == 1, let plan = (try fields.value("output_plan", as: [CentralBody].self))?.first,
              (try plan.value("target_device_id", as: String.self)) == binding.deviceID, (try plan.value("output_modes", as: [String].self))?.contains("voice") == true,
              (try chunk?.value("target_device_id", as: String.self)) == binding.deviceID, (try chunk?.value("route_version", as: String.self)) == (try plan.value("route_version", as: String.self)),
              (try chunk?.value("reply_id", as: String.self)) == (try fields.value("reply_id", as: String.self)), (try chunk?.value("reply_epoch", as: Int.self)) == (try fields.value("reply_epoch", as: Int.self)),
              (try chunk?.value("output_id", as: String.self))?.hasPrefix("voice:") == true, (try chunk?.value("seq", as: Int.self)) == voicePlayed + 1,
              try voicePacket.map { try $0.fields.value("chunk", as: CentralBody.self)?.value("output_id", as: String.self) == chunk?.value("output_id", as: String.self) } ?? true,
              (try chunk?.value("text_range", as: CentralBody.self)?.value("start", as: Int.self)) == 0,
              ((try fields.value("reply_mode", as: String.self)) == "voice" ? ((try chunk?.value("text_range", as: CentralBody.self)?.value("end", as: Int.self)) ?? 0) > 0
                : (try chunk?.value("text_range", as: CentralBody.self)?.value("end", as: Int.self)) == presentation?.text.unicodeScalars.count) else { throw CentralTextError.contextChanged() }
        pendingVoice = voiceQueue.isEmpty ? nil : voiceQueue.removeFirst(); playingVoice = playback; voicePacket = playback.packet
        voiceConfirmed = false
        status = "原 WAV 已校验；原生播放中，尚无 played 确认"
        return playback
    }
    mutating func voiceCompleted(_ playback: CentralVoicePlayback, successfully: Bool, observedAt: String) throws -> Data? {
        guard playingVoice == playback, let chunk = (try playback.packet.fields.value("chunk", as: CentralBody.self)),
              (try chunk.value("reply_epoch", as: Int.self)) != cancelledVoiceEpoch, let dID = (try accepted?.fields.value("processed_event_id", as: String.self)) else { throw CentralTextError.contextChanged() }
        playingVoice = nil
        guard successfully else { voiceRetryRequired = true; status = "原生播放失败；没有 played 确认"; return nil }
        voicePlayed = try chunk.value("seq", as: Int.self)!
        voiceReceipts[voicePlayed] = VoiceReceipt(packet: playback.packet, observedAt: observedAt)
        voiceObservedAt = observedAt
        voiceACK = try AssistantCentralTextWire.acknowledge(packet: playback.packet, processedID: dID, observedAt: observedAt, status: "played")
        voiceConfirmed = false; revision &+= 1
        status = "原生播放完成；服务端确认尚未收到"
        return voiceACK
    }
    var canRetryVoiceGeneration: Bool {
        get throws {
            guard binding?.voiceTransport == AssistantCentralTextWire.voiceTransport,
                  let header, let epoch = try header.fields.value("reply_epoch", as: Int.self),
                  cancelledVoiceEpoch != epoch else { return false }
            return try header.fields.value("voice_status", as: String.self) == "failed"
        }
    }
    var canRetryVoicePlayback: Bool { voiceRetryRequired && cancelledVoiceEpoch == nil }
    mutating func retryVoicePlayback() throws {
        guard canRetryVoicePlayback else { throw CentralTextError.unavailable }
        voiceRetryRequired = false; voicePacket = voiceReceipts[voicePlayed]?.packet
        voiceReceived = voiceReceived.filter { $0.key <= voicePlayed }; releaseQueuedVoice(); playingVoice = nil
    }
    mutating func voiceFailed(_ packet: CentralTextPacket) throws {
        if let id = try packet.fields.value("event_id", as: String.self), var observed = pending[id] {
            try observed.voiceFailed(packet); pending[id] = observed
            return
        }
        guard try (try packet.fields.value("processed_event_id", as: String.self)) == (try accepted?.fields.value("processed_event_id", as: String.self)) else { return }
        voiceRetryRequired = true; releaseQueuedVoice()
        status = "语音传输失败；文字保留，可主动重读原 WAV"
    }
    mutating func cancelVoice() throws {
        let pending = pendingVoice
        releaseQueuedVoice(); playingVoice = nil
        cancelledVoiceEpoch = try header?.fields.value("reply_epoch", as: Int.self) ?? pending?.packet.fields.value("chunk", as: CentralBody.self)?.value("reply_epoch", as: Int.self)
        status = "本地播放窗口已关闭；远端取消尚未确认"
    }
    private mutating func releaseDiscardedVoice() {
        releaseQueuedVoice()
        playingVoice?.resource.remove()
        for var observed in pending.values { observed.releaseDiscardedVoice() }
    }
    private mutating func releaseQueuedVoice() {
        pendingVoice?.resource.remove(); voiceQueue.forEach { $0.resource.remove() }
        pendingVoice = nil; voiceQueue = []
    }
    private var resultNotice: String {
        get throws {
            try (try header?.fields.value("result_status", as: String.self)) == "failed" ? "；业务结果为失败" : ""
        }
    }

    mutating func consumedByUI(_ displayed: CentralTextPresentation, observedAt: String) throws -> Data? {
        // Display callbacks can outlive their session. They do not submit an operation or ACK a new binding.
        guard displayed.binding == binding else { return nil }
        if displayed != presentation {
            guard displayed.packet != presentation?.packet else { throw CentralTextError.invalidPacket }
            return try consumeRetained(displayed, observedAt: observedAt)
        }
        guard displayed == presentation, displayed.binding == binding,
              let chunk = (try displayed.packet.fields.value("chunk", as: CentralBody.self)), let seq = (try chunk.value("seq", as: Int.self)),
              let processedID = (try accepted?.fields.value("processed_event_id", as: String.self)) else { throw CentralTextError.invalidPacket }
        guard try (try header?.fields.value("reply_phase", as: String.self)) == "sealed",
              seq > max(renderedSequence, (try header?.fields.value("rendered_text_through_seq", as: Int.self)) ?? 0) else { return nil }
        let ack = try AssistantCentralTextWire.acknowledge(packet: displayed.packet, processedID: processedID, observedAt: observedAt)
        revision &+= 1
        renderedSequence = seq
        renderedPacket = displayed.packet
        renderedObservedAt = observedAt
        renderedACK = ack
        ackConfirmed = false
        status = "文字已由界面消费；服务端确认尚未收到" + (try resultNotice)
        return ack
    }
    private mutating func clearActive(preserveMemory: Bool = false) throws {
        let savedControls = controls, savedRetained = retained, savedPending = pending, savedRunOrder = observedRunOrder
        let savedMemory = memoryProposals, savedMemoryStatus = memoryStatus, savedDecision = memoryDecision
        let savedOrigin = memoryOriginD, savedBinding = memoryBinding, savedVoiceTurn = voiceTurn, savedErrands = errands
        let savedCall = call, savedOwner = ownerVoice
        try reset(binding: binding, ownerPairingIdentity: ownerPairingIdentity)
        // A new request never ends a live call (the call has its own open/close); only a session reset does.
        voiceTurn = savedVoiceTurn; errands = savedErrands; call = savedCall; ownerVoice = savedOwner
        observedRunOrder = 0
        accepted = nil; eventID = nil; header = nil; cancelledVoiceEpoch = nil
        pendingVoice = nil; playingVoice = nil; voicePacket = nil; voiceACK = nil
        voiceObservedAt = nil; voiceConfirmed = false; voiceBinding = nil
        voiceReceived = [:]; voiceReceipts = [:]; voicePlayed = 0
        memoryProposals = []; memoryOriginD = nil; memoryBinding = nil; memoryDecision = nil
        memoryStatus = "待批记录尚未读取"
        controls = savedControls.filter { $0.value.operation != "memory_proposals" }; retained = savedRetained; pending = savedPending; observedRunOrder = savedRunOrder
        if preserveMemory {
            memoryProposals = savedMemory; memoryStatus = savedMemoryStatus; memoryDecision = savedDecision
            memoryOriginD = savedOrigin; memoryBinding = savedBinding
        }
    }
    private mutating func retireCurrent() throws {
        guard try (try needsRetention) else { return }
        guard let accepted, let dID = (try accepted.fields.value("processed_event_id", as: String.self)), let header, (try canRetain) else { throw CentralTextError.unavailable }
        if retained.count >= 16 {
            guard let released = try retained.keys.sorted().first(where: { try retained[$0]?.canReleaseUnknownAfterNewSubmit == true }) else {
                throw CentralTextError.unavailable
            }
            retained.removeValue(forKey: released)
        }
        retained[dID] = RetainedDelivery(accepted: accepted, header: header,
            displayed: presentation?.packet, textDigest: presentation.map { Data(SHA256.hash(data: Data($0.text.utf8))) },
            renderedACK: renderedACK, renderedPacket: renderedPacket, observedAt: renderedObservedAt,
            sequence: renderedSequence, confirmed: ackConfirmed,
            voicePacket: voicePacket, voiceACK: voiceACK, voiceObservedAt: voiceObservedAt, voiceConfirmed: voiceConfirmed, voiceReceipts: voiceReceipts)
    }
    mutating func requestMemoryProposals(controlID: String) throws -> Data {
        guard binding != nil, let dID = (try accepted?.fields.value("processed_event_id", as: String.self)), controls.count < 16 else { throw CentralTextError.unavailable }
        memoryBinding = binding
        let sourceD = memoryOriginD ?? dID
        memoryOriginD = sourceD
        let bytes = try AssistantCentralTextWire.control(operation: "memory_proposals", controlID: controlID, processedID: sourceD)
        controls[controlID] = Control(operation: "memory_proposals", processedID: sourceD,
            epoch: nil, bytes: bytes, proposal: nil, choice: nil)
        memoryStatus = "读取本次原提交的待批记录；尚未确认"
        revision &+= 1
        return bytes
    }
    func canDecideMemory(_ proposal: CentralMemoryProposal) throws -> Bool {
        try (try canBeginSubmit) && controls.count < 16 && proposal.origin.processed_event_id == memoryOriginD
            && proposal.decision == nil && proposal.receipt == nil
            && memoryDecision?.decision?.command_id != proposal.command.command_id
            && memoryDecision?.receipt?.command_id != proposal.command.command_id
    }
    mutating func decideMemory(_ proposal: CentralMemoryProposal, choice: CentralMemoryDecision.Choice, controlID: String) throws -> Data {
        guard binding != nil, accepted != nil, try canDecideMemory(proposal),
              memoryProposals.contains(where: { $0.proposal_ref == proposal.proposal_ref &&
                  $0.command.payload_sha256 == proposal.command.payload_sha256 && $0.command.command_id == proposal.command.command_id && $0.decision == nil && $0.receipt == nil }),
              proposal.origin.processed_event_id == memoryOriginD else { throw CentralTextError.unavailable }
        let bytes = try AssistantCentralTextWire.control(operation: "memory_decide", controlID: controlID, processedID: proposal.origin.processed_event_id, memoryProposal: proposal, memoryChoice: choice)
        controls[controlID] = Control(operation: "memory_decide", processedID: proposal.origin.processed_event_id,
            epoch: nil, bytes: bytes, proposal: proposal, choice: choice)
        memoryStatus = "决定请求发送中；是否记录尚未确认"
        revision &+= 1
        return bytes
    }
    func retryMemoryControl(_ controlID: String) throws -> Data {
        guard binding != nil, let control = controls[controlID], control.operation.hasPrefix("memory_") else { throw CentralTextError.unavailable }
        return control.bytes
    }
    private mutating func acceptMemory(_ packet: CentralTextPacket) throws {
        let f = packet.fields
        guard let id = (try f.value("control_id", as: String.self)) else { throw CentralTextError.contextChanged() }
        if controls[id] == nil, (try f.value("operation", as: String.self)) == "memory_decision", let prior = memoryDecision,
           let decision = prior.decision, decision.control_id == id, let next = (try f.value("outcome", as: CentralMemoryOutcome.self)),
           next.status == prior.status, next.execution?.status == prior.execution?.status,
           next.proposal_ref == prior.proposal_ref, next.decision?.control_id == id,
           next.decision?.decision == decision.decision, next.decision?.session_id == decision.session_id,
           next.decision?.event_id == decision.event_id, next.decision?.decision_ref == decision.decision_ref,
           next.decision?.command_id == decision.command_id,
           next.decision?.payload_sha256 == decision.payload_sha256,
           next.accepted?.processed_event.processed_event_id == (try accepted?.fields.value("processed_event_id", as: String.self)) { return }
        guard let control = controls[id] else { throw CentralTextError.contextChanged() }
        if try (try f.value("operation", as: String.self)) == "memory_proposals" {
            guard control.operation == "memory_proposals", (try f.value("processed_event_id", as: String.self)) == control.processedID,
                  (control.processedID == (try accepted?.fields.value("processed_event_id", as: String.self)) || control.processedID == memoryOriginD), let proposals = (try f.value("proposals", as: [CentralMemoryProposal].self)),
                  proposals.count <= 256, proposals.allSatisfy({ $0.origin.processed_event_id == control.processedID &&
                      $0.origin.session_id == binding?.sessionID }) else { throw CentralTextError.contextChanged() }
            memoryOriginD = control.processedID
            memoryProposals = proposals
            memoryStatus = proposals.isEmpty ? "本次原提交没有待批记录" : "待批记录来自本次原提交；记忆提交尚未确认"
            controls.removeValue(forKey: id)
            return
        }
        guard control.operation == "memory_decide", let proposal = control.proposal,
              let outcome = (try f.value("outcome", as: CentralMemoryOutcome.self)) else { throw CentralTextError.contextChanged() }
        if outcome.status == .already_committed {
            guard let receipt = outcome.receipt, receipt.command_id == proposal.command.command_id,
                  receipt.payload_sha256 == proposal.command.payload_sha256, receipt.version > 0 else { throw CentralTextError.invalidPacket }
            memoryStatus = "记录已提交，版本 " + String(receipt.version)
            controls.removeValue(forKey: id)
        } else {
            guard let decision = outcome.decision, decision.control_id == id,
                  decision.command_id == proposal.command.command_id, decision.payload_sha256 == proposal.command.payload_sha256,
                  decision.decision == control.choice, decision.session_id == binding?.sessionID,
                  outcome.proposal_ref == proposal.proposal_ref, let execution = outcome.execution else { throw CentralTextError.contextChanged() }
            memoryStatus = "决定已记录；记忆提交尚未确认"
            if execution.status == .accepted {
                guard let next = outcome.accepted, next.processed_event.event_id == decision.event_id else { throw CentralTextError.invalidPacket }
                memoryStatus += "；等待原接纳通知"

            } else {
                guard outcome.accepted == nil else { throw CentralTextError.invalidPacket }
                memoryStatus += "；执行未知：" + (execution.error_code ?? "unknown")
            }
        }
        memoryDecision = outcome
    }
    private static func checkHeader(_ fields: CentralBody, prior: CentralBody) throws {
        guard try (try prior.value("reply_phase", as: String.self)) != "interrupted" || (try fields.value("reply_phase", as: String.self)) == "interrupted",
              try (try fields.value("run_id", as: String.self)) == (try prior.value("run_id", as: String.self)) && (try fields.value("reply_id", as: String.self)) == (try prior.value("reply_id", as: String.self)) && (try fields.value("reply_mode", as: String.self)) == (try prior.value("reply_mode", as: String.self)),
              (try fields.value("reply_epoch", as: Int.self)) == (try prior.value("reply_epoch", as: Int.self)), (try fields.value("text_chunk_count", as: Int.self)) == (try prior.value("text_chunk_count", as: Int.self)),
              ((try fields.value("rendered_text_through_seq", as: Int.self)) ?? 0) >= ((try prior.value("rendered_text_through_seq", as: Int.self)) ?? 0),
              ((try fields.value("result_revision", as: Int.self)) ?? 0) >= ((try prior.value("result_revision", as: Int.self)) ?? 0),
              (try fields.value("output_plan", as: [CentralBody].self)?.first?.value("route_version", as: String.self)) == (try prior.value("output_plan", as: [CentralBody].self)?.first?.value("route_version", as: String.self)),
              (try fields.value("output_plan", as: [CentralBody].self)?.first?.value("target_device_id", as: String.self)) == (try prior.value("output_plan", as: [CentralBody].self)?.first?.value("target_device_id", as: String.self)) else { throw CentralTextError.contextChanged() }
    }
    private static func checkACK(_ fields: CentralBody, header: CentralTextPacket?, expected: CentralTextPacket?, sequence: Int, observedAt: String?, status: String = "rendered") throws {
        guard try (try header?.fields.value("reply_phase", as: String.self)) == "sealed", let expected = (try expected?.fields.value("chunk", as: CentralBody.self)),
              let receipt = (try fields.value("receipt", as: CentralBody.self)), (try receipt.value("status", as: String.self)) == status, (try receipt.value("highest_contiguous_seq", as: Int.self)) == sequence,
              try (try receipt.value("output_id", as: String.self)) == (try expected.value("output_id", as: String.self)) && (try receipt.value("reply_id", as: String.self)) == (try expected.value("reply_id", as: String.self)) && (try receipt.value("target_device_id", as: String.self)) == (try expected.value("target_device_id", as: String.self)) && (try receipt.value("route_version", as: String.self)) == (try expected.value("route_version", as: String.self)),
              (try receipt.value("reply_epoch", as: Int.self)) == (try expected.value("reply_epoch", as: Int.self)), (try receipt.value("observed_at", as: String.self)) == observedAt else { throw CentralTextError.contextChanged() }
    }
    private mutating func acceptRetained(_ packet: CentralTextPacket, processedID: String) throws {
        guard var old = retained[processedID] else { throw CentralTextError.contextChanged() }
        let f = packet.fields
        if try (try f.value("operation", as: String.self)) == "ack_receipt" {
            if try (try f.value("receipt", as: CentralBody.self)?.value("status", as: String.self)) == "played" {
                guard let seq = try f.value("receipt", as: CentralBody.self)?.value("highest_contiguous_seq", as: Int.self),
                      let fact = old.voiceReceipts[seq] else { throw CentralTextError.contextChanged() }
                try Self.checkACK(f, header: old.header, expected: fact.packet, sequence: seq, observedAt: fact.observedAt, status: "played")
                old.voiceConfirmed = try old.voiceConfirmed || seq == (old.voicePacket?.fields.value("chunk", as: CentralBody.self)?.value("seq", as: Int.self))
            } else {
                try Self.checkACK(f, header: old.header, expected: old.renderedPacket, sequence: old.sequence, observedAt: old.observedAt)
                old.confirmed = true
            }
        } else {
            guard try (try f.value("event_id", as: String.self)) == (try old.accepted.fields.value("event_id", as: String.self)), let total = (try f.value("text_chunk_count", as: Int.self)),
                  let watermark = (try f.value("rendered_text_through_seq", as: Int.self)), watermark <= total,
                  (try f.value("pending_text_chunk_count", as: Int.self)) == total - watermark else { throw CentralTextError.contextChanged() }
            try Self.checkHeader(f, prior: old.header.fields)
            guard try total == 0 || (((try f.value("reply_phase", as: String.self)) == "sealed" && (try f.value("reply_status", as: String.self)) == "complete") || (try f.value("reply_phase", as: String.self)) == "interrupted"),
                  try total == 0 || (try f.value("output_plan", as: [CentralBody].self))?.count == 1 && (try f.value("output_plan", as: [CentralBody].self)?.first?.value("output_modes", as: [String].self))?.contains("text") == true else { throw CentralTextError.invalidPacket }
            old.header = packet
            guard let phase = try f.value("reply_phase", as: String.self),
                  let voiceStatus = try f.value("voice_status", as: String.self) else { throw CentralTextError.invalidPacket }
            let generationStatus = voiceStatus == "reconcile_required" ? "unknown（reconcile_required）" : voiceStatus
            let received = phase == "interrupted" ? "interrupted" : generationStatus
            status = "已收到较早语音生成状态：" + received + "；没有新增播放确认"
            if try (try f.value("reply_phase", as: String.self)) != "sealed" || watermark >= old.sequence { old.renderedACK = nil }
        }
        retained[processedID] = (try old.unsettled) ? old : nil
    }
    private mutating func consumeRetained(_ displayed: CentralTextPresentation, observedAt: String) throws -> Data? {
        guard let id = (try displayed.packet.fields.value("processed_event_id", as: String.self)) else { throw CentralTextError.invalidPacket }
        // Settled results are no longer retained, but their rows can still appear again.
        guard var old = retained[id] else { return nil }
        guard displayed.packet == old.displayed, old.textDigest == Data(SHA256.hash(data: Data(displayed.text.utf8))),
              let chunk = (try displayed.packet.fields.value("chunk", as: CentralBody.self)), let seq = (try chunk.value("seq", as: Int.self)) else { throw CentralTextError.invalidPacket }
        guard try (try old.header.fields.value("reply_phase", as: String.self)) == "sealed", seq > max(old.sequence, (try old.header.fields.value("rendered_text_through_seq", as: Int.self)) ?? 0) else { return nil }
        let bytes = try AssistantCentralTextWire.acknowledge(packet: displayed.packet, processedID: id, observedAt: observedAt)
        old.sequence = seq; old.observedAt = observedAt; old.renderedPacket = displayed.packet
        old.renderedACK = bytes; old.confirmed = false
        retained[id] = old
        revision &+= 1
        return bytes
    }

}


// Owned WAV resource validation. SDK remains the framing/order/trailer owner.
struct CentralVoiceFile: Equatable, Sendable {
    let file: URL
    private init(file: URL) { self.file = file }
    static func receive<S: AsyncSequence>(_ reader: S, audio: CentralBody) async throws -> CentralVoiceFile where S.Element == Data {
        guard let expected = (try audio.value("bytes", as: Int.self)), (44...33_554_432).contains(expected), let digest = (try audio.value("sha256", as: String.self)) else { throw CentralTextError.invalidPacket }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("paios-formal-voice-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let file = directory.appendingPathComponent("output.wav")
        var completed = false
        defer { if !completed { try? FileManager.default.removeItem(at: directory) } }
        guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw CentralTextError.unavailable }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        var size = 0, hash = SHA256()
        for try await chunk in reader {
            try Task.checkCancellation()
            guard chunk.count <= expected - size else { throw CentralTextError.invalidPacket }
            try handle.write(contentsOf: chunk); hash.update(data: chunk); size += chunk.count
        }
        try Task.checkCancellation()
        guard size == expected, hash.finalize().map({ String(format: "%02x", $0) }).joined() == digest else { throw CentralTextError.invalidPacket }
        try handle.synchronize()
        completed = true
        return Self(file: file)
    }
    func validate(chunk: CentralBody) throws {
        let bytes = try Data(contentsOf: file, options: .mappedIfSafe)
        func u16(_ offset: Int) -> Int { Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 }
        func u32(_ offset: Int) -> Int { u16(offset) | u16(offset + 2) << 16 }
        func tag(_ offset: Int) -> String { String(decoding: bytes[offset..<offset+4], as: UTF8.self) }
        guard bytes.count >= 44, bytes.count == (try chunk.value("audio", as: CentralBody.self)?.value("bytes", as: Int.self)), tag(0) == "RIFF", tag(8) == "WAVE", u32(4) + 8 == bytes.count else { throw CentralTextError.invalidPacket }
        var offset = 12, rate = 0, channels = 0, payload = 0
        while offset + 8 <= bytes.count {
            let count = u32(offset + 4), start = offset + 8
            guard count <= bytes.count - start else { throw CentralTextError.invalidPacket }
            if tag(offset) == "fmt " {
                guard count >= 16, u16(start) == 1, u16(start + 14) == 16 else { throw CentralTextError.invalidPacket }
                channels = u16(start + 2); rate = u32(start + 4)
                guard (1...2).contains(channels), rate > 0, u16(start + 12) == channels * 2,
                      u32(start + 8) == rate * channels * 2 else { throw CentralTextError.invalidPacket }
            }
            if tag(offset) == "data" { payload = count }
            offset = start + count + (count % 2)
        }
        guard try (try chunk.value("codec", as: String.self)) == "pcm_s16le", rate == (try chunk.value("sample_rate", as: Int.self)), channels == (try chunk.value("channels", as: Int.self)),
              rate > 0, (1...2).contains(channels), payload > 0, payload % (channels * 2) == 0,
              Int((Double(payload) * 1000 / Double(rate * channels * 2)).rounded()) == (try chunk.value("audio", as: CentralBody.self)?.value("duration_ms", as: Int.self)) else { throw CentralTextError.invalidPacket }
    }
    func remove() { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
}
