import XCTest
@testable import HealthKitExporter

final class YimiChatScrollTests: XCTestCase {
    func testVoiceIconUsesInputModalityAcrossLiveAndCachedItems() throws {
        for via in ["text", "ptt", "ambient", "call", "errand", "proactive", "queue", "chat"] {
            let item = YimiItem(id: "me-1", kind: .me, text: "hello", date: .distantPast, via: via)
            let restored = try JSONDecoder().decode(YimiItem.self, from: JSONEncoder().encode(item))
            XCTAssertEqual(restored.isVoiceInput, ["ptt", "ambient", "call"].contains(via), via)
        }
        XCTAssertFalse(YimiItem(id: "local", kind: .me, text: "typed", date: .distantPast).isVoiceInput)
    }

    private func metrics(_ top: CGFloat, _ bottom: CGFloat, _ viewport: CGFloat = 600) -> YimiChatScrollState.Metrics {
        .init(top: top, bottom: bottom, viewport: viewport)
    }

    /// The field failure: the list sat at the bottom, replies from another device and from her kept arriving, and the
    /// view never followed. Following is the owner being at the bottom; the list growing is never read as the owner leaving.
    func testPinnedListFollowsReplyFromAnotherDeviceAndEveryLaterOne() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        var height: CGFloat = 2000
        _ = scroll.update(metrics(600 - height, 600))
        for _ in 0..<3 {
            _ = scroll.update(metrics(600 - height, 900))      // a 300 pt reply arrives below the fold
            height += 300
            XCTAssertTrue(scroll.pinned, "growth alone never releases the owner")
            _ = scroll.update(metrics(600 - height, 600))      // the scroll to the bottom marker landed
            XCTAssertTrue(scroll.pinned)
        }
    }

    func testPinnedListFollowsStreamingTypingDotsCardsAndKeyboard() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        _ = scroll.update(metrics(-400, 640))
        XCTAssertTrue(scroll.pinned, "typing dots or a new card")
        _ = scroll.update(metrics(-400, 700))
        _ = scroll.update(metrics(-400, 760))
        XCTAssertTrue(scroll.pinned, "streaming height")
        _ = scroll.update(metrics(-400, 760, 320))
        XCTAssertTrue(scroll.pinned, "keyboard resize")
    }

    func testKeyboardPositioningWithoutAHistoryGestureKeepsFollowing() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        _ = scroll.update(metrics(-400, 600, 320))
        _ = scroll.update(metrics(-440, 560, 320))
        XCTAssertTrue(scroll.pinned, "same-size keyboard positioning is not a history gesture")
        _ = scroll.update(metrics(-440, 560, 600))
        _ = scroll.update(metrics(-400, 600))
        XCTAssertTrue(scroll.pinned)
    }

    func testReplacingAnEqualHeightTailRowDoesNotReleaseFollowing() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        _ = scroll.update(metrics(-300, 700))
        XCTAssertTrue(scroll.pinned, "a fixed-size tail can move before its new bottom target lands")
        _ = scroll.update(metrics(-400, 600))
        XCTAssertTrue(scroll.pinned)
        _ = scroll.drag(towardHistory: true, began: true)
        _ = scroll.update(metrics(-300, 700))
        XCTAssertFalse(scroll.pinned, "the same geometry after an actual history drag releases following")
    }

    func testScrollLandingWithinTheSlackStaysPinned() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        _ = scroll.update(metrics(-400, 900))
        _ = scroll.update(metrics(-660, 640))
        XCTAssertTrue(scroll.pinned)
    }

    func testReadingHistoryDoesNotJumpOnNewReplyOrKeyboardButSendingAlwaysFollows() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        XCTAssertFalse(scroll.drag(towardHistory: true, began: true))
        _ = scroll.update(metrics(-100, 900))
        XCTAssertFalse(scroll.pinned)
        _ = scroll.update(metrics(-100, 950))
        _ = scroll.update(metrics(-100, 950, 320))
        XCTAssertFalse(scroll.pinned, "a reply or the keyboard while reading does not move the list")
        scroll.showLatest()
        XCTAssertTrue(scroll.pinned, "own send")
        _ = scroll.update(metrics(-100, 1000, 320))
        XCTAssertTrue(scroll.pinned)
    }

    func testFlickAwayFromBottomIsReleasedByTheScrollItself() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        _ = scroll.drag(towardHistory: true, began: true)
        scroll.endDrag()                                       // released while still near the bottom
        _ = scroll.update(metrics(-370, 630))
        XCTAssertTrue(scroll.pinned)
        _ = scroll.update(metrics(100, 1100))                  // momentum carries on toward history
        XCTAssertFalse(scroll.pinned)
        _ = scroll.update(metrics(100, 1400))                  // a reply arrives while reading
        XCTAssertFalse(scroll.pinned)
    }

    func testDismissingTheKeyboardWithADragAtTheBottomStaysPinned() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        _ = scroll.drag(towardHistory: true, began: true)
        XCTAssertFalse(scroll.pinned)
        scroll.endDrag()
        XCTAssertTrue(scroll.pinned)
    }

    func testReturningNearBottomResumesFollowingWithoutLoadingHistory() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-100, 900))
        _ = scroll.drag(towardHistory: true, began: true)
        _ = scroll.drag(towardHistory: false, began: true)
        XCTAssertFalse(scroll.update(metrics(-350, 650)))
        XCTAssertTrue(scroll.pinned)
    }

    func testNotificationAnchorStopsFollowingUntilTheOwnerReachesTheBottom() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(-400, 600))
        scroll.readingHistory()
        _ = scroll.update(metrics(-150, 850))
        _ = scroll.update(metrics(-150, 900))
        XCTAssertFalse(scroll.pinned)
        _ = scroll.update(metrics(-400, 650))
        XCTAssertTrue(scroll.pinned)
    }

    func testShortHistoryPullAndReleaseKeepsItsPositionWhenOlderRowsArrive() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        _ = scroll.update(metrics(0, 300))
        XCTAssertTrue(scroll.drag(towardHistory: true, began: true))
        scroll.endDrag()
        _ = scroll.update(metrics(10, 310))
        XCTAssertFalse(scroll.pinned, "bounce cannot erase explicit history intent")
        _ = scroll.update(metrics(0, 1500))
        XCTAssertFalse(scroll.pinned, "an older page above is not new content at the bottom")
    }

    func testLayoutAndPrependingNeverTriggerAnotherHistoryPage() {
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        XCTAssertFalse(scroll.update(metrics(0, 300)))
        XCTAssertTrue(scroll.drag(towardHistory: true, began: true))
        XCTAssertFalse(scroll.update(metrics(0, 1500)))
        XCTAssertFalse(scroll.drag(towardHistory: true, began: false))
        XCTAssertTrue(scroll.drag(towardHistory: true, began: true), "one more deliberate gesture")
    }

    private func rows(_ count: Int) -> [YimiItem] {
        (1...count).map { YimiItem(id: "server-\($0)", kind: .her, text: "row", date: .distantPast, seq: $0) }
    }

    func testLaunchWithLargeRestoredHistoryRendersOnlyTheTail() {
        let window = YimiChatWindow()
        let shown = window.rows(rows(5000))
        XCTAssertEqual(shown.count, YimiChatWindow.tail)
        XCTAssertEqual(shown.last?.seq, 5000)
        XCTAssertEqual(shown.first?.seq, 5000 - YimiChatWindow.tail + 1)
        XCTAssertEqual(window.rows(rows(40)).count, 40, "a short history is shown whole")
    }

    func testOlderWidensOverLoadedRowsBeforeAskingTheServer() {
        var window = YimiChatWindow()
        XCTAssertFalse(window.older(loaded: 500), "rows are hidden: widen, no server")
        XCTAssertEqual(window.rows(rows(500)).count, YimiChatWindow.tail + YimiChatWindow.step)
        XCTAssertFalse(window.older(loaded: 500))
        XCTAssertFalse(window.older(loaded: 500))
        XCTAssertEqual(window.rows(rows(500)).count, 450)
        XCTAssertFalse(window.older(loaded: 500))
        XCTAssertTrue(window.older(loaded: 500), "everything loaded is shown: the next rows come from the server")
    }

    func testServerPageThatArrivesAfterOlderIsShownWhole() {
        var window = YimiChatWindow()
        XCTAssertTrue(window.older(loaded: 120), "all 120 shown: ask the server")
        XCTAssertEqual(window.rows(rows(150)).count, 150, "the 30-row page that arrives is not hidden")
    }

    func testNewReplyWhilePinnedKeepsFollowingThroughTheTailWindow() {
        var window = YimiChatWindow()
        var scroll = YimiChatScrollState(tracksHistoryGestures: true)
        var all = rows(400)
        var height: CGFloat = 3600
        _ = scroll.update(metrics(600 - height, 600))
        for next in 401...403 {
            all.append(YimiItem(id: "server-\(next)", kind: .her, text: "reply", date: .distantPast, seq: next))
            XCTAssertEqual(window.rows(all).count, YimiChatWindow.tail, "the window slides, it does not grow")
            XCTAssertEqual(window.rows(all).last?.seq, next)
            _ = scroll.update(metrics(600 - height, 760))       // the new row grows the list below the fold
            height += 160
            XCTAssertTrue(scroll.pinned)
            _ = scroll.update(metrics(600 - height, 600))       // the follow landed
            XCTAssertTrue(scroll.pinned)
        }
        XCTAssertFalse(window.older(loaded: all.count), "older still widens over hidden rows first")
    }

    /// The owner's history held a 72,255-character reply of 630 fact lines; a row lays out a bounded prefix of it.
    func testLongMessagePreviewIsBoundedByCharactersAndLines() throws {
        XCTAssertNil(YimiLongText.preview("短回复"))
        XCTAssertNil(YimiLongText.preview(String(repeating: "字", count: YimiLongText.characters)))
        XCTAssertNil(YimiLongText.preview(String(repeating: "一行\n", count: YimiLongText.lines - 1) + "\n \n"), "trailing blank lines fit")

        let facts = String(repeating: "path：/a，来源 relay。\n", count: 4_000)
        XCTAssertGreaterThan(facts.count, 70_000)
        let byLines = try XCTUnwrap(YimiLongText.preview(facts))
        XCTAssertEqual(byLines.filter(\.isNewline).count, YimiLongText.lines - 1)
        XCTAssertTrue(byLines.hasSuffix("…"))
        XCTAssertTrue(facts.hasPrefix(String(byLines.dropLast())))

        let prose = String(repeating: "回执事实没有换行", count: 9_000)
        let byCharacters = try XCTUnwrap(YimiLongText.preview(prose))
        XCTAssertEqual(byCharacters.count, YimiLongText.characters + 1)
    }
}
