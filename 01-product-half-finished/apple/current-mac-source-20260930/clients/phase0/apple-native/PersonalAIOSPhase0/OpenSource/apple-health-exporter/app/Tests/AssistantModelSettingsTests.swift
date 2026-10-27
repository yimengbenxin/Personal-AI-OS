import CryptoKit
import Foundation
import XCTest
@testable import HealthKitExporter

@MainActor
final class AssistantModelSettingsTests: XCTestCase {
    func testFrozenReviewPinsEveryPageAndSignsExactlyTheReviewedDraft() async throws {
        let f = ModelSettingsFixture(); await f.load()
        await f.model.prepareRoutes(roles: [f.role(model: "new-model")], summary: "更换主脑")
        let review = try XCTUnwrap(f.model.review)
        XCTAssertEqual(review.pageCount, 2)
        XCTAssertEqual(review.after.roles.last?.model_id, "new-model")
        XCTAssertEqual(review.before.roles.last?.model_id, "original-model")
        XCTAssertTrue(review.payloadText.contains("更换主脑"))
        await f.model.confirm()
        let bytes = try XCTUnwrap(f.signed)
        let statement = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(statement["draft_id"] as? String, review.draft.draft_id)
        XCTAssertEqual(statement["change_sha256"] as? String, review.draft.change_sha256)
        XCTAssertEqual(statement["nonce"] as? String, review.nonce)
        XCTAssertEqual(statement["expected_revision"] as? Int, 1)
        XCTAssertEqual(f.model.snapshot?.desired, 2)
        XCTAssertEqual(f.model.snapshot?.activationText, "已保存，当前任务结束后生效")
        XCTAssertNil(f.model.review)
    }

    func testIncompleteDraftCannotBeConfirmedAndCASRequiresFreshReview() async throws {
        let f = ModelSettingsFixture(); await f.load()
        f.failSecondPage = true
        await f.model.prepareResume()
        XCTAssertNil(f.model.review)
        await f.model.confirm()
        XCTAssertEqual(f.mutations, 0)
        f.failSecondPage = false
        await f.model.prepareResume()
        f.conflict = true
        await f.model.confirm()
        XCTAssertNil(f.model.review)
        XCTAssertEqual(f.model.snapshot?.revision, 3)
        XCTAssertTrue(f.model.error?.contains("重新检查") == true)
        XCTAssertEqual(f.mutations, 0)
    }

    func testUnauthorizedMacReadsButCannotDraft() async throws {
        let f = ModelSettingsFixture(deviceClass: "mac"); await f.load()
        XCTAssertNotNil(f.model.snapshot)
        XCTAssertFalse(f.model.authorized)
        XCTAssertFalse(f.model.canWrite)
        await f.model.prepareResume()
        XCTAssertNil(f.model.review)
        XCTAssertFalse(f.operations.contains("model_settings_draft"))
    }

    func testInitialWatchClosesReadSubscribeRace() async throws {
        let f = ModelSettingsFixture(); f.changeOnWatch = true; await f.load()
        XCTAssertEqual(f.model.snapshot?.revision, 2)
        XCTAssertEqual(f.model.snapshot?.desired, 2)
    }

