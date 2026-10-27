import Foundation

struct CentralAttachment: Codable, Equatable, Sendable {
    let grant_id: String; let path: String; let name: String; let size: Int64; let kind: String
    init(grantID: String, path: String, name: String, size: Int64, kind: String) {
        self.grant_id = grantID; self.path = path; self.name = name; self.size = size; self.kind = kind
    }
}
struct CentralTimelineAttachment: Codable, Equatable, Sendable {
    let name: String; let kind: String; let size: Int
}
struct CentralTerminal: Codable, Equatable, Identifiable, Sendable {
    let device_id: String; let device_class: String; let label: String?; let paired_at: String
    let connected: Bool; let last_seen_at: String?; let `self`: Bool; let paused: Bool?
    var id: String { device_id }
    var isSelf: Bool { self.`self` }
    var displayName: String { label ?? (device_class == "iphone" ? "iPhone" : device_class == "glasses" ? "眼镜" : "Mac") }
}
struct CentralPendingConfirmation: Codable, Equatable, Identifiable, Sendable {
    let confirmation_id: String; let kind: String; let text: String?; let expires_in_ms: Int; let answer_on: String
    var id: String { confirmation_id }
}
struct CentralTerminalReceipt: Codable, Equatable, Sendable {
    let control_id: String; let ok: Bool; let error_code: String?
}
struct CentralTimelineItem: Codable, Equatable, Sendable {
    let seq: Int; let item_id: String; let kind: String; let via: String; var text: String; let at: String
    let source_class: String?; let part: Int?; let parts: Int?; let attachments: [CentralTimelineAttachment]?
}

/// Server sequence and content commit together; a partial item never advances the durable cursor.
struct CentralTerminalState {
    private(set) var historyEpoch: String?
    private(set) var historyResetID: UUID?
    private(set) var historyGeneration: UInt64 = 0
    private(set) var historyEpochConfirmed = false

    /// Called only from the authenticated ready packet. A persisted epoch makes reconnects idempotent.
    @discardableResult mutating func applyHistoryEpoch(_ epoch: String?) -> Bool {
        historyEpochConfirmed = epoch != nil
        guard let epoch else { return false }
        let changed = epoch != historyEpoch
        if changed || historyGeneration == 0 { historyGeneration = AssistantHistoryFiles.nextGeneration() }
        guard changed else { return false }
        historyEpoch = epoch; historyResetID = UUID()
        timeline = YimiConversationTimeline(); lastSeq = 0; syncHeadSeq = 0
        completedSeqs = []; fragments = [:]; removed = []; removedBefore = 0
        confirmations = []; requestID = nil; hasOlderHistory = true; initialSeed = false
        return true
    }
    private(set) var ownerIdentity: String?

    /// Only a source-authenticated session can bind new server timeline entries to an owner.
    mutating func bindOwner(_ identity: String?) {
        guard ownerIdentity != identity else { return }
        self = CentralTerminalState()
        ownerIdentity = identity
    }

    var appearance = AssistantAppearanceState()
    var avatar: CentralAvatarProfile?
    var avatarVersion = 0
    var avatarLoadedReceipts: [AssistantAppearanceLoadedReceipt] = []
    var avatarReceived = false
    private(set) var avatarEventID = UUID()
    var terminals: [CentralTerminal] = []
    var confirmations: [CentralPendingConfirmation] = []
    var receipt: CentralTerminalReceipt?
    var timeline = YimiConversationTimeline()
    var lastSeq = 0
    private var completedSeqs = Set<Int>()
    private var fragments: [Int: [Int: CentralTimelineItem]] = [:]
    private var removed = Set<Int>()
    private var removedBefore = 0
    private(set) var pages = 0
    private(set) var requestID: String?
    private var older = false
    private var requestedAfter = 0
    private(set) var syncHeadSeq = 0
    private(set) var syncFailed = false
    private(set) var hasOlderHistory = true
    private var initialSeed = false
    private var seedHead: Int?
    var isCatchingUp: Bool { requestID != nil && !older }

