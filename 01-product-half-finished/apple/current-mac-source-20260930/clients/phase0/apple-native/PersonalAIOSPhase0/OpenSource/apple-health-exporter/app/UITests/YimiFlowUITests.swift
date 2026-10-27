import XCTest

private extension XCUIApplication {
    func backgroundForYimiTest() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.activate()
        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 5), "SpringBoard is foreground")
        let backgrounded = XCTNSPredicateExpectation(predicate: NSPredicate { object, _ in
            guard let app = object as? XCUIApplication else { return false }
            return app.state == .runningBackground || app.state == .runningBackgroundSuspended
        }, object: self)
        XCTAssertEqual(XCTWaiter().wait(for: [backgrounded], timeout: 5), .completed,
                       "the YiMi app is running in the background")
    }
}

/// Local presentation flow with synthetic history: real taps, typing, long press and an edge swipe.
/// Connected media and server replies are covered by YimiLiveUITests.
final class YimiFlowUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments.append("-ui-testing")
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "activity-update.fixtures", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let fixtures = try XCTUnwrap(root["fixtures"] as? [String: [String: Any]])
        app.launchEnvironment["YIMI_CHAT_FIXTURES"] = "{\"count\":0,\"hugeHistory\":false}"
        app.launchEnvironment["YIMI_ACTIVITY_FIXTURES"] = String(
            decoding: try JSONSerialization.data(withJSONObject: [try XCTUnwrap(fixtures["single_running"])]), as: UTF8.self)
        app.launch()
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func button(_ label: String) -> XCUIElement { app.buttons[label].firstMatch }

    func testHomeChatCallFlow() {
        XCTAssertTrue(button("对话").waitForExistence(timeout: 25), "fixture app reaches home")
        shot("01-home")

        button("对话").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["依米"].waitForExistence(timeout: 5), "conversation opens")
        button("切换到键盘").tap()
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 3))
        input.tap()
        input.typeText("今晚有点累")
        button("发送").tap()
        XCTAssertTrue(app.staticTexts["今晚有点累"].waitForExistence(timeout: 5), "typed message appears")
        shot("02-chat-typed")

        button("语音通话").tap()
        XCTAssertTrue(button("挂断").waitForExistence(timeout: 5), "voice call cover opens")
        shot("03-voice-call")
        button("收起通话").tap()
        XCTAssertTrue(button("回到语音通话").waitForExistence(timeout: 5), "minimised to the island")
        XCTAssertTrue(app.navigationBars.staticTexts["依米"].exists, "minimising returns to where the call started")
        shot("04-voice-minimised")
        button("回到语音通话").tap()
        XCTAssertTrue(button("挂断").waitForExistence(timeout: 5), "island restores the call")

        button("挂断").tap()
        XCTAssertFalse(button("挂断").waitForExistence(timeout: 2), "voice call cover closes")
        button("视频通话").tap()
        XCTAssertTrue(button("翻转镜头").waitForExistence(timeout: 5), "video call cover opens")
        shot("05-video-call")
        button("收起通话").tap()
        XCTAssertTrue(button("回到视频通话").waitForExistence(timeout: 5), "video minimised (island + PiP)")
        shot("06-video-minimised")
        button("回到视频通话").tap()
        XCTAssertTrue(button("挂断").waitForExistence(timeout: 5), "restored the video call")
        button("挂断").tap()
        XCTAssertFalse(button("挂断").waitForExistence(timeout: 2), "call cover closes")

        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.0, dy: 0.5)).withOffset(CGVector(dx: 2, dy: 0))
        start.press(forDuration: 0, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(button("对话").waitForExistence(timeout: 5), "edge swipe goes back home")
        shot("07-home-after-swipe")

        button("按住说话").press(forDuration: 1.6)
        shot("08-after-hold-to-talk")
    }

    /// Regression: 她了解你 → 健康数据与诊断 pushed a view with its own NavigationStacks onto the bound root stack.
    func testHealthPageOpensAndPresentsTheExporter() {
        XCTAssertTrue(button("她了解你").waitForExistence(timeout: 25))
        button("她了解你").tap()
        app.staticTexts["健康数据与诊断"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars.staticTexts["健康数据与诊断"].waitForExistence(timeout: 5), "health page pushed, no crash")
        button("健康导出器与诊断").tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 5), "exporter opens as a sheet")
        shot("09-health-exporter-sheet")
    }
}

