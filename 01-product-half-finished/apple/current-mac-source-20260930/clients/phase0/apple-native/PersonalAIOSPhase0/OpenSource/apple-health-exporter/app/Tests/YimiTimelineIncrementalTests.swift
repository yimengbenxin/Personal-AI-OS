import Foundation
import XCTest
@testable import HealthKitExporter

final class YimiTimelineIncrementalTests: XCTestCase {
    func testWatchLatestIndexPreservesOwnerOrderEditsAndRetirement() {
        var timeline = YimiConversationTimeline(items: [
            YimiItem(id: "a1", kind: .her, text: "a1", date: .distantPast, seq: 1, ownerIdentity: "a"),
            YimiItem(id: "b2", kind: .her, text: "b2", date: .distantPast, seq: 2, ownerIdentity: "b"),
            YimiItem(id: "a4", kind: .her, text: "a4", date: .distantPast, seq: 4, ownerIdentity: "a"),
            YimiItem(id: "legacy", kind: .her, text: "legacy", date: .distantPast)
        ])
        XCTAssertNil(timeline.latestAssistantItem(ownerIdentity: nil))
        XCTAssertEqual(timeline.latestAssistantItem(ownerIdentity: "a")?.id, "a4")
        timeline.upsert(YimiItem(id: "a3", kind: .her, text: "older", date: .distantPast, seq: 3, ownerIdentity: "a"))
        XCTAssertEqual(timeline.latestAssistantItem(ownerIdentity: "a")?.id, "a4")
        var edited = timeline.item(id: "a4")!; edited.ownerIdentity = "b"; timeline.upsert(edited)
        XCTAssertEqual(timeline.latestAssistantItem(ownerIdentity: "a")?.id, "a3")
        XCTAssertEqual(timeline.latestAssistantItem(ownerIdentity: "b")?.id, "a4")
        timeline.remove(ids: ["a4"])
        XCTAssertEqual(timeline.latestAssistantItem(ownerIdentity: "b")?.id, "b2")
        timeline.remove(ids: ["a1", "b2", "a3"])
        XCTAssertNil(timeline.latestAssistantItem(ownerIdentity: "a"))
        XCTAssertNil(timeline.latestAssistantItem(ownerIdentity: "b"))
    }

    func testCallAndAmbientRowsFollowThePresentationOwnerTogether() {
        var timeline = YimiConversationTimeline()
        let call = CentralCall(id: "owner-call", state: "live", lines: [
            .init(callID: "owner-call", turn: 0, role: "user", text: "通话", interrupted: false)])
        let reply = CentralAmbientReply(id: "owner-wake", heard: "唤醒", text: "回应")
        timeline.accept(call, ownerIdentity: "owner"); timeline.accept(reply, ownerIdentity: "owner")
        XCTAssertTrue(timeline.items.allSatisfy { $0.ownerIdentity == "owner" })
        timeline.accept(call, ownerIdentity: nil); timeline.accept(reply, ownerIdentity: nil)
        XCTAssertTrue(timeline.items.allSatisfy { $0.ownerIdentity == nil })
    }

    func testRepeatedServerReplySettlesARequestRestoredAfterThatReply() {
        let reply = YimiItem(id: "her-late", kind: .her, text: "回复", date: Date(), seq: 2)
        var timeline = YimiConversationTimeline(items: [reply])
        var queued = YimiItem(id: "me-late", kind: .me, text: "请求", date: Date(), delivery: .sending, seq: 1)
        queued.setSubmissionDelivery(.queued, processedID: "late")
        timeline.upsert(queued)
        timeline.upsert(reply)
        XCTAssertNil(timeline.item(id: "me-late")?.deliveryStatus)
    }

    func testMacMergeDoesNotReplayLocalRowsFromTheCoordinatorsCache() {
        let date = Date()
        var display = YimiConversationTimeline(items: [YimiItem(id: "me-local", kind: .me, text: "latest", date: date)])
        let source = YimiConversationTimeline(items: [
            YimiItem(id: "me-local", kind: .me, text: "cached", date: date),
            YimiItem(id: "server", kind: .her, text: "reply", date: date, seq: 1, ownerIdentity: "owner")])
        display.merge(source, ownerIdentity: "owner", includeLocal: false)
        XCTAssertEqual(display.item(id: "me-local")?.text, "latest")
        XCTAssertEqual(display.item(id: "server")?.text, "reply")
    }

