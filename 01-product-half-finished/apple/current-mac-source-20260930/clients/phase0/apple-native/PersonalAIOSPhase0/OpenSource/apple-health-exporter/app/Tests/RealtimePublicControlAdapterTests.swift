import CryptoKit
import CoreLocation
import Darwin
import Dispatch
import Foundation
import GRDB
import Security
import XCTest
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif
@testable import HealthKitExporter

final class RealtimePublicControlAdapterTests: XCTestCase {
    private let adapter = RealtimePublicControlAdapter()
    // Frozen HPKE vector expires at 2026-08-23T12:00:00.000Z; its AAD stays byte-identical.
    private static let e2eeVectorNow = Date(timeIntervalSince1970: 1787482800) // 2026-08-23T11:00:00Z

    override func setUp() {
        super.setUp()
        RealtimeURLProtocolSpy.reset()
    }

    func testBootstrapConnectionResetsReplayIdenticalAdmittedRequest() async throws {
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], bootstrapRecoveryWindow: .seconds(3))
        RealtimeURLProtocolSpy.handler = { [self] request in
            if RealtimeURLProtocolSpy.requestCount == 1 { throw URLError(.timedOut) }
            if RealtimeURLProtocolSpy.requestCount < 4 { throw URLError(.networkConnectionLost) }
            XCTAssertEqual(request.timeoutInterval, 30)
            return response(for: request, body: fixture("bootstrap-response.valid.json"))
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let requests = RealtimeURLProtocolSpy.observations
        XCTAssertEqual(requests.count, 4)
        XCTAssertTrue(requests.allSatisfy { $0.body == requests.first?.body })
        XCTAssertEqual(requests.first?.absoluteURL, requests.last?.absoluteURL)
        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, statusCode: 403, body: Data("{}".utf8)) }
        do { _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true)); XCTFail("HTTP denial must fail") }
        catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .unexpectedHTTPStatus(403, nil)) }
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1, "HTTP denial is never retried within the recovery window")
    }

    func testHTTPBudgetAcceptsExactLimitAndRejectsOversizedSuccessAndErrors() async throws {
        let limit = 128 * 1024
        let valid = fixture("bootstrap-response.valid.json")
        for (status, count) in [(200, valid.count), (200, limit), (200, limit + 1), (403, limit + 1), (503, limit + 1)] {
            RealtimeURLProtocolSpy.reset()
            let body = valid + Data(repeating: 32, count: count - valid.count)
            let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")])
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, statusCode: status, body: body) }
            do {
                _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
                XCTAssertLessThanOrEqual(count, limit)
            } catch {
                XCTAssertGreaterThan(count, limit)
                XCTAssertEqual(error as? RealtimePublicControlAdapterError, .responseTooLarge)
            }
            XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)
        }
    }

    func testHTTPBudgetRejectsOversizedRefreshBeforeTerminalParsing() async throws {
        let terminal = Data(#"{"operation":"connected_credential_refresh","status":"revoked"}"#.utf8)
        let oversized = terminal + Data(repeating: 32, count: 128 * 1024 + 1 - terminal.count)
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"),
                                           .credentialRefresh: fixture("credential-refresh.valid.json")])
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, body: request.url?.path == "/v1/realtime/bootstrap"
                ? fixture("bootstrap-response.valid.json") : oversized)
        }
        let intent = AssistantStartIntent(userInitiated: true)
        let existing = try await provider.bootstrap(for: intent)
        do { _ = try await provider.reconnectDetails(existing, for: intent); XCTFail("Oversized refresh must fail") }
        catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .responseTooLarge) }
    }

    func testHTTPBudgetStopsOversizedStreamWithoutWaitingForEOF() async throws {
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")])
        let stopped = expectation(description: "Oversized response task cancelled before EOF")
        RealtimeURLProtocolSpy.holdResponseOpen = true
        RealtimeURLProtocolSpy.onStop = { _ in stopped.fulfill() }
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, body: Data(repeating: 32, count: 128 * 1024 + 1))
        }
        let pending = Task { try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true)) }
        let completion = await XCTWaiter.fulfillment(of: [stopped], timeout: 2)
        XCTAssertEqual(completion, .completed)
        if completion != .completed { pending.cancel() } // Release the baseline without racing the size error.
        do { _ = try await pending.value; XCTFail("Oversized stream must fail") }
        catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .responseTooLarge) }
    }

    func testHTTPBudgetStopsOversizedOriginProofWithoutChangingPairing() async throws {
        let store = RealtimeTestPairingStore(), original = try pairingData()
        try store.replacePairingData(original)
        let clock = RealtimeOriginTestClock(), settled = originProbeFinished(clock)
        let stopped = expectation(description: "Oversized origin proof cancelled before EOF")
        let accepted = try originMigrationResponse(proof: false)
        RealtimeURLProtocolSpy.onStop = { request in
            if request.url?.path.hasSuffix("/reconcile") == true { stopped.fulfill() }
        }
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path.hasSuffix("/reconcile") == true {
                RealtimeURLProtocolSpy.holdResponseOpen = true
                return response(for: request, body: Data(repeating: 32, count: 128 * 1024 + 1))
            }
            return response(for: request, body: accepted)
        }
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")],
                                    credentials: PairedRealtimeCredentialStore(store: store), originProbeNow: clock.now)
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        await fulfillment(of: [stopped], timeout: 2)
        await fulfillment(of: [settled], timeout: 6) // Baseline proof eventually reaches its existing deadline.
        XCTAssertEqual(store.data, original)
    }

    func testHTTPBudgetRejectsOversizedEnrollmentBeforeDecode() async throws {
        let pairing = try RealtimeDevicePairing.decode(pairingData())
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RealtimeURLProtocolSpy.self]
        let transport = URLSession(configuration: config)
        defer { transport.invalidateAndCancel() }
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, statusCode: 403, body: Data(repeating: 32, count: 128 * 1024 + 1))
        }
        do {
            _ = try await ProductionRealtimePublicControlProvider.glassesEnrollment(pairing: pairing, session: transport)
            XCTFail("Oversized enrollment must fail")
        } catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .responseTooLarge) }
    }

    func testOnlyACommittedBootstrapReadLeavesASessionToStop() throws {
        func fact(_ fields: [String: Any]) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["operation": "bootstrap", "kind": "paios.public-operation.read.v1"]
                .merging(fields) { $1 })
        }
        XCTAssertTrue(try adapter.bootstrapReadLeftSessionToStop(fact(["status": "committed"])))
        // Never ran, or superseded by the device's next explicit Start: nothing to stop, Start stays free.
        XCTAssertFalse(try adapter.bootstrapReadLeftSessionToStop(fact(["status": "missing"])))
        XCTAssertFalse(try adapter.bootstrapReadLeftSessionToStop(fact(["status": "failed", "outcome": "not_executed"])))
        XCTAssertFalse(try adapter.bootstrapReadLeftSessionToStop(fact(["status": "failed", "outcome": "unknown"])))
        XCTAssertFalse(try adapter.bootstrapReadLeftSessionToStop(fact(["status": "indeterminate", "outcome": "unknown"])))
        XCTAssertFalse(try adapter.bootstrapReadLeftSessionToStop(fact(["status": "in_flight"])))
        XCTAssertFalse(try adapter.bootstrapReadLeftSessionToStop(fact(["status": "committed", "error_code": "APPLE_ENROLLMENT_X"])))
        // Audit APP-15: an open outcome is not "never ran"; only terminal answers release the pending bootstrap.
        XCTAssertEqual(try adapter.classifyBootstrapRead(fact(["status": "in_flight"])), .unresolved)
        XCTAssertEqual(try adapter.classifyBootstrapRead(fact(["status": "reconciling_v2"])), .unresolved)
        XCTAssertEqual(try adapter.classifyBootstrapRead(fact(["status": "missing"])), .nothingToStop)
        XCTAssertEqual(try adapter.classifyBootstrapRead(fact(["status": "failed", "outcome": "unknown"])), .nothingToStop)
        XCTAssertEqual(try adapter.classifyBootstrapRead(fact(["status": "indeterminate"])), .nothingToStop)
        XCTAssertEqual(try adapter.classifyBootstrapRead(fact(["status": "committed"])), .sessionToStop)
        XCTAssertThrowsError(try adapter.bootstrapReadLeftSessionToStop(
            JSONSerialization.data(withJSONObject: ["operation": "stop", "kind": "paios.public-operation.read.v1", "status": "missing"])))
    }

    override func tearDown() {
        RealtimeURLProtocolSpy.reset()
        super.tearDown()
    }

    func testDecodesExistingFixtureOperations() throws {
        let bootstrap = try adapter.decodeBootstrap(
            fixture("bootstrap-response.valid.json")
        )
        XCTAssertEqual(bootstrap.status, "bootstrap_accepted")
        XCTAssertEqual(
            bootstrap.livekit.serverURL,
            "wss://media.example.invalid"
        )

        let handoff = try adapter.decodeHandoff(fixture("handoff.valid.json"))
        XCTAssertEqual(
            handoff.operationOutcome.outcomeClass,
            "committed_success"
        )
        XCTAssertEqual(handoff.executionFacts.roomCleanup, "verified_absent")

        let stop = try adapter.decodeMediaStop(fixture("media-stop.valid.json"))
        XCTAssertEqual(stop.releaseScope, "media_device_lease_only")
    }

    func testRefreshE2EEAndEndContinuityAreTypedOnly() throws {
        let refresh = try adapter.decodeCredentialRefresh(credentialRefreshResponse(), expected: fixture("credential-refresh.valid.json"))
        XCTAssertEqual(refresh.status, "credential_refreshed")
        let e2ee = try RealtimePublicControlAdapter(e2eeNow: { Self.e2eeVectorNow })
            .decodeE2EEResolve(e2eeVectorResponse(), expected: e2eeVectorRequest())
        XCTAssertEqual(e2ee.status, "key_resolved")
        let ended = try adapter.decodeEndContinuity(endContinuityResponse(), expected: endContinuityRequest())
        XCTAssertEqual(ended.status, "success")
    }

    func testBootstrapCarriesReliableCallRecoveryWindowWithoutRequiringCallSupport() throws {
        var response = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-response.valid.json")) as? [String: Any])
        response["central_text_transport"] = ["schema": "paios.central.text-transport.v1", "execution_owner": "hermes_text",
            "expected_gateway_identity": "gateway", "input_topic": AssistantCentralTextWire.inputTopic,
            "output_topic": AssistantCentralTextWire.outputTopic, "max_packet_bytes": 12288, "call_rejoin_window_s": 1]
        let mapping = try adapter.mapBootstrap(JSONSerialization.data(withJSONObject: response))
        XCTAssertEqual(mapping.centralTransportBinding?.callRejoinWindowS, 1)
        var metadata = response["central_text_transport"] as! [String: Any]; metadata["call_rejoin_window_s"] = 0
        response["central_text_transport"] = metadata
        XCTAssertThrowsError(try adapter.mapBootstrap(JSONSerialization.data(withJSONObject: response)))
    }

    func testReconnectRefreshesTokenWithoutReplacingBindingAndRejectsForeignOrExpiredCredentials() async throws {
        let request = fixture("credential-refresh.valid.json")
        for fault in ["none", "foreign_epoch", "expired", "foreign_call", "bad_deadline"] {
            RealtimeURLProtocolSpy.reset()
            let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"), .credentialRefresh: request])
            var refreshed = try XCTUnwrap(JSONSerialization.jsonObject(with: request) as? [String: Any])
            refreshed["status"] = "credential_refreshed"
            refreshed["transport_credential"] = ["credential": "fresh-participant-token", "credential_generation": "2",
                "expires_at": fault == "expired" ? "2020-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"]
            if fault == "foreign_epoch" { refreshed["connection_epoch"] = "99" }
            refreshed["call_rejoin"] = ["call_id": fault == "foreign_call" ? "other-call" : "same-call",
                "rejoin_deadline": fault == "bad_deadline" ? "not-a-date" : "2099-01-01T00:00:00.000Z"]
            let refreshedData = try JSONSerialization.data(withJSONObject: refreshed)
            RealtimeURLProtocolSpy.handler = { [self] request in
                response(for: request, body: request.url?.path == "/v1/realtime/bootstrap"
                    ? fixture("bootstrap-response.valid.json") : refreshedData)
            }
            let intent = AssistantStartIntent(userInitiated: true)
            let existing = try await provider.bootstrap(for: intent)
            let before = await provider.localBindingSnapshot()
            do {
                let details = try await provider.reconnectDetails(existing, for: intent, callID: "same-call")
                XCTAssertNotNil(details.callRejoinDeadline)
                XCTAssertEqual(fault, "none")
                XCTAssertEqual(details.participantToken, "fresh-participant-token")
                XCTAssertNotEqual(details.participantToken, existing.participantToken)
                XCTAssertEqual(details.serverURL, existing.serverURL); XCTAssertEqual(details.roomName, existing.roomName)
                XCTAssertEqual(details.capabilities, existing.capabilities)
            } catch let error as AssistantCallRecoveryError {
                XCTAssertNotEqual(fault, "none"); XCTAssertEqual(error, .bindingRejected)
            }
            let after = await provider.localBindingSnapshot()
            XCTAssertEqual(after, before)
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.map(\.path), ["/v1/realtime/bootstrap", "/v1/realtime/credentials/refresh"])
        }
    }

    func testRestartBindingUnknownRejectsRefreshImmediatelyWithoutCallDeadline() async throws {
        RealtimeURLProtocolSpy.reset()
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"), .credentialRefresh: fixture("credential-refresh.valid.json")])
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path == "/v1/realtime/bootstrap" { return response(for: request, body: fixture("bootstrap-response.valid.json")) }
            return response(for: request, statusCode: 409, body: Data(#"{"error":"REALTIME_REFRESH_BINDING_UNKNOWN"}"#.utf8))
        }
        let intent = AssistantStartIntent(userInitiated: true), details = try await provider.bootstrap(for: intent)
        XCTAssertNil(details.callRejoinDeadline)
        do { _ = try await provider.reconnectDetails(details, for: intent, callID: "interrupted-call"); XCTFail("Restart-lost binding cannot enter a transport retry") }
        catch { XCTAssertEqual(error as? AssistantCallRecoveryError, .bindingMissing) }
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.map(\.path), ["/v1/realtime/bootstrap", "/v1/realtime/credentials/refresh"])
    }

    func testReconnectRejectsExplicitBindingFailuresButPreservesUnavailableResponses() async throws {
        for (status, code, terminal) in [(401, "AUTH_REJECTED", true), (403, "OWNER_REJECTED", true),
            (409, "REALTIME_REFRESH_BINDING_UNKNOWN", true), (503, "LEASE_REVOKED", true),
            (410, "expired", true), (410, "revoked", true),
            (409, "IDEMPOTENCY_CONFLICT", false), (503, "PUBLIC_CONTROL_UNAVAILABLE", false)] {
            RealtimeURLProtocolSpy.reset()
            let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"), .credentialRefresh: fixture("credential-refresh.valid.json")])
            RealtimeURLProtocolSpy.handler = { [self] request in
                if request.url?.path == "/v1/realtime/bootstrap" { return response(for: request, body: fixture("bootstrap-response.valid.json")) }
                let terminal: [String: Any] = ["operation": "connected_credential_refresh", "status": code]
                let body: [String: Any] = code == "expired" ? terminal : code == "revoked" ? ["terminal_result": terminal] : ["error": code]
                return response(for: request, statusCode: status, body: try JSONSerialization.data(withJSONObject: body))
            }
            let intent = AssistantStartIntent(userInitiated: true), existing = try await provider.bootstrap(for: intent)
            do { _ = try await provider.reconnectDetails(existing, for: intent); XCTFail("Refresh must surface the response") }
            catch {
                if terminal {
                    let gone = ["LEASE_REVOKED"].contains(code)
                    let expected: AssistantCallRecoveryError = code == "REALTIME_REFRESH_BINDING_UNKNOWN" ? .bindingMissing : gone ? .bindingGone(code) : .bindingRejected
                    XCTAssertEqual(error as? AssistantCallRecoveryError, expected)
                }
                else { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .unexpectedHTTPStatus(status, code)) }
            }
        }
    }

    func testSixExactPOSTSurfacesPreserveCanonicalBodiesAndHeaders()
        async throws {
        let bodies: [RealtimePublicControlOperation: Data] = [
            .bootstrap: fixture("bootstrap-request.valid.json"),
            .e2eeKeyResolve: e2eeVectorRequest(),
            .credentialRefresh: fixture("credential-refresh.valid.json"),
            .mediaStop: fixture("media-stop.valid.json"),
            .endContinuity: endContinuityRequest(),
            .handoff: handoffRequest()
        ]
        let credentials = RealtimeTestCredentialStore(
            tokens: ["api-token-123456"]
        )
        let provider = makeProvider(
            bodies: bodies,
            credentials: credentials,
            e2eeNow: { Self.e2eeVectorNow }
        )

        RealtimeURLProtocolSpy.handler = { [self] request in
            switch request.url?.path {
            case "/v1/realtime/bootstrap":
                return response(
                    for: request,
                    body: fixture("bootstrap-response.valid.json")
                )
            case "/v1/realtime/e2ee/key/resolve":
                return response(
                    for: request,
                    body: e2eeVectorResponse()
                )
            case "/v1/realtime/credentials/refresh":
                return response(
                    for: request,
                    body: credentialRefreshResponse()
                )
            case "/v1/realtime/media/stop":
                return response(
                    for: request,
                    body: stopResponse()
                )
            case "/v1/realtime/end-continuity":
                return response(
                    for: request,
                    body: endContinuityResponse()
                )
            case "/v1/realtime/handoff":
                return response(
                    for: request,
                    body: handoffTerminalResponse()
                )
            default:
                throw URLError(.unsupportedURL)
            }
        }

        let details = try await provider.bootstrap(
            for: AssistantStartIntent(
                operationID: AssistantOperationID(rawValue: "bootstrap-local"),
                userInitiated: true
            )
        )
        _ = try await provider.resolveE2EEKey(
            context: context(.e2eeKeyResolve)
        )
        _ = try await provider.refreshCredentials(
            context: context(.credentialRefresh)
        )
        let stop = try await provider.stop(
            AssistantStopContext(
                operationID: AssistantOperationID(rawValue: "stop-local"),
                roomName: details.roomName,
                reasonCode: "user_stop"
            )
        )
        _ = try await provider.endContinuity(
            context: context(.endContinuity)
        )
        _ = try await provider.handoff(context: context(.handoff))

        XCTAssertEqual(
            details.serverURL.absoluteString,
            "wss://media.example.invalid"
        )
        XCTAssertEqual(details.roomName, "room-opaque-fixture-1")
        XCTAssertEqual(
            details.participantToken,
            "<fixture-participant-token>"
        )
        XCTAssertTrue(details.capabilities.allows(.microphone))
        XCTAssertTrue(details.capabilities.allows(.camera))
        XCTAssertTrue(details.capabilities.canPublishData)
        XCTAssertTrue(stop.confirmed)

        let allowedPaths = RealtimePublicControlOperation.allCases.filter { $0 != .watchBinding }.map(\.path)
        let observations = RealtimeURLProtocolSpy.observations
        XCTAssertEqual(observations.map(\.path), allowedPaths)
        XCTAssertEqual(credentials.apiTokenCallCount, allowedPaths.count)

        let bodyByPath = Dictionary(
            uniqueKeysWithValues: bodies.map { ($0.key.path, $0.value) }
        )
        for observation in observations {
            XCTAssertEqual(
                observation.absoluteURL,
                ProductionRealtimePublicControlProvider.requiredOrigin
                    + observation.path
            )
            XCTAssertEqual(observation.method, "POST")
            XCTAssertNil(observation.query)
            XCTAssertFalse(observation.path.hasSuffix("/"))
            XCTAssertFalse(observation.path.contains("/rtc"))
            XCTAssertEqual(
                observation.contentType,
                "application/json; charset=utf-8"
            )
            XCTAssertEqual(
                observation.contentLength,
                String(bodyByPath[observation.path]!.count)
            )
            XCTAssertNil(observation.transferEncoding)
            XCTAssertNil(observation.idempotencyKey)
            XCTAssertEqual(observation.authorization, "Bearer api-token-123456")
            XCTAssertEqual(
                observation.body,
                bodyByPath[observation.path]
            )
        }
    }

    func testBootstrapMapsServerGrantsAndKeepsOnlyLocalBinding()
        async throws {
        let provider = makeProvider(
            bodies: [
                .bootstrap: fixture("bootstrap-request.valid.json")
            ]
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                body: fixture("bootstrap-response.valid.json")
            )
        }

        let details = try await provider.bootstrap(
            for: AssistantStartIntent(
                operationID: AssistantOperationID(rawValue: "mapping-local"),
                userInitiated: true
            )
        )
        let binding = await provider.localBindingSnapshot()

        XCTAssertEqual(details.roomName, "room-opaque-fixture-1")
        XCTAssertTrue(details.capabilities.allows(.microphone))
        XCTAssertTrue(details.capabilities.allows(.camera))
        XCTAssertTrue(details.capabilities.canPublishData)
        XCTAssertEqual(binding?.realtimeSessionRef.refType, "RealtimeSession")
        XCTAssertEqual(binding?.deviceLeaseRef.refType, "DeviceLease")
        XCTAssertEqual(
            binding?.continuityID,
            "018f0000-0000-7000-8000-000000000003"
        )
        XCTAssertEqual(binding?.connectionEpoch, "1")
        XCTAssertEqual(binding?.transportAliases.count, 2)
    }


    func testPendingBootstrapInvalidationRejectsLateBindingAndStopStaysLocal()
        async throws {
        let gate = RealtimeDelayedResponseGate()
        let provider = makeProvider(bodies: [
            .bootstrap: fixture("bootstrap-request.valid.json"),
            .mediaStop: fixture("media-stop.valid.json")
        ])
        RealtimeURLProtocolSpy.handler = { [self] request in
            gate.block()
            return response(
                for: request,
                body: fixture("bootstrap-response.valid.json")
            )
        }
        let pending = Task {
            try await provider.bootstrap(for: AssistantStartIntent(
                operationID: AssistantOperationID(
                    rawValue: "invalidate-pending"
                ),
                userInitiated: true
            ))
        }
        XCTAssertTrue(gate.waitUntilBlocked())
        await provider.invalidatePendingBootstrap()
        let before = RealtimeURLProtocolSpy.requestCount
        let stop = try await provider.stop(AssistantStopContext(
            operationID: AssistantOperationID(rawValue: "stop-pending"),
            roomName: "room-opaque-fixture-1",
            reasonCode: "user_stop"
        ))
        XCTAssertFalse(stop.confirmed)
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, before)
        gate.release()
        do {
            _ = try await pending.value
            XCTFail("Invalidated bootstrap must not complete")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .bootstrapSuperseded)
        }
        let binding = await provider.localBindingSnapshot()
        XCTAssertNil(binding)
    }

    func testCancelledBootstrapCannotInstallLateBinding() async throws {
        let gate = RealtimeDelayedResponseGate()
        let provider = makeProvider(
            bodies: [.bootstrap: fixture("bootstrap-request.valid.json")]
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            gate.block()
            return response(
                for: request,
                body: fixture("bootstrap-response.valid.json")
            )
        }
        let pending = Task {
            try await provider.bootstrap(for: AssistantStartIntent(
                operationID: AssistantOperationID(
                    rawValue: "cancel-pending"
                ),
                userInitiated: true
            ))
        }
        XCTAssertTrue(gate.waitUntilBlocked())
        pending.cancel()
        gate.release()
        do {
            _ = try await pending.value
            XCTFail("Cancelled bootstrap must not complete")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .bootstrapCancelled)
        }
        let binding = await provider.localBindingSnapshot()
        XCTAssertNil(binding)
    }

    func testReverseBootstrapCompletionBindsNewestAndStopUsesIt()
        async throws {
        let firstGate = RealtimeDelayedResponseGate()
        let secondGate = RealtimeDelayedResponseGate()
        let counter = RealtimeAtomicCounter()
        let recorder = RealtimeCanonicalContextRecorder()
        let firstResponse = bootstrapResponse(
            roomName: "room-generation-one",
            sessionID: "018f0000-0000-7000-8000-000000000101",
            leaseID: "018f0000-0000-7000-8000-000000000201",
            continuityID: "018f0000-0000-7000-8000-000000000301",
            connectionEpoch: "11"
        )
        let secondResponse = bootstrapResponse(
            roomName: "room-generation-two",
            sessionID: "018f0000-0000-7000-8000-000000000102",
            leaseID: "018f0000-0000-7000-8000-000000000202",
            continuityID: "018f0000-0000-7000-8000-000000000302",
            connectionEpoch: "12"
        )
        let newest = try adapter.mapBootstrap(secondResponse).localBinding
        let stopBody = mediaStopBody(
            binding: newest,
            requestID: "media_stop_generation_two"
        )
        let provider = makeProvider(
            bodies: [
                .bootstrap: fixture("bootstrap-request.valid.json"),
                .mediaStop: stopBody
            ],
            contextObserver: { context in
                await recorder.record(context)
            }
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            switch counter.next() {
            case 1:
                firstGate.block()
                return response(for: request, body: firstResponse)
            case 2:
                secondGate.block()
                return response(for: request, body: secondResponse)
            default:
                throw URLError(.badServerResponse)
            }
        }
        let first = Task {
            try await provider.bootstrap(for: AssistantStartIntent(
                operationID: AssistantOperationID(rawValue: "first"),
                userInitiated: true
            ))
        }
        XCTAssertTrue(firstGate.waitUntilBlocked())
        let second = Task {
            try await provider.bootstrap(for: AssistantStartIntent(
                operationID: AssistantOperationID(rawValue: "second"),
                userInitiated: true
            ))
        }
        XCTAssertTrue(secondGate.waitUntilBlocked())
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 2)
        secondGate.release()
        let details = try await second.value
        XCTAssertEqual(details.roomName, "room-generation-two")
        firstGate.release()
        do {
            _ = try await first.value
            XCTFail("Older bootstrap must be superseded")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .bootstrapSuperseded)
        }
        let newestSnapshot = await provider.localBindingSnapshot()
        XCTAssertEqual(newestSnapshot, newest)

        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                body: stopResponse(canonicalBody: stopBody)
            )
        }
        let stop = try await provider.stop(AssistantStopContext(
            operationID: AssistantOperationID(rawValue: "stop-newest"),
            roomName: "room-generation-two",
            reasonCode: "user_stop"
        ))
        let observed = await recorder.lastContext(for: .mediaStop)
        XCTAssertEqual(observed?.retainedBootstrapBinding, newest)
        XCTAssertTrue(stop.confirmed)
        let clearedSnapshot = await provider.localBindingSnapshot()
        XCTAssertNil(clearedSnapshot)
    }

    func testStopMismatchAndCrossSessionReplayDoNotClearBinding()
        async throws {
        let provider = makeProvider(bodies: [
            .bootstrap: fixture("bootstrap-request.valid.json"),
            .mediaStop: fixture("media-stop.valid.json")
        ])
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                body: fixture("bootstrap-response.valid.json")
            )
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(
            operationID: AssistantOperationID(rawValue: "correlation"),
            userInitiated: true
        ))
        let expected = await provider.localBindingSnapshot()

        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                body: stopResponse(responseRequestID: "replayed_request")
            )
        }
        let mismatch = try await provider.stop(AssistantStopContext(
            operationID: AssistantOperationID(rawValue: "mismatch"),
            roomName: "room-opaque-fixture-1",
            reasonCode: "user_stop"
        ))
        XCTAssertFalse(mismatch.confirmed)
        let postStopSnapshot = await provider.localBindingSnapshot()
        XCTAssertEqual(postStopSnapshot, expected)

        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                body: stopResponse(
                    responseSessionID:
                        "018f0000-0000-7000-8000-000000000999"
                )
            )
        }
        let replay = try await provider.stop(AssistantStopContext(
            operationID: AssistantOperationID(rawValue: "cross-session"),
            roomName: "room-opaque-fixture-1",
            reasonCode: "user_stop"
        ))
        XCTAssertFalse(replay.confirmed)
        let postReplaySnapshot = await provider.localBindingSnapshot()
        XCTAssertEqual(postReplaySnapshot, expected)
    }

    func testMissingBodyContextAndOversizeFailBeforeURLSession()
        async throws {
        let noBodyProvider = makeProvider(bodies: [:])

        do {
            _ = try await noBodyProvider.bootstrap(
                for: AssistantStartIntent(
                    operationID: AssistantOperationID(rawValue: "no-body"),
                    userInitiated: true
                )
            )
            XCTFail("Expected missing canonical body")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingCanonicalBody)
        }

        let validBodyProvider = makeProvider(
            bodies: [
                .credentialRefresh: Data(#"{"canonical":true}"#.utf8)
            ]
        )
        do {
            _ = try await validBodyProvider.refreshCredentials(
                context: RealtimeCanonicalRequestContext(
                    operation: .credentialRefresh,
                    localBinding: ""
                )
            )
            XCTFail("Expected missing canonical context")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingCanonicalContext)
        }

        let tooSmallProvider = makeProvider(
            bodies: [.credentialRefresh: Data([0x7b])]
        )
        do {
            _ = try await tooSmallProvider.refreshCredentials(
                context: context(.credentialRefresh)
            )
            XCTFail("Expected undersized canonical body rejection")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingCanonicalBody)
        }

        let oversized = Data(
            repeating: 0x61,
            count:
                ProductionRealtimePublicControlProvider
                    .maximumCanonicalBodyBytes + 1
        )
        let oversizedProvider = makeProvider(
            bodies: [.credentialRefresh: oversized]
        )
        do {
            _ = try await oversizedProvider.refreshCredentials(
                context: context(.credentialRefresh)
            )
            XCTFail("Expected oversized canonical body rejection")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .canonicalBodyTooLarge)
        }

        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 0)
    }


    func testExactPunycodeOriginReachesURLProtocolOnMacOS()
        async throws {
        let provider = makeProvider(
            bodies: [
                .endContinuity: endContinuityRequest()
            ]
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, body: endContinuityResponse())
        }

        _ = try await provider.endContinuity(
            context: context(.endContinuity)
        )

        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)
        let observed = RealtimeURLProtocolSpy.observations.first
        XCTAssertEqual(
            observed?.absoluteURL,
            ProductionRealtimePublicControlProvider.requiredOrigin
                + RealtimePublicControlOperation.endContinuity.path
        )
        XCTAssertEqual(
            URL(
                string:
                    ProductionRealtimePublicControlProvider.requiredOrigin
            )?.host,
            "gateway.example.invalid"
        )
    }

    func testConfiguredOriginReachesControlRequestOnlyWithMatchingInstalledPairing() async throws {
        let origin = "https://api.example:9443"
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData { $0["origin"] = origin })
        let credentials = RealtimeDelegatingCredentialStore(
            wrapped: PairedRealtimeCredentialStore(store: store, identity: RealtimeTestCredentialStore(tokens: []))
        )
        let bodies: [RealtimePublicControlOperation: Data] = [.endContinuity: endContinuityRequest()]
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: endContinuityResponse()) }
        _ = try await makeProvider(bodies: bodies, credentials: credentials, endpoint: origin)
            .endContinuity(context: context(.endContinuity))
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.first?.absoluteURL, origin + RealtimePublicControlOperation.endContinuity.path)
        RealtimeURLProtocolSpy.reset()
        do {
            _ = try await makeProvider(bodies: bodies, credentials: credentials, endpoint: "https://other.example:9443")
                .endContinuity(context: context(.endContinuity))
            XCTFail("Pairing bearer must stay bound to its installed origin")
        } catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .invalidPublicOrigin) }
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 0)
    }

    func testInvalidOriginsAndMissingCredentialFailBeforeURLSession()
        async throws {
        let body = Data(#"{"canonical":true}"#.utf8)
        let invalidEndpoints = [
            "http://api.example:9443",
            "https://api.example:0",
            "https://api.example:65536",
            ProductionRealtimePublicControlProvider.requiredOrigin + "/rtc",
            ProductionRealtimePublicControlProvider.requiredOrigin + "?probe=1",
            "https://user@legacy.example.invalid",
            ProductionRealtimePublicControlProvider.requiredOrigin + "#fragment"
        ]

        for endpoint in invalidEndpoints {
            let provider = makeProvider(
                bodies: [.credentialRefresh: body],
                endpoint: endpoint
            )
            do {
                _ = try await provider.refreshCredentials(
                    context: context(.credentialRefresh)
                )
                XCTFail("Expected exact-origin rejection for \(endpoint)")
            } catch let error as RealtimePublicControlAdapterError {
                XCTAssertEqual(error, .invalidPublicOrigin)
            }
        }

        let missingCredential = makeProvider(
            bodies: [.credentialRefresh: body],
            credentials: RealtimeTestCredentialStore(tokens: [])
        )
        do {
            _ = try await missingCredential.refreshCredentials(
                context: context(.credentialRefresh)
            )
            XCTFail("Expected missing credential rejection")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingBearerCredential)
        }

        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 0)
    }

    func testBearerPacketBoundsAndForbiddenCharactersFailBeforeNetwork()
        async throws {
        let invalidTokens = [
            String(repeating: "a", count: 15),
            String(repeating: "b", count: 8_193),
            "valid token-123456",
            "valid-token-\u{0001}-123456",
            "valid-token,123456"
        ]

        for token in invalidTokens {
            let provider = makeProvider(
                bodies: [
                    .credentialRefresh: fixture(
                        "credential-refresh.valid.json"
                    )
                ],
                credentials: RealtimeTestCredentialStore(tokens: [token])
            )
            do {
                _ = try await provider.refreshCredentials(
                    context: context(.credentialRefresh)
                )
                XCTFail("Expected invalid bearer packet")
            } catch let error as RealtimePublicControlAdapterError {
                XCTAssertEqual(error, .invalidBearerCredential)
            }
        }

        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 0)
    }

    func testCredentialIsResolvedAgainAndNotCachedByProvider()
        async throws {
        let credentials = RealtimeTestCredentialStore(
            tokens: ["token:one!1234567", "token:two#1234567"]
        )
        let provider = makeProvider(
            bodies: [
                .endContinuity: endContinuityRequest()
            ],
            credentials: credentials
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, body: endContinuityResponse())
        }

        _ = try await provider.endContinuity(
            context: RealtimeCanonicalRequestContext(
                operation: .endContinuity,
                localBinding: "first-local"
            )
        )
        _ = try await provider.endContinuity(
            context: RealtimeCanonicalRequestContext(
                operation: .endContinuity,
                localBinding: "second-local"
            )
        )

        XCTAssertEqual(credentials.apiTokenCallCount, 2)
        XCTAssertEqual(
            RealtimeURLProtocolSpy.observations.map(\.authorization),
            ["Bearer token:one!1234567", "Bearer token:two#1234567"]
        )
    }

    func testStopBeforeBootstrapIsUnconfirmedWithoutNetwork()
        async throws {
        let credentials = RealtimeTestCredentialStore(
            tokens: ["api-token-123456"]
        )
        let provider = makeProvider(
            bodies: [.mediaStop: fixture("media-stop.valid.json")],
            credentials: credentials
        )
        RealtimeURLProtocolSpy.handler = { _ in
            XCTFail("Stop before bootstrap must not reach URLSession")
            throw URLError(.badURL)
        }

        let result = try await provider.stop(
            AssistantStopContext(
                operationID: AssistantOperationID(rawValue: "stop-before"),
                roomName: "room-opaque-fixture-1",
                reasonCode: "user_stop"
            )
        )

        XCTAssertFalse(result.confirmed)
        XCTAssertNil(result.opaqueReference)
        XCTAssertEqual(credentials.apiTokenCallCount, 0)
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 0)
    }

    func testStopBodyProviderReceivesExactRetainedBootstrapBinding()
        async throws {
        let recorder = RealtimeCanonicalContextRecorder()
        let provider = makeProvider(
            bodies: [
                .bootstrap: fixture("bootstrap-request.valid.json"),
                .mediaStop: fixture("media-stop.valid.json")
            ],
            contextObserver: { context in
                await recorder.record(context)
            }
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            switch request.url?.path {
            case "/v1/realtime/bootstrap":
                return response(
                    for: request,
                    body: fixture("bootstrap-response.valid.json")
                )
            case "/v1/realtime/media/stop":
                return response(for: request, body: stopResponse())
            default:
                throw URLError(.unsupportedURL)
            }
        }

        _ = try await provider.bootstrap(
            for: AssistantStartIntent(
                operationID: AssistantOperationID(rawValue: "bind-bootstrap"),
                userInitiated: true
            )
        )
        let result = try await provider.stop(
            AssistantStopContext(
                operationID: AssistantOperationID(rawValue: "bind-stop"),
                roomName: "room-opaque-fixture-1",
                reasonCode: "user_stop"
            )
        )

        let observed = await recorder.lastContext(for: .mediaStop)
        let expected = try adapter.mapBootstrap(
            fixture("bootstrap-response.valid.json")
        ).localBinding
        XCTAssertEqual(observed?.retainedBootstrapBinding, expected)
        XCTAssertTrue(result.confirmed)
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 2)
    }

    func testStopTransportFailureIsUnconfirmedAndNeverRetried()
        async throws {
        let provider = makeProvider(
            bodies: [
                .bootstrap: fixture("bootstrap-request.valid.json"),
                .mediaStop: fixture("media-stop.valid.json")
            ]
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                body: fixture("bootstrap-response.valid.json")
            )
        }
        _ = try await provider.bootstrap(
            for: AssistantStartIntent(
                operationID: AssistantOperationID(rawValue: "stop-bootstrap"),
                userInitiated: true
            )
        )

        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { _ in
            throw URLError(.cannotConnectToHost)
        }
        let result = try await provider.stop(
            AssistantStopContext(
                operationID: AssistantOperationID(rawValue: "stop-once"),
                roomName: "room-opaque-fixture-1",
                reasonCode: "user_stop"
            )
        )

        XCTAssertFalse(result.confirmed)
        XCTAssertNil(result.opaqueReference)
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)
    }

    func testUnknownStopRetryReusesExactBody() async throws {
        let body = fixture("media-stop.valid.json")
        let provider = makeProvider(bodies: [
            .bootstrap: fixture("bootstrap-request.valid.json"), .mediaStop: body
        ])
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, body: fixture("bootstrap-response.valid.json"))
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let context = AssistantStopContext(operationID: AssistantOperationID(rawValue: "original-stop"),
            roomName: "room-opaque-fixture-1", reasonCode: "user_stop")
        RealtimeURLProtocolSpy.handler = { _ in throw URLError(.networkConnectionLost) }
        let unknown = try await provider.stop(context)
        XCTAssertFalse(unknown.confirmed)
        RealtimeURLProtocolSpy.handler = { [self] request in
            return response(for: request, body: stopResponse())
        }
        let retried = try await provider.stop(context)
        XCTAssertTrue(retried.confirmed)
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.filter {
            $0.path == "/v1/realtime/media/stop"
        }.map(\.body), [body, body])
        let remaining = await provider.localBindingSnapshot()
        XCTAssertNil(remaining)
    }

    func testRelaunchReplaysPersistedStopWithoutReserializingItsFingerprint() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/stop-replay-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let scope = Data("fixture-scope".utf8)
        let body = fixture("media-stop.valid.json")
        let seed = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"), .mediaStop: body],
            pendingStopDatabase: database, replayScope: scope)
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: fixture("bootstrap-response.valid.json")) }
        _ = try await seed.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let context = AssistantStopContext(operationID: AssistantOperationID(rawValue: "saved-stop"),
            roomName: "room-opaque-fixture-1", reasonCode: "app_background")
        RealtimeURLProtocolSpy.handler = { _ in throw URLError(.networkConnectionLost) }
        _ = try await seed.stop(context)
        let original = try XCTUnwrap(database.pendingStopReplay())
        // A valid earlier writer's JSON need not have the current encoder's byte representation.
        let object = try JSONSerialization.jsonObject(with: original.payload)
        let payload = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        let fingerprint = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        let writer = try DatabaseQueue(path: database.databaseURL.path)
        try await writer.write { db in
            try db.execute(sql: "UPDATE local_operations SET replay_payload = ?, fingerprint = ? WHERE operation_id = ?",
                arguments: [payload, fingerprint, context.operationID.rawValue])
        }
        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: stopResponse()) }
        let restored = makeProvider(bodies: [:], pendingStopDatabase: database, replayScope: scope)
        let result = try await restored.stop(context)
        XCTAssertTrue(result.confirmed)
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.map(\.body), [body])
        XCTAssertNil(try database.pendingStopReplay())
    }

    func testConfirmedInitialStartSupersedesUnknownStopOnlyAfterAcceptance() async throws {
        for confirmedStart in [false, true] {
            let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .appendingPathComponent(".build/stop-start-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
            let scope = Data("fixture-scope".utf8)
            let bodies: [RealtimePublicControlOperation: Data] = [.bootstrap: fixture("bootstrap-request.valid.json"), .mediaStop: fixture("media-stop.valid.json")]
            let seed = makeProvider(bodies: bodies, pendingStopDatabase: database, replayScope: scope)
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: fixture("bootstrap-response.valid.json")) }
            _ = try await seed.bootstrap(for: AssistantStartIntent(userInitiated: true))
            let old = AssistantStopContext(operationID: AssistantOperationID(rawValue: "stale-stop"),
                roomName: "room-opaque-fixture-1", reasonCode: "app_background")
            RealtimeURLProtocolSpy.handler = { _ in throw URLError(.networkConnectionLost) }
            _ = try await seed.stop(old)
            let replacement = makeProvider(bodies: bodies, pendingStopDatabase: database, replayScope: scope)
            RealtimeURLProtocolSpy.reset()
            RealtimeURLProtocolSpy.handler = { [self] request in
                XCTAssertNotNil(try database.pendingStopReplay(), "Unknown Stop remains until server acceptance")
                XCTAssertEqual(try database.operation(operationID: old.operationID.rawValue)?.state, .stopUnknown)
                if !confirmedStart { throw URLError(.networkConnectionLost) }
                return response(for: request, body: fixture("bootstrap-response.valid.json"))
            }
            if !confirmedStart {
                do { _ = try await replacement.bootstrap(for: AssistantStartIntent(userInitiated: true)); XCTFail("Expected lost response") }
                catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .transportFailure) }
                XCTAssertNotNil(try database.pendingStopReplay())
                XCTAssertEqual(try database.operation(operationID: old.operationID.rawValue)?.state, .stopUnknown)
                continue
            }
            _ = try await replacement.bootstrap(for: AssistantStartIntent(userInitiated: true))
            XCTAssertNil(try database.pendingStopReplay())
            XCTAssertEqual(try database.operation(operationID: old.operationID.rawValue)?.lastError, "superseded_by_start")
            let count = RealtimeURLProtocolSpy.observations.count
            let stale = try await replacement.stop(old)
            XCTAssertFalse(stale.confirmed)
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.count, count, "Old Stop cannot send after replacement")
        }
    }

    func testDurableStopRejectsRowIdentityAndContextCorruptionWithValidFingerprint() async throws {
        for corruption in ["row-id", "oversized-room", "empty-reason"] {
            RealtimeURLProtocolSpy.reset()
            let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(".build/stop-durability-tests")
                .appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
            let scope = Data("fixture-scope".utf8)
            let seed = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"),
                .mediaStop: fixture("media-stop.valid.json")], pendingStopDatabase: database, replayScope: scope)
            RealtimeURLProtocolSpy.handler = { [self] request in
                response(for: request, body: fixture("bootstrap-response.valid.json"))
            }
            _ = try await seed.bootstrap(for: AssistantStartIntent(userInitiated: true))
            let original = AssistantStopContext(operationID: AssistantOperationID(rawValue: "original-stop"),
                roomName: "room-opaque-fixture-1", reasonCode: "user_stop")
            RealtimeURLProtocolSpy.handler = { _ in throw URLError(.networkConnectionLost) }
            let unknown = try await seed.stop(original)
            XCTAssertFalse(unknown.confirmed)
            let replay = try XCTUnwrap(database.pendingStopReplay())
            var payload = replay.payload
            if corruption != "row-id" {
                var object = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
                var context = try XCTUnwrap(object["context"] as? [String: Any])
                if corruption == "oversized-room" { context["roomName"] = String(repeating: "r", count: 257) }
                else { context["reasonCode"] = "" }
                object["context"] = context
                payload = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
            }
            let fingerprint = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
            let writer = try DatabaseQueue(path: database.databaseURL.path)
            try await writer.write { db in
                try db.execute(sql: "UPDATE local_operations SET operation_id = ?, replay_payload = ?, fingerprint = ? WHERE operation_id = ? AND kind = 'stop' AND state = 'stop_unknown'",
                    arguments: [corruption == "row-id" ? "wrong-stop" : replay.operationID, payload, fingerprint, replay.operationID])
            }
            RealtimeURLProtocolSpy.reset()
            let restored = makeProvider(bodies: [:], pendingStopDatabase: database, replayScope: scope)
            do { _ = try await restored.restorePendingStop(); XCTFail("Reject " + corruption) }
            catch { XCTAssertEqual(error as? AssistantLocalOperationDatabaseError, .corruptRow) }
            do { _ = try await restored.stop(original); XCTFail("Corrupt pending cannot send") }
            catch { }
            XCTAssertTrue(RealtimeURLProtocolSpy.observations.isEmpty)
            XCTAssertEqual(try database.pending().count, 1)
            XCTAssertNotNil(try database.pendingStopReplay(), "Structurally intact payload remains unresolved")
        }
    }

    func testCentralBootstrapMetadataIsClosedOptionalAndSourceDeviceBound() async throws {
        let metadata: [String: Any] = ["schema": "paios.central.text-transport.v1", "execution_owner": "hermes_text",
            "expected_gateway_identity": "controlled-gateway", "input_topic": AssistantCentralTextWire.inputTopic,
            "output_topic": AssistantCentralTextWire.outputTopic, "max_packet_bytes": 12_288]
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-response.valid.json")) as? [String: Any])
        XCTAssertNil(try adapter.mapBootstrap(fixture("bootstrap-response.valid.json")).centralTransportBinding)
        object["central_text_transport"] = metadata
        let responseBytes = try JSONSerialization.data(withJSONObject: object)
        let mapped = try adapter.mapBootstrap(responseBytes)
        let binding = try XCTUnwrap(mapped.centralTransportBinding)
        XCTAssertEqual(binding.sessionID, mapped.localBinding.continuityID)
        XCTAssertEqual(binding.deviceID, mapped.localBinding.e2eeKeyEnvelope.scope.deviceID)
        XCTAssertEqual(binding.connectionEpoch, mapped.localBinding.connectionEpoch)
        XCTAssertEqual(binding.expectedGatewayIdentity, "controlled-gateway")
        for (key, value) in [("execution_owner", "legacy" as Any), ("schema", "other" as Any),
            ("input_topic", "wrong" as Any), ("output_topic", "wrong" as Any), ("expected_gateway_identity", "" as Any),
            ("max_packet_bytes", true as Any), ("max_packet_bytes", 12_289 as Any), ("extra", "forged" as Any)] {
            var invalid = metadata
            invalid[key] = value
            object["central_text_transport"] = invalid
            XCTAssertThrowsError(try adapter.mapBootstrap(JSONSerialization.data(withJSONObject: object)), key)
        }
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")])
        let fresh = try await provider.centralTransportBinding()
        XCTAssertNil(fresh, "No persisted receipt/header may invent gateway identity before fresh bootstrap")
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: responseBytes) }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let validated = try await provider.centralTransportBinding()
        XCTAssertEqual(validated, binding)
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.count, 1, "Binding getter acquires no HTTP/SDK transport")
        for deviceClass in ["iphone", "mac", "glasses"] {
            let store = RealtimeTestPairingStore()
            try store.replacePairingData(pairingData { object in
                object["device_id"] = binding.deviceID
                if deviceClass != "iphone" {
                    object["device_type"] = deviceClass
                    object["capabilities"] = deviceClass == "mac" ? ["display", "chat_ui", "desktop_tools"] : ["display"]
                }
            })
            let typed = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store))
            _ = try await typed.bootstrap(for: AssistantStartIntent(userInitiated: true))
            let qualified = try await typed.centralTransportBinding()
            XCTAssertEqual(qualified?.deviceClass, deviceClass)
        }
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: fixture("bootstrap-response.valid.json")) }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let legacy = try await provider.centralTransportBinding()
        XCTAssertNil(legacy, "Fresh legacy bootstrap clears optional candidate metadata")

        var wrongBody = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-request.valid.json")) as? [String: Any])
        wrongBody["device_id"] = "other-device"
        let mismatch = makeProvider(bodies: [.bootstrap: try JSONSerialization.data(withJSONObject: wrongBody)])
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: responseBytes) }
        _ = try await mismatch.bootstrap(for: AssistantStartIntent(userInitiated: true))
        do { _ = try await mismatch.centralTransportBinding(); XCTFail("Enrollment request device and local E2EE scope must agree") }
        catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .staleBinding) }
    }

    func testLegacyAndCorruptDurableStopCannotRestoreOrSend() async throws {
        for corruption in ["legacy", "fingerprint", "invalid-json"] {
            let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(".build/stop-durability-tests")
                .appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
            if corruption == "legacy" {
                _ = try database.markStopUnknown(operationID: "legacy-stop", fingerprint: String(repeating: "a", count: 64))
            } else {
                try database.preserveStopReplay(operationID: "corrupt-stop", payload: Data("invalid-json".utf8))
                if corruption == "fingerprint" {
                    let writer = try DatabaseQueue(path: database.databaseURL.path)
                    try await writer.write { db in
                        try db.execute(sql: "UPDATE local_operations SET fingerprint = ?", arguments: [String(repeating: "b", count: 64)])
                    }
                }
            }
            let provider = makeProvider(bodies: [:], pendingStopDatabase: database,
                replayScope: Data("fixture-scope".utf8))
            do { _ = try await provider.restorePendingStop(); XCTFail("Must reject " + corruption) }
            catch { XCTAssertTrue(error is AssistantLocalOperationDatabaseError || error is DecodingError) }
            do { _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true)); XCTFail("Must block bootstrap") }
            catch { }
            let context = AssistantStopContext(operationID: AssistantOperationID(rawValue: "corrupt-stop"),
                roomName: "room-opaque-fixture-1", reasonCode: "user_stop")
            do { _ = try await provider.stop(context); XCTFail("Unreadable pending must block send") }
            catch { }
            XCTAssertTrue(RealtimeURLProtocolSpy.observations.isEmpty)
            XCTAssertEqual(try database.pending().count, 1)
        }
    }

    #if os(macOS)
    func testStopDurabilityAcrossIndependentProcesses() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let stage = env["PAIOS_STOP_TEST_STAGE"], let path = env["PAIOS_STOP_TEST_DB"] else {
            let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(".build/stop-durability-tests")
                .appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            for stage in ["seed", "replay", "cleared"] {
                let worker = Process()
                worker.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
                worker.arguments = ["-XCTest", "HealthKitExporterTests.RealtimePublicControlAdapterTests/testStopDurabilityAcrossIndependentProcesses", Bundle(for: Self.self).bundlePath]
                worker.environment = env.merging(["PAIOS_STOP_TEST_STAGE": stage,
                    "PAIOS_STOP_TEST_DB": root.appendingPathComponent("pending.sqlite").path]) { _, value in value }
                let log = root.appendingPathComponent(stage + ".log")
                FileManager.default.createFile(atPath: log.path, contents: nil)
                let output = try FileHandle(forWritingTo: log)
                worker.standardOutput = output
                worker.standardError = output
                try worker.run()
                worker.waitUntilExit()
                try output.close()
                let diagnostics = try String(contentsOf: log, encoding: .utf8)
                XCTAssertEqual(worker.terminationStatus, 0, diagnostics)
                XCTAssertTrue(diagnostics.contains("PAIOS_STOP_DURABILITY_STAGE=" + stage), diagnostics)
            }
            return
        }
        print("PAIOS_STOP_DURABILITY_STAGE=" + stage)
        let database = try AssistantLocalOperationDatabase(path: path)
        let scope = Data("fixture-principal-device-config".utf8)
        let body = fixture("media-stop.valid.json")
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"), .mediaStop: body],
            pendingStopDatabase: database, replayScope: scope)
        let original = AssistantStopContext(operationID: AssistantOperationID(rawValue: "durable-original"),
            roomName: "room-opaque-fixture-1", reasonCode: "user_stop")
        if stage == "seed" {
            RealtimeURLProtocolSpy.handler = { [self] request in
                response(for: request, body: fixture("bootstrap-response.valid.json"))
            }
            _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
            RealtimeURLProtocolSpy.handler = { _ in
                XCTAssertNotNil(try database.pendingStopReplay(), "Must commit before sending")
                throw URLError(.networkConnectionLost)
            }
            let result = try await provider.stop(original)
            XCTAssertFalse(result.confirmed)
            XCTAssertEqual(try database.pending().count, 1)
        } else if stage == "replay" {
            let restored = try await provider.restorePendingStop()
            XCTAssertEqual(restored?.operationID, original.operationID)
            XCTAssertEqual(restored?.reasonCode, original.reasonCode)
            XCTAssertEqual(restored?.roomName, original.roomName)
            XCTAssertTrue(RealtimeURLProtocolSpy.observations.isEmpty, "Restore cannot send")
            let missingScope = makeProvider(bodies: [:], pendingStopDatabase: database)
            let missingScopeResult = try await missingScope.stop(original)
            XCTAssertFalse(missingScopeResult.confirmed)
            XCTAssertTrue(RealtimeURLProtocolSpy.observations.isEmpty, "Missing scope must not send")
            XCTAssertNotNil(try database.pendingStopReplay())
            let changed = makeProvider(bodies: [:], pendingStopDatabase: database, replayScope: Data("other-account".utf8))
            let denied = try await changed.stop(original)
            XCTAssertFalse(denied.confirmed)
            XCTAssertTrue(RealtimeURLProtocolSpy.observations.isEmpty, "Changed enrollment must not send")
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: Data("{}".utf8)) }
            let unknown = try await provider.stop(original)
            XCTAssertFalse(unknown.confirmed)
            XCTAssertNotNil(try database.pendingStopReplay())
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: stopResponse()) }
            let result = try await provider.stop(original)
            XCTAssertTrue(result.confirmed)
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.map(\.body), [body, body])
            XCTAssertNil(try database.pendingStopReplay())
        } else {
            let restored = try await provider.restorePendingStop()
            XCTAssertNil(restored)
            XCTAssertEqual(try database.operation(operationID: original.operationID.rawValue)?.state, .completed)
        }
    }

    #endif

    func testMalformedAndNon2xxResponsesFailClosed() async throws {
        let malformedProvider = makeProvider(
            bodies: [
                .bootstrap: fixture("bootstrap-request.valid.json")
            ]
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                body: Data(#"{"operation":"bootstrap"}"#.utf8)
            )
        }

        do {
            _ = try await malformedProvider.bootstrap(
                for: AssistantStartIntent(
                    operationID: AssistantOperationID(rawValue: "malformed"),
                    userInitiated: true
                )
            )
            XCTFail("Expected malformed response rejection")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .malformedFixture)
        }

        RealtimeURLProtocolSpy.reset()
        let non2xxProvider = makeProvider(
            bodies: [
                .credentialRefresh: fixture(
                    "credential-refresh.valid.json"
                )
            ]
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                statusCode: 503,
                body: fixture("credential-refresh.valid.json")
            )
        }

        do {
            _ = try await non2xxProvider.refreshCredentials(
                context: context(.credentialRefresh)
            )
            XCTFail("Expected non-2xx response rejection")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .unexpectedHTTPStatus(503, nil))
        }
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)

        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(
                for: request,
                statusCode: 201,
                body: fixture("credential-refresh.valid.json")
            )
        }
        do {
            _ = try await non2xxProvider.refreshCredentials(
                context: context(.credentialRefresh)
            )
            XCTFail("Expected HTTP 201 rejection")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .unexpectedHTTPStatus(201, nil))
        }
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)
    }

    func testHTTPErrorCodeIsSanitizedAndNeverRetried() async throws {
        let provider = makeProvider(
            bodies: [
                .credentialRefresh: fixture(
                    "credential-refresh.valid.json"
                )
            ]
        )
        let cases: [
            (status: Int, body: Data, code: String?, rawContent: String)
        ] = [
            (
                403,
                Data(#"{"error":"T03_BINDING_MISMATCH"}"#.utf8),
                "T03_BINDING_MISMATCH",
                "T03_BINDING_MISMATCH"
            ),
            (
                400,
                Data("not-json-SECRET_MALFORMED".utf8),
                nil,
                "SECRET_MALFORMED"
            ),
            (
                422,
                Data(
                    #"{"error":"T03_BINDING_MISMATCH","extra":"SECRET_EXTRA_KEY"}"#.utf8
                ),
                nil,
                "SECRET_EXTRA_KEY"
            ),
            (
                500,
                Data(#"{"error":"invalid-code-SECRET_INVALID"}"#.utf8),
                nil,
                "invalid-code-SECRET_INVALID"
            )
        ]

        for testCase in cases {
            RealtimeURLProtocolSpy.reset()
            RealtimeURLProtocolSpy.handler = { [self] request in
                response(
                    for: request,
                    statusCode: testCase.status,
                    body: testCase.body
                )
            }

            let output = try await captureStandardOutput {
                do {
                    _ = try await provider.refreshCredentials(
                        context: context(.credentialRefresh)
                    )
                    XCTFail("Expected HTTP error rejection")
                } catch let error as RealtimePublicControlAdapterError {
                    XCTAssertEqual(
                        error,
                        .unexpectedHTTPStatus(testCase.status, testCase.code)
                    )
                }
            }

            XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)
#if DEBUG
            XCTAssertEqual(
                output,
                "PAIOS_PUBLIC_CONTROL_HTTP_ERROR "
                    + "status=\(testCase.status) "
                    + "code=\(testCase.code ?? "UNKNOWN")\n"
            )
#else
            XCTAssertEqual(output, "")
#endif
            if testCase.code == nil {
                XCTAssertFalse(output.contains(testCase.rawContent))
            }
        }
    }

    func testStopConfirmationRequiresCommittedSuccessAndFullTuple()
        throws {
        let expected = try adapter.decodeStopExpectation(
            fixture("media-stop.valid.json")
        )
        XCTAssertTrue(try adapter.decodeStopConfirmation(
            stopResponse(),
            expected: expected
        ).confirmed)
        var omittedCleanup = try XCTUnwrap(JSONSerialization.jsonObject(with: stopResponse()) as? [String: Any])
        var facts = omittedCleanup["execution_facts"] as! [String: Any]
        facts.removeValue(forKey: "participant_cleanup")
        omittedCleanup["execution_facts"] = facts
        for data in [
            try JSONSerialization.data(withJSONObject: omittedCleanup),
            stopResponse(status: "indeterminate"),
            stopResponse(outcomeClass: "indeterminate"),
            stopResponse(closureStatus: "unknown"),
            stopResponse(deviceLeaseRelease: "unknown"),
            stopResponse(participantCleanup: "unknown"),
            stopResponse(trackCleanup: "unknown"),
            stopResponse(roomCleanup: "unknown")
        ] {
            XCTAssertFalse(try adapter.decodeStopConfirmation(
                data,
                expected: expected
            ).confirmed)
        }
    }

    func testMissingCanonicalBodyNeverFallsBackToBundledFixture()
        async throws {
        let provider = makeProvider(bodies: [:])
        RealtimeURLProtocolSpy.handler = { _ in
            XCTFail("URLSession must not be reached")
            throw URLError(.badURL)
        }

        do {
            _ = try await provider.bootstrap(
                for: AssistantStartIntent(
                    operationID: AssistantOperationID(
                        rawValue: "no-fixture-fallback"
                    ),
                    userInitiated: true
                )
            )
            XCTFail("Expected fail-closed missing body")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingCanonicalBody)
        }

        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 0)
    }

    func testE2EERecipientRegistrationAndBoundContentKeyOpen()
        async throws {
        let keyStore = RealtimeTestE2EERecipientKeyStore(
            rawRepresentation: e2eeVectorPrivateKey()
        )
        let requestBody = e2eeVectorRequest()
        let provider = makeProvider(
            bodies: [
                .bootstrap: fixture("bootstrap-request.valid.json"),
                .e2eeKeyResolve: requestBody
            ],
            e2eeNow: { Self.e2eeVectorNow },
            recipientKeyStore: keyStore
        )
        RealtimeURLProtocolSpy.handler = { [self] request in
            switch request.url?.path {
            case "/v1/realtime/bootstrap":
                return response(
                    for: request,
                    body: fixture("bootstrap-response.valid.json")
                )
            case "/v1/realtime/e2ee/key/resolve":
                return response(for: request, body: e2eeVectorResponse())
            default:
                throw URLError(.unsupportedURL)
            }
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(
            operationID: AssistantOperationID(rawValue: "e2ee-bootstrap"),
            userInitiated: true
        ))
        let retainedBindingSnapshot = await provider.localBindingSnapshot()
        let retainedBinding = try XCTUnwrap(retainedBindingSnapshot)
        let context = RealtimeCanonicalRequestContext(
            operation: .e2eeKeyResolve,
            localBinding: "e2ee-vector",
            retainedBootstrapBinding: retainedBinding
        )

        let registration = try await provider.recipientRegistration(
            for: e2eeVectorRegistrationContext()
        )
        XCTAssertEqual(registration.algorithm, "X25519")
        XCTAssertEqual(registration.purpose, "hpke_recipient")
        XCTAssertEqual(registration.publicKeyRaw.count, 32)
        XCTAssertEqual(
            registration.publicKey,
            "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8"
        )
        XCTAssertEqual(
            registration.publicKeySha256,
            e2eeSHA256Hex(registration.publicKeyRaw)
        )

        var opened = try await provider.resolveE2EEContentKey(
            context: context
        )
        XCTAssertEqual(opened, e2eeVectorContentKey())
        opened.resetBytes(in: 0..<opened.count)
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 2)
    }

    func testE2EERegistrationExportRepeatsPublicMaterialOnly()
        throws {
        let keyStore = RealtimeTestE2EERecipientKeyStore(
            rawRepresentation: e2eeVectorPrivateKey()
        )
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("e2ee-export-\(UUID().uuidString)")
        let destination = root.appendingPathComponent("registration.json")
        defer {
            try? FileManager.default.removeItem(at: root)
        }

        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try RealtimeE2EERegistrationRuntime.exportRegistration(
            to: destination,
            keyStore: keyStore,
            now: now
        )
        let first = try Data(contentsOf: destination)
        try RealtimeE2EERegistrationRuntime.exportRegistration(
            to: destination,
            keyStore: keyStore,
            now: now
        )
        let second = try Data(contentsOf: destination)
        XCTAssertNotEqual(first, Data())
        XCTAssertEqual(first, second)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: first) as? [String: Any]
        )
        XCTAssertEqual(
            Set(object.keys),
            [
                "schema", "public_raw32_base64url", "public_sha256",
                "local_slot_ref_hash", "created_at"
            ]
        )
        XCTAssertEqual(
            object["public_raw32_base64url"] as? String,
            "j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8"
        )
        XCTAssertNil(object["private_key"])
        XCTAssertNil(object["device_id"])
        XCTAssertNil(object["bearer"])
    }

    func testE2EEKeychainPersistsAcrossInstancesAndConcurrentCallers()
        async throws {
        let service = "ai.paios.test.e2ee.\(UUID().uuidString)"
        defer { deleteE2EEKeychainItem(service: service) }

        let first = try KeychainE2EERecipientKeyStore(service: service)
            .loadOrCreateRecipientPrivateKey()
        let firstPublic = first.publicKey.rawRepresentation
        let second = try KeychainE2EERecipientKeyStore(service: service)
            .loadOrCreateRecipientPrivateKey()
        XCTAssertEqual(second.publicKey.rawRepresentation, firstPublic)

        let results = try await withThrowingTaskGroup(of: Data.self) { group in
            for _ in 0..<8 {
                group.addTask {
                    let key = try KeychainE2EERecipientKeyStore(
                        service: service
                    ).loadOrCreateRecipientPrivateKey()
                    return key.publicKey.rawRepresentation
                }
            }
            var values: [Data] = []
            while let value = try await group.next() {
                values.append(value)
            }
            return values
        }

        XCTAssertEqual(results.count, 8)
        XCTAssertEqual(Set(results), [firstPublic])
    }

    func testE2EEKeychainCorruptItemFailsClosedWithoutRotation() throws {
        let service = "ai.paios.test.e2ee.corrupt.\(UUID().uuidString)"
        defer { deleteE2EEKeychainItem(service: service) }
        let corrupt = Data(repeating: 0xA5, count: 31)
        var item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.account,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String:
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: corrupt
        ]
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        item.removeValue(forKey: kSecValueData as String)

        XCTAssertThrowsError(
            try KeychainE2EERecipientKeyStore(service: service)
                .loadOrCreateRecipientPrivateKey()
        ) { error in
            XCTAssertEqual(
                error as? E2EERecipientKeyStoreError,
                .storedKeyInvalid
            )
        }

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.account,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true
        ]
        var result: CFTypeRef?
        XCTAssertEqual(
            SecItemCopyMatching(query as CFDictionary, &result),
            errSecSuccess
        )
        XCTAssertEqual(result as? Data, corrupt)
        query.removeValue(forKey: kSecReturnData as String)
    }

    func testE2EEKeychainLegacyZeroizedItemMigratesOnceAndPersists()
        throws {
        let service = "ai.paios.test.e2ee.zeroized.\(UUID().uuidString)"
        defer { deleteE2EEKeychainItem(service: service) }
        let zeroized = Data(repeating: 0, count: 32)
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.account,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String:
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: zeroized
        ]
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)

        let first = try KeychainE2EERecipientKeyStore(service: service)
            .loadOrCreateRecipientPrivateKey()
        XCTAssertNotEqual(first.rawRepresentation, zeroized)
        let second = try KeychainE2EERecipientKeyStore(service: service)
            .loadOrCreateRecipientPrivateKey()
        XCTAssertEqual(second.rawRepresentation, first.rawRepresentation)

        let markerQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.zeroizedMigrationMarkerAccount,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true
        ]
        var markerResult: CFTypeRef?
        XCTAssertEqual(
            SecItemCopyMatching(markerQuery as CFDictionary, &markerResult),
            errSecSuccess
        )
        XCTAssertEqual(markerResult as? Data, Data([1]))
    }

    func testE2EEKeychainZeroizedMigrationMarkerBlocksSecondMigration()
        throws {
        let service = "ai.paios.test.e2ee.zeroized-marker.\(UUID().uuidString)"
        defer { deleteE2EEKeychainItem(service: service) }
        let zeroized = Data(repeating: 0, count: 32)
        let keyItem: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.account,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String:
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: zeroized
        ]
        XCTAssertEqual(SecItemAdd(keyItem as CFDictionary, nil), errSecSuccess)
        let markerItem: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.zeroizedMigrationMarkerAccount,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String:
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: Data([1])
        ]
        XCTAssertEqual(
            SecItemAdd(markerItem as CFDictionary, nil),
            errSecSuccess
        )

        XCTAssertThrowsError(
            try KeychainE2EERecipientKeyStore(service: service)
                .loadOrCreateRecipientPrivateKey()
        ) { error in
            // iOS keeps the items' accessibility class, so the marker refuses the second migration (storedKeyInvalid).
            // The macOS file keychain that hosts these tests does not return it, so the marker check refuses first
            // (storedKeyNotThisDeviceOnly). Both fail closed; the reads below prove no replacement key was written.
            let code = error as? E2EERecipientKeyStoreError
            XCTAssertTrue(code == .storedKeyInvalid || code == .storedKeyNotThisDeviceOnly, String(describing: code))
        }

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.account,
            kSecAttrSynchronizable as String: false,
            kSecReturnData as String: true
        ]
        var result: CFTypeRef?
        XCTAssertEqual(
            SecItemCopyMatching(query as CFDictionary, &result),
            errSecSuccess
        )
        XCTAssertEqual(result as? Data, zeroized)
        query.removeValue(forKey: kSecReturnData as String)
    }

    func testE2EEKeychainDuplicateItemIsReadWithoutRotation() throws {
        let service = "ai.paios.test.e2ee.duplicate.\(UUID().uuidString)"
        defer { deleteE2EEKeychainItem(service: service) }
        let raw = e2eeVectorPrivateKey()
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String:
                KeychainE2EERecipientKeyStore.account,
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String:
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: raw
        ]
        XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        XCTAssertEqual(
            SecItemAdd(item as CFDictionary, nil),
            errSecDuplicateItem
        )

        let key = try KeychainE2EERecipientKeyStore(service: service)
            .loadOrCreateRecipientPrivateKey()
        XCTAssertEqual(key.rawRepresentation, raw)
    }

    func testGlassesEnrollmentUsesPairedBearerAndPreservesQRJSON() async throws {
        let pairing = try RealtimeDevicePairing.decode(pairingData())
        for announced in [pairing.origin, RealtimeAPIOriginMigration.canonicalOrigin] {
        let body = try JSONSerialization.data(withJSONObject: [
            "schema": "paios.glasses-enrollment.v1", "origin": announced,
            "token": String(repeating: "a", count: 43),
            "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(299))
        ])
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RealtimeURLProtocolSpy.self]
        RealtimeURLProtocolSpy.handler = { [self] request in
            XCTAssertEqual(request.url?.absoluteString, pairing.origin + "/v1/devices/glasses/enrollment")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + pairing.token)
            return response(for: request, body: body)
        }
        let result = try await ProductionRealtimePublicControlProvider.glassesEnrollment(
            pairing: pairing, session: URLSession(configuration: config))
        XCTAssertEqual(result.qrData, body)
        // URLSession hands URLProtocol the body as a stream; the spy's observation reads it back.
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.last?.body, Data("{}".utf8))
        XCTAssertEqual(pairing.origin, RealtimeAPIOriginMigration.legacyOrigin, "QR announcement alone cannot migrate the phone")
        }
    }

    func testGlassesEnrollmentRejectsInvalidOrExpiredQR() throws {
        let now = Date(timeIntervalSince1970: 1_791_000_000)
        let origin = "https://api.example"
        let valid = ["schema": "paios.glasses-enrollment.v1", "origin": origin,
                     "token": String(repeating: "a", count: 43),
                     "expires_at": ISO8601DateFormatter().string(from: now.addingTimeInterval(300))]
        let data = try JSONSerialization.data(withJSONObject: valid)
        XCTAssertEqual(try RealtimeGlassesEnrollment.decode(data, origin: origin, now: now).qrData, data)
        for (key, value) in [("schema", "unknown"), ("origin", "https://other.example"),
                             ("token", "short"), ("extra", "field"),
                             ("expires_at", ISO8601DateFormatter().string(from: now)),
                             ("expires_at", "invalid-date")] {
            var object = valid; object[key] = value
            XCTAssertThrowsError(try RealtimeGlassesEnrollment.decode(
                JSONSerialization.data(withJSONObject: object), origin: origin, now: now))
        }
    }

    func testDevicePairingPathResolvesUnderApplicationSupport() throws {
        let base = try XCTUnwrap(RealtimeDevicePairingRuntime.applicationSupportURL())
        XCTAssertEqual(
            base.appendingPathComponent(RealtimeDevicePairingRuntime.pairingRelativePath),
            base.appendingPathComponent("PersonalAIOS/E2EE/device-pairing.v1.json")
        )
    }

    func testDevicePairingImportStoresExactBytesSupersedesReplaysAndDeletesInput() async throws {
        let store = RealtimeTestPairingStore()
        let (root, input) = try pairingInput(pairingData(), permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        try database.preserveStopReplay(operationID: "original-stop", payload: Data("stop".utf8))

        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: input, store: store,
            database: database), .imported)
        XCTAssertFalse(FileManager.default.fileExists(atPath: input.path))
        XCTAssertEqual(store.data, try pairingData())
        XCTAssertEqual(store.replaceCallCount, 1)
        XCTAssertNil(try database.pendingStopReplay())

        let provider = PairedRealtimeRequestBodyProvider(store: store, now: { Date(timeIntervalSince1970: 1_791_000_000) },
            makeID: { _ in "01a11111-0000-7000-8000-00000000aaaa" })
        XCTAssertTrue(provider.isReady)
        let bootstrapBody = try await provider.canonicalBody(for: .bootstrap, context: context(.bootstrap))
        let body = try XCTUnwrap(bootstrapBody)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["operation"] as? String, "bootstrap")
        XCTAssertEqual(object["bootstrap_mode"] as? String, "initial")
        XCTAssertEqual(object["request_id"] as? String, "01a11111-0000-7000-8000-00000000aaaa")
        XCTAssertEqual(object["device_id"] as? String, Self.pairedDeviceID)
        XCTAssertEqual(object["requested_media"] as? [String: Bool], ["audio": true, "video": false, "data": true])
        let start = try XCTUnwrap(object["start"] as? [String: Any])
        XCTAssertEqual(start["modalities"] as? [String], ["audio", "data"])
        XCTAssertEqual(start["started_at"] as? String, "2026-10-03T04:00:00.000Z")
        XCTAssertEqual((object["governance"] as? [String: Any])?["policy_decision_refs"] as? [String],
            ["01a11111-0000-7000-8000-000000000004"])
        try assertIdempotencyContext(object, kind: "realtime_bootstrap", targetType: "RealtimeSession", targetID: nil)
        XCTAssertEqual(try provider.replayScope()?.count, 32)
        let handoffBody = try await provider.canonicalBody(for: .handoff, context: context(.handoff))
        XCTAssertNil(handoffBody)
    }

    func testSessionPairingIdentitySurvivesLockedKeychainAndRejectsReplacedOwner() throws {
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let provider = PairedRealtimeRequestBodyProvider(store: store)
        let pairing = try XCTUnwrap(provider.pairing()), owner = CentralOwnerDataIdentity.pairing(pairing)
        let snapshot = RealtimePairingSessionIdentity.shared
        store.loadError = .unavailable
        XCTAssertThrowsError(try provider.pairing())
        XCTAssertTrue(snapshot.matches(owner), "Locking must preserve the admitted care notification/reply identity")

        snapshot.invalidate()
        XCTAssertFalse(snapshot.matches(owner), "An explicit re-pair must fence the old session")
        store.loadError = nil
        try store.replacePairingData(pairingData { $0["paired_at"] = "2026-10-12T16:00:00.000Z" })
        _ = try provider.pairing()
        XCTAssertFalse(snapshot.matches(owner))
    }

    func testIdenticalPairingImportKeepsOriginalStopReplay() throws {
        let store = RealtimeTestPairingStore(), original = try pairingData()
        try store.replacePairingData(original)
        let owner = CentralOwnerDataIdentity.pairing(try XCTUnwrap(PairedRealtimeRequestBodyProvider(store: store).pairing()))
        let canonical = try JSONSerialization.jsonObject(with: original)
        let (root, input) = try pairingInput(JSONSerialization.data(withJSONObject: canonical, options: .prettyPrinted), permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let stop = Data("original-stop".utf8)
        try database.preserveStopReplay(operationID: "original-stop", payload: stop)

        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: input, store: store,
            database: database), .imported)
        XCTAssertEqual(try database.pendingStopReplay()?.payload, stop)
        XCTAssertEqual(store.data, original)
        XCTAssertTrue(RealtimePairingSessionIdentity.shared.matches(owner))
        XCTAssertFalse(FileManager.default.fileExists(atPath: input.path))
    }

    func testFailedPairingWriteKeepsOriginalStopReplay() throws {
        let store = RealtimeTestPairingStore(), original = try pairingData()
        try store.replacePairingData(original)
        store.replaceError = .unavailable
        let (root, input) = try pairingInput(pairingData { $0["paired_at"] = "2026-10-12T16:00:00.000Z" }, permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let stop = Data("original-stop".utf8)
        try database.preserveStopReplay(operationID: "original-stop", payload: stop)

        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: input, store: store,
            database: database), .rejected)
        XCTAssertEqual(try database.pendingStopReplay()?.payload, stop)
        XCTAssertEqual(store.data, original)
        XCTAssertTrue(FileManager.default.fileExists(atPath: input.path))
    }

    func testPairingImportRecoversKeychainInstallationAfterSQLiteCommitFailure() throws {
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let replacement = try pairingData { $0["paired_at"] = "2026-10-12T16:00:00.000Z" }
        let (root, input) = try pairingInput(replacement, permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("pending.sqlite"), database = try AssistantLocalOperationDatabase(url: url)
        let stop = Data("original-stop".utf8)
        try database.preserveStopReplay(operationID: "original-stop", payload: stop)
        let fault = try DatabaseQueue(path: url.path)
        try fault.write { db in
            try db.execute(sql: """
                CREATE TABLE pairing_parent (id INTEGER PRIMARY KEY);
                CREATE TABLE pairing_commit_fault (id INTEGER REFERENCES pairing_parent(id) DEFERRABLE INITIALLY DEFERRED);
                CREATE TRIGGER fail_pairing_commit AFTER UPDATE OF state ON local_operations
                WHEN NEW.operation_id = 'pairing-replacement' AND NEW.state = 'completed'
                BEGIN INSERT INTO pairing_commit_fault VALUES (1); END;
                """)
        }
        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: input, store: store, database: database), .rejected)
        XCTAssertEqual(store.data, replacement, "Keychain committed before SQLite rejected COMMIT")
        XCTAssertEqual(try database.pendingStopReplay()?.payload, stop)
        XCTAssertTrue(FileManager.default.fileExists(atPath: input.path))

        try fault.write { db in try db.execute(sql: "DROP TRIGGER fail_pairing_commit") }
        let reopened = try AssistantLocalOperationDatabase(url: url)
        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: input, store: store, database: reopened), .imported)
        XCTAssertNil(try reopened.pendingStopReplay())
        XCTAssertEqual(store.data, replacement)
        XCTAssertFalse(FileManager.default.fileExists(atPath: input.path))
    }

    func testUpgradeLoadsMigratedPairingWithoutUsingNewBuildEndpoints() async throws {
        // Persisted migration routes follow the packaged endpoint configuration.
        let previousOrigin = RealtimeAPIOriginMigration.legacyOrigin
        let pairedOrigin = RealtimeAPIOriginMigration.canonicalOrigin
        for successes in [1, 2] {
            RealtimeURLProtocolSpy.reset()
            let saved = try pairingData {
                $0["origin"] = pairedOrigin
                $0["anchor_origin"] = previousOrigin
                $0["fallback_origin"] = previousOrigin
                $0["canonical_successes"] = successes
            }
            let store = RealtimeTestPairingStore()
            try store.replacePairingData(saved)
            let bodyProvider = PairedRealtimeRequestBodyProvider(store: store)
            XCTAssertTrue(bodyProvider.isReady, "An upgrade keeps the installed pairing")
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [RealtimeURLProtocolSpy.self]
            let provider = ProductionRealtimePublicControlProvider(
                settingsStore: RealtimeTestSettingsStore(settings: AppSettings(endpoint: previousOrigin)),
                credentialStore: PairedRealtimeCredentialStore(store: store),
                canonicalBodyProvider: bodyProvider,
                session: URLSession(configuration: configuration))
            RealtimeURLProtocolSpy.handler = { [self] request in
                response(for: request, body: fixture("bootstrap-response.valid.json"))
            }
            _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
            let request = try XCTUnwrap(RealtimeURLProtocolSpy.observations.first)
            XCTAssertEqual(request.absoluteURL, pairedOrigin + RealtimePublicControlOperation.bootstrap.path)
            XCTAssertEqual(request.authorization, "Bearer " + (try RealtimeDevicePairing.decode(saved)).token)
            XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)
            var expectedPairing = try RealtimeDevicePairing.decode(saved)
            expectedPairing.canonicalSuccesses = 2
            XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.data)), expectedPairing,
                "Authenticated bootstrap confirms the route without changing the installed pairing")
            if successes == 2 { XCTAssertEqual(store.data, saved, "An already confirmed route is not rewritten") }
        }
    }

    func testUpgradeRejectsIncompleteOrInvalidPersistedMigrationRoutes() throws {
        let mutations: [(inout [String: Any]) -> Void] = [
            { $0["anchor_origin"] = "http://previous-release.example" },
            { $0["fallback_origin"] = "https://unrelated.example" },
            { $0.removeValue(forKey: "anchor_origin") },
            { $0["canonical_successes"] = 0 },
            { $0["canonical_successes"] = 3 }
        ]
        for mutate in mutations {
            XCTAssertThrowsError(try RealtimeDevicePairing.decode(pairingData {
                $0["origin"] = "https://paired-release.example:9443"
                $0["anchor_origin"] = "https://previous-release.example"
                $0["fallback_origin"] = "https://previous-release.example"
                $0["canonical_successes"] = 2
                mutate(&$0)
            }))
        }
    }

    func testOriginMigrationKeepsHealthIdentityAndOriginalArtifactCannotUndoIt() throws {
        let original = try pairingData()
        let pairing = try RealtimeDevicePairing.decode(original)
        let migrated = try RealtimeAPIOriginMigration.migrated(pairing)
        XCTAssertEqual(CentralOwnerDataIdentity.pairing(pairing), CentralOwnerDataIdentity.pairing(migrated))
        XCTAssertEqual(migrated.token, pairing.token)
        XCTAssertEqual(migrated.originalOrigin, pairing.origin)
        XCTAssertEqual(migrated.fallbackOrigin, pairing.origin)
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(JSONEncoder().encode(migrated))
        let (root, _) = try pairingInput(original, permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("operations.sqlite"))
        try database.replacePairing(data: original, store: store)
        XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.data)), migrated)
        XCTAssertThrowsError(try RealtimeDevicePairing.decode(pairingData {
            $0["anchor_origin"] = "https://unrelated.co.uk"; $0["fallback_origin"] = $0["origin"]
        }))
    }

    func testOriginMigrationProvesCommittedBindingThenNeverFallsBackToRetiredEdge() async throws {
        for failureStatus in [0, 502] {
            RealtimeURLProtocolSpy.reset()
            let store = RealtimeTestPairingStore()
            try store.replacePairingData(pairingData())
            let credentials = PairedRealtimeCredentialStore(store: store)
            let body = fixture("bootstrap-request.valid.json")
            let accepted = try originMigrationResponse(proof: false)
            let proof = try originMigrationResponse(proof: true)
            RealtimeURLProtocolSpy.handler = { [self] request in
                response(for: request, body: request.url!.path.hasSuffix("/reconcile") ? proof :
                    request.url!.path.hasSuffix("/stop") ? stopResponse() : accepted)
            }
            let clock = RealtimeOriginTestClock()
            let discovered = originProbeFinished(clock)
            let initial = makeProvider(bodies: [.bootstrap: body, .mediaStop: fixture("media-stop.valid.json")], credentials: credentials, originProbeNow: clock.now)
            _ = try await initial.bootstrap(for: AssistantStartIntent(userInitiated: true))
            await fulfillment(of: [discovered], timeout: 2)
            var saved = try RealtimeDevicePairing.decode(XCTUnwrap(store.data))
            XCTAssertEqual(saved.origin, RealtimeAPIOriginMigration.canonicalOrigin)
            XCTAssertEqual(saved.canonicalSuccesses, 1)
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.count, 2)
            XCTAssertTrue(RealtimeURLProtocolSpy.observations.allSatisfy { $0.body == body })
            let stopped = try await initial.stop(AssistantStopContext(operationID: AssistantOperationID(rawValue: "cm2b-stop"),
                roomName: "room-opaque-fixture-1", reasonCode: "user_stop"))
            XCTAssertTrue(stopped.confirmed)
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.last?.absoluteURL,
                RealtimeAPIOriginMigration.canonicalOrigin + RealtimePublicControlOperation.mediaStop.path,
                "A fresh Stop uses the proven current origin; only already durable replays retain their origin")
            // A new provider starts from Keychain, even with the old settings endpoint.
            RealtimeURLProtocolSpy.reset()
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: accepted) }
            _ = try await makeProvider(bodies: [.bootstrap: body], credentials: credentials)
                .bootstrap(for: AssistantStartIntent(userInitiated: true))
            saved = try RealtimeDevicePairing.decode(XCTUnwrap(store.data))
            XCTAssertEqual(saved.canonicalSuccesses, 2)
            XCTAssertEqual(saved.fallbackOrigin, RealtimeAPIOriginMigration.legacyOrigin)
            RealtimeURLProtocolSpy.reset()
            RealtimeURLProtocolSpy.handler = { [self] request in
                if request.url!.host == "gateway.example.invalid" {
                    if failureStatus == 0 { throw URLError(.cannotConnectToHost) }
                    return response(for: request, statusCode: failureStatus, body: Data("{}".utf8))
                }
                return response(for: request, body: accepted)
            }
            do {
                _ = try await makeProvider(bodies: [.bootstrap: body], credentials: credentials)
                    .bootstrap(for: AssistantStartIntent(userInitiated: true))
                XCTFail("The retired edge must never recover a primary-origin failure")
            } catch { XCTAssertNotNil(error as? RealtimePublicControlAdapterError) }
            saved = try RealtimeDevicePairing.decode(XCTUnwrap(store.data))
            XCTAssertEqual(saved.origin, RealtimeAPIOriginMigration.canonicalOrigin)
            XCTAssertEqual(saved.originalOrigin, RealtimeAPIOriginMigration.legacyOrigin)
            XCTAssertEqual(saved.canonicalSuccesses, 2)
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.count, 1)
            XCTAssertTrue(RealtimeURLProtocolSpy.observations.allSatisfy {
                $0.body == body && $0.absoluteURL.hasPrefix(RealtimeAPIOriginMigration.canonicalOrigin + "/")
            })
        }
    }

    func testOriginMigrationRejectsRedirectAuthFailureWrongBindingAndPersistenceFailure() async throws {
        let accepted = try originMigrationResponse(proof: false)
        for status in [302, 401, 200, -1] {
            RealtimeURLProtocolSpy.reset()
            let store = RealtimeTestPairingStore(), original = try pairingData()
            try store.replacePairingData(original)
            if status == -1 { store.replaceError = .unavailable }
            let credentials = PairedRealtimeCredentialStore(store: store)
            var proof = try XCTUnwrap(JSONSerialization.jsonObject(with: originMigrationResponse(proof: true)) as? [String: Any])
            if status == 200 { proof["continuity_id"] = "018f0000-0000-7000-8000-000000000099" }
            let bytes = try JSONSerialization.data(withJSONObject: proof)
            RealtimeURLProtocolSpy.handler = { [self] request in
                response(for: request, statusCode: request.url!.path.hasSuffix("/reconcile") ? max(200, status) : 200,
                         body: request.url!.path.hasSuffix("/reconcile") ? bytes : accepted)
            }
            let clock = RealtimeOriginTestClock()
            let finished = originProbeFinished(clock)
            let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: credentials, originProbeNow: clock.now)
            _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
            await fulfillment(of: [finished], timeout: 2)
            XCTAssertEqual(store.data, original, "Failed optional discovery preserves the working pairing bytes")
        }
        RealtimeURLProtocolSpy.reset()
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(JSONEncoder().encode(RealtimeAPIOriginMigration.migrated(RealtimeDevicePairing.decode(pairingData()))))
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, statusCode: 401, body: Data("{}".utf8)) }
        do {
            _ = try await makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store))
                .bootstrap(for: AssistantStartIntent(userInitiated: true))
            XCTFail("Revocation must fail")
        } catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .unexpectedHTTPStatus(401, nil)) }
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.count, 1, "Auth denial must never forward the token to fallback")
        XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.data)).origin, RealtimeAPIOriginMigration.canonicalOrigin)
    }

    func testOriginMigrationCannotOverwriteConcurrentRepairingDuringProof() async throws {
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let replacement = try pairingData { $0["paired_at"] = "2026-10-14T16:00:00.000Z" }
        let accepted = try originMigrationResponse(proof: false), proof = try originMigrationResponse(proof: true)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path.hasSuffix("/reconcile") {
                try store.replacePairingData(replacement)
                return response(for: request, body: proof)
            }
            return response(for: request, body: accepted)
        }
        let clock = RealtimeOriginTestClock()
        let finished = originProbeFinished(clock)
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store), originProbeNow: clock.now)
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(store.data, replacement, "Proof must compare-and-swap the exact pairing bytes read before awaiting")
    }

    func testOriginMigrationOnlyAllowsExactOwnedOrigins() async throws {
        for origin in ["https://bj.attacker.co.uk:9443", "https://gateway.example.invalid:9443/", "https://user@gateway.example.invalid:9443", "https://gateway.example.invalid:9443?x=1"] {
            RealtimeURLProtocolSpy.reset()
            let store = RealtimeTestPairingStore(), original = try pairingData()
            try store.replacePairingData(original)
            var accepted = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-response.valid.json")) as? [String: Any])
            accepted["canonical_api_origin"] = origin
            let bytes = try JSONSerialization.data(withJSONObject: accepted)
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: bytes) }
            _ = try await makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store))
                .bootstrap(for: AssistantStartIntent(userInitiated: true))
            XCTAssertEqual(store.data, original)
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.count, 1)
        }
    }

    func testOriginRecoveryRetainsProvenPairAcrossPrimaryGatewayOutagesAndConfigRollback() async throws {
        let store = RealtimeTestPairingStore()
        let original = try RealtimeDevicePairing.decode(pairingData())
        try store.replacePairingData(JSONEncoder().encode(RealtimeAPIOriginMigration.migrated(original)))
        let body = fixture("bootstrap-request.valid.json")
        let rollback = try originMigrationResponse(proof: false, canonical: RealtimeAPIOriginMigration.legacyOrigin)
        for _ in 0..<2 {
            RealtimeURLProtocolSpy.reset()
            RealtimeURLProtocolSpy.handler = { _ in throw URLError(.cannotConnectToHost) }
            let restarted = makeProvider(bodies: [.bootstrap: body], credentials: PairedRealtimeCredentialStore(store: store))
            do {
                _ = try await restarted.bootstrap(for: AssistantStartIntent(userInitiated: true))
                XCTFail("Primary-origin outage must surface")
            } catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .transportFailure) }
            let saved = try RealtimeDevicePairing.decode(XCTUnwrap(store.data))
            XCTAssertEqual(saved.origin, RealtimeAPIOriginMigration.canonicalOrigin)
            XCTAssertEqual(CentralOwnerDataIdentity.pairing(saved), CentralOwnerDataIdentity.pairing(original))
            XCTAssertEqual(RealtimeURLProtocolSpy.observations.map(\.absoluteURL),
                [RealtimeAPIOriginMigration.canonicalOrigin + RealtimePublicControlOperation.bootstrap.path])
        }
        // A rollback announcement does not force a healthy, accepted BJ route back to AI.
        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: rollback) }
        let healthy = makeProvider(bodies: [.bootstrap: body], credentials: PairedRealtimeCredentialStore(store: store))
        _ = try await healthy.bootstrap(for: AssistantStartIntent(userInitiated: true))
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1)
        XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.data)).origin, RealtimeAPIOriginMigration.canonicalOrigin)
    }

    func testOriginRecoveryBothFailuresPreservePairAndBoundEveryRetryAcrossRestart() async throws {
        for initial in [RealtimeAPIOriginMigration.legacyOrigin, RealtimeAPIOriginMigration.canonicalOrigin] {
            for status in [0, 502] {
                RealtimeURLProtocolSpy.reset()
                let store = RealtimeTestPairingStore()
                var pairing = try RealtimeAPIOriginMigration.migrated(RealtimeDevicePairing.decode(pairingData()))
                pairing.origin = initial
                let before = try JSONEncoder().encode(pairing)
                try store.replacePairingData(before)
                let body = fixture("bootstrap-request.valid.json")
                RealtimeURLProtocolSpy.handler = { [self] request in
                    if status == 0 { throw URLError(.timedOut) }
                    return response(for: request, statusCode: status, body: Data("{}".utf8))
                }
                let failed = makeProvider(bodies: [.bootstrap: body], credentials: PairedRealtimeCredentialStore(store: store), bootstrapRecoveryWindow: .seconds(2))
                do { _ = try await failed.bootstrap(for: AssistantStartIntent(userInitiated: true)); XCTFail("Both routes failed") }
                catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, status == 0 ? .transportFailure : .unexpectedHTTPStatus(status, nil)) }
                if initial == RealtimeAPIOriginMigration.legacyOrigin {
                    XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 2, "One primary-origin alternate exhausts the alternate budget")
                } else {
                    XCTAssertTrue((1...5).contains(RealtimeURLProtocolSpy.requestCount), "Existing connection-loss retry remains bounded by two seconds")
                    XCTAssertTrue(RealtimeURLProtocolSpy.observations.allSatisfy {
                        $0.absoluteURL.hasPrefix(RealtimeAPIOriginMigration.canonicalOrigin + "/")
                    })
                }
                XCTAssertEqual(store.data, before)
                XCTAssertTrue(RealtimeURLProtocolSpy.observations.allSatisfy { $0.body == body && $0.authorization == "Bearer " + pairing.token })
                RealtimeURLProtocolSpy.reset()
                let accepted = try originMigrationResponse(proof: false)
                RealtimeURLProtocolSpy.handler = { [self] request in
                    if request.url!.host != "gateway.example.invalid" { throw URLError(.cannotConnectToHost) }
                    return response(for: request, body: accepted)
                }
                let restarted = makeProvider(bodies: [.bootstrap: body], credentials: PairedRealtimeCredentialStore(store: store))
                _ = try await restarted.bootstrap(for: AssistantStartIntent(userInitiated: true))
                XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.data)).origin, RealtimeAPIOriginMigration.canonicalOrigin)
                XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, initial == RealtimeAPIOriginMigration.legacyOrigin ? 2 : 1)
            }
        }
    }

    func testReview3ExpiredE2EEReplayCannotPersistAlternateRoute() async throws {
        let reply = e2eeVectorResponse()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: reply) as? [String: Any])
        let expiry = try XCTUnwrap(RealtimeControlValidation.parseTimestamp("2026-08-23T12:00:00.000Z"))
        XCTAssertLessThan(expiry, Date())
        XCTAssertEqual(object["expires_at"] as? String, "2026-08-23T12:00:00.000Z")
        for initial in [RealtimeAPIOriginMigration.legacyOrigin, RealtimeAPIOriginMigration.canonicalOrigin] {
            try await assertDeferredRoute(.e2eeKeyResolve, request: e2eeVectorRequest(), reply: reply,
                accepted: false, initialOrigin: initial) // Real default clock; original AAD/ciphertext unchanged.
        }
    }

    func testE2EEFutureFrozenVectorPersistsAlternateRouteWithExplicitClock() async throws {
        for initial in [RealtimeAPIOriginMigration.legacyOrigin, RealtimeAPIOriginMigration.canonicalOrigin] {
            try await assertDeferredRoute(.e2eeKeyResolve, request: e2eeVectorRequest(), reply: e2eeVectorResponse(),
                accepted: true, initialOrigin: initial, e2eeNow: { Self.e2eeVectorNow })
        }
    }

    func testE2EEExpiryBoundaryAndMalformedTimestampRejectProjectionAndKeyOpen() throws {
        let request = e2eeVectorRequest(), response = e2eeVectorResponse()
        let expiry = try XCTUnwrap(RealtimeControlValidation.parseTimestamp("2026-08-23T12:00:00.000Z"))
        let manager = RealtimeE2EERecipientKeyManager(store:
            RealtimeTestE2EERecipientKeyStore(rawRepresentation: e2eeVectorPrivateKey()))
        for now in [expiry, expiry.addingTimeInterval(1)] {
            XCTAssertThrowsError(try RealtimePublicControlAdapter(e2eeNow: { now }).decodeE2EEResolve(response, expected: request)) {
                XCTAssertEqual($0 as? RealtimePublicControlAdapterError, .e2eeOpenFailed)
            }
            XCTAssertThrowsError(try manager.open(responseData: response, requestData: request, now: now)) {
                XCTAssertEqual($0 as? RealtimePublicControlAdapterError, .e2eeOpenFailed)
            }
        }
        for invalid in ["not-a-date", "2026-08-23T12:00:00.000Z "] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: response) as? [String: Any])
            object["expires_at"] = invalid
            let malformed = try JSONSerialization.data(withJSONObject: object)
            XCTAssertThrowsError(try RealtimePublicControlAdapter(e2eeNow: { Self.e2eeVectorNow })
                .decodeE2EEResolve(malformed, expected: request))
            XCTAssertThrowsError(try manager.open(responseData: malformed, requestData: request, now: Self.e2eeVectorNow))
        }
    }

    func testAdversarialDeferredReplyPersistsRouteWithoutSuccessStatus() async throws {
        let invalid = Data(#"{"operation":"connected_credential_refresh","status":"failed","request_id":"wrong-request","continuity_id":"wrong-session","connection_epoch":"wrong-epoch"}"#.utf8)
        try await assertDeferredRoute(.credentialRefresh, request: fixture("credential-refresh.valid.json"), reply: invalid, accepted: false)
    }

    func testDeferredControlRoutesRequireOperationSuccessAndExactPendingBinding() async throws {
        let cases: [(RealtimePublicControlOperation, Data, Data, [String])] = [
            (.credentialRefresh, fixture("credential-refresh.valid.json"), credentialRefreshResponse(),
             ["device_lease_ref", "transport_aliases", "transport_credential.credential", "transport_credential.expires_at", "transport_credential.credential_generation"]),
            (.e2eeKeyResolve, e2eeVectorRequest(), e2eeVectorResponse(),
             ["device_lease_ref", "recipient_device_credential_ref", "key_generation", "aad_sha256", "ciphertext"]),
            (.endContinuity, endContinuityRequest(), endContinuityResponse(),
             ["operation_outcome.outcome_class", "operation_outcome.recorded_result_ref.idempotency_context", "execution_facts.closure_status"]),
            (.handoff, handoffRequest(), handoffTerminalResponse(),
             ["previous_device_lease_ref", "from_device_id", "to_device_id", "device_lease_ref", "lease_version", "fencing_token", "old_device_suppression_fence.new_device_lease_ref", "old_device_suppression_fence.state", "operation_outcome.recorded_result_ref.fencing_epoch", "operation_outcome.recorded_result_ref.idempotency_context", "execution_facts.evidence_refs", "execution_facts.closure_status", "execution_facts.participant_cleanup", "execution_facts.track_cleanup", "execution_facts.room_cleanup"])
        ]
        for (operation, request, valid, specific) in cases {
            try await assertDeferredRoute(operation, request: request, reply: valid, accepted: true, e2eeNow: { Self.e2eeVectorNow })
            if operation == .credentialRefresh {
                for credential in [
                    ["credential": "fixture-token", "expires_at": "2020-01-01T00:00:00Z", "credential_generation": "2"],
                    ["credential": String(repeating: "a", count: 32769), "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), "credential_generation": "2"]
                ] {
                    var invalid = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
                    invalid["transport_credential"] = credential
                    try await assertDeferredRoute(operation, request: request,
                        reply: JSONSerialization.data(withJSONObject: invalid), accepted: false, e2eeNow: { Self.e2eeVectorNow })
                }
            }
            if operation == .endContinuity {
                var foreign = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
                let refresh = try XCTUnwrap(JSONSerialization.jsonObject(with: credentialRefreshResponse()) as? [String: Any])
                foreign["device_lease_ref"] = refresh["device_lease_ref"]
                try await assertDeferredRoute(operation, request: request,
                    reply: JSONSerialization.data(withJSONObject: foreign), accepted: false, e2eeNow: { Self.e2eeVectorNow })
            }
            if operation == .handoff {
                var omitted = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
                var facts = omitted["execution_facts"] as! [String: Any]
                for key in ["participant_cleanup", "track_cleanup", "room_cleanup"] { facts.removeValue(forKey: key) }
                omitted["execution_facts"] = facts
                try await assertDeferredRoute(operation, request: request,
                    reply: JSONSerialization.data(withJSONObject: omitted), accepted: true, e2eeNow: { Self.e2eeVectorNow })
            }
            for key in ["operation", "status", "request_id", "realtime_session_ref", "continuity_id", "connection_epoch", "governance"] + specific {
                var object = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
                func corrupt(_ object: inout [String: Any], path: ArraySlice<String>) {
                    let key = path.first!
                    if path.count == 1 { object[key] = key == "credential" ? "" : "invalid"; return }
                    var child = object[key] as! [String: Any]
                    corrupt(&child, path: path.dropFirst())
                    object[key] = child
                }
                corrupt(&object, path: key.split(separator: ".").map(String.init)[...])
                let invalid = try JSONSerialization.data(withJSONObject: object)
                try await assertDeferredRoute(operation, request: request, reply: invalid, accepted: false, e2eeNow: { Self.e2eeVectorNow })
            }
        }
    }

    private func assertDeferredRoute(_ operation: RealtimePublicControlOperation, request: Data, reply: Data,
        accepted: Bool, initialOrigin: String = RealtimeAPIOriginMigration.legacyOrigin,
        e2eeNow: @escaping @Sendable () -> Date = { Date() }, file: StaticString = #filePath, line: UInt = #line) async throws {
        RealtimeURLProtocolSpy.reset()
        let store = RealtimeTestPairingStore()
        var original = try RealtimeAPIOriginMigration.migrated(RealtimeDevicePairing.decode(pairingData()))
        original.origin = initialOrigin
        let alternate = initialOrigin == RealtimeAPIOriginMigration.canonicalOrigin
            ? RealtimeAPIOriginMigration.legacyOrigin : RealtimeAPIOriginMigration.canonicalOrigin
        let before = try JSONEncoder().encode(original)
        try store.replacePairingData(before)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.absoluteString.hasPrefix(initialOrigin + "/") {
                return response(for: request, statusCode: 503, body: Data())
            }
            return response(for: request, body: reply)
        }
        let provider = makeProvider(bodies: [operation: request], credentials: PairedRealtimeCredentialStore(store: store), e2eeNow: e2eeNow)
        do {
            switch operation {
            case .credentialRefresh: _ = try await provider.refreshCredentials(context: context(operation))
            case .e2eeKeyResolve: _ = try await provider.resolveE2EEKey(context: context(operation))
            case .handoff: _ = try await provider.handoff(context: context(operation))
            case .endContinuity: _ = try await provider.endContinuity(context: context(operation))
            default: XCTFail("Unsupported case", file: file, line: line)
            }
            XCTAssertTrue(accepted && initialOrigin == RealtimeAPIOriginMigration.legacyOrigin, "\(operation) must reject unqualified reply", file: file, line: line)
        } catch { XCTAssertFalse(accepted && initialOrigin == RealtimeAPIOriginMigration.legacyOrigin, "\(operation) valid success rejected: \(error)", file: file, line: line) }
        let observations = RealtimeURLProtocolSpy.observations
        XCTAssertEqual(observations.count, initialOrigin == RealtimeAPIOriginMigration.legacyOrigin ? 2 : 1, file: file, line: line)
        XCTAssertEqual(observations.first?.absoluteURL, initialOrigin + operation.path, file: file, line: line)
        XCTAssertEqual(observations.last?.absoluteURL, (initialOrigin == RealtimeAPIOriginMigration.legacyOrigin ? alternate : initialOrigin) + operation.path, file: file, line: line)
        XCTAssertTrue(observations.allSatisfy { $0.body == request }, file: file, line: line)
        XCTAssertEqual(observations.first?.authorization, observations.last?.authorization, file: file, line: line)
        if accepted && initialOrigin == RealtimeAPIOriginMigration.legacyOrigin {
            XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.data)).origin, alternate, file: file, line: line)
        } else { XCTAssertEqual(store.data, before, "Failed qualification cannot persist route", file: file, line: line) }
    }

    func testOriginRecoveryDoesNotPersistMalformedSuccessOrFallbackAfterAuthDenial() async throws {
        for initial in [RealtimeAPIOriginMigration.legacyOrigin, RealtimeAPIOriginMigration.canonicalOrigin] {
            for status in [200, 401] {
                RealtimeURLProtocolSpy.reset()
                let store = RealtimeTestPairingStore()
                var pairing = try RealtimeAPIOriginMigration.migrated(RealtimeDevicePairing.decode(pairingData()))
                pairing.origin = initial
                let before = try JSONEncoder().encode(pairing)
                try store.replacePairingData(before)
                RealtimeURLProtocolSpy.handler = { [self] request in
                    let code = status == 401 ? 401 : request.url!.absoluteString.hasPrefix(initial + "/") ? 503 : 200
                    return response(for: request, statusCode: code, body: Data("{}".utf8))
                }
                let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store))
                do { _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true)); XCTFail("Invalid response must fail") }
                catch { XCTAssertNotNil(error as? RealtimePublicControlAdapterError) }
                XCTAssertEqual(store.data, before, "HTTP 200 alone must not commit an unqualified response route")
                XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, status == 401 || initial == RealtimeAPIOriginMigration.canonicalOrigin ? 1 : 2)
            }
        }
    }

    func testOriginRecoveryDurableStopReplaysSameBytesToProvenAlternateAfterRestart() async throws {
        let store = RealtimeTestPairingStore()
        var pairing = try RealtimeAPIOriginMigration.migrated(RealtimeDevicePairing.decode(pairingData()))
        pairing.origin = RealtimeAPIOriginMigration.legacyOrigin
        try store.replacePairingData(JSONEncoder().encode(pairing))
        let (root, _) = try pairingInput(XCTUnwrap(store.data), permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let scope = Data("origin-replay-scope".utf8), body = fixture("media-stop.valid.json")
        let accepted = try originMigrationResponse(proof: false, canonical: RealtimeAPIOriginMigration.legacyOrigin)
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: accepted) }
        let initial = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json"), .mediaStop: body], credentials: PairedRealtimeCredentialStore(store: store), pendingStopDatabase: database, replayScope: scope)
        _ = try await initial.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let context = AssistantStopContext(operationID: AssistantOperationID(rawValue: "origin-durable-stop"), roomName: "room-opaque-fixture-1", reasonCode: "app_background")
        let before = store.data
        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { _ in throw URLError(.timedOut) }
        let failed = try await initial.stop(context)
        XCTAssertFalse(failed.confirmed)
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 2)
        XCTAssertNotNil(try database.pendingStopReplay())
        XCTAssertEqual(store.data, before)
        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.host != "gateway.example.invalid" { throw URLError(.cannotConnectToHost) }
            return response(for: request, body: stopResponse())
        }
        let restarted = makeProvider(bodies: [:], credentials: PairedRealtimeCredentialStore(store: store), pendingStopDatabase: database, replayScope: scope)
        let stopped = try await restarted.stop(context)
        XCTAssertTrue(stopped.confirmed)
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.map(\.body), [body, body])
        XCTAssertTrue(RealtimeURLProtocolSpy.observations.allSatisfy { $0.authorization == "Bearer " + pairing.token })
        XCTAssertNil(try database.pendingStopReplay())
        let recovered = try RealtimeDevicePairing.decode(XCTUnwrap(store.data))
        XCTAssertEqual(recovered.origin, RealtimeAPIOriginMigration.canonicalOrigin)
        XCTAssertEqual(recovered.canonicalSuccesses, 1, "Stop success changes the route, not the bootstrap confirmation marker")
        XCTAssertEqual(CentralOwnerDataIdentity.pairing(recovered), CentralOwnerDataIdentity.pairing(pairing))
    }

    func testOriginDiscoveryReturnsAcceptedSessionBeforeProofAndBacksOffExponentially() async throws {
        let store = RealtimeTestPairingStore(), original = try pairingData()
        try store.replacePairingData(original)
        let clock = RealtimeOriginTestClock(), gate = RealtimeDelayedResponseGate(), probes = RealtimeAtomicCounter()
        defer { gate.release() }
        let accepted = try originMigrationResponse(proof: false), proof = try originMigrationResponse(proof: true)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path.hasSuffix("/reconcile") {
                if probes.next() == 1 { gate.block() }
                return response(for: request, statusCode: 401, body: Data("{}".utf8))
            }
            return response(for: request, body: accepted)
        }
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store), originProbeNow: clock.now)
        let returned = expectation(description: "accepted foreground session returned")
        let settled = originProbeFinished(clock)
        let start = Task { let details = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true)); returned.fulfill(); return details }
        await fulfillment(of: [returned], timeout: 2)
        XCTAssertTrue(gate.waitUntilBlocked())
        XCTAssertEqual(store.data, original)
        gate.release()
        _ = try await start.value
        await fulfillment(of: [settled], timeout: 2)
        for _ in 0..<3 { _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true)) }
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.filter { $0.path.hasSuffix("/reconcile") }.count, 1)
        clock.advance(5)
        let second = originProbeFinished(clock, read: 7)
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        await fulfillment(of: [second], timeout: 2)
        clock.advance(9)
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.filter { $0.path.hasSuffix("/reconcile") }.count, 2)
        clock.advance(1)
        let third = originProbeFinished(clock, read: 10)
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: request.url!.path.hasSuffix("/reconcile") ? proof : accepted) }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        await fulfillment(of: [third], timeout: 2)
        XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.data)).origin, RealtimeAPIOriginMigration.canonicalOrigin)
    }

    func testOriginDiscoveryHasTotalFiveSecondDeadline() async throws {
        let store = RealtimeTestPairingStore(), original = try pairingData()
        try store.replacePairingData(original)
        let clock = RealtimeOriginTestClock(), gate = RealtimeDelayedResponseGate()
        defer { gate.release() }
        let finished = originProbeFinished(clock), accepted = try originMigrationResponse(proof: false)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path.hasSuffix("/reconcile") { gate.block() }
            return response(for: request, body: accepted)
        }
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store), originProbeNow: clock.now)
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        XCTAssertTrue(gate.waitUntilBlocked())
        await fulfillment(of: [finished], timeout: 7)
        XCTAssertEqual(store.data, original)
    }

    func testOriginDiscoveryCancelsOnProviderTeardown() async throws {
        let store = RealtimeTestPairingStore(), gate = RealtimeDelayedResponseGate()
        try store.replacePairingData(pairingData())
        defer { gate.release() }
        let accepted = try originMigrationResponse(proof: false)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path.hasSuffix("/reconcile") { gate.block() }
            return response(for: request, body: accepted)
        }
        var provider: ProductionRealtimePublicControlProvider? = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store))
        weak var weakProvider = provider
        _ = try await provider!.bootstrap(for: AssistantStartIntent(userInitiated: true))
        XCTAssertTrue(gate.waitUntilBlocked())
        let cancelled = expectation(description: "teardown cancels URLSession proof")
        RealtimeURLProtocolSpy.onStop = { request in if request.url?.path.hasSuffix("/reconcile") == true { cancelled.fulfill() } }
        provider = nil
        XCTAssertNil(weakProvider)
        await fulfillment(of: [cancelled], timeout: 2)
        RealtimeURLProtocolSpy.onStop = nil
    }

    func testOriginDiscoveryCancelsOldPairingOnNextCredentialRead() async throws {
        let store = RealtimeTestPairingStore(), gate = RealtimeDelayedResponseGate()
        try store.replacePairingData(pairingData())
        defer { gate.release() }
        let accepted = try originMigrationResponse(proof: false), proof = try originMigrationResponse(proof: true)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path.hasSuffix("/reconcile") { gate.block(); return response(for: request, body: proof) }
            return response(for: request, body: accepted)
        }
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")], credentials: PairedRealtimeCredentialStore(store: store))
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        XCTAssertTrue(gate.waitUntilBlocked())
        let replacement = try pairingData { $0["paired_at"] = "2026-10-15T16:00:00.000Z" }
        try store.replacePairingData(replacement)
        let cancelled = expectation(description: "pair replacement cancels URLSession proof")
        RealtimeURLProtocolSpy.onStop = { request in if request.url?.path.hasSuffix("/reconcile") == true { cancelled.fulfill() } }
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: fixture("bootstrap-response.valid.json")) }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        await fulfillment(of: [cancelled], timeout: 2)
        RealtimeURLProtocolSpy.onStop = nil
        XCTAssertEqual(store.data, replacement)
    }

    private func originProbeFinished(_ clock: RealtimeOriginTestClock, read: Int = 2) -> XCTestExpectation {
        let finished = expectation(description: "origin discovery settled")
        clock.onRead = { count in if count == read { finished.fulfill() } }
        return finished
    }

    private func originMigrationResponse(proof: Bool, canonical: String = RealtimeAPIOriginMigration.canonicalOrigin) throws -> Data {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-response.valid.json")) as? [String: Any])
        if proof {
            object = object.filter { ["realtime_session_ref", "device_lease_ref", "continuity_id", "connection_epoch",
                "transport_aliases", "e2ee_key_envelope", "recipient_device_credential_ref"].contains($0.key) }
            object["operation"] = "bootstrap"; object["kind"] = "paios.public-operation.read.v1"; object["status"] = "committed"
        }
        if !proof { object["canonical_api_origin"] = canonical }
        return try JSONSerialization.data(withJSONObject: object)
    }

    func testDevicePairingDecodeAcceptsExactPhoneGlassesAndMacArtifacts() throws {
        let phoneBytes = try pairingData()
        let phoneObject = try XCTUnwrap(JSONSerialization.jsonObject(with: phoneBytes) as? [String: Any])
        XCTAssertEqual(phoneObject.count, 8)
        let phone = try RealtimeDevicePairing.decode(phoneBytes)
        XCTAssertNil(phone.deviceType); XCTAssertNil(phone.capabilities)
        for (deviceClass, capabilities) in [("glasses", ["display", "microphone"]), ("mac", ["display", "microphone", "notifications", "chat_ui", "desktop_tools"]), ("mac", ["display", "chat_ui", "desktop_tools", "owner_unlock"])] {
            let bytes = try pairingData { $0["device_type"] = deviceClass; $0["capabilities"] = capabilities }
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            XCTAssertEqual(object.count, 10)
            let decoded = try RealtimeDevicePairing.decode(bytes)
            XCTAssertEqual(decoded.deviceType, deviceClass); XCTAssertEqual(decoded.capabilities, capabilities)
        }
        let invalid: [(inout [String: Any]) -> Void] = [
            { $0["device_type"] = "mac" },
            { $0["capabilities"] = ["display"] },
            { $0["device_type"] = "iphone"; $0["capabilities"] = ["display"] },
            { $0["device_type"] = "mac"; $0["capabilities"] = ["display", "chat_ui", "desktop_tools", "health"] },
            { $0["device_type"] = "glasses"; $0["capabilities"] = ["desktop_tools"] }
        ]
        for mutation in invalid { XCTAssertThrowsError(try RealtimeDevicePairing.decode(pairingData(mutation))) }
    }

    func testDevicePairingDecodeRejectsMalformedPairings() throws {
        XCTAssertNoThrow(try RealtimeDevicePairing.decode(pairingData()))
        XCTAssertNoThrow(try RealtimeDevicePairing.decode(pairingData { $0["origin"] = "https://api.example:9443" }))
        let mutations: [(inout [String: Any]) -> Void] = [
            { $0["unexpected"] = true },
            { $0["schema"] = "paios.realtime-production-enrollment-bundle.v1" },
            { $0["origin"] = "http://api.example:9443" },
            { $0["origin"] = "https://api.example:9443/rtc" },
            { $0["origin"] = "https://api.example:65536" },
            { $0["token"] = "short" },
            { $0["token"] = "contains space token value" },
            { $0["device_id"] = "11111111-1111-4111-8111-111111111111" },
            { $0["media"] = ["audio"] },
            { $0["media"] = ["audio", "data", "screen"] },
            { $0["media"] = ["data", "data"] },
            { var governance = $0["governance"] as! [String: Any]; governance["extra"] = []; $0["governance"] = governance },
            { var governance = $0["governance"] as! [String: Any]; governance["consent_record_refs"] = ["not-a-uuid"]; $0["governance"] = governance },
            { $0.removeValue(forKey: "paired_at") }
        ]
        for mutate in mutations {
            XCTAssertThrowsError(try RealtimeDevicePairing.decode(pairingData(mutate))) { error in
                XCTAssertEqual(error as? RealtimeDevicePairingError, .invalidPairing)
            }
        }
    }

    func testMissingOptionalHandoffFailsClosedBeforeURLSession() async throws {
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RealtimeURLProtocolSpy.self]
        let provider = ProductionRealtimePublicControlProvider(
            settingsStore: RealtimeTestSettingsStore(
                settings: AppSettings(endpoint: ProductionRealtimePublicControlProvider.requiredOrigin)),
            credentialStore: PairedRealtimeCredentialStore(store: store, identity: RealtimeTestCredentialStore(tokens: [])),
            canonicalBodyProvider: PairedRealtimeRequestBodyProvider(store: store),
            session: URLSession(configuration: configuration),
            recipientKeyStore: RealtimeTestE2EERecipientKeyStore(rawRepresentation: Data(repeating: 7, count: 32))
        )
        RealtimeURLProtocolSpy.handler = { _ in throw URLError(.badURL) }

        do {
            _ = try await provider.handoff(context: context(.handoff))
            XCTFail("Expected missing optional handoff body")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingCanonicalBody)
        }
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 0)
    }

    func testInvalidPairingIsRejectedKeptAndProviderStaysNotReady() throws {
        let store = RealtimeTestPairingStore()
        let (root, input) = try pairingInput(pairingData { $0["unexpected"] = true }, permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))

        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: input, store: store,
            database: database), .rejected)
        XCTAssertTrue(FileManager.default.fileExists(atPath: input.path))
        XCTAssertNil(store.data)
        XCTAssertTrue(try database.pending().isEmpty)
        XCTAssertFalse(PairedRealtimeRequestBodyProvider(store: store).isReady)
    }

    func testPairingImportRejectsSymlinkAndNonOwnerOnlyFileWithoutStoreCall() throws {
        let store = RealtimeTestPairingStore()
        let (root, target) = try pairingInput(pairingData(), permissions: 0o600)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let symlink = root.appendingPathComponent("symlink.json")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: target)
        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: symlink, store: store,
            database: database), .rejected)
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))

        let nonOwnerOnly = root.appendingPathComponent("non-owner-only.json")
        try pairingData().write(to: nonOwnerOnly)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: 0o644)], ofItemAtPath: nonOwnerOnly.path)
        XCTAssertEqual(RealtimeDevicePairingRuntime.importPairing(from: nonOwnerOnly, store: store,
            database: database), .rejected)
        XCTAssertTrue(FileManager.default.fileExists(atPath: nonOwnerOnly.path))
        XCTAssertEqual(store.replaceCallCount, 0)
    }

    /// Live check of the whole Swift control plane against the paired Mac gateway through the public origin.
    /// Skipped unless a local dev pairing (pairing + recipient X25519 key) is present on the host.
    func testLivePairedControlPlaneThroughPublicOrigin() async throws {
        guard ProcessInfo.processInfo.environment["PAIOS_LIVE_PAIRED_CONTROL_TEST"] == "1" else {
            throw XCTSkip("Live public control test requires explicit opt-in")
        }
        let url = URL(fileURLWithPath: "/opt/paios/fixtures/live-pairing.json")
        guard let data = try? Data(contentsOf: url) else { throw XCTSkip("no live pairing on this host") }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(JSONSerialization.data(withJSONObject: XCTUnwrap(object["pairing"])))
        var encodedKey = try XCTUnwrap(object["recipient_private_raw32_base64url"] as? String)
            .replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while encodedKey.count % 4 != 0 { encodedKey += "=" }
        let provider = ProductionRealtimePublicControlProvider(
            settingsStore: RealtimeTestSettingsStore(
                settings: AppSettings(endpoint: ProductionRealtimePublicControlProvider.requiredOrigin)),
            credentialStore: PairedRealtimeCredentialStore(store: store, identity: RealtimeTestCredentialStore(tokens: [])),
            canonicalBodyProvider: PairedRealtimeRequestBodyProvider(store: store),
            recipientKeyStore: RealtimeTestE2EERecipientKeyStore(rawRepresentation: try XCTUnwrap(Data(base64Encoded: encodedKey)))
        )
        let intent = AssistantStartIntent(userInitiated: true)
        let details = try await provider.bootstrap(for: intent)
        XCTAssertFalse(details.participantToken.isEmpty)
        let snapshot = await provider.localBindingSnapshot()
        let binding = try XCTUnwrap(snapshot)
        func bound(_ operation: RealtimePublicControlOperation) -> RealtimeCanonicalRequestContext {
            RealtimeCanonicalRequestContext(operation: operation, localBinding: intent.operationID.rawValue,
                retainedBootstrapBinding: binding)
        }
        let key = try await provider.resolveE2EEContentKey(context: bound(.e2eeKeyResolve))
        XCTAssertEqual(key.count, 32)
        let refreshed = try await provider.refreshCredentials(context: bound(.credentialRefresh))
        XCTAssertEqual(refreshed.operation, "connected_credential_refresh")
        let room = try XCTUnwrap(binding.transportAliases.first { $0.aliasType == "room" }).value
        let stopped = try await provider.stop(AssistantStopContext(operationID: intent.operationID, roomName: room,
            reasonCode: "user_stop"))
        XCTAssertTrue(stopped.confirmed)
        let ended = try await provider.endContinuity(context: bound(.endContinuity))
        XCTAssertEqual(ended.operation, "end_continuity")
    }

    func testPairedProviderSendsAndConfirmsMediaStopForTheRetainedBinding() async throws {
        RealtimeURLProtocolSpy.reset()
        // The real app: durable stop required, and the stop reuses the start's operation id.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("paired-stop-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let requestID = "01a11111-0000-7000-8000-00000000cccc"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RealtimeURLProtocolSpy.self]
        let provider = ProductionRealtimePublicControlProvider(
            settingsStore: RealtimeTestSettingsStore(
                settings: AppSettings(endpoint: ProductionRealtimePublicControlProvider.requiredOrigin)),
            credentialStore: PairedRealtimeCredentialStore(store: store, identity: RealtimeTestCredentialStore(tokens: [])),
            canonicalBodyProvider: PairedRealtimeRequestBodyProvider(store: store, makeID: { _ in requestID }),
            session: URLSession(configuration: configuration),
            pendingStopDatabase: database,
            requiresDurableStop: true,
            recipientKeyStore: RealtimeTestE2EERecipientKeyStore(rawRepresentation: Data(repeating: 7, count: 32))
        )
        var editable = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-response.valid.json")) as? [String: Any])
        // Real gateway room aliases are T02 transport aliases (~290 bytes), longer than any fixture value.
        let roomAlias = "t02.realtime.transport-alias.v1:" + [String](repeating: String(repeating: "a", count: 64), count: 3)
            .joined(separator: ":") + ":1:" + String(repeating: "b", count: 64)
        editable["transport_aliases"] = try XCTUnwrap(editable["transport_aliases"] as? [[String: Any]]).map { alias in
            var alias = alias
            if alias["alias_type"] as? String == "room" { alias["value"] = roomAlias }
            return alias
        }
        let bootstrap = editable
        let bootstrapData = try JSONSerialization.data(withJSONObject: bootstrap)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path == "/v1/realtime/credentials/refresh" {
                return response(for: request, body: credentialRefreshResponse(
                    request: try XCTUnwrap(RealtimeURLProtocolSpy.observations.last?.body)))
            }
            guard request.url?.path == "/v1/realtime/media/stop" else {
                return response(for: request, body: bootstrapData)
            }
            let terminal: [String: Any] = ["operation": "media_stop", "status": "success", "request_id": requestID,
                "realtime_session_ref": bootstrap["realtime_session_ref"]!, "device_lease_ref": bootstrap["device_lease_ref"]!,
                "continuity_id": bootstrap["continuity_id"]!, "connection_epoch": bootstrap["connection_epoch"]!,
                "operation_outcome": ["outcome_class": "committed_success", "resolution_mode": "direct"],
                "execution_facts": ["closure_status": "verified_closed", "device_lease_release": "released",
                    "participant_cleanup": "verified_absent", "track_cleanup": "verified_absent", "room_cleanup": "verified_absent"]]
            return response(for: request, body: try JSONSerialization.data(withJSONObject: terminal))
        }
        let intent = AssistantStartIntent(userInitiated: true)
        let details = try await provider.bootstrap(for: intent)
        let snapshot = await provider.localBindingSnapshot()
        let binding = try XCTUnwrap(snapshot)
        _ = try await provider.refreshCredentials(context: RealtimeCanonicalRequestContext(operation: .credentialRefresh,
            localBinding: intent.operationID.rawValue, retainedBootstrapBinding: binding))
        XCTAssertGreaterThan(details.roomName.utf8.count, 256)
        let stopped = try await provider.stop(AssistantStopContext(operationID: intent.operationID,
            roomName: details.roomName, reasonCode: "user_stop"))
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.map(\.path),
            ["/v1/realtime/bootstrap", "/v1/realtime/credentials/refresh", "/v1/realtime/media/stop"])
        XCTAssertTrue(stopped.confirmed)
        XCTAssertNil(try database.pendingStopReplay(), "A confirmed stop completes the operation its start opened")
    }

    func testUnresolvedBootstrapAllowsReplacementAndKeepsOldPayloadUntilAcceptance() async throws {
        let origin = "https://api.example:9443"
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("inflight-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let bodies: [RealtimePublicControlOperation: Data] = [.bootstrap: fixture("bootstrap-request.valid.json")]
        RealtimeURLProtocolSpy.handler = { _ in throw URLError(.networkConnectionLost) }
        do {
            _ = try await makeProvider(bodies: bodies, endpoint: origin, pendingStopDatabase: database)
                .bootstrap(for: AssistantStartIntent(userInitiated: true))
            XCTFail("The lost bootstrap response must fail the start")
        } catch {}
        let old = try XCTUnwrap(database.pendingStopReplay(kind: "bootstrap"))

        let inFlight = Data(#"{"operation":"bootstrap","kind":"paios.public-operation.read.v1","status":"in_flight"}"#.utf8)
        for body in [inFlight, Data("{}".utf8)] {
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: body) }
            let restored = try await makeProvider(bodies: bodies, endpoint: origin, pendingStopDatabase: database).restorePendingStop()
            XCTAssertNil(restored)
            XCTAssertEqual(try database.pendingStopReplay(kind: "bootstrap")?.payload, old.payload)
        }
        let replacement = makeProvider(bodies: bodies, endpoint: origin, pendingStopDatabase: database)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path.hasSuffix("/reconcile") == true {
                XCTAssertEqual(request.url?.absoluteString, origin + "/v1/realtime/bootstrap/reconcile")
                return response(for: request, body: inFlight) }
            XCTAssertEqual(try database.pendingStopReplay(kind: "bootstrap")?.operationID, "replacement")
            XCTAssertEqual(try database.operation(operationID: old.operationID)?.state, .pending)
            throw URLError(.networkConnectionLost)
        }
        let context = try await replacement.restorePendingStop()
        XCTAssertNil(context)
        XCTAssertEqual(try database.pendingStopReplay(kind: "bootstrap")?.payload, old.payload)
        do {
            _ = try await replacement.bootstrap(for: AssistantStartIntent(operationID: AssistantOperationID(rawValue: "replacement"), userInitiated: true))
            XCTFail("Expected the replacement response to be lost")
        } catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .transportFailure) }
        XCTAssertEqual(try database.operation(operationID: old.operationID)?.state, .pending)
        let retry = makeProvider(bodies: bodies, endpoint: origin, pendingStopDatabase: database)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path.hasSuffix("/reconcile") == true { throw URLError(.networkConnectionLost) }
            XCTAssertEqual(try database.operation(operationID: old.operationID)?.state, .pending)
            XCTAssertEqual(try database.operation(operationID: "replacement")?.state, .pending)
            return response(for: request, body: fixture("bootstrap-response.valid.json"))
        }
        let unavailable = try await retry.restorePendingStop()
        XCTAssertNil(unavailable)
        _ = try await retry.bootstrap(for: AssistantStartIntent(userInitiated: true))
        for id in [old.operationID, "replacement"] {
            XCTAssertEqual(try database.operation(operationID: id)?.state, .completed)
            XCTAssertEqual(try database.operation(operationID: id)?.lastError, "superseded_by_start")
        }
        XCTAssertNil(try database.pendingStopReplay(kind: "bootstrap"))
    }

    func testInvalidationDuringBootstrapBodyConstructionCannotSendANewStart() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("reconcile-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        let bodies: [RealtimePublicControlOperation: Data] = [.bootstrap: fixture("bootstrap-request.valid.json")]
        RealtimeURLProtocolSpy.handler = { _ in throw URLError(.networkConnectionLost) }
        do { _ = try await makeProvider(bodies: bodies, pendingStopDatabase: database).bootstrap(for: AssistantStartIntent(userInitiated: true)) }
        catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .transportFailure) }
        let original = try XCTUnwrap(database.pendingStopReplay(kind: "bootstrap"))
        let gate = RealtimeDelayedResponseGate()
        defer { gate.release() }
        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { _ in XCTFail("Invalidated Start must not send"); throw URLError(.badServerResponse) }
        let provider = makeProvider(bodies: bodies, pendingStopDatabase: database,
            contextObserver: { _ in gate.block() })
        let pending = Task { try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true)) }
        XCTAssertTrue(gate.waitUntilBlocked())
        await provider.invalidatePendingBootstrap()
        gate.release()
        do { _ = try await pending.value; XCTFail("Invalidated Start cannot reach admission") }
        catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .bootstrapSuperseded) }
        XCTAssertTrue(RealtimeURLProtocolSpy.observations.isEmpty)
        XCTAssertEqual(try database.pendingStopReplay(kind: "bootstrap")?.payload, original.payload)
    }

    func testSupersedeControlReplaysFreesStartForTheNewPairing() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("supersede-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("pending.sqlite"))
        try database.preserveStopReplay(operationID: "old-start", payload: Data("{}".utf8), kind: "bootstrap")
        XCTAssertNotNil(try database.pendingStopReplay(kind: "bootstrap"))

        try database.supersedeControlReplays()
        XCTAssertNil(try database.pendingStopReplay(kind: "bootstrap"))
        XCTAssertNil(try database.pendingStopReplay())
        XCTAssertNoThrow(try database.preserveStopReplay(operationID: "new-start", payload: Data("{}".utf8), kind: "bootstrap"))
    }

    private func makeProvider(
        bodies: [RealtimePublicControlOperation: Data],
        credentials: any CredentialStoring =
            RealtimeTestCredentialStore(tokens: ["api-token-123456"]),
        endpoint: String =
            ProductionRealtimePublicControlProvider.requiredOrigin,
        pendingStopDatabase: AssistantLocalOperationDatabase? = nil,
        replayScope: Data? = nil,
        bootstrapRecoveryWindow: Duration = .zero,
        originProbeNow: @escaping @Sendable () -> Date = { Date() },
        e2eeNow: @escaping @Sendable () -> Date = { Date() },
        contextObserver: (@Sendable (
            RealtimeCanonicalRequestContext
        ) async -> Void)? = nil,
        recipientKeyStore: any E2EERecipientKeyStoring =
            RealtimeTestE2EERecipientKeyStore(rawRepresentation: Data(repeating: 7, count: 32))
    ) -> ProductionRealtimePublicControlProvider {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RealtimeURLProtocolSpy.self]
        let session = URLSession(configuration: configuration)
        let canonicalBodyProvider = AppLocalCanonicalRequestBodyProvider(replayScope: replayScope) {
            operation, context in
            if let contextObserver {
                await contextObserver(context)
            }
            return bodies[operation]
        }
        return ProductionRealtimePublicControlProvider(
            settingsStore: RealtimeTestSettingsStore(
                settings: AppSettings(endpoint: endpoint)
            ),
            credentialStore: credentials,
            canonicalBodyProvider: canonicalBodyProvider,
            session: session,
            bootstrapRecoveryWindow: bootstrapRecoveryWindow,
            originProbeNow: originProbeNow,
            pendingStopDatabase: pendingStopDatabase,
            adapter: RealtimePublicControlAdapter(e2eeNow: e2eeNow),
            recipientKeyStore: recipientKeyStore
        )
    }

    private func captureStandardOutput(
        during operation: () async throws -> Void
    ) async throws -> String {
        let pipe = Pipe()
        let savedOutput = dup(STDOUT_FILENO)
        guard savedOutput >= 0 else {
            throw NSError(
                domain: "RealtimePublicControlAdapterTests",
                code: 1
            )
        }
        fflush(stdout)
        guard dup2(
            pipe.fileHandleForWriting.fileDescriptor,
            STDOUT_FILENO
        ) >= 0 else {
            close(savedOutput)
            throw NSError(
                domain: "RealtimePublicControlAdapterTests",
                code: 2
            )
        }

        var operationError: Error?
        do {
            try await operation()
        } catch {
            operationError = error
        }

        fflush(stdout)
        _ = dup2(savedOutput, STDOUT_FILENO)
        close(savedOutput)
        pipe.fileHandleForWriting.closeFile()
        let output = String(
            data: pipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        if let operationError {
            throw operationError
        }
        return output
    }

    func testPairedBodiesBindRetainedBootstrapAndCarryAVerifiableIdempotencyContext() async throws {
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let provider = PairedRealtimeRequestBodyProvider(store: store, now: { Date(timeIntervalSince1970: 1_791_000_000) },
            makeID: { _ in "01a11111-0000-7000-8000-00000000bbbb" })
        let binding = try RealtimePublicControlAdapter().mapBootstrap(fixture("bootstrap-response.valid.json")).localBinding
        let credential = try XCTUnwrap(binding.recipientDeviceCredentialRef)
        func body(_ operation: RealtimePublicControlOperation) async throws -> [String: Any] {
            let data = try await provider.canonicalBody(for: operation, context: RealtimeCanonicalRequestContext(
                operation: operation, localBinding: "bound", retainedBootstrapBinding: binding))
            return try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(data)) as? [String: Any])
        }
        func reference(_ value: Any?) throws -> RealtimeCanonicalReference {
            try JSONDecoder().decode(RealtimeCanonicalReference.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(value)))
        }

        let e2ee = try await body(.e2eeKeyResolve)
        XCTAssertEqual(e2ee["device_id"] as? String, Self.pairedDeviceID)
        XCTAssertEqual(try reference(e2ee["realtime_session_ref"]), binding.realtimeSessionRef)
        XCTAssertEqual(try reference(e2ee["device_lease_ref"]), binding.deviceLeaseRef)
        XCTAssertEqual(try reference(e2ee["recipient_device_credential_ref"]), credential)
        XCTAssertEqual((e2ee["participant_audience"] as? [String: String])?["alias_type"], "participant")
        XCTAssertEqual(e2ee["key_index"] as? Int, binding.e2eeKeyEnvelope.keyIndex)
        XCTAssertEqual(e2ee["key_generation"] as? String, binding.e2eeKeyEnvelope.keyGeneration)
        XCTAssertEqual((e2ee["transport_aliases"] as? [Any])?.count, binding.transportAliases.count)
        try assertIdempotencyContext(e2ee, kind: "realtime_e2ee_key_resolve", targetType: "RealtimeSession",
            targetID: binding.realtimeSessionRef.refID)

        let refresh = try await body(.credentialRefresh)
        XCTAssertEqual(refresh["refresh_reason"] as? String, "server_refresh")
        try assertIdempotencyContext(refresh, kind: "realtime_credential_refresh", targetType: "RealtimeSession",
            targetID: binding.realtimeSessionRef.refID)

        let stop = try await body(.mediaStop)
        XCTAssertEqual(stop["reason"] as? String, "user_stop")
        XCTAssertEqual(stop["release_scope"] as? String, "media_device_lease_only")
        XCTAssertTrue(try RealtimePublicControlAdapter().decodeStopExpectation(
            JSONSerialization.data(withJSONObject: stop)).matches(binding))
        try assertIdempotencyContext(stop, kind: "realtime_media_stop", targetType: "DeviceLease",
            targetID: binding.deviceLeaseRef.refID)

        let end = try await body(.endContinuity)
        XCTAssertEqual(end["confirmation"] as? String, "explicit_user_end_continuity")
        XCTAssertNil(end["device_lease_ref"])
        XCTAssertNil(end["transport_aliases"])
        try assertIdempotencyContext(end, kind: "realtime_end_continuity", targetType: "RealtimeSession",
            targetID: binding.realtimeSessionRef.refID)

        do {
            _ = try await provider.canonicalBody(for: .mediaStop, context: context(.mediaStop))
            XCTFail("A bound operation needs the retained bootstrap binding")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingCanonicalContext)
        }
        let noAudience = RealtimeBootstrapLocalBinding(realtimeSessionRef: binding.realtimeSessionRef,
            deviceLeaseRef: binding.deviceLeaseRef, continuityID: binding.continuityID, connectionEpoch: binding.connectionEpoch,
            transportAliases: binding.transportAliases.filter { $0.aliasType != "participant" },
            e2eeKeyEnvelope: binding.e2eeKeyEnvelope, recipientDeviceCredentialRef: credential)
        do {
            _ = try await provider.canonicalBody(for: .e2eeKeyResolve, context: RealtimeCanonicalRequestContext(
                operation: .e2eeKeyResolve, localBinding: "bound", retainedBootstrapBinding: noAudience))
            XCTFail("Key resolution needs the participant audience")
        } catch let error as RealtimePublicControlAdapterError {
            XCTAssertEqual(error, .missingCanonicalContext)
        }
    }

    func testCommittedBootstrapReadFactRebuildsTheOriginalBinding() throws {
        let adapter = RealtimePublicControlAdapter()
        let response = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-response.valid.json")) as? [String: Any])
        var fact: [String: Any] = ["operation": "bootstrap", "kind": "paios.public-operation.read.v1", "status": "committed"]
        for key in ["realtime_session_ref", "device_lease_ref", "continuity_id", "connection_epoch", "transport_aliases",
                    "e2ee_key_envelope", "recipient_device_credential_ref"] {
            fact[key] = response[key]
        }
        let data = try JSONSerialization.data(withJSONObject: fact)
        XCTAssertTrue(try adapter.bootstrapReadLeftSessionToStop(data))
        XCTAssertEqual(try adapter.qualifyBootstrapRead(data),
            try adapter.mapBootstrap(fixture("bootstrap-response.valid.json")).localBinding)
        fact.removeValue(forKey: "device_lease_ref")
        XCTAssertThrowsError(try adapter.qualifyBootstrapRead(JSONSerialization.data(withJSONObject: fact)))
    }

    func testFreshWatchRegistrationReadsZeroAndReconnectRestoresFormalOrigin() async throws {
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")])
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path == "/v1/realtime/bootstrap" {
                return response(for: request, body: fixture("bootstrap-response.valid.json"))
            }
            if request.url?.path == "/v1/realtime/watch-binding/read" {
                let registered = RealtimeURLProtocolSpy.observations.contains { $0.path == "/v1/realtime/watch-binding" }
                let envelope: [String: Any] = ["operation": "watch_binding",
                    "pair_state": ["pair_version": registered ? "1" : "0", "status": registered ? "active" : "absent", "requires_rebind": false],
                    "binding": registered ? try formalWatchReceipt() : NSNull()]
                return response(for: request, body: try JSONSerialization.data(withJSONObject: envelope))
            }
            let body = try XCTUnwrap(RealtimeURLProtocolSpy.observations.last?.body)
            let mutation = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            XCTAssertEqual(mutation["action"] as? String, "register")
            XCTAssertEqual(mutation["expected_pair_version"] as? String, "0")
            let receipt = try formalWatchReceipt { raw in
                raw["requestId"] = mutation["request_id"]; raw["idempotencyKey"] = mutation["idempotency_key"]
                raw["installationId"] = mutation["installation_id"]
            }
            return response(for: request, body: try JSONSerialization.data(withJSONObject: ["operation": "watch_binding", "binding": receipt]))
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
#if canImport(WatchConnectivity) && os(iOS)
        let channel = WatchConnectivityPhoneAdapter(sender: TestPhoneControlSender())
        await provider.bindWatchChannel(channel)
        _ = try await provider.registerWatchFromUserAction(using: channel)
#else
        let pair = try await provider.readFormalWatchPairState()
        _ = try await provider.mutateFormalWatch(action: "register", observedInstallationID: "dddddddd-dddd-4ddd-bddd-dddddddddddd",
            expectedPairVersion: pair.pairVersion, requestID: "first-registration", idempotencyKey: "first-registration")
#endif
        let registered = try await provider.currentFormalWatchOrigin()
        XCTAssertNotNil(registered)
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let restored = try await provider.currentFormalWatchOrigin()
        XCTAssertEqual(restored, registered)
        XCTAssertEqual(RealtimeURLProtocolSpy.observations.filter { $0.path.hasSuffix("/watch-binding/read") }.count, 2)
    }

    func testWatchPairReadRejectsLateResponseAfterNewBootstrap() async throws {
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")])
        let gate = RealtimeDelayedResponseGate()
        defer { gate.release() }
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path == "/v1/realtime/bootstrap" { return response(for: request, body: fixture("bootstrap-response.valid.json")) }
            gate.block()
            return response(for: request, body: Data(#"{"operation":"watch_binding","pair_state":{"pair_version":"0","status":"absent","requires_rebind":false},"binding":null}"#.utf8))
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let pending = Task { try await provider.readFormalWatchPairState() }
        XCTAssertTrue(gate.waitUntilBlocked())
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        gate.release()
        do { _ = try await pending.value; XCTFail("the old session must not install its pair state") }
        catch { XCTAssertEqual(error as? RealtimePublicControlAdapterError, .staleBinding) }
    }

    func testWatchPairReadRejectsInventedZeroStateAndForeignSession() async throws {
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")])
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: fixture("bootstrap-response.valid.json")) }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let foreign = try formalWatchReceipt { raw in
            var session = raw["realtimeSessionRef"] as! [String: Any]
            session["ref_id"] = "018f0000-0000-7000-8000-000000000099"
            raw["realtimeSessionRef"] = session
        }
        for envelope: [String: Any] in [
            ["operation": "watch_binding", "pair_state": ["pair_version": "3", "status": "absent", "requires_rebind": false], "binding": NSNull()],
            ["operation": "watch_binding", "pair_state": ["pair_version": "1", "status": "active", "requires_rebind": false], "binding": foreign]
        ] {
            RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, body: try JSONSerialization.data(withJSONObject: envelope)) }
            do { _ = try await provider.readFormalWatchPairState(); XCTFail("untrusted pair state must be rejected") }
            catch { XCTAssertTrue(error is RealtimeControlValidationError) }
        }
    }

    func testRevocationReadsCurrentVersionAndAcceptsExpiredPriorSessionReceipt() async throws {
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")])
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path == "/v1/realtime/bootstrap" { return response(for: request, body: fixture("bootstrap-response.valid.json")) }
            if request.url?.path.hasSuffix("/read") == true {
                return response(for: request, body: Data(#"{"operation":"watch_binding","pair_state":{"pair_version":"39","status":"active","requires_rebind":true},"binding":null}"#.utf8))
            }
            let mutation = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(RealtimeURLProtocolSpy.observations.last?.body)) as? [String: Any])
            XCTAssertEqual(mutation["expected_pair_version"] as? String, "39")
            XCTAssertEqual(mutation["action"] as? String, "revoke")
            let receipt = try formalWatchReceipt { raw in
                raw["requestId"] = mutation["request_id"]; raw["idempotencyKey"] = mutation["idempotency_key"]
                raw["pairVersion"] = "40"; raw["status"] = "revoked"; raw["expiresAt"] = "2026-01-02T00:00:00.000Z"
                var session = raw["realtimeSessionRef"] as! [String: Any]
                session["ref_id"] = "018f0000-0000-7000-8000-000000000099"; raw["realtimeSessionRef"] = session
            }
            return response(for: request, body: try JSONSerialization.data(withJSONObject: ["operation": "watch_binding", "binding": receipt]))
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        let revoked = try await provider.revokeWatchFromUserAction()
        XCTAssertEqual(revoked.status, "revoked")
        let origin = try await provider.currentFormalWatchOrigin()
        XCTAssertNil(origin)
    }

    private func formalWatchReceipt(_ mutate: (inout [String: Any]) -> Void = { _ in }) throws -> [String: Any] {
        let bootstrap = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("bootstrap-response.valid.json")) as? [String: Any])
        let id: (Int) -> String = { "018f0000-0000-7000-8000-0000000000" + String(format: "%02d", $0) }
        var raw: [String: Any] = ["bindingId": id(10), "kind": "t02.apple.watch-binding.v1", "status": "active", "pairVersion": "1",
            "installationId": "dddddddd-dddd-4ddd-bddd-dddddddddddd", "userId": id(11), "issuedAt": "2026-01-01T00:00:00.000Z",
            "expiresAt": "2027-01-01T00:00:00.000Z", "objectVersion": "1", "requestId": "first-registration", "idempotencyKey": "first-registration",
            "requestFingerprintSha256": String(repeating: "a", count: 64), "principalRef": "distinct-principal", "realtimeSessionRef": bootstrap["realtime_session_ref"]!,
            "iphone": ["deviceId": id(12), "clientInstanceId": id(13), "deviceLeaseRef": bootstrap["device_lease_ref"]!],
            "watch": ["deviceId": id(14), "clientInstanceId": id(16), "deviceLeaseRef": ["ref_type": "DeviceLease", "ref_id": id(15),
                "object_version": "1", "canonical_payload_sha256": String(repeating: "e", count: 64)]]]
        mutate(&raw)
        let canonical = try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys, .withoutEscapingSlashes])
        raw["canonicalPayloadSha256"] = e2eeSHA256Hex(Data("paios.t02.apple-watch-binding.receipt.v1\n".utf8) + canonical)
        return raw
    }

    func testFormalWatchReceiptValidationPreservesUUIDv7SourceAndRejectsCanaryRevocationAndDrift() throws {
        let id: (Int) -> String = { "018f0000-0000-7000-8000-0000000000" + String(format: "%02d", $0) }
        let reference: (String, String, String) -> [String: Any] = { type, refID, digit in
            ["ref_type": type, "ref_id": refID, "object_version": "1", "canonical_payload_sha256": String(repeating: digit, count: 64)] }
        let session = reference("RealtimeSession", id(2), "b"), lease = reference("DeviceLease", id(3), "c")
        let binding = try JSONDecoder().decode(RealtimeEnrollmentBinding.self, from: JSONSerialization.data(withJSONObject: [
            "realtime_session_ref": session, "device_lease_ref": lease, "continuity_id": id(4), "connection_epoch": "1"]))
        let watchLease = reference("DeviceLease", id(15), "e")
        var formal: [String: Any] = ["bindingId": id(10), "expiresAt": "2027-01-01T00:00:00.000Z", "idempotencyKey": "formal-register-1", "issuedAt": "2026-01-01T00:00:00.000Z", "kind": "t02.apple.watch-binding.v1", "objectVersion": "1", "realtimeSessionRef": session, "requestFingerprintSha256": String(repeating: "a", count: 64), "requestId": "formal-register-1", "pairVersion": "1", "installationId": "11111111-1111-4111-8111-111111111111", "userId": id(11), "principalRef": "distinct-principal", "status": "active", "iphone": ["deviceId": id(12), "clientInstanceId": id(13), "deviceLeaseRef": lease], "watch": ["deviceId": id(14), "clientInstanceId": id(16), "deviceLeaseRef": watchLease]]
        let now = Date(timeIntervalSince1970: 1_780_000_000)
        func validated(_ value: [String: Any]) throws -> RealtimeFormalWatchBinding {
            var receipt = value
            receipt.removeValue(forKey: "canonicalPayloadSha256")
            let canonical = try JSONSerialization.data(withJSONObject: receipt, options: [.sortedKeys, .withoutEscapingSlashes])
            receipt["canonicalPayloadSha256"] = e2eeSHA256Hex(Data("paios.t02.apple-watch-binding.receipt.v1\n".utf8) + canonical)
            let decoded = try JSONDecoder().decode(RealtimeFormalWatchBinding.self, from: JSONSerialization.data(withJSONObject: receipt))
            try RealtimeControlValidation.validateFormalWatch(decoded, raw: receipt, binding: binding, now: now)
            return decoded
        }
        XCTAssertEqual(try validated(formal).origin?.deviceID, id(14))
        formal["watch"] = ["deviceId": id(17), "clientInstanceId": id(18), "deviceLeaseRef": watchLease]
        formal["pairVersion"] = "2"
        XCTAssertEqual(try validated(formal).origin?.deviceID, id(17))
        formal["status"] = "revoked"
        XCTAssertThrowsError(try validated(formal))
        formal["status"] = "active"
        formal["kind"] = "t02.apple.physical-canary-binding.v1"
        XCTAssertThrowsError(try validated(formal))
        formal["kind"] = "t02.apple.watch-binding.v1"
        formal["realtimeSessionRef"] = watchLease
        XCTAssertThrowsError(try validated(formal))
    }

    private static let pairedDeviceID = "01a11111-0000-7000-8000-000000000002"

    @MainActor
    func testPlaceRetriesKeepIdenticalEventsAndFreshEventsBypassBackoffWhileMainKeychainLocked() async throws {
        let h = try placeHarness(); defer { try? FileManager.default.removeItem(at: h.root) }
        h.main.loadError = .unavailable
        let event = placeEvent()
        try h.database.persistPlaceEvent(event, identity: h.service.state.identity!)
        RealtimeURLProtocolSpy.handler = { _ in throw URLError(.networkConnectionLost) }
        let failed = await h.service.flush(); XCTAssertFalse(failed)
        XCTAssertEqual(try h.database.pendingPlaceEvents(), [event])
        let blocked = await h.service.flush(); XCTAssertTrue(blocked)
        XCTAssertEqual(RealtimeURLProtocolSpy.requestCount, 1, "A retry-only trigger respects the backoff")
        RealtimeURLProtocolSpy.handler = { [self] request in
            if RealtimeURLProtocolSpy.requestCount == 2 { throw URLError(.networkConnectionLost) } // Garage: one more loss.
            return try placeUploadResponse(request)
        }
        let fresh = placeEvent()
        h.service.capture(fresh)
        for _ in 0..<500 where !((try? h.database.pendingPlaceEvents().isEmpty) ?? false) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let sent = try RealtimeURLProtocolSpy.observations.map { try JSONSerialization.jsonObject(with: $0.body!) as! [String: Any] }
        XCTAssertEqual(sent.count, 3, "The fresh event skips the backoff and retries once within the same wake")
        let first = sent[0]["events"] as! [[String: Any]], last = sent[2]["events"] as! [[String: Any]]
        XCTAssertEqual(last.map { $0["id"] as! String }, [event.id, fresh.id])
        XCTAssertEqual(first[0] as NSDictionary, last[0] as NSDictionary)
        let request = RealtimeURLProtocolSpy.observations[2]
        XCTAssertEqual(request.authorization, "Bearer " + String(repeating: "p", count: 43))
        XCTAssertEqual(request.contentLength, String(request.body!.count)); XCTAssertNil(request.query)
        XCTAssertNotNil(h.service.state.lastUpload)
    }

    @MainActor
    func testPlacePoisonBatchesIsolateAndDropOnlyOffendingEvents() async throws {
        for (status, code) in [(400, "INVALID_CAPTURED_AT"), (409, "PLACE_REGION_UNKNOWN"), (413, "BODY_TOO_LARGE"), (422, "PLACE_SCHEMA_INVALID")] {
            RealtimeURLProtocolSpy.reset()
            let h = try placeHarness(); defer { try? FileManager.default.removeItem(at: h.root) }
            let bad = placeEvent(), good = placeEvent()
            try h.database.persistPlaceEvent(bad, identity: h.service.state.identity!)
            try h.database.persistPlaceEvent(good, identity: h.service.state.identity!)
            RealtimeURLProtocolSpy.handler = { [self] request in
                let body = try JSONSerialization.jsonObject(with: RealtimeURLProtocolSpy.observations.last!.body!) as! [String: Any]
                let events = body["events"] as! [[String: Any]]
                if events.contains(where: { $0["id"] as? String == bad.id }) {
                    return response(for: request, statusCode: status, body: try JSONSerialization.data(withJSONObject: ["error": code]))
                }
                return try placeUploadResponse(request)
            }
            let uploaded = await h.service.flush(); XCTAssertTrue(uploaded, code)
            XCTAssertTrue(try h.database.pendingPlaceEvents().isEmpty)
            let sent = try RealtimeURLProtocolSpy.observations.map { try JSONSerialization.jsonObject(with: $0.body!) as! [String: Any] }
            XCTAssertEqual(sent.count, 3, "One rejected batch, one dropped event, one preserved event")
            XCTAssertEqual((sent[2]["events"] as! [[String: Any]]).map { $0["id"] as! String }, [good.id])
        }
    }

    @MainActor
    func testPlaceUnauthorizedKeepsEventsUntilMainCredentialCanRotate() async throws {
        let h = try placeHarness(); defer { try? FileManager.default.removeItem(at: h.root) }
        let event = placeEvent(); try h.database.persistPlaceEvent(event, identity: h.service.state.identity!)
        h.main.loadError = .unavailable
        RealtimeURLProtocolSpy.handler = { [self] request in response(for: request, statusCode: 401, body: Data("{\"error\":\"PLACE_CREDENTIAL_DENIED\"}".utf8)) }
        let locked = await h.service.flush(); XCTAssertFalse(locked)
        XCTAssertEqual(try h.database.pendingPlaceEvents(), [event])
        h.main.loadError = nil
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path == "/v1/place/credential" { return try placeCredentialResponse(request) }
            return try placeUploadResponse(request)
        }
        let recovered = await h.service.flush(force: true); XCTAssertTrue(recovered)
        let requests = RealtimeURLProtocolSpy.observations
        XCTAssertEqual(requests.map(\.path), ["/v1/place/upload", "/v1/place/credential", "/v1/place/upload"])
        let rotation = try JSONSerialization.jsonObject(with: requests[1].body!) as! [String: String]
        XCTAssertEqual(rotation["action"], "rotate"); XCTAssertEqual(requests[1].authorization, "Bearer " + (try RealtimeDevicePairing.decode(h.main.data!).token))
        XCTAssertEqual(requests[2].authorization, "Bearer " + String(repeating: "r", count: 43))
        XCTAssertEqual(requests[0].body, requests[2].body)
    }

    @MainActor
    func testPlaceMalformedAcknowledgementRetainsEventsThenDuplicateAndExpiryDrain() async throws {
        let h = try placeHarness(); defer { try? FileManager.default.removeItem(at: h.root) }
        let duplicate = placeEvent(), expired = placeEvent()
        for event in [duplicate, expired] { try h.database.persistPlaceEvent(event, identity: h.service.state.identity!) }
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, body: try JSONEncoder().encode(PlaceUploadResponse(schema: "paios.place-upload-response.v1",
                stored_ids: [], duplicate_ids: [], expired_ids: [], regions: PlaceRegionSet(version: 0, items: nil))))
        }
        let invalid = await h.service.flush(); XCTAssertFalse(invalid)
        XCTAssertEqual(try h.database.pendingPlaceEvents(), [duplicate, expired])
        RealtimeURLProtocolSpy.handler = { [self] request in
            response(for: request, body: try JSONEncoder().encode(PlaceUploadResponse(schema: "paios.place-upload-response.v1",
                stored_ids: [], duplicate_ids: [duplicate.id], expired_ids: [expired.id], regions: PlaceRegionSet(version: 0, items: nil))))
        }
        let drained = await h.service.flush(force: true); XCTAssertTrue(drained)
        XCTAssertTrue(try h.database.pendingPlaceEvents().isEmpty)
    }

    @MainActor
    func testPlacePoisonIsolationSurvivesServiceRelaunch() async throws {
        let h = try placeHarness(); defer { try? FileManager.default.removeItem(at: h.root) }
        for _ in 0..<2 { try h.database.persistPlaceEvent(placeEvent(), identity: h.service.state.identity!) }
        RealtimeURLProtocolSpy.handler = { [self] request in
            if RealtimeURLProtocolSpy.requestCount == 1 {
                return response(for: request, statusCode: 400, body: Data("{\"error\":\"PLACE_UPLOAD_INVALID\"}".utf8))
            }
            throw URLError(.networkConnectionLost)
        }
        let interrupted = await h.service.flush(); XCTAssertFalse(interrupted)
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [RealtimeURLProtocolSpy.self]
        let reopened = try AssistantLocalOperationDatabase(url: h.database.databaseURL)
        let restored = try PlaceSensingService(database: reopened, location: LocationService(manager: PlaceTestManager()),
            client: PlaceGatewayClient(session: URLSession(configuration: configuration)), credentials: h.credentials,
            pairingProvider: PairedRealtimeRequestBodyProvider(store: h.main))
        RealtimeURLProtocolSpy.reset()
        RealtimeURLProtocolSpy.handler = { [self] request in try placeUploadResponse(request) }
        let drained = await restored.flush(force: true); XCTAssertTrue(drained)
        let batches = try RealtimeURLProtocolSpy.observations.map { try JSONSerialization.jsonObject(with: $0.body!) as! [String: Any] }
        XCTAssertEqual(batches.count, 2)
        XCTAssertTrue(batches.allSatisfy { ($0["events"] as! [Any]).count == 1 })
    }

    @MainActor
    func testPlaceEnableFullRegionSyncThenVersionedReplacementAndSwitchOff() async throws {
        let h = try placeHarness(enabled: false); defer { try? FileManager.default.removeItem(at: h.root) }
        try h.credentials.save(nil)
        let home = PlaceRegion(id: "home", label: "家", latitude: 3, longitude: 4, radius_m: 100)
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path == "/v1/place/credential" { return try placeCredentialResponse(request) }
            return try placeUploadResponse(request, regions: PlaceRegionSet(version: 1, items: [home]))
        }
        await h.service.setEnabled(true)
        let first = try JSONSerialization.jsonObject(with: RealtimeURLProtocolSpy.observations.last!.body!) as! [String: Any]
        XCTAssertEqual((first["events"] as! [Any]).count, 0); XCTAssertNil(first["region_version"])
        XCTAssertEqual(h.service.monitoredRegionCount, 1)
        let started = h.manager.starts.count
        RealtimeURLProtocolSpy.handler = { [self] request in try placeUploadResponse(request, regions: PlaceRegionSet(version: 1, items: nil)) }
        await h.service.flush(force: true)
        XCTAssertEqual(h.manager.starts.count, started)
        let updated = PlaceRegion(id: "home", label: "家", latitude: 5, longitude: 6, radius_m: 200)
        RealtimeURLProtocolSpy.handler = { [self] request in try placeUploadResponse(request, regions: PlaceRegionSet(version: 2, items: [updated])) }
        await h.service.flush(force: true)
        XCTAssertEqual(h.manager.starts.last?.radius, 200); XCTAssertEqual(h.manager.starts.last?.center.latitude, 5)
        try h.database.persistPlaceEvent(placeEvent(), identity: h.service.state.identity!)
        h.main.loadError = .unavailable
        await h.service.setEnabled(false)
        XCTAssertFalse(h.service.state.enabled); XCTAssertEqual(h.service.monitoredRegionCount, 0)
        XCTAssertTrue(try h.database.pendingPlaceEvents().isEmpty); XCTAssertNil(try h.credentials.load())
        h.main.loadError = nil
        RealtimeURLProtocolSpy.handler = { [self] request in try placeCredentialResponse(request) }
        await h.service.flush(force: true)
        let revoked = try JSONSerialization.jsonObject(with: RealtimeURLProtocolSpy.observations.last!.body!) as! [String: String]
        XCTAssertEqual(revoked["action"], "revoke"); XCTAssertFalse(h.service.state.revokePending)
    }

    @MainActor
    func testPairingReplacementKeepsPlaceConsentAndReissuesToken() async throws {
        let h = try placeHarness(); defer { try? FileManager.default.removeItem(at: h.root) }
        try h.database.persistPlaceEvent(placeEvent(), identity: h.service.state.identity!)
        try h.database.replacePairing(data: pairingData { $0["paired_at"] = "2026-10-13T16:00:00.000Z" }, store: h.main)
        XCTAssertTrue(try h.database.pendingPlaceEvents().isEmpty, "The old pairing's outbox goes")
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url!.path == "/v1/place/credential" { return try placeCredentialResponse(request) }
            return try placeUploadResponse(request)
        }
        let synced = await h.service.flush(force: true); XCTAssertTrue(synced)
        let identity = CentralOwnerDataIdentity.pairing(try RealtimeDevicePairing.decode(h.main.data!))
        XCTAssertTrue(h.service.state.enabled); XCTAssertEqual(h.service.state.identity, identity)
        XCTAssertEqual(try h.credentials.load()?.pairingIdentity, identity)
        let requests = RealtimeURLProtocolSpy.observations
        XCTAssertEqual(requests.map(\.path), ["/v1/place/credential", "/v1/place/upload"])
        XCTAssertEqual((try JSONSerialization.jsonObject(with: requests[0].body!) as! [String: String])["action"], "rotate")
        XCTAssertNil((try JSONSerialization.jsonObject(with: requests[1].body!) as! [String: Any])["region_version"])
    }

    private func placeEvent() -> PlaceEvent {
        let at = Date(timeIntervalSince1970: 1_700_000_000)
        return PlaceEvent(kind: .visitArrival, location: AssistantLocationObservation(localCaptureID: "capture",
            latitude: 3, longitude: 4, horizontalAccuracy: 10, observedAt: at), arrivalAt: at)
    }

    @MainActor
    private func placeHarness(enabled: Bool = true) throws -> (root: URL, database: AssistantLocalOperationDatabase,
        main: RealtimeTestPairingStore, credentials: PlaceTestCredentials, manager: PlaceTestManager, service: PlaceSensingService) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("place-\(UUID().uuidString)")
        let database = try AssistantLocalOperationDatabase(url: root.appendingPathComponent("operations.sqlite"))
        let main = RealtimeTestPairingStore(); try main.replacePairingData(pairingData())
        let pairing = try RealtimeDevicePairing.decode(main.data!)
        var state = PlaceSensingState(); state.enabled = enabled; state.identity = CentralOwnerDataIdentity.pairing(pairing)
        state.regionVersion = 0; try database.savePlaceState(state, clearOutbox: true)
        let credentials = PlaceTestCredentials(); try credentials.save(PlaceCredential(pairing: pairing, token: String(repeating: "p", count: 43)))
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [RealtimeURLProtocolSpy.self]
        let manager = PlaceTestManager(), location = LocationService(manager: manager)
        let service = try PlaceSensingService(database: database, location: location,
            client: PlaceGatewayClient(session: URLSession(configuration: configuration)), credentials: credentials,
            pairingProvider: PairedRealtimeRequestBodyProvider(store: main))
        return (root, database, main, credentials, manager, service)
    }

    private func placeUploadResponse(_ request: URLRequest, regions: PlaceRegionSet = PlaceRegionSet(version: 0, items: [])) throws -> (HTTPURLResponse, Data) {
        let body = try JSONSerialization.jsonObject(with: RealtimeURLProtocolSpy.observations.last!.body!) as! [String: Any]
        return response(for: request, body: try JSONEncoder().encode(PlaceUploadResponse(schema: "paios.place-upload-response.v1",
            stored_ids: (body["events"] as! [[String: Any]]).map { $0["id"] as! String }, duplicate_ids: [], expired_ids: [], regions: regions)))
    }

    private func placeCredentialResponse(_ request: URLRequest) throws -> (HTTPURLResponse, Data) {
        let body = try JSONSerialization.jsonObject(with: RealtimeURLProtocolSpy.observations.last!.body!) as! [String: String]
        var receipt: [String: Any] = ["schema": "paios.place-credential.v1", "device_id": body["device_id"]!, "scope": "place_upload"]
        if body["action"] == "revoke" { receipt["revoked"] = true } else { receipt["token"] = String(repeating: "r", count: 43) }
        return response(for: request, body: try JSONSerialization.data(withJSONObject: receipt))
    }

    private func pairingData(_ mutate: (inout [String: Any]) -> Void = { _ in }) throws -> Data {
        var object: [String: Any] = [
            "schema": RealtimeDevicePairing.schema,
            "origin": RealtimeAPIOriginMigration.legacyOrigin,
            "device_id": Self.pairedDeviceID,
            "user_id": "01a11111-0000-7000-8000-000000000001",
            "token": "paired-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "governance": [
                "purpose_scopes": ["cycling_assistant"],
                "consent_record_refs": ["01a11111-0000-7000-8000-000000000003"],
                "policy_decision_refs": ["01a11111-0000-7000-8000-000000000004"],
                "purpose_token_refs": ["01a11111-0000-7000-8000-000000000005"],
                "capability_grant_refs": ["01a11111-0000-7000-8000-000000000006"]
            ],
            "media": ["audio", "data"],
            "paired_at": "2026-10-06T16:00:00.000Z"
        ]
        mutate(&object)
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func pairingInput(_ data: Data, permissions: Int) throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("pairing-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let input = root.appendingPathComponent("device-pairing.v1.json")
        try data.write(to: input)
        try FileManager.default.setAttributes([.posixPermissions: NSNumber(value: permissions)], ofItemAtPath: input.path)
        return (root, input)
    }

    /// The context binds this body: same request id, scope target, the paired owner, and a request hash over the
    /// body without the context.
    private func assertIdempotencyContext(_ object: [String: Any], kind: String, targetType: String, targetID: String?,
                                          file: StaticString = #filePath, line: UInt = #line) throws {
        let context = try XCTUnwrap(object["idempotency_context"] as? [String: Any], file: file, line: line)
        let scope = try XCTUnwrap(context["idempotency_scope"] as? [String: Any], file: file, line: line)
        XCTAssertEqual(context["idempotency_key"] as? String, object["request_id"] as? String, file: file, line: line)
        XCTAssertTrue(RealtimeUUIDv7.isValid(try XCTUnwrap(object["request_id"] as? String)), file: file, line: line)
        XCTAssertEqual(scope["operation_kind"] as? String, kind, file: file, line: line)
        XCTAssertEqual(scope["target_object_type"] as? String, targetType, file: file, line: line)
        XCTAssertEqual(scope["target_object_id"] as? String, targetID, file: file, line: line)
        XCTAssertEqual(scope["user_id"] as? String, "01a11111-0000-7000-8000-000000000001", file: file, line: line)
        XCTAssertEqual((context["idempotency_profile_sha256"] as? String)?.count, 64, file: file, line: line)
        var withoutContext = object
        withoutContext.removeValue(forKey: "idempotency_context")
        let canonical = try JSONSerialization.data(withJSONObject: withoutContext, options: [.sortedKeys, .withoutEscapingSlashes])
        XCTAssertEqual(context["idempotency_request_sha256"] as? String, e2eeSHA256Hex(canonical), file: file, line: line)
    }

    private func context(
        _ operation: RealtimePublicControlOperation
    ) -> RealtimeCanonicalRequestContext {
        RealtimeCanonicalRequestContext(
            operation: operation,
            localBinding: "local-\(operation.rawValue)"
        )
    }

    private func fixture(_ name: String) -> Data {
#if SWIFT_PACKAGE
        let bundle = Bundle.module
        let subdirectory: String? = "Fixtures/RealtimePublicControl"
#else
        let bundle = Bundle(for: Self.self)
        let subdirectory: String? = nil
#endif
        let url = bundle.url(
            forResource: name.replacingOccurrences(of: ".json", with: ""),
            withExtension: "json", subdirectory: subdirectory
        )!
        return try! Data(contentsOf: url)
    }

    private func response(
        for request: URLRequest,
        statusCode: Int = 200,
        body: Data
    ) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": String(body.count)
                ]
            )!,
            body
        )
    }

    private func bootstrapResponse(
        roomName: String,
        sessionID: String,
        leaseID: String,
        continuityID: String,
        connectionEpoch: String
    ) -> Data {
        var object = try! JSONSerialization.jsonObject(
            with: fixture("bootstrap-response.valid.json")
        ) as! [String: Any]
        var session = object["realtime_session_ref"] as! [String: Any]
        session["ref_id"] = sessionID
        object["realtime_session_ref"] = session
        var lease = object["device_lease_ref"] as! [String: Any]
        lease["ref_id"] = leaseID
        object["device_lease_ref"] = lease
        object["continuity_id"] = continuityID
        object["connection_epoch"] = connectionEpoch
        var e2ee = object["e2ee_key_envelope"] as! [String: Any]
        var e2eeSession = e2ee["realtime_session_ref"] as! [String: Any]
        e2eeSession["ref_id"] = sessionID
        e2ee["realtime_session_ref"] = e2eeSession
        e2ee["continuity_id"] = continuityID
        object["e2ee_key_envelope"] = e2ee
        var aliases = object["transport_aliases"] as! [[String: Any]]
        for i in aliases.indices
        where aliases[i]["alias_type"] as? String == "room" {
            aliases[i]["value"] = roomName
        }
        object["transport_aliases"] = aliases
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func e2eeVectorRegistrationContext()
        -> RealtimeE2EERecipientRegistrationContext {
        RealtimeE2EERecipientRegistrationContext(
            deviceID: "018f0e0e-0000-7000-8000-000000000004",
            deviceCredentialRef: RealtimeCanonicalReference(
                refType: "DeviceCredential",
                refID: "018f0e0e-0000-7000-8000-000000000006",
                objectVersion: "3",
                canonicalPayloadSha256: String(repeating: "3", count: 64)
            ),
            audience: RealtimeTransportAlias(
                aliasType: "participant",
                issuer: "paios",
                value: "aud-001"
            ),
            realtimeSessionRef: RealtimeCanonicalReference(
                refType: "RealtimeSession",
                refID: "018f0e0e-0000-7000-8000-000000000001",
                objectVersion: "1",
                canonicalPayloadSha256: String(repeating: "1", count: 64)
            ),
            deviceLeaseRef: RealtimeCanonicalReference(
                refType: "DeviceLease",
                refID: "018f0e0e-0000-7000-8000-000000000002",
                objectVersion: "2",
                canonicalPayloadSha256: String(repeating: "2", count: 64)
            ),
            continuityID: "018f0e0e-0000-7000-8000-000000000003",
            expiresAt: "2026-08-23T12:00:00.000Z"
        )
    }

    private func e2eeVectorRequest() -> Data {
        let object: [String: Any] = [
            "operation": "realtime_e2ee_key_resolve",
            "request_id": "req-test-00000001",
            "idempotency_context": [
                "idempotency_scope": [
                    "owner_module": "T11B",
                    "operation_kind": "realtime_e2ee_key_resolve",
                    "target_object_type": "RealtimeSession"
                ],
                "idempotency_key": "idem-test-00000001",
                "idempotency_profile_id": "https://personal-ai-os.local/contracts/realtime/realtime-e2ee-key-resolve-request.v1.schema.json",
                "idempotency_profile_version": "1.0.0",
                "idempotency_profile_sha256": String(repeating: "4", count: 64),
                "idempotency_request_sha256": String(repeating: "5", count: 64)
            ],
            "realtime_session_ref": e2eeReference(
                type: "RealtimeSession",
                id: "018f0e0e-0000-7000-8000-000000000001",
                version: "1",
                hash: String(repeating: "1", count: 64)
            ),
            "device_lease_ref": e2eeReference(
                type: "DeviceLease",
                id: "018f0e0e-0000-7000-8000-000000000002",
                version: "2",
                hash: String(repeating: "2", count: 64)
            ),
            "continuity_id": "018f0e0e-0000-7000-8000-000000000003",
            "connection_epoch": "7",
            "transport_aliases": [
                ["alias_type": "room", "issuer": "test_provider", "value": "room-001"]
            ],
            "key_envelope_ref": [
                "alias_type": "key_envelope", "issuer": "paios", "value": "env-001"
            ],
            "key_index": 0,
            "key_generation": "1",
            "device_id": "018f0e0e-0000-7000-8000-000000000004",
            "recipient_device_credential_ref": e2eeReference(
                type: "DeviceCredential",
                id: "018f0e0e-0000-7000-8000-000000000006",
                version: "3",
                hash: String(repeating: "3", count: 64)
            ),
            "participant_audience": [
                "alias_type": "participant", "issuer": "paios", "value": "aud-001"
            ],
            "governance": [
                "purpose_scopes": ["realtime_audio"],
                "consent_record_refs": ["018f0e0e-0000-7000-8000-000000000007"],
                "policy_decision_refs": ["018f0e0e-0000-7000-8000-000000000008"],
                "purpose_token_refs": ["018f0e0e-0000-7000-8000-000000000009"],
                "capability_grant_refs": ["018f0e0e-0000-7000-8000-00000000000a"]
            ]
        ]
        return try! JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys]
        )
    }

    private func e2eeVectorResponse() -> Data {
        var object = try! JSONSerialization.jsonObject(
            with: e2eeVectorRequest()
        ) as! [String: Any]
        object["status"] = "key_resolved"
        object["expires_at"] = "2026-08-23T12:00:00.000Z"
        object["cipher_suite"] =
            "DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM"
        object["encapsulated_key"] =
            "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ"
        object["ciphertext"] =
            "80px7iyqSyW9aG4Hm-qP07n9JIVfc8kfzblrpRIdo4e3_m13kEeP86xUOW_I6vDUFx51AOPwa4ys8jMLf9U10g"
        object["aad_sha256"] =
            "5dcb52c670cc00be562f9ab41fb2ae14c2e89253a435d2a0569f64635a23fc9b"
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func e2eeReference(
        type: String,
        id: String,
        version: String,
        hash: String
    ) -> [String: Any] {
        [
            "ref_type": type,
            "ref_id": id,
            "object_version": version,
            "canonical_payload_sha256": hash
        ]
    }

    private func e2eeVectorPrivateKey() -> Data {
        Data([
            0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
            0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
            0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
            0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f
        ])
    }

    private func e2eeVectorContentKey() -> Data {
        Data([
            0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
            0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
            0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
            0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf
        ])
    }

    private func e2eeSHA256Hex(_ data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func mediaStopBody(
        binding: RealtimeBootstrapLocalBinding,
        requestID: String
    ) -> Data {
        var object = try! JSONSerialization.jsonObject(
            with: fixture("media-stop.valid.json")
        ) as! [String: Any]
        object["request_id"] = requestID
        object["realtime_session_ref"] = referenceObject(
            binding.realtimeSessionRef
        )
        object["device_lease_ref"] = referenceObject(
            binding.deviceLeaseRef
        )
        object["continuity_id"] = binding.continuityID
        object["connection_epoch"] = binding.connectionEpoch
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func referenceObject(
        _ reference: RealtimeCanonicalReference
    ) -> [String: Any] {
        [
            "ref_type": reference.refType,
            "ref_id": reference.refID,
            "object_version": reference.objectVersion,
            "canonical_payload_sha256":
                reference.canonicalPayloadSha256
        ]
    }

    private func handoffTerminalResponse() -> Data {
        let envelope = try! JSONSerialization.jsonObject(
            with: fixture("handoff.valid.json")
        ) as! [String: Any]
        return try! JSONSerialization.data(
            withJSONObject: envelope["terminal_result"]!
        )
    }

    private func handoffRequest() -> Data {
        let object = try! JSONSerialization.jsonObject(with: fixture("handoff.valid.json")) as! [String: Any]
        return try! JSONSerialization.data(withJSONObject: object["request"]!)
    }

    private func credentialRefreshResponse(request: Data? = nil) -> Data {
        var object = try! JSONSerialization.jsonObject(with: request ?? fixture("credential-refresh.valid.json")) as! [String: Any]
        object.removeValue(forKey: "idempotency_context")
        object.removeValue(forKey: "refresh_reason")
        object["status"] = "credential_refreshed"
        object["transport_credential"] = ["credential": "fixture-transport-credential", "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600)), "credential_generation": "2"]
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func endContinuityRequest() -> Data {
        var object = try! JSONSerialization.jsonObject(with: fixture("credential-refresh.valid.json")) as! [String: Any]
        for key in ["device_lease_ref", "transport_aliases", "refresh_reason"] { object.removeValue(forKey: key) }
        object["operation"] = "end_continuity"
        object["confirmation"] = "explicit_user_end_continuity"
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func endContinuityResponse() -> Data {
        var object = try! JSONSerialization.jsonObject(with: endContinuityRequest()) as! [String: Any]
        let context = object.removeValue(forKey: "idempotency_context")!
        object.removeValue(forKey: "confirmation")
        object["status"] = "success"
        let handoff = try! JSONSerialization.jsonObject(with: handoffTerminalResponse()) as! [String: Any]
        var outcome = handoff["operation_outcome"] as! [String: Any]
        var recorded = outcome["recorded_result_ref"] as! [String: Any]
        recorded["idempotency_context"] = context
        outcome["recorded_result_ref"] = recorded
        object["operation_outcome"] = outcome
        object["execution_facts"] = ["closure_status": "not_applicable"]
        return try! JSONSerialization.data(withJSONObject: object)
    }

    private func stopResponse(
        canonicalBody: Data? = nil,
        status: String = "success",
        outcomeClass: String = "committed_success",
        closureStatus: String = "verified_closed",
        deviceLeaseRelease: String = "released",
        participantCleanup: String = "verified_absent",
        trackCleanup: String = "verified_absent",
        roomCleanup: String = "verified_absent",
        responseRequestID: String? = nil,
        responseSessionID: String? = nil
    ) -> Data {
        var object = try! JSONSerialization.jsonObject(
            with: canonicalBody ?? fixture("media-stop.valid.json")
        ) as! [String: Any]
        object["status"] = status
        if let responseRequestID {
            object["request_id"] = responseRequestID
        }
        if let responseSessionID {
            var session = object["realtime_session_ref"] as! [String: Any]
            session["ref_id"] = responseSessionID
            object["realtime_session_ref"] = session
        }
        object["operation_outcome"] = [
            "outcome_class": outcomeClass,
            "resolution_mode": "direct"
        ]
        object["execution_facts"] = [
            "closure_status": closureStatus,
            "device_lease_release": deviceLeaseRelease,
            "participant_cleanup": participantCleanup,
            "track_cleanup": trackCleanup,
            "room_cleanup": roomCleanup
        ]
        return try! JSONSerialization.data(withJSONObject: object)
    }
}

private func deleteE2EEKeychainItem(service: String) {
    for account in [
        KeychainE2EERecipientKeyStore.account,
        KeychainE2EERecipientKeyStore.zeroizedMigrationMarkerAccount
    ] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
        _ = SecItemDelete(query as CFDictionary)
    }
}

private final class RealtimeDelayedResponseGate:
    @unchecked Sendable {
    private let entered = DispatchSemaphore(value: 0)
    private let released = DispatchSemaphore(value: 0)

    func block() {
        entered.signal()
        released.wait()
    }

    func waitUntilBlocked() -> Bool {
        entered.wait(timeout: .now() + 5) == .success
    }

    func release() {
        released.signal()
    }
}

private final class RealtimeAtomicCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> Int {
        lock.withLock {
            value += 1
            return value
        }
    }
}

private actor RealtimeCanonicalContextRecorder {
    private var contexts: [RealtimeCanonicalRequestContext] = []

    func record(_ context: RealtimeCanonicalRequestContext) {
        contexts.append(context)
    }

    func lastContext(
        for operation: RealtimePublicControlOperation
    ) -> RealtimeCanonicalRequestContext? {
        contexts.last { $0.operation == operation }
    }
}

private actor RealtimeTestSettingsStore: SettingsStoring {
    private var settings: AppSettings

    init(settings: AppSettings) {
        self.settings = settings
    }

    func loadSettings() throws -> AppSettings {
        settings
    }

    func saveSettings(_ settings: AppSettings) throws {
        self.settings = settings
    }

    func loadConsent() throws -> ConsentReceipt? {
        nil
    }

    func saveConsent(_ receipt: ConsentReceipt?) throws {
        _ = receipt
    }
}

private final class RealtimeTestCredentialStore:
    CredentialStoring,
    @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String]
    private var index = 0
    private var calls = 0

    init(tokens: [String]) {
        self.tokens = tokens
    }

    var apiTokenCallCount: Int {
        lock.withLock { calls }
    }

    func apiToken() throws -> String? {
        lock.withLock {
            calls += 1
            guard !tokens.isEmpty else {
                return nil
            }
            let selected = tokens[min(index, tokens.count - 1)]
            index += 1
            return selected
        }
    }

    func apiToken(for origin: String) throws -> String? {
        try apiToken()
    }

    func setAPIToken(_ token: String) throws {
        lock.withLock {
            tokens = token.isEmpty ? [] : [token]
            index = 0
        }
    }

    func deviceID() throws -> UUID {
        UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    }
}

private final class RealtimeTestE2EERecipientKeyStore:
    E2EERecipientKeyStoring,
    @unchecked Sendable {
    private let privateKey: Curve25519.KeyAgreement.PrivateKey

    init(rawRepresentation: Data) {
        privateKey = try! Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: rawRepresentation
        )
    }

    func loadOrCreateRecipientPrivateKey()
        throws -> Curve25519.KeyAgreement.PrivateKey {
        privateKey
    }
}

