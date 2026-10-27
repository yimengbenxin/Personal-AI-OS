import Foundation
import XCTest
@testable import HealthKitExporter

final class AssistantTerminalTimelineTests: XCTestCase {
    func testProcessTimeZoneKeepsCachedForwardSyncAndSentReplyMerge() throws {
        assertProcessTimeZone()
        var seed = CentralTerminalState(); seed.bindOwner("owner")
        _ = try seed.sync()
        _ = try seed.accept(items([datedItem(100, at: "2026-10-25T00:05:00.000Z")], request: seed.requestID))
        var state = CentralTerminalState(); try state.restore(seed.encodedCache()); state.attach()
        var display = YimiConversationTimeline(items: [YimiItem(id: "local", kind: .me, text: "local draft",
            date: Date(timeIntervalSince1970: 1_792_886_730), delivery: .sending)])
        display.merge(state.timeline, ownerIdentity: "owner", includeLocal: false)
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: state.sync()) as? [String: Any])
        XCTAssertEqual(request["after_seq"] as? Int, 100)
        XCTAssertNil(request["before_seq"])
        _ = try state.accept(items([
            datedItem(101, at: "2026-10-25T00:06:00.000Z", text: "sent message"),
            datedItem(102, at: "2026-10-25T07:05:00.000Z", kind: "yimi", text: "server reply")
        ], request: state.requestID))
        display.merge(state.timeline, ownerIdentity: "owner", includeLocal: false)
        XCTAssertEqual(display.items.map(\.id), ["me-e100", "local", "me-e101", "me-e102"])
        XCTAssertEqual(display.items.map(\.text), ["row 100", "local draft", "sent message", "server reply"])
        XCTAssertEqual(display.items.map { $0.date.timeIntervalSince1970 },
            [1_792_886_700, 1_792_886_730, 1_792_886_760, 1_792_911_900])
        XCTAssertEqual(state.lastSeq, 102); XCTAssertNil(state.requestID)
        var restored = CentralTerminalState(); try restored.restore(state.encodedCache())
        XCTAssertEqual(restored.lastSeq, 102)
        XCTAssertEqual(restored.timeline.items, state.timeline.items)
        print("N15_TZ \(TimeZone.current.identifier) cached_forward_cursor=102 sent_reply_and_local_row=preserved")
    }

    func testProcessTimeZoneKeepsDSTHistoryPagingLiveRowsAndDeletion() throws {
        assertProcessTimeZone()
        var state = CentralTerminalState(); state.bindOwner("owner")
        _ = try state.sync()
        _ = try state.accept(items([datedItem(30, at: "2026-11-01T09:40:00.000Z")], request: state.requestID, more: true))
        let older = try XCTUnwrap(state.loadOlder(before: 30))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: older) as? [String: Any])
        XCTAssertEqual(fields["before_seq"] as? Int, 30); XCTAssertNil(fields["after_seq"])
        let request = state.requestID
        _ = try state.accept(items([datedItem(31, at: "2026-11-01T09:45:00.000Z", kind: "yimi", text: "live reply")]))
        _ = try state.accept(packet("timeline_removed", ["seq": 32, "head_seq": 32, "has_more": false, "removed_seqs": [27]]))
        _ = try state.accept(packet("timeline_items", ["request_id": try XCTUnwrap(request), "head_seq": 30,
            "has_more": true, "items": [
                datedItem(27, at: "2026-11-01T08:00:00.000Z", text: "deleted before page arrived"),
                datedItem(28, at: "2026-11-01T08:30:00.000Z"),
                datedItem(29, at: "2026-11-01T09:30:00.000Z")]]))
        var display = YimiConversationTimeline(); display.merge(state.timeline, ownerIdentity: "owner", includeLocal: false)
        XCTAssertEqual(display.items.compactMap(\.seq), [28, 29, 30, 31])
        XCTAssertEqual(display.items.map { $0.date.timeIntervalSince1970 },
            [1_793_521_800, 1_793_525_400, 1_793_526_000, 1_793_526_300])
        XCTAssertEqual(display.items[1].date.timeIntervalSince(display.items[0].date), 3600)
        XCTAssertEqual(display.items.last?.text, "live reply")
        XCTAssertEqual(state.lastSeq, 32); XCTAssertNil(state.requestID); XCTAssertTrue(state.hasOlderHistory)
        var restored = CentralTerminalState(); try restored.restore(state.encodedCache())
        XCTAssertEqual(restored.timeline.items, display.items); XCTAssertEqual(restored.lastSeq, 32)
        print("N15_TZ \(TimeZone.current.identifier) DST_instants_delta=3600 older_before=30 live_delete_cursor=32 rows=28,29,30,31")
    }

    func testProcessTimeZoneKeepsBootstrapAndWireTimestampsAbsolute() throws {
        assertProcessTimeZone()
        for timestamp in ["2026-10-25T00:05:00.000Z", "2026-10-25T00:05:00Z"] {
            XCTAssertEqual(RealtimeControlValidation.parseTimestamp(timestamp)?.timeIntervalSince1970, 1_792_886_700)
        }
        for timestamp in ["2026-10-25T00:05:00.000", "2026-10-25T08:05:00.000+08:00"] {
            XCTAssertNil(RealtimeControlValidation.parseTimestamp(timestamp))
            XCTAssertThrowsError(try items([datedItem(1, at: timestamp)]))
        }
        print("N15_TZ \(TimeZone.current.identifier) bootstrap_epoch=1792886700 non_UTC_wire_rejected=true")
    }

    private func assertProcessTimeZone() {
        if let identifier = ProcessInfo.processInfo.environment["TZ"] {
            let expected = TimeZone(identifier: identifier)!
            for epoch in [1_792_886_700.0, 1_793_525_400.0] {
                let instant = Date(timeIntervalSince1970: epoch)
                XCTAssertEqual(TimeZone.current.secondsFromGMT(for: instant), expected.secondsFromGMT(for: instant),
                    "The process must actually use the injected time zone")
            }
        }
    }

    private func datedItem(_ seq: Int, at: String, kind: String = "owner", text: String? = nil) -> [String: Any] {
        var value = item(seq, text ?? "row \(seq)")
        value["at"] = at; value["kind"] = kind
        return value
    }

    func testCacheWriterSkipsUnpersistedPacketsAndKeepsNewestVersionFence() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = CentralTerminalCacheWriter()
        var state = CentralTerminalState(); state.bindOwner("owner")
        _ = try state.accept(items([item(1)]))
        try await writer.write(state, version: 1, to: url)
        let savedDate = Date(timeIntervalSince1970: 1_700_000_000)
        try FileManager.default.setAttributes([.modificationDate: savedDate], ofItemAtPath: url.path)
        _ = try state.accept(packet("avatar_state", ["profile": avatar()]))
        _ = try state.accept(packet("confirmations", ["items": []]))
        _ = try state.accept(packet("terminal_receipt", ["control_id": "c1", "ok": true]))
        try await writer.write(state, version: 3, to: url)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date, savedDate)
        var stale = state
        stale.timeline.upsert(YimiItem(id: "stale", kind: .her, text: "stale", date: .distantPast))
        try await writer.write(stale, version: 2, to: url)
        var restored = CentralTerminalState(); try restored.restore(Data(contentsOf: url))
        XCTAssertEqual(restored.timeline.items.map(\.id), ["me-e1"])
        _ = try state.accept(packet("timeline_removed", ["seq": 2, "head_seq": 2, "has_more": false, "removed_seqs": [1]]))
        try await writer.write(state, version: 4, to: url)
        try restored.restore(Data(contentsOf: url))
        XCTAssertTrue(restored.timeline.items.isEmpty)
        XCTAssertEqual(restored.lastSeq, 2)
        try await writer.remove(version: 5, at: url)
        try await writer.write(state, version: 6, to: url)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "Removal clears the persisted projection")
    }

    func testOpeningLongHistoryStopsAfterOnePageAndReconnectRequestsOnlyNewer() throws {
        var state = CentralTerminalState()
        _ = try state.sync()
        let response = try state.accept(items((672...701).map { item($0) }, request: state.requestID, more: true))
        XCTAssertNil(response.request, "Opening history must not request an older page")
        XCTAssertNil(state.requestID)
        XCTAssertEqual(state.timeline.items.count, 30)
        XCTAssertEqual(state.lastSeq, 701)
        state.attach()
        let reconnect = try XCTUnwrap(JSONSerialization.jsonObject(with: state.sync()) as? [String: Any])
        XCTAssertEqual(reconnect["after_seq"] as? Int, 701)
        XCTAssertNil(reconnect["before_seq"])
    }

    func testResyncWhileHistoryPageIsPendingDefersOneForwardCatchup() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        _ = try state.accept(items([item(50)], request: state.requestID, more: true))
        _ = try state.loadOlder(before: 50)
        let pending = try XCTUnwrap(state.requestID)
        XCTAssertNil(try state.accept(packet("timeline_resync", ["head_seq": 51])).request)
        XCTAssertEqual(state.requestID, pending)
        let next = try state.accept(items([item(49)], request: pending, more: true))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(next.request)) as? [String: Any])
        XCTAssertEqual(fields["after_seq"] as? Int, 50)
        XCTAssertNil(fields["before_seq"])
        _ = try state.accept(items([item(51)], request: state.requestID))
        XCTAssertNil(state.requestID)
        XCTAssertEqual(state.lastSeq, 51)
    }

    func testResyncDuringForwardPageIsNotLostAndEmptySnapshotCommitsItsHead() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(50)]))
        _ = try state.sync()
        let pending = try XCTUnwrap(state.requestID)
        XCTAssertNil(try state.accept(packet("timeline_resync", ["head_seq": 52])).request)
        let next = try state.accept(packet("timeline_items", ["items": [], "head_seq": 51,
            "has_more": false, "request_id": pending]))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(next.request)) as? [String: Any])
        XCTAssertEqual(fields["after_seq"] as? Int, 51)
        XCTAssertNil(try state.accept(items([item(52)], request: state.requestID)).request)
        XCTAssertEqual(state.lastSeq, 52)
        XCTAssertNil(state.requestID)
    }

    func testLiveResetAfterFinishedOlderPageStartsFreshSeed() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(2)]))
        _ = try state.sync(before: 2)
        _ = try state.accept(items([item(1)], request: state.requestID))
        XCTAssertNil(state.requestID)
        XCTAssertNotNil(try state.accept(packet("timeline_reset", ["head_seq": 0])).request)
        XCTAssertTrue(state.timeline.items.isEmpty)
        XCTAssertEqual(state.lastSeq, 0)
    }

    func testPairedGlassesSurviveRelaunchAndClearWithOwner() throws {
        var state = CentralTerminalState()
        state.bindOwner("owner")
        state.terminals = [CentralTerminal(device_id: "glasses", device_class: "glasses", label: nil,
            paired_at: "2026-10-18T00:00:00Z", connected: false, last_seen_at: nil, self: false, paused: nil)]
        var restored = CentralTerminalState()
        try restored.restore(state.encodedCache())
        XCTAssertEqual(restored.terminals, state.terminals)
        restored.bindOwner("other-owner")
        XCTAssertTrue(restored.terminals.isEmpty)
    }

    private func packet(_ operation: String, _ fields: [String: Any]) throws -> CentralTextPacket {
        var body = fields
        if ["timeline_items", "timeline_removed"].contains(operation), body["request_id"] != nil, body["page_end"] == nil { body["page_end"] = true }
        body["operation"] = operation; body["schema_version"] = "paios.central.text-envelope.v1"; body["session_id"] = "s1"
        return try AssistantCentralTextWire.decode(JSONSerialization.data(withJSONObject: body))
    }
    private func item(_ seq: Int, _ text: String = "hello", part: Int? = nil) -> [String: Any] {
        var value: [String: Any] = ["seq": seq, "item_id": "me-e\(seq)", "kind": "owner", "via": "text", "text": text, "at": "2026-10-15T00:00:00.000Z"]
        if let part { value["part"] = part; value["parts"] = 2 }
        return value
    }
    private func items(_ values: [[String: Any]], request: String? = nil, more: Bool = false) throws -> CentralTextPacket {
        var fields: [String: Any] = ["items": values, "head_seq": values.compactMap { $0["seq"] as? Int }.max() ?? 0, "has_more": more]
        if let request { fields["request_id"] = request }
        return try packet("timeline_items", fields)
    }
    func testTimelineProvenanceSurvivesCacheAndOwnerChangesWithoutRelabeling() throws {
        var source = CentralTerminalState()
        source.bindOwner("owner-a")
        _ = try source.accept(items([item(1, "private-a")]))
        let queued = source
        var restored = CentralTerminalState()
        try restored.restore(source.encodedCache())
        XCTAssertEqual(restored.ownerIdentity, "owner-a")
        XCTAssertEqual(restored.timeline.items.first?.ownerIdentity, "owner-a")
        source.bindOwner("owner-b")
        XCTAssertTrue(source.timeline.items.isEmpty)
        XCTAssertEqual(source.lastSeq, 0)
        _ = try source.accept(items([item(1, "private-b")]))
        XCTAssertEqual(source.timeline.items.first?.ownerIdentity, "owner-b")
        XCTAssertEqual(queued.timeline.items.first?.ownerIdentity, "owner-a", "deferred old snapshots keep original provenance")
        var unscoped = CentralTerminalState()
        _ = try unscoped.accept(items([item(1, "legacy")]))
        var legacy = CentralTerminalState()
        try legacy.restore(unscoped.encodedCache())
        XCTAssertNil(legacy.timeline.items.first?.ownerIdentity)
        legacy.bindOwner("owner-b")
        XCTAssertTrue(legacy.timeline.items.isEmpty, "unproven cursor must not suppress current owner history sync")
    }

    private func avatar(_ version: Int = 1) -> [String: Any] {
        ["version": version, "look_id": "approved-look", "style": "portrait",
         "image_url": "https://images.example.com/immutable/portrait.jpg",
         "focus": ["x": 0.2, "y": 0.8], "updated_at": "2026-10-17T00:00:00.000Z"]
    }

    func testAvatarSnapshotIgnoresOlderRevisionAndAcceptsAuthoritativeReset() throws {
        var state = CentralTerminalState()
        state.bindOwner("first-owner")
        _ = try state.accept(packet("avatar_state", ["profile": avatar(2)]))
        _ = try state.accept(packet("avatar_state", ["profile": avatar(1)]))
        XCTAssertTrue(state.avatarReceived)
        XCTAssertEqual(state.avatar?.version, 2)
        XCTAssertEqual(state.avatar?.focus.x, 0.2)
        XCTAssertEqual(state.avatar?.focus.y, 0.8)
        _ = try state.accept(packet("avatar_state", ["profile": NSNull(), "profile_version": 3]))
        XCTAssertNil(state.avatar)
        XCTAssertTrue(state.avatarReceived)
        // Profile sync does not depend on the conversation cursor.
        XCTAssertEqual(state.lastSeq, 0)
        XCTAssertNoThrow(try AssistantCentralTextWire.encode("avatar_sync", fields: [:]))
        _ = try state.accept(packet("avatar_state", ["profile": avatar(3)]))
        _ = try state.accept(items([item(1, "private-first-owner")]))
        _ = try state.sync()
        let queued = state
        let previousEvent = state.avatarEventID
        state.bindOwner("first-owner")
        XCTAssertEqual(state.avatar?.version, 3)
        XCTAssertEqual(state.lastSeq, 1)
        XCTAssertNotNil(state.requestID)
        state.bindOwner("second-owner")
        XCTAssertEqual(state.ownerIdentity, "second-owner")
        XCTAssertTrue(state.timeline.items.isEmpty)
        XCTAssertEqual(state.lastSeq, 0)
        XCTAssertNil(state.requestID)
        XCTAssertNotEqual(state.avatarEventID, previousEvent)
        XCTAssertEqual(queued.avatar?.version, 3)
        XCTAssertEqual(queued.ownerIdentity, "first-owner")
        XCTAssertNil(state.avatar)
        XCTAssertFalse(state.avatarReceived)
        _ = try state.accept(packet("avatar_state", ["profile": avatar(1)]))
        XCTAssertEqual(state.avatar?.version, 1)
    }

    func testDefaultRevisionPreventsDelayedCustomProfileAndKeepsLoadedReceipts() throws {
        var state = CentralTerminalState(); state.bindOwner("owner")
        _ = try state.accept(packet("avatar_state", ["profile": avatar(2), "profile_version": 2]))
        _ = try state.accept(packet("avatar_state", ["profile": NSNull(), "profile_version": 4,
            "loaded_receipts": [["device_id": "mac-owner", "device_type": "mac", "profile_version": 4, "loaded_at": "2026-10-19T00:00:00.000Z"]]]))
        _ = try state.accept(packet("avatar_state", ["profile": avatar(3), "profile_version": 3]))
        XCTAssertNil(state.avatar)
        XCTAssertEqual(state.avatarVersion, 4)
        XCTAssertEqual(state.avatarLoadedReceipts.first?.device_type, "mac")
        XCTAssertEqual(state.avatarLoadedReceipts.first?.profile_version, 4)
    }

    func testAvatarRejectsInvalidRemoteProfileAtDecodeBoundary() throws {
        var malformed = avatar()
        malformed["image_url"] = "http://images.example.com/avatar.jpg"
        XCTAssertThrowsError(try packet("avatar_state", ["profile": malformed]))
        malformed = avatar(); malformed["focus"] = ["x": -0.1, "y": 0.5]
        XCTAssertThrowsError(try packet("avatar_state", ["profile": malformed]))
        malformed = avatar(); malformed["version"] = 0
        XCTAssertThrowsError(try packet("avatar_state", ["profile": malformed]))
        malformed = avatar(); malformed["updated_at"] = "not-a-date"
        var state = CentralTerminalState()
        XCTAssertThrowsError(try state.accept(packet("avatar_state", ["profile": malformed])))
    }

    func testPartialItemNeverAdvancesPersistedCursorPastIncompleteSequence() throws {
        var state = CentralTerminalState()
        _ = try state.sync()
        let request = try XCTUnwrap(state.requestID)
        _ = try state.accept(items([item(10, "first", part: 1), item(11)], request: request))
        XCTAssertEqual(state.lastSeq, 0)
        XCTAssertEqual(state.timeline.items.map(\.id), ["me-e11"])
        var restored = CentralTerminalState(); try restored.restore(state.encodedCache())
        XCTAssertEqual(restored.lastSeq, 0)
        _ = try state.accept(items([item(10, "second", part: 2)], request: request))
        XCTAssertEqual(state.lastSeq, 11)
        XCTAssertEqual(state.timeline.items.first(where: { $0.id == "me-e10" })?.text, "firstsecond")
    }
    func testGapRequestsOneCatchupAndDeduplicatesSourceItem() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(1)]))
        let gap = try state.accept(items([item(3)]))
        XCTAssertNotNil(gap.request); XCTAssertEqual(state.lastSeq, 1)
        XCTAssertNil(try state.accept(items([item(3)])).request)
        let request = try XCTUnwrap(state.requestID)
        _ = try state.accept(items([item(2), item(3)], request: request))
        XCTAssertEqual(state.lastSeq, 3)
        XCTAssertEqual(state.timeline.items.count, 3)
    }
    func testTombstonesRemoveAndResetDropsCache() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(1), item(2)]))
        _ = try state.accept(packet("timeline_removed", ["head_seq": 3, "seq": 3, "has_more": false, "removed_seqs": [1]]))
        XCTAssertEqual(state.timeline.items.map(\.seq), [2])
        _ = try state.accept(items([item(1)]))
        XCTAssertEqual(state.timeline.items.map(\.seq), [2])
        let reset = try state.accept(packet("timeline_reset", ["head_seq": 3]))
        XCTAssertNotNil(reset.request); XCTAssertTrue(state.timeline.items.isEmpty); XCTAssertEqual(state.lastSeq, 0)
    }
    func testCatchupDrainsSevenPagesAndOlderRequestHasBeforeOnly() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(1)]))
        var requestBytes = try state.sync()
        for seq in 2...8 {
            let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: requestBytes) as? [String: Any])
            XCTAssertEqual(fields["limit"] as? Int, 30)
            let request = try XCTUnwrap(state.requestID)
            let result = try state.accept(packet("timeline_items", ["items": [item(seq)],
                "head_seq": 8, "has_more": seq < 8, "request_id": request]))
            XCTAssertEqual(result.request != nil, seq < 8)
            XCTAssertEqual(state.lastSeq, seq)
            XCTAssertEqual(state.syncHeadSeq, 8)
            XCTAssertEqual(state.isCatchingUp, seq < 8)
            var restored = CentralTerminalState(); try restored.restore(state.encodedCache())
            XCTAssertEqual(restored.lastSeq, seq, "Each completed page persists its cursor")
            if let next = result.request { requestBytes = next }
        }
        XCTAssertEqual(state.timeline.items.count, 8)
        let older = try JSONSerialization.jsonObject(with: state.sync(before: 2)) as? [String: Any]
        XCTAssertEqual(older?["before_seq"] as? Int, 2); XCTAssertNil(older?["after_seq"])
    }
    func testCatchupRejectsNonAdvancingPageAndIgnoresSupersededResponse() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        let stale = try XCTUnwrap(state.requestID)
        _ = try state.sync()
        XCTAssertNil(try state.accept(items([item(20)], request: stale, more: true)).request)
        XCTAssertEqual(state.lastSeq, 0)
        // Seed a forward cursor: fresh seeds use has_more to page backward, even with no forward progress.
        _ = try state.accept(items([item(1)], request: state.requestID))
        _ = try state.sync()
        XCTAssertThrowsError(try state.accept(items([], request: state.requestID, more: true)))
        XCTAssertNil(state.requestID)
        XCTAssertTrue(state.syncFailed)
    }
    func testCatchupBeyondRetentionKeepsBoundedTimelineAndCompleteCursor() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(1)]))
        _ = try state.sync()
        for seq in 2...5001 {
            _ = try state.accept(packet("timeline_items", ["items": [item(seq)],
                "head_seq": 5001, "has_more": seq < 5001, "request_id": try XCTUnwrap(state.requestID)]))
            XCTAssertLessThanOrEqual(state.timeline.items.count, 5000)
        }
        XCTAssertEqual(state.lastSeq, 5001)
        XCTAssertEqual(state.timeline.items.count, 5000)
        XCTAssertNil(state.requestID)
    }
    func testMarkedSeedWaitsForPageEndThenCommitsHeadWithoutAutoBackfill() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        let request = try XCTUnwrap(state.requestID)
        for seq in 672...701 {
            let next = try state.accept(packet("timeline_items", ["items": [item(seq)],
                "head_seq": 701, "has_more": true, "request_id": request, "page_end": seq == 701]))
            XCTAssertNil(next.request)
            XCTAssertEqual(state.requestID == nil, seq == 701)
        }
        XCTAssertEqual(state.timeline.items.count, 30)
        XCTAssertEqual(state.lastSeq, 701)
        XCTAssertTrue(state.hasOlderHistory)
    }

    func testWireFramesAssembleSplitItemsAndAdvanceThroughRemovalPages() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(1)])); _ = try state.sync()
        let request = try XCTUnwrap(state.requestID)
        XCTAssertNil(try state.accept(packet("timeline_items", ["items": [item(2, "first", part: 1)],
            "head_seq": 9, "has_more": true, "request_id": request])).request)
        XCTAssertEqual(state.lastSeq, 1)
        XCTAssertNotNil(try state.accept(packet("timeline_items", ["items": [item(2, "second", part: 2)],
            "head_seq": 9, "has_more": true, "request_id": request])).request)
        _ = try state.accept(packet("timeline_removed", ["seq": 3, "removed_seqs": [1], "head_seq": 9,
            "has_more": true, "request_id": try XCTUnwrap(state.requestID)]))
        for seq in 4...9 {
            _ = try state.accept(packet("timeline_items", ["items": [item(seq)], "head_seq": 9,
                "has_more": seq < 9, "request_id": try XCTUnwrap(state.requestID)]))
        }
        XCTAssertEqual(state.lastSeq, 9)
        XCTAssertNil(state.requestID)
        XCTAssertEqual(state.timeline.items.first?.text, "firstsecond")
        XCTAssertFalse(state.timeline.items.contains { $0.seq == 1 })
    }
    func testFreshSnapshotCommitsDeletionTailHeadAndDropsUncommittedCachedServerRows() throws {
        var state = CentralTerminalState()
        state.timeline.upsert(YimiItem(id: "stale", kind: .me, text: "deleted server row", date: .distantPast, seq: 11))
        state.timeline.upsert(YimiItem(id: "local", kind: .me, text: "unsent", date: .distantPast))
        _ = try state.sync()
        XCTAssertEqual(state.timeline.items.map(\.id), ["local"])
        let result = try state.accept(packet("timeline_items", ["items": [item(10)], "head_seq": 10000,
            "has_more": false, "request_id": try XCTUnwrap(state.requestID)]))
        XCTAssertNil(result.request, "Fresh snapshot already reflects the deletion tail; do not request after10 and reset-loop")
        XCTAssertEqual(state.lastSeq, 10000)
        XCTAssertNil(state.requestID)
        XCTAssertFalse(state.syncFailed)
        XCTAssertEqual(Set(state.timeline.items.map(\.id)), Set(["local", "me-e10"]))
    }
    func testRetriedSeedReplaysDeletionBetweenItsFirstHeadAndReplacementPage() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        let request = try XCTUnwrap(state.requestID)
        _ = try state.accept(packet("timeline_items", ["items": [item(10), item(11)], "head_seq": 100,
            "has_more": true, "request_id": request, "page_end": false]))
        XCTAssertEqual(state.lastSeq, 0, "A partially delivered seed cannot persist its frame cursor")
        // Publication failure makes the gateway query this seed again under the same request.
        let next = try state.accept(packet("timeline_items", ["items": [item(130)], "head_seq": 130,
            "has_more": true, "request_id": request, "page_end": true]))
        XCTAssertEqual(state.lastSeq, 100)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(next.request)) as? [String: Any])
        XCTAssertEqual(fields["after_seq"] as? Int, 100)
        _ = try state.accept(packet("timeline_removed", ["seq": 101, "removed_seqs": [10], "head_seq": 130,
            "has_more": false, "request_id": try XCTUnwrap(state.requestID), "page_end": false]))
        var restored = CentralTerminalState(); try restored.restore(state.encodedCache())
        XCTAssertEqual(restored.lastSeq, 101, "Disconnect mid-replay must not skip deletion102")
        _ = try state.accept(packet("timeline_removed", ["seq": 102, "removed_seqs": [11], "head_seq": 130,
            "has_more": false, "request_id": try XCTUnwrap(state.requestID), "page_end": false]))
        _ = try state.accept(items([item(130)], request: state.requestID))
        XCTAssertEqual(state.lastSeq, 130)
        XCTAssertFalse(state.timeline.items.contains { $0.seq == 10 || $0.seq == 11 })
        XCTAssertNil(state.requestID)
    }

    func testFreshSnapshotUsesFirstHeadAndReplaysLiveChangesDuringPage() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        let request = try XCTUnwrap(state.requestID)
        _ = try state.accept(packet("timeline_items", ["items": [item(9)], "head_seq": 10000,
            "has_more": true, "request_id": request, "page_end": false]))
        _ = try state.accept(packet("timeline_removed", ["seq": 10001, "removed_seqs": [10], "head_seq": 10002, "has_more": false]))
        let next = try state.accept(packet("timeline_items", ["items": [item(10)], "head_seq": 10000,
            "has_more": true, "request_id": request, "page_end": true]))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(next.request)) as? [String: Any])
        XCTAssertEqual(fields["after_seq"] as? Int, 10000)
        _ = try state.accept(packet("timeline_removed", ["seq": 10001, "removed_seqs": [10], "head_seq": 10002,
            "has_more": false, "request_id": try XCTUnwrap(state.requestID), "page_end": false]))
        _ = try state.accept(packet("timeline_items", ["items": [item(10002)], "head_seq": 10002,
            "has_more": false, "request_id": try XCTUnwrap(state.requestID)]))
        XCTAssertEqual(state.lastSeq, 10002)
        XCTAssertFalse(state.timeline.items.contains { $0.seq == 10 })
        XCTAssertTrue(state.timeline.items.contains { $0.seq == 10002 })
        XCTAssertNil(state.requestID)
    }

    func testLiveFragmentedGapPreservesFirstPartWhileForwardSyncQueues() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(1)]))
        let gap = try state.accept(packet("timeline_items", ["items": [item(10, "first", part: 1)],
            "head_seq": 10, "has_more": false]))
        XCTAssertNotNil(gap.request)
        let pending = try XCTUnwrap(state.requestID)
        XCTAssertEqual(state.lastSeq, 1)
        // Gateway finishes all fragments of its live item before serving the queued sync request.
        _ = try state.accept(packet("timeline_items", ["items": [item(10, "second", part: 2)],
            "head_seq": 10, "has_more": false]))
        XCTAssertEqual(state.timeline.items.first { $0.seq == 10 }?.text, "firstsecond")
        XCTAssertEqual(state.requestID, pending)
        for seq in 2...10 {
            let response = try state.accept(packet("timeline_items", ["items": [item(seq, seq == 10 ? "firstsecond" : "hello")],
                "head_seq": 10, "has_more": seq < 10, "request_id": try XCTUnwrap(state.requestID)]))
            XCTAssertEqual(response.request != nil, seq < 10, "No orphan live fragment can block page completion")
        }
        XCTAssertEqual(state.lastSeq, 10)
        XCTAssertNil(state.requestID)
        XCTAssertFalse(state.syncFailed)
        XCTAssertEqual(state.timeline.items.count, 10)
    }
    func testLiveDeletionBeforePreparedPageConsumesPositionWithoutResurrectingText() throws {
        for fragmented in [false, true] {
            var state = CentralTerminalState()
            _ = try state.accept(items([item(1)])); _ = try state.sync()
            let pending = try XCTUnwrap(state.requestID)
            _ = try state.accept(packet("timeline_removed", ["seq": 4, "removed_seqs": [2], "head_seq": 4, "has_more": false]))
            XCTAssertEqual(state.lastSeq, 1)
            if fragmented {
                let first = try state.accept(packet("timeline_items", ["items": [item(2, "deleted-first", part: 1)],
                    "head_seq": 3, "has_more": true, "request_id": pending]))
                XCTAssertNil(first.request)
                XCTAssertEqual(state.requestID, pending)
                XCTAssertFalse(state.syncFailed)
            }
            let prepared = item(2, "deleted", part: fragmented ? 2 : nil)
            let next = try state.accept(packet("timeline_items", ["items": [prepared],
                "head_seq": 3, "has_more": true, "request_id": pending]))
            XCTAssertNotNil(next.request)
            XCTAssertEqual(state.lastSeq, 2)
            XCTAssertFalse(state.timeline.items.contains { $0.seq == 2 })
            _ = try state.accept(packet("timeline_items", ["items": [item(3)], "head_seq": 4,
                "has_more": true, "request_id": try XCTUnwrap(state.requestID)]))
            _ = try state.accept(packet("timeline_removed", ["seq": 4, "removed_seqs": [2], "head_seq": 4,
                "has_more": false, "request_id": try XCTUnwrap(state.requestID)]))
            XCTAssertEqual(state.lastSeq, 4)
            XCTAssertNil(state.requestID)
            XCTAssertFalse(state.syncFailed)
            XCTAssertEqual(state.timeline.items.compactMap(\.seq), [1, 3])
        }
    }
    func testServerRetryReplacesAbandonedPartialPageUnderSameRequestID() throws {
        var state = CentralTerminalState()
        _ = try state.accept(items([item(1)])); _ = try state.sync()
        let pending = try XCTUnwrap(state.requestID)
        let partial = try state.accept(packet("timeline_items", ["items": [item(10, "abandoned", part: 1)],
            "head_seq": 11, "has_more": true, "request_id": pending]))
        XCTAssertNil(partial.request)
        XCTAssertEqual(state.lastSeq, 1)
        // Gateway retries its failed publication by querying after1 again. Row10 was deleted meanwhile.
        let replacement = try state.accept(packet("timeline_items", ["items": [item(11)],
            "head_seq": 12, "has_more": true, "request_id": pending]))
        XCTAssertNotNil(replacement.request)
        XCTAssertEqual(state.lastSeq, 11, "Abandoned row10 cannot leave a fragment ceiling at9")
        _ = try state.accept(packet("timeline_removed", ["seq": 12, "removed_seqs": [10], "head_seq": 12,
            "has_more": false, "request_id": try XCTUnwrap(state.requestID)]))
        XCTAssertEqual(state.lastSeq, 12)
        XCTAssertNil(state.requestID)
        XCTAssertFalse(state.syncFailed)
        XCTAssertEqual(state.timeline.items.compactMap(\.seq), [1, 11])
    }
    func testTopGestureLoadsExactlyOnePageWithOneRequestInFlight() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        _ = try state.accept(items((672...701).map { item($0) }, request: state.requestID, more: true))
        var scroll = YimiChatScrollState()
        _ = scroll.update(.init(top: -500, bottom: 600, viewport: 600))
        XCTAssertNil(state.requestID, "Layout alone cannot load history")
        XCTAssertFalse(scroll.drag(towardHistory: true, began: true))
        XCTAssertTrue(scroll.update(.init(top: 0, bottom: 1100, viewport: 600)))
        let bytes = try XCTUnwrap(state.loadOlder(before: 672))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(fields["before_seq"] as? Int, 672)
        XCTAssertEqual(fields["limit"] as? Int, 30)
        XCTAssertEqual(fields["page_markers"] as? Bool, true)
        XCTAssertNil(fields["after_seq"])
        XCTAssertNil(try state.loadOlder(before: 672))
        let result = try state.accept(items((642...671).map { item($0) }, request: state.requestID, more: true))
        XCTAssertNil(result.request, "A history page must not chain another request")
        XCTAssertNil(state.requestID)
        XCTAssertEqual(state.timeline.items.count, 60)
        XCTAssertEqual(state.lastSeq, 701)
        XCTAssertFalse(scroll.update(.init(top: 0, bottom: 2100, viewport: 600)))
        var restored = CentralTerminalState(); try restored.restore(state.encodedCache())
        XCTAssertTrue(restored.hasOlderHistory)
        _ = try state.loadOlder(before: 642)
        _ = try state.accept(items([item(641)], request: state.requestID))
        XCTAssertFalse(state.hasOlderHistory)
        XCTAssertNil(try state.loadOlder(before: 641))
        try restored.restore(state.encodedCache())
        XCTAssertFalse(restored.hasOlderHistory)
    }

    func testPublicationFailureCannotCancelNewerSyncIntent() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        let failed = state.requestID
        _ = try state.sync()
        XCTAssertFalse(state.failSync(requestID: failed))
        let current = state.requestID
        _ = try state.accept(packet("timeline_reset", ["head_seq": 100, "request_id": try XCTUnwrap(failed)]))
        XCTAssertEqual(state.requestID, current)
        XCTAssertNotNil(state.requestID)
        XCTAssertFalse(state.syncFailed)
        XCTAssertTrue(state.failSync(requestID: state.requestID))
        XCTAssertTrue(state.syncFailed)
        XCTAssertNil(state.requestID)
    }
    func testEnrollmentBindsMacClassAndCanonicalOrigin() throws {
        let origin = "https://example.com"
        var payload = ["schema": "paios.mac-enrollment.v1", "origin": origin, "token": String(repeating: "a", count: 43), "expires_at": "2099-01-01T00:00:00.000Z"]
        let bytes = try JSONSerialization.data(withJSONObject: payload)
        XCTAssertNoThrow(try RealtimeTerminalEnrollment.decode(bytes, origin: origin, deviceClass: .mac))
        XCTAssertThrowsError(try RealtimeTerminalEnrollment.decode(bytes, origin: origin))
        payload["extra"] = "bad"
        XCTAssertThrowsError(try RealtimeTerminalEnrollment.decode(JSONSerialization.data(withJSONObject: payload), origin: origin, deviceClass: .mac))
        payload.removeValue(forKey: "extra"); payload["origin"] = origin + "/"
        XCTAssertThrowsError(try RealtimeTerminalEnrollment.decode(JSONSerialization.data(withJSONObject: payload), origin: origin, deviceClass: .mac))
        payload["origin"] = origin; payload["expires_at"] = "2000-01-01T00:00:00.000Z"
        XCTAssertThrowsError(try RealtimeTerminalEnrollment.decode(JSONSerialization.data(withJSONObject: payload), origin: origin, deviceClass: .mac))
    }
    func testGlassesEnrollmentCannotBeExchangedAsMacAndMacRejectsLegacyOrigin() throws {
        let origin = "https://example.com"
        let glasses: [String: String] = ["schema": "paios.glasses-enrollment.v1", "origin": origin, "token": String(repeating: "a", count: 43), "expires_at": "2099-01-01T00:00:00.000Z"]
        let bytes = try JSONSerialization.data(withJSONObject: glasses)
        XCTAssertNoThrow(try RealtimeTerminalEnrollment.decode(bytes, origin: origin, deviceClass: .glasses))
        XCTAssertThrowsError(try RealtimeTerminalEnrollment.decode(bytes, origin: origin, deviceClass: .mac))
        var mac = glasses; mac["schema"] = "paios.mac-enrollment.v1"; mac["origin"] = RealtimeAPIOriginMigration.legacyOrigin
        XCTAssertThrowsError(try RealtimeTerminalEnrollment.decode(JSONSerialization.data(withJSONObject: mac), origin: RealtimeAPIOriginMigration.canonicalOrigin, deviceClass: .mac))
    }

    func testPublishedTimelineAttachmentsReachPersistedPhoneAndMacChips() throws {
        var incoming = item(1)
        incoming["attachments"] = [["name": "发票.pdf", "kind": "pdf", "size": 1024]]
        var state = CentralTerminalState()
        _ = try state.accept(items([incoming]))
        let chip = try XCTUnwrap(state.timeline.chatItems.first?.attachments?.first)
        XCTAssertEqual(chip.name, "发票.pdf"); XCTAssertEqual(chip.kind, "pdf"); XCTAssertEqual(chip.size, 1024)
        var restored = CentralTerminalState(); try restored.restore(state.encodedCache())
        XCTAssertEqual(restored.timeline.chatItems.first?.attachments, [chip])
        incoming["attachments"] = [["name": "发票.pdf", "kind": "pdf", "size": 1024, "path": "/private/invoice.pdf"]]
        XCTAssertThrowsError(try items([incoming]), "Timeline chips carry the published metadata only")
    }

    func testOlderPagesInsertBySequenceAndDeduplicateLocalOwnerID() throws {
        var state = CentralTerminalState()
        state.timeline.upsert(YimiItem(id: "me-e1", kind: .me, text: "local", date: Date(timeIntervalSince1970: 123)))
        _ = try state.sync()
        _ = try state.accept(items([item(2)], request: state.requestID))
        _ = try state.sync(before: 2)
        _ = try state.accept(items([item(1, "canonical")], request: state.requestID))
        XCTAssertEqual(state.timeline.chatItems.map(\.id), ["me-e1", "me-e2"])
        XCTAssertEqual(state.timeline.chatItems.first?.date, Date(timeIntervalSince1970: 123))
        XCTAssertEqual(state.timeline.chatItems.first?.text, "canonical")
        XCTAssertEqual(state.lastSeq, 2, "Paging older history cannot rewind the catch-up cursor")
        var newerFirst = YimiConversationTimeline()
        newerFirst.accept(try JSONDecoder().decode(CentralTimelineItem.self, from: JSONSerialization.data(withJSONObject: item(2))))
        newerFirst.accept(try JSONDecoder().decode(CentralTimelineItem.self, from: JSONSerialization.data(withJSONObject: item(1))))
        XCTAssertEqual(newerFirst.chatItems.compactMap(\.seq), [1, 2], "Same timestamp still orders by authoritative sequence")
    }

    func testOlderSplitCannotRewindOrSkipLiveCursor() throws {
        var state = CentralTerminalState(); _ = try state.sync()
        _ = try state.accept(items([item(2)], request: state.requestID))
        _ = try state.sync(before: 2)
        let request = state.requestID
        _ = try state.accept(items([item(1, "old-", part: 1)], request: request))
        _ = try state.accept(items([item(3)]))
        XCTAssertEqual(state.lastSeq, 2)
        _ = try state.accept(items([item(1, "finished", part: 2)], request: request))
        XCTAssertEqual(state.lastSeq, 3)
        XCTAssertEqual(state.timeline.chatItems.compactMap(\.seq), [1, 2, 3])
        XCTAssertEqual(state.timeline.chatItems.first?.text, "old-finished")
    }

    func testServerHistoryExceedsLocalRecordBudget() {
        var timeline = YimiConversationTimeline()
        for seq in (1...601).reversed() {
            timeline.upsert(YimiItem(id: "server-\(seq)", kind: .me, text: "history", date: .distantPast, seq: seq))
        }
        XCTAssertEqual(timeline.chatItems.count, 601)
        XCTAssertEqual(timeline.chatItems.first?.seq, 1)
        XCTAssertEqual(timeline.chatItems.last?.seq, 601)
    }

    func testFormalAttachmentsRoundtripAndLimits() throws {
        let attachment = CentralAttachment(grantID: "grant-1", path: "/tmp/file.pdf", name: "file.pdf", size: 123, kind: "pdf")
        let envelope = AssistantPromptEnvelope(promptID: "0199e60d-0000-7000-8000-000000000001", text: "处理这份文件", attachments: [attachment])
        XCTAssertEqual(try AssistantPromptEnvelope.decodeStrict(envelope.encodedStrict()), envelope)
        let bytes = try AssistantCentralTextWire.submit(eventID: "event1", capturedAt: "2026-10-15T00:00:00.000Z", text: envelope.text, attachments: envelope.attachments)
        let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        XCTAssertEqual((object?["attachments"] as? [[String: Any]])?.first?["grant_id"] as? String, "grant-1")
        XCTAssertThrowsError(try AssistantCentralTextWire.submit(eventID: "event1", capturedAt: "2026-10-15T00:00:00.000Z", text: "test", attachments: Array(repeating: attachment, count: 11)))
    }
}
