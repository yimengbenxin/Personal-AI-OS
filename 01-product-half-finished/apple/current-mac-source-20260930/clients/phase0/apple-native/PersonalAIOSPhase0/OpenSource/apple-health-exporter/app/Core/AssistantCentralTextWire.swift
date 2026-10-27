import Foundation
import VoiceWake
import CoreFoundation
import CryptoKit

struct CentralTransportBinding: Equatable, Sendable {
    let sessionID: String
    let deviceID: String
    let connectionEpoch: String
    let expectedGatewayIdentity: String
    let maxPacketBytes: Int
    var deviceClass: String? = nil
    var voiceTransport: String? = nil
    var callRejoinWindowS: Int? = nil
}

enum AssistantTextOwner: String, CaseIterable, Sendable {
    case legacy
    case centralCandidate
}

enum CentralTextError: Error, Equatable, CustomStringConvertible {
    case invalidPacket, unavailable
    case contextChanged(fileID: String = #fileID, line: UInt = #line)

    // Diagnostic metadata must not become user-facing text in other clients.
    var description: String {
        switch self {
        case .invalidPacket: return "invalidPacket"
        case .unavailable: return "unavailable"
        case .contextChanged: return "contextChanged"
        }
    }
}

// One immutable original JSON object. The canonical schema owns protocol field declarations.
struct CentralBody: @unchecked Sendable {
    private let raw: [String: Any]
    fileprivate init(_ raw: [String: Any]) { self.raw = raw }
    private func present(_ name: String) -> Any? {
        guard let value = raw[name], !(value is NSNull) else { return nil }
        return value
    }
    func value<T: Decodable>(_ name: String, as type: T.Type) throws -> T? {
        guard let value = present(name) else { return nil }
        do { return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)) }
        catch { throw CentralTextError.invalidPacket }
    }
    func value(_ name: String, as type: CentralBody.Type) throws -> CentralBody? {
        guard let value = present(name) else { return nil }
        guard let object = value as? [String: Any] else { throw CentralTextError.invalidPacket }
        return CentralBody(object)
    }
    func value(_ name: String, as type: [CentralBody].Type) throws -> [CentralBody]? {
        guard let value = present(name) else { return nil }
        guard let objects = value as? [[String: Any]] else { throw CentralTextError.invalidPacket }
        return objects.map(CentralBody.init)
    }
}

indirect enum CentralJSONValue: Decodable, Sendable {
    case null, boolean(Bool), number(Double), string(String)
    case array([CentralJSONValue]), object([String: CentralJSONValue])
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let decoded = try? value.decode(Bool.self) { self = .boolean(decoded) }
        else if let decoded = try? value.decode(String.self) { self = .string(decoded) }
        else if let decoded = try? value.decode(Double.self) { self = .number(decoded) }
        else if let decoded = try? value.decode([CentralJSONValue].self) { self = .array(decoded) }
        else { self = .object(try value.decode([String: CentralJSONValue].self)) }
    }
}

