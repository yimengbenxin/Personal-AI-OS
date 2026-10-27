import Darwin
import Foundation
import XCTest
@testable import HealthKitExporter

final class YimiActivityLayoutTests: XCTestCase {
    private func activity(_ id: String, state: CentralActivityCard.State = .succeeded,
                          at: String = "2026-10-24T00:00:00.000Z", arrivedAt: Date = Date()) -> ActivityPresentation {
        let card = CentralActivityCard(id: id, revision: 1, state: state, summary: "合成任务",
            step_summary: nil, summary_source: .generic, started_at: at, observed_at: at, last_progress_at: at,
            elapsed_ms: 1000, completed_at: state == .running ? nil : at,
            counts: .init(total: 1, running: state == .running ? 1 : 0, succeeded: state == .succeeded ? 1 : 0,
                failed: 0, cancelled: 0, partial: nil), items: [], omitted_items: 0, failure_reason: nil)
        return ActivityPresentation(update: .init(operation: "activity_update", session_id: "test",
            processed_event_id: id, card: card), arrivedAt: arrivedAt)
    }

    func testAnchorsUseWholeHistoryAndKeepRequestAndReplySemantics() {
        let date = Date()
        let items = [
            YimiItem(id: "me-first", kind: .me, text: "request", date: date, submissionProcessedID: "done"),
            YimiItem(id: "me-second", kind: .me, text: "request", date: date, submissionProcessedID: "done"),
            YimiItem(id: "her-done", kind: .her, text: "reply", date: date),
            YimiItem(id: "me-running", kind: .me, text: "request", date: date, submissionProcessedID: "running")
        ]
        let cards = [activity("done"), activity("running", state: .running), activity("missing")]
        let layout = YimiActivityLayout(items: items, activities: cards, consumer: nil)
        XCTAssertEqual(layout.under["her-done"]?.map(\.id), ["done"])
        XCTAssertNil(layout.under["me-first"])
        XCTAssertEqual(layout.under["me-running"]?.map(\.id), ["running"])
        XCTAssertEqual(layout.unanchored.map(\.id), ["missing"])
        XCTAssertEqual(layout.anchor(for: cards[0]), "her-done")
        let waiting = YimiActivityLayout(items: Array(items.prefix(2)), activities: [cards[0]], consumer: nil)
        XCTAssertEqual(waiting.under["me-first"]?.map(\.id), ["done"])
        XCTAssertEqual(waiting.under["me-second"]?.map(\.id), ["done"])
        XCTAssertEqual(waiting.anchor(for: cards[0]), "me-first")
        XCTAssertTrue(waiting.unanchored.isEmpty)
    }

    func testMissingRequestUsesOwnReplyWithoutCollapsingRunningCard() {
        let items = [YimiItem(id: "her-running", kind: .her, text: "reply", date: .distantPast)]
        let card = activity("running", state: .running)
        let layout = YimiActivityLayout(items: items, activities: [card], consumer: nil)
        XCTAssertEqual(layout.under["her-running"]?.map(\.id), ["running"])
        XCTAssertEqual(layout.anchor(for: card), "her-running")
        XCTAssertFalse(card.collapsed(replyProcessedIDs: layout.replyProcessedIDs))
        XCTAssertTrue(layout.unanchored.isEmpty)
        let done = activity("running")
        XCTAssertTrue(done.collapsed(replyProcessedIDs: layout.replyProcessedIDs))
    }

    func testLongHistoryKeepsExactAnchorsOutsideVisibleTail() {
        let start = ISO8601.utc.date(from: "2026-10-24T00:00:00.000Z")!
        let items = [YimiItem(id: "request", kind: .me, text: "old request", date: .distantPast,
                              submissionProcessedID: "running")]
            + (0..<500).map { YimiItem(id: "her-\($0)", kind: .her, text: "history", date: start.addingTimeInterval(Double($0))) }
        let card = activity("running", state: .running)
        let orphan = activity("orphan")
        let layout = YimiActivityLayout(items: items, activities: [card, orphan], consumer: nil)
        XCTAssertEqual(layout.under["request"]?.map(\.id), ["running"])
        XCTAssertEqual(layout.under["her-0"]?.map(\.id), ["orphan"])
        XCTAssertEqual(layout.anchor(for: card), "request")
        XCTAssertTrue(layout.leading.isEmpty)
        XCTAssertEqual(layout.unanchored.map(\.id), ["orphan"])
        XCTAssertTrue(items.suffix(80).allSatisfy { layout.under[$0.id] == nil })
    }

