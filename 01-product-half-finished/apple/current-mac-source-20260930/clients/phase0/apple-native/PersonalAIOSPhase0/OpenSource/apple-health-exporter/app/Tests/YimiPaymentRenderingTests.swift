#if os(iOS) && !SWIFT_PACKAGE && targetEnvironment(simulator)
import XCTest
import SwiftUI
import UIKit
import Vision
@testable import HealthKitExporter

/// Reviewable simulator snapshots with OCR assertions against actual rendered pixels.
/// There are no approved golden images yet; attachments are the visual review evidence.
@MainActor
final class YimiPaymentRenderingTests: XCTestCase {
    func testEveryPublishedCardStateAndReasonRendersWithCorrectActions() async throws {
        let fixture = try Fixture()
        let expectedStates: [String: String] = [
            "awaiting_owner": "等待确认", "auto_pending": "即将自动付款", "verifying": "正在核对两句话",
            "granted": "付款中", "paying": "付款中", "paid": "已付款", "outcome_unknown": "付款结果待确认",
            "cancelled": "已取消", "expired": "已过期", "superseded": "金额已更新", "failed": "未付款",
        ]
        var states = Set<String>(), reasons = Set<String>(), stateImages: [String: Data] = [:]
        for (index, example) in try fixture.examples("payment_cards").enumerated() {
            try fixture.deliver(example)
            guard let card = fixture.model.cards.first else { continue }
            let reason = card.notice?.reason
            let name = reason.map { "reason-" + $0.rawValue } ?? "state-" + card.state.rawValue + "-\(index)"
            let shot = try await render(YimiPaymentCard(payment: fixture.model, card: card), name: name)
            XCTAssertTrue(shot.contains(try XCTUnwrap(expectedStates[card.state.rawValue])), "\(name): \(shot.text)")
            XCTAssertTrue(shot.contains("16.6"), "The authorized amount must remain visible in \(name)")
            XCTAssertTrue(shot.contains("一点点"), "The payee must remain visible in \(name)")
            let hasPayAction = shot.contains("付款¥16.6") || shot.contains("现在付款")
            if card.state.canDecide {
                XCTAssertTrue(hasPayAction, "\(name) lost its explicit pay action")
                XCTAssertTrue(shot.contains("取消"), "\(name) lost its unsigned cancel action")
            } else {
                XCTAssertFalse(hasPayAction, "\(name) must never offer a second payment")
            }
            if let reason {
                reasons.insert(reason.rawValue)
                if let expected = reason.line(limitFen: card.notice?.limit_fen, usedFen: card.today_auto_used_fen,
                                              budgetFen: card.notice?.limit_fen, newFen: card.notice?.amount_fen,
                                              oldFen: card.notice?.previous_amount_fen, triesLeft: card.methods.voice.tries_left,
                                              terminal: "付款设备") {
                    XCTAssertTrue(shot.contains(expected), "\(name) must explain why this card needs a decision; OCR: \(shot.text)")
                }
            } else if states.insert(card.state.rawValue).inserted {
                stateImages[card.state.rawValue] = try XCTUnwrap(shot.image.pngData())
            }
        }
        XCTAssertEqual(states, Set(CentralPaymentState.allCases.map(\.rawValue)))
        XCTAssertEqual(reasons, Set(CentralPaymentReason.allCases.map(\.rawValue)))
        XCTAssertNotEqual(stateImages["paid"], stateImages["outcome_unknown"], "Unknown must not look like payment success")
        XCTAssertNotEqual(stateImages["auto_pending"], stateImages["awaiting_owner"], "The undo window needs a distinct presentation")
    }