// Read-only projections of the original MEM source DTO; no authorization or digest algorithm.
struct CentralMemoryProposal: Decodable, Sendable, Identifiable {
    enum Binding: String, Decodable { case supported }
    let binding_status: Binding
    let proposal_ref: String
    let command: Command
    let origin: Origin
    let decision: CentralMemoryDecision?
    let receipt: CentralMemoryReceipt?
    var id: String { proposal_ref }
    struct Command: Decodable, Sendable {
        enum Operation: String, Decodable { case create, correct, review, delete, retract, deny }
        let command_id: String
        let payload_sha256: String
        let operation: Operation
        let expected_version: Int
        let assertion: Assertion
        let evidence_refs: [Evidence]
    }
    struct Assertion: Decodable, Sendable {
        enum Status: String, Decodable { case candidate, active, retracted, deleted }
        enum Applicability: String, Decodable { case applicable, stopped, needs_reevaluation }
        let assertion_id: String
        let subject_ref: Subject
        let status: Status
        let applicability_status: Applicability
        struct Subject: Decodable, Sendable {
            enum Kind: String, Decodable { case known_person, speaker_cluster, unknown_subject }
            let type: Kind
            let id: String
        }
        let predicate: String
        let value: CentralJSONValue
        let unknown_conditions: [String]
        let conflicts: [String]
        let evidence_status: String
        let confidence: Double?
    }
    struct Evidence: Decodable, Sendable {
        let event_id: String
        let processed_event_id: String
        let raw_ref: String
        let archive_revision: String
    }
    struct Origin: Decodable, Sendable {
        let run_id: String
        let session_id: String
        let tool_call_id: String
        let processed_event_id: String
    }
}
struct CentralMemoryDecision: Decodable, Sendable {
    enum Choice: String, Codable { case approve, reject }
    let command_id: String
    let payload_sha256: String
    let decision: Choice
    let control_id: String
    let decision_ref: String
    let event_id: String
    let session_id: String
}
struct CentralMemoryReceipt: Decodable, Sendable {
    enum Status: String, Decodable { case committed }
    let status: Status
    let receipt_ref: String
    let command_id: String
    let payload_sha256: String
    let assertion_id: String
    let version: Int
    let committed_at: String
}
struct CentralMemoryOutcome: Decodable, Sendable {
    enum Status: String, Decodable { case decision_recorded, already_committed }
    let status: Status
    let proposal_ref: String?
    let decision: CentralMemoryDecision?
    let receipt: CentralMemoryReceipt?
    let execution: Execution?
    let accepted: Accepted?
    struct Execution: Decodable, Sendable {
        enum Status: String, Decodable { case accepted, unknown }
        let status: Status
        let error_code: String?
    }
    struct Accepted: Decodable, Sendable {
        let processed_event: Event
        struct Event: Decodable, Sendable {
            let event_id: String
            let processed_event_id: String
        }
    }
}

private struct CentralMemoryPayload: Decodable {
    let proposals: [CentralMemoryProposal]?
    let outcome: CentralMemoryOutcome?
}

struct CentralTextPacket: Equatable, Sendable {
    let bytes: Data
    let fields: CentralBody
    // This is an envelope-only diagnostic, not a validated payment output DTO.
    let unsupportedPaymentWireVersion: Int?
    init(bytes: Data, fields: CentralBody, unsupportedPaymentWireVersion: Int? = nil) {
        self.bytes = bytes
        self.fields = fields
        self.unsupportedPaymentWireVersion = unsupportedPaymentWireVersion
    }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.bytes == rhs.bytes }
}

private final class CentralWireBundle: NSObject {}

