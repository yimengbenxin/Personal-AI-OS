import Combine
import Foundation
import CryptoKit

/// A transient view of the server authority. Revisions and activation never originate here.
@MainActor
final class AssistantModelSettingsModel: ObservableObject {
    typealias Sender = (Data, String, TimeInterval) async throws -> CentralTextPacket
    typealias Signer = (Data, String) async throws -> Data
    @Published private(set) var snapshot: ModelSettingsSnapshot?
    @Published private(set) var review: ModelSettingsReview?
    @Published private(set) var busy = false
    @Published private(set) var connected = false
    @Published private(set) var authorized = false
    @Published private(set) var error: String?
    @Published private(set) var message: String?
    @Published private(set) var pendingMacs: [ModelSettingsMac] = []
    @Published private(set) var catalog: ModelSettingsCatalog?
    @Published private(set) var testResult: String?
    @Published private(set) var testedRole: ModelSettingsRole?
    @Published private(set) var undoSnapshot: ModelSettingsSnapshot?
    private(set) var binding: CentralTransportBinding?
    var signer: Signer?
    var canWrite: Bool { connected && authorized && !busy }
    private var send: Sender?
    private var events: Task<Void, Never>?
    private var needsRefresh = false
    private var generation = 0
    private var watching = false
    private var refreshingGeneration: Int?
    private var stateVersion = 0
    private var state: AssistantModelSettingsWire.State?

    init(sender: Sender? = nil, signer: Signer? = nil) { send = sender; self.signer = signer }
    deinit { events?.cancel() }

    func connect(_ coordinator: AssistantSessionCoordinator) {
        let channel = coordinator.paymentChannel
        send = { try await channel.request($0, id: $1, timeout: $2) }
        events?.cancel()
        let (stream, continuation) = AsyncStream<AssistantPaymentEvent>.makeStream()
        events = Task { [weak self] in
            await channel.setModelSettingsObserver { continuation.yield($0) }
            for await event in stream {
                guard !Task.isCancelled else { return }
                self?.receive(event)
            }
        }
    }

    func receive(_ event: AssistantPaymentEvent) {
        switch event {
        case .attached(let value):
            guard binding != value else { return }
            generation += 1
            binding = value; connected = true; authorized = value.deviceClass == "iphone"
            watching = false; state = nil; needsRefresh = false
            snapshot = nil; review = nil; catalog = nil; pendingMacs = []; message = nil; undoSnapshot = nil
            let attachedGeneration = generation
            Task { [weak self] in
                guard let self, self.generation == attachedGeneration, self.snapshot == nil else { return }
                await self.open()
            }
        case .detached, .failed:
            generation += 1
            binding = nil; connected = false; authorized = false
            snapshot = nil; review = nil; pendingMacs = []; catalog = nil; testResult = nil; undoSnapshot = nil
            watching = false; state = nil; needsRefresh = false
        case .output(let packet):
            guard let binding,
                  (try? packet.fields.value("session_id", as: String.self)) == binding.sessionID,
                  (try? packet.fields.value("operation", as: String.self)) == "model_settings_state" else { return }
            do {
                guard let state = try packet.fields.value("state", as: AssistantModelSettingsWire.State.self) else {
                    throw CentralTextError.invalidPacket
                }
                accept(state)
            } catch { reportError(error) }
        }
    }

    /// Opening and attachment share the same initial snapshot need.
    func open() async {
        guard connected, snapshot == nil || snapshot?.revision != snapshot?.desired else { return }
        await refresh()
    }

    func refresh() async {
        guard connected else { return }
        if busy {
            if refreshingGeneration != generation { needsRefresh = true }
            return
        }
        let refreshGeneration = generation
        refreshingGeneration = refreshGeneration
        defer { refreshingGeneration = nil }
        await perform {
            if !self.watching {
                let stateBeforeWatch = self.stateVersion
                let state: AssistantModelSettingsWire.State = try await self.result("watch")
                self.watching = true
                // A push delivered during registration is newer than its receipt.
                if self.stateVersion == stateBeforeWatch { self.accept(state) }
            }
            self.snapshot = try await self.readSnapshot().0
            if self.binding?.deviceClass == "mac" {
                do { _ = try await self.request("challenge"); self.authorized = true }
                catch ModelSettingsError.server("MODEL_SETTINGS_MAC_UNAUTHORIZED") { self.authorized = false }
            }
        }
    }

    private func accept(_ value: AssistantModelSettingsWire.State) {
        if let snapshot, snapshot.environment_id != value.environment_id || value.desired < snapshot.desired { return }
        if let state, state.environment_id != value.environment_id || value.desired < state.desired { return }
        stateVersion += 1
        state = value
        if snapshot != nil {
            snapshot?.desired = value.desired
            snapshot?.groups = value.groups
        }
    }