    func testIncrementalUpdatesMatchSnapshotOrderingDeliveryAndRemoval() {
        let date = Date(timeIntervalSince1970: 100)
        var waiting = YimiItem(id: "me-request", kind: .me, text: "下一句", date: date, delivery: .sending)
        waiting.setSubmissionDelivery(.queued, processedID: "request")
        let local = [
            waiting,
            YimiItem(id: "call-old", kind: .call, text: "", lines: [
                .init(role: "assistant", text: "回复", turn: 0), .init(role: "user", text: "提问", turn: 0)], date: date),
            YimiItem(id: "me-ambient-wake", kind: .me, text: "唤醒", date: date),
            YimiItem(id: "her-wake", kind: .her, text: "回应", date: date)
        ]
        var incremental = YimiConversationTimeline(items: local), reference = incremental
        var source = YimiConversationTimeline()
        for step in 0..<36 {
            if step == 12 { source.removeServerItems(seqs: [3, 5], before: 2) }
            else if step == 20 { source = YimiConversationTimeline() }
            else {
                let seq = step.isMultiple(of: 3) ? step + 2 : step + 1
                source.upsert(YimiItem(id: step == 8 ? "her-request" : "server-\(seq)", kind: .her,
                    text: "更新 \(step)", date: date.addingTimeInterval(Double(seq)), seq: seq, ownerIdentity: "owner"))
            }
            let retained = reference.items.filter { $0.seq == nil || $0.delivery != nil || $0.ownerIdentity != "owner" }
            reference = YimiConversationTimeline(items: retained + source.items)
            incremental.merge(source, ownerIdentity: "owner")
            XCTAssertEqual(incremental.items, reference.items, "source update \(step)")
            XCTAssertFalse(incremental.merge(source, ownerIdentity: "owner"))
        }
        XCTAssertEqual(incremental.callLines("old").map(\.text), ["提问", "回复"])
        XCTAssertTrue(incremental.items.filter { $0.id == "her-wake" }.allSatisfy { $0.via == "ambient" })
    }

    func testMissedRevisionsOwnerChangeAndDivergentCopiesReconcile() {
        let date = Date(timeIntervalSince1970: 100)
        var source = YimiConversationTimeline(items: [
            YimiItem(id: "one", kind: .her, text: "first", date: date, seq: 1, ownerIdentity: "first")])
        var display = YimiConversationTimeline()
        display.merge(source, ownerIdentity: "first")
        var sibling = source
        source.upsert(YimiItem(id: "one", kind: .her, text: "changed", date: date, seq: 1, ownerIdentity: "first"))
        sibling.upsert(YimiItem(id: "one", kind: .her, text: "sibling", date: date, seq: 1, ownerIdentity: "first"))
        display.merge(source, ownerIdentity: "first"); display.merge(sibling, ownerIdentity: "first")
        XCTAssertEqual(display.item(id: "one")?.text, "sibling")
        sibling.upsert(YimiItem(id: "two", kind: .her, text: "second", date: date, seq: 2, ownerIdentity: "first"))
        sibling.removeServerItems(seqs: [1], before: 0)
        display.merge(sibling, ownerIdentity: "first")
        XCTAssertEqual(display.items.map(\.id), ["two"])
        display.merge(YimiConversationTimeline(), ownerIdentity: "second")
        XCTAssertEqual(display.items.map(\.id), ["two"], "another owner's cache does not delete retained history")
    }

    func testTerminalCacheCannotRegressWhenOlderWriteArrivesLast() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        var newer = CentralTerminalState()
        newer.timeline.upsert(YimiItem(id: "new", kind: .her, text: "new", date: Date(), seq: 1))
        let writer = CentralTerminalCacheWriter()
        try await writer.write(newer, version: 2, to: url)
        try await writer.write(CentralTerminalState(), version: 1, to: url)
        var restored = CentralTerminalState(); try restored.restore(Data(contentsOf: url))
        XCTAssertEqual(restored.timeline.items.map(\.id), ["new"])
        try await writer.remove(version: 3, at: url)
        try await writer.write(newer, version: 2, to: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "an in-flight cache save cannot resurrect an unpaired cache")
    }
}