    func testApprovalsSettingsAndRecordScreensRenderPublishedFixtures() async throws {
        let fixture = try Fixture()
        try fixture.deliverFirst("payment_approvals")
        let approval = try XCTUnwrap(fixture.model.approvals.first)
        let unlock = try await render(YimiPaymentApprovalCard(payment: fixture.model, approval: approval), name: "approval-unlock")
        XCTAssertTrue(unlock.contains("眼镜要解锁依米"))
        XCTAssertTrue(unlock.contains("不是我"))
        XCTAssertTrue(unlock.contains("允许解锁"))
        var enrolmentExample = try fixture.first("payment_approvals")
        var approvals = try XCTUnwrap(enrolmentExample["approvals"] as? [[String: Any]])
        approvals[0]["kind"] = "voiceprint_enrol"
        enrolmentExample["approvals"] = approvals
        try fixture.deliver(enrolmentExample)
        let enrolment = try await render(YimiPaymentApprovalCard(payment: fixture.model, approval: XCTUnwrap(fixture.model.approvals.first)), name: "approval-enrolment")
        XCTAssertTrue(enrolment.contains("眼镜要录入你的声音"))
        XCTAssertTrue(enrolment.contains("允许录入"))
        XCTAssertTrue(enrolment.contains("不是我"))

        let settings = try await render(NavigationStack { YimiPaymentSettingsView(payment: fixture.model, onVoice: {}) }, name: "settings-prerequisites", screen: true)
        XCTAssertTrue(settings.contains("默认：每笔你点确认"))
        XCTAssertTrue(settings.contains("声纹支付"))
        XCTAssertTrue(settings.contains("免密支付"))
        XCTAssertTrue(settings.contains("开启前需要"))
        XCTAssertTrue(settings.contains("已录入你的声音"))

        let records = try await render(NavigationStack { YimiPaymentRecordsView(payment: fixture.model) }, name: "records", screen: true)
        XCTAssertTrue(records.contains("一点点"))
        XCTAssertTrue(records.contains("点卡片"))
        XCTAssertTrue(records.contains("iPhone"))
        XCTAssertTrue(records.contains("已付款"))
        let id = try XCTUnwrap(fixture.model.records.first?.payment_id)
        let detail = try await render(NavigationStack { YimiPaymentRecordDetailView(payment: fixture.model, paymentID: id) }, name: "record-detail", screen: true)
        XCTAssertTrue(detail.contains("帮我点一杯香柠养乐多"))
        XCTAssertTrue(detail.contains("已授权，等待执行手机付款"), "Grant issuance must not be labelled as execution success")
        XCTAssertTrue(detail.contains("这不是我付的"))
        XCTAssertFalse(detail.contains("AAAAAAAA"), "Nonces must not appear in records")
    }

    func testLongReasonAndUndoWindowAtAccessibilitySize() async throws {
        let fixture = try Fixture()
        let examples = try fixture.examples("payment_cards")
        let longReason = try XCTUnwrap(examples.first { example in
            guard let card = (example["cards"] as? [[String: Any]])?.first,
                  let notice = card["notice"] as? [String: Any] else { return false }
            return notice["reason"] as? String == "INITIATING_NOT_VOICE"
        })
        try fixture.deliver(longReason)
        let card = try XCTUnwrap(fixture.model.cards.first)
        let large = try await render(YimiPaymentCard(payment: fixture.model, card: card), name: "accessibility-long-reason", largeType: true)
        XCTAssertTrue(large.contains("这件事是你打字发起的"))
        let automatic = try XCTUnwrap(examples.first { ($0["cards"] as? [[String: Any]])?.first?["state"] as? String == "auto_pending" })
        try fixture.deliver(automatic)
        let auto = try await render(YimiPaymentCard(payment: fixture.model, card: XCTUnwrap(fixture.model.cards.first)), name: "accessibility-undo-window", largeType: true)
        XCTAssertTrue(auto.contains("自动付款"))
        XCTAssertTrue(auto.contains("取消"))
        XCTAssertTrue(auto.contains("现在付款"))
    }