    func refreshPendingMacs() async {
        await perform {
            var offset = 0, values: [ModelSettingsMac] = []
            while true {
                let page: AssistantModelSettingsWire.PendingMacs = try await self.result("pending_macs", request: ["offset": offset])
                values += page.items
                guard let next = page.next_offset else { break }
                guard next > offset else { throw CentralTextError.invalidPacket }
                offset = next
            }
            self.pendingMacs = values
        }
    }

    func prepareRoutes(providers: [ModelSettingsProvider] = [], roles: [ModelSettingsRole] = [], summary: String) async {
        await perform {
            try await self.prepare("draft", request: ["providers": try AssistantModelSettingsWire.object(providers),
                "roles": try AssistantModelSettingsWire.object(roles), "change_summary": summary])
        }
    }

    /// Only encoded wire bytes cross the async boundary; neither the input nor a draft retains the key string.
    func prepareKey(credentialRef: String, key: inout String) -> Task<Void, Never>? {
        guard canWrite, let binding, let before = snapshot else { return nil }
        do {
            let id = "model-settings:" + UUID().uuidString
            var bytes: Data? = try AssistantCentralTextWire.encode("model_settings_set_key", fields: ["control_id": id,
                "request": ["credential_ref": credentialRef, "key": key, "expected_revision": before.revision]])
            key = ""
            return Task {
                await perform {
                    guard self.binding == binding else { throw ModelSettingsError.changed }
                    self.review = nil; self.message = nil
                    let packet = try await self.exchange(bytes!, id: id)
                    bytes = nil
                    let draft = try AssistantModelSettingsWire.result(packet, as: ModelSettingsDraft.self)
                    try await self.finishReview(draft, before: before, binding: binding)
                }
                bytes = nil
            }
        } catch { reportError(error); return nil }
    }
    func prepareUndo(revision: Int) async {
        await perform {
            self.undoSnapshot = nil
            self.undoSnapshot = try await self.readSnapshot(revision: revision).0
            try await self.prepare("draft", request: ["action": "undo", "revision": revision])
        }
    }
    func prepareBudget(pauseOnLimit: Bool, reserve: Double = 1) async {
        await perform {
            guard reserve.isFinite && reserve >= 1 else { throw ModelSettingsError.server("MODEL_SETTINGS_OWNER_RESERVE_INVALID") }
            try await self.prepare("draft", request: ["action": "pause", "pause_on_limit": pauseOnLimit, "owner_reserve_cny": reserve])
        }
    }
    func prepareResume() async {
        await perform { try await self.prepare("draft", request: ["action": "resume"]) }
    }
    func prepareAuthorization(_ mac: ModelSettingsMac) async {
        await perform {
            guard let key = mac.public_x963_b64 else { throw ModelSettingsError.server("MODEL_SETTINGS_MAC_KEY_REQUIRED") }
            try await self.prepare("draft", request: ["action": "authorize_mac", "device_id": mac.device_id, "public_x963_b64": key])
        }
    }
    func discardReview() { review = nil }
    func reportError(_ error: Error) { self.error = error.localizedDescription }

    func confirm() async {
        await perform {
            guard let review = self.review, review.complete, let signer = self.signer else {
                throw ModelSettingsError.incomplete
            }
            guard review.expiresAt > Date() else { self.review = nil; throw ModelSettingsError.expired }
            guard self.binding == review.binding else { throw ModelSettingsError.changed }
            let statement = try AssistantModelSettingsWire.statement(review: review)
            let signature = try await signer(statement, review.binding.deviceID)
            guard self.binding == review.binding, self.review?.draft.draft_id == review.draft.draft_id else {
                throw ModelSettingsError.changed
            }
            do {
                _ = try await self.request(review.draft.action, fields: ["request": ["draft_id": review.draft.draft_id],
                    "statement_b64": statement.base64EncodedString(), "signature_b64": signature.base64EncodedString()])
            } catch {
                self.review = nil
                if !(error is ModelSettingsError) { self.message = "提交结果尚未确认，请刷新查看已保存版本" }
                throw error
            }
            self.review = nil
            switch review.draft.action {
            case "resume": self.message = "已恢复，暂停的工作会自动继续"
            case "pause": self.message = "预算策略已保存"
            case "authorize_mac": self.message = "这台 Mac 已获模型设置授权"
            default: self.message = "已保存，当前任务结束后生效"
            }
            self.snapshot = try await self.readSnapshot().0
            if review.draft.action == "authorize_mac" { self.pendingMacs = [] }
        }
    }