    func testInitialAttachmentAndExplicitOpenReadOnceAndWatchOnce() async throws {
        let f = ModelSettingsFixture(); await f.load(); await f.settle()
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_read" }.count, 2)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_watch" }.count, 1)
        await f.model.open()
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_read" }.count, 2)
        await f.model.refresh()
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_read" }.count, 4)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_watch" }.count, 1)
    }

    func testReceiptAndStateBurstUpdatesActivationWithoutReadingRoutes() async throws {
        let f = ModelSettingsFixture(); await f.load(); await f.settle()
        let operations = f.operations, roles = f.model.snapshot?.roles
        for _ in 0..<20 {
            f.model.receive(.output(try f.state(desired: 2)))
            f.model.receive(.output(try f.receipt()))
        }
        await f.settle()
        XCTAssertEqual(f.operations, operations)
        XCTAssertEqual(f.model.snapshot?.desired, 2)
        XCTAssertEqual(f.model.snapshot?.groups["brain"]?.status, "pending")
        XCTAssertEqual(f.model.snapshot?.revision, 1)
        XCTAssertEqual(f.model.snapshot?.roles, roles)
        XCTAssertEqual(f.model.snapshot?.activationText, "已保存，当前任务结束后生效")
        f.model.receive(.output(try f.state(desired: 1)))
        f.model.receive(.output(try f.state(desired: 9, environment: "other")))
        f.model.receive(.output(try f.state(desired: 9, session: "other")))
        XCTAssertEqual(f.model.snapshot?.desired, 2)
    }

    func testLaterOpenReadsRemoteDesiredRevisionOnceAndThenUsesCache() async throws {
        let f = ModelSettingsFixture(); await f.load(); await f.settle()
        let operations = f.operations
        f.revision = 2
        f.model.receive(.output(try f.state(desired: 2)))
        await f.settle()
        XCTAssertEqual(f.operations, operations)
        XCTAssertEqual(f.model.snapshot?.revision, 1)
        XCTAssertEqual(f.model.snapshot?.desired, 2)
        await f.model.open()
        XCTAssertEqual(f.model.snapshot?.revision, 2)
        XCTAssertEqual(f.model.snapshot?.desired, 2)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_read" }.count, 4)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_watch" }.count, 1)
        let refreshed = f.operations
        await f.model.open(); await f.settle()
        XCTAssertEqual(f.operations, refreshed)
    }

    func testRepeatedAttachmentKeepsReviewAndReconnectRegistersNewWatch() async throws {
        let f = ModelSettingsFixture(); await f.load(); await f.settle()
        await f.model.prepareResume()
        let review = try XCTUnwrap(f.model.review), operations = f.operations
        f.attach(); await f.settle()
        XCTAssertEqual(f.model.review?.draft.draft_id, review.draft.draft_id)
        XCTAssertEqual(f.operations, operations)
        f.model.receive(.detached)
        f.model.receive(.output(try f.state(desired: 9)))
        XCTAssertNil(f.model.snapshot)
        f.attach(); await f.settle()
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_watch" }.count, 2)
        XCTAssertEqual(f.model.snapshot?.desired, 1)
    }

    func testImmediateWatchPushDoesNotStartReadWatchFeedback() async throws {
        let f = ModelSettingsFixture()
        f.beforeReply = { operation in
            if operation == "model_settings_watch" {
                f.model.receive(.output(try f.state(desired: 2)))
            }
        }
        await f.load(); await f.settle()
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_watch" }.count, 1)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_read" }.count, 2)
        XCTAssertEqual(f.model.snapshot?.desired, 2)
        XCTAssertEqual(f.model.snapshot?.revision, 1)
    }

    func testStateDuringPagedReadSurvivesWithoutAnotherRead() async throws {
        let f = ModelSettingsFixture()
        f.beforeReply = { operation in
            if operation == "model_settings_read" {
                f.model.receive(.output(try f.state(desired: 2)))
            }
        }
        await f.load(); await f.settle()
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_read" }.count, 2)
        XCTAssertEqual(f.model.snapshot?.revision, 1)
        XCTAssertEqual(f.model.snapshot?.desired, 2)
        XCTAssertEqual(f.model.snapshot?.roles.last?.model_id, "original-model")
    }

    func testDetachedReadCannotPublishAfterSameBindingReattaches() async throws {
        let f = ModelSettingsFixture()
        var interrupted = false
        f.beforeReply = { operation in
            if operation == "model_settings_read", !interrupted {
                interrupted = true
                f.model.receive(.detached)
                f.attach()
            }
        }
        await f.load(); await f.settle()
        XCTAssertTrue(interrupted)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_watch" }.count, 2)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_read" }.count, 3)
        XCTAssertEqual(f.model.snapshot?.revision, 1)
        XCTAssertNil(f.model.error)
    }

    func testActivationFailureAndUndoRequireRealKeyReentry() async throws {
        let f = ModelSettingsFixture(); f.failedActivation = true; await f.load()
        XCTAssertEqual(f.model.snapshot?.activationText, "应用失败，仍用原设置")
        f.undoNeedsKey = true
        await f.model.prepareUndo(revision: 0)
        XCTAssertNil(f.model.review)
        XCTAssertTrue(f.model.error?.contains("重新填写") == true)
        XCTAssertEqual(f.mutations, 0)
    }

    func testResumeWorksWithFailedBrainAndReserveCannotFallBelowOne() async throws {
        let f = ModelSettingsFixture(); f.failedActivation = true; await f.load()
        await f.model.prepareBudget(pauseOnLimit: true, reserve: 0)
        XCTAssertNil(f.model.review)
        await f.model.prepareBudget(pauseOnLimit: false, reserve: 1)
        XCTAssertTrue(f.model.review?.payloadText.contains("pause_on_limit") == true)
        f.model.discardReview()
        await f.model.prepareResume(); await f.model.confirm()
        XCTAssertEqual(f.mutations, 1)
        XCTAssertTrue(f.operations.contains("model_settings_resume"))
        XCTAssertFalse(f.operations.contains(where: { $0.contains("brain") || $0.contains("chat") }))
        XCTAssertEqual(f.model.message, "已恢复，暂停的工作会自动继续")
    }

    func testUnknownCommitReceiptRequiresRefreshInsteadOfSigningAgain() async throws {
        let f = ModelSettingsFixture(); await f.load()
        await f.model.prepareResume()
        f.loseReceipt = true
        await f.model.confirm()
        XCTAssertNil(f.model.review)
        XCTAssertEqual(f.mutations, 1)
        XCTAssertEqual(f.model.message, "提交结果尚未确认，请刷新查看已保存版本")
        await f.model.confirm()
        XCTAssertEqual(f.mutations, 1)
        await f.model.refresh()
        XCTAssertEqual(f.model.snapshot?.revision, 2)
    }

    func testKeyOnlyTravelsInPrepareAndNeverEntersFrozenClientState() async throws {
        let f = ModelSettingsFixture(); await f.load()
        var input = "fixture-key-never-persist"
        let submission = f.model.prepareKey(credentialRef: "credential", key: &input)
        XCTAssertTrue(input.isEmpty)
        await submission?.value
        let review = try XCTUnwrap(f.model.review)
        XCTAssertEqual(review.draft.action, "set_key")
        XCTAssertFalse(review.payloadText.contains("fixture-key-never-persist"))
        XCTAssertFalse(try AssistantModelSettingsWire.pretty(review.after).contains("fixture-key-never-persist"))
        await f.model.confirm()
        XCTAssertEqual(f.mutations, 1)
        XCTAssertEqual(f.operations.filter { $0 == "model_settings_set_key" }.count, 2)
    }

    func testCatalogPagesRetainFrozenIdentityAndUnavailableDiffersFromFailure() async throws {
        let f = ModelSettingsFixture(); await f.load()
        await f.model.loadCatalog(providerRef: "provider")
        XCTAssertEqual(f.model.catalog?.models.map(\.id), ["model-0", "model-1"])
        f.catalogStatus = "unavailable"; await f.model.loadCatalog(providerRef: "provider")
        XCTAssertEqual(f.model.catalog?.status, "unavailable")
        f.catalogStatus = "failed"; await f.model.loadCatalog(providerRef: "provider")
        XCTAssertEqual(f.model.catalog?.status, "failed")
        XCTAssertNil(f.model.catalog?.message)
    }

    func testPublishedContractExamplesPassProductionCodec() throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Contracts/model-settings.v1.json")
        let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let examples = try XCTUnwrap(contract["examples"] as? [String: [[String: Any]]])
        for (operation, values) in examples {
            for value in values {
                if operation == "model_settings_receipt" || operation == "model_settings_state" {
                    _ = try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: value))
                } else { _ = try AssistantCentralTextWire.encode(operation, fields: value) }
            }
        }
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("model_settings_draft", fields: ["control_id": "bad",
            "request": ["action": "pause", "expected_revision": 1, "pause_on_limit": true, "owner_reserve_cny": 0]]))
        XCTAssertThrowsError(try AssistantCentralTextWire.encode("model_settings_draft", fields: ["control_id": "bad",
            "request": ["expected_revision": 1, "key": "fixture-key"]]))
    }

    func testMacPublicationUsesPairedX25519ProofAndContractHKDF() throws {
        let recipient = Curve25519.KeyAgreement.PrivateKey(), server = Curve25519.KeyAgreement.PrivateKey()
        let publicKey = P256.Signing.PrivateKey().publicKey.x963Representation
        let nonce = Data(repeating: 7, count: 32)
        let challenge = AssistantModelSettingsWire.KeyChallenge(nonce: nonce.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: ""), expires_in_ms: 1000,
            server_public_key_b64: server.publicKey.rawRepresentation.base64EncodedString(), algorithm: "X25519-HKDF-SHA256-HMAC-SHA256")
        let fields = try AssistantModelSettingsWire.publication(publicKey: publicKey, recipient: recipient, challenge: challenge,
            deviceID: "mac", principalID: "owner")
        let statement = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(fields["statement_b64"] as? String)))
        let signature = try XCTUnwrap(Data(base64Encoded: XCTUnwrap(fields["signature_b64"] as? String)))
        let secret = try server.sharedSecretFromKeyAgreement(with: recipient.publicKey)
        let key = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: nonce,
            sharedInfo: Data("paios.model_settings.publish_key.v1".utf8), outputByteCount: 32)
        XCTAssertTrue(HMAC<SHA256>.isValidAuthenticationCode(signature, authenticating: statement, using: key))
        let wrong = SymmetricKey(size: .bits256)
        XCTAssertFalse(HMAC<SHA256>.isValidAuthenticationCode(signature, authenticating: statement, using: wrong))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: statement) as? [String: String])
        XCTAssertEqual(Set(object.keys), ["purpose", "device_id", "principal_id", "nonce", "key_sha256"])
        XCTAssertEqual(object["purpose"], "model_settings_publish_key")
    }
}