    func testReplayUsesStartedAtAndPreservesCardOrderWithinChronologicalSlots() {
        let start = ISO8601.utc.date(from: "2026-10-24T00:00:00.000Z")!
        let items = [
            YimiItem(id: "first", kind: .her, text: "first", date: start),
            YimiItem(id: "last", kind: .her, text: "last", date: start.addingTimeInterval(120))
        ]
        func replay(at arrival: Date) -> YimiActivityLayout {
            YimiActivityLayout(items: items, activities: [
                activity("before", at: "2026-10-23T23:59:00.000Z", arrivedAt: arrival),
                activity("between-a", at: "2026-10-24T00:01:00.000Z", arrivedAt: arrival),
                activity("between-b", at: "2026-10-24T00:00:30Z", arrivedAt: arrival),
                activity("new", state: .running, at: "2026-10-24T00:03:00.000Z", arrivedAt: arrival)
            ], consumer: nil)
        }
        for arrival in [start, start.addingTimeInterval(86_400)] {
            let layout = replay(at: arrival)
            XCTAssertEqual(layout.leading.map(\.id), ["before"])
            XCTAssertEqual(layout.under["first"]?.map(\.id), ["between-a", "between-b"])
            XCTAssertEqual(layout.under["last"]?.map(\.id), ["new"])
        }
    }

    func testEmptyHistoryPlacesOrphanBeforeAnyRows() {
        let layout = YimiActivityLayout(items: [], activities: [activity("missing")], consumer: nil)
        XCTAssertEqual(layout.leading.map(\.id), ["missing"])
        XCTAssertTrue(layout.under.isEmpty)
    }

    @MainActor func testOwnerScaleActivityProjection() {
        let count = ProcessInfo.processInfo.environment["YIMI_PERF_ITEMS"].flatMap(Int.init) ?? 5000
        let items = (0..<count).map { YimiItem(id: "her-\($0)", kind: .her, text: "历史", date: .distantPast) }
        let cards = [activity("missing")]
        let start = ProcessInfo.processInfo.systemUptime
        var threadTime = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &threadTime)
        let cpuStart = Double(threadTime.tv_sec) + Double(threadTime.tv_nsec) / 1_000_000_000
        var orphaned: [ActivityPresentation]
        if ProcessInfo.processInfo.environment["YIMI_PERF_LEGACY_ACTIVITY"] == "1" {
            // The pre-fix UI's exact orphan-card search, retained only to reproduce its measured regression.
            orphaned = cards.filter { card in
                !items.contains { item in
                    let replies = Set(items.filter { $0.kind == .her }.compactMap(\.processedEventID))
                    if card.collapsed(replyProcessedIDs: replies) {
                        return item.kind == .her && item.processedEventID == card.processedEventID
                    }
                    return item.kind == .me && item.activityProcessedEventID(consumer: nil) == card.processedEventID
                }
            }
        } else {
            orphaned = YimiActivityLayout(items: items, activities: cards, consumer: nil).unanchored
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - start
        clock_gettime(CLOCK_THREAD_CPUTIME_ID, &threadTime)
        let usedCPU = Double(threadTime.tv_sec) + Double(threadTime.tv_nsec) / 1_000_000_000 - cpuStart
        print("YIMI_ACTIVITY_PERF items=\(count) orphan_cards=1 wall_ms=\(elapsed * 1000) thread_cpu_ms=\(usedCPU * 1000)")
        XCTAssertEqual(orphaned.map(\.id), ["missing"])
        XCTAssertLessThan(usedCPU, 0.020, "one card must not repeatedly scan the full history")
    }
}
