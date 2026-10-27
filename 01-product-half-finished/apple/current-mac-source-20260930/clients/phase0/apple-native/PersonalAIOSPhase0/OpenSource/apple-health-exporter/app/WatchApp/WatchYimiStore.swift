import Combine
import Foundation
import Security

protocol WatchCredentialStoring {
    func load() throws -> Data?
    func save(_ data: Data?) throws
}

struct KeychainWatchCredentialStore: WatchCredentialStoring {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "ai.paios.watch.credential.v1",
         kSecAttrAccount as String: "watch-credential"]
    }
    func load() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return value as? Data
    }
    func save(_ data: Data?) throws {
        let deleted = SecItemDelete(query as CFDictionary)
        guard deleted == errSecSuccess || deleted == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(deleted))
        }
        guard let data else { return }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}

@MainActor
final class WatchYimiStore: ObservableObject {
    @Published private(set) var state: WatchYimiState?
    @Published private(set) var lastError: String?
    @Published private(set) var lastReceipt: WatchLocalEnvelope?
    @Published private(set) var credential: WatchCredential?
    @Published private(set) var lastCompletedRequest: WatchLocalEnvelope?
    /// When the phone's ride figures last changed on this watch. Nothing carries a sample time with them, so this is
    /// how the ride screen tells current figures from ones left over after the phone went away.
    private(set) var rideMetricsAt: Date?
    var onReceipt: ((WatchLocalAckStatus) -> Void)?
    private(set) var reducer: WatchStateReducer
    private let defaults: UserDefaults?
    private let credentials: any WatchCredentialStoring
    private let cacheKey = "paios.watch.yimi-state.v1"
    var onScopeChange: (() -> Void)?
    var sendAction: ((WatchAssistantAction, WatchYimiActionArguments) -> String?)?
    var currentScope: WatchBindingScope? { reducer.scope }
    var validCredential: WatchCredential? { validCredential(at: Date()) }
    func validCredential(at now: Date) -> WatchCredential? { reducer.validCredential(at: now) }
    init(defaults: UserDefaults? = .standard, credentials: any WatchCredentialStoring = KeychainWatchCredentialStore()) {
        self.defaults = defaults; self.credentials = credentials
        var cached: WatchYimiState?
        var cacheError: String?
        if let data = defaults?.data(forKey: cacheKey) {
            do { cached = try WatchYimiState.decodeStrict(data) }
            catch { cacheError = "保存的状态无法读取：\(error)" }
        }
        reducer = WatchStateReducer(state: cached); state = cached
        if let cacheError { report(cacheError) }
        do {
            if let data = try credentials.load() {
                let value = try JSONDecoder().decode(WatchCredential.self, from: data)
                if value.scope == cached?.scope {
                    reducer = WatchStateReducer(state: cached, credential: value)
                    credential = reducer.credential
                }
                else { try credentials.save(nil) }
            }
        } catch { report("连接凭证无法读取：\(error)") }
    }
    /// Call with the entire merged context, including at cold launch.
    func receiveContext(_ context: [String: Any]) {
        guard let data = context["yimi_state"] as? Data else {
            if context["yimi_state"] != nil { report("状态必须是 Data") }
            if let raw = context["watch_credential"] {
                do {
                    guard let data = raw as? Data else { throw WatchYimiError.invalidValue }
                    let value = try JSONDecoder().decode(WatchCredential.self, from: data)
                    try reducer.receiveCredential(value, contextState: nil, now: Date())
                } catch { report("忽略没有同批状态的连接凭证：\(error)") }
            }
            return
        }
        do {
            let incoming = try WatchYimiState.decodeStrict(data)
            lastError = nil
            if reducer.changesScope(incoming) {
                onScopeChange?()
                credential = nil; lastReceipt = nil; lastCompletedRequest = nil
                // The authority transition must clear in-memory work even if the vault is unavailable.
                do { try credentials.save(nil) }
                catch { report("旧连接凭证删除失败：\(error)") }
            }
            let historyChanged = incoming.history_epoch != nil && incoming.history_epoch != state?.history_epoch
            if reducer.apply(incoming, fromContext: true) {
                if historyChanged { lastReceipt = nil; lastCompletedRequest = nil }
                try publishState()
            }
            if let raw = context["watch_credential"] {
                guard let bytes = raw as? Data else { throw WatchYimiError.invalidValue }
                let value = try JSONDecoder().decode(WatchCredential.self, from: bytes)
                var updated = reducer
                try updated.receiveCredential(value, contextState: incoming, now: Date())
                try credentials.save(bytes)
                reducer = updated
                credential = reducer.credential
            }
        } catch { report("状态接收失败：\(error)") }
    }
    func receiveMessageState(_ data: Data) {
        do {
            let incoming = try WatchYimiState.decodeStrict(data)
            guard incoming.scope == currentScope else { report("忽略其他绑定的即时状态"); return }
            let historyChanged = incoming.history_epoch != nil && incoming.history_epoch != state?.history_epoch
            if reducer.apply(incoming, fromContext: false) {
                if historyChanged { lastReceipt = nil; lastCompletedRequest = nil }
                try publishState()
            }
        } catch { report("即时状态接收失败：\(error)") }
    }
    func begin(_ request: WatchLocalEnvelope, scope: WatchBindingScope) throws { try reducer.begin(request, scope: scope); lastError = nil }
    func fail(_ requestID: String, error: String) { reducer.fail(requestID); report(error) }
    func receiveReceipt(_ data: Data, scope: WatchBindingScope) {
        do {
            let receipt = try WatchLocalEnvelope.decodeStrict(data)
            let request = reducer.pending[receipt.requestID]?.request
            guard reducer.receive(receipt, scope: scope) else { report("忽略不匹配的操作回执"); return }
            lastCompletedRequest = request
            lastReceipt = receipt
            if let status = receipt.status { onReceipt?(status) }
        } catch { report("操作回执无法读取：\(error)") }
    }
    func report(_ detail: String, userMessage: String = "暂时没能同步，请稍后再试。") {
        lastError = userMessage
        print("YIMI_WATCH \(detail)")
    }
    private func publishState() throws {
        guard let value = reducer.state else { return }
        defaults?.set(try value.encodedStrict(), forKey: cacheKey)
        if value.ride?.metrics != state?.ride?.metrics { rideMetricsAt = Date() }
        state = value
    }
    @discardableResult
    func answer(cardID: String, optionID: String) -> String? { sendAction?(.cardAnswer, .init(card_id: cardID, option_id: optionID)) }
    @discardableResult
    func stopErrand(jobID: String) -> String? { sendAction?(.errandStop, .init(job_id: jobID)) }
    @discardableResult
    func careSafe(careID: String) -> String? { sendAction?(.careSafe, .init(care_id: careID)) }
    @discardableResult
    func requestState() -> String? { sendAction?(.stateRequest, .init()) }
    @discardableResult
    func refreshCredential() -> String? { sendAction?(.credentialRefresh, .init()) }
}
