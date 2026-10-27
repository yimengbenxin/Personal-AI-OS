import Combine
import Darwin
import Foundation
import XCTest
@testable import HealthKitExporter

@MainActor
final class WatchRelayPerformanceTests: XCTestCase {
    func testUnreachableWatchDoesNoHistoryWorkForInboundBurst() async throws {
        try await burst(reachable: false)
    }

    func testReachableWatchCoalescesInboundBurst() async throws {
        try await burst(reachable: true)
    }

    private func burst(reachable: Bool) async throws {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        let items = (0..<5000).map {
            YimiItem(id: "history-\($0)", kind: $0.isMultiple(of: 2) ? .me : .her,
                text: "历史 \($0)", date: date, seq: $0 + 1, ownerIdentity: "owner")
        }
        var computations = 0, publications = 0
        let name = "WatchBurst-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let relay = WatchRelay(sources: {
            computations += 1
            return WatchRelaySources(ownerIdentity: "principal", ownerPairingIdentity: "owner",
                items: items, question: nil, errands: [], care: nil, payments: [], serverReachable: true)
        }, currentOwner: { _, _ in true }, publish: { _, _ in publications += 1 },
            answerQuestion: { _, _ in true }, cancelErrand: { _, _ in true }, careSafe: { _ in true },
            refreshCredential: {}, defaults: defaults, isReachable: { reachable })
        try relay.projectBinding(WatchCredentialAuthority(
            scope: WatchBindingScope(watch_device_id: "00000000-0000-4000-8000-000000000001", pair_version: "1"),
            principal: "principal", pairingIdentity: "owner"), credential: nil)
        computations = 0; publications = 0
        let changes = PassthroughSubject<Void, Never>()
        let observation = relay.observe([changes.eraseToAnyPublisher()]) { XCTFail("\($0)") }
        let begin = threadCPU()
        for _ in 0..<700 { changes.send() }
        // RunLoop receive-on blocks drain before this barrier, on the same main thread.
        await withCheckedContinuation { done in DispatchQueue.main.async { done.resume() } }
        let mainCPU = threadCPU() - begin
        try await Task.sleep(nanoseconds: 550_000_000)
        withExtendedLifetime(observation) {}
        print("WATCH_BURST reachable=\(reachable) items=5000 publishes=700 computations=\(computations) publications=\(publications) main_ms=\(mainCPU * 1000)")
        XCTAssertLessThanOrEqual(computations, reachable ? 2 : 0)
        XCTAssertEqual(publications, 0, "An unchanged projection must not republish")
        XCTAssertLessThan(mainCPU, 0.016, "A burst must leave the main runloop within one frame")
    }

    func testSettingsAndCallBurstAtRetainedHistoryScale() async throws {
        let history = BurstHistory()
        history.timeline = YimiConversationTimeline(items: (0..<5000).map {
            YimiItem(id: "history-\($0)", kind: $0.isMultiple(of: 2) ? .me : .her,
                text: "历史 \($0)", date: Date(timeIntervalSince1970: Double($0)), seq: $0 + 1, ownerIdentity: "owner")
        })
        var reads = 0, watches = 0, computations = 0
        let settings = AssistantModelSettingsModel(sender: { bytes, id, _ in
            let request = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            let operation = request["operation"] as! String
            var result: [String: Any] = ["environment_id": "fixture", "desired": 1, "groups": [:]]
            if operation == "model_settings_read" { reads += 1; result["revision"] = 1; result["items"] = [] }
            if operation == "model_settings_watch" { watches += 1 }
            return try Self.packet("model_settings_receipt", fields: ["control_id": id, "ok": true, "result": result])
        })
        settings.receive(.attached(CentralTransportBinding(sessionID: "session", deviceID: "device", connectionEpoch: "epoch",
            expectedGatewayIdentity: "gateway", maxPacketBytes: 12288, deviceClass: "iphone")))
        await settings.open()
        let name = "WatchCombined-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let relay = WatchRelay(sources: {
            computations += 1
            return WatchRelaySources(ownerIdentity: "principal", ownerPairingIdentity: "owner",
                items: history.timeline.latestAssistantItem(ownerIdentity: "owner").map { [$0] } ?? [],
                question: nil, errands: [], care: nil, payments: [], serverReachable: true)
        }, currentOwner: { _, _ in true }, publish: { _, _ in },
            answerQuestion: { _, _ in true }, cancelErrand: { _, _ in true }, careSafe: { _ in true },
            refreshCredential: {}, defaults: defaults, isReachable: { false })
        try relay.projectBinding(WatchCredentialAuthority(
            scope: WatchBindingScope(watch_device_id: "00000000-0000-4000-8000-000000000001", pair_version: "1"),
            principal: "principal", pairingIdentity: "owner"), credential: nil)
        computations = 0
        let observation = relay.observe([history.$timeline.map(\.revision).removeDuplicates().map { _ in () }.eraseToAnyPublisher()]) { XCTFail("\($0)") }
        let receipt = try Self.packet("model_settings_receipt", fields: ["control_id": "receipt", "ok": true, "result": [:]])
        var call = CentralCall(); call.id = "live"; call.state = "live"
        var worst = 0.0
        for index in 0..<500 {
            let start = threadCPU()
            settings.receive(.output(receipt))
            if index < 200 {
                call.lines.append(CentralCall.Line(callID: "live", turn: index / 2,
                    role: index.isMultiple(of: 2) ? "user" : "assistant", text: "回合 \(index)", interrupted: false))
                call.lines = Array(call.lines.suffix(60))
                history.timeline.accept(call, ownerIdentity: "owner")
            }
            worst = max(worst, threadCPU() - start)
        }
        try await Task.sleep(nanoseconds: 550_000_000)
        withExtendedLifetime(observation) {}
        print("COMBINED_BURST receipts=500 transcripts=200 history=5000 reads=\(reads) watches=\(watches) watch_computations=\(computations) max_main_ms=\(worst * 1000)")
        XCTAssertEqual(reads, 1); XCTAssertEqual(watches, 1); XCTAssertEqual(computations, 0)
        XCTAssertEqual(history.timeline.callLines("live").count, 200)
        XCTAssertEqual(history.timeline.latestAssistantItem(ownerIdentity: "owner")?.text, "回合 199")
        XCTAssertLessThan(worst * 2, 0.008)
    }

    private static func packet(_ operation: String, fields: [String: Any]) throws -> CentralTextPacket {
        var fields = fields
        fields["schema_version"] = AssistantCentralTextWire.schema
        fields["operation"] = operation; fields["session_id"] = "session"
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: fields))
    }

    private func threadCPU() -> Double {
        var value = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value)
        return Double(value.tv_sec) + Double(value.tv_nsec) / 1_000_000_000
    }
}

@MainActor
private final class BurstHistory: ObservableObject {
    @Published var timeline = YimiConversationTimeline()
}
