import Foundation
import XCTest
@testable import DesktopKit

final class HistoryEpochTests: XCTestCase {
    func testAuthenticatedEpochRetiresAuditAndTemporaryPayloadsButKeepsSettings() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-history-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = root.appendingPathComponent("store"), allowed = root.appendingPathComponent("allowed")
        try FileManager.default.createDirectory(at: allowed, withIntermediateDirectories: true)
        let desktop = try TestDesktop.make(store: store, resources: root.appendingPathComponent("unused"))
        _ = try await desktop.authorize(folder: allowed, write: true)
        let settings = try Data(contentsOf: store.appendingPathComponent("guard.json"))
        let journal = try await desktop.history.guardJournal()
        for name in ["undo", "transfers", "opengcua-output"] {
            let path = store.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true)
            try Data("synthetic history".utf8).write(to: path.appendingPathComponent("old"))
        }
        let epoch = String(repeating: "a", count: 32)
        try await desktop.acceptTrustedHistoryEpoch(epoch)
        let records = try await desktop.audit(before: nil, limit: 100)
        XCTAssertTrue(records.isEmpty)
        XCTAssertEqual(try Data(contentsOf: store.appendingPathComponent("guard.json")), settings)
        let afterJournal = try await desktop.history.guardJournal()
        XCTAssertEqual(afterJournal, journal)
        for name in ["undo", "transfers", "opengcua-output"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: store.appendingPathComponent(name).path))
        }
        _ = try await desktop.authorize(folder: allowed, write: true)
        try await desktop.acceptTrustedHistoryEpoch(epoch)
        let newRecords = try await desktop.audit(before: nil, limit: 100)
        XCTAssertFalse(newRecords.isEmpty, "reconnect keeps post-reset history")
    }

    func testWeChatEpochKeepsItsConsentAndDoesNotReplayOldNotifications() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("wechat-history-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("preview.json"), inbox = try WeChatPreviewInbox(file: file)
        var policy = WeChatPreviewPolicy(); policy.enabled = true; policy.chats = ["synthetic-chat"]
        try await inbox.configure(policy, owner: "synthetic-owner", now: Date(timeIntervalSince1970: 1))
        try await inbox.acceptTrustedHistoryEpoch(String(repeating: "a", count: 32), now: Date(timeIntervalSince1970: 100))
        let after = await inbox.policy()
        XCTAssertEqual(after, policy)
        let bytes = try Data(contentsOf: file)
        try await inbox.acceptTrustedHistoryEpoch(String(repeating: "a", count: 32), now: Date(timeIntervalSince1970: 200))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
}