private final class RealtimeTestPairingStore: RealtimeDevicePairingStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var storedData: Data?
    var data: Data? { lock.withLock { storedData } }
    private(set) var replaceCallCount = 0
    var replaceError: RealtimeDevicePairingError?
    var loadError: RealtimeDevicePairingError?

    func loadPairingData() throws -> Data? {
        try lock.withLock {
            if let loadError { throw loadError }
            return storedData
        }
    }

    func replacePairingData(_ data: Data) throws {
        try lock.withLock { try replaceUnlocked(data) }
    }

    func replacePairingData(_ data: Data, ifCurrent expected: Data) throws -> Bool {
        try lock.withLock {
            guard storedData == expected else { return false }
            try replaceUnlocked(data)
            return true
        }
    }

    private func replaceUnlocked(_ data: Data) throws {
        replaceCallCount += 1
        if let replaceError { throw replaceError }
        storedData = data
    }
}

private final class RealtimeOriginTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = Date(timeIntervalSince1970: 1_800_000_000)
    private var reads = 0
    var onRead: (@Sendable (Int) -> Void)?
    func now() -> Date {
        let (value, count) = lock.withLock { reads += 1; return (instant, reads) }
        onRead?(count)
        return value
    }
    func advance(_ seconds: TimeInterval) { lock.withLock { instant.addTimeInterval(seconds) } }
}