    mutating func attach() { initialSeed = false; syncFailed = false; pages = 0; fragments = [:]; completedSeqs = []; requestID = nil }
    /// One marked wire page per history gesture; reconnects drain only forward changes.
    mutating func sync(before: Int? = nil) throws -> Data {
        if requestID != nil { fragments = [:]; completedSeqs = [] }
        initialSeed = before == nil && lastSeq == 0
        if initialSeed {
            timeline = YimiConversationTimeline(items: timeline.items.filter { $0.seq == nil })
            seedHead = nil; syncHeadSeq = 0
        }
        return try request(before: before)
    }
    mutating func loadOlder(before: Int) throws -> Data? {
        guard requestID == nil, hasOlderHistory else { return nil }
        return try sync(before: before)
    }
    private mutating func request(before: Int? = nil) throws -> Data {
        syncFailed = false
        requestID = UUID().uuidString; older = before != nil; requestedAfter = lastSeq
        var fields: [String: Any] = ["request_id": requestID!, "limit": 30, "page_markers": true]
        if let before { fields["before_seq"] = before }
        else if lastSeq > 0 { fields["after_seq"] = lastSeq }
        return try AssistantCentralTextWire.encode("timeline_sync", fields: fields)
    }
    /// Failure belongs to the exact request; an old publication error cannot cancel a newer sync intent.
    @discardableResult mutating func failSync(requestID failedRequest: String?) -> Bool {
        guard let failedRequest, requestID == failedRequest else { return false }
        requestID = nil; syncFailed = true; fragments = [:]; completedSeqs = []
        return true
    }
    private mutating func commitCursor() {
        // A seed can be re-queried under the same request after a failed publication.
        // Its first head is the only safe watermark until forward changes have been replayed.
        guard !initialSeed else { return }
        let ceiling = fragments.keys.min().map { $0 - 1 } ?? Int.max
        if let committed = completedSeqs.filter({ $0 <= ceiling }).max() { lastSeq = max(lastSeq, committed) }
        completedSeqs = completedSeqs.filter { $0 > lastSeq }
    }
    /// One page is committed before requesting the next. Timeline retention remains bounded at 5,000 items.
    /// A server claiming more history must advance the cursor; otherwise surface the broken contract.
    private mutating func finishPage(_ fields: CentralBody) throws -> Data? {
        pages += 1
        let more = try fields.value("has_more", as: Bool.self) == true
        if initialSeed || older {
            hasOlderHistory = more
            if initialSeed, let seedHead {
                lastSeq = seedHead
                completedSeqs = []
            }
            let resumeForward = lastSeq < syncHeadSeq
            initialSeed = false
            if resumeForward { return try request() }
            requestID = nil
            return nil
        }
        if more {
            guard lastSeq > requestedAfter else { throw CentralTextError.invalidPacket }
            return try request()
        }
        // A fully consumed forward snapshot also covers hidden timeline positions through its head.
        let head = try fields.value("head_seq", as: Int.self) ?? 0
        lastSeq = max(lastSeq, head)
        if syncHeadSeq > head { return try request() }
        requestID = nil
        return nil
    }
    private mutating func gapSync() throws -> Data? { requestID == nil ? try sync() : nil }
    mutating func accept(_ packet: CentralTextPacket) throws -> (handled: Bool, request: Data?) {
        let pending = requestID
        do { return try acceptPacket(packet) }
        catch { failSync(requestID: pending); throw error }
    }
    private mutating func acceptPacket(_ packet: CentralTextPacket) throws -> (handled: Bool, request: Data?) {
        let fields = packet.fields
        let operation = try fields.value("operation", as: String.self)
        if let operation, try appearance.consume(operation, fields: fields) { return (true, nil) }
        if operation == "timeline_items" || operation == "timeline_removed" || operation == "timeline_reset" {
            if let response = try fields.value("request_id", as: String.self), response != requestID { return (true, nil) }
            let head = try fields.value("head_seq", as: Int.self) ?? 0
            syncHeadSeq = max(syncHeadSeq, head)
            if initialSeed, !older, seedHead == nil, operation == "timeline_items",
               try fields.value("request_id", as: String.self) == requestID { seedHead = head }
        }
        switch try fields.value("operation", as: String.self) {
        case "avatar_state":
            let incoming = try fields.value("profile", as: CentralAvatarProfile.self)
            try incoming?.validate()
            let revision = try fields.value("profile_version", as: Int.self) ?? incoming?.version ?? 0
            if revision >= avatarVersion {
                avatar = incoming; avatarVersion = revision; avatarReceived = true; avatarEventID = UUID()
                avatarLoadedReceipts = try fields.value("loaded_receipts", as: [AssistantAppearanceLoadedReceipt].self) ?? []
            }
        case "terminals": terminals = try fields.value("terminals", as: [CentralTerminal].self) ?? []
        case "confirmations": confirmations = try fields.value("items", as: [CentralPendingConfirmation].self) ?? []
        case "terminal_receipt": receipt = try JSONDecoder().decode(CentralTerminalReceipt.self, from: packet.bytes)
        case "timeline_reset":
            let bootstrapReset = requestID != nil && (initialSeed || older)
            timeline = YimiConversationTimeline(); lastSeq = 0; syncHeadSeq = 0; completedSeqs = []; removed = []; removedBefore = 0; fragments = [:]
            if bootstrapReset { throw CentralTextError.invalidPacket }
            return (true, try sync())
        case "timeline_resync":
            syncHeadSeq = max(syncHeadSeq, try fields.value("head_seq", as: Int.self) ?? 0)
            return (true, try gapSync())
        case "timeline_removed":
            let seq = try fields.value("seq", as: Int.self) ?? 0
            removed.formUnion(try fields.value("removed_seqs", as: [Int].self) ?? [])
            removedBefore = max(removedBefore, try fields.value("before_seq", as: Int.self) ?? 0)
            timeline.removeServerItems(seqs: removed, before: removedBefore)
            fragments = fragments.filter { !removed.contains($0.key) && $0.key >= removedBefore }
            if seq > lastSeq + 1, try fields.value("request_id", as: String.self) == nil { return (true, try gapSync()) }
            completedSeqs.insert(seq); commitCursor()
            if let response = try fields.value("request_id", as: String.self), response == requestID, try fields.value("page_end", as: Bool.self) == true {
                return (true, try finishPage(fields))
            }
        case "timeline_items":
            let incoming = try fields.value("items", as: [CentralTimelineItem].self) ?? []
            let response = try fields.value("request_id", as: String.self)
            if response != nil {
                // The gateway retries a failed item from its first fragment within this request.
                fragments = fragments.filter { seq, _ in incoming.contains { $0.seq == seq && $0.part != nil } }
            }
            var expected = lastSeq
            var gap = false, discardedPartial = false
            if response == nil {
                for seq in Set(incoming.map(\.seq)).sorted() where seq > expected {
                    if seq > expected + 1 { gap = true }
                    expected = seq
                }
            }
            for var item in incoming {
                if removed.contains(item.seq) || item.seq < removedBefore {
                    // A prepared page can arrive after its live deletion. Consume its position, never its text.
                    // Wait for the final fragment so the next request cannot overtake this server item.
                    if item.part != item.parts { discardedPartial = true }
                    else if response != nil { completedSeqs.insert(item.seq) }
                    continue
                }
                if let part = item.part, let count = item.parts {
                    // The gateway serializes a split item before starting another item (timelineFrames).
                    guard count <= 1024, fragments.isEmpty || fragments[item.seq] != nil else { throw CentralTextError.invalidPacket }
                    fragments[item.seq, default: [:]][part] = item
                    guard fragments[item.seq]?.count == count else { continue }
                    item.text = try (1...count).map { index in
                        guard let fragment = fragments[item.seq]?[index], fragment.item_id == item.item_id else { throw CentralTextError.invalidPacket }
                        return fragment.text
                    }.joined()
                    fragments[item.seq] = nil
                }
                timeline.accept(item, ownerIdentity: ownerIdentity)
                if !gap { completedSeqs.insert(item.seq) }
            }
            commitCursor()
            if gap { return (true, try gapSync()) }
            if let response, response == requestID, fragments.isEmpty, !discardedPartial, try fields.value("page_end", as: Bool.self) == true {
                return (true, try finishPage(fields))
            }
        default: return (false, nil)
        }
        return (true, nil)
    }

