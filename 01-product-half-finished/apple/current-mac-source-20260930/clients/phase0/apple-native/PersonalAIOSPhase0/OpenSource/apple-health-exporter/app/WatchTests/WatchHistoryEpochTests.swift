import Foundation
import XCTest
@testable import PersonalAIOSWatch

final class WatchHistoryEpochTests: XCTestCase {
    func testNewHistoryRetiresCachedReplyAndPendingWorkButKeepsPairingCredential() throws {
        let scope = WatchBindingScope(watch_device_id: UUID().uuidString, pair_version: "1")
        func state(_ revision: UInt64, _ epoch: String, latest: WatchYimiLatest? = nil) -> WatchYimiState {
            WatchYimiState(version: 1, kind: "yimi_state", rev: revision, link: .ok, scope: scope,
                latest: latest, question: nil, errands: [], care: nil,
                payment_pending: .init(count: 0, summary: ""), ride: nil, history_epoch: epoch)
        }
        let credential = WatchCredential(version: 1, kind: "watch_credential", token: "synthetic-pairing",
            expires_at: "2099-01-01T00:00:00Z", server: "https://synthetic.invalid", scope: scope)
        let old = state(1, String(repeating: "a", count: 32),
            latest: .init(card_id: "old", title: "依米", lines: ["synthetic history"],
                          created_at: "2026-10-25T00:00:00Z", kind: .message))
        var reducer = WatchStateReducer(state: old, credential: credential)
        try reducer.begin(.init(kind: .request, action: .stateRequest, requestID: "old-work",
                                sequence: 1, version: 1, args: .init()), scope: scope)
        let incoming = state(2, String(repeating: "b", count: 32))
        XCTAssertTrue(reducer.apply(try WatchYimiState.decodeStrict(incoming.encodedStrict()), fromContext: true))
        XCTAssertNil(reducer.state?.latest)
        XCTAssertTrue(reducer.pending.isEmpty)
        XCTAssertEqual(reducer.credential, credential)
        XCTAssertEqual(reducer.scope, scope)
    }
}
