import Foundation
import GRDB
import CryptoKit
import XCTest
@testable import HealthKitExporter

final class AssistantLocalOperationDatabaseTests: XCTestCase {
    func testN14DatabaseRollsBackToN13AndReopensWithoutReapplyingMigrations() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let nonce: String
        do {
            let n14 = try AssistantLocalOperationDatabase(url: url)
            _ = try n14.enqueue(operationID: "from-n14", kind: "start",
                fingerprint: String(repeating: "a", count: 64), createdAt: now)
            nonce = try XCTUnwrap(n14.preserveQwenHandoff(identity: "owner", sourceID: "source", now: now)).nonce
            let retired = try XCTUnwrap(n14.preserveQwenHandoff(identity: "retired-owner", sourceID: "retired", now: now))
            _ = try n14.markCompleted(operationID: retired.nonce, at: now)
        }
        let migrations: [String], schemaVersion: Int
        do {
            let inspection = try DatabaseQueue(path: url.path)
            (migrations, schemaVersion) = try inspection.read {
                (try String.fetchAll($0, sql: "SELECT identifier FROM grdb_migrations ORDER BY rowid"),
                 try Int.fetchOne($0, sql: "PRAGMA schema_version")!)
            }
        }
        XCTAssertEqual(migrations, ["v1_local_operation_cache", "v2_stop_replay_payload", "v3_place_outbox",
            "v4_move_outbox", "v5_outstanding_qwen_index"])
        do {
            let n13 = try N13LocalOperationDatabaseFixture(url: url)
            let original = try XCTUnwrap(n13.operation("from-n14"))
            XCTAssertEqual(original["fingerprint"] as String, String(repeating: "a", count: 64))
            XCTAssertEqual(original["created_at"] as Double, now.timeIntervalSince1970)
            try n13.enqueue("from-n13", kind: "start", fingerprint: String(repeating: "b", count: 64), now: now)
            XCTAssertEqual(try n13.operation("from-n13")?["state"] as String?, "pending")
            let records = try n13.qwenHandoffs()
            XCTAssertEqual(records.map(\.state), [.pending, .completed])
            let pending = try XCTUnwrap(records.first)
            XCTAssertEqual(pending.handoff.pending.nonce, nonce)
            XCTAssertEqual(pending.state, .pending)
            XCTAssertNil(pending.handoff.reply)
            try n13.reply(nonce: nonce, text: "reply written by N13", now: now)
            XCTAssertEqual(try n13.qwenHandoffs().first?.handoff.reply?.text, "reply written by N13")
        }
        do {
            let n14 = try AssistantLocalOperationDatabase(url: url)
            XCTAssertEqual(try n14.operation(operationID: "from-n14")?.state, .pending)
            XCTAssertEqual(try n14.operation(operationID: "from-n13")?.fingerprint, String(repeating: "b", count: 64))
            XCTAssertEqual(try n14.pendingQwenReply(identity: "owner")?.eventID, nonce)
            XCTAssertEqual(try n14.pendingQwenReply(identity: "owner")?.text, "reply written by N13")
        }
        let inspection = try DatabaseQueue(path: url.path)
        try inspection.read { db in
            XCTAssertEqual(try String.fetchAll(db, sql: "SELECT identifier FROM grdb_migrations ORDER BY rowid"), migrations)
            XCTAssertEqual(try Int.fetchOne(db, sql: "PRAGMA schema_version"), schemaVersion)
            XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'local_operations_outstanding_qwen'"), 1)
            XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT count(*) FROM local_operations"), 4)
        }
        print("N15_ROLLBACK N14(v1-v5)->N13(v1-v4)->N14 migrations=5 schema_unchanged=true operations=4 qwen_read_write=ok")
    }

    func testPlaceOutboxSurvivesReopenAndConsentCleanup() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let event = PlaceEvent(kind: .visitArrival, location: AssistantLocationObservation(localCaptureID: "capture",
            latitude: 3, longitude: 4, horizontalAccuracy: 10, observedAt: Date(timeIntervalSince1970: 1_700_000_000)),
            arrivalAt: Date(timeIntervalSince1970: 1_700_000_000))
        do {
            let database = try AssistantLocalOperationDatabase(url: url)
            var state = PlaceSensingState(); state.enabled = true; state.identity = "owner"
            try database.savePlaceState(state, clearOutbox: true)
            XCTAssertTrue(try database.persistPlaceEvent(event, identity: "owner"))
        }
        let database = try AssistantLocalOperationDatabase(url: url)
        XCTAssertEqual(try database.pendingPlaceEvents(), [event])
        var state = try database.placeState(); state.enabled = false
        try database.savePlaceState(state, clearOutbox: true)
        XCTAssertTrue(try database.pendingPlaceEvents().isEmpty)
        XCTAssertFalse(try database.persistPlaceEvent(event, identity: "owner"))
        XCTAssertTrue(try database.verifyFileProtection())
    }

    func testRetiredPlaceConsentRejectsLateResponseAndRetryWrites() throws {
        let (root, url) = try makeDatabaseURL(); defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)
        var active = PlaceSensingState(); active.enabled = true; active.identity = "owner"
        try database.savePlaceState(active, clearOutbox: true)
        var off = active; off.enabled = false
        try database.savePlaceState(off, clearOutbox: true)
        XCTAssertThrowsError(try database.savePlaceState(active))
        try database.savePlaceState(PlaceSensingState(), clearOutbox: true)
        XCTAssertThrowsError(try database.savePlaceState(off))
        XCTAssertFalse(try database.placeState().enabled)
        XCTAssertNil(try database.placeState().identity)
    }

    func testFileProtectionValueNormalizationRemainsStrict() {
        XCTAssertTrue(
            AssistantLocalOperationDatabase.isRequiredFileProtectionValue(
                AssistantLocalOperationDatabase.requiredFileProtection
            )
        )
        XCTAssertTrue(
            AssistantLocalOperationDatabase.isRequiredFileProtectionValue(
                AssistantLocalOperationDatabase.requiredFileProtection.rawValue
            )
        )
        XCTAssertFalse(
            AssistantLocalOperationDatabase.isRequiredFileProtectionValue(nil)
        )
        XCTAssertFalse(
            AssistantLocalOperationDatabase.isRequiredFileProtectionValue("none")
        )
    }