/// Live acceptance on a paired client against its server: no loopback and no fixtures.
/// Runs only with TEST_RUNNER_YIMI_LIVE_UI=1. It never pays, books, or messages anyone but 依米.
final class YimiLiveUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["YIMI_LIVE_UI"] == "1", "live acceptance only")
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDown() {
        if let app, testRun?.hasSucceeded == false {
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "failure-tree"
            tree.lifetime = .keepAlways
            add(tree)
            shot("failure")
            // A failed responsiveness assertion must still release the live microphone.
            app.terminate()
        }
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func button(_ label: String) -> XCUIElement { app.buttons[label].firstMatch }

    /// A person sends with the 发送 arrow: Return in the multi-line composer inserts a line break, it does not send.
    private func send() {
        XCTAssertTrue(button("发送").waitForExistence(timeout: 5), "send button appears for the draft")
        button("发送").tap()
    }

    private func dialAndWaitForLive() -> String {
        button("语音通话").tap()
        let connection = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "yimi.call.connection.")).firstMatch
        XCTAssertTrue(connection.waitForExistence(timeout: 15), "call presentation opens")
        let live = expectation(for: NSPredicate(format: "value == %@", "已接通"), evaluatedWith: connection)
        XCTAssertEqual(XCTWaiter().wait(for: [live], timeout: 60), .completed,
                       "the server confirms live, beyond merely showing the hang-up button")
        return String(connection.identifier.dropFirst("yimi.call.connection.".count))
    }

    func test12DialHangUpDialConnectsAgain() {
        assertHomeWithoutCover("12-home")
        let first = dialAndWaitForLive()
        shot("12-first-live")
        button("挂断").tap()
        let ended = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: button("挂断"))
        XCTAssertEqual(XCTWaiter().wait(for: [ended], timeout: 10), .completed)
        let second = dialAndWaitForLive()
        XCTAssertNotEqual(second, first, "redial establishes a new call")
        shot("12-second-live")
        button("挂断").tap()
    }

    func test13OneDialShowsExactlyOneCall() {
        assertHomeWithoutCover("13-home")
        button("对话").tap()
        let records = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "yimi.call.record."))
        let previous = Set(records.allElementsBoundByIndex.map(\.identifier))
        let id = dialAndWaitForLive()
        button("收起通话").tap()
        let matching = app.buttons.matching(identifier: "yimi.call.record.call-" + id)
        let record = matching.firstMatch
        XCTAssertTrue(record.waitForExistence(timeout: 10), "the call has one history record")
        XCTAssertEqual(matching.count, 1)
        XCTAssertEqual(record.value as? String, "通话中")
        let added = Set(records.allElementsBoundByIndex.map(\.identifier)).subtracting(previous)
        XCTAssertEqual(added, [record.identifier], "one dial creates exactly one call record")
        shot("13-one-live-record")
        button("回到语音通话").tap()
        let same = app.descendants(matching: .any)["yimi.call.connection." + id].firstMatch
        XCTAssertTrue(same.waitForExistence(timeout: 5), "restoring keeps the same call identity")
        button("挂断").tap()
    }

    private func assertHomeWithoutCover(_ step: String) {
        XCTAssertTrue(button("对话").waitForExistence(timeout: 30), "\(step): home is reachable")
        sleep(3)
        XCTAssertFalse(app.staticTexts["解锁，见到依米"].exists, "\(step): no lock cover over home")
        shot(step)
    }

    func test1LaunchShowsHome() {
        assertHomeWithoutCover("01-cold-launch")
    }

    func test2ReturnFromBackgroundShowsHome() {
        assertHomeWithoutCover("02-before-background")
        app.backgroundForYimiTest()
        sleep(4)
        app.activate()
        assertHomeWithoutCover("02-after-background")
    }

    func test3ChatGetsAReply() {
        assertHomeWithoutCover("03-home")
        button("对话").tap()
        if button("切换到键盘").waitForExistence(timeout: 5) { button("切换到键盘").tap() }
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5), "chat input exists")
        input.tap()
        input.typeText("测试：这是上线前的自动测试。请直接告诉我 12 加 30 等于多少")
        send()
        shot("03-chat-sent")
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '42'")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 90), "依米 replies with the answer")
        shot("03-chat-replied")
    }

    /// Leaving mid-reply ends the session; coming back starts a new one, and typing must work
    /// at once, with no 「这条请求未确认 · 选择怎么处理」 decision in the way.
    func test7TypingWorksAfterBackgroundMidReply() {
        assertHomeWithoutCover("07-home")
        button("对话").tap()
        if button("切换到键盘").waitForExistence(timeout: 5) { button("切换到键盘").tap() }
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5), "chat input exists")
        input.tap()
        input.typeText("测试：请用三段话介绍一下你自己")
        send()
        shot("07-long-question-sent")
        app.backgroundForYimiTest()
        sleep(8)
        app.activate()
        if button("对话").waitForExistence(timeout: 10) { button("对话").tap() }
        shot("07-back-from-background")
        XCTAssertFalse(button("这条请求未确认 · 选择怎么处理").waitForExistence(timeout: 5), "no decision locks typing")
        if button("切换到键盘").waitForExistence(timeout: 5) { button("切换到键盘").tap() }
        XCTAssertTrue(input.waitForExistence(timeout: 10), "chat input exists after returning")
        input.tap()
        input.typeText("测试：12 加 30 等于多少")
        send()
        shot("07-second-question-sent")
        let reply = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '42'")).firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 90), "依米 answers the question typed after returning")
        shot("07-second-question-replied")
    }

    func test10ChatHistoryStaysVisibleWithKeyboardAndFollowsReplies() {
        assertHomeWithoutCover("10-home")
        button("对话").tap()
        if button("切换到键盘").waitForExistence(timeout: 5) { button("切换到键盘").tap() }
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        let firstToken = "chat-" + UUID().uuidString.prefix(8)
        input.tap()
        let firstPrompt = "测试：请只回复这个标记，不加其他文字：" + firstToken
        input.typeText(firstPrompt)
        send()
        let firstReply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label != %@", firstToken, firstPrompt)).firstMatch
        XCTAssertTrue(firstReply.waitForExistence(timeout: 90))
        let firstVisible = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: firstReply)
        XCTAssertEqual(XCTWaiter().wait(for: [firstVisible], timeout: 5), .completed, "reply follows into the viewport")
        shot("10-first-reply-visible")

        button("切换到语音").tap()
        button("切换到键盘").tap()
        input.tap()
        let secondToken = "chat-" + UUID().uuidString.prefix(8)
        let secondPrompt = "测试：请只回复这个标记，不加其他文字：" + secondToken
        input.typeText(secondPrompt)
        XCTAssertTrue(firstReply.isHittable, "history remains visible while the field is focused and typing")
        shot("10-history-visible-while-typing")
        send()
        let secondReply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label != %@", secondToken, secondPrompt)).firstMatch
        XCTAssertTrue(secondReply.waitForExistence(timeout: 90))
        let secondVisible = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: secondReply)
        XCTAssertEqual(XCTWaiter().wait(for: [secondVisible], timeout: 5), .completed, "new reply follows without leaving chat")
        shot("10-second-reply-visible")
    }

    func test11CallConversationModeConfirmsBothDirections() {
        assertHomeWithoutCover("11-home")
        button("语音通话").tap()
        XCTAssertTrue(button("挂断").waitForExistence(timeout: 15), "voice call opens")
        let picker = app.segmentedControls["yimi.call.conversationMode"].firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 15), "server advertises conversation mode")
        let confirmed = app.staticTexts["yimi.call.mode.confirmed"].firstMatch
        let chat = picker.buttons["yimi.call.mode.chat"].firstMatch
        let thinking = picker.buttons["yimi.call.mode.thinking"].firstMatch
        XCTAssertTrue(chat.exists && thinking.exists)
        if confirmed.label != "聊天模式" { chat.tap() }
        let initialChat = expectation(for: NSPredicate(format: "label == %@", "聊天模式"), evaluatedWith: confirmed)
        XCTAssertEqual(XCTWaiter().wait(for: [initialChat], timeout: 20), .completed, "server confirms initial chat mode")
        XCTAssertTrue(chat.isSelected)
        thinking.tap()
        let thinkingConfirmed = expectation(for: NSPredicate(format: "label == %@", "思考模式"), evaluatedWith: confirmed)
        XCTAssertEqual(XCTWaiter().wait(for: [thinkingConfirmed], timeout: 20), .completed, "server confirms thinking mode")
        XCTAssertTrue(thinking.isSelected, "selected segment follows the confirmation")
        shot("11-thinking-confirmed")
        chat.tap()
        let chatConfirmed = expectation(for: NSPredicate(format: "label == %@", "聊天模式"), evaluatedWith: confirmed)
        XCTAssertEqual(XCTWaiter().wait(for: [chatConfirmed], timeout: 20), .completed, "server confirms chat mode again")
        XCTAssertTrue(chat.isSelected)
        shot("11-chat-confirmed")
        button("挂断").tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: button("挂断"))
        XCTAssertEqual(XCTWaiter().wait(for: [closed], timeout: 5), .completed, "voice call closes")
    }

    func test12PhoneRearCameraRequestOpensFullscreenAndEnds() {
        assertHomeWithoutCover("12-home")
        button("对话").tap()
        if button("切换到键盘").waitForExistence(timeout: 5) { button("切换到键盘").tap() }
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5), "chat input exists")
        XCTAssertEqual(app.state, .runningForeground, "camera request starts with the app active")
        let surface = app.descendants(matching: .any)["yimi.camera.request.surface"].firstMatch
        XCTAssertFalse(surface.exists, "camera mode opens only after the server request")
        input.tap()
        input.typeText("测试：现在打开我的 iPhone 后置摄像头视频模式，看一眼眼前的东西")
        send()
        shot("12-camera-request-sent")

        XCTAssertTrue(surface.waitForExistence(timeout: 120), "live server camera request opens camera mode")
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertGreaterThanOrEqual(surface.frame.width, app.frame.width * 0.95, "camera mode fills the screen width")
        XCTAssertGreaterThanOrEqual(surface.frame.height, app.frame.height * 0.90, "camera mode fills the screen height")
        let status = app.staticTexts["yimi.camera.request.status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertEqual(status.label, "依米正在看 · 后置摄像头")
        XCTAssertTrue(app.descendants(matching: .any)["yimi.camera.request.preview"].firstMatch.waitForExistence(timeout: 10), "local camera preview is present")
        let end = button("yimi.camera.request.end")
        XCTAssertTrue(end.waitForExistence(timeout: 5))
        shot("12-rear-camera-fullscreen")

        end.tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: surface)
        XCTAssertEqual(XCTWaiter().wait(for: [closed], timeout: 10), .completed, "ending camera mode closes the fullscreen surface")
        XCTAssertFalse(end.exists)
        XCTAssertTrue(input.waitForExistence(timeout: 5), "ending camera mode returns to the conversation")
        shot("12-rear-camera-ended")
    }

    func test4VoiceCallConnectsAndHangsUp() {
        assertHomeWithoutCover("04-home")
        let id = dialAndWaitForLive()
        let duration = Int(ProcessInfo.processInfo.environment["YIMI_CALL_PERF_SECONDS"] ?? "20")!
        print("YIMI_LIVE_CALL_PERF call_id=\(id) duration_s=\(duration)")
        let hangUp = app.buttons["yimi.call.hangUp"].firstMatch
        // Measure the accessibility query itself: a one-second waiter alone can hide a minute-long snapshot.
        for elapsed in stride(from: 0, to: duration, by: 2) {
            sleep(UInt32(min(2, duration - elapsed)))
            let start = ProcessInfo.processInfo.systemUptime
            XCTAssertTrue(hangUp.isHittable, "hang-up remains hittable during call \(id), \(elapsed + 2) s")
            XCTAssertLessThanOrEqual(ProcessInfo.processInfo.systemUptime - start, 1,
                "the app must answer accessibility within one second while the microphone is live")
        }
        shot("04-voice-call-live")
        hangUp.tap()
        let connection = app.descendants(matching: .any)["yimi.call.connection." + id].firstMatch
        let ended = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: connection)
        let home = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: button("对话"))
        XCTAssertEqual(XCTWaiter().wait(for: [ended, home], timeout: 5), .completed,
            "the same live call ends and home answers after tapping hang-up")
        shot("04-voice-call-closed")
    }

    /// Minimising before she picked up left the island unresponsive, and 「查看完整对话」 froze
    /// the app (his history holds 72,255- and 29,164-character replies). On his phone, against his own history.
    func test14MinimiseBeforeLiveThenReturnAndOpenHistory() {
        assertHomeWithoutCover("14-home")
        button("语音通话").tap()
        let connection = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "yimi.call.connection.")).firstMatch
        XCTAssertTrue(connection.waitForExistence(timeout: 15), "call presentation opens")
        button("收起通话").tap()
        let island = button("回到语音通话")
        XCTAssertTrue(island.waitForExistence(timeout: 5), "minimised while connecting")
        var start = ProcessInfo.processInfo.systemUptime
        island.tap()
        XCTAssertTrue(connection.waitForExistence(timeout: 2), "the island brings the connecting call back")
        XCTAssertLessThanOrEqual(ProcessInfo.processInfo.systemUptime - start, 2)
        let live = expectation(for: NSPredicate(format: "value == %@", "已接通"), evaluatedWith: connection)
        XCTAssertEqual(XCTWaiter().wait(for: [live], timeout: 60), .completed)
        start = ProcessInfo.processInfo.systemUptime
        app.buttons["yimi.call.transcript"].firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any)["yimi.chat.history"].waitForExistence(timeout: 3), "the full history opens during the call")
        XCTAssertLessThanOrEqual(ProcessInfo.processInfo.systemUptime - start, 3, "history push stays interactive")
        shot("14-history-during-call")
        island.tap()
        let hangUp = app.buttons["yimi.call.hangUp"].firstMatch
        XCTAssertTrue(hangUp.waitForExistence(timeout: 3))
        hangUp.tap()
    }

    func test5VideoCallConnectsAndHangsUp() {
        assertHomeWithoutCover("05-home")
        button("视频通话").tap()
        XCTAssertTrue(button("挂断").waitForExistence(timeout: 15), "video call opens")
        // 翻转镜头 shows only in video mode and enables only once her first avatar frame is drawn.
        let flip = button("翻转镜头")
        let live = NSPredicate(format: "exists == true AND enabled == true")
        let avatar = expectation(for: live, evaluatedWith: flip)
        XCTAssertEqual(XCTWaiter().wait(for: [avatar], timeout: 30), .completed, "her video avatar appears")
        shot("05-video-live")
        let fallback = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '语音通话继续' OR label CONTAINS '没接通'")).firstMatch
        for second in 1...25 {
            sleep(1)
            XCTAssertFalse(fallback.exists, "no fallback to voice at \(second) s")
            XCTAssertTrue(flip.exists && flip.isEnabled, "avatar still live at \(second) s")
            if fallback.exists || !flip.exists { break }
        }
        shot("05-video-call-25s")
        button("挂断").tap()
        XCTAssertFalse(button("挂断").waitForExistence(timeout: 5), "video call closes")
        shot("05-video-call-closed")
    }

    /// Regression: flushing avatar playback must keep the app responsive, including during hang-up.
    /// Switching a live video call to voice sends `call_playback_reset` (target avatar) and leaves ARTC; both that
    /// and the hang-up must leave the app answering at once.
    func test8VideoToVoiceAndHangUpStayResponsive() {
        assertHomeWithoutCover("08-home")
        button("视频通话").tap()
        XCTAssertTrue(button("挂断").waitForExistence(timeout: 15), "video call opens")
        let flip = button("翻转镜头")
        let avatar = expectation(for: NSPredicate(format: "exists == true AND enabled == true"), evaluatedWith: flip)
        XCTAssertEqual(XCTWaiter().wait(for: [avatar], timeout: 30), .completed, "her video avatar appears")
        sleep(5) // She greets: the playback ring holds audio when it is flushed.
        shot("08-video-live")
        button("摄像头").tap()
        let voice = expectation(for: NSPredicate(format: "exists == true"), evaluatedWith: app.staticTexts["开视频"])
        let flipGone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: flip)
        XCTAssertEqual(XCTWaiter().wait(for: [voice, flipGone], timeout: 3), .completed, "switched to voice within 3 s")
        XCTAssertTrue(button("挂断").exists, "the voice call continues")
        shot("08-switched-to-voice")
        button("挂断").tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: button("挂断"))
        let home = expectation(for: NSPredicate(format: "exists == true AND hittable == true"), evaluatedWith: button("对话"))
        XCTAssertEqual(XCTWaiter().wait(for: [closed, home], timeout: 5), .completed, "call closes and home answers within 5 s")
        shot("08-call-closed")
    }

    /// Regression: when the gateway leaves the room, the app must not remain in it with nobody
    /// serving it. When the gateway leaves (restart, crash, a server-side stop) the app must bootstrap fresh and keep
    /// answering. The test operator removes the gateway participant from this room during the 45 s window.
    func test9ChatWorksAfterTheGatewayLeaves() {
        assertHomeWithoutCover("09-home")
        button("对话").tap()
        if button("切换到键盘").waitForExistence(timeout: 5) { button("切换到键盘").tap() }
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5), "chat input exists")
        input.tap()
        input.typeText("测试：网关离开前，请直接告诉我 19 加 47 等于多少")
        send()
        let first = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '66'")).firstMatch
        XCTAssertTrue(first.waitForExistence(timeout: 90), "依米 replies before the gateway leaves")
        shot("09-before-gateway-leave")
        sleep(45)
        shot("09-after-gateway-leave")
        if button("切换到键盘").waitForExistence(timeout: 5) { button("切换到键盘").tap() }
        XCTAssertTrue(input.waitForExistence(timeout: 10), "chat input exists after the gateway left")
        input.tap()
        input.typeText("测试：网关离开后，请直接告诉我 23 加 54 等于多少")
        send()
        let second = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '77'")).firstMatch
        XCTAssertTrue(second.waitForExistence(timeout: 90), "依米 replies after the gateway left and came back")
        shot("09-after-gateway-leave-replied")
    }

    func test6AddComputerCopiesAPairingCode() {
        assertHomeWithoutCover("06-home")
        button("设备").tap()
        button("添加电脑").tap()
        let copy = button("复制配对码（没有摄像头时）")
        XCTAssertTrue(copy.waitForExistence(timeout: 20), "pairing code is ready")
        shot("06-add-computer")
        copy.tap()
        sleep(5)
        button("完成").tap()
    }
}

