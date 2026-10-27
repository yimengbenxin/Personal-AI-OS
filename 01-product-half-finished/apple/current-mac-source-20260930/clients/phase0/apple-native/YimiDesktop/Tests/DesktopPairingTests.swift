import Combine
import CryptoKit
import DesktopKit
import XCTest

final class DesktopPairingTests: XCTestCase {
    @MainActor
    func testCapabilityDeclarationKeepsPairingAndUsesOnlyServerGrantedCapabilities() async throws {
        let id = "01900000-0000-7000-8000-000000000001"
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id])
        let legacy = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id,
            userID: "01900000-0000-7000-8000-000000000002", token: "test-pairing-token-00000000", governance: governance,
            media: ["data"], pairedAt: "2026-10-17T00:00:00Z", deviceType: "mac", capabilities: ["display", "chat_ui", "desktop_tools"])
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CapabilityDeclarationURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel(); CapabilityDeclarationURLProtocol.handler = nil }
        for ownerUnlock in [false, true] {
            let persistence = PairingMemoryPersistence(); persistence.data = try JSONEncoder().encode(legacy)
            let store = try DesktopPairingStore(pairingStore: persistence, recipientStore: persistence)
            let key = try store.loadOrCreateRecipientPrivateKey().rawRepresentation
            let controller = try DesktopPairingController(store: store, session: session, ownerUnlockEnabled: ownerUnlock)
            var publications = 0
            let observer = controller.$pairing.dropFirst().sink { _ in publications += 1 }
            defer { observer.cancel() }
            for granted in [legacy.capabilities!, ["display", "speaker", "chat_ui", "desktop_tools"]] {
                CapabilityDeclarationURLProtocol.handler = { request in
                    XCTAssertEqual(request.url?.path, "/v1/terminals/capabilities")
                    XCTAssertEqual(request.httpMethod, "POST")
                    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(legacy.token)")
                    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: CapabilityDeclarationURLProtocol.body(request)) as? [String: [String]])
                    XCTAssertEqual(Set(body.keys), ["capabilities"])
                    XCTAssertEqual(Set(body["capabilities"] ?? []), Set(["display", "speaker", "microphone", "camera", "notifications", "chat_ui", "desktop_tools"] + (ownerUnlock ? ["owner_unlock"] : [])))
                    return try JSONSerialization.data(withJSONObject: ["governance": governance.wireObject, "media": ["data"], "capabilities": granted])
                }
                let result = try await controller.declareCapabilities()
                XCTAssertEqual(result.capabilities, granted)
                var expected = legacy; expected.capabilities = granted
                XCTAssertEqual(result, expected)
                XCTAssertEqual(try RealtimeDevicePairing.decode(XCTUnwrap(store.loadPairingData())), expected)
                XCTAssertEqual(try store.loadOrCreateRecipientPrivateKey().rawRepresentation, key)
            }
            XCTAssertEqual(publications, 1)
            _ = try await controller.declareCapabilities()
            XCTAssertEqual(publications, 1)
            let saved = try store.loadPairingData()
            CapabilityDeclarationURLProtocol.handler = { _ in Data("{}".utf8) }
            do { _ = try await controller.declareCapabilities(); XCTFail("Invalid grant must fail") }
            catch { XCTAssertEqual(error as? RealtimeDevicePairingError, .invalidPairing) }
            XCTAssertEqual(try store.loadPairingData(), saved)
        }
    }

    func testInjectedStoresAvoidKeychainAndCacheRecipientForLockedScreen() throws {
        let persistence = PairingMemoryPersistence()
        let store = try DesktopPairingStore(pairingStore: persistence, recipientStore: persistence)
        XCTAssertNil(try store.loadPairingData())
        XCTAssertNil(try store.loadPairingData())
        XCTAssertEqual(persistence.pairingReads, 1)
        XCTAssertEqual(persistence.recipientReads, 0)
        let first = try store.loadOrCreateRecipientPrivateKey().publicKey.rawRepresentation
        let second = try store.loadOrCreateRecipientPrivateKey().publicKey.rawRepresentation
        XCTAssertEqual(first, second)
        XCTAssertEqual(persistence.recipientReads, 1)
        try store.clear()
        XCTAssertEqual(persistence.removals, 2)
    }

    @MainActor
    func testI4RevokedElsewhereWipesCredentialsConversationAndDraftWhileKeepingLocalFiles() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for name in ["conversation.json", "audit.sqlite", "guard.json", "report.txt"] { try Data(name.utf8).write(to: root.appendingPathComponent(name)) }
        let id = "01900000-0000-7000-8000-000000000001"
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id])
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id, userID: "01900000-0000-7000-8000-000000000002", token: "test-pairing-token-00000000", governance: governance, media: ["data", "audio"], pairedAt: "2026-10-15T00:00:00Z", deviceType: "mac", capabilities: ["display", "chat_ui", "desktop_tools", "microphone", "notifications"])
        let persistence = PairingMemoryPersistence(); persistence.data = try JSONEncoder().encode(pairing)
        let store = try DesktopPairingStore(pairingStore: persistence, recipientStore: persistence)
        let controller = try DesktopPairingController(store: store)
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), pairingController: controller, storeURL: root)
        model.connected = true; model.composer.text = "private draft"
        try await model.composer.attach([root.appendingPathComponent("report.txt")], via: .drag)
        model.timeline = [YimiItem(id: "private", kind: .me, text: "private conversation", date: Date())]
        await model.accept(AssistantSessionSnapshot(state: .failed(code: "realtime_pairing_revoked"), revision: 1,
            isRestoringPendingStop: false, hasPendingStop: false, pendingStopRecoveryFailed: false))
        XCTAssertNil(try store.loadPairingData()); XCTAssertEqual(persistence.removals, 2)
        XCTAssertNil(model.pairing); XCTAssertFalse(model.connected); XCTAssertEqual(model.connectionLabel, "这台电脑已解除配对")
        XCTAssertTrue(model.timeline.isEmpty); XCTAssertTrue(model.composer.text.isEmpty); XCTAssertTrue(model.composer.files.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("conversation.json").path))
        for name in ["audit.sqlite", "guard.json", "report.txt"] { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), Data(name.utf8)) }
    }

    @MainActor
    func testOnboardingOutputSelectionCreatesAuthorizedFolderWithoutRevivingRemovedAccess() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let home = root.appendingPathComponent("home", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = root.appendingPathComponent("desktop")
        let desktop = try Desktop(store: store, resources: root, home: home,
                                  trash: { _ in throw CocoaError(.featureUnsupported) })
        let model = try DesktopAppModel(desktop: desktop, storeURL: root.appendingPathComponent("app"))
        let output = home.appendingPathComponent("Documents/依米", isDirectory: true)
        try await model.authorizeOnboardingFolders(suggestions: [], output: false, home: home)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
        XCTAssertTrue(model.folders.isEmpty)
        try await model.authorizeOnboardingFolders(suggestions: [], output: true, home: home)
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: output.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
        let folder = try XCTUnwrap(model.folders.first)
        let selected = try FileManager.default.attributesOfItem(atPath: output.path)
        let authorized = try FileManager.default.attributesOfItem(atPath: folder.id)
        for key in [FileAttributeKey.systemNumber, .systemFileNumber] {
            XCTAssertEqual(try XCTUnwrap(selected[key] as? NSNumber), try XCTUnwrap(authorized[key] as? NSNumber))
        }
        XCTAssertEqual(folder.label, "文稿/依米"); XCTAssertTrue(folder.write)
        XCTAssertEqual(model.folders.count, 1)
        try await desktop.remove(folder: folder.id)
        await desktop.stop()
        let reopened = try Desktop(store: store, resources: root, home: home,
                                   trash: { _ in throw CocoaError(.featureUnsupported) })
        let restored = try DesktopAppModel(desktop: reopened, storeURL: root.appendingPathComponent("app"))
        try await restored.authorizeOnboardingFolders(suggestions: [], output: false, home: home)
        XCTAssertTrue(restored.folders.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: output.path))
        await reopened.stop()
    }

    @MainActor
    func testSavedFileCardsFollowConversationChronologyAndAuditUpdates() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = try DesktopAppModel(desktop: FakeDesktopControl(), storeURL: root)
        let start = Date(timeIntervalSince1970: 100)
        model.timeline = [YimiItem(id: "before", kind: .me, text: "做个表", date: start),
                          YimiItem(id: "after", kind: .her, text: "好了", date: start.addingTimeInterval(2))]
        model.auditEntries = [AuditEntry(id: "saved", at: start.addingTimeInterval(1), tool: "write_file", toolClass: "write",
            names: ["表格.csv"], count: 1, decision: "allowed", result: "ok", errorCode: nil, undo: .create,
            undoneAt: nil, reveal: root.appendingPathComponent("表格.csv"))]
        XCTAssertEqual(model.chatEntries.map(\.id), ["message-before", "file-saved", "message-after"])
        model.auditEntries = [AuditEntry(id: "saved", at: start.addingTimeInterval(1), tool: "write_file", toolClass: "write",
            names: ["表格.csv"], count: 1, decision: "allowed", result: "ok", errorCode: nil, undo: .create,
            undoneAt: start.addingTimeInterval(3), reveal: root.appendingPathComponent("表格.csv"))]
        XCTAssertEqual(model.chatEntries.map(\.id), ["message-before", "message-after"])
    }

    func testMacPairingDecoderPreservesLegacyAndExplicitOwnerUnlock() throws {
        let id = "01900000-0000-7000-8000-000000000001"
        let governance = RealtimeWireGovernance(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id])
        for unlock in [false, true] {
            let capabilities = ["display", "chat_ui", "desktop_tools"] + (unlock ? ["owner_unlock"] : [])
            let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id,
                userID: "01900000-0000-7000-8000-000000000002", token: "test-pairing-token-00000000", governance: governance,
                media: ["data"], pairedAt: "2026-10-17T00:00:00Z", deviceType: "mac", capabilities: capabilities)
            XCTAssertEqual(try RealtimeDevicePairing.decode(JSONEncoder().encode(pairing)).capabilities, capabilities)
        }
    }

    func testMacQRRejectsExpiredForeignOriginAndLeakedPollCredential() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let formatter = ISO8601DateFormatter()
        var object = ["schema": RealtimeMacPairingQR.schema, "origin": "https://example.test",
            "nonce": String(repeating: "n", count: 43), "public_key_sha256": String(repeating: "a", count: 64),
            "expires_at": formatter.string(from: now.addingTimeInterval(60))]
        let data = try JSONSerialization.data(withJSONObject: object)
        XCTAssertEqual(try RealtimeMacPairingQR.decode(data, origin: "https://example.test", now: now).nonce, object["nonce"])
        XCTAssertThrowsError(try RealtimeMacPairingQR.decode(data, origin: "https://other.test", now: now))
        XCTAssertThrowsError(try RealtimeMacPairingQR.decode(data, origin: "https://example.test", now: now.addingTimeInterval(61)))
        object["poll_token"] = String(repeating: "s", count: 43)
        XCTAssertThrowsError(try RealtimeMacPairingQR.decode(JSONSerialization.data(withJSONObject: object), origin: "https://example.test", now: now))
    }

    @MainActor
    func testI4A61RegistrationUsesAuthorityKeyAndCameraPlaybackCapabilities() {
        let authority = RealtimeE2EERecipientRegistrationExport(
            schema: RealtimeE2EERecipientRegistrationExport.schema,
            publicRaw32Base64URL: "authority-public-key", publicSha256: "authority-digest",
            localSlotRefHash: "local-only", createdAt: "2026-10-16T00:00:00Z")
        let registration = DesktopPairingController.registration(publicKey: authority, label: "我的电脑")
        XCTAssertEqual(registration["public_raw32_base64url"] as? String, authority.publicRaw32Base64URL)
        XCTAssertEqual(registration["public_sha256"] as? String, authority.publicSha256)
        XCTAssertEqual(registration["device_type"] as? String, "mac")
        let capabilities = Set(registration["capabilities"] as? [String] ?? [])
        XCTAssertEqual(capabilities, ["display", "speaker", "microphone", "camera", "notifications", "chat_ui", "desktop_tools"])
        XCTAssertNil(registration["local_slot_ref_hash"])
        let optedIn = DesktopPairingController.registration(publicKey: authority, label: "我的电脑", ownerUnlockEnabled: true)
        XCTAssertEqual(Set(optedIn["capabilities"] as? [String] ?? []), capabilities.union(["owner_unlock"]))
    }
}