    func testHomeSummaryCallBarAndAppLockSurfacesRender() async throws {
        let fixture = try Fixture()
        try fixture.deliverFirst("payment_cards")
        let card = try XCTUnwrap(fixture.model.cards.first)
        let summary = try await render(YimiPaymentSummaryRow(payment: fixture.model, onOpen: {}), name: "home-summary")
        XCTAssertTrue(summary.contains("16.6"))
        let call = try await render(YimiPaymentCallBar(payment: fixture.model, card: card, onOpen: {}), name: "call-bar")
        XCTAssertTrue(call.contains("16.6")); XCTAssertTrue(call.contains("取消"))
        let settings = try await render(NavigationStack { YimiPaymentLockSettingsView(payment: fixture.model) }, name: "lock-settings", screen: true)
        XCTAssertTrue(settings.contains("进入依米需要验证"))
        fixture.model.appLock.configure(CentralPaymentPhone(enabled: true, relock_s: 60, relock_choices_s: [0, 60], unlocked: false))
        let cover = try await render(YimiAppLockCover(payment: fixture.model, lock: fixture.model.appLock), name: "lock-cover", screen: true)
        XCTAssertTrue(cover.contains("用 Face ID 或 iPhone 密码继续"))
        XCTAssertTrue(cover.contains("通话和随身模式会继续"))
    }