/// Synthetic packets enter the same canonical decoder and timeline used by chat.
final class YimiActivityUITests: XCTestCase {
    private func shot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
    /// N13 dumped receipt facts into replies (72,255 characters on the owner's phone); the history push laid that text
    /// out whole on the main thread and the watchdog killed the app. A long reply now shows a prefix and opens in full.
    func testHistoryWithA70kReplyOpensWithinOneSecond() throws {
        let fixtureURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "activity-update.fixtures", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
        let running = try XCTUnwrap((root["fixtures"] as? [String: [String: Any]])?["parallel_six"])
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launchEnvironment["YIMI_ACTIVITY_FIXTURES"] = String(decoding: try JSONSerialization.data(withJSONObject: [running]), as: UTF8.self)
        app.launchEnvironment["YIMI_LONG_REPLY_CHARACTERS"] = "70000"
        app.launch()
        let history = app.descendants(matching: .any)["yimi.chat.history"].firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 60), "the fixture opens the history")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let open = app.buttons["对话"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 30), "back on the home page")
        // Measure the app's navigation-to-layout interval. tap() also includes XCTest IPC and idle polling.
        open.tap()
        XCTAssertTrue(history.exists)
        let elapsed = try XCTUnwrap(Double(try XCTUnwrap(history.value as? String)))
        XCTAssertGreaterThan(elapsed, 0)
        let measurement = XCTAttachment(string: "navigation_to_layout_seconds=\(elapsed)")
        measurement.name = "history-navigation-to-layout"; measurement.lifetime = .keepAlways
        add(measurement)
        XCTAssertLessThan(elapsed, 1, "history opened in \(elapsed) s")
        let full = app.buttons["yimi.message.fullText"].firstMatch
        XCTAssertTrue(full.waitForExistence(timeout: 2), "the long reply shows a prefix and a link to the whole text")
        shot(app, name: "history-long-reply-prefix")
        full.tap()
        XCTAssertTrue(app.textViews["yimi.message.fullText.page"].waitForExistence(timeout: 2), "the whole reply opens on its own page")
        shot(app, name: "history-long-reply-full")
    }

    func testCardExpandsSixItemsAndCollapsesUnderMatchingReply() throws {
        continueAfterFailure = false
        let fixtureURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "activity-update.fixtures", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
        let fixtures = try XCTUnwrap(root["fixtures"] as? [String: [String: Any]])
        let running = try XCTUnwrap(fixtures["parallel_six"])
        var succeeded = try XCTUnwrap(fixtures["succeeded"])
        succeeded["session_id"] = running["session_id"]
        succeeded["processed_event_id"] = running["processed_event_id"]
        var completedCard = try XCTUnwrap(succeeded["card"] as? [String: Any])
        completedCard["id"] = (running["card"] as? [String: Any])?["id"]
        completedCard["revision"] = 16
        succeeded["card"] = completedCard
        let packets = try JSONSerialization.data(withJSONObject: [running, succeeded])
        let app = XCUIApplication()
        app.launchArguments = ["-ui-testing"]
        app.launchEnvironment["YIMI_ACTIVITY_FIXTURES"] = String(decoding: packets, as: UTF8.self)
        app.launch()
        let card = app.descendants(matching: .any)["yimi.activity.card"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        let items = try XCTUnwrap((running["card"] as? [String: Any])?["items"] as? [[String: Any]])
        for (index, item) in items.enumerated() {
            XCTAssertEqual(card.label.contains(try XCTUnwrap(item["summary"] as? String)), index < 2)
        }
        XCTAssertFalse(card.label.contains("整理测试数据文件夹"))
        shot(app, name: "activity-running-two-items")
        let expand = app.buttons["yimi.activity.expand"].firstMatch
        expand.tap()
        XCTAssertEqual(expand.value as? String, "已展开")
        for item in items { XCTAssertTrue(card.label.contains(try XCTUnwrap(item["summary"] as? String))) }
        shot(app, name: "activity-expanded-six-items")
        // The normal composer advances the isolated fixture stream and supplies the matching reply.
        app.buttons["切换到键盘"].firstMatch.tap()
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        input.tap(); input.typeText("完成夹具")
        app.buttons["发送"].firstMatch.tap()
        let collapsed = app.buttons["yimi.activity.collapsed"].firstMatch
        XCTAssertTrue(collapsed.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["云手机已打开。"].exists)
        XCTAssertFalse(card.exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "activity-completed"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}

/// Deterministic chat regressions use synthetic Debug fixtures and the same conversation timeline as the app.
final class YimiChatRegressionUITests: XCTestCase {
    private var app: XCUIApplication!

    override func tearDown() {
        if let app, (testRun?.failureCount ?? 0) > 0 {
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "failure-tree"
            tree.lifetime = .keepAlways
            add(tree)
            shot("failure")
        }
    }

    override func setUpWithError() throws {
#if targetEnvironment(simulator)
        continueAfterFailure = false
        app = XCUIApplication()
#else
        throw XCTSkip("synthetic chat regression runs only on Simulator")
#endif
    }

    private func activityFixtureJSON(offsets: [TimeInterval] = [-900, -480]) throws -> String {
        let fixtureURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "activity-update.fixtures", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
        let fixtures = try XCTUnwrap(root["fixtures"] as? [String: [String: Any]])
        var packets = Array([try XCTUnwrap(fixtures["single_running"]), try XCTUnwrap(fixtures["parallel_six"])].prefix(offsets.count))
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = Date()
        let observedAt = now.addingTimeInterval(-15)
        for index in packets.indices {
            var card = try XCTUnwrap(packets[index]["card"] as? [String: Any])
            let startedAt = now.addingTimeInterval(offsets[index])
            card["started_at"] = formatter.string(from: startedAt)
            card["observed_at"] = formatter.string(from: observedAt)
            card["last_progress_at"] = formatter.string(from: observedAt)
            card["elapsed_ms"] = Int(observedAt.timeIntervalSince(startedAt) * 1000)
            var items = try XCTUnwrap(card["items"] as? [[String: Any]])
            for itemIndex in items.indices {
                let itemStart = startedAt.addingTimeInterval(Double(itemIndex + 1))
                items[itemIndex]["started_at"] = formatter.string(from: itemStart)
                if items[itemIndex]["state"] as? String == "running" {
                    items[itemIndex]["elapsed_ms"] = Int(observedAt.timeIntervalSince(itemStart) * 1000)
                    items[itemIndex].removeValue(forKey: "completed_at")
                } else {
                    let completedAt = observedAt.addingTimeInterval(-2)
                    items[itemIndex]["completed_at"] = formatter.string(from: completedAt)
                    items[itemIndex]["elapsed_ms"] = Int(completedAt.timeIntervalSince(itemStart) * 1000)
                }
            }
            card["items"] = items
            packets[index]["card"] = card
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: packets), as: UTF8.self)
    }

    private func launchChatFixture(hugeHistory: Bool = false) throws {
        let descriptor: [String: Any] = ["count": hugeHistory ? 5000 : 150, "hugeHistory": hugeHistory]
        app.launchArguments = ["-ui-testing"]
        app.launchEnvironment["YIMI_CHAT_FIXTURES"] = String(
            decoding: try JSONSerialization.data(withJSONObject: descriptor), as: UTF8.self)
        app.launchEnvironment["YIMI_ACTIVITY_FIXTURES"] = try activityFixtureJSON()
        app.launch()
    }

    private func button(_ label: String) -> XCUIElement { app.buttons[label].firstMatch }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func openChatWithKeyboard() -> XCUIElement {
        XCTAssertTrue(button("对话").waitForExistence(timeout: 25), "fixture app reaches home")
        button("对话").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["依米"].waitForExistence(timeout: 5), "conversation opens")
        let keyboard = button("切换到键盘")
        if keyboard.waitForExistence(timeout: 5) { keyboard.tap() }
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10), "chat input appears")
        return input
    }

    private func reply(for prompt: String, token: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label != %@", token, prompt)).firstMatch
    }

    func testOldCompanionAndOrphanKeepTheirHistoryPositionAndNewestPreview() throws {
        app.launchArguments = ["-ui-testing"]
        app.launchEnvironment["YIMI_CHAT_FIXTURES"] = "{\"count\":3,\"hugeHistory\":false,\"oldCompanion\":true}"
        app.launchEnvironment["YIMI_ACTIVITY_FIXTURES"] = try activityFixtureJSON(offsets: [-150])
        app.launch()
        XCTAssertTrue(button("对话").waitForExistence(timeout: 25))
        let preview = app.staticTexts["依米：最近一条历史"].firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 5), "home previews the newest message, not the old companion reply")
        shot("rq116-home-newest-preview")
        button("对话").tap()
        let old = app.staticTexts["10-18 随身回复"].firstMatch
        let middle = app.staticTexts["历史 1：这是一条完整保留的历史消息，用于验证聊天窗口。"].firstMatch
        let newest = app.staticTexts["最近一条历史"].firstMatch
        let card = app.descendants(matching: .any)["yimi.activity.card"].firstMatch
        XCTAssertTrue(newest.waitForExistence(timeout: 5))
        XCTAssertTrue(newest.isHittable, "the newest message stays at the visible end of history")
        // With three rows, the orphan and both neighbouring messages fit without scrolling.
        XCTAssertTrue(old.isHittable)
        XCTAssertTrue(card.isHittable)
        XCTAssertTrue(middle.isHittable)
        XCTAssertLessThanOrEqual(old.frame.maxY, card.frame.minY)
        XCTAssertLessThanOrEqual(card.frame.maxY, middle.frame.minY, "the replayed orphan uses started_at, before the newer rows")
        XCTAssertLessThan(middle.frame.maxY, newest.frame.minY)
        shot("rq116-orphan-between-history-rows-newest-last")
    }

    func testLongHistoryOpensWithoutLayingOutOffscreenHugeReplies() throws {
        try launchChatFixture(hugeHistory: true)
        XCTAssertTrue(button("对话").waitForExistence(timeout: 25), "fixture app reaches home")
        let started = ProcessInfo.processInfo.systemUptime
        button("对话").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["依米"].waitForExistence(timeout: 5), "conversation opens")
        let keyboard = button("切换到键盘")
        if keyboard.waitForExistence(timeout: 5) { keyboard.tap() }
        let input = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 15), "chat input attaches within 15 seconds")
        input.tap()
        XCTAssertTrue(input.isHittable, "focused input remains hittable")
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        print("YIMI_CHAT_ATTACH_SECONDS=\(elapsed)")
        XCTAssertLessThanOrEqual(elapsed, 15,
                                 "home-to-chat keyboard attach stays within 15 seconds")
        shot("chat-regression-huge-history-input")
    }

    func testChatHistoryStaysVisibleWithKeyboardAndFollowsReplies() throws {
        try launchChatFixture()
        let input = openChatWithKeyboard()
        let firstToken = "chat-" + String(UUID().uuidString.prefix(8))
        let firstPrompt = "只回复这个标记，不加其他文字：" + firstToken
        input.tap()
        input.typeText(firstPrompt)
        button("发送").tap()
        let firstReply = reply(for: firstPrompt, token: firstToken)
        XCTAssertTrue(firstReply.waitForExistence(timeout: 15), "first fixture reply appears")
        let firstVisible = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: firstReply)
        XCTAssertEqual(XCTWaiter().wait(for: [firstVisible], timeout: 5), .completed,
                       "first reply follows into the viewport")
        XCTAssertTrue(firstReply.isHittable, "first reply is visible in the viewport")
        shot("chat-regression-first-reply-visible")

        button("切换到语音").tap()
        button("切换到键盘").tap()
        input.tap()
        let secondToken = "chat-" + String(UUID().uuidString.prefix(8))
        let secondPrompt = "只回复这个标记，不加其他文字：" + secondToken
        input.typeText(secondPrompt)
        XCTAssertTrue(firstReply.isHittable, "history remains visible while the field is focused and typing")
        button("发送").tap()
        let secondReply = reply(for: secondPrompt, token: secondToken)
        XCTAssertTrue(secondReply.waitForExistence(timeout: 15), "second fixture reply appears")
        XCTAssertTrue(secondReply.isHittable, "the new reply is visible without leaving chat")
        shot("chat-regression-second-reply-visible")
    }

    func testTypingWorksAfterBackgroundMidReply() throws {
        try launchChatFixture()
        let input = openChatWithKeyboard()
        let firstToken = "resume-" + String(UUID().uuidString.prefix(8))
        let firstPrompt = "请只回复这个标记：" + firstToken
        input.tap()
        input.typeText(firstPrompt)
        button("发送").tap()
        app.backgroundForYimiTest()
        sleep(3)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "YiMi returns to foreground")
        if !app.descendants(matching: .any)["yimi.input"].firstMatch.waitForExistence(timeout: 5) {
            XCTAssertTrue(button("对话").waitForExistence(timeout: 10), "conversation can be reopened")
            button("对话").tap()
            let keyboard = button("切换到键盘")
            if keyboard.waitForExistence(timeout: 5) { keyboard.tap() }
        }
        let decision = app.buttons.matching(NSPredicate(
            format: "label CONTAINS '未确认' OR label CONTAINS '结果不确定'")).firstMatch
        XCTAssertFalse(decision.exists, "background return does not leave a recovery decision blocking chat")
        let resumedInput = app.descendants(matching: .any)["yimi.input"].firstMatch
        XCTAssertTrue(resumedInput.waitForExistence(timeout: 10), "chat input returns")
        XCTAssertTrue(resumedInput.isHittable, "chat input accepts typing after backgrounding")
        let secondToken = "resume-" + String(UUID().uuidString.prefix(8))
        let secondPrompt = "请只回复这个标记：" + secondToken
        resumedInput.tap()
        resumedInput.typeText(secondPrompt)
        button("发送").tap()
        let secondReply = reply(for: secondPrompt, token: secondToken)
        XCTAssertTrue(secondReply.waitForExistence(timeout: 15), "second fixture reply arrives after backgrounding")
        XCTAssertTrue(secondReply.isHittable, "reply remains visible in the resumed conversation")
        shot("chat-regression-resumed-reply-visible")
    }
}
