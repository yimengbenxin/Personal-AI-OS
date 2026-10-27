import Foundation
import GRDB
import CryptoKit

// This store is deliberately endpoint-local. It is a crash/relaunch cache for
// Apple-client work and is never a T02/PostgreSQL or T10 DeliveryReceipt store.
enum AssistantLocalOperationState: String, Codable, Equatable, Sendable {
    case pending
    case stopUnknown = "stop_unknown"
    case completed
    case abandoned
}

enum AssistantLocalOperationDatabaseError: LocalizedError, Equatable, Sendable {
    case fingerprintConflict(operationID: String)
    case operationNotFound(operationID: String)
    case invalidTransition(operationID: String, state: String)
    case forbiddenField(String)
    case invalidFingerprint
    case invalidStatusCode
    case corruptRow
    case fileProtectionMismatch
    case qwenReplyTooLarge

    var errorDescription: String? {
        switch self {
        case .fingerprintConflict(let operationID):
            return "本地操作 \(operationID) 的指纹发生冲突。"
        case .operationNotFound(let operationID):
            return "本地操作 \(operationID) 不存在。"
        case .invalidTransition(let operationID, let state):
            return "本地操作 \(operationID) 不能从 \(state) 完成当前转换。"
        case .forbiddenField(let field):
            return "本地操作字段 \(field) 不允许写入。"
        case .invalidFingerprint:
            return "本地操作指纹必须是固定格式的 SHA-256 摘要。"
        case .invalidStatusCode:
            return "本地回执状态码不是安全的短状态标识。"
        case .corruptRow:
            return "本地操作数据库包含无法解码的行。"
        case .fileProtectionMismatch:
            return "本地操作数据库文件保护属性不符合要求。"
        case .qwenReplyTooLarge:
            return "千问回复超过正式文字消息限制；请缩短后重新返回。"
        }
    }
}

struct AssistantLocalOperation: Codable, Equatable, Sendable {
    let operationID: String
    let kind: String
    let fingerprint: String
    let state: AssistantLocalOperationState
    let createdAt: Date
    let updatedAt: Date
    let attemptCount: Int
    let lastError: String?

    var isReplayable: Bool {
        state == .pending || state == .stopUnknown
    }
}

enum AssistantLocalOperationAdmission: Equatable, Sendable {
    case inserted(AssistantLocalOperation)
    case duplicate(AssistantLocalOperation)
    case conflict(existing: AssistantLocalOperation)
}

struct AssistantLocalReceiptCacheEntry: Equatable, Sendable {
    let operationID: String
    let kind: String
    let recordedAt: Date
    let localCleanupComplete: Bool
    let remoteConfirmationPresent: Bool
    let statusCode: String
}

protocol AppleLocalPendingCaching: Sendable {
    // This is a cache seam only. The opaque remote reference is intentionally
    // not part of the cache API and cannot become a DeliveryReceipt authority.
    func cache(_ receipt: AppleLocalOperationReceipt) throws
}

struct AssistantLocalStopReplay: Sendable {
    let operationID: String
    let payload: Data
}

struct AssistantLocalCareSafe: Codable, Equatable, Sendable {
    let controlID: String
    let identity: String
    let deviceID: String
}

private struct AssistantLocalPairingReplacement: Codable {
    let previousIdentity: String?
    let identity: String
}

struct AssistantRetainedPrompt: Codable, Equatable, Sendable {
    let identity: String
    let eventID: String
    let capturedAt: String
    let text: String
    let location: AssistantRetainedLocation?
}

/// Persist the capture metadata without changing the location service's ownership or refreshing its timestamp.
struct AssistantRetainedLocation: Codable, Equatable, Sendable {
    let localCaptureID: String
    let latitude: Double
    let longitude: Double
    let horizontalAccuracy: Double
    let observedAt: Date
    let place: String?

    init(_ fix: AssistantLocationObservation) {
        localCaptureID = fix.localCaptureID; latitude = fix.latitude; longitude = fix.longitude
        horizontalAccuracy = fix.horizontalAccuracy; observedAt = fix.observedAt; place = fix.place
    }

    var observation: AssistantLocationObservation {
        AssistantLocationObservation(localCaptureID: localCaptureID, latitude: latitude, longitude: longitude,
            horizontalAccuracy: horizontalAccuracy, observedAt: observedAt, place: place)
    }
}

private struct AssistantLocalQwenHandoff: Codable {
    let identity: String
    let sourceID: String
    let pending: QwenHandoff.Pending
    var reply: AssistantRetainedPrompt?
}

final class AssistantLocalOperationDatabase: AppleLocalPendingCaching, @unchecked Sendable {
    static let requiredFileProtection = FileProtectionType.completeUntilFirstUserAuthentication
    private static let maximumOperationIDLength = 128
    private static let maximumKindLength = 64
    private static let receiptCacheCapacity = 128
    private static let completedOperationCapacity = 128
    private static let forbiddenFieldFragments = [
        "bearer", "token", "secret", "password", "credential",
        "privatekey", "contentkey", "e2eekey", "authorization"
    ]

    let databaseURL: URL

    private let queue: DatabaseQueue
    private let fileManager: FileManager
#if targetEnvironment(simulator)
    private var simulatorProtectionWriteSucceededPaths = Set<String>()
#endif

    init(
        url: URL,
        fileManager: FileManager = .default
    ) throws {
        self.databaseURL = url
        self.fileManager = fileManager

        let directory = url.deletingLastPathComponent()
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )

        self.queue = try DatabaseQueue(path: url.path)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1_local_operation_cache") { db in
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS local_operations (
                    operation_id TEXT NOT NULL PRIMARY KEY,
                    kind TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT
                )
                """)
            try db.execute(sql: """
                CREATE TABLE IF NOT EXISTS local_receipt_cache (
                    operation_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    recorded_at REAL NOT NULL,
                    local_cleanup_complete INTEGER NOT NULL,
                    remote_confirmation_present INTEGER NOT NULL,
                    status_code TEXT NOT NULL,
                    PRIMARY KEY (operation_id, kind)
                )
                """)
            try db.execute(sql: """
                CREATE INDEX IF NOT EXISTS local_operations_replay_index
                ON local_operations (state, updated_at, created_at)
                """)
        }
        migrator.registerMigration("v2_stop_replay_payload") { db in
            try db.execute(sql: "ALTER TABLE local_operations ADD COLUMN replay_payload BLOB")
        }
        migrator.registerMigration("v3_place_outbox") { db in
            try db.execute(sql: "CREATE TABLE place_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload BLOB NOT NULL)")
            try db.execute(sql: "CREATE TABLE place_outbox (id TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL)")
        }
        migrator.registerMigration("v4_move_outbox") { db in
            try db.execute(sql: "CREATE TABLE move_outbox (id TEXT PRIMARY KEY NOT NULL, identity TEXT NOT NULL, payload BLOB NOT NULL)")
            try db.execute(sql: "CREATE TABLE move_checkpoint (identity TEXT PRIMARY KEY NOT NULL, payload BLOB NOT NULL)")
        }
        migrator.registerMigration("v5_outstanding_qwen_index") { db in
            try db.execute(sql: "CREATE INDEX local_operations_outstanding_qwen ON local_operations (kind) WHERE kind = 'qwen_handoff' AND state != 'completed'")
        }
        try migrator.migrate(queue)
        try queue.write { db in
            try pruneCompletedOperations(db: db)
        }
        try protectSQLiteFiles()
    }

    convenience init(
        path: String,
        fileManager: FileManager = .default
    ) throws {
        try self.init(url: URL(fileURLWithPath: path), fileManager: fileManager)
    }

    static func defaultURL(fileManager: FileManager = .default) throws -> URL {
        guard let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            throw AssistantLocalOperationDatabaseError.fileProtectionMismatch
        }
        return applicationSupport
            .appendingPathComponent("PersonalAIOSPhase0", isDirectory: true)
            .appendingPathComponent("assistant-local-operations.sqlite")
    }

    func placeState() throws -> PlaceSensingState {
        try queue.read { db in try placeState(db) }
    }

    /// History generation from the authenticated server; never exposed as a local/model operation.
    func discardProductHistory(epoch: String) throws {
        try AssistantHistoryFiles.locked {
        let marker = databaseURL.appendingPathExtension("history-epoch")
        if (try? String(contentsOf: marker, encoding: .utf8)) == epoch { return }
        try queue.write { db in
            try db.execute(sql: "PRAGMA secure_delete=ON")
            let old = try placeState(db)
            var fresh = PlaceSensingState()
            fresh.enabled = old.enabled; fresh.identity = old.identity; fresh.needsRegionSync = old.enabled
            for table in ["local_receipt_cache", "local_operations", "place_outbox", "move_outbox", "move_checkpoint", "place_state"] {
                try db.execute(sql: "DELETE FROM \(table)")
            }
            try db.execute(sql: "INSERT INTO place_state(id,payload) VALUES(1,?)", arguments: [try JSONEncoder().encode(fresh)])
        }
        try queue.writeWithoutTransaction { db in
            guard let row = try Row.fetchOne(db, sql: "PRAGMA wal_checkpoint(TRUNCATE)") else { throw CocoaError(.fileWriteUnknown) }
            let busy: Int = row["busy"]
            guard busy == 0 else { throw CocoaError(.fileWriteUnknown) }
            try db.execute(sql: "VACUUM")
        }
        try Data(epoch.utf8).write(to: marker, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    private func placeState(_ db: Database) throws -> PlaceSensingState {
        try Data.fetchOne(db, sql: "SELECT payload FROM place_state WHERE id = 1")
            .map { try JSONDecoder().decode(PlaceSensingState.self, from: $0) } ?? PlaceSensingState()
    }

    func savePlaceState(_ state: PlaceSensingState, removing ids: [String] = [], clearOutbox: Bool = false) throws {
        let payload = try JSONEncoder().encode(state)
        try queue.write { db in
            let current = try placeState(db)
            guard clearOutbox || (current.identity == state.identity && current.enabled == state.enabled) else {
                throw CentralTextError.contextChanged()
            }
            try db.execute(sql: "INSERT OR REPLACE INTO place_state VALUES (1, ?)", arguments: [payload])
            if clearOutbox { try db.execute(sql: "DELETE FROM place_outbox") }
            else { for id in ids { try db.execute(sql: "DELETE FROM place_outbox WHERE id = ?", arguments: [id]) } }
        }
        try protectSQLiteFiles()
    }

    @discardableResult
    func persistPlaceEvent(_ event: PlaceEvent, identity: String) throws -> Bool {
        let payload = try JSONEncoder().encode(event)
        let inserted = try queue.write { db in
            let state = try placeState(db)
            guard state.enabled, state.identity == identity else { return false }
            try db.execute(sql: "INSERT INTO place_outbox VALUES (?, ?)", arguments: [event.id, payload])
            return true
        }
        try protectSQLiteFiles()
        return inserted
    }

    func pendingPlaceEvents(limit: Int = 64) throws -> [PlaceEvent] {
        try queue.read { db in
            try Data.fetchAll(db, sql: "SELECT payload FROM place_outbox ORDER BY rowid LIMIT ?", arguments: [limit])
                .map { try JSONDecoder().decode(PlaceEvent.self, from: $0) }
        }
    }

    func preserveMoveEvents(_ records: [MoveLifecycleRecord], checkpoint: Data? = nil) throws {
        try queue.write { db in
            if let checkpoint, let identity = records.first?.identity {
                try db.execute(sql: "INSERT OR REPLACE INTO move_checkpoint VALUES (?, ?)", arguments: [identity, checkpoint])
            }
            for record in records {
                guard let identity = record.identity else { throw CentralTextError.contextChanged() }
                if try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM move_outbox WHERE id = ?", arguments: [record.id]) == 1 { continue }
                guard try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM move_outbox")! < 256 else { throw CentralTextError.unavailable }
                try db.execute(sql: "INSERT INTO move_outbox VALUES (?, ?, ?)", arguments: [record.id, identity, try JSONEncoder().encode(record)])
            }
        }
        try protectSQLiteFiles()
    }

    func pendingMoveEvents(identity: String) throws -> [MoveLifecycleRecord] {
        try queue.read { db in
            try Data.fetchAll(db, sql: "SELECT payload FROM move_outbox WHERE identity = ? ORDER BY rowid", arguments: [identity])
                .map { try JSONDecoder().decode(MoveLifecycleRecord.self, from: $0) }
        }
    }

    func acknowledgeMoveEvent(id: String, identity: String) throws {
        try queue.write { db in
            try db.execute(sql: "DELETE FROM move_outbox WHERE id = ? AND identity = ?", arguments: [id, identity])
        }
    }

    func saveMoveCheckpoint(data: Data, identity: String) throws {
        try queue.write { db in
            try db.execute(sql: "DELETE FROM move_checkpoint WHERE identity != ?", arguments: [identity])
            try db.execute(sql: "INSERT OR REPLACE INTO move_checkpoint VALUES (?, ?)", arguments: [identity, data])
        }
        try protectSQLiteFiles()
    }

    func moveCheckpoint(identity: String) throws -> Data? {
        try queue.read { db in try Data.fetchOne(db, sql: "SELECT payload FROM move_checkpoint WHERE identity = ?", arguments: [identity]) }
    }

    @discardableResult
    func enqueue(
        operationID: String,
        kind: String,
        fingerprint: String,
        metadata: [String: String] = [:],
        createdAt: Date = Date()
    ) throws -> AssistantLocalOperationAdmission {
        let normalizedFingerprint = try validate(
            operationID: operationID,
            kind: kind,
            fingerprint: fingerprint,
            metadata: metadata
        )
        let admission = try queue.write { db -> AssistantLocalOperationAdmission in
            if let existing = try fetch(operationID: operationID, db: db) {
                guard existing.kind == kind,
                      existing.fingerprint == normalizedFingerprint else {
                    return .conflict(existing: existing)
                }
                return .duplicate(existing)
            }

            let timestamp = createdAt.timeIntervalSince1970
            try db.execute(
                sql: """
                INSERT INTO local_operations
                    (operation_id, kind, fingerprint, state, created_at,
                     updated_at, attempt_count, last_error)
                VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
                """,
                arguments: [
                    operationID,
                    kind,
                    normalizedFingerprint,
                    AssistantLocalOperationState.pending.rawValue,
                    timestamp,
                    timestamp
                ]
            )
            guard let inserted = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            return .inserted(inserted)
        }
        try protectSQLiteFiles()
        return admission
    }

    @discardableResult
    func enqueue(
        operationID: AssistantOperationID,
        kind: String,
        fingerprint: String,
        metadata: [String: String] = [:],
        createdAt: Date = Date()
    ) throws -> AssistantLocalOperationAdmission {
        try enqueue(
            operationID: operationID.rawValue,
            kind: kind,
            fingerprint: fingerprint,
            metadata: metadata,
            createdAt: createdAt
        )
    }

    @discardableResult
    func markStopUnknown(
        operationID: String,
        fingerprint: String,
        createdAt: Date = Date(),
        at date: Date = Date()
    ) throws -> AssistantLocalOperation {
        let normalizedFingerprint = try validate(
            operationID: operationID,
            kind: "stop",
            fingerprint: fingerprint,
            metadata: [:]
        )
        let operation = try queue.write { db in
            if let existing = try fetch(operationID: operationID, db: db) {
                guard existing.kind == "stop",
                      existing.fingerprint == normalizedFingerprint else {
                    throw AssistantLocalOperationDatabaseError
                        .fingerprintConflict(operationID: operationID)
                }
                if existing.state == .completed
                    || existing.state == .stopUnknown {
                    return existing
                }
                try db.execute(
                    sql: """
                    UPDATE local_operations
                    SET state = ?, updated_at = ?, last_error = ?
                    WHERE operation_id = ?
                    """,
                    arguments: [
                        AssistantLocalOperationState.stopUnknown.rawValue,
                        date.timeIntervalSince1970,
                        "remote_stop_unconfirmed",
                        operationID
                    ]
                )
            } else {
                let timestamp = createdAt.timeIntervalSince1970
                try db.execute(
                    sql: """
                    INSERT INTO local_operations
                        (operation_id, kind, fingerprint, state, created_at,
                         updated_at, attempt_count, last_error)
                    VALUES (?, 'stop', ?, ?, ?, ?, 0, ?)
                    """,
                    arguments: [
                        operationID,
                        normalizedFingerprint,
                        AssistantLocalOperationState.stopUnknown.rawValue,
                        timestamp,
                        timestamp,
                        "remote_stop_unconfirmed"
                    ]
                )
            }
            guard let operation = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            return operation
        }
        try protectSQLiteFiles()
        return operation
    }

    @discardableResult
    func markStopUnknown(
        operationID: AssistantOperationID,
        fingerprint: String,
        createdAt: Date = Date(),
        at date: Date = Date()
    ) throws -> AssistantLocalOperation {
        try markStopUnknown(
            operationID: operationID.rawValue,
            fingerprint: fingerprint,
            createdAt: createdAt,
            at: date
        )
    }

    @discardableResult
    func markCompleted(
        operationID: String,
        fingerprint: String? = nil,
        at date: Date = Date()
    ) throws -> AssistantLocalOperation {
        try validateOperationID(operationID)
        let normalizedFingerprint: String?
        if let fingerprint {
            normalizedFingerprint = try Self.normalizeFingerprint(fingerprint)
        } else {
            normalizedFingerprint = nil
        }
        let operation = try queue.write { db in
            guard let existing = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.operationNotFound(
                    operationID: operationID
                )
            }
            if let normalizedFingerprint,
               normalizedFingerprint != existing.fingerprint {
                throw AssistantLocalOperationDatabaseError.fingerprintConflict(
                    operationID: operationID
                )
            }
            if existing.state == .completed {
                return existing
            }
            try db.execute(
                sql: """
                UPDATE local_operations
                SET state = ?, updated_at = ?, last_error = NULL
                WHERE operation_id = ?
                """,
                arguments: [
                    AssistantLocalOperationState.completed.rawValue,
                    date.timeIntervalSince1970,
                    operationID
                ]
            )
            guard let updated = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            try pruneCompletedOperations(db: db)
            return updated
        }
        try protectSQLiteFiles()
        return operation
    }

    @discardableResult
    func recordAttempt(
        operationID: String,
        at date: Date = Date()
    ) throws -> AssistantLocalOperation {
        try validateOperationID(operationID)
        let operation = try queue.write { db in
            guard let existing = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.operationNotFound(
                    operationID: operationID
                )
            }
            guard existing.state != .completed else {
                throw AssistantLocalOperationDatabaseError.invalidTransition(
                    operationID: operationID,
                    state: existing.state.rawValue
                )
            }
            try db.execute(
                sql: """
                UPDATE local_operations
                SET attempt_count = attempt_count + 1,
                    updated_at = ?,
                    last_error = NULL
                WHERE operation_id = ?
                """,
                arguments: [date.timeIntervalSince1970, operationID]
            )
            guard let updated = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            return updated
        }
        try protectSQLiteFiles()
        return operation
    }

    @discardableResult
    func recordFailure(
        operationID: String,
        message: String,
        at date: Date = Date()
    ) throws -> AssistantLocalOperation {
        try validateOperationID(operationID)
        let errorCode = Self.safeErrorCode(message)
        let operation = try queue.write { db in
            guard let existing = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.operationNotFound(
                    operationID: operationID
                )
            }
            guard existing.state != .completed else {
                throw AssistantLocalOperationDatabaseError.invalidTransition(
                    operationID: operationID,
                    state: existing.state.rawValue
                )
            }
            try db.execute(
                sql: """
                UPDATE local_operations
                SET state = ?, updated_at = ?, last_error = ?
                WHERE operation_id = ?
                """,
                arguments: [
                    existing.state.rawValue,
                    date.timeIntervalSince1970,
                    errorCode,
                    operationID
                ]
            )
            guard let updated = try fetch(operationID: operationID, db: db) else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            return updated
        }
        try protectSQLiteFiles()
        return operation
    }

    func operation(operationID: String) throws -> AssistantLocalOperation? {
        try validateOperationID(operationID)
        return try queue.read { db in
            try fetch(operationID: operationID, db: db)
        }
    }

    func pending(limit: Int = 100) throws -> [AssistantLocalOperation] {
        guard limit > 0 else { return [] }
        return try queue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                SELECT operation_id, kind, fingerprint, state, created_at,
                       updated_at, attempt_count, last_error
                FROM local_operations
                WHERE state IN (?, ?)
                ORDER BY updated_at ASC, created_at ASC, operation_id ASC
                LIMIT ?
                """,
                arguments: [
                    AssistantLocalOperationState.pending.rawValue,
                    AssistantLocalOperationState.stopUnknown.rawValue,
                    limit
                ]
            )
            return try rows.map(makeOperation)
        }
    }

    func replayableOperations(limit: Int = 100) throws -> [AssistantLocalOperation] {
        try pending(limit: limit)
    }

    func cachedReceipts(limit: Int = 128) throws -> [AssistantLocalReceiptCacheEntry] {
        guard limit > 0 else { return [] }
        return try queue.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                SELECT operation_id, kind, recorded_at,
                       local_cleanup_complete, remote_confirmation_present,
                       status_code
                FROM local_receipt_cache
                ORDER BY recorded_at ASC, operation_id ASC, kind ASC
                LIMIT ?
                """,
                arguments: [limit]
            )
            return try rows.map(makeReceipt)
        }
    }

    func cachedReceiptCount() throws -> Int {
        try queue.read { db in
            try Int.fetchOne(
                db,
                sql: "SELECT COUNT(*) FROM local_receipt_cache"
            ) ?? 0
        }
    }

    func verifyFileProtection() throws -> Bool {
        try verifySQLiteFiles()
    }

    func cache(_ receipt: AppleLocalOperationReceipt) throws {
        try validateOperationID(receipt.operationID)
        try validateKind(receipt.kind.rawValue)
        guard Self.isSafeStatusCode(receipt.statusCode) else {
            throw AssistantLocalOperationDatabaseError.invalidStatusCode
        }
        // Deliberately omit opaqueRemoteReference. It is not needed for local
        // recovery and must never turn this cache into a delivery authority.
        try queue.write { db in
            try db.execute(
                sql: """
                INSERT OR REPLACE INTO local_receipt_cache
                    (operation_id, kind, recorded_at, local_cleanup_complete,
                     remote_confirmation_present, status_code)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                arguments: [
                    receipt.operationID,
                    receipt.kind.rawValue,
                    receipt.recordedAt.timeIntervalSince1970,
                    receipt.localCleanupComplete ? 1 : 0,
                    receipt.remoteConfirmationPresent ? 1 : 0,
                    receipt.statusCode
                ]
            )
            try db.execute(
                sql: """
                DELETE FROM local_receipt_cache
                WHERE rowid NOT IN (
                    SELECT rowid
                    FROM local_receipt_cache
                    ORDER BY recorded_at DESC, operation_id DESC, kind DESC
                    LIMIT ?
                )
                """,
                arguments: [Self.receiptCacheCapacity]
            )
            try pruneCompletedOperations(db: db)
        }
        try protectSQLiteFiles()
    }

    // Replay material belongs to the existing pending operation, not receipt history.
    private static func stopReplayFingerprint(_ payload: Data) -> String {
        SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    }

    /// One pending nonce per pairing; returned replies stay in the same operation journal until admission.
    func preserveQwenHandoff(identity: String, sourceID: String, now: Date = Date()) throws -> QwenHandoff.Pending? {
        try queue.write { db in
            let records = try qwenHandoffs(db: db, includeCompleted: true)
            if let existing = records.first(where: { $0.handoff.identity == identity && $0.handoff.sourceID == sourceID }) {
                return existing.state == .pending && existing.handoff.reply == nil ? existing.handoff.pending : nil
            }
            for record in records where record.state == .pending && record.handoff.identity == identity && record.handoff.reply == nil {
                try db.execute(sql: "UPDATE local_operations SET state = 'completed' WHERE operation_id = ?", arguments: [record.handoff.pending.nonce])
            }
            let pending = QwenHandoff.Pending(nonce: UUID().uuidString.lowercased(), createdAt: now)
            let payload = try JSONEncoder().encode(AssistantLocalQwenHandoff(identity: identity, sourceID: sourceID, pending: pending))
            try db.execute(sql: "INSERT INTO local_operations (operation_id, kind, fingerprint, state, created_at, updated_at, attempt_count, replay_payload) VALUES (?, 'qwen_handoff', ?, 'pending', ?, ?, 0, ?)", arguments: [pending.nonce, Self.stopReplayFingerprint(payload), now.timeIntervalSince1970, now.timeIntervalSince1970, payload])
            try pruneCompletedOperations(db: db)
            try protectSQLiteFiles()
            return pending
        }
    }

    /// Validate the final UTF-8 wire bytes before atomically replacing a pending nonce with its durable reply.
    func consumeQwenReply(_ url: URL, identity: String? = nil, now: Date = Date(), location: AssistantLocationObservation? = nil) throws -> AssistantRetainedPrompt? {
        try queue.write { db in
            for record in try qwenHandoffs(db: db) where record.state == .pending && (identity == nil || record.handoff.identity == identity) && record.handoff.reply == nil {
                var handoff = record.handoff
                guard let text = QwenHandoff.reply(from: url, pending: handoff.pending, now: now)?.trimmingCharacters(in: .whitespacesAndNewlines) else { continue }
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                let reply = AssistantRetainedPrompt(identity: handoff.identity, eventID: handoff.pending.nonce, capturedAt: formatter.string(from: now), text: text, location: identity != nil ? location.map(AssistantRetainedLocation.init) : nil)
                do { _ = try AssistantCentralTextWire.submit(eventID: reply.eventID, capturedAt: reply.capturedAt, text: reply.text, location: reply.location?.observation) }
                catch CentralTextError.invalidPacket { throw AssistantLocalOperationDatabaseError.qwenReplyTooLarge }
                handoff.reply = reply
                let payload = try JSONEncoder().encode(handoff)
                try db.execute(sql: "UPDATE local_operations SET replay_payload = ?, fingerprint = ?, updated_at = ? WHERE operation_id = ?", arguments: [payload, Self.stopReplayFingerprint(payload), now.timeIntervalSince1970, reply.eventID])
                try protectSQLiteFiles()
                return reply
            }
            return nil
        }
    }

    func pendingQwenReply(identity: String) throws -> AssistantRetainedPrompt? {
        try queue.read { db in try qwenHandoffs(db: db).first(where: { $0.state == .pending && $0.handoff.identity == identity && $0.handoff.reply != nil })?.handoff.reply }
    }

    func acknowledgeQwenReply(_ consumer: AssistantCentralTextConsumer) throws {
        guard let identity = consumer.ownerPairingIdentity else { return }
        let replies = try queue.read { db in try qwenHandoffs(db: db).filter {
            $0.state != .completed && $0.handoff.identity == identity
        }.compactMap { $0.handoff.reply?.eventID } }
        for eventID in replies where consumer.submissionDelivery(eventID: eventID) == .accepted || consumer.submissionDelivery(eventID: eventID) == .queued {
            _ = try markCompleted(operationID: eventID)
        }
    }

    private func qwenHandoffs(db: Database, includeCompleted: Bool = false) throws -> [(handoff: AssistantLocalQwenHandoff, state: AssistantLocalOperationState)] {
        let scope = includeCompleted ? "(state != 'completed' OR replay_payload IS NOT NULL)" : "state != 'completed'"
        return try Row.fetchAll(db, sql: "SELECT * FROM local_operations WHERE kind = 'qwen_handoff' AND \(scope) ORDER BY rowid").map { row in
            guard let payload: Data = row["replay_payload"], Self.stopReplayFingerprint(payload) == (row["fingerprint"] as String) else { throw AssistantLocalOperationDatabaseError.corruptRow }
            let handoff = try JSONDecoder().decode(AssistantLocalQwenHandoff.self, from: payload)
            guard handoff.pending.nonce == (row["operation_id"] as String), let state = AssistantLocalOperationState(rawValue: row["state"]) else { throw AssistantLocalOperationDatabaseError.corruptRow }
            return (handoff, state)
        }
    }

    /// The notification action is admitted before bootstrap and stays bound to the pairing that displayed it.
    func pendingCareSafe(identity: String) throws -> AssistantLocalCareSafe? {
        try queue.read { db in try careSafe(identity: identity, db: db) }
    }

    func preserveCareSafe(identity: String, deviceID: String) throws -> AssistantLocalCareSafe {
        let control = try queue.write { db -> AssistantLocalCareSafe in
            if let pending = try careSafe(identity: identity, db: db) { return pending }
            let control = AssistantLocalCareSafe(controlID: "care-safe-" + UUID().uuidString.lowercased(), identity: identity, deviceID: deviceID)
            let payload = try JSONEncoder().encode(control), now = Date().timeIntervalSince1970
            try db.execute(sql: "INSERT INTO local_operations (operation_id, kind, fingerprint, state, created_at, updated_at, attempt_count, replay_payload) VALUES (?, 'care_safe', ?, 'pending', ?, ?, 0, ?)",
                arguments: [control.controlID, Self.stopReplayFingerprint(payload), now, now, payload])
            return control
        }
        try protectSQLiteFiles()
        return control
    }

    private func careSafe(identity: String, db: Database) throws -> AssistantLocalCareSafe? {
        for row in try Row.fetchAll(db, sql: "SELECT * FROM local_operations WHERE kind = 'care_safe' AND state != 'completed'") {
            guard let payload: Data = row["replay_payload"], Self.stopReplayFingerprint(payload) == (row["fingerprint"] as String) else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            let control = try JSONDecoder().decode(AssistantLocalCareSafe.self, from: payload)
            guard control.controlID == (row["operation_id"] as String) else { throw AssistantLocalOperationDatabaseError.corruptRow }
            if control.identity == identity { return control }
        }
        return nil
    }

    func pendingStopReplay(kind: String = "stop") throws -> AssistantLocalStopReplay? {
        guard kind == "stop" || kind == "bootstrap" else { throw AssistantLocalOperationDatabaseError.corruptRow }
        return try queue.read { db in
            let rows = try Row.fetchAll(db, sql: "SELECT * FROM local_operations WHERE kind = ? AND state != 'completed' ORDER BY rowid DESC", arguments: [kind])
            guard kind == "bootstrap" || rows.count <= 1 else { throw AssistantLocalOperationDatabaseError.corruptRow }
            guard let row = rows.first else { return nil }
            guard let data: Data = row["replay_payload"] else { throw AssistantLocalOperationDatabaseError.corruptRow }
            let operation = try makeOperation(row)
            guard Self.stopReplayFingerprint(data) == operation.fingerprint else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            return AssistantLocalStopReplay(operationID: operation.operationID, payload: data)
        }
    }

    func preserveStopReplay(operationID: String, payload: Data, kind: String = "stop") throws {
        guard kind == "stop" || kind == "bootstrap" else { throw AssistantLocalOperationDatabaseError.corruptRow }
        try validateOperationID(operationID)
        let fingerprint = Self.stopReplayFingerprint(payload)
        try queue.write { db in
            let existing = try fetch(operationID: operationID, db: db)
            if let existing, existing.kind == "bootstrap", existing.state == .completed, kind == "stop" {
                // A session's stop continues the operation its start opened (the coordinator reuses the start's id).
                guard try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM local_operations WHERE kind IN ('stop', 'bootstrap') AND state != 'completed'") == 0 else {
                    throw AssistantLocalOperationDatabaseError.corruptRow
                }
                try db.execute(sql: "UPDATE local_operations SET kind = 'stop', state = 'stop_unknown', fingerprint = ?, replay_payload = ?, last_error = NULL, updated_at = ? WHERE operation_id = ? AND kind = 'bootstrap' AND state = 'completed'", arguments: [fingerprint, payload, Date().timeIntervalSince1970, operationID])
                guard db.changesCount == 1 else { throw AssistantLocalOperationDatabaseError.fingerprintConflict(operationID: operationID) }
                return
            }
            if let existing {
                guard existing.kind == kind, existing.fingerprint == fingerprint, existing.state != .completed else {
                    throw AssistantLocalOperationDatabaseError.fingerprintConflict(operationID: operationID)
                }
                return
            }
            guard try kind == "bootstrap" || Int.fetchOne(db, sql: "SELECT COUNT(*) FROM local_operations WHERE kind IN ('stop', 'bootstrap') AND state != 'completed'") == 0 else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            let now = Date().timeIntervalSince1970
            try db.execute(sql: "INSERT INTO local_operations (operation_id, kind, fingerprint, state, created_at, updated_at, attempt_count, replay_payload) VALUES (?, ?, ?, ?, ?, ?, 0, ?)", arguments: [operationID, kind, fingerprint, kind == "stop" ? "stop_unknown" : "pending", now, now, payload])
        }
        try protectSQLiteFiles()
    }

    func upgradeStopReplay(operationID: String, expectedPayload: Data, payload: Data, expectedKind: String = "stop") throws {
        guard expectedKind == "stop" || expectedKind == "bootstrap" else { throw AssistantLocalOperationDatabaseError.corruptRow }
        try validateOperationID(operationID)
        let expected = Self.stopReplayFingerprint(expectedPayload)
        let fingerprint = Self.stopReplayFingerprint(payload)
        try queue.write { db in
            guard let row = try fetch(operationID: operationID, db: db),
                  row.kind == expectedKind, row.state != .completed,
                  let stored: Data = try Row.fetchOne(db, sql: "SELECT replay_payload FROM local_operations WHERE operation_id = ?", arguments: [operationID])?["replay_payload"],
                  Self.stopReplayFingerprint(stored) == row.fingerprint,
                  try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM local_operations WHERE kind IN ('stop', 'bootstrap') AND state != 'completed'") == 1 else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            if row.kind == "stop", row.fingerprint == fingerprint { return }
            guard row.fingerprint == expected else {
                throw AssistantLocalOperationDatabaseError.fingerprintConflict(operationID: operationID)
            }
            try db.execute(sql: "UPDATE local_operations SET kind = 'stop', state = 'stop_unknown', fingerprint = ?, replay_payload = ?, updated_at = ? WHERE operation_id = ? AND fingerprint = ? AND kind = ? AND state != 'completed'", arguments: [fingerprint, payload, Date().timeIntervalSince1970, operationID, expected, expectedKind])
            guard db.changesCount == 1 else { throw AssistantLocalOperationDatabaseError.fingerprintConflict(operationID: operationID) }
        }
        try protectSQLiteFiles()
    }

    /// A new device pairing revokes the previous bearer centrally, so start/stop replays recorded under it can never
    /// complete; they are closed here (payloads dropped) instead of blocking the next Start forever.
    func supersedeControlReplays() throws {
        try queue.write { db in
            try supersedeControlReplays(db: db)
            try pruneCompletedOperations(db: db)
        }
        try protectSQLiteFiles()
    }

    private func supersedeControlReplays(db: Database) throws {
        try db.execute(sql: "DELETE FROM move_outbox")
        try db.execute(sql: "DELETE FROM move_checkpoint")
        try db.execute(sql: "UPDATE local_operations SET state = 'completed', replay_payload = NULL, last_error = 'superseded_by_pairing', updated_at = ? WHERE kind IN ('stop', 'bootstrap', 'qwen_handoff') AND state != 'completed'", arguments: [Date().timeIntervalSince1970])
    }

    /// The intent contains only identities. If Keychain installation outlives a rolled-back SQLite commit,
    /// the next import finishes retirement before treating an identical import as a no-op.
    func replacePairing(data: Data, store: any RealtimeDevicePairingStoring) throws {
        let incoming = try RealtimeDevicePairing.decode(data)
        let previous = try store.loadPairingData().map(RealtimeDevicePairing.decode)
        // A launch-time copy of the original artifact must not undo an authenticated origin migration.
        if let previous, previous.anchorOrigin == incoming.origin,
           previous.deviceID == incoming.deviceID, previous.userID == incoming.userID,
           previous.pairedAt == incoming.pairedAt, previous.token == incoming.token,
           previous.governance == incoming.governance, previous.media == incoming.media { return }
        let previousIdentity = previous.map(CentralOwnerDataIdentity.pairing)
        let identity = CentralOwnerDataIdentity.pairing(incoming), operationID = "pairing-replacement"
        var pending = try queue.read { db -> AssistantLocalPairingReplacement? in
            guard let row = try Row.fetchOne(db, sql: "SELECT * FROM local_operations WHERE operation_id = ? AND state != 'completed'", arguments: [operationID]) else { return nil }
            guard let payload: Data = row["replay_payload"], Self.stopReplayFingerprint(payload) == (row["fingerprint"] as String) else { throw AssistantLocalOperationDatabaseError.corruptRow }
            return try JSONDecoder().decode(AssistantLocalPairingReplacement.self, from: payload)
        }
        // The owner's place consent survives re-pairing: it moves to the new pairing, whose place token is re-issued
        // (the old token fails the credential identity check) and whose regions are synchronized afresh. Only the old
        // pairing's outbox goes.
        func finish(_ db: Database, identity: String) throws {
            try supersedeControlReplays(db: db)
            let previous = try placeState(db)
            var place = PlaceSensingState()
            if previous.enabled { place.enabled = true; place.identity = identity; place.regions = previous.regions; place.needsRegionSync = true }
            try db.execute(sql: "INSERT OR REPLACE INTO place_state VALUES (1, ?)", arguments: [JSONEncoder().encode(place)])
            try db.execute(sql: "DELETE FROM place_outbox")
            try db.execute(sql: "UPDATE local_operations SET state = 'completed', replay_payload = NULL WHERE operation_id = ?", arguments: [operationID])
            try pruneCompletedOperations(db: db)
            try protectSQLiteFiles()
        }
        if let intent = pending {
            if previousIdentity == intent.identity {
                try queue.write { db in try finish(db, identity: intent.identity) }
                RealtimePairingSessionIdentity.shared.invalidate()
                pending = nil
            } else if previousIdentity != intent.previousIdentity { throw CentralTextError.contextChanged() }
        }
        if previousIdentity == identity {
            if previous != incoming { try store.replacePairingData(data) }
            if pending != nil { _ = try markCompleted(operationID: operationID) }
            return
        }
        let payload = try JSONEncoder().encode(AssistantLocalPairingReplacement(previousIdentity: previousIdentity, identity: identity))
        let now = Date().timeIntervalSince1970
        try queue.write { db in
            try db.execute(sql: "INSERT OR REPLACE INTO local_operations (operation_id, kind, fingerprint, state, created_at, updated_at, attempt_count, replay_payload) VALUES (?, 'pairing_replacement', ?, 'pending', ?, ?, 0, ?)", arguments: [operationID, Self.stopReplayFingerprint(payload), now, now, payload])
            try protectSQLiteFiles()
        }
        try queue.write { db in
            try finish(db, identity: identity)
            try store.replacePairingData(data)
            RealtimePairingSessionIdentity.shared.invalidate()
        }
    }

    func supersedePendingControlAfterBootstrap(operationID: String) throws {
        try queue.write { db in
            try supersedePendingControlAfterBootstrap(db: db, operationID: operationID)
            try pruneCompletedOperations(db: db)
        }
        try protectSQLiteFiles()
    }

    private func supersedePendingControlAfterBootstrap(db: Database, operationID: String) throws {
        // Accepted Start supersedes older control intents; it does not confirm their outcomes.
        try db.execute(sql: "UPDATE local_operations SET state = 'completed', replay_payload = NULL, last_error = 'superseded_by_start', updated_at = ? WHERE kind IN ('stop', 'bootstrap') AND state != 'completed' AND operation_id != ?", arguments: [Date().timeIntervalSince1970, operationID])
    }

    func completeStopReplay(operationID: String, kind: String = "stop", supersedingControl: Bool = false) throws {
        guard kind == "stop" || kind == "bootstrap" else { throw AssistantLocalOperationDatabaseError.corruptRow }
        try queue.write { db in
            guard let row = try fetch(operationID: operationID, db: db), row.kind == kind else {
                throw AssistantLocalOperationDatabaseError.operationNotFound(operationID: operationID)
            }
            if supersedingControl {
                try supersedePendingControlAfterBootstrap(db: db, operationID: operationID)
            }
            try db.execute(sql: "UPDATE local_operations SET state = 'completed', replay_payload = NULL, last_error = NULL, updated_at = ? WHERE operation_id = ?", arguments: [Date().timeIntervalSince1970, operationID])
            try pruneCompletedOperations(db: db)
        }
        try protectSQLiteFiles()
    }

    private func pruneCompletedOperations(db: Database) throws {
        // Pending rows never compete for history capacity. Retained receipts and
        // the latest successful Start can still refer to a completed operation.
        try db.execute(sql: """
            DELETE FROM local_operations
            WHERE operation_id IN (
                SELECT operation_id FROM local_operations
                WHERE state IN ('completed', 'abandoned')
                  AND operation_id NOT IN (SELECT operation_id FROM local_receipt_cache)
                  AND operation_id NOT IN (
                      SELECT operation_id FROM local_operations
                      WHERE kind = 'bootstrap' AND state = 'completed' AND last_error IS NULL
                      ORDER BY updated_at DESC, created_at DESC, operation_id DESC
                      LIMIT 1
                  )
                ORDER BY updated_at DESC, created_at DESC, operation_id DESC
                LIMIT -1 OFFSET ?
            )
            """, arguments: [Self.completedOperationCapacity])
    }

    private func validate(
        operationID: String,
        kind: String,
        fingerprint: String,
        metadata: [String: String]
    ) throws -> String {
        try validateOperationID(operationID)
        try validateKind(kind)
        let forbidden = metadata.keys.first { key in
            let normalized = key
                .lowercased()
                .replacingOccurrences(of: "-", with: "")
                .replacingOccurrences(of: "_", with: "")
            return Self.forbiddenFieldFragments.contains {
                normalized.contains($0)
            }
        }
        if let forbidden {
            throw AssistantLocalOperationDatabaseError.forbiddenField(forbidden)
        }
        return try Self.normalizeFingerprint(fingerprint)
    }

    private func validateOperationID(_ value: String) throws {
        guard Self.isSafeIdentifier(
            value,
            maximumLength: Self.maximumOperationIDLength
        ) else {
            throw AssistantLocalOperationDatabaseError.forbiddenField("operationID")
        }
    }

    private func validateKind(_ value: String) throws {
        guard Self.isSafeIdentifier(
            value,
            maximumLength: Self.maximumKindLength
        ) else {
            throw AssistantLocalOperationDatabaseError.forbiddenField("kind")
        }
    }

    private static func normalizeFingerprint(_ value: String) throws -> String {
        guard value.count == 64,
              value.unicodeScalars.allSatisfy({ scalar in
                  let code = scalar.value
                  return (code >= 48 && code <= 57)
                      || (code >= 65 && code <= 70)
                      || (code >= 97 && code <= 102)
              }) else {
            throw AssistantLocalOperationDatabaseError.invalidFingerprint
        }
        return value.lowercased()
    }

    private static func isSafeIdentifier(
        _ value: String,
        maximumLength: Int
    ) -> Bool {
        guard !value.isEmpty, value.count <= maximumLength else {
            return false
        }
        let normalized = value.lowercased()
        guard forbiddenFieldFragments.allSatisfy({
            !normalized.contains($0)
        }) else {
            return false
        }
        return value.unicodeScalars.allSatisfy { scalar in
            let code = scalar.value
            return (code >= 48 && code <= 57)
                || (code >= 65 && code <= 90)
                || (code >= 97 && code <= 122)
                || code == 95
                || code == 45
                || code == 46
        }
    }

    private static func safeErrorCode(_ value: String) -> String {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSafeIdentifier(normalized, maximumLength: 64) else {
            return "unspecified"
        }
        return normalized.lowercased()
    }

    private func fetch(
        operationID: String,
        db: Database
    ) throws -> AssistantLocalOperation? {
        guard let row = try Row.fetchOne(
            db,
            sql: """
            SELECT operation_id, kind, fingerprint, state, created_at,
                   updated_at, attempt_count, last_error
            FROM local_operations
            WHERE operation_id = ?
            """,
            arguments: [operationID]
        ) else {
            return nil
        }
        return try makeOperation(row)
    }

    private func makeOperation(_ row: Row) throws -> AssistantLocalOperation {
        guard
            let operationID: String = row["operation_id"],
            let kind: String = row["kind"],
            let fingerprint: String = row["fingerprint"],
            let stateRaw: String = row["state"],
            let state = AssistantLocalOperationState(rawValue: stateRaw),
            let createdTimestamp: Double = row["created_at"],
            let updatedTimestamp: Double = row["updated_at"],
            let attemptCount: Int = row["attempt_count"]
        else {
            throw AssistantLocalOperationDatabaseError.corruptRow
        }
        guard Self.isSafeIdentifier(
            operationID,
            maximumLength: Self.maximumOperationIDLength
        ),
        Self.isSafeIdentifier(
            kind,
            maximumLength: Self.maximumKindLength
        ),
        (try? Self.normalizeFingerprint(fingerprint)) == fingerprint,
        attemptCount >= 0 else {
            throw AssistantLocalOperationDatabaseError.corruptRow
        }
        let rawError: String? = row["last_error"]
        let safeError: String?
        if let rawError {
            guard Self.safeErrorCode(rawError) == rawError else {
                throw AssistantLocalOperationDatabaseError.corruptRow
            }
            safeError = rawError
        } else {
            safeError = nil
        }
        return AssistantLocalOperation(
            operationID: operationID,
            kind: kind,
            fingerprint: fingerprint,
            state: state,
            createdAt: Date(timeIntervalSince1970: createdTimestamp),
            updatedAt: Date(timeIntervalSince1970: updatedTimestamp),
            attemptCount: attemptCount,
            lastError: safeError
        )
    }

    private func makeReceipt(_ row: Row) throws -> AssistantLocalReceiptCacheEntry {
        guard
            let operationID: String = row["operation_id"],
            let kind: String = row["kind"],
            let recordedTimestamp: Double = row["recorded_at"],
            let localCleanup: Int = row["local_cleanup_complete"],
            let remoteConfirmation: Int = row["remote_confirmation_present"],
            let statusCode: String = row["status_code"]
        else {
            throw AssistantLocalOperationDatabaseError.corruptRow
        }
        guard Self.isSafeIdentifier(
            operationID,
            maximumLength: Self.maximumOperationIDLength
        ),
        Self.isSafeIdentifier(kind, maximumLength: Self.maximumKindLength),
        Self.isSafeStatusCode(statusCode) else {
            throw AssistantLocalOperationDatabaseError.corruptRow
        }
        return AssistantLocalReceiptCacheEntry(
            operationID: operationID,
            kind: kind,
            recordedAt: Date(timeIntervalSince1970: recordedTimestamp),
            localCleanupComplete: localCleanup != 0,
            remoteConfirmationPresent: remoteConfirmation != 0,
            statusCode: statusCode
        )
    }

    private static func isSafeStatusCode(_ value: String) -> Bool {
        isSafeIdentifier(value, maximumLength: 128)
    }

    private var sqliteFileURLs: [URL] {
        [
            databaseURL,
            URL(fileURLWithPath: "\(databaseURL.path)-wal"),
            URL(fileURLWithPath: "\(databaseURL.path)-shm"),
            URL(fileURLWithPath: "\(databaseURL.path)-journal")
        ]
    }

    private func protectSQLiteFiles() throws {
#if targetEnvironment(simulator)
        simulatorProtectionWriteSucceededPaths.removeAll(keepingCapacity: true)
#endif
        for url in sqliteFileURLs
            where fileManager.fileExists(atPath: url.path) {
            try Self.setProtection(at: url, fileManager: fileManager)
            try Self.verifyProtection(
                at: url,
                fileManager: fileManager,
                allowSimulatorUnreported: true
            )
#if targetEnvironment(simulator)
            simulatorProtectionWriteSucceededPaths.insert(url.path)
#endif
        }
    }

    private func verifySQLiteFiles() throws -> Bool {
        guard fileManager.fileExists(atPath: databaseURL.path) else {
            throw AssistantLocalOperationDatabaseError.fileProtectionMismatch
        }
        for url in sqliteFileURLs
            where fileManager.fileExists(atPath: url.path) {
#if targetEnvironment(simulator)
            let allowSimulatorUnreported =
                simulatorProtectionWriteSucceededPaths.contains(url.path)
#else
            let allowSimulatorUnreported = false
#endif
            try Self.verifyProtection(
                at: url,
                fileManager: fileManager,
                allowSimulatorUnreported: allowSimulatorUnreported
            )
        }
        return true
    }

    private static func setProtection(
        at url: URL,
        fileManager: FileManager
    ) throws {
        try fileManager.setAttributes(
            [.protectionKey: requiredFileProtection],
            ofItemAtPath: url.path
        )
    }

    private static func verifyProtection(
        at url: URL,
        fileManager: FileManager,
        allowSimulatorUnreported: Bool = false
    ) throws {
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        guard let actual = Self.normalizeProtection(
            attributes[.protectionKey]
        ), actual == requiredFileProtection else {
#if targetEnvironment(simulator)
            if allowSimulatorUnreported,
               attributes[.protectionKey] == nil {
                return
            }
#endif
            throw AssistantLocalOperationDatabaseError.fileProtectionMismatch
        }
    }

    static func isRequiredFileProtectionValue(_ value: Any?) -> Bool {
        guard let actual = normalizeProtection(value) else {
            return false
        }
        return actual == requiredFileProtection
    }

    private static func normalizeProtection(
        _ value: Any?
    ) -> FileProtectionType? {
        guard let value else {
            return nil
        }
        if let typed = value as? FileProtectionType {
            return typed
        }
        guard let rawValue = value as? String,
              rawValue == requiredFileProtection.rawValue else {
            return nil
        }
        return requiredFileProtection
    }
}


/// An owner-bound lifecycle intent. Transport completion never acknowledges durable acceptance.
struct MoveLifecycleRecord: Codable, Sendable {
    let id: String
    let identity: String?
    let sourceSession: String?
    let bytes: Data

    init(event: MoveEvent, identity: String?, sourceSession: String?) throws {
        id = UUID().uuidString.lowercased()
        self.identity = identity; self.sourceSession = sourceSession
        bytes = try AssistantCentralTextWire.move(event, lifecycleID: id)
    }
}
