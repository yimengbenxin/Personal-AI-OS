import DesktopKit
import Foundation
import LiveKit

/// Byte conversion only. Core owns the encrypted attachment and rotates channels before SDK recovery.
final class DesktopSessionTransport: DesktopTransport, @unchecked Sendable {
    static let frameTopic = "paios.desktop.mcp.v1", fileTopic = "paios.desktop.file.v1"
    private let room: SystemLiveKitRoomOperator
    // A reset marker must outlive any stale buffered frames.
    private var incomingFrames = AsyncStream<DesktopFrame>.makeStream(bufferingPolicy: .bufferingNewest(32))
    private var incomingFiles = AsyncStream<DesktopIncomingFile>.makeStream(bufferingPolicy: .bufferingOldest(8))
    private let lock = NSLock()
    private var readers: [UUID: Task<Void, Error>] = [:]
    private var files = Set<URL>(), retiredFiles = Set<URL>()
    private var finished = false
    private var retiringHistory = false
    private var resetHandler: @Sendable () -> Void = {}
    private let temporary: URL
    init(room: SystemLiveKitRoomOperator, temporary: URL) throws {
        self.room = room; self.temporary = temporary.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: self.temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        room.configureByteStreams(topics: [Self.frameTopic, Self.fileTopic], reset: { [weak self] in self?.rotate(reopen: true) }) { [weak self] topic, reader, context in
            guard let self else { throw CancellationError() }
            try await self.receive(topic: topic, reader: reader, current: context.current, progress: context.progress)
        }
    }
    var auditDeviceID: String? { room.pairedDeviceID }
    func onReset(_ handler: @escaping @Sendable () -> Void) { lock.withLock { resetHandler = handler } }
    func frames() -> AsyncStream<DesktopFrame> { lock.withLock { incomingFrames.stream } }
    func downloads() -> AsyncStream<DesktopIncomingFile> { lock.withLock { incomingFiles.stream } }
    func send(_ frame: Data) async throws {
        guard frame.count <= 1_048_576 else { throw CentralTextError.invalidPacket }
        var offsets = stride(from: 0, to: frame.count, by: 65_536).makeIterator()
        try await room.sendCentralBytes(topic: Self.frameTopic, mime: "application/json", attributes: ["v": "1"], size: frame.count) {
            offsets.next().map { frame.subdata(in: $0..<min($0 + 65_536, frame.count)) }
        }
    }
    func upload(file: URL, attributes: [String: String]) async throws {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        let size = try handle.seekToEnd(); try handle.seek(toOffset: 0)
        try await room.sendCentralBytes(topic: Self.fileTopic, mime: "application/octet-stream", attributes: attributes, size: Int(size)) {
            try handle.read(upToCount: 65_536)
        }
    }
    func receive(topic: String, reader: ByteStreamReader, current: @escaping @Sendable () -> Bool, progress: @escaping @Sendable () -> Void) async throws {
        let frame = topic == Self.frameTopic
        guard current(), let size = reader.info.totalLength, size >= 0, reader.info.attributes["v"] == "1",
              size <= (frame ? 1_048_576 : 50 * 1_048_576),
              reader.info.mimeType == (frame ? "application/json" : "application/octet-stream"),
              frame || reader.info.attributes["dir"] == "down" else { throw CentralTextError.invalidPacket }
        let id = UUID(), file = temporary.appendingPathComponent(UUID().uuidString)
        let wait: @Sendable () async throws -> Void = try lock.withLock {
            guard !finished, !retiringHistory, readers.values.filter({ !$0.isCancelled }).count < 8 else { throw CentralTextError.unavailable }
            let frames = incomingFrames.continuation, downloads = incomingFiles.continuation
            if !frame { files.insert(file) }
            let task = Task {
                var bytes = Data(), count = 0
                var handle: FileHandle?
                defer { try? handle?.close() }
                do {
                    if !frame {
                        guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
                        handle = try FileHandle(forWritingTo: file)
                    }
                    for try await chunk in reader {
                        try Task.checkCancellation()
                        guard current(), chunk.count <= size - count else { throw CentralTextError.invalidPacket }
                        if let handle { try handle.write(contentsOf: chunk) } else { bytes.append(chunk) }
                        count += chunk.count; progress()
                    }
                    try Task.checkCancellation()
                    guard current(), count == size else { throw CentralTextError.invalidPacket }
                    if frame, case .enqueued = frames.yield(DesktopFrame(bytes, current: current)) {} else if frame { throw CentralTextError.unavailable }
                } catch { if !frame { try? FileManager.default.removeItem(at: file) }; throw error }
            }
            readers[id] = task
            let wait: @Sendable () async throws -> Void = { try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() } }
            if !frame {
                let incoming = DesktopIncomingFile(attributes: reader.info.attributes, file: file, completion: wait, abort: { task.cancel(); _ = await task.result }, current: current)
                guard case .enqueued = downloads.yield(incoming) else {
                    task.cancel()
                    return { _ = await task.result; throw CentralTextError.unavailable }
                }
            }
            return wait
        }
        defer { lock.withLock { _ = readers.removeValue(forKey: id) } }
        try await wait()
    }
    func rotate(reopen: Bool) {
        lock.withLock {
            guard !finished else { return }
            DesktopDiagnostics.logger.notice("stopped reason=\(reopen ? "room_rotation" : "transport_finished", privacy: .public)")
            resetHandler()
            if reopen { incomingFrames.continuation.yield(.reset) }
            readers.values.forEach { $0.cancel() }
            retiredFiles.formUnion(files); files = []; finished = !reopen
            if !reopen {
                incomingFrames.continuation.finish(); incomingFiles.continuation.finish()
            }
        }
    }
    func removeTemporaryFiles() async throws {
        let (tasks, paths, ended) = lock.withLock {
            let snapshot = (readers.values.filter(\.isCancelled), retiredFiles, finished); retiredFiles = []; return snapshot
        }
        for task in tasks { _ = await task.result }
        for file in paths where FileManager.default.fileExists(atPath: file.path) { try FileManager.default.removeItem(at: file) }
        if ended { try FileManager.default.removeItem(at: temporary) }
    }
    func finish() { rotate(reopen: false) }
    func retireHistoryFiles() async throws {
        lock.withLock { retiringHistory = true }
        defer { lock.withLock { retiringHistory = false } }
        rotate(reopen: true)
        try await removeTemporaryFiles()
        let parent = temporary.deletingLastPathComponent()
        for path in try FileManager.default.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil) {
            try FileManager.default.removeItem(at: path)
        }
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
}
