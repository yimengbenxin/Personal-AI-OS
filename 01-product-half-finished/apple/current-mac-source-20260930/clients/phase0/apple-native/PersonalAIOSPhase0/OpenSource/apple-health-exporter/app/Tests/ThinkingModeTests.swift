import Foundation
import XCTest
@testable import HealthKitExporter

final class ThinkingModeTests: XCTestCase {
    private func fixture(_ name: String, _ changes: [String: Any] = [:]) throws -> [String: Any] {
        #if SWIFT_PACKAGE
        let url = Bundle.module.url(forResource: "control", withExtension: "json", subdirectory: "Fixtures/ThinkingMode")
        #else
        let url = Bundle(for: Self.self).url(forResource: "control", withExtension: "json", subdirectory: "Fixtures/ThinkingMode")
        #endif
        let all = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(url))) as? [String: Any])
        var fields = try XCTUnwrap(all[name] as? [String: Any])
        fields.merge(changes) { $1 }
        return fields
    }
    private func packet(_ name: String, _ changes: [String: Any] = [:]) throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: fixture(name, changes)))
    }
    private func body(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }
    private func consumer(mode: String = "chat") throws -> AssistantCentralTextConsumer {
        var value = AssistantCentralTextConsumer()
        try value.reset(binding: CentralTransportBinding(sessionID: "continuity", deviceID: "phone", connectionEpoch: "1",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12_288, callRejoinWindowS: 120))
        _ = try value.openCall(enrollment: (sessionID: "enrollment-1", callID: "call-1"))
        try value.accept(packet("state", ["conversation_mode": mode]))
        return value
    }

    func testCanonicalRequestsAndOpenLeavesModeToServer() throws {
        XCTAssertEqual(try body(AssistantCentralTextWire.call("call_open", callID: "call-1")), try fixture("open") as NSDictionary)
        XCTAssertEqual(try body(AssistantCentralTextWire.callConversationMode(callID: "call-1", controlID: "mode-1", mode: .thinking)), try fixture("setMode") as NSDictionary)
        XCTAssertEqual(try body(AssistantCentralTextWire.callRetry(callID: "call-1", controlID: "retry-1", processedEventID: "processed-1")), try fixture("retry") as NSDictionary)
        var value = try consumer()
        let open = try body(value.openCall())
        XCTAssertNil(open["conversation_mode"])
        XCTAssertNil(value.call.conversationMode)
    }

    func testSwitchWaitsForServerAndResendKeepsOriginalIdentityAndBytes() throws {
        var value = try consumer()
        let original = try value.setCallConversationMode(.thinking, controlID: "mode-1")
        XCTAssertEqual(value.call.conversationMode, .chat)
        XCTAssertEqual(value.call.pendingConversationMode, .thinking)
        value.reportCallControlFailure(URLError(.networkConnectionLost), controlID: "unrelated")
        XCTAssertNil(value.call.conversationModeFailure)
        value.reportCallControlFailure(URLError(.networkConnectionLost), controlID: "mode-1")
        XCTAssertNotNil(value.call.conversationModeFailure)
        XCTAssertEqual(value.call.pendingConversationMode, .thinking)
        XCTAssertEqual(try value.resendCallConversationMode(), original)
        XCTAssertNil(value.call.conversationModeFailure)
        try value.accept(packet("modeReceipt"))
        XCTAssertEqual(value.call.conversationMode, .thinking)
        XCTAssertNil(value.call.pendingConversationMode)
        XCTAssertFalse(value.call.avatarAllowed)
        let next = try body(value.setCallConversationMode(.chat, controlID: "mode-2"))
        XCTAssertEqual(next["control_id"] as? String, "mode-2")
        XCTAssertEqual(value.call.conversationMode, .thinking)
        try value.accept(packet("state", ["conversation_mode": "chat"]))
        XCTAssertEqual(value.call.conversationMode, .chat)
        XCTAssertNil(value.call.pendingConversationMode)
        XCTAssertTrue(value.call.avatarAllowed)
    }

    func testRejectedSwitchKeepsConfirmedModeAndRawError() throws {
        var value = try consumer()
        _ = try value.setCallConversationMode(.thinking, controlID: "mode-1")
        try value.accept(packet("rejected", ["request_operation": "call_retry"]))
        XCTAssertEqual(value.call.pendingConversationMode, .thinking)
        try value.accept(packet("rejected", ["control_id": "old-control"]))
        XCTAssertEqual(value.call.pendingConversationMode, .thinking)
        try value.accept(packet("rejected"))
        XCTAssertEqual(value.call.conversationMode, .chat)
        XCTAssertNil(value.call.pendingConversationMode)
        XCTAssertEqual(value.call.conversationModeFailure, "CALL_MODE_CHANGE_FAILED")
    }

    func testForeignReceiptsCannotConfirmMode() throws {
        var value = try consumer()
        _ = try value.setCallConversationMode(.thinking, controlID: "mode-1")
        try value.accept(packet("modeReceipt", ["control_id": "old-control"]))
        XCTAssertThrowsError(try value.accept(packet("modeReceipt", ["call_id": "other-call"])))
        XCTAssertThrowsError(try value.accept(packet("modeReceipt", ["session_id": "other-session"])))
        try value.accept(packet("state", ["call_id": "other-call"]))
        XCTAssertEqual(value.call.conversationMode, .chat)
        XCTAssertEqual(value.call.pendingConversationMode, .thinking)
        XCTAssertThrowsError(try value.accept(packet("state", ["session_id": "other-session"])))
        XCTAssertEqual(value.call.conversationMode, .chat)
    }

    func testThinkingStatusActionsAndRetryFollowProcessedEvent() throws {
        var value = try consumer(mode: "thinking")
        XCTAssertEqual(value.call.thinkingStatus?.text, "本次思考失败，请重试。")
        XCTAssertEqual(value.call.thinkingStatus?.actions, ["retry", "switch_to_chat"])
        XCTAssertTrue(value.call.canRetryThinking)
        let bytes = try value.retryCallThinking(controlID: "retry-1")
        XCTAssertEqual(try body(bytes), try fixture("retry") as NSDictionary)
        XCTAssertTrue(value.call.thinkingRetryPending)
        XCTAssertFalse(value.call.canRetryThinking)
        value.reportCallControlFailure(URLError(.timedOut), controlID: "retry-1")
        XCTAssertNotNil(value.call.thinkingRetryFailure)
        XCTAssertEqual(try value.retryCallThinking(controlID: "retry-2"), bytes)
        XCTAssertNil(value.call.thinkingRetryFailure)
        XCTAssertThrowsError(try value.accept(packet("retryReceipt", ["processed_event_id": "another-event"])))
        XCTAssertTrue(value.call.thinkingRetryPending)
        try value.accept(packet("retryReceipt"))
        XCTAssertFalse(value.call.thinkingRetryPending)
        try value.accept(packet("state", ["thinking_status": ["state": "waiting", "text": "正在思考"]]))
        XCTAssertEqual(value.call.thinkingStatus?.actions, [])
        XCTAssertFalse(value.call.canRetryThinking)
        XCTAssertThrowsError(try value.retryCallThinking(controlID: "retry-3"))
    }

    func testNewThinkingEventRetiresPreviousRetryIdentity() throws {
        var value = try consumer(mode: "thinking")
        _ = try value.retryCallThinking(controlID: "retry-1")
        value.reportCallControlFailure(URLError(.timedOut), controlID: "retry-1")
        try value.accept(packet("state", ["processed_event_id": "processed-2", "conversation_mode": "thinking"]))
        XCTAssertTrue(value.call.canRetryThinking)
        XCTAssertFalse(value.call.thinkingRetryPending)
        XCTAssertNil(value.call.thinkingRetryFailure)
        let retry = try body(value.retryCallThinking(controlID: "retry-2"))
        XCTAssertEqual(retry["control_id"] as? String, "retry-2")
        XCTAssertEqual(retry["processed_event_id"] as? String, "processed-2")
        try value.accept(packet("retryReceipt"))
        XCTAssertTrue(value.call.thinkingRetryPending, "late receipt cannot settle a new event's retry")
    }

    func testLegacyStateAndCallEndClearModeControlsAndThinkingStatus() throws {
        var value = try consumer(mode: "thinking")
        _ = try value.retryCallThinking(controlID: "retry-1")
        _ = try value.setCallConversationMode(.chat, controlID: "mode-2")
        var legacy = try fixture("state")
        legacy.removeValue(forKey: "conversation_mode")
        try value.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: legacy)))
        XCTAssertNil(value.call.conversationMode)
        XCTAssertNil(value.call.thinkingStatus)
        XCTAssertNil(value.call.pendingConversationMode)
        XCTAssertFalse(value.call.thinkingRetryPending)
        XCTAssertThrowsError(try value.setCallConversationMode(.thinking, controlID: "mode-3"))
        value = try consumer(mode: "thinking")
        _ = try value.retryCallThinking(controlID: "retry-1")
        _ = try value.setCallConversationMode(.chat, controlID: "mode-2")
        _ = try value.closeCall()
        XCTAssertNil(value.call.pendingConversationMode)
        XCTAssertFalse(value.call.thinkingRetryPending)
        XCTAssertNil(value.call.thinkingStatus)
        XCTAssertThrowsError(try value.resendCallConversationMode())
    }

    func testMalformedExternalModesStatusesAndControlsAreRejected() throws {
        XCTAssertThrowsError(try packet("state", ["conversation_mode": "unknown"]))
        XCTAssertThrowsError(try packet("state", ["thinking_status": ["state": "done", "text": "done"]]))
        XCTAssertThrowsError(try packet("state", ["thinking_status": ["state": "failed", "text": "failed", "actions": ["cancel_generation"]]]))
        XCTAssertThrowsError(try packet("modeReceipt", ["receipt": ["state": "ok"]]))
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("call_set_conversation_mode", fields: ["call_id": "call-1", "control_id": "mode-1", "conversation_mode": "unknown"]))
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("call_retry", fields: ["call_id": "call-1", "control_id": "retry-1"]))
    }
}
