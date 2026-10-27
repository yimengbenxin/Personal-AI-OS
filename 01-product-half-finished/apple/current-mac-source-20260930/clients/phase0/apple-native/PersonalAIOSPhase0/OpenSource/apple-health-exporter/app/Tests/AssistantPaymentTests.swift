import Foundation
import XCTest
import CryptoKit
@testable import HealthKitExporter

final class AssistantPaymentTests: XCTestCase {
    private func contract(_ name: String = "payment-message.v1") throws -> (Data, [String: Any]) {
        #if SWIFT_PACKAGE
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let url = app.appendingPathComponent("Contracts/\(name).json")
        #else
        let url = try XCTUnwrap(Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "Contracts"))
        #endif
        let bytes = try Data(contentsOf: url)
        return (bytes, try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any]))
    }
    private func example(_ operation: String, at index: Int = 0) throws -> [String: Any] {
        let examples = try XCTUnwrap(contract().1["examples"] as? [String: [[String: Any]]])
        return try XCTUnwrap(examples[operation]?[index])
    }
    private func packet(_ object: [String: Any]) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: object))
    }
    private func round3Fixture(_ name: String) throws -> Data {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: AssistantPaymentTests.self)
        #endif
        let url = try XCTUnwrap(bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/PaymentRound3"))
        return try Data(contentsOf: url)
    }
    func testMergedFormalContractPreservesAuthorityAndReleaseNodes() throws {
        let proof = try XCTUnwrap(JSONSerialization.jsonObject(with: round3Fixture("formal-structural")) as? [String: Any])
        let extras = try XCTUnwrap(proof["extra_nodes"] as? [String: [String]])
        let expected = try XCTUnwrap(proof["canonical_authority_sha256"] as? [String: String])
        var formal = try contract("formal-message.v1").1
        var inputs = try XCTUnwrap(formal["inputs"] as? [String: Any])
        var confirmation = try XCTUnwrap(inputs["voice_confirm"] as? [String: Any])
        var definition = try XCTUnwrap(confirmation["definition"] as? [String: Any])
        var properties = try XCTUnwrap(definition["properties"] as? [String: Any])
        let auth = try XCTUnwrap(properties.removeValue(forKey: "auth") as? [String: Any])
        XCTAssertEqual(auth["enum"] as? [String], ["face_id", "touch_id"])
        XCTAssertFalse((definition["required"] as? [String] ?? []).contains("auth"))
        definition["properties"] = properties; confirmation["definition"] = definition
        inputs["voice_confirm"] = confirmation; formal["inputs"] = inputs
        for group in ["$defs", "inputs", "outputs"] {
            var nodes = try XCTUnwrap(formal.removeValue(forKey: group) as? [String: Any])
            // Validate the conversation extensions before removing the fixture-listed additive nodes.
            if group == "$defs" {
                let enrollment = try XCTUnwrap(nodes["voice_enrollment"] as? [String: Any])
                XCTAssertEqual(enrollment["additionalProperties"] as? Bool, false)
            } else if group == "inputs" {
                let control = try XCTUnwrap(nodes["voice_enrollment_control"] as? [String: Any])
                let definition = try XCTUnwrap(control["definition"] as? [String: Any])
                let properties = try XCTUnwrap(definition["properties"] as? [String: Any])
                let action = try XCTUnwrap(properties["action"] as? [String: Any])
                XCTAssertEqual(action["enum"] as? [String], ["status", "start", "pause", "resume", "stop", "check", "commit", "discard", "preview"])
            } else {
                let state = try XCTUnwrap(nodes["voice_enrollment_state"] as? [String: Any])
                let properties = try XCTUnwrap(state["properties"] as? [String: Any])
                XCTAssertEqual(properties["enrollment"] as? [String: String], ["$ref": "#/$defs/voice_enrollment"])
            }
            for name in extras[group] ?? [] { XCTAssertNotNil(nodes.removeValue(forKey: name), name) }
            // Activity display extends the formal contract; its closed shapes are checked by AssistantActivityTests.
            if group == "$defs" {
                for name in ["activity_card", "activity_item", "scope_confirmation"] { XCTAssertNotNil(nodes.removeValue(forKey: name)) }
            } else if group == "outputs" { XCTAssertNotNil(nodes.removeValue(forKey: "activity_update")) }
            // Mode controls extend the call contract while preserving the historical authority projection.
            if group == "inputs" {
                XCTAssertNotNil(nodes.removeValue(forKey: "call_set_conversation_mode"))
                XCTAssertNotNil(nodes.removeValue(forKey: "call_retry"))
            } else if group == "outputs" {
                for (name, fields) in ["call_state": ["conversation_mode", "processed_event_id", "thinking_status", "readout_fidelity"],
                                       "call_transcript": ["message_id"], "control_receipt": ["call_id"]] {
                    var node = try XCTUnwrap(nodes[name] as? [String: Any])
                    var properties = try XCTUnwrap(node["properties"] as? [String: Any])
                    for field in fields { XCTAssertNotNil(properties.removeValue(forKey: field), field) }
                    if name == "control_receipt" {
                        XCTAssertNotNil(node.removeValue(forKey: "anyOf"))
                        var required = try XCTUnwrap(node["required"] as? [String])
                        required.insert("processed_event_id", at: 3); node["required"] = required
                        var operation = try XCTUnwrap(properties["requested_operation"] as? [String: Any])
                        var values = try XCTUnwrap(operation["enum"] as? [String])
                        XCTAssertEqual(values.removeLast(), "call_retry")
                        XCTAssertEqual(values.removeLast(), "call_set_conversation_mode")
                        operation["enum"] = values; properties["requested_operation"] = operation
                        var receipt = try XCTUnwrap(properties["receipt"] as? [String: Any])
                        var receiptProperties = try XCTUnwrap(receipt["properties"] as? [String: Any])
                        XCTAssertNotNil(receiptProperties.removeValue(forKey: "conversation_mode"))
                        receipt["properties"] = receiptProperties; properties["receipt"] = receipt
                    }
                    node["properties"] = properties; nodes[name] = node
                }
            }
            // Verify optional call fields before comparing the historical merge projection.
            if group == "inputs" {
                var call = try XCTUnwrap(nodes["call_open"] as? [String: Any])
                var definition = try XCTUnwrap(call["definition"] as? [String: Any])
                var properties = try XCTUnwrap(definition["properties"] as? [String: Any])
                XCTAssertEqual(properties.removeValue(forKey: "conversation_mode") as? [String: [String]], ["enum": ["chat", "thinking"]])
                XCTAssertEqual(properties.removeValue(forKey: "wake_word") as? [String: String], ["type": "boolean"])
                XCTAssertEqual(properties.removeValue(forKey: "enrollment_session_id") as? [String: String],
                    ["type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$"])
                XCTAssertFalse(try XCTUnwrap(definition["required"] as? [String]).contains("enrollment_session_id"))
                definition["properties"] = properties; call["definition"] = definition; nodes["call_open"] = call
                // Location diagnostics are additive and do not alter the payment authority projection.
                var location = try XCTUnwrap(nodes["location_update"] as? [String: Any])
                var locationDefinition = try XCTUnwrap(location["definition"] as? [String: Any])
                var locationProperties = try XCTUnwrap(locationDefinition["properties"] as? [String: Any])
                XCTAssertEqual(locationProperties.removeValue(forKey: "unavailable_reason") as? [String: [String]],
                    ["enum": ["sharing_off", "permission_denied", "permission_restricted", "permission_not_determined",
                              "location_unknown", "network", "timeout", "stale_fix", "invalid_fix",
                              "background_when_in_use", "reduced_accuracy", "location_failed"]])
                XCTAssertEqual(locationProperties.removeValue(forKey: "cached_fix_age_ms") as? NSDictionary,
                    ["type": ["integer", "null"], "minimum": 0] as NSDictionary)
                XCTAssertFalse(try XCTUnwrap(locationDefinition["required"] as? [String]).contains("unavailable_reason"))
                locationDefinition["properties"] = locationProperties; location["definition"] = locationDefinition
                nodes["location_update"] = location
                // Route switching extends navigation while retaining stop in the historical projection.
                var navigation = try XCTUnwrap(nodes["nav_control"] as? [String: Any])
                var navigationDefinition = try XCTUnwrap(navigation["definition"] as? [String: Any])
                var navigationProperties = try XCTUnwrap(navigationDefinition["properties"] as? [String: Any])
                XCTAssertEqual(navigationProperties["action"] as? [String: [String]], ["enum": ["stop", "switch"]])
                navigationProperties["action"] = ["const": "stop"]
                navigationDefinition["properties"] = navigationProperties; navigation["definition"] = navigationDefinition
                nodes["nav_control"] = navigation
            } else if group == "outputs" {
                var ready = try XCTUnwrap(nodes["ready"] as? [String: Any])
                var readyProperties = try XCTUnwrap(ready["properties"] as? [String: Any])
                XCTAssertEqual(readyProperties.removeValue(forKey: "history_epoch") as? [String: String],
                    ["type": "string", "pattern": "^[a-f0-9]{32}$"])
                XCTAssertFalse(try XCTUnwrap(ready["required"] as? [String]).contains("history_epoch"))
                ready["properties"] = readyProperties; nodes["ready"] = ready
                var hud = try XCTUnwrap(nodes["move_hud"] as? [String: Any])
                var hudProperties = try XCTUnwrap(hud["properties"] as? [String: Any])
                XCTAssertEqual(hudProperties.removeValue(forKey: "seq") as? NSDictionary,
                    ["type": "integer", "minimum": 0] as NSDictionary)
                XCTAssertEqual(hudProperties.removeValue(forKey: "coordinate_system") as? [String: String], ["const": "wgs84"])
                XCTAssertEqual(hudProperties.removeValue(forKey: "position") as? [String: String], ["$ref": "#/$defs/move_position"])
                var hudRequired = try XCTUnwrap(hud["required"] as? [String])
                XCTAssertEqual(Array(hudRequired.suffix(2)), ["seq", "coordinate_system"])
                hudRequired.removeLast(2); hud["required"] = hudRequired
                var nav = try XCTUnwrap(hudProperties["nav"] as? [String: Any])
                var navProperties = try XCTUnwrap(nav["properties"] as? [String: Any])
                XCTAssertEqual(navProperties.removeValue(forKey: "route_segment_index") as? NSDictionary,
                    ["type": "integer", "minimum": 0] as NSDictionary)
                XCTAssertEqual(navProperties.removeValue(forKey: "segment_fraction") as? NSDictionary,
                    ["type": "number", "minimum": 0, "maximum": 1] as NSDictionary)
                XCTAssertEqual(navProperties.removeValue(forKey: "maneuver_location") as? [String: String],
                    ["$ref": "#/$defs/move_coordinate"])
                var navRequired = try XCTUnwrap(nav["required"] as? [String])
                XCTAssertEqual(Array(navRequired.suffix(3)), ["route_segment_index", "segment_fraction", "maneuver_location"])
                navRequired.removeLast(3); nav["required"] = navRequired
                nav["properties"] = navProperties; hudProperties["nav"] = nav
                var ride = try XCTUnwrap(hudProperties["ride"] as? [String: Any])
                var rideProperties = try XCTUnwrap(ride["properties"] as? [String: Any])
                for field in ["speed_sample_at", "hr_sample_at"] {
                    XCTAssertEqual(rideProperties.removeValue(forKey: field) as? [String: String],
                        ["type": "string", "format": "paios-utc"])
                }
                ride["properties"] = rideProperties; hudProperties["ride"] = ride; hud["properties"] = hudProperties
                nodes["move_hud"] = hud
                var call = try XCTUnwrap(nodes["call_state"] as? [String: Any])
                var properties = try XCTUnwrap(call["properties"] as? [String: Any])
                var reason = try XCTUnwrap(properties["reason"] as? [String: Any])
                var values = try XCTUnwrap(reason["enum"] as? [String])
                XCTAssertEqual(Array(values.prefix(3)), ["button", "goodbye", "false_wake"])
                values = Array(values.prefix(1)) + Array(values.dropFirst(3))
                reason["enum"] = values; properties["reason"] = reason; call["properties"] = properties; nodes["call_state"] = call
                // Identity additions are checked exactly, then removed from the unchanged authority projection.
                let deviceID = ["type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$"]
                var rejected = try XCTUnwrap(nodes["rejected"] as? [String: Any])
                var rejectionProperties = try XCTUnwrap(rejected["properties"] as? [String: Any])
                XCTAssertEqual(rejectionProperties.removeValue(forKey: "frame_id") as? [String: String], deviceID)
                XCTAssertFalse(try XCTUnwrap(rejected["required"] as? [String]).contains("frame_id"))
                rejected["properties"] = rejectionProperties; nodes["rejected"] = rejected
                let deviceType = ["type": "string", "enum": ["phone", "glasses", "mac", "watch"]] as [String: Any]
                let devices: [String: Any] = ["type": "array", "maxItems": 32, "items": [
                    "type": "object", "additionalProperties": false, "required": ["device_id", "device_type"],
                    "properties": ["device_id": deviceID, "device_type": deviceType,
                        "name": ["type": "string", "maxLength": 100] as [String: Any]]]]
                var owner = try XCTUnwrap(nodes["voiceprint_owner"] as? [String: Any])
                var ownerProperties = try XCTUnwrap(owner["properties"] as? [String: Any])
                XCTAssertEqual(ownerProperties.removeValue(forKey: "voice_devices") as? NSDictionary, devices as NSDictionary)
                XCTAssertEqual(ownerProperties.removeValue(forKey: "active_voice_device_id") as? [String: String], deviceID)
                owner["properties"] = ownerProperties; nodes["voiceprint_owner"] = owner
                var cards = try XCTUnwrap(nodes["voice_confirmations"] as? [String: Any])
                var cardProperties = try XCTUnwrap(cards["properties"] as? [String: Any])
                var confirmations = try XCTUnwrap(cardProperties["confirmations"] as? [String: Any])
                var item = try XCTUnwrap(confirmations["items"] as? [String: Any])
                var itemProperties = try XCTUnwrap(item["properties"] as? [String: Any])
                XCTAssertEqual(itemProperties.removeValue(forKey: "purpose") as? [String: [String]], ["enum": ["trust_window", "call"]])
                XCTAssertEqual(itemProperties.removeValue(forKey: "source_device_id") as? [String: String], deviceID)
                XCTAssertEqual(itemProperties.removeValue(forKey: "source_device_type") as? NSDictionary, deviceType as NSDictionary)
                XCTAssertEqual(itemProperties.removeValue(forKey: "scope_confirmation") as? [String: String],
                    ["$ref": "#/$defs/scope_confirmation"])
                let scopeCondition: [[String: Any]] = [[
                    "if": ["properties": ["scope_confirmation": [String: Any]()], "required": ["scope_confirmation"]],
                    "then": ["properties": ["kind": ["const": "native_approval"]], "required": ["kind"]]
                ]]
                XCTAssertEqual(item.removeValue(forKey: "allOf") as? NSArray, scopeCondition as NSArray)
                item["properties"] = itemProperties; confirmations["items"] = item
                cardProperties["confirmations"] = confirmations; cards["properties"] = cardProperties
                nodes["voice_confirmations"] = cards
            }
            let canonical = try JSONSerialization.data(withJSONObject: nodes, options: [.sortedKeys, .withoutEscapingSlashes])
            XCTAssertEqual(SHA256.hash(data: canonical).map { String(format: "%02x", $0) }.joined(), expected[group], group)
        }
        let authorityPins = try XCTUnwrap(proof["authority_extension_pins"] as? [String: String])
        let extraExtensions = try XCTUnwrap(proof["extra_extensions"] as? [String])
        var entries = try XCTUnwrap(formal["extensions"] as? [[String: Any]])
        for entry in entries {
            let name = try XCTUnwrap(entry["contract"] as? String)
            let bytes = try contract(String(name.dropLast(5))).0
            XCTAssertEqual(entry["sha256"] as? String, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
        }
        // Registered after the authority commit: each is pinned above, then removed from the authority projection.
        XCTAssertEqual(entries.suffix(extraExtensions.count).compactMap { $0["contract"] as? String }, extraExtensions)
        entries.removeLast(extraExtensions.count)
        for index in entries.indices {
            let name = try XCTUnwrap(entries[index]["contract"] as? String)
            if name == "terminal-message.v1.json" {
                XCTAssertEqual(entries[index]["version"] as? Int, 4)
                entries[index]["version"] = 3 // Project the loaded-version extension back to the historical authority.
            }
            entries[index]["sha256"] = try XCTUnwrap(authorityPins[name])
        }
        formal["extensions"] = entries
        let header = try JSONSerialization.data(withJSONObject: formal, options: [.sortedKeys, .withoutEscapingSlashes])
        XCTAssertEqual(SHA256.hash(data: header).map { String(format: "%02x", $0) }.joined(), expected["header"])
    }
    func testRegistryDecodesPaymentAndDesktopTerminalOperations() throws {
        let formal = try contract("formal-message.v1").1
        let entries = try XCTUnwrap(formal["extensions"] as? [[String: Any]])
        XCTAssertEqual(entries.compactMap { $0["contract"] as? String }, ["payment-message.v1.json", "terminal-message.v1.json",
            "owner-override-message.v1.json", "call-avatar.v1.json", "appearance-message.v1.json", "model-settings.v1.json"])
        let terminal = try contract("terminal-message.v1").1
        let groups = try XCTUnwrap(terminal["examples"] as? [String: Any])
        let examples = try XCTUnwrap(groups["outputs"] as? [String: [[String: Any]]])
        for packets in examples.values {
            for packet in packets where packet["schema_version"] != nil {
                let bytes = try JSONSerialization.data(withJSONObject: packet)
                _ = try AssistantCentralTextWire.decode(bytes)
            }
        }
        let inputs = try XCTUnwrap(groups["inputs"] as? [String: [[String: Any]]])
        for (operation, packets) in inputs {
            for packet in packets { _ = try AssistantCentralTextWire.encode(operation, fields: packet) }
        }
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("timeline_sync", fields: ["after_seq": 1, "before_seq": 2]))
        var removal = try XCTUnwrap(examples["timeline_removed"]?.first)
        removal["removed_seqs"] = [1, 1]
        let duplicated = try JSONSerialization.data(withJSONObject: removal)
        XCTAssertThrowsError(try AssistantCentralTextWire.decode(duplicated))
    }
    func testFinalAuthorityMaximumVectorsPassRealSwiftWireAndNativeDTOs() throws {
        let outputs = try XCTUnwrap(contract().1["outputs"] as? [String: Any])
        XCTAssertEqual(outputs.count, 9)
        for operation in outputs.keys {
            let bytes = try round3Fixture(operation)
            XCTAssertLessThanOrEqual(bytes.count, 12_288, operation)
            let decoded = try AssistantCentralTextWire.decode(bytes)
            XCTAssertEqual(try decoded.fields.value("operation", as: String.self), operation)
            // decode() calls the production native DTO validation for every payment output.
            if operation == "payment_cards" {
                let value = try JSONDecoder().decode(CentralPaymentCards.self, from: bytes)
                XCTAssertTrue(value.complete); XCTAssertEqual(value.cards.count, 2)
            } else if operation == "payment_approvals" {
                let value = try JSONDecoder().decode(CentralPaymentApprovals.self, from: bytes)
                XCTAssertTrue(value.complete); XCTAssertEqual(value.approvals.count, 2)
            } else if operation == "payment_record" {
                let value = try JSONDecoder().decode(CentralPaymentRecord.self, from: bytes)
                XCTAssertNotNil(value.next_seq); XCTAssertFalse(value.timeline.isEmpty)
            }
        }
    }
    func testCompleteSnapshotContractRejectsMissingFalseAndThirdLiveEntry() throws {
        for (operation, field) in [("payment_cards", "cards"), ("payment_approvals", "approvals")] {
            var snapshot = try XCTUnwrap(JSONSerialization.jsonObject(with: round3Fixture(operation)) as? [String: Any])
            _ = try packet(snapshot)
            snapshot.removeValue(forKey: "complete"); XCTAssertThrowsError(try packet(snapshot))
            snapshot["complete"] = false; XCTAssertThrowsError(try packet(snapshot))
            snapshot["complete"] = true
            let entry = try XCTUnwrap((try example(operation)[field] as? [[String: Any]])?.first)
            snapshot[field] = Array(repeating: entry, count: 3)
            XCTAssertThrowsError(try packet(snapshot))
        }
    }
    func testOpaqueRecordsCursorAndDetailSequenceContinuationStayAuthorityOwned() throws {
        let page = try example("payment_records"), cursor = try XCTUnwrap(page["next_before"] as? String)
        let bytes = try AssistantCentralTextWire.encode("payment_records_get", fields: ["request_id": "page-2", "before": cursor])
        let input = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(input["before"] as? String, cursor)
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("payment_records_get", fields: ["request_id": "bad", "before": "2026-10-15T00:00:00.000Z"]))
        let detail = try JSONDecoder().decode(CentralPaymentRecord.self, from: packet(example("payment_record")).bytes)
        let sequence = try XCTUnwrap(detail.next_seq)
        _ = try AssistantCentralTextWire.encode("payment_record_get", fields: ["request_id": "older", "payment_id": detail.payment.payment_id, "before_seq": sequence])
        for invalid: Any in [0, -1, true, "41"] {
            XCTAssertThrowsError(try AssistantCentralTextWire.encode("payment_record_get", fields: ["request_id": "older", "payment_id": detail.payment.payment_id, "before_seq": invalid]))
        }
        XCTAssertEqual(AssistantPayment.errorLine("PAYMENT_CHECKPOINT_ACTIVE"), "请先完成或取消一笔进行中的付款")
        XCTAssertEqual(AssistantPayment.errorLine("APPROVAL_BUSY"), "请先处理眼镜上正在等待确认的请求")
    }
    func testI2OptionalReasonAmountsNeverInventMissingEvidence() {
        for reason in [CentralPaymentReason.OVER_AUTO_LIMIT, .OVER_AUTO_DAY_LIMIT, .OVER_VOICE_LIMIT, .OVER_BUDGET, .AMOUNT_CHANGED] {
            let line = reason.line()
            XCTAssertNotNil(line)
            XCTAssertFalse(line?.contains("¥") == true)
            XCTAssertFalse(line?.contains("—") == true)
        }
        XCTAssertTrue(CentralPaymentReason.OVER_AUTO_LIMIT.line(limitFen: 5000)?.contains("¥50") == true)
    }

    func testFrozenContractPinAndEveryPublishedInputAndOutputExample() throws {
        let (bytes, contract) = try contract()
        XCTAssertEqual(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), AssistantPayment.contractSHA256)
        XCTAssertEqual(contract["version"] as? Int, 1)
        XCTAssertEqual(contract["schema"] as? String, "paios.payment.wire.v1")
        let (formalBytes, formal) = try self.contract("formal-message.v1")
        XCTAssertEqual(SHA256.hash(data: formalBytes).map { String(format: "%02x", $0) }.joined(), AssistantCentralTextWire.contractSHA256)
        XCTAssertEqual(formal["version"] as? Int, 1)
        var confirmation: [String: Any] = ["confirmation_id": String(repeating: "a", count: 64),
            "event_id": "scope-event", "expires_in_ms": 1000, "kind": "native_approval",
            "scope_confirmation": ["grant_request": ["scope_session_id": "scope-1", "target_id": "target-1",
                "target_device_id": "device-1", "expires_at": "2026-10-26T12:00:00.000Z",
                "allowed_operation_kinds": ["desktop.click"]], "preview_items": ["打开设置"]]]
        var native: [String: Any] = ["schema_version": "paios.central.text-envelope.v1",
            "operation": "voice_confirmations", "session_id": "session-1", "confirmations": [confirmation]]
        _ = try packet(native)
        confirmation.removeValue(forKey: "kind")
        native["confirmations"] = [confirmation]
        XCTAssertThrowsError(try packet(native), "A scope confirmation must explicitly be a native approval")
        let examples = try XCTUnwrap(contract["examples"] as? [String: [[String: Any]]])
        let inputs = try XCTUnwrap(contract["inputs"] as? [String: Any])
        let outputs = try XCTUnwrap(contract["outputs"] as? [String: Any])
        XCTAssertEqual(outputs.count, 9)
        for (operation, values) in examples {
            for value in values {
                if inputs[operation] != nil { _ = try AssistantCentralTextWire.encode(operation, fields: value) }
                if outputs[operation] != nil { _ = try packet(value) }
            }
        }
    }
    func testAmendedBaseRetainsReleasedMovementInputsAndOutputsAlongsideWearCycle() throws {
        let at = "2026-10-15T00:00:00.000Z"
        let coordinate: [String: Any] = ["lat": 0, "lng": 0.01]
        let metrics: [String: Any] = ["avg_kmh": 18, "max_kmh": 24, "distance_m": 1000, "moving_s": 200, "elapsed_s": 220]
        var summary = metrics; summary["started_at"] = at; summary["ended_at"] = at
        let progress: [String: Any] = ["nav_id": "nav-1", "revision": 1, "step_index": 0, "maneuver": "arrive",
                                       "distance_to_maneuver_m": 1000, "remaining_m": 1000, "remaining_s": 200, "route_segment_index": 0, "segment_fraction": 0.25]
        let inputs: [(String, [String: Any])] = [
            ("ride_state", ["ride_id": "ride-1", "state": "ended", "at": at, "started_by": "voice", "summary": summary]),
            ("move_frame", ["ride_id": "ride-1", "nav_id": "nav-1", "seq": 1, "at": at,
                            "position": ["lat": 0, "lng": 0.01, "accuracy_m": 5, "at": at], "ride": metrics, "nav": progress]),
            ("nav_state", ["nav_id": "nav-1", "state": "arrived", "at": at, "position": coordinate]),
            ("wear_state", ["control_id": "wear-retained", "worn": true, "lock_cycle": 7])
        ]
        for (operation, fields) in inputs { _ = try AssistantCentralTextWire.encode(operation, fields: fields) }
        let outputs: [[String: Any]] = [
            ["operation": "ride_control", "action": "start", "requested_by": "voice"],
            ["operation": "nav_control", "nav_id": "nav-1", "action": "stop"],
            ["operation": "nav_route", "coordinate_system": "wgs84", "nav_id": "nav-1", "revision": 1, "mode": "bicycling",
             "destination": ["name": "终点", "lat": 0, "lng": 0.01], "total_m": 1000, "total_s": 200,
             "steps": [["index": 0, "maneuver": "arrive", "instruction": "到达", "distance_m": 1000, "duration_s": 200,
                         "maneuver_location": coordinate, "polyline": [["lat": 0, "lng": 0], coordinate]]]]
        ]
        for var output in outputs {
            output["schema_version"] = "paios.central.text-envelope.v1"; output["session_id"] = "session-1"
            _ = try packet(output)
        }
    }
    func testUnsupportedPaymentVersionIsEnvelopeOnlyDiagnosticAndMalformedEnvelopeIsRejected() throws {
        let canonical = try example("payment_settings")
        XCTAssertNil(try packet(canonical).unsupportedPaymentWireVersion)
        var future: [String: Any] = ["schema_version": canonical["schema_version"]!, "session_id": "session-1",
                                   "operation": "payment_settings", "wire_version": 2, "request_id": "request-2",
                                   "future_policy": ["opaque": true]]
        let diagnostic = try packet(future)
        XCTAssertEqual(diagnostic.unsupportedPaymentWireVersion, 2)
        XCTAssertEqual(try diagnostic.fields.value("session_id", as: String.self), "session-1")
        XCTAssertEqual(try diagnostic.fields.value("request_id", as: String.self), "request-2")
        XCTAssertNil(try diagnostic.fields.value("future_policy", as: CentralBody.self))
        XCTAssertNil(try diagnostic.fields.value("limits", as: CentralBody.self))
        future["schema_version"] = "untrusted"; XCTAssertThrowsError(try packet(future))
        future["schema_version"] = canonical["schema_version"]
        future["session_id"] = "bad session"; XCTAssertThrowsError(try packet(future))
        future["session_id"] = "session-1"
        future["request_id"] = "bad request"; XCTAssertThrowsError(try packet(future))
        future["request_id"] = "request-2"
        future["wire_version"] = "2"; XCTAssertThrowsError(try packet(future))
        future["wire_version"] = true; XCTAssertThrowsError(try packet(future))
    }
    func testAmendedLockCycleIsOptionalOnSnapshotsAndWearButRequiredOnUnlockRequests() throws {
        var state = try example("payment_lock_state")
        state.removeValue(forKey: "lock_cycle")
        let original = try JSONDecoder().decode(CentralPaymentLockState.self, from: packet(state).bytes)
        XCTAssertNil(original.lock_cycle)
        for cycle in [0, 9_007_199_254_740_991] {
            state["lock_cycle"] = cycle
            let decoded = try JSONDecoder().decode(CentralPaymentLockState.self, from: packet(state).bytes)
            XCTAssertEqual(decoded.lock_cycle, cycle)
        }
        for invalid: Any in [-1, 1.1, true, "1"] {
            state["lock_cycle"] = invalid
            XCTAssertThrowsError(try packet(state))
        }
        state["lock_cycle"] = 1; state["unknown_cycle"] = 1
        XCTAssertThrowsError(try packet(state))
        var unlock = try example("glasses_unlock_request")
        _ = try AssistantCentralTextWire.encode("glasses_unlock_request", fields: unlock)
        unlock.removeValue(forKey: "lock_cycle")
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("glasses_unlock_request", fields: unlock))
        for invalid: Any in [-1, 1.1, true, "1"] {
            unlock["lock_cycle"] = invalid
            XCTAssertThrowsError(try AssistantCentralTextWire.encode("glasses_unlock_request", fields: unlock))
        }
        var wear: [String: Any] = ["control_id": "wear-1", "worn": false]
        _ = try AssistantCentralTextWire.encode("wear_state", fields: wear)
        wear["lock_cycle"] = 2
        _ = try AssistantCentralTextWire.encode("wear_state", fields: wear)
        wear["lock_cycle"] = -1
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("wear_state", fields: wear))
    }
    func testPaymentWireVersionRemainsIntegerOneAndV1ShapesStayClosed() throws {
        var settings = try example("payment_settings")
        for invalid: Any in ["1", 1.1, true] {
            settings["wire_version"] = invalid
            XCTAssertThrowsError(try packet(settings))
        }
        settings["wire_version"] = 1; settings["unknown_policy"] = false
        XCTAssertThrowsError(try packet(settings))
    }
    func testPublishedRecordPageBoundsAndLargestSingleRecordItemDecodeWithinTransportBudget() throws {
        var page = try example("payment_records")
        let row = try XCTUnwrap((page["items"] as? [[String: Any]])?.first)
        var shortRow = row
        for optional in ["payee", "method", "terminal"] { shortRow.removeValue(forKey: optional) }
        let outputs = try XCTUnwrap(contract().1["outputs"] as? [String: [String: Any]])
        let properties = try XCTUnwrap(outputs["payment_records"]?["properties"] as? [String: [String: Any]])
        let maxItems = try XCTUnwrap(properties["items"]?["maxItems"] as? Int)
        page["items"] = Array(repeating: shortRow, count: maxItems)
        let cursor = try XCTUnwrap(page["next_before"] as? String)
        let full = try packet(page)
        XCTAssertLessThanOrEqual(full.bytes.count, 12_288)
        XCTAssertEqual(try full.fields.value("items", as: [CentralPaymentRecordItem].self)?.count, maxItems)
        XCTAssertEqual(try full.fields.value("next_before", as: String.self), cursor)
        // Six JSON bytes per scalar exercises escaped UTF-8 size, not just ASCII character caps.
        var largest = row
        largest["app"] = String(repeating: "\u{0001}", count: 20)
        largest["payee"] = String(repeating: "\u{0001}", count: 200)
        largest["summary"] = String(repeating: "\u{0001}", count: 400)
        largest["amount_fen"] = 100_000_000
        largest["state"] = "outcome_unknown"; largest["method"] = "voice"; largest["terminal"] = "glasses"
        page["session_id"] = String(repeating: "s", count: 200)
        page["request_id"] = String(repeating: "r", count: 200)
        page["items"] = [largest]
        let maximum = try packet(page)
        XCTAssertLessThanOrEqual(maximum.bytes.count, 12_288)
        let decoded = try XCTUnwrap(maximum.fields.value("items", as: [CentralPaymentRecordItem].self)?.first)
        XCTAssertEqual(decoded.summary, largest["summary"] as? String)
        XCTAssertEqual(decoded.payee, largest["payee"] as? String)
        XCTAssertEqual(decoded.amount_fen, 100_000_000)
    }
    func testI2SignedDecisionBindsDisplayedAmountPayeeAndNonceWithDERFixtureSignature() throws {
        let source = try example("payment_cards")
        let cards = try XCTUnwrap(packet(source).fields.value("cards", as: [CentralPaymentCard].self))
        let card = try XCTUnwrap(cards.first)
        let statement = try AssistantPayment.decisionStatement(deviceID: "phone-fixture", card: card)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: statement) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["purpose", "device_id", "payment_id", "decision", "amount_fen", "payee_key", "nonce"])
        XCTAssertEqual(object["amount_fen"] as? Int, card.amount_fen)
        XCTAssertEqual(object["nonce"] as? String, card.decision_nonce)
        // CryptoKit software keys exist only in this fixture. Production requires Secure Enclave.
        let fixture = P256.Signing.PrivateKey()
        let signature = try fixture.signature(for: statement)
        XCTAssertTrue(fixture.publicKey.isValidSignature(try P256.Signing.ECDSASignature(derRepresentation: signature.derRepresentation), for: statement))
        var changed = object; changed["amount_fen"] = card.amount_fen + 1
        XCTAssertFalse(fixture.publicKey.isValidSignature(signature, for: try AssistantPayment.statement(changed)))
        let fields = AssistantPayment.signedFields(statement: statement, signature: signature.derRepresentation)
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(fields["statement_b64"] as? String)), statement)
    }
    func testI6UserStatementsHaveExactPurposeFieldsAndClassifyEverySettingsChange() throws {
        let nonce = String(repeating: "a", count: 43)
        let change = CentralPaymentChange(kind: "limits", auto_order_fen: 1)
        let settings = try AssistantPayment.settingsStatement(deviceID: "phone", nonce: nonce, policyVersion: 7, change: change)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: settings) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["purpose", "device_id", "nonce", "policy_version", "change"])
        XCTAssertEqual((object["change"] as? [String: Any])?["auto_order_fen"] as? Int, 1)
        for kind in ["limits", "phone_lock", "glasses_lock", "relock"] {
            XCTAssertTrue(CentralPaymentChange(kind: kind, enabled: false).requiresUserSignature)
        }
        XCTAssertTrue(CentralPaymentChange(kind: "voice", enabled: true).requiresUserSignature)
        XCTAssertTrue(CentralPaymentChange(kind: "auto", enabled: true).requiresUserSignature)
        let unlock = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantPayment.unlockStatement(deviceID: "phone", nonce: nonce)) as? [String: Any])
        XCTAssertEqual(Set(unlock.keys), ["purpose", "device_id", "nonce"])
        let approval = try JSONDecoder().decode(CentralPaymentApprovals.self, from: JSONSerialization.data(withJSONObject: example("payment_approvals")))
        let approve = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantPayment.approvalStatement(deviceID: "phone", approval: XCTUnwrap(approval.approvals.first))) as? [String: Any])
        XCTAssertEqual(Set(approve.keys), ["purpose", "device_id", "nonce", "approval_id", "kind", "target_device_id", "decision"])
        let forget = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantPayment.forgetStatement(deviceID: "phone", nonce: nonce)) as? [String: Any])
        XCTAssertEqual(Set(forget.keys), ["purpose", "device_id", "nonce", "channel"])
        let publicKey = P256.Signing.PrivateKey().publicKey.x963Representation
        let registration = try XCTUnwrap(JSONSerialization.jsonObject(with: AssistantPayment.keyRegistrationStatement(deviceID: "phone", nonce: nonce, role: "user", publicKey: publicKey)) as? [String: Any])
        XCTAssertEqual(Set(registration.keys), ["purpose", "role", "device_id", "nonce", "key_sha256"])
        XCTAssertEqual(registration["key_sha256"] as? String, SHA256.hash(data: publicKey).map { String(format: "%02x", $0) }.joined())
    }
    func testI7UnsignedRiskReductionAndRequiredSignaturesAreValidated() throws {
        for kind in ["voice", "auto"] {
            let change = CentralPaymentChange(kind: kind, enabled: false)
            XCTAssertFalse(change.requiresUserSignature)
            _ = try AssistantCentralTextWire.encode("payment_settings_set", fields: ["control_id": "off", "policy_version": 1, "change": AssistantPayment.object(change)])
        }
        var pay = try example("payment_decide"); pay.removeValue(forKey: "signature_b64")
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("payment_decide", fields: pay))
        pay["decision"] = "cancel"; pay.removeValue(forKey: "statement_b64")
        _ = try AssistantCentralTextWire.encode("payment_decide", fields: pay)
        var approval = try example("payment_approval_decide"); approval.removeValue(forKey: "signature_b64")
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("payment_approval_decide", fields: approval))
        approval["decision"] = "deny"; approval.removeValue(forKey: "statement_b64")
        _ = try AssistantCentralTextWire.encode("payment_approval_decide", fields: approval)
        _ = try AssistantCentralTextWire.encode("payment_dispute", fields: ["control_id": "dispute", "payment_id": pay["payment_id"]!])
        var register = try example("payment_keys_register", at: 1); register.removeValue(forKey: "device_signature_b64")
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("payment_keys_register", fields: register))
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("payment_settings_set", fields: ["control_id": "limit", "policy_version": 1, "change": ["kind": "limits"]]))
    }
    func testI8RecordProjectionRejectsNonceAndStatementAndLockedNoticeHidesDetails() throws {
        var record = try example("payment_record")
        var timeline = try XCTUnwrap(record["timeline"] as? [[String: Any]])
        var event = try XCTUnwrap(timeline.first); var data = try XCTUnwrap(event["data"] as? [String: Any])
        for secret in ["nonce", "statement_b64", "grant_id"] {
            data[secret] = "forbidden"; event["data"] = data; timeline[0] = event; record["timeline"] = timeline
            XCTAssertThrowsError(try packet(record)); data.removeValue(forKey: secret)
        }
        var notice = try example("payment_notice")
        notice["notice"] = ["payment_id": "pay-00000000-0000-4000-8000-000000000001", "state": "awaiting_owner", "reason": "TERMINAL_LOCKED", "expires_in_ms": 1]
        _ = try packet(notice)
        var locked = try XCTUnwrap(notice["notice"] as? [String: Any]); locked["amount_fen"] = 500
        notice["notice"] = locked; XCTAssertThrowsError(try packet(notice))
    }
    func testI15MissingPairedIdentityKeyNeverCreatesReplacement() throws {
        let keys = AssistantPaymentKeys(deviceID: "unregistered-fixture-" + UUID().uuidString)
        XCTAssertThrowsError(try keys.publicKey(role: .device))
        XCTAssertThrowsError(try keys.sign(Data("test".utf8), role: .user))
        XCTAssertEqual(AssistantPayment.errorLine("PAYMENT_DEVICE_KEY_UNKNOWN"), "请重新配对这台 iPhone")
    }
    func testI16TypedAndUnverifiedRequestReasonsStayCardOnlyAndStatePresentationIsComplete() {
        XCTAssertEqual(CentralPaymentReason.INITIATING_NOT_VOICE.line(), "这件事是你打字发起的，没有声音可核对，请点「付款」")
        XCTAssertEqual(CentralPaymentReason.INITIATING_NOT_OWNER_VERIFIED.line(), "发起这件事那句话没认出是你，这一单要你确认")
        for reason in CentralPaymentReason.allCases {
            if [.VOICE_DISABLED, .AUTO_DISABLED, .LOCKS_NOT_ENABLED].contains(reason) { XCTAssertNil(reason.line()) }
            else { XCTAssertFalse(reason.line()?.isEmpty ?? true) }
        }
        for state in CentralPaymentState.allCases { XCTAssertFalse(state.title.isEmpty) }
        XCTAssertFalse(CentralPaymentState.outcome_unknown.canDecide)
        XCTAssertTrue(CentralPaymentState.outcome_unknown.isTerminal)
        XCTAssertEqual(CentralPaymentState.verifying.title, "正在核对两句话")
    }
}