enum AssistantCentralTextWire {
    static let contractSHA256 = "9dc8b39792e2fc11371df23b2aaf9be7c3d0bb38315023045bc33e4826c605c0"
    // Default JSONSerialization creates immutable containers and leaves.
    // This private value never escapes the schema owner and has no mutation API.
    private struct ImmutableContract: @unchecked Sendable {
        private let value: [String: Any]
        init(_ value: [String: Any]) { self.value = value }
        subscript(_ key: String) -> Any? { value[key] }
    }
    private static let contract: ImmutableContract? = {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: CentralWireBundle.self)
        #endif
        guard let url = bundle.url(forResource: "formal-message.v1", withExtension: "json", subdirectory: "Contracts"),
              let bytes = try? Data(contentsOf: url), bytes.count <= 262_144,
              SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == contractSHA256,
              let value = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              (value["version"] as? Int) == 1 else { return nil }
        return ImmutableContract(value)
    }()
    private static let extensionContracts: [String: ImmutableContract]? = {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: CentralWireBundle.self)
        #endif
        guard let entries = contract?["extensions"] as? [[String: Any]] else { return nil }
        var loaded: [String: ImmutableContract] = [:]
        for entry in entries {
            guard let name = entry["contract"] as? String, name.hasSuffix(".json"), !name.contains("/"),
                  let pin = entry["sha256"] as? String, let version = entry["version"] as? Int,
                  loaded[name] == nil,
                  let url = bundle.url(forResource: String(name.dropLast(5)), withExtension: "json", subdirectory: "Contracts"),
                  let bytes = try? Data(contentsOf: url), bytes.count <= 262_144,
                  SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == pin,
                  let value = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
                  (value["version"] as? Int) == version else { return nil }
            loaded[name] = ImmutableContract(value)
        }
        return loaded
    }()
    private static var paymentContract: ImmutableContract? { extensionContracts?["payment-message.v1.json"] }
    static var inputTopic: String { contract?["input_topic"] as? String ?? "" }
    static var outputTopic: String { contract?["output_topic"] as? String ?? "" }
    static var schema: String { contract?["schema"] as? String ?? "" }
    // Canonical validation checks primitive types and closed shapes. Native Codable also checks the MEM DTO.
    private static func valid(_ value: Any, _ definition: [String: Any], source: ImmutableContract? = contract) -> Bool {
        if definition.isEmpty { return true }
        if let reference = definition["$ref"] as? String {
            guard reference.hasPrefix("#/$defs/"), let definitions = source?["$defs"] as? [String: [String: Any]],
                  let target = definitions[String(reference.dropFirst(8))] else { return false }
            return valid(value, target, source: source)
        }
        if let excluded = definition["not"] as? [String: Any], valid(value, excluded, source: source) { return false }
        if let parts = definition["allOf"] as? [[String: Any]], !parts.allSatisfy({ valid(value, $0, source: source) }) { return false }
        if let parts = definition["anyOf"] as? [[String: Any]], !parts.contains(where: { valid(value, $0, source: source) }) { return false }
        if let parts = definition["oneOf"] as? [[String: Any]], parts.filter({ valid(value, $0, source: source) }).count != 1 { return false }
        if let condition = definition["if"] as? [String: Any] {
            let branch = valid(value, condition, source: source) ? "then" : "else"
            if let schema = definition[branch] as? [String: Any], !valid(value, schema, source: source) { return false }
        }
        if definition["type"] == nil, definition["properties"] != nil || definition["required"] != nil {
            guard let values = value as? [String: Any] else { return true }
            let required = definition["required"] as? [String] ?? []
            let properties = definition["properties"] as? [String: [String: Any]] ?? [:]
            guard required.allSatisfy({ values[$0] != nil }), values.allSatisfy({ key, field in
                properties[key].map { valid(field, $0, source: source) } ?? true
            }) else { return false }
        }
        if let types = definition["type"] as? [String] {
            return types.contains { type in
                var typed = definition; typed["type"] = type
                return valid(value, typed, source: source)
            }
        }
        if let literal = definition["const"] {
            return CFGetTypeID(value as CFTypeRef) == CFGetTypeID(literal as CFTypeRef)
                && (value as? NSObject)?.isEqual(literal) == true
        }
        if let choices = definition["enum"] as? [Any] { return choices.contains { valid(value, ["const": $0], source: source) } }
        switch definition["type"] as? String {
        case "null": return value is NSNull
        case "object":
            guard let values = value as? [String: Any] else { return false }
            guard let properties = definition["properties"] as? [String: [String: Any]] else { return true }
            let required = definition["required"] as? [String] ?? []
            let dependencies = definition["dependencies"] as? [String: [String]] ?? [:]
            guard dependencies.allSatisfy({ key, fields in
                values[key] == nil || fields.allSatisfy { values[$0] != nil }
            }) else { return false }
            return required.allSatisfy { values[$0] != nil } && values.allSatisfy { key, field in
                properties[key].map { valid(field, $0, source: source) } ?? (definition["additionalProperties"] as? Bool != false)
            }
        case "array":
            guard let values = value as? [Any], let items = definition["items"] as? [String: Any],
                  values.count >= (definition["minItems"] as? Int ?? 0),
                  values.count <= (definition["maxItems"] as? Int ?? Int.max) else { return false }
            return values.allSatisfy { valid($0, items, source: source) }
                && (definition["uniqueItems"] as? Bool != true || values.enumerated().allSatisfy { index, item in
                    !values.prefix(index).contains { valid(item, ["const": $0], source: source) }
                })
        case "boolean":
            return (value as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true
        case "integer":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
                  let native = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed),
                  (try? JSONDecoder().decode(Int.self, from: native)) != nil else { return false }
            return number.doubleValue >= (definition["minimum"] as? Double ?? -.infinity)
                && number.doubleValue <= (definition["maximum"] as? Double ?? .infinity)
                && number.doubleValue < (definition["exclusiveMaximum"] as? Double ?? .infinity)
        case "number":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite else { return false }
            return number.doubleValue >= (definition["minimum"] as? Double ?? -.infinity)
                && number.doubleValue <= (definition["maximum"] as? Double ?? .infinity)
                && number.doubleValue > (definition["exclusiveMinimum"] as? Double ?? -.infinity)
                && number.doubleValue < (definition["exclusiveMaximum"] as? Double ?? .infinity)
        case "string":
            guard let text = value as? String, text.unicodeScalars.count >= (definition["minLength"] as? Int ?? 0),
                  text.unicodeScalars.count <= (definition["maxLength"] as? Int ?? Int.max) else { return false }
            if let pattern = definition["pattern"] as? String, text.range(of: pattern, options: .regularExpression) == nil { return false }
            if definition["format"] as? String == "paios-utc" {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return text.range(of: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", options: .regularExpression) != nil
                    && formatter.date(from: text).map { formatter.string(from: $0) == text } == true
            }
            return true
        default: return definition["type"] == nil
        }
    }
    static var voiceTopic: String { contract?["voice_topic"] as? String ?? "" }
    static var voiceTransport: String { contract?["voice_transport"] as? String ?? "" }
    static func bootstrapEnvelope(_ data: Data) throws -> CentralBody? {
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CentralTextError.invalidPacket }
        guard let value = envelope["central_text_transport"] else { return nil }
        guard let raw = value as? [String: Any], let definitions = contract?["$defs"] as? [String: [String: Any]],
              let definition = definitions["bootstrap"], valid(raw, definition) else { throw CentralTextError.invalidPacket }
        return CentralBody(raw)
    }
    static func decode(_ data: Data) throws -> CentralTextPacket {
        guard let limit = contract?["output_limit"] as? Int, !data.isEmpty, data.count <= limit else { throw CentralTextError.invalidPacket }
        let raw = try JSONSerialization.jsonObject(with: data)
        guard let object = raw as? [String: Any], let operation = object["operation"] as? String else { throw CentralTextError.invalidPacket }
        if operation == "payment_settings", let version = object["wire_version"],
           valid(version, ["type": "integer", "minimum": 1]), let number = version as? Int, number != 1 {
            guard let outputs = paymentContract?["outputs"] as? [String: [String: Any]],
                  let properties = outputs[operation]?["properties"] as? [String: [String: Any]] else { throw CentralTextError.unavailable }
            var envelope: [String: Any] = ["operation": operation, "wire_version": number]
            for field in ["schema_version", "session_id", "request_id"] {
                if field == "request_id", object[field] == nil { continue }
                guard let value = object[field], let definition = properties[field],
                      valid(value, definition, source: paymentContract) else { throw CentralTextError.invalidPacket }
                envelope[field] = value
            }
            // A future version can have a different body. Only its checked envelope reaches the payment UI gate.
            return CentralTextPacket(bytes: data, fields: CentralBody(envelope), unsupportedPaymentWireVersion: number)
        }
        guard let source = outputContract(operation),
              let outputs = source["outputs"] as? [String: [String: Any]],
              let definition = outputs[operation], valid(raw, definition, source: source) else { throw CentralTextError.invalidPacket }
        let fields = CentralBody(object)
        try AssistantPayment.validateOutput(operation: operation, data: data)
        // MEM keeps its original native DTO rejection before optional field access.
        _ = try JSONDecoder().decode(CentralMemoryPayload.self, from: data)
        guard (try fields.value("proposals", as: [CentralMemoryProposal].self))?.allSatisfy({ $0.command.expected_version >= 0 && ($0.receipt?.version ?? 1) > 0 }) ?? true,
              ((try fields.value("outcome", as: CentralMemoryOutcome.self))?.receipt?.version ?? 1) > 0 else { throw CentralTextError.invalidPacket }
        return CentralTextPacket(bytes: data, fields: fields)
    }
    static func watchEventID(deviceID: String, idempotencyKey: String) throws -> String {
        let source = ["device_id": deviceID, "idempotency_key": idempotencyKey]
        let bytes = try JSONSerialization.data(withJSONObject: source, options: [.sortedKeys, .withoutEscapingSlashes])
        return "watch:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    static func submit(eventID: String, capturedAt: String, text: String,
                       location: AssistantLocationObservation? = nil, attachments: [CentralAttachment] = []) throws -> Data {
        guard attachments.count <= 10, attachments.allSatisfy({ $0.path.utf8.count <= 1024 && $0.name.utf8.count <= 255 }) else { throw CentralTextError.invalidPacket }
        var fields: [String: Any] = ["event_id": eventID, "captured_at": capturedAt, "text": text]
        if !attachments.isEmpty { fields["attachments"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(attachments)) }
        if let location { fields["location"] = wire(location) }
        return try encode("submit", fields: fields)
    }
    /// The phone's fix as the contract's `location` (WGS-84 from CoreLocation); the agent uses it for addresses and pickups.
    static func wire(_ location: AssistantLocationObservation) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var fields: [String: Any] = ["latitude": location.latitude, "longitude": location.longitude,
                                     "accuracy_m": min(max(location.horizontalAccuracy, 0), 100_000),
                                     "observed_at": formatter.string(from: location.observedAt), "datum": "wgs84"]
        if let place = location.place, !place.isEmpty { fields["place"] = String(String.UnicodeScalarView(place.unicodeScalars.prefix(200))) }
        return fields
    }
    static func result(processedID: String, sealed: Bool = false) throws -> Data {
        var fields: [String: Any] = ["processed_event_id": processedID]
        if sealed { fields["text_replay"] = "sealed" }
        return try encode("result", fields: fields)
    }
    static func control(operation: String, controlID: String, processedID: String, replyEpoch: Int? = nil,
                        memoryProposal: CentralMemoryProposal? = nil, memoryChoice: CentralMemoryDecision.Choice? = nil) throws -> Data {
        var fields: [String: Any] = ["control_id": controlID, "processed_event_id": processedID]
        if let replyEpoch { fields["reply_epoch"] = replyEpoch }
        if let memoryProposal {
            fields["command_id"] = memoryProposal.command.command_id
            fields["payload_sha256"] = memoryProposal.command.payload_sha256
        }
        if let memoryChoice { fields["decision"] = memoryChoice.rawValue }
        return try encode(operation, fields: fields)
    }
    // Push-to-talk: the device names only the operation; refs, ranges and clocks are cut centrally.
    static func voice(_ operation: String, operationID: String, candidate: CentralVoiceCandidate? = nil) throws -> Data {
        var fields: [String: Any] = ["operation_id": operationID]
        if let candidate {
            fields["candidate_ref"] = candidate.candidateRef
            fields["candidate_revision"] = candidate.candidateRevision
            fields["window_ref"] = candidate.windowRef
            fields["selected_input_sha256"] = candidate.selectedInputSHA256
            fields["transcript_sha256"] = candidate.transcriptSHA256
        }
        return try encode(operation, fields: fields)
    }
    // Live call: the device only opens/closes; the realtime front and the main agent run centrally.
    static func call(_ operation: String, callID: String, reason: String? = nil,
                     location: AssistantLocationObservation? = nil, silenceTimeout: CallSilenceTimeout = .threeMinutes, video: Bool = false, videoRevision: UInt64 = 0, wakeWord: Bool = false, enrollmentSessionID: String? = nil, confirmedQuote: AssistantAppearanceQuote? = nil) throws -> Data {
        var fields: [String: Any] = ["call_id": callID]
        if operation == "call_avatar" {
            fields["avatar"] = video; fields["avatar_revision"] = videoRevision
            if video, let confirmedQuote {
                fields["control_id"] = "\(videoRevision):\(callID)"
                fields["confirmed_quote"] = ["quote_id": confirmedQuote.quote_id,
                    "price_text": confirmedQuote.price_text, "scope_text": confirmedQuote.scope_text]
            }
            return try encode(operation, fields: fields)
        }
        if operation == "call_open" {
            fields["silence_timeout_ms"] = silenceTimeout.rawValue
            if wakeWord { fields["wake_word"] = true }
            if let enrollmentSessionID { fields["enrollment_session_id"] = enrollmentSessionID }
        }
        if operation == "call_open" || operation == "call_video" {
            guard videoRevision <= 9_007_199_254_740_991 else { throw CentralTextError.invalidPacket }
            fields["video_revision"] = videoRevision
        }
        if operation == "call_video" || operation == "call_open" && video { fields["video"] = video }
        if let reason { fields["reason"] = reason }
        if let location { fields["location"] = wire(location) }
        return try encode(operation, fields: fields)
    }
    static func callConversationMode(callID: String, controlID: String, mode: CallConversationMode) throws -> Data {
        try encode("call_set_conversation_mode", fields: [
            "call_id": callID, "control_id": controlID, "conversation_mode": mode.rawValue
        ])
    }
    static func callRetry(callID: String, controlID: String, processedEventID: String) throws -> Data {
        try encode("call_retry", fields: [
            "call_id": callID, "control_id": controlID, "processed_event_id": processedEventID
        ])
    }
    static func callPcm(callID: String, sessionID: String, frame: WakePcmFrame) throws -> Data {
        guard (1...1600).contains(frame.samples.count) else { throw CentralTextError.invalidPacket }
        return try encode("call_pcm", fields: [
            "schema_version": "paios.central.text-envelope.v1", "session_id": sessionID,
            "call_id": callID, "seq": frame.sequence, "captured_at_ms": frame.capturedAtMs,
            "sample_rate": 16000, "pcm_s16le_base64": frame.littleEndianData.base64EncodedString()
        ])
    }
    // The phone's position for central's per-device location authority (随身模式's feed and every new fix).
    // A missing fix says why (`unavailable_reason`), so central can tell the owner what to fix.
    static func locationUpdate(_ location: AssistantLocationObservation?, requestID: String? = nil,
                               unavailable: AssistantLocationUnavailableReason? = nil, cachedFixAgeMs: Int? = nil) throws -> Data {
        var fields: [String: Any] = ["location": location.map { wire($0) as Any } ?? NSNull()]
        if let requestID { fields["request_id"] = requestID }
        if location == nil, let unavailable { fields["unavailable_reason"] = unavailable.rawValue }
        if location == nil, requestID != nil { fields["cached_fix_age_ms"] = cachedFixAgeMs.map { $0 as Any } ?? NSNull() }
        return try encode("location_update", fields: fields)
    }
    static func move(_ event: MoveEvent, lifecycleID: String? = nil) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            var value = encoder.singleValueContainer(); try value.encode(formatter.string(from: date))
        }
        var fields = try JSONSerialization.jsonObject(with: encoder.encode(event)) as! [String: Any]
        if let lifecycleID { fields["lifecycle_id"] = lifecycleID }
        return try encode(event.operation, fields: fields)
    }
    // Stop an errand the executor phone is running (the next errand_progress snapshot shows the outcome).
    static func errandCancel(jobID: String) throws -> Data { try encode("errand_cancel", fields: ["job_id": jobID]) }
    // 录入我的声音: one sentence window (open/commit/cancel) on the published microphone; central cuts and measures it.
    static func voiceprintWindow(_ operation: String, operationID: String) throws -> Data {
        guard ["voiceprint_open", "voiceprint_commit", "voiceprint_cancel"].contains(operation) else { throw CentralTextError.invalidPacket }
        return try encode(operation, fields: ["operation_id": operationID])
    }
    // Commit measured samples (the registry judges the set), forget the profile, or read its status.
    static func voiceprintControl(_ operation: String, controlID: String, sampleIDs: [String]? = nil, sourceDeviceID: String? = nil) throws -> Data {
        guard ["voiceprint_enroll", "voiceprint_forget", "voiceprint_read", "voice_trust_window_open"].contains(operation),
              (operation == "voiceprint_enroll") == (sampleIDs != nil) else { throw CentralTextError.invalidPacket }
        var fields: [String: Any] = ["control_id": controlID]
        if let sampleIDs { fields["sample_ids"] = sampleIDs }
        if let sourceDeviceID { fields["source_device_id"] = sourceDeviceID }
        return try encode(operation, fields: fields)
    }
    static func voiceEnrollment(_ action: String, controlID: String, sessionID: String?, callID: String?) throws -> Data {
        guard ["status", "start", "pause", "resume", "check", "preview", "commit", "discard"].contains(action),
              ["status", "start"].contains(action) || sessionID != nil else { throw CentralTextError.unavailable }
        var fields: [String: Any] = ["control_id": controlID, "action": action]
        if let sessionID { fields["enrollment_session_id"] = sessionID }
        if let callID { fields["call_id"] = callID }
        return try encode("voice_enrollment_control", fields: fields)
    }
    // "确认是我" for one pending prompt.
    static func careSafe(controlID: String) throws -> Data { try encode("care_safe", fields: ["control_id": controlID]) }
    static func voiceConfirm(confirmationID: String, choice: CentralVoiceConfirmationChoice? = nil, auth: String? = nil) throws -> Data {
        var fields: [String: Any] = ["confirmation_id": confirmationID]
        if let choice { fields["choice"] = choice.rawValue }
        if let auth { fields["auth"] = auth }
        return try encode("voice_confirm", fields: fields)
    }
    static func acknowledge(packet: CentralTextPacket, processedID: String, observedAt: String, status: String = "rendered") throws -> Data {
        guard let envelope = try JSONSerialization.jsonObject(with: packet.bytes) as? [String: Any],
              let chunk = envelope["chunk"] as? [String: Any],
              let definitions = contract?["$defs"] as? [String: [String: Any]],
              let properties = definitions["ack"]?["properties"] as? [String: Any] else { throw CentralTextError.invalidPacket }
        var ack = chunk.filter { properties[$0.key] != nil }
        ack["highest_contiguous_seq"] = chunk["seq"]
        ack["observed_at"] = observedAt
        ack["status"] = status
        return try encode("ack", fields: ["ack": ack, "processed_event_id": processedID])
    }
    private static func operationContract(_ operation: String, group: String) -> ImmutableContract? {
        guard let extensions = extensionContracts else { return nil }
        let owners = extensions.values.filter { ($0[group] as? [String: Any])?[operation] != nil }
        if (contract?[group] as? [String: Any])?[operation] != nil { return owners.isEmpty ? contract : nil }
        return owners.count == 1 ? owners.first : nil
    }
    private static func inputContract(_ operation: String) -> ImmutableContract? { operationContract(operation, group: "inputs") }
    private static func outputContract(_ operation: String) -> ImmutableContract? { operationContract(operation, group: "outputs") }
    static func encode(_ operation: String, fields: [String: Any]) throws -> Data {
        var body = fields
        body["operation"] = operation
        guard let source = inputContract(operation), let inputs = source["inputs"] as? [String: [String: Any]],
              let definition = inputs[operation]?["definition"] as? [String: Any],
              let limit = contract?["input_limit"] as? Int else { throw CentralTextError.unavailable }
        guard valid(body, definition, source: source) else { throw CentralTextError.invalidPacket }
        let bytes = try JSONSerialization.data(withJSONObject: body, options: .sortedKeys)
        guard bytes.count <= limit else { throw CentralTextError.invalidPacket }
        return bytes
    }
}