#if targetEnvironment(simulator)
    func testSimulatorProtectionReadbackAfterSuccessfulSet() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }

        let database = try AssistantLocalOperationDatabase(url: url)
        XCTAssertEqual(
            AssistantLocalOperationDatabase.requiredFileProtection,
            .completeUntilFirstUserAuthentication
        )
        XCTAssertTrue(try database.verifyFileProtection())
    }
#endif

    func testMigrationAndReopenRecoversPendingOperation() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }

        let createdAt = Date(timeIntervalSince1970: 1_700_000_000)
        do {
            let database = try AssistantLocalOperationDatabase(url: url)
            XCTAssertTrue(try database.verifyFileProtection())
            guard case .inserted(let operation) = try database.enqueue(
                operationID: "op-reopen",
                kind: "start",
                fingerprint: String(repeating: "a", count: 64),
                createdAt: createdAt
            ) else {
                return XCTFail("expected an inserted operation")
            }
            XCTAssertEqual(operation.state, .pending)
            XCTAssertEqual(operation.createdAt, createdAt)
        }

        let reopened = try AssistantLocalOperationDatabase(url: url)
        let recovered = try XCTUnwrap(reopened.operation(operationID: "op-reopen"))
        XCTAssertEqual(recovered.state, .pending)
        XCTAssertEqual(try reopened.replayableOperations().map(\.operationID), ["op-reopen"])
    }

    func testDuplicateSameFingerprintIsNoOp() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)

        guard case .inserted(let first) = try database.enqueue(
            operationID: "op-duplicate",
            kind: "start",
            fingerprint: String(repeating: "b", count: 64)
        ) else {
            return XCTFail("expected first insertion")
        }
        guard case .duplicate(let second) = try database.enqueue(
            operationID: "op-duplicate",
            kind: "start",
            fingerprint: String(repeating: "b", count: 64)
        ) else {
            return XCTFail("expected a duplicate no-op")
        }
        XCTAssertEqual(first, second)
        XCTAssertEqual(try database.pending().count, 1)
    }

    func testDifferentFingerprintIsConflictAndPreservesPreimage() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)

        _ = try database.enqueue(
            operationID: "op-conflict",
            kind: "start",
            fingerprint: String(repeating: "c", count: 64)
        )
        guard case .conflict(let existing) = try database.enqueue(
            operationID: "op-conflict",
            kind: "start",
            fingerprint: String(repeating: "d", count: 64)
        ) else {
            return XCTFail("expected a fingerprint conflict")
        }
        XCTAssertEqual(existing.fingerprint, String(repeating: "c", count: 64))
        XCTAssertEqual(
            try database.operation(operationID: "op-conflict")?.fingerprint,
            String(repeating: "c", count: 64)
        )
    }

    func testUnknownStopIsReplayableAndCanBeCompletedIdempotently() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)

        let unknown = try database.markStopUnknown(
            operationID: "op-stop",
            fingerprint: String(repeating: "e", count: 64)
        )
        XCTAssertEqual(unknown.state, .stopUnknown)
        XCTAssertTrue(unknown.isReplayable)
        XCTAssertEqual(try database.pending().count, 1)

        let completed = try database.markCompleted(
            operationID: "op-stop",
            fingerprint: String(repeating: "e", count: 64)
        )
        XCTAssertEqual(completed.state, .completed)
        XCTAssertFalse(completed.isReplayable)
        XCTAssertTrue(try database.pending().isEmpty)
        XCTAssertEqual(
            try database.markCompleted(
                operationID: "op-stop",
                fingerprint: String(repeating: "e", count: 64)
            ),
            completed
        )
        XCTAssertThrowsError(
            try database.recordAttempt(operationID: "op-stop")
        ) { error in
            XCTAssertEqual(
                error as? AssistantLocalOperationDatabaseError,
                .invalidTransition(operationID: "op-stop", state: "completed")
            )
        }
        XCTAssertThrowsError(
            try database.recordFailure(
                operationID: "op-stop",
                message: "Bearer secret-token-value"
            )
        ) { error in
            XCTAssertEqual(
                error as? AssistantLocalOperationDatabaseError,
                .invalidTransition(operationID: "op-stop", state: "completed")
            )
        }
    }

    func testSecretFieldsAreRejectedAndOpaqueReferenceIsNotCached() async throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)

        XCTAssertThrowsError(
            try database.enqueue(
                operationID: "op-metadata",
                kind: "start",
                fingerprint: String(repeating: "f", count: 64),
                metadata: ["participantToken": "do-not-store"]
            )
        ) { error in
            XCTAssertEqual(
                error as? AssistantLocalOperationDatabaseError,
                .forbiddenField("participantToken")
            )
        }

        let receipt = AppleLocalOperationReceipt(
            operationID: "op-cache",
            kind: .stop,
            recordedAt: Date(timeIntervalSince1970: 1_700_000_001),
            localCleanupComplete: true,
            remoteConfirmationPresent: false,
            statusCode: "remote_stop_unconfirmed",
            opaqueRemoteReference: "secret-token-value"
        )
        try database.cache(receipt)
        XCTAssertEqual(try database.cachedReceiptCount(), 1)
        let bytes = try Data(contentsOf: url)
        XCTAssertFalse(
            String(decoding: bytes, as: UTF8.self).contains("secret-token-value")
        )

        _ = try database.enqueue(
            operationID: "op-error",
            kind: "start",
            fingerprint: String(repeating: "1", count: 64)
        )
        let failed = try database.recordFailure(
            operationID: "op-error",
            message: "Bearer secret-token-value"
        )
        XCTAssertEqual(failed.lastError, "unspecified")
        let updatedBytes = try Data(contentsOf: url)
        XCTAssertFalse(
            String(decoding: updatedBytes, as: UTF8.self)
                .contains("secret-token-value")
        )
    }

    func testInputConstraintsRejectNonDigestAndSecretLikeIdentifiers() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)

        XCTAssertThrowsError(
            try database.enqueue(
                operationID: "op-invalid",
                kind: "start",
                fingerprint: "short"
            )
        ) { error in
            XCTAssertEqual(
                error as? AssistantLocalOperationDatabaseError,
                .invalidFingerprint
            )
        }
        XCTAssertThrowsError(
            try database.enqueue(
                operationID: "bearer-token",
                kind: "start",
                fingerprint: String(repeating: "2", count: 64)
            )
        ) { error in
            XCTAssertEqual(
                error as? AssistantLocalOperationDatabaseError,
                .forbiddenField("operationID")
            )
        }
        XCTAssertTrue(try database.verifyFileProtection())
    }

    func testStopUnknownAndReceiptCacheAreIdempotentAndBounded() async throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)
        let fingerprint = String(repeating: "3", count: 64)

        let first = try database.markStopUnknown(
            operationID: "op-idempotent-stop",
            fingerprint: fingerprint,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            at: Date(timeIntervalSince1970: 1_700_000_001)
        )
        let second = try database.markStopUnknown(
            operationID: "op-idempotent-stop",
            fingerprint: fingerprint,
            createdAt: Date(timeIntervalSince1970: 1_700_000_002),
            at: Date(timeIntervalSince1970: 1_700_000_003)
        )
        XCTAssertEqual(first, second)

        for index in 0..<140 {
            let receipt = AppleLocalOperationReceipt(
                operationID: "op-cache-\(index)",
                kind: .stop,
                recordedAt: Date(timeIntervalSince1970: 1_700_001_000 + Double(index)),
                localCleanupComplete: true,
                remoteConfirmationPresent: false,
                statusCode: "remote_stop_unconfirmed",
                opaqueRemoteReference: "opaque-\(index)"
            )
            try database.cache(receipt)
        }
        XCTAssertEqual(try database.cachedReceiptCount(), 128)
    }

    func testCompletedRetentionOnReopenPreservesReplayAndReferencedIdentities() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let fingerprint = String(repeating: "4", count: 64)
        let stopPayload = Data("pending-stop".utf8)
        let startPayload = Data("pending-bootstrap".utf8)
        do {
            let database = try AssistantLocalOperationDatabase(url: url)
            _ = try database.enqueue(operationID: "pending-start", kind: "start", fingerprint: fingerprint)
            _ = try database.enqueue(operationID: "pending-recovery", kind: "recovery", fingerprint: fingerprint)
            try database.preserveStopReplay(operationID: "active-start", payload: Data("active".utf8), kind: "bootstrap")
            try database.completeStopReplay(operationID: "active-start", kind: "bootstrap")
            try database.preserveStopReplay(operationID: "pending-stop", payload: stopPayload)
            try database.preserveStopReplay(operationID: "pending-bootstrap", payload: startPayload, kind: "bootstrap")
            try database.cache(AppleLocalOperationReceipt(
                operationID: "done-000", kind: .stop, recordedAt: Date(),
                localCleanupComplete: true, remoteConfirmationPresent: true,
                statusCode: "stopped", opaqueRemoteReference: nil
            ))
        }
        // Simulate an existing installation's terminal backlog before reopening.
        do {
            let queue = try DatabaseQueue(path: url.path)
            try queue.write { db in
                for index in 0..<140 {
                    try db.execute(sql: """
                        INSERT INTO local_operations
                        (operation_id, kind, fingerprint, state, created_at, updated_at, attempt_count)
                        VALUES (?, 'start', ?, 'completed', ?, ?, 0)
                        """, arguments: [String(format: "done-%03d", index), fingerprint, Double(index), Double(index)])
                }
            }
        }
        let reopened = try AssistantLocalOperationDatabase(url: url)
        XCTAssertEqual(Set(try reopened.pending().map(\.operationID)),
                       ["pending-start", "pending-recovery", "pending-stop", "pending-bootstrap"])
        XCTAssertEqual(try reopened.pendingStopReplay()?.payload, stopPayload)
        XCTAssertEqual(try reopened.pendingStopReplay(kind: "bootstrap")?.payload, startPayload)
        XCTAssertNotNil(try reopened.operation(operationID: "done-000"))
        XCTAssertNil(try reopened.operation(operationID: "done-011"))
        XCTAssertNotNil(try reopened.operation(operationID: "done-012"))
        XCTAssertNotNil(try reopened.operation(operationID: "active-start"))
        _ = try reopened.markCompleted(operationID: "pending-start")
        XCTAssertNil(try reopened.operation(operationID: "done-012"))
        XCTAssertNotNil(try reopened.operation(operationID: "pending-recovery"))
        try reopened.supersedeControlReplays()
        try reopened.preserveStopReplay(operationID: "active-start", payload: Data("active-stop".utf8))
        XCTAssertEqual(try reopened.pendingStopReplay()?.operationID, "active-start")
        let inspection = try DatabaseQueue(path: url.path)
        let terminalCount = try inspection.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM local_operations WHERE state = 'completed'")
        }
        XCTAssertEqual(terminalCount, 129) // 128 latest terminal rows plus the retained receipt identity.
    }

    func testOversizedQwenReplyLeavesItsNonceAvailableForAShorterReply() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)
        let pending = try XCTUnwrap(database.preserveQwenHandoff(identity: "owner", sourceID: "source"))
        let long = try XCTUnwrap(URL(string: "paios://qwen-result/\(pending.nonce)?result=" + String(repeating: "%E7%95%8C", count: 4_000)))
        XCTAssertThrowsError(try database.consumeQwenReply(long, identity: "owner")) { error in
            XCTAssertEqual(error as? AssistantLocalOperationDatabaseError, .qwenReplyTooLarge)
        }
        XCTAssertNil(try database.pendingQwenReply(identity: "owner"))
        let short = try XCTUnwrap(URL(string: "paios://qwen-result/\(pending.nonce)?result=ok"))
        XCTAssertEqual(try database.consumeQwenReply(short)?.text, QwenHandoff.replyPrefix + "ok", "A registered callback is durable before cold-start pairing authentication")
        XCTAssertNil(try database.consumeQwenReply(short, identity: "owner"), "The durably transferred nonce is consumed once")
    }

    /// A saved 千问 reply resent after a session change settles once the gateway says an earlier session admitted it.
    func testOutstandingQwenQueriesDoNotDecodeCompletedReplayHistory() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)
        let old = try XCTUnwrap(database.preserveQwenHandoff(identity: "owner", sourceID: "old"))
        _ = try database.markCompleted(operationID: old.nonce)
        let pending = try XCTUnwrap(database.preserveQwenHandoff(identity: "owner", sourceID: "current"))
        let inspection = try DatabaseQueue(path: url.path)
        try inspection.write { db in
            try db.execute(sql: "UPDATE local_operations SET replay_payload = ? WHERE operation_id = ?",
                arguments: [Data("invalid retired payload".utf8), old.nonce])
            try db.execute(sql: """
                WITH RECURSIVE retired(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM retired WHERE n < 5000)
                INSERT INTO local_operations (operation_id, kind, fingerprint, state, created_at, updated_at, attempt_count, replay_payload)
                SELECT 'retired-' || n, 'qwen_handoff', 'retired', 'completed', 0, 0, 0, X'00' FROM retired
                """)
        }
        XCTAssertNil(try database.pendingQwenReply(identity: "owner"))
        let reply = try database.consumeQwenReply(XCTUnwrap(URL(string: "paios://qwen-result/\(pending.nonce)?result=ok")), identity: "owner")
        XCTAssertEqual(try database.pendingQwenReply(identity: "owner"), reply)
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: CentralTextTestFixture().binding, generation: 1, ownerPairingIdentity: "owner")
        XCTAssertNoThrow(try database.acknowledgeQwenReply(consumer))
        XCTAssertThrowsError(try database.preserveQwenHandoff(identity: "owner", sourceID: "old"),
            "The source-deduplication path still validates completed history")
    }

    func testQwenReplyAdmittedByAnEarlierSessionCompletesOnTheSessionConflict() throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)
        let pending = try XCTUnwrap(database.preserveQwenHandoff(identity: "owner", sourceID: "source"))
        let reply = try XCTUnwrap(database.consumeQwenReply(XCTUnwrap(URL(string: "paios://qwen-result/\(pending.nonce)?result=ok")), identity: "owner"))
        let binding = try CentralTextTestFixture().binding
        var consumer = AssistantCentralTextConsumer()
        try consumer.reset(binding: binding, generation: 1, ownerPairingIdentity: "owner")
        _ = try consumer.beginSubmit(eventID: reply.eventID, capturedAt: reply.capturedAt, text: reply.text)
        try database.acknowledgeQwenReply(consumer)
        XCTAssertEqual(try database.pendingQwenReply(identity: "owner"), reply, "a send is not an admission")
        let rejection: [String: Any] = ["schema_version": AssistantCentralTextWire.schema, "operation": "rejected",
            "session_id": binding.sessionID, "request_operation": "submit", "event_id": reply.eventID,
            "control_id": NSNull(), "processed_event_id": NSNull(), "error_code": "D_SESSION_CONFLICT"]
        try consumer.accept(AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: rejection)))
        try database.acknowledgeQwenReply(consumer)
        XCTAssertNil(try database.pendingQwenReply(identity: "owner"))
    }

    func testAppleReceiptStoreUsesOnlyLocalCacheSeam() async throws {
        let (root, url) = try makeDatabaseURL()
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: url)
        let store = AppleReceiptStore(localPendingCache: database)
        let receipt = AppleLocalOperationReceipt(
            operationID: "op-seam",
            kind: .start,
            recordedAt: Date(timeIntervalSince1970: 1_700_000_002),
            localCleanupComplete: false,
            remoteConfirmationPresent: false,
            statusCode: "started",
            opaqueRemoteReference: "opaque-reference"
        )

        try await store.append(receipt)
        XCTAssertEqual(try database.cachedReceiptCount(), 1)
        let recent = try await store.recent()
        XCTAssertEqual(recent, [receipt])
    }

    func testAppleReceiptStoreFilePersistenceDropsOpaqueReferenceAndDeduplicates()
        async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("a4-receipts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appendingPathComponent("receipts.json")
        let receipt = AppleLocalOperationReceipt(
            operationID: "op-file",
            kind: .stop,
            recordedAt: Date(timeIntervalSince1970: 1_700_000_100),
            localCleanupComplete: true,
            remoteConfirmationPresent: false,
            statusCode: "remote_stop_unconfirmed",
            opaqueRemoteReference: "secret-token-value"
        )

        do {
            let store = AppleReceiptStore(fileURL: fileURL)
            try await store.append(receipt)
            try await store.append(receipt)
            let recent = try await store.recent()
            XCTAssertEqual(recent.count, 1)
        }

        let bytes = try Data(contentsOf: fileURL)
        let persisted = String(decoding: bytes, as: UTF8.self)
        XCTAssertFalse(persisted.contains("opaqueRemoteReference"))
        XCTAssertFalse(persisted.contains("secret-token-value"))

        let reopened = AppleReceiptStore(fileURL: fileURL)
        let recovered = try await reopened.recent()
        XCTAssertEqual(recovered.count, 1)
        XCTAssertNil(recovered[0].opaqueRemoteReference)
    }

    func testAppleReceiptStoreCorruptPersistenceFailsClosed() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("a4-receipts-corrupt-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: root) }
        let fileURL = root.appendingPathComponent("receipts.json")
        try Data(#"[{"operationID":"op","opaqueRemoteReference":"secret"}]"#.utf8)
            .write(to: fileURL)

        let store = AppleReceiptStore(fileURL: fileURL)
        for _ in 0..<2 {
            do {
                _ = try await store.recent()
                XCTFail("corrupt persistence must fail closed")
            } catch let error as AppleReceiptStoreError {
                XCTAssertEqual(error, .corruptPersistence)
            }
        }
    }

    private func makeDatabaseURL() throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("a4-grdb-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        return (root, root.appendingPathComponent("operations.sqlite"))
    }
}