private final class CapabilityDeclarationURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> Data)?
    static func body(_ request: URLRequest) throws -> Data {
        if let data = request.httpBody { return data }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw try XCTUnwrap(stream.streamError) }
            if count == 0 { return data }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let data = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class PairingMemoryPersistence: DesktopPairingPersisting, DesktopRecipientKeyPersisting, @unchecked Sendable {
    var data: Data?
    var key: Curve25519.KeyAgreement.PrivateKey?
    var pairingReads = 0
    var recipientReads = 0
    var removals = 0
    func loadPairingData() throws -> Data? { pairingReads += 1; return data }
    func replacePairingData(_ data: Data) throws { self.data = data }
    func removePairing() throws { data = nil; removals += 1 }
    func loadOrCreateRecipientPrivateKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        recipientReads += 1
        if let key { return key }; let created = Curve25519.KeyAgreement.PrivateKey(); key = created; return created
    }
    func removeRecipientPrivateKey() throws { key = nil; removals += 1 }
}


extension DesktopPairingTests {
    @MainActor func testOfflineUnpairClearsLocallyAndKeepsPendingStatus() async throws {
        try await checkUnpair(connected: false, repeatedTaps: false)
    }

    @MainActor func testOnlineUnpairWaitsForServerConfirmation() async throws {
        try await checkUnpair(connected: true, repeatedTaps: false)
    }