    func loadCatalog(providerRef: String, providers: [ModelSettingsProvider] = []) async {
        await perform {
            self.catalog = nil
            let draft: ModelSettingsDraft = try await self.result("draft", request: ["expected_revision": try self.current().revision,
                "providers": try AssistantModelSettingsWire.object(providers), "roles": [], "change_summary": "读取服务商模型列表"])
            var offset = 0, combined: ModelSettingsCatalog?
            while true {
                var page: ModelSettingsCatalog = try await self.result("catalog", request: ["draft_id": draft.draft_id,
                    "provider_ref": providerRef, "offset": offset])
                guard page.draft_id == draft.draft_id, page.change_sha256 == draft.change_sha256, page.provider_ref == providerRef else {
                    throw CentralTextError.invalidPacket
                }
                if let previous = combined { page.models = previous.models + page.models }
                combined = page
                guard page.status == "available", let next = page.next_offset else { break }
                guard next > offset else { throw CentralTextError.invalidPacket }
                offset = next
            }
            self.catalog = combined
        }
    }

    func testConnection(role: ModelSettingsRole) async {
        await perform {
            self.testResult = nil
            self.testedRole = nil
            let draft: ModelSettingsDraft = try await self.result("draft", request: ["expected_revision": try self.current().revision,
                "providers": [], "roles": try AssistantModelSettingsWire.object([role]), "change_summary": "测试连接（不保存路由）"])
            let packet = try await self.request("test", fields: ["request": ["draft_id": draft.draft_id, "profile": role.profile, "role": role.id]])
            let value: [String: AssistantModelSettingsWire.Value] = try AssistantModelSettingsWire.result(packet, as: [String: AssistantModelSettingsWire.Value].self)
            self.testResult = try AssistantModelSettingsWire.pretty(value)
            self.testedRole = role
        }
    }

    func publishMacKey(publicKey: Data, principalID: String, recipient: Curve25519.KeyAgreement.PrivateKey) async {
        await perform {
            guard let binding = self.binding, binding.deviceClass == "mac" else { throw ModelSettingsError.changed }
            let challenge: AssistantModelSettingsWire.KeyChallenge = try await self.result("key_challenge")
            let fields = try AssistantModelSettingsWire.publication(publicKey: publicKey, recipient: recipient,
                challenge: challenge, deviceID: binding.deviceID, principalID: principalID)
            _ = try await self.request("publish_key", fields: fields)
            self.message = "已提交签名密钥，请在 iPhone 上授权这台 Mac"
        }
    }

    private func current() throws -> ModelSettingsSnapshot {
        guard let snapshot else { throw ModelSettingsError.changed }
        return snapshot
    }

    private func prepare(_ operation: String, request: [String: Any]) async throws {
        guard authorized, let binding else { throw ModelSettingsError.changed }
        let before = try current()
        var request = request; request["expected_revision"] = before.revision
        review = nil; message = nil
        let draft: ModelSettingsDraft = try await result(operation, request: request)
        try await finishReview(draft, before: before, binding: binding)
    }

    private func finishReview(_ draft: ModelSettingsDraft, before: ModelSettingsSnapshot, binding: CentralTransportBinding) async throws {
        guard self.binding == binding else { throw ModelSettingsError.changed }
        let (after, count, frozen) = try await readSnapshot(draftID: draft.draft_id)
        guard let frozen, frozen.draft_id == draft.draft_id, frozen.action == draft.action,
              after.revision == before.revision + 1 else { throw ModelSettingsError.incomplete }
        let challenge: AssistantModelSettingsWire.Challenge = try await result("challenge")
        var payload = try AssistantModelSettingsWire.pretty(frozen.payload)
        if let key = draft.preview?.key {
            payload += "\n新密钥已准备，确认后保存。凭据：\(key.credential_ref)；末四位：\(key.last4)。"
        }
        guard self.binding == binding else { throw ModelSettingsError.changed }
        review = ModelSettingsReview(draft: draft, before: before, after: after,
            changes: try differences(before, after), payloadText: payload, pageCount: count, complete: true,
            nonce: challenge.nonce, expiresAt: min(Date(timeIntervalSince1970: draft.expires_at_ms / 1000),
                Date().addingTimeInterval(challenge.expires_in_ms / 1000)), binding: binding)
    }