// Frozen migration registrations and SQL from N13 bdc24da15157ae2cb683e57c668d957878dfc2e7,
// Core/AssistantLocalOperationDatabase.swift. Exercise the old schema contract, not a reduced migrator.
private struct N13LocalOperationDatabaseFixture {
    private let queue: DatabaseQueue
    init(url: URL) throws {
        queue = try DatabaseQueue(path: url.path)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1_local_operation_cache") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS local_operations (
                    operation_id TEXT NOT NULL PRIMARY KEY,
                    kind TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                )
                """)
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS local_receipt_cache (
                    operation_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    recorded_at REAL NOT NULL,
                    local_cleanup_complete INTEGER NOT NULL,
                    remote_confirmation_present INTEGER NOT NULL,
                    status_code TEXT NOT NULL,
                    PRIMARY KEY (operation_id, kind)
                )
                """)
            try db.execute(sql: """
                CREATE INDEX IF NOT EXISTS local_operations_replay_index
                ON local_operations (state, updated_at, created_at)
                """)
        }
        migrator.registerMigration("v2_stop_replay_payload") { db in
            try db.execute(sql: "ALTER TABLE local_operations ADD COLUMN replay_payload BLOB")
        }
        migrator.registerMigration("v3_place_outbox") { db in
            try db.execute(sql: "CREATE TABLE place_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload BLOB NOT NULL)")
            try db.execute(sql: "CREATE TABLE place_outbox (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL)")
        }
        migrator.registerMigration("v4_move_outbox") { db in
            try db.execute(sql: "CREATE TABLE move_outbox (id TEXT PRIMARY KEY NOT NULL, identity TEXT NOT NULL, payload BLOB NOT NULL)")
            try db.execute(sql: "CREATE TABLE move_checkpoint (identity TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL)")
        }
        try migrator.migrate(queue)
    }

    func operation(_ operationID: String) throws -> Row? {
        try queue.read { db in
            try Row.fetchOne(db, sql: """
                SELECT operation_id, kind, fingerprint, state, created_at,
                       updated_at, attempt_count, last_error
                FROM local_operations
                WHERE operation_id = ?
                """, arguments: [operationID])
        }
    }

    func enqueue(_ operationID: String, kind: String, fingerprint: String, now: Date) throws {
        try queue.write { db in
            try db.execute(sql: """
                INSERT INTO local_operations
                    (operation_id, kind, fingerprint, state, created_at,
                     updated_at, attempt_count, last_error)
                VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
                """, arguments: [operationID, kind, fingerprint, AssistantLocalOperationState.pending.rawValue,
                    now.timeIntervalSince1970, now.timeIntervalSince1970])
        }
    }

    struct AssistantLocalQwenHandoff: Codable {
        let identity: String
        let sourceID: String
        let pending: QwenHandoff.Pending
        var reply: AssistantRetainedPrompt?
    }

    private static func stopReplayFingerprint(_ payload: Data) -> String {
        SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    }

    func qwenHandoffs() throws -> [(handoff: AssistantLocalQwenHandoff, state: AssistantLocalOperationState)] {
        try queue.read { db in
            try Row.fetchAll(db, sql: "SELECT * FROM local_operations WHERE kind = 'qwen_handoff' AND (state != 'completed' OR replay_payload IS NOT NULL) ORDER BY rowid").map { row in
                guard let payload: Data = row["replay_payload"], Self.stopReplayFingerprint(payload) == (row["fingerprint"] as String) else { throw AssistantLocalOperationDatabaseError.corruptRow }
                let handoff = try JSONDecoder().decode(AssistantLocalQwenHandoff.self, from: payload)
                guard handoff.pending.nonce == (row["operation_id"] as String), let state = AssistantLocalOperationState(rawValue: row["state"]) else { throw AssistantLocalOperationDatabaseError.corruptRow }
                return (handoff, state)
            }
        }
    }

    func reply(nonce: String, text: String, now: Date) throws {
        var handoff = try XCTUnwrap(qwenHandoffs().first { $0.handoff.pending.nonce == nonce }).handoff
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let reply = AssistantRetainedPrompt(identity: handoff.identity, eventID: handoff.pending.nonce,
            capturedAt: formatter.string(from: now), text: text, location: nil)
        handoff.reply = reply
        let payload = try JSONEncoder().encode(handoff)
        try queue.write { db in
            try db.execute(sql: "UPDATE local_operations SET replay_payload = ?, fingerprint = ?, updated_at = ? WHERE operation_id = ?", arguments: [payload, Self.stopReplayFingerprint(payload), now.timeIntervalSince1970, reply.eventID])
        }
    }
}
