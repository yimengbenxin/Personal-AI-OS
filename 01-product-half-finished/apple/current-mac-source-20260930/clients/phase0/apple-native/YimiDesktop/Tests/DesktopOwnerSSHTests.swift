import XCTest

final class DesktopOwnerSSHTests: XCTestCase {
    @MainActor func testLocalStopRemovesAuthorizationAndPreservesIdentityAndAudit() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for name in ["authorized_keys", "host_key", "commands.jsonl"] { try Data(name.utf8).write(to: root.appendingPathComponent(name)) }
        let ssh = DesktopOwnerSSH(directory: root, revocations: MemoryDesktopRevocations())
        try ssh.stop()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("authorized_keys").path))
        for name in ["host_key", "commands.jsonl"] { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), Data(name.utf8)) }
        try ssh.stop()
    }

    @MainActor func testRejectedCloudRevokeStillRemovesLocalAuthorization() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("test key".utf8).write(to: root.appendingPathComponent("authorized_keys"))
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [RejectedSSHRequest.self]
        let ssh = DesktopOwnerSSH(directory: root, session: URLSession(configuration: config), revocations: MemoryDesktopRevocations())
        let id = "01900000-0000-7000-8000-000000000001"
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id])
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id, userID: id, token: "test-token", governance: governance, media: [], pairedAt: "2026-10-19T00:00:00Z", deviceType: "mac")
        do { try await ssh.revoke(pairing); XCTFail("Cloud rejection must surface") }
        catch { XCTAssertEqual((error as NSError).code, 403) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("authorized_keys").path))
    }
}

private final class RejectedSSHRequest: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}


extension DesktopOwnerSSHTests {
    @MainActor func testExt13FailedRevokeSurvivesRestartWithoutLocalControl() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("test key".utf8).write(to: root.appendingPathComponent("authorized_keys"))
        let store = MemoryDesktopRevocations(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Ext13RevokeRequest.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel(); Ext13RevokeRequest.status = 503; Ext13RevokeRequest.requests = [] }
        let id = "01900000-0000-7000-8000-000000000001"
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id, userID: id, token: "test-token",
            governance: .init(purposeScopes: [], consentRecordRefs: [], policyDecisionRefs: [], purposeTokenRefs: [], capabilityGrantRefs: []),
            media: ["data"], pairedAt: "2026-10-24T00:00:00Z", deviceType: "mac")
        do { try await DesktopOwnerSSH(directory: root, session: session, revocations: store).revoke(pairing); XCTFail("Revoke must report the outage") }
        catch { XCTAssertEqual((error as NSError).code, 503) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("authorized_keys").path))
        XCTAssertEqual(store.intents, [.init(origin: pairing.origin, deviceID: id, token: pairing.token)])
        let restarted = DesktopOwnerSSH(directory: root, session: session, revocations: store)
        Ext13RevokeRequest.status = 200
        try await restarted.retryRevocations()
        XCTAssertTrue(store.intents.isEmpty)
        XCTAssertEqual(Ext13RevokeRequest.requests.count, 2)
        XCTAssertEqual(Ext13RevokeRequest.requests.map { $0.url?.path }, ["/v1/mac/ssh/revoke", "/v1/mac/ssh/revoke"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("authorized_keys").path))
    }
}

private final class MemoryDesktopRevocations: DesktopRevocationPersisting {
    var intents: [DesktopRevocation] = []
    func load() -> [DesktopRevocation] { intents }
    var didSave: (([DesktopRevocation]) -> Void)?
    func save(_ intents: [DesktopRevocation]) { self.intents = intents; didSave?(intents) }
}
private final class Ext13RevokeRequest: URLProtocol {
    static var status = 503
    static var body = "{}"
    static var holdFirst = false
    static var held: Ext13RevokeRequest?
    static var firstRequested: (() -> Void)?
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        if Self.holdFirst, Self.requests.count == 1 { Self.held = self; Self.firstRequested?(); return }
        complete()
    }
    func complete() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}