private struct RealtimeObservedRequest: Equatable {
    let absoluteURL: String
    let path: String
    let query: String?
    let method: String?
    let authorization: String?
    let contentType: String?
    let contentLength: String?
    let transferEncoding: String?
    let idempotencyKey: String?
    let body: Data?
}

private final class RealtimeURLProtocolSpy: URLProtocol {
    typealias Handler = (
        URLRequest
    ) throws -> (HTTPURLResponse, Data)

    private static let lock = NSLock()
    private static let handlerQueue = DispatchQueue(
        label: "ai.personalaios.tests.realtime-url-protocol",
        qos: .userInitiated,
        attributes: .concurrent
    )
    private static var storedHandler: Handler?
    private static var storedObservations: [RealtimeObservedRequest] = []
    private static var storedHoldResponseOpen = false
    static var holdResponseOpen: Bool {
        get { lock.withLock { storedHoldResponseOpen } }
        set { lock.withLock { storedHoldResponseOpen = newValue } }
    }
    private static var storedOnStop: (@Sendable (URLRequest) -> Void)?
    static var onStop: (@Sendable (URLRequest) -> Void)? {
        get { lock.withLock { storedOnStop } }
        set { lock.withLock { storedOnStop = newValue } }
    }

    private let stateLock = NSLock()
    private var stopped = false