    /// Identity of persisted facts; timeline revision avoids comparing retained history.
    struct CacheProjection: Equatable {
        let ownerIdentity: String?
        let timelineRevision: UUID
        let lastSeq: Int
        let removed: Set<Int>
        let removedBefore: Int
        let terminals: [CentralTerminal]
        let hasOlderHistory: Bool
    }
    var cacheProjection: CacheProjection {
        CacheProjection(ownerIdentity: ownerIdentity, timelineRevision: timeline.revision, lastSeq: lastSeq,
            removed: removed, removedBefore: removedBefore, terminals: terminals, hasOlderHistory: hasOlderHistory)
    }

    struct Cache: Codable { var ownerIdentity: String? = nil; let items: [YimiItem]; let lastSeq: Int; let removed: Set<Int>?; let removedBefore: Int?; var terminals: [CentralTerminal]? = nil; var hasOlderHistory: Bool? = nil; var historyEpoch: String? = nil }
    func encodedCache() throws -> Data { try JSONEncoder().encode(Cache(ownerIdentity: ownerIdentity, items: timeline.items, lastSeq: lastSeq, removed: removed, removedBefore: removedBefore, terminals: terminals, hasOlderHistory: hasOlderHistory, historyEpoch: historyEpoch)) }
    mutating func restore(_ data: Data) throws {
        let cache = try JSONDecoder().decode(Cache.self, from: data)
        ownerIdentity = cache.ownerIdentity
        historyEpoch = cache.historyEpoch
        terminals = cache.terminals ?? []
        hasOlderHistory = cache.hasOlderHistory ?? true
        timeline = YimiConversationTimeline(items: cache.items); lastSeq = cache.lastSeq
        removed = cache.removed ?? []; removedBefore = cache.removedBefore ?? 0
    }
}