extension DesktopOwnerSSHTests {
    @MainActor func testExt13RevokeOnlyRetiresIntentForAuthorityConfirmedRevocation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [Ext13RevokeRequest.self]
        let session = URLSession(configuration: config), store = MemoryDesktopRevocations()
        defer { session.invalidateAndCancel(); Ext13RevokeRequest.status = 503; Ext13RevokeRequest.body = "{}"; Ext13RevokeRequest.requests = [] }
        store.intents = [.init(origin: "https://example.test", deviceID: "old-device", token: "test-token")]
        let ssh = DesktopOwnerSSH(directory: root, session: session, revocations: store)
        Ext13RevokeRequest.status = 403
        do { try await ssh.retryRevocations(); XCTFail("A generic denial does not prove revocation") } catch { }
        XCTAssertEqual(store.intents.count, 1)
        for (status, code) in [(403, "PAIRED_DEVICE_REVOKED"), (401, "CONTROL_CAPABILITY_INVALID")] {
            store.intents = [.init(origin: "https://example.test", deviceID: "old-device", token: "test-token")]
            Ext13RevokeRequest.status = status
            Ext13RevokeRequest.body = "{\"error\":\"\(code)\"}"
            try await ssh.retryRevocations()
            XCTAssertTrue(store.intents.isEmpty, "The authority confirms revocation after a lost success response")
        }
        try await ssh.retryRevocations()
        XCTAssertEqual(Ext13RevokeRequest.requests.count, 3, "A completed intent never sends again")
    }
}


extension DesktopOwnerSSHTests {
    func testExt13RevocationKeychainPersistsAcrossStoreInstancesAndErasesAfterCompletion() throws {
        let service = "test.desktop.revocation." + UUID().uuidString
        let first = KeychainDesktopRevocations(service: service)
        defer { try? first.save([]) }
        let intents = [DesktopRevocation(origin: "https://example.test", deviceID: "old-device", token: "test-token")]
        try first.save(intents)
        XCTAssertEqual(try KeychainDesktopRevocations(service: service).load(), intents)
        try KeychainDesktopRevocations(service: service).save([])
        XCTAssertTrue(try first.load().isEmpty)
    }
}


extension DesktopOwnerSSHTests {
    @MainActor func testExt13RetryWorkerDrainsIntentAddedDuringAnotherRevoke() async throws {
        let store = MemoryDesktopRevocations(), config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Ext13RevokeRequest.self]
        let session = URLSession(configuration: config)
        defer {
            session.invalidateAndCancel(); Ext13RevokeRequest.holdFirst = false; Ext13RevokeRequest.held = nil
            Ext13RevokeRequest.firstRequested = nil; Ext13RevokeRequest.status = 503; Ext13RevokeRequest.body = "{}"; Ext13RevokeRequest.requests = []
        }
        let first = expectation(description: "first revoke suspended"), drained = expectation(description: "both intents drained")
        Ext13RevokeRequest.status = 200; Ext13RevokeRequest.holdFirst = true
        Ext13RevokeRequest.firstRequested = { first.fulfill() }
        let id = "01900000-0000-7000-8000-000000000001"
        store.intents = [.init(origin: "https://example.test", deviceID: id, token: "test-first")]
        store.didSave = { if $0.isEmpty { drained.fulfill() } }
        let ssh = DesktopOwnerSSH(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString), session: session, revocations: store,
            sleep: { _ in throw CancellationError() })
        ssh.resumeRevocations { if $0 != nil { XCTFail("Fixture revocations succeed") } }
        await fulfillment(of: [first], timeout: 3)
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: "01900000-0000-7000-8000-000000000002", userID: id, token: "test-second",
            governance: .init(purposeScopes: [], consentRecordRefs: [], policyDecisionRefs: [], purposeTokenRefs: [], capabilityGrantRefs: []), media: ["data"], pairedAt: "2026-10-24T00:00:00Z", deviceType: "mac")
        try ssh.rememberRevocation(pairing)
        ssh.resumeRevocations { if $0 != nil { XCTFail("Fixture revocations succeed") } }
        Ext13RevokeRequest.held?.complete()
        await fulfillment(of: [drained], timeout: 3)
        XCTAssertTrue(store.intents.isEmpty)
        XCTAssertEqual(Ext13RevokeRequest.requests.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer test-first", "Bearer test-second"])
    }
}