    static var handler: Handler? {
        get {
            lock.withLock { storedHandler }
        }
        set {
            lock.withLock { storedHandler = newValue }
        }
    }

    static var observations: [RealtimeObservedRequest] {
        lock.withLock { storedObservations }
    }

    static var requestCount: Int {
        lock.withLock { storedObservations.count }
    }

    static func reset() {
        lock.withLock {
            storedHandler = nil
            storedObservations = []
            storedOnStop = nil
            storedHoldResponseOpen = false
        }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }

        stream.open()
        defer {
            stream.close()
        }

        let capacity = 16_384
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer {
            buffer.deallocate()
        }

        var body = Data()
        while true {
            let count = stream.read(buffer, maxLength: capacity)
            if count > 0 {
                body.append(buffer, count: count)
            } else if count == 0 {
                return body
            } else {
                return nil
            }
        }
    }

    override func startLoading() {
        let observedBody = Self.readBody(from: request)
        let components = request.url.flatMap {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)
        }
        Self.lock.withLock {
            Self.storedObservations.append(
                RealtimeObservedRequest(
                    absoluteURL: request.url?.absoluteString ?? "",
                    path: request.url?.path ?? "",
                    query: components?.query,
                    method: request.httpMethod,
                    authorization: request.value(
                        forHTTPHeaderField: "Authorization"
                    ),
                    contentType: request.value(
                        forHTTPHeaderField: "Content-Type"
                    ),
                    contentLength: request.value(
                        forHTTPHeaderField: "Content-Length"
                    ),
                    transferEncoding: request.value(
                        forHTTPHeaderField: "Transfer-Encoding"
                    ),
                    idempotencyKey: request.value(
                        forHTTPHeaderField: "Idempotency-Key"
                    ),
                    body: observedBody
                )
            )
        }

        let capturedRequest = request
        let capturedHandler = Self.handler
        Self.handlerQueue.async { [self] in
            guard let handler = capturedHandler else {
                self.deliver(error: URLError(.badServerResponse))
                return
            }
            do {
                let (response, data) = try handler(capturedRequest)
                self.deliver(response: response, data: data)
            } catch {
                self.deliver(error: error)
            }
        }
    }

    override func stopLoading() {
        stateLock.withLock {
            stopped = true
        }
        Self.onStop?(request)
    }

    private func deliver(
        response: HTTPURLResponse,
        data: Data
    ) {
        let shouldDeliver = stateLock.withLock { !stopped }
        guard shouldDeliver else {
            return
        }
        client?.urlProtocol(
            self,
            didReceive: response,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: data)
        if !Self.holdResponseOpen { client?.urlProtocolDidFinishLoading(self) }
    }

    private func deliver(error: Error) {
        let shouldDeliver = stateLock.withLock { !stopped }
        guard shouldDeliver else {
            return
        }
        client?.urlProtocol(self, didFailWithError: error)
    }
}