@MainActor
private final class ModelSettingsFixture {
    var revision = 1, mutations = 0
    var failedActivation = false, failSecondPage = false, conflict = false, undoNeedsKey = false, loseReceipt = false
    var catalogStatus = "available", deviceClass: String
    var changeOnWatch = false
    var operations: [String] = []
    var beforeReply: ((String) throws -> Void)?
    var signed: Data?
    var draftRequest: [String: Any] = [:]
    let hash = String(repeating: "a", count: 64)
    lazy var model = AssistantModelSettingsModel(sender: { [unowned self] bytes, id, _ in try self.reply(bytes, id: id) },
        signer: { [unowned self] bytes, _ in self.signed = bytes; return Data([1, 2, 3]) })
    init(deviceClass: String = "iphone") { self.deviceClass = deviceClass }
    func role(model: String) -> ModelSettingsRole {
        ModelSettingsRole(id: "brain", profile: "owner", provider_ref: "provider", model_id: model, activation_boundary: "brain_idle")
    }
    func attach() {
        model.receive(.attached(CentralTransportBinding(sessionID: "session", deviceID: "device", connectionEpoch: "epoch",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288, deviceClass: deviceClass)))
    }
    func load() async {
        attach()
        await model.refresh()
        for _ in 0..<20 { await Task.yield(); if !model.busy { break } }
    }
    func settle() async { for _ in 0..<100 { await Task.yield() } }
    func state(desired: Int, environment: String = "fixture", session: String = "session") throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": "paios.central.text-envelope.v1", "operation": "model_settings_state", "session_id": session,
            "state": ["environment_id": environment, "desired": desired,
                "groups": ["brain": ["desired": desired, "effective": 1, "status": "pending", "error": NSNull()]]]]))
    }
    func receipt() throws -> CentralTextPacket {
        try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: [
            "schema_version": "paios.central.text-envelope.v1", "operation": "model_settings_receipt",
            "session_id": "session", "control_id": "unrelated", "ok": true, "result": [:]]))
    }
    func reply(_ bytes: Data, id: String) throws -> CentralTextPacket {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let operation = try XCTUnwrap(object["operation"] as? String); operations.append(operation)
        try beforeReply?(operation)
        let request = object["request"] as? [String: Any] ?? [:]
        var result: [String: Any] = [:], error: String?
        switch operation {
        case "model_settings_read":
            let frozen = request["draft_id"] != nil, offset = request["offset"] as? Int ?? 0
            if frozen && offset == 1 && failSecondPage { error = "MODEL_SETTINGS_DRAFT_UNKNOWN"; break }
            let provider: [String: Any] = ["id": "provider", "display_name": "Fixture", "wire_protocol": "chat_completions",
                "base_url": "https://fixture.example/v1", "credential_ref": "credential"]
            let requestedRoles = draftRequest["roles"] as? [[String: Any]]
            let role = try AssistantModelSettingsWire.object(self.role(model: "original-model"))
            result = ["environment_id": "fixture", "revision": frozen ? revision + 1 : request["revision"] as? Int ?? revision, "desired": revision,
                "groups": ["brain": ["desired": revision, "effective": 1, "status": failedActivation ? "failed" : revision == 1 ? "effective" : "pending", "error": NSNull()]],
                "usage": ["local_date": "2026-10-24", "attempts": 1, "known_cny": 11, "estimated_cny": 2,
                    "unknown_attempts": 1, "foreign_currency_attempts": 0, "subscription_remaining": "套餐余量未知",
                    "threshold_cny": 10, "owner_reserve_cny": 1, "pause_on_limit": true, "paused": true, "resumed_local_date": NSNull()],
                "items": offset == 0 ? [["kind": "provider", "value": provider]] : [["kind": "role", "value": frozen ? requestedRoles?.first ?? role : role]],
                "next_offset": offset == 0 ? 1 : NSNull()]
            if frozen { result["draft"] = ["draft_id": "draft", "action": draftRequest["action"] ?? "commit", "payload": draftRequest] }
        case "model_settings_draft", "model_settings_set_key":
            if operation == "model_settings_set_key", request["draft_id"] != nil { mutations += 1; revision += 1; break }
            if request["action"] as? String == "undo" && undoNeedsKey { error = "MODEL_SETTINGS_KEY_REENTRY_REQUIRED"; break }
            draftRequest = request
            if operation == "model_settings_set_key" { draftRequest.removeValue(forKey: "key"); draftRequest["action"] = "set_key" }
            result = ["draft_id": "draft", "action": draftRequest["action"] ?? "commit", "expected_revision": revision,
                "change_sha256": hash, "expires_at_ms": Date().addingTimeInterval(240).timeIntervalSince1970 * 1000, "principal_id": "owner"]
        case "model_settings_challenge":
            if deviceClass == "mac" { error = "MODEL_SETTINGS_MAC_UNAUTHORIZED" }
            else { result = ["nonce": String(repeating: "A", count: 43), "expires_in_ms": 120000] }
        case "model_settings_watch":
            if changeOnWatch { revision = 2; changeOnWatch = false }
            result = ["environment_id": "fixture", "desired": revision,
                "groups": ["brain": ["desired": revision, "effective": 1, "status": failedActivation ? "failed" : revision == 1 ? "effective" : "pending", "error": NSNull()]]]
        case "model_settings_catalog":
            let offset = request["offset"] as? Int ?? 0
            result = ["draft_id": "draft", "change_sha256": hash, "provider_ref": "provider", "credential_ref": "credential",
                "credential_version": 1, "status": catalogStatus, "source": catalogStatus == "unavailable" ? "provider_no_list" : "provider_models_api",
                "fetched_at": "2026-10-24T12:00:00.000Z", "models": catalogStatus == "available" ? [["id": "model-\(offset)"]] : [],
                "message": catalogStatus == "unavailable" ? "服务商未提供模型列表，可填写模型 ID" : NSNull(),
                "safe_error": catalogStatus == "failed" ? "MODEL_SETTINGS_PROBE_FAILED" : NSNull(),
                "next_offset": catalogStatus == "available" && offset == 0 ? 1 : NSNull()]
        case "model_settings_commit", "model_settings_resume", "model_settings_pause":
            if conflict { revision = 3; error = "MODEL_SETTINGS_REVISION_CONFLICT" }
            else { mutations += 1; revision += 1; if loseReceipt { throw AssistantPaymentChannelError.timeout } }
        default: break
        }
        var body: [String: Any] = ["schema_version": "paios.central.text-envelope.v1", "operation": "model_settings_receipt",
            "session_id": "session", "control_id": id, "ok": error == nil]
        if let error { body["error_code"] = error } else { body["result"] = result }
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body))
    }
}