/// Hands a task to 千问 through the user's "交给千问" shortcut (App Intent, no RPA). Hermes writes one line
/// "【交给千问】<instruction>"; the reply comes back via paios://qwen-result/<nonce> and is sent to Hermes as the next
/// turn. Only the one hand-off this app started is accepted back: exact host, its single-use random nonce in the path
/// (Shortcuts appends `result` as a query, so the path survives), unexpired; the reply is size-bounded.
enum QwenHandoff {
    static let marker = "【交给千问】"
    static let replyPrefix = "【千问回复】"
    static let validity: TimeInterval = 30 * 60
    static let maximumReplyCharacters = 4_000

    struct Pending: Codable, Equatable, Sendable {
        let nonce: String
        let createdAt: Date
    }

    static func split(_ text: String) -> (display: String, task: String?) {
        var task: String?
        let kept = text.components(separatedBy: "\n").filter { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(marker) else { return true }
            let body = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
            if !body.isEmpty { task = body }
            return false
        }
        return (kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), task)
    }

    static func runURL(task: String, nonce: String) -> URL? {
        // x-callback-url parameters fully percent-encoded (":" and "/" too), as Shortcuts documents.
        let enc = { (v: String) in v.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
        let query = [("name", "交给千问"), ("input", "text"), ("text", task), ("x-success", "paios://qwen-result/" + nonce),
                     ("x-error", "paios://qwen-error/" + nonce), ("x-cancel", "paios://qwen-error/" + nonce)]
            .map { "\($0.0)=\(enc($0.1))" }.joined(separator: "&")
        return URL(string: "shortcuts://x-callback-url/run-shortcut?" + query)
    }

    /// The reply for `pending`, or nil for anything else (no hand-off, other nonce, expired, other host/scheme).
    static func reply(from url: URL, pending: Pending?, now: Date = Date()) -> String? {
        guard url.scheme == "paios", let host = url.host, host == "qwen-result" || host == "qwen-error",
              let pending, url.pathComponents == ["/", pending.nonce],
              now.timeIntervalSince(pending.createdAt) >= 0, now.timeIntervalSince(pending.createdAt) <= validity
        else { return nil }
        guard host == "qwen-result" else { return replyPrefix + "（千问没有返回结果）" }
        let result = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "result" }?.value ?? ""
        return replyPrefix + String(result.prefix(maximumReplyCharacters))
    }
}