/// A consumer wrapper must preserve origin validation through the protocol witness.
private struct RealtimeDelegatingCredentialStore: CredentialStoring {
    let wrapped: any CredentialStoring

    func apiToken() throws -> String? { try wrapped.apiToken() }
    func apiToken(for origin: String) throws -> String? { try wrapped.apiToken(for: origin) }
    func setAPIToken(_ token: String) throws { try wrapped.setAPIToken(token) }
    func deviceID() throws -> UUID { try wrapped.deviceID() }
}

private final class PlaceTestCredentials: PlaceCredentialStoring, @unchecked Sendable {
    private var value: PlaceCredential?
    func load() throws -> PlaceCredential? { value }
    func save(_ credential: PlaceCredential?) throws { value = credential }
}

private final class PlaceTestManager: CLLocationManager {
    private var circles: Set<CLRegion> = []
    var starts: [CLCircularRegion] = []
    override var authorizationStatus: CLAuthorizationStatus { .authorizedAlways }
    override var monitoredRegions: Set<CLRegion> { circles }
    override func startMonitoring(for region: CLRegion) { circles.insert(region); starts.append(region as! CLCircularRegion) }
    override func stopMonitoring(for region: CLRegion) { circles.remove(region) }
#if os(iOS)
    override func startMonitoringVisits() {}
    override func stopMonitoringVisits() {}
#endif
}