extension YimiConversationTimeline {
    mutating func accept(_ item: CentralTimelineItem, ownerIdentity: String? = nil) {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fractional = formatter.date(from: item.at); formatter.formatOptions = [.withInternetDateTime]
        upsert(YimiItem(id: item.item_id, kind: item.kind == "owner" ? .me : .her, text: item.text,
            date: fractional ?? formatter.date(from: item.at) ?? .distantPast, via: item.via, seq: item.seq, attachments: item.attachments, ownerIdentity: ownerIdentity))
    }
}

/// One process gate covers both history writers. A pending marker resumes an interrupted multi-account purge.
enum AssistantHistoryFiles {
    private static let gate = NSRecursiveLock()
    private static var counter: UInt64 = 0
    private static var generations: [String: (epoch: String, generation: UInt64)] = [:]
    static func nextGeneration() -> UInt64 {
        locked { counter &+= 1; return counter }
    }
    static func locked<T>(_ body: () throws -> T) rethrows -> T {
        gate.lock(); defer { gate.unlock() }; return try body()
    }
    private static func marker(_ folder: URL, pending: Bool = false) -> URL {
        folder.appendingPathComponent(pending ? "yimi-history-epoch.pending" : "yimi-history-epoch")
    }
    static func permits(_ epoch: String?, in folder: URL) -> Bool {
        if let latest = generations[folder.standardizedFileURL.path], latest.epoch != epoch { return false }
        guard !FileManager.default.fileExists(atPath: marker(folder, pending: true).path) else { return false }
        let saved = try? String(contentsOf: marker(folder), encoding: .utf8)
        return saved == nil || saved == epoch
    }
    @discardableResult static func retire(_ epoch: String, generation: UInt64 = 0, in folder: URL, desktop: Bool = false) throws -> Bool {
        try locked {
            let key = folder.standardizedFileURL.path
            if let latest = generations[key], latest.epoch != epoch, generation <= latest.generation {
                throw CocoaError(.fileWriteNoPermission)
            }
            if generations[key] == nil || generation >= generations[key]!.generation {
                generations[key] = (epoch, generation)
            }
            let pending = marker(folder, pending: true)
            if permits(epoch, in: folder),
               (try? String(contentsOf: marker(folder), encoding: .utf8)) == epoch { return false }
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data(epoch.utf8).write(to: pending, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            for path in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
                let name = path.lastPathComponent
                if name.hasPrefix("yimi-conversation") || name.hasPrefix("yimi-terminal-") || desktop && name.hasPrefix("conversation.") {
                    try FileManager.default.removeItem(at: path)
                }
            }
            let temporary = FileManager.default.temporaryDirectory
            for path in try FileManager.default.contentsOfDirectory(at: temporary, includingPropertiesForKeys: nil)
                where path.lastPathComponent.hasPrefix("paios-formal-voice-") {
                try FileManager.default.removeItem(at: path)
            }
            try Data(epoch.utf8).write(to: marker(folder), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try FileManager.default.removeItem(at: pending)
            return true
        }
    }
}

/// Encoding and atomic replacement run outside the UI actor; delayed older tasks cannot replace newer caches.
actor CentralTerminalCacheWriter {
    private var written: UInt64 = 0
    private var projection: CentralTerminalState.CacheProjection?
    private var destination: URL?

    func write(_ state: CentralTerminalState, version: UInt64, to url: URL) throws {
        guard version > written else { return }
        try AssistantHistoryFiles.locked {
        let folder = url.deletingLastPathComponent()
        var retired = false
        if state.historyEpochConfirmed, let epoch = state.historyEpoch {
            retired = try AssistantHistoryFiles.retire(epoch, generation: state.historyGeneration, in: folder, desktop: url.lastPathComponent == "conversation.json")
        }
        guard AssistantHistoryFiles.permits(state.historyEpoch, in: folder) else { throw CocoaError(.fileWriteNoPermission) }
        let incoming = state.cacheProjection
        if !retired, destination == url, projection == incoming {
            written = version
            return
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try state.encodedCache().write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        written = version
        projection = incoming
        destination = url
        }
    }

    func remove(version: UInt64, at url: URL) throws {
        guard version > written else { return }
        written = version
        projection = nil
        destination = nil
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}