    @MainActor func testRepeatedUnpairTapsShareOneLocalClearAndRemoteRequest() async throws {
        try await checkUnpair(connected: true, repeatedTaps: true)
    }

    @MainActor private func checkUnpair(connected: Bool, repeatedTaps: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let directory = root.appendingPathComponent("ssh")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let authorization = directory.appendingPathComponent("authorized_keys")
        try Data("fixture authorization".utf8).write(to: authorization)
        let id = "01900000-0000-7000-8000-000000000001"
        let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id, userID: id, token: "test-pairing-token-00000000",
            governance: .init(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id]),
            media: ["data"], pairedAt: "2026-10-24T00:00:00Z", deviceType: "mac", capabilities: ["display", "chat_ui", "desktop_tools"])
        let persistence = PairingMemoryPersistence(); persistence.data = try JSONEncoder().encode(pairing)
        let store = try DesktopPairingStore(pairingStore: persistence, recipientStore: persistence)
        let controller = try DesktopPairingController(store: store), intents = PairingRevokeFixture()
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [HeldPairingRevoke.self]
        let session = URLSession(configuration: config)
        defer {
            session.invalidateAndCancel(); HeldPairingRevoke.held = nil; HeldPairingRevoke.requested = nil; HeldPairingRevoke.count = 0
            try? FileManager.default.removeItem(at: root)
        }
        let requested = expectation(description: "remote request starts after local teardown")
        let settled = expectation(description: "server confirms or offline retry is scheduled")
        HeldPairingRevoke.requested = { requested.fulfill() }
        let ssh = DesktopOwnerSSH(directory: directory, session: session, revocations: intents,
            sleep: { _ in settled.fulfill(); throw CancellationError() })
        let control = FakeDesktopControl()
        let model = try DesktopAppModel(desktop: control, pairingController: controller, storeURL: root, ownerSSH: ssh)
        model.connected = connected
        XCTAssertTrue(model.canUnpair, "The unpair action must also be enabled offline")
        let subscription = model.$unpairStatus.filter { $0 == "这台电脑已解除配对" }.prefix(1).sink { _ in settled.fulfill() }
        defer { subscription.cancel() }
        let stopping = repeatedTaps ? expectation(description: "local desktop stop held") : nil
        let release = AsyncStream<Void>.makeStream()
        if let stopping { await control.setStopBarrier { stopping.fulfill(); for await _ in release.stream { break } } }
        let unpair = Task { await model.unpair() }
        if let stopping {
            await fulfillment(of: [stopping], timeout: 3)
            await model.unpair(); await model.unpair()
            XCTAssertFalse(model.canUnpair)
            XCTAssertEqual(HeldPairingRevoke.count, 0, "Remote compensation waits for local teardown")
            release.continuation.yield(())
        }
        await unpair.value
        await fulfillment(of: [requested], timeout: 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: authorization.path))
        XCTAssertNil(persistence.key); XCTAssertNil(model.pairing); XCTAssertNil(controller.pairing)
        let reopened = try DesktopPairingStore(pairingStore: persistence, recipientStore: persistence)
        XCTAssertNil(try reopened.loadPairingData(), "Unpaired is durable before the remote response")
        XCTAssertEqual(persistence.removals, 2); XCTAssertEqual(intents.intents.count, 1)
        XCTAssertEqual(model.unpairStatus, "已在本机解除；服务器端待同步")
        XCTAssertFalse(model.canUnpair)
        await model.unpair(); await model.unpair()
        XCTAssertEqual(HeldPairingRevoke.count, 1)
        HeldPairingRevoke.held?.complete(online: connected)
        await fulfillment(of: [settled], timeout: 3)
        XCTAssertEqual(intents.intents.count, connected ? 0 : 1)
        XCTAssertEqual(model.unpairStatus, connected ? "这台电脑已解除配对" : "已在本机解除；服务器端待同步")
        XCTAssertEqual(persistence.removals, 2)
        let stopCalls = await control.stopCalls
        XCTAssertEqual(stopCalls, 1)
    }

    @MainActor func testExt13UnpairAndPendingRestartClearActiveIdentityWhileRevokeIsOffline() async throws {
        for (restarting, paired) in [(false, true), (true, true), (true, false)] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let id = "01900000-0000-7000-8000-000000000001"
            let pairing = RealtimeDevicePairing(schema: RealtimeDevicePairing.schema, origin: "https://example.test", deviceID: id, userID: id, token: "test-pairing-token-00000000",
                governance: .init(purposeScopes: ["personal_assistant"], consentRecordRefs: [id], policyDecisionRefs: [id], purposeTokenRefs: [id], capabilityGrantRefs: [id]), media: ["data"], pairedAt: "2026-10-24T00:00:00Z", deviceType: "mac", capabilities: ["display", "chat_ui", "desktop_tools"])
            let persistence = PairingMemoryPersistence()
            persistence.data = paired ? try JSONEncoder().encode(pairing) : nil
            let store = try DesktopPairingStore(pairingStore: persistence, recipientStore: persistence)
            let controller = try DesktopPairingController(store: store), intents = PairingRevokeFixture()
            if restarting { intents.intents = [.init(origin: pairing.origin, deviceID: id, token: pairing.token)] }
            let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [OfflinePairingRevoke.self]
            let session = URLSession(configuration: config); defer { session.invalidateAndCancel() }
            let ssh = DesktopOwnerSSH(directory: root.appendingPathComponent("ssh"), session: session, revocations: intents, sleep: { _ in throw CancellationError() })
            let model = try DesktopAppModel(desktop: FakeDesktopControl(), pairingController: controller, storeURL: root, ownerSSH: ssh)
            if restarting { await model.activate() } else { await model.unpair() }
            XCTAssertNil(try store.loadPairingData()); XCTAssertNil(model.pairing); XCTAssertFalse(model.connected)
            XCTAssertEqual(persistence.removals, paired ? 2 : 0)
            XCTAssertEqual(intents.intents.count, 1, "Offline revocation retains only its independent intent")
            XCTAssertEqual(model.unpairStatus, "已在本机解除；服务器端待同步")
        }
    }
}

private final class PairingRevokeFixture: DesktopRevocationPersisting {
    var intents: [DesktopRevocation] = []
    func load() -> [DesktopRevocation] { intents }
    func save(_ intents: [DesktopRevocation]) { self.intents = intents }
}
private final class OfflinePairingRevoke: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
    override func stopLoading() {}
}

private final class HeldPairingRevoke: URLProtocol {
    static var held: HeldPairingRevoke?
    static var requested: (() -> Void)?
    static var count = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTAssertEqual(request.url?.path, "/v1/mac/ssh/revoke")
        Self.count += 1; Self.held = self; Self.requested?()
    }
    func complete(online: Bool) {
        if !online { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)); return }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