extension RealtimePublicControlAdapterTests {
    func testPairingIdentityNotificationCarriesImmutableGenerationAndAuthenticationState() throws {
        let identity = RealtimePairingSessionIdentity()
        let pairing = try RealtimeDevicePairing.decode(pairingData())
        let posted = expectation(forNotification: RealtimePairingSessionIdentity.didChange, object: identity) { note in
            let change = note.userInfo?[RealtimePairingSessionIdentity.snapshotKey] as? RealtimePairingSessionIdentity.Snapshot
            return change?.generation == 1 && change?.identity == CentralOwnerDataIdentity.pairing(pairing)
        }
        identity.authenticate(pairing)
        wait(for: [posted], timeout: 1)
        let authenticated = identity.snapshot()
        identity.authenticate(pairing)
        XCTAssertEqual(identity.snapshot(), authenticated)
        identity.invalidate()
        XCTAssertNil(identity.snapshot().identity)
        XCTAssertEqual(identity.snapshot().generation, authenticated.generation + 1)
        XCTAssertNotEqual(identity.snapshot(), authenticated)
    }

    private func credentialFormalWatchReceipt() throws -> [String: Any] {
        let pairing = try RealtimeDevicePairing.decode(pairingData())
        return try formalWatchReceipt { raw in
            raw["userId"] = pairing.userID
            var phone = raw["iphone"] as! [String: Any]
            phone["deviceId"] = pairing.deviceID
            raw["iphone"] = phone
        }
    }

