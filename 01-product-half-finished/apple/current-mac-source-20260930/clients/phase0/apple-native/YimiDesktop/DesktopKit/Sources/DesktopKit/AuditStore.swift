import Foundation
import CSQLite
import Darwin

func auditID() -> String {
    var bytes = withUnsafeBytes(of: UUID().uuid) { Array($0) }
    let milliseconds = UInt64(Date().timeIntervalSince1970 * 1000)
    for index in 0..<6 { bytes[index] = UInt8(truncatingIfNeeded: milliseconds >> ((5 - index) * 8)) }
    bytes[6] = (bytes[6] & 0x0f) | 0x70
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    let hex = bytes.map { String(format: "%02x", $0) }
    return [hex[0..<4], hex[4..<6], hex[6..<8], hex[8..<10], hex[10..<16]].map { $0.joined() }.joined(separator: "-")
}

struct UndoRecord: Codable {
    var kind: String
    var originalPath: String
    var backupPath: String? = nil
    var trashPath: String? = nil
    var movedTo: String? = nil
    // Identity of the committed object; absent on older v1 audit rows.
    var device: UInt64? = nil
    var inode: UInt64? = nil
    var previousDevice: UInt64? = nil
    var previousInode: UInt64? = nil
    var previousSize: Int64? = nil
    var previousMtime: Double? = nil
    var size: Int64? = nil
    var mtime: Double? = nil
    var replacement: FileReplacement? = nil
    var creation: FileReplacement? = nil
    var movement: FileMovement? = nil
}

struct CreatedNode: Codable {
    let path: String
    let device: Int32
    let inode: UInt64
    let directory: Bool
}

struct FileReplacement: Codable {
    let directory: String
    let device: Int32
    let inode: UInt64
    let payloadDevice: Int32
    let payloadInode: UInt64
    let payloadSize: Int64
    let payloadMtime: Double
    var createdNodes: [CreatedNode]? = nil
}

struct AuditRecord: Codable {
    var id: String = auditID()
    var at: Date = Date()
    var deviceID: String
    var requestID: String
    var tool: String
    var toolClass: String
    var paths: [String] = []
    var names: [String] = []
    var count: Int = 0
    var decision: String = "allowed"
    var result: String? = nil
    var guardCode: String? = nil
    var errorCode: String? = nil
    var durationMS: Int = 0
    var bytesIn: Int = 0
    var bytesOut: Int = 0
    var undo: UndoRecord? = nil
    var undoneAt: Date? = nil
    var undoOf: String? = nil

    var entry: AuditEntry {
        AuditEntry(id: id, at: at, tool: tool, toolClass: toolClass, names: names, count: count,
                   decision: decision, result: result, errorCode: errorCode ?? guardCode,
                   undo: result == "ok" ? undo.flatMap { AuditEntry.Undo(rawValue: $0.kind) } : nil, undoneAt: undoneAt,
                   reveal: result == "ok" && (undo?.kind == "create" || tool == "save_from_workshop")
                       ? paths.first.map { URL(fileURLWithPath: $0) } : nil)
    }
}

