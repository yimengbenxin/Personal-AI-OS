import Foundation

extension Desktop {
    /// Called by the app's authenticated ready handler. There is no MCP tool or local command for this transition.
    public func acceptTrustedHistoryEpoch(_ epoch: String) async throws {
        guard epoch.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { throw CancellationError() }
        let marker = store.appendingPathComponent("desktop-history-epoch")
        if (try? String(contentsOf: marker, encoding: .utf8)) == epoch { return }
        let previous = transport
        await stop()
        do {
            while inFlight > 0 { try await Task.sleep(nanoseconds: 10_000_000) }
            try history.eraseAuditRows()
            for name in ["undo", "transfers", "opengcua-output"] {
                let path = store.appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
            }
            try Data(epoch.utf8).write(to: marker, options: .atomic)
        } catch {
            if let previous { await start(transport: previous) }
            throw error
        }
        if let previous { await start(transport: previous) }
    }
}
