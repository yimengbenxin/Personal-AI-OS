import Foundation

enum WatchHomeContent: Equatable {
    case question(WatchYimiQuestion)
    case errands([WatchYimiErrand])
    case latest(WatchYimiLatest)
    case empty
}

struct WatchScopedRequest {
    let scope: WatchBindingScope
    let request: WatchLocalEnvelope
}
struct WatchScopedReceipt {
    let scope: WatchBindingScope
    let receipt: WatchLocalEnvelope
}

/// The merged context is the sole scope authority. No ordering is inferred from a scope.
struct WatchStateReducer {
    private(set) var state: WatchYimiState?
    private(set) var credential: WatchCredential?
    var scope: WatchBindingScope? { state?.scope }
    private(set) var pending: [String: WatchScopedRequest] = [:]
    private(set) var receipts: [String: WatchScopedReceipt] = [:]
    private var fingerprints: [String: Data] = [:]
    init(state: WatchYimiState? = nil, credential: WatchCredential? = nil) {
        self.state = state
        self.credential = credential?.scope == state?.scope ? credential : nil
    }
    func validCredential(at now: Date) -> WatchCredential? {
        guard let credential, credential.scope == scope,
              let expiry = Self.date(credential.expires_at), expiry > now else { return nil }
        return credential
    }
    mutating func receiveCredential(_ value: WatchCredential, contextState: WatchYimiState?, now: Date) throws {
        guard contextState != nil, contextState?.scope == scope, value.scope == scope,
              let expiry = Self.date(value.expires_at), expiry > now else { throw WatchYimiError.invalidValue }
        if let credential, credential.server != value.server { throw WatchYimiError.invalidValue }
        credential = value
    }

    func changesScope(_ incoming: WatchYimiState) -> Bool { incoming.scope != scope }
    @discardableResult
    mutating func apply(_ incoming: WatchYimiState, fromContext: Bool) -> Bool {
        if fromContext, changesScope(incoming) {
            pending.removeAll(); receipts.removeAll(); fingerprints.removeAll(); credential = nil
            state = incoming
            return true
        }
        guard incoming.scope == scope,
              state.map({ incoming.rev > $0.rev }) ?? fromContext else { return false }
        if let epoch = incoming.history_epoch, epoch != state?.history_epoch {
            pending.removeAll(); receipts.removeAll(); fingerprints.removeAll()
        }
        state = incoming
        return true
    }
    mutating func begin(_ request: WatchLocalEnvelope, scope: WatchBindingScope) throws {
        guard scope == self.scope, request.kind == .request else { throw WatchYimiError.invalidValue }
        let data = try Self.fingerprint(request)
        if let prior = fingerprints[request.requestID], prior != data { throw WatchYimiError.invalidValue }
        fingerprints[request.requestID] = data
        pending[request.requestID] = WatchScopedRequest(scope: scope, request: request)
    }
    mutating func fail(_ requestID: String) {
        pending.removeValue(forKey: requestID); fingerprints.removeValue(forKey: requestID)
    }
    @discardableResult
    mutating func receive(_ receipt: WatchLocalEnvelope, scope: WatchBindingScope) -> Bool {
        guard scope == self.scope, receipt.kind == .acknowledgement,
              let entry = pending[receipt.requestID], entry.scope == scope,
              entry.request.sequence == receipt.sequence, entry.request.action == receipt.action,
              receipt.version == entry.request.version else { return false }
        pending.removeValue(forKey: receipt.requestID)
        receipts[receipt.requestID] = WatchScopedReceipt(scope: scope, receipt: receipt)
        // Keep a bounded local correlation ledger. Receipts never constitute cloud execution proof.
        if receipts.count > 64, let key = receipts.keys.sorted().first {
            receipts.removeValue(forKey: key); fingerprints.removeValue(forKey: key)
        }
        return true
    }
    static func fingerprint(_ request: WatchLocalEnvelope) throws -> Data {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(request)
    }
    static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = text.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: text)
    }
    static func home(state: WatchYimiState?, now: Date = Date()) -> WatchHomeContent {
        guard let state else { return .empty }
        if let question = state.question, let expiry = date(question.expires_at), expiry > now { return .question(question) }
        if !state.errands.isEmpty { return .errands(state.errands) }
        if let latest = state.latest { return .latest(latest) }
        return .empty
    }
    static func linkText(_ link: WatchYimiLink) -> String {
        switch link {
        case .ok: return "在呢"
        case .server_unreachable: return "暂时连不上依米，稍后再试"
        case .watch_unregistered: return "先在 iPhone 上登记这块手表"
        }
    }
}