    func testI5LockCoverStaysAbovePresentedSheetsWithoutDismissingThem() async throws {
        let fixture = try Fixture()
        let lock = fixture.model.appLock
        let host = UIHostingController(rootView: Text("Private content").background {
            YimiLockWindow(payment: fixture.model, lock: lock).frame(width: 0, height: 0)
        })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { lock.configure(CentralPaymentPhone(enabled: false, relock_s: 60, relock_choices_s: [0, 60], unlocked: false)); window.isHidden = true; window.rootViewController = nil; previous?.makeKey() }
        let hostAttached = try await waitForUIKit { window.isKeyWindow && host.viewIfLoaded?.window === window }
        XCTAssertTrue(hostAttached, "The test host must be attached before presenting its sheet")
        let sheet = UIViewController()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            host.present(sheet, animated: false) { continuation.resume() }
        }
        lock.configure(CentralPaymentPhone(enabled: true, relock_s: 60, relock_choices_s: [0, 60], unlocked: false))
        let coverReady = try await waitForUIKit {
            scene.windows.contains { !$0.isHidden && $0.isKeyWindow && $0.rootViewController is UIHostingController<YimiAppLockCover> }
        }
        XCTAssertTrue(coverReady, "Locking must show the cover in its key window")
        let cover = try XCTUnwrap(scene.windows.first { !$0.isHidden && $0.isKeyWindow && $0.rootViewController is UIHostingController<YimiAppLockCover> })
        XCTAssertGreaterThan(cover.windowLevel.rawValue, UIWindow.Level.alert.rawValue)
        XCTAssertTrue(cover.isKeyWindow)
        XCTAssertTrue(host.presentedViewController === sheet, "Locking must keep the mounted screen and its work")
        lock.didUnlock(generation: lock.generation)
        let coverHidden = try await waitForUIKit { cover.isHidden }
        XCTAssertTrue(coverHidden, "Unlocking must hide the lock cover")
        XCTAssertTrue(cover.isHidden)
        XCTAssertTrue(host.presentedViewController === sheet)
    }

    private func waitForUIKit(_ condition: () -> Bool) async throws -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(3))
        while clock.now < deadline {
            if condition() { return true }
            try await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    func testSubmittedDecisionStillOffersUnsignedCancelAndDeny() async throws {
        let fixture = try Fixture()
        try fixture.deliverFirst("payment_cards")
        let card = try XCTUnwrap(fixture.model.cards.first)
        // The fake transport refuses mutations. That leaves a submitted, unconfirmed decision.
        await fixture.model.decide(card, decision: "cancel")
        XCTAssertTrue(fixture.model.submitted.contains(card.payment_id))
        let pending = try await render(YimiPaymentCard(payment: fixture.model, card: card), name: "submitted-card-cancel-still-available")
        XCTAssertTrue(pending.contains("取消"))
        XCTAssertFalse(pending.contains("付款¥16.6"))
        try fixture.deliverFirst("payment_approvals")
        let approval = try XCTUnwrap(fixture.model.approvals.first)
        await fixture.model.approve(approval, allow: false)
        XCTAssertTrue(fixture.model.submitted.contains(approval.approval_id))
        let denied = try await render(YimiPaymentApprovalCard(payment: fixture.model, approval: approval), name: "submitted-approval-deny-still-available")
        XCTAssertTrue(denied.contains("不是我"))
        XCTAssertFalse(denied.contains("允许解锁"))
    }

    private struct Shot {
        let image: UIImage
        let text: String
        func contains(_ value: String) -> Bool {
            func normalized(_ text: String) -> String {
                text.unicodeScalars.filter { CharacterSet.letters.union(.decimalDigits).contains($0) }.map(String.init).joined()
            }
            return normalized(text).contains(normalized(value))
        }
    }

    private func render<V: View>(_ content: V, name: String, largeType: Bool = false, screen: Bool = false) async throws -> Shot {
        let size = CGSize(width: 390, height: 844)
        let root = screen ? AnyView(content) : AnyView(ScrollView { content.padding(16) })
        let host = UIHostingController(rootView: root
            .environment(\.dynamicTypeSize, largeType ? .accessibility3 : .large).background(Color.white))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKey() }
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(150))
        host.view.layoutIfNeeded()
        func capture(_ suffix: String) throws -> Shot {
            let format = UIGraphicsImageRendererFormat(); format.scale = 2
            let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true), "Render did not complete: \(name)")
            }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage)).perform([request])
            let text = request.results?.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n") ?? ""
            XCTAssertFalse(text.isEmpty, "Rendered text is missing in \(name)")
            let attachment = XCTAttachment(image: image)
            attachment.name = "payment-" + name + suffix
            attachment.lifetime = .keepAlways
            add(attachment)
            return Shot(image: image, text: text)
        }
        let first = try capture("")
        func scrollable(_ view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView, scroll.contentSize.height > scroll.bounds.height + 1 { return scroll }
            return view.subviews.lazy.compactMap { scrollable($0) }.first
        }
        if let scroll = scrollable(host.view) {
            scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom), animated: false)
            try await Task.sleep(for: .milliseconds(150))
            host.view.layoutIfNeeded()
            let bottom = try capture("-bottom")
            return Shot(image: first.image, text: first.text + "\n" + bottom.text)
        }
        return first
    }

    @MainActor private final class Fixture {
        private let published: [String: [[String: Any]]]
        private let suite = "YimiPaymentRendering." + UUID().uuidString
        private var defaults: UserDefaults!
        var model: YimiPaymentModel!
        init() throws {
            let url = try XCTUnwrap(Bundle.main.url(forResource: "payment-message.v1", withExtension: "json", subdirectory: "Contracts"))
            let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
            published = try XCTUnwrap(contract["examples"] as? [String: [[String: Any]]])
            defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            model = YimiPaymentModel(appLock: YimiAppLock(defaults: defaults), timeout: 1, sender: { [weak self] bytes, id, _ in
                guard let self else { throw CentralTextError.unavailable }
                let request = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
                let operation = try XCTUnwrap(request["operation"] as? String)
                let replies = ["payment_settings_get": "payment_settings", "payment_records_get": "payment_records", "payment_record_get": "payment_record"]
                guard let reply = replies[operation] else { throw CentralTextError.unavailable }
                var response = try self.first(reply)
                response["request_id"] = id
                if reply == "payment_settings" { response["keys"] = ["device": true, "user": true] }
                let packet = try self.packet(response)
                self.model.receive(.output(packet))
                return packet
            }, presence: { _ in })
            model.receive(.attached(CentralTransportBinding(sessionID: "session-1", deviceID: "phone-fixture", connectionEpoch: "render-epoch", expectedGatewayIdentity: "fixture", maxPacketBytes: 12_288)))
            var settings = try first("payment_settings")
            // Rendering never creates hardware keys. Signing and registration have separate model tests.
            settings["keys"] = ["device": true, "user": true]
            try deliver(settings)
        }
        deinit { defaults?.removePersistentDomain(forName: suite) }
        func examples(_ operation: String) throws -> [[String: Any]] { try XCTUnwrap(published[operation]) }
        func first(_ operation: String) throws -> [String: Any] { try XCTUnwrap(examples(operation).first) }
        func packet(_ object: [String: Any]) throws -> CentralTextPacket { try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: object)) }
        func deliver(_ object: [String: Any]) throws { model.receive(.output(try packet(object))) }
        func deliverFirst(_ operation: String) throws { try deliver(first(operation)) }
    }
}
#endif