/// Owned by Desktop's actor. Values contain operation metadata only, never file contents.
final class AuditStore {
    private var db: OpaquePointer?
    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(store: URL) throws {
        directory = store
        let fm = FileManager.default
        try fm.createDirectory(at: store, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(store.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw ToolFailure("DESKTOP_AUDIT_STORE", String(cString: strerror(errno))) }
        defer { close(fd) }
        guard fchmod(fd, 0o700) == 0 else { throw ToolFailure("DESKTOP_AUDIT_STORE", String(cString: strerror(errno))) }
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(fd, F_GETPATH, &path) == 0 else { throw ToolFailure("DESKTOP_AUDIT_STORE", String(cString: strerror(errno))) }
        let file = String(cString: path) + "/audit.sqlite"
        let status = sqlite3_open_v2(file, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOFOLLOW, nil)
        guard status == SQLITE_OK else {
            let failure = databaseError()
            sqlite3_close(db)
            db = nil
            throw failure
        }
        do {
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file)
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=FULL")
            try execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            try execute("INSERT OR IGNORE INTO meta VALUES('schema', 'paios.desktop-audit.v1')")
            try execute("CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, at REAL NOT NULL, args_summary TEXT NOT NULL, record TEXT NOT NULL)")
            try execute("CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC, id DESC)")
            for suffix in ["-wal", "-shm"] where fm.fileExists(atPath: file + suffix) {
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file + suffix)
            }
        } catch {
            sqlite3_close(db)
            db = nil
            throw error
        }
    }

    deinit { sqlite3_close(db) }

    func eraseAuditRows() throws {
        try execute("PRAGMA secure_delete=ON")
        try execute("DELETE FROM audit")
        guard sqlite3_wal_checkpoint_v2(db, nil, SQLITE_CHECKPOINT_TRUNCATE, nil, nil) == SQLITE_OK else { throw databaseError() }
        try execute("VACUUM")
    }

    func append(_ record: AuditRecord) throws {
        let summary: [String: Any] = ["paths": record.paths, "names": record.names, "counts": record.count]
        let args = String(decoding: try JSONSerialization.data(withJSONObject: summary), as: UTF8.self)
        try execute("INSERT INTO audit(id,at,args_summary,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,args_summary=excluded.args_summary,record=excluded.record",
                    [record.id, String(record.at.timeIntervalSince1970), args, try json(record)])
    }

    /// The caller owns rollback of external state; this transaction covers audit rows only.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let value = try body()
            try execute("COMMIT")
            return value
        } catch {
            let failure = error
            if sqlite3_get_autocommit(db) == 0 {
                do { try execute("ROLLBACK") }
                catch { throw ToolFailure("DESKTOP_AUDIT_STORE", "活动事务失败：\(failure)；回滚失败：\(error)") }
            }
            throw failure
        }
    }

    func guardJournal() throws -> Data? {
        let statement = try prepare("SELECT value FROM meta WHERE key='guard-install-v2'", [])
        defer { sqlite3_finalize(statement) }
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { throw databaseError() }
        return Data(String(cString: text).utf8)
    }
    func setGuardJournal(_ data: Data) throws {
        try execute("INSERT INTO meta(key,value) VALUES('guard-install-v2',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    [String(decoding: data, as: UTF8.self)])
    }

    func records(before: Date?, limit: Int) throws -> [AuditRecord] {
        let maximum = min(max(limit, 1), 500)
        return try query("SELECT record FROM audit WHERE (? IS NULL OR at < ?) ORDER BY at DESC,id DESC LIMIT ?",
                         [before.map { String($0.timeIntervalSince1970) }, before.map { String($0.timeIntervalSince1970) }, String(maximum)])
    }

    func record(_ id: String) throws -> AuditRecord? {
        try query("SELECT record FROM audit WHERE id=?", [id]).first
    }

    func rebindRestoredIdentity(device: UInt64, inode: UInt64, size: Int64, mtime: Double, to restored: stat) throws {
        for var row in try query("SELECT record FROM audit WHERE json_extract(record,'$.result')='ok' AND json_extract(record,'$.undoneAt') IS NULL", []) {
            guard row.undo?.device == device, row.undo?.inode == inode,
                  row.undo?.size == size, row.undo?.mtime == mtime else { continue }
            row.undo?.device = UInt64(UInt32(bitPattern: restored.st_dev)); row.undo?.inode = restored.st_ino
            row.undo?.size = restored.st_size; row.undo?.mtime = Double(restored.st_mtimespec.tv_sec) + Double(restored.st_mtimespec.tv_nsec) / 1e9
            try append(row)
        }
    }

    func unresolvedRetirements() throws -> [AuditRecord] {
        try query("SELECT record FROM audit WHERE json_extract(record,'$.tool')='retire_file_grant' AND json_extract(record,'$.result') IS NULL", [])
    }

    func unresolvedReplacements() throws -> [AuditRecord] {
        try query("SELECT record FROM audit WHERE json_extract(record,'$.undo.replacement') IS NOT NULL OR json_extract(record,'$.undo.creation') IS NOT NULL ORDER BY at,id", [])
    }

    func unresolvedMovements() throws -> [AuditRecord] {
        try query("SELECT record FROM audit WHERE json_extract(record,'$.undo.movement') IS NOT NULL ORDER BY at,id", [])
    }

    func markUndone(_ id: String, at: Date) throws {
        guard var value = try record(id) else { throw ToolFailure("GUARD_NOT_FOUND", "找不到这条活动记录") }
        value.undoneAt = at
        try execute("UPDATE audit SET record=? WHERE id=?", [try json(value), id])
    }

    func prune(auditDays: Int, undoDays: Int) throws -> [URL] {
        let now = Date().timeIntervalSince1970
        let auditCutoff = now - Double(auditDays) * 86400
        let undoCutoff = now - Double(undoDays) * 86400
        var directories: [URL] = []
        let pending = "json_extract(record,'$.undo.movement') IS NOT NULL OR json_extract(record,'$.undo.replacement') IS NOT NULL OR json_extract(record,'$.undo.creation') IS NOT NULL"
        let prunable = "NOT (\(pending)) AND id NOT IN (SELECT json_extract(record,'$.undoOf') FROM audit WHERE (\(pending)) AND json_extract(record,'$.undoOf') IS NOT NULL)"
        try execute("BEGIN IMMEDIATE")
        do {
            for var value in try query("SELECT record FROM audit WHERE at < ? AND \(prunable)", [String(max(auditCutoff, undoCutoff))]) {
                if let path = value.undo?.backupPath {
                    let undoRoot = directory.appendingPathComponent("undo").standardizedFileURL
                    let expected = undoRoot.appendingPathComponent(value.id).standardizedFileURL
                    if expected.deletingLastPathComponent().path == undoRoot.path,
                       URL(fileURLWithPath: path).standardizedFileURL.deletingLastPathComponent().path == expected.path {
                        directories.append(expected)
                    }
                }
                if value.at.timeIntervalSince1970 >= auditCutoff {
                    value.undo = nil
                    try execute("UPDATE audit SET record=? WHERE id=?", [try json(value), value.id])
                }
            }
            try execute("DELETE FROM audit WHERE at < ? AND \(prunable)", [String(auditCutoff)])
            try execute("COMMIT")
        } catch {
            try execute("ROLLBACK")
            throw error
        }
        return directories
    }

    private func json(_ value: AuditRecord) throws -> String {
        String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private func databaseError() -> ToolFailure {
        ToolFailure("DESKTOP_AUDIT_STORE", db.map { String(cString: sqlite3_errmsg($0)) } ?? "无法打开活动记录")
    }

    private func prepare(_ sql: String, _ arguments: [String?]) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw databaseError() }
        for (index, value) in arguments.enumerated() {
            let status = value.map { sqlite3_bind_text(statement, Int32(index + 1), $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
                ?? sqlite3_bind_null(statement, Int32(index + 1))
            guard status == SQLITE_OK else {
                sqlite3_finalize(statement)
                throw databaseError()
            }
        }
        return statement
    }

    private func execute(_ sql: String, _ arguments: [String?] = []) throws {
        let statement = try prepare(sql, arguments)
        defer { sqlite3_finalize(statement) }
        var status = sqlite3_step(statement)
        while status == SQLITE_ROW { status = sqlite3_step(statement) }
        guard status == SQLITE_DONE else { throw databaseError() }
    }

    private func query(_ sql: String, _ arguments: [String?]) throws -> [AuditRecord] {
        let statement = try prepare(sql, arguments)
        defer { sqlite3_finalize(statement) }
        var values: [AuditRecord] = []
        var status = sqlite3_step(statement)
        while status == SQLITE_ROW {
            guard let text = sqlite3_column_text(statement, 0) else { throw databaseError() }
            values.append(try decoder.decode(AuditRecord.self, from: Data(String(cString: text).utf8)))
            status = sqlite3_step(statement)
        }
        guard status == SQLITE_DONE else { throw databaseError() }
        return values
    }
}