    func testWatchCredentialHTTPUsesPairedPhoneAndExactFrozenActions() async throws {
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")],
            credentials: PairedRealtimeCredentialStore(store: store))
        let preparation = RealtimeWatchPreparationSpy()
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path == "/v1/realtime/bootstrap" {
                return response(for: request, body: fixture("bootstrap-response.valid.json"))
            }
            let formal = try credentialFormalWatchReceipt()
            if request.url?.path == "/v1/realtime/watch-binding/read" {
                return response(for: request, body: try JSONSerialization.data(withJSONObject: ["operation": "watch_binding",
                    "pair_state": ["pair_version": "1", "status": "active", "requires_rebind": false], "binding": formal]))
            }
            XCTAssertEqual(request.url?.path, "/v1/realtime/watch-binding/credential")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertEqual(preparation.values.last!?.scope, WatchBindingScope(
                watch_device_id: (formal["watch"] as! [String: Any])["deviceId"] as! String, pair_version: "1"))
            let pairing = try RealtimeDevicePairing.decode(pairingData())
            XCTAssertEqual(preparation.values.last!?.principal, pairing.userID)
            XCTAssertEqual(preparation.values.last!?.pairingIdentity, CentralOwnerDataIdentity.pairing(pairing))
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            let bytes = try XCTUnwrap(RealtimeURLProtocolSpy.observations.last?.body)
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: String])
            XCTAssertEqual(Set(body.keys), ["action", "watch_device_id", "installation_id", "expected_pair_version", "request_id"])
            XCTAssertNotNil(body["request_id"].flatMap(UUID.init(uuidString:)))
            let watch = try XCTUnwrap(formal["watch"] as? [String: Any])
            XCTAssertEqual(body["watch_device_id"], watch["deviceId"] as? String)
            XCTAssertEqual(body["installation_id"], formal["installationId"] as? String)
            XCTAssertEqual(body["expected_pair_version"], "1")
            var reply: [String: Any] = ["status": body["action"] == "revoke" ? "revoked" : "credential",
                "watch_device_id": body["watch_device_id"]!, "installation_id": body["installation_id"]!, "pair_version": "1"]
            if body["action"] != "revoke" {
                reply["token"] = "watch-token-" + body["action"]!
                reply["expires_at"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(300))
            }
            return response(for: request, body: try JSONSerialization.data(withJSONObject: reply))
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        for action in [WatchCredentialAction.issue, .refresh, .revoke] {
            let credential = try await provider.watchCredential(action: action, requestID: UUID().uuidString.lowercased(), prepare: { scope in
                XCTAssertEqual(RealtimeURLProtocolSpy.observations.last?.path, "/v1/realtime/watch-binding/read")
                preparation.append(scope)
            })
            XCTAssertEqual(credential?.token, action == .revoke ? nil : "watch-token-" + action.rawValue)
            if let credential {
                XCTAssertEqual(credential.server, try RealtimeDevicePairing.decode(pairingData()).origin)
                XCTAssertEqual(credential.scope, preparation.values.last!?.scope)
            }
        }
    }

    func testWatchCredentialIneligibleReadPreparesNilWithoutCredentialHTTP() async throws {
        for state in [("absent", "0", false), ("revoked", "2", true), ("active", "2", true)] {
            RealtimeURLProtocolSpy.reset()
            let store = RealtimeTestPairingStore()
            try store.replacePairingData(pairingData())
            let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")],
                credentials: PairedRealtimeCredentialStore(store: store))
            let preparation = RealtimeWatchPreparationSpy()
            RealtimeURLProtocolSpy.handler = { [self] request in
                if request.url?.path == "/v1/realtime/bootstrap" {
                    return response(for: request, body: fixture("bootstrap-response.valid.json"))
                }
                XCTAssertEqual(request.url?.path, "/v1/realtime/watch-binding/read")
                return response(for: request, body: try JSONSerialization.data(withJSONObject: ["operation": "watch_binding",
                    "pair_state": ["pair_version": state.1, "status": state.0, "requires_rebind": state.2], "binding": NSNull()]))
            }
            _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
            do {
                _ = try await provider.watchCredential(action: .issue, requestID: UUID().uuidString.lowercased(), prepare: { scope in
                    preparation.append(scope)
                })
                XCTFail("Ineligible formal authority cannot issue a token")
            } catch { XCTAssertEqual(error as? WatchCredentialError, .staleAuthority) }
            XCTAssertEqual(preparation.values.count, 1)
            XCTAssertNil(preparation.values.first!)
            XCTAssertFalse(RealtimeURLProtocolSpy.observations.contains { $0.path.hasSuffix("/credential") })
        }
    }

    func testWatchCredentialHTTPRejectsParentPairingChangeBeforeReply() async throws {
        let store = RealtimeTestPairingStore()
        try store.replacePairingData(pairingData())
        let provider = makeProvider(bodies: [.bootstrap: fixture("bootstrap-request.valid.json")],
            credentials: PairedRealtimeCredentialStore(store: store))
        RealtimeURLProtocolSpy.handler = { [self] request in
            if request.url?.path == "/v1/realtime/bootstrap" {
                return response(for: request, body: fixture("bootstrap-response.valid.json"))
            }
            let formal = try credentialFormalWatchReceipt()
            if request.url?.path == "/v1/realtime/watch-binding/read" {
                return response(for: request, body: try JSONSerialization.data(withJSONObject: ["operation": "watch_binding",
                    "pair_state": ["pair_version": "1", "status": "active", "requires_rebind": false], "binding": formal]))
            }
            try store.replacePairingData(pairingData { $0["token"] = "replacement-parent-token-aaaaaaaaaaaaaaaa" })
            return response(for: request, body: Data(#"{"status":"failed","reason":"credential_revoked"}"#.utf8))
        }
        _ = try await provider.bootstrap(for: AssistantStartIntent(userInitiated: true))
        do {
            _ = try await provider.watchCredential(action: .issue, requestID: UUID().uuidString.lowercased(), prepare: { _ in })
            XCTFail("The old parent authority must not publish a response")
        } catch { XCTAssertEqual(error as? WatchCredentialError, .staleAuthority) }
    }
}

private final class RealtimeWatchPreparationSpy: @unchecked Sendable {
    private let lock = NSLock()
    private var scopes: [WatchCredentialAuthority?] = []
    var values: [WatchCredentialAuthority?] { lock.lock(); defer { lock.unlock() }; return scopes }
    func append(_ scope: WatchCredentialAuthority?) { lock.lock(); defer { lock.unlock() }; scopes.append(scope) }
}