    private func readSnapshot(draftID: String? = nil, revision: Int? = nil) async throws -> (ModelSettingsSnapshot, Int, AssistantModelSettingsWire.FrozenAction?) {
        let stateAtRead = stateVersion
        var offset = 0, count = 0, snapshot: ModelSettingsSnapshot?, frozen: AssistantModelSettingsWire.FrozenAction?
        while true {
            var request: [String: Any] = ["offset": offset]
            if let draftID { request["draft_id"] = draftID }
            else if let revision = snapshot?.revision ?? revision { request["revision"] = revision }
            let page: AssistantModelSettingsWire.Page = try await result("read", request: request)
            if snapshot == nil {
                snapshot = ModelSettingsSnapshot(environment_id: page.environment_id, revision: page.revision,
                    desired: page.desired, groups: page.groups, usage: page.usage)
                frozen = page.draft
            }
            guard snapshot?.revision == page.revision, snapshot?.environment_id == page.environment_id else { throw CentralTextError.invalidPacket }
            for item in page.items {
                switch item {
                case .provider(let value): snapshot?.providers.append(value)
                case .role(let value): snapshot?.roles.append(value)
                case .credential(let value): snapshot?.credentials.append(value)
                }
            }
            count += 1
            guard let next = page.next_offset else { break }
            guard next > offset else { throw CentralTextError.invalidPacket }
            offset = next
        }
        guard var snapshot else { throw ModelSettingsError.incomplete }
        if draftID == nil, revision == nil, let state,
           state.environment_id == snapshot.environment_id,
           state.desired > snapshot.desired || (state.desired == snapshot.desired && stateVersion != stateAtRead) {
            snapshot.desired = state.desired
            snapshot.groups = state.groups
        }
        return (snapshot, count, frozen)
    }

    private func differences(_ before: ModelSettingsSnapshot, _ after: ModelSettingsSnapshot) throws -> [ModelSettingsDifference] {
        var changes: [ModelSettingsDifference] = []
        func compare<T: Encodable & Equatable>(_ old: [T], _ new: [T], id: (T) -> String, title: String) throws {
            let old = Dictionary(uniqueKeysWithValues: old.map { (id($0), $0) })
            let new = Dictionary(uniqueKeysWithValues: new.map { (id($0), $0) })
            for key in Set(old.keys).union(new.keys).sorted() where old[key] != new[key] {
                changes.append(ModelSettingsDifference(id: title + key, title: title + " · " + key,
                    before: try old[key].map { try AssistantModelSettingsWire.pretty($0) } ?? "未配置",
                    after: try new[key].map { try AssistantModelSettingsWire.pretty($0) } ?? "未配置"))
            }
        }
        try compare(before.providers, after.providers, id: { $0.id }, title: "服务商")
        try compare(before.roles, after.roles, id: { $0.key }, title: "角色")
        try compare(before.credentials, after.credentials, id: { $0.credential_ref }, title: "密钥状态")
        return changes
    }

    private func request(_ suffix: String, fields: [String: Any] = [:]) async throws -> CentralTextPacket {
        let id = "model-settings:" + UUID().uuidString
        var fields = fields; fields["control_id"] = id
        let bytes = try AssistantCentralTextWire.encode("model_settings_" + suffix, fields: fields)
        return try await exchange(bytes, id: id)
    }
    private func exchange(_ bytes: Data, id: String) async throws -> CentralTextPacket {
        guard let binding, let send else { throw ModelSettingsError.changed }
        let generation = generation
        let packet = try await send(bytes, id, 30)
        guard self.generation == generation, self.binding == binding else { throw ModelSettingsError.changed }
        guard try packet.fields.value("ok", as: Bool.self) == true else {
            throw ModelSettingsError.server(try packet.fields.value("error_code", as: String.self) ?? "MODEL_SETTINGS_RECEIPT_INVALID")
        }
        return packet
    }
    private func result<T: Decodable>(_ suffix: String, request: [String: Any]? = nil) async throws -> T {
        let packet = try await self.request(suffix, fields: request.map { ["request": $0] } ?? [:])
        return try AssistantModelSettingsWire.result(packet, as: T.self)
    }
    private func perform(_ action: () async throws -> Void) async {
        guard !busy else { return }
        let generation = generation
        busy = true; error = nil
        defer {
            busy = false
            if needsRefresh, connected {
                needsRefresh = false
                let pendingGeneration = self.generation
                Task { [weak self] in
                    guard let self, self.generation == pendingGeneration else { return }
                    await self.refresh()
                }
            }
        }
        do { try await action() }
        catch {
            guard self.generation == generation else { return }
            if case ModelSettingsError.server("MODEL_SETTINGS_REVISION_CONFLICT") = error {
                review = nil
                do { snapshot = try await readSnapshot().0 }
                catch { self.error = error.localizedDescription; return }
            }
            self.error = error.localizedDescription
        }
    }
}
