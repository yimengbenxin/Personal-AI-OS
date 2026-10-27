import Foundation

public struct WeChatPreviewPolicy: Codable, Equatable, Sendable {
    public var enabled = false
    public var chats: [String] = []
    public init() {}
}

public struct WeChatPreviewBatch: Codable, Equatable, Sendable {
    public let batch_id: String
    public let previews: [WeChatPreview]
}

/// The producer's consent and pending delivery live together. Cloud events and replies remain server owned.
public actor WeChatPreviewInbox {
    private struct Pending: Codable { let batch: WeChatPreviewBatch; let cursor: WeChatPreviewCursor }
    private struct State: Codable {
        var policy = WeChatPreviewPolicy()
        var owner: String? = nil
        var cursor = WeChatPreviewCursor(since: Date())
        var pending: Pending? = nil
        var historyEpoch: String? = nil
    }
    private var state: State
    private let file: URL
    public init(file: URL) throws {
        self.file = file
        state = FileManager.default.fileExists(atPath: file.path) ? try JSONDecoder().decode(State.self, from: Data(contentsOf: file)) : State()
    }
    public func policy() -> WeChatPreviewPolicy { state.policy }
    public func configure(_ policy: WeChatPreviewPolicy, owner: String, now: Date = Date()) throws {
        var next = State(); next.policy = policy; next.owner = owner; next.cursor = WeChatPreviewCursor(since: now)
        try save(next)
    }
    public func reset() throws { try save(State()) }
    public func acceptTrustedHistoryEpoch(_ epoch: String, now: Date = Date()) throws {
        guard state.historyEpoch != epoch else { return }
        var next = state
        next.cursor = WeChatPreviewCursor(since: now); next.pending = nil; next.historyEpoch = epoch
        try save(next)
    }
    public func prepare(reader: WeChatNotificationReader, owner: String) throws -> WeChatPreviewBatch? {
        guard state.policy.enabled, state.owner == owner, !state.policy.chats.isEmpty else { return nil }
        if let pending = state.pending { return pending.batch }
        let page = try reader.read(after: state.cursor, chats: Set(state.policy.chats))
        var next = state
        if page.previews.isEmpty { next.cursor = page.cursor }
        else { next.pending = Pending(batch: WeChatPreviewBatch(batch_id: UUID().uuidString.lowercased(), previews: page.previews), cursor: page.cursor) }
        if next.cursor != state.cursor || next.pending != nil { try save(next) }
        return state.pending?.batch
    }
    public func acknowledge(_ batchID: String) throws {
        guard let pending = state.pending, pending.batch.batch_id == batchID else { return }
        var next = state; next.cursor = pending.cursor; next.pending = nil
        try save(next)
    }
    private func save(_ next: State) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        state = next
    }
}
