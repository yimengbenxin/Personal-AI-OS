import Foundation
import GRDB
import XCTest
@testable import HealthKitExporter

final class HistoryEpochTests: XCTestCase {
    func testV5IndexIsEmptiedWithoutMigratingOrRepeatingOnReconnect() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("assistant-local-operations.sqlite")
        let db = try AssistantLocalOperationDatabase(url: url)
        let inspection = try DatabaseQueue(path: url.path)
        func migrations() throws -> [String] {
            try inspection.read { try String.fetchAll($0, sql: "SELECT identifier FROM grdb_migrations ORDER BY rowid") }
        }
        let before = try migrations()
        _ = try db.enqueue(operationID: "old", kind: "start", fingerprint: String(repeating: "a", count: 64), createdAt: Date())
        let epoch = String(repeating: "a", count: 32)
        try db.discardProductHistory(epoch: epoch)
        XCTAssertTrue(try db.pending().isEmpty)
        XCTAssertEqual(try migrations(), before)
        _ = try db.enqueue(operationID: "new", kind: "start", fingerprint: String(repeating: "b", count: 64), createdAt: Date())
        try db.discardProductHistory(epoch: epoch)
        XCTAssertNotNil(try db.operation(operationID: "new"))
    }

    func testEpochRetiresLocalRowsAndSurvivesCacheRestore() throws {
        var state = CentralTerminalState()
        state.bindOwner("synthetic-owner")
        state.timeline.upsert(YimiItem(id: "old", kind: .her, text: "synthetic history", date: Date()))
        state.lastSeq = 50
        XCTAssertTrue(state.applyHistoryEpoch(String(repeating: "a", count: 32)))
        XCTAssertTrue(state.timeline.items.isEmpty)
        XCTAssertEqual(state.lastSeq, 0)
        XCTAssertEqual(state.ownerIdentity, "synthetic-owner")
        var restored = CentralTerminalState()
        try restored.restore(state.encodedCache())
        XCTAssertFalse(restored.applyHistoryEpoch(String(repeating: "a", count: 32)))
        XCTAssertTrue(restored.historyEpochConfirmed)
        XCTAssertTrue(restored.applyHistoryEpoch(String(repeating: "b", count: 32)), "rollback uses another generation")
    }

    func testConversationStorePurgesCorruptCopiesBeforeCommittingEpoch() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema,
            origin: RealtimeAPIOriginMigration.legacyOrigin, deviceID: "phone", userID: "synthetic-owner", token: "synthetic-token",
            governance: RealtimeWireGovernance(purposeScopes: [], consentRecordRefs: [], policyDecisionRefs: [],
                purposeTokenRefs: [], capabilityGrantRefs: []), media: ["data"], pairedAt: "2026-10-25T00:00:00Z")
        let store = try XCTUnwrap(YimiConversationStore(folder: folder, pairing: pairing))
        try store.write([YimiItem(id: "old", kind: .her, text: "synthetic history", date: Date())])
        let corrupt = store.url.deletingPathExtension().appendingPathExtension("corrupt-1.json")
        try Data("synthetic history".utf8).write(to: corrupt)
        let legacy = folder.appendingPathComponent("yimi-conversation.json")
        let guest = folder.appendingPathComponent("yimi-conversation-guest.json")
        try Data("synthetic old owner".utf8).write(to: legacy)
        try Data("synthetic guest".utf8).write(to: guest)
        let fixture = folder.appendingPathComponent("acceptance-fixture.json")
        try Data("protected fixture".utf8).write(to: fixture)
        let epoch = String(repeating: "a", count: 32)
        try store.retireHistory(for: epoch)
        XCTAssertTrue(try store.load().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: corrupt.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: guest.path))
        XCTAssertEqual(store.historyEpoch(), epoch)
        XCTAssertEqual(try Data(contentsOf: fixture), Data("protected fixture".utf8))
        try store.write([YimiItem(id: "new", kind: .her, text: "new synthetic history", date: Date())], historyEpoch: epoch)
        try store.retireHistory(for: epoch)
        XCTAssertEqual(try store.load().count, 1)
        let newer = String(repeating: "b", count: 32)
        try store.retireHistory(for: newer, generation: AssistantHistoryFiles.nextGeneration())
        XCTAssertThrowsError(try store.retireHistory(for: epoch, generation: 0), "a delayed older writer cannot reset the epoch backwards")
        XCTAssertThrowsError(try store.write([], historyEpoch: epoch))
        XCTAssertEqual(store.historyEpoch(), newer)
    }
}
