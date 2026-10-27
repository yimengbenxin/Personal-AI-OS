import AppKit
import Darwin
import DesktopKit
import Security

/// Owns only the paired account's OpenSSH processes; Desktop owns pause state.
@MainActor final class DesktopOwnerSSH {
    struct Provision: Decodable {
        let schema: String, device_id: String, authorized_key: String
        let paused: Bool
        let relay: Relay
        struct Relay: Decodable { let server_addr: String, token: String, proxy_name: String, secret_key: String; let server_port: Int }
    }
    let directory: URL
    var auditURL: URL { directory.appendingPathComponent("commands.jsonl") }
    func acceptTrustedHistoryEpoch(_ epoch: String) async throws {
        let marker = directory.appendingPathComponent("history-epoch")
        if (try? String(contentsOf: marker, encoding: .utf8)) == epoch { return }
        let previous = lease
        lease?.cancel(); lease = nil
        await previous?.value
        try stop()
        for path in [auditURL, directory.appendingPathComponent("opengcua-output")] {
            if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try Data(epoch.utf8).write(to: marker, options: .atomic)
    }
    private var children: [Process] = []
    private var lifelines: [Pipe] = []
    private var lease: Task<Void, Never>?
    private let embedded: EmbeddedCUA
    private let session: URLSession
    private let revocations: any DesktopRevocationPersisting
    private var revocationRetry: Task<Void, Never>?
    private let sleep: @Sendable (Duration) async throws -> Void
    init(directory: URL, session: URLSession = ProductionRealtimePublicControlProvider.makeSession(),
         revocations: any DesktopRevocationPersisting = KeychainDesktopRevocations(),
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.directory = directory; self.session = session; self.revocations = revocations; self.sleep = sleep
        embedded = EmbeddedCUA(directory: directory)
    }
    func update(pairing: RealtimeDevicePairing?, paused: Bool, report: @escaping (String) -> Void) {
        lease?.cancel()
        do { try stop() } catch { report(error.localizedDescription); return }
        guard let pairing else { return }
        do { if try hasPendingRevocation(pairing) { return } }
        catch { report(DesktopUserFacingError.message(error)); return }
        lease = Task {
            do {
                if paused { _ = try await request(pairing, action: "pause", body: [:]); return }
                if !UserDefaults.standard.bool(forKey: "desktop.ownerSSHExplained") {
                    let alert = NSAlert(); alert.messageText = "依米可以使用你的 Mac 账户"
                    alert.informativeText = "配对后，依米以你的 Mac 账户身份操作：能读取、批量修改原文件，运行你安装的工具。暂停电脑操作会立即断开，已完成的修改不会撤销。文件打不开时，可在系统设置中为依米开启“完全磁盘访问”。每笔付款仍要你确认；第一次给某个人发某类信息前，也会先问你。"
                    alert.addButton(withTitle: "知道了"); alert.runModal()
                    UserDefaults.standard.set(true, forKey: "desktop.ownerSSHExplained")
                }
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let key = directory.appendingPathComponent("host_key")
                if !FileManager.default.fileExists(atPath: key.path) {
                    let process = try launch("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key.path]); process.waitUntilExit()
                    guard process.terminationStatus == 0 else { throw CocoaError(.executableRuntimeMismatch) }
                }
                let host = try String(contentsOf: key.appendingPathExtension("pub"), encoding: .utf8)
                    .split(whereSeparator: \.isWhitespace).prefix(2).joined(separator: " ")
                while !Task.isCancelled {
                    do {
                        let data = try await request(pairing, action: "provision", body: ["ssh_user": NSUserName(), "home": FileManager.default.homeDirectoryForCurrentUser.path, "host_public_key": host])
                        try Task.checkCancellation()
                        let provision = try JSONDecoder().decode(Provision.self, from: data)
                        guard provision.schema == "paios.owner-mac-ssh.v1", provision.device_id == pairing.deviceID,
                              provision.authorized_key.hasPrefix("ssh-ed25519 "), !provision.authorized_key.contains("\n") else { throw CocoaError(.fileReadCorruptFile) }
                        if provision.paused { try stop() }
                        else if children.isEmpty { try start(provision) }
                        else if children.contains(where: { !$0.isRunning }) || embedded.failed { throw CocoaError(.executableRuntimeMismatch) }
                    } catch let error as URLError where error.code != .cancelled { report("Mac 账户连接：" + error.localizedDescription) }
                    catch let error as NSError where error.domain == "OwnerMacSSH" && [502, 503, 504].contains(error.code) { report("Mac 账户连接：" + error.localizedDescription) }
                    try await Task.sleep(for: .seconds(30))
                }
            } catch is CancellationError {} catch let error as URLError where error.code == .cancelled {} catch {
                guard !Task.isCancelled else { return }
                do { try stop() } catch { report(error.localizedDescription) }
                report("Mac 账户连接不可用：" + error.localizedDescription)
            }
        }
    }
    func revoke(_ pairing: RealtimeDevicePairing) async throws {
        lease?.cancel(); try stop()
        try rememberRevocation(pairing)
        try await retryRevocations()
    }
    func rememberRevocation(_ pairing: RealtimeDevicePairing) throws {
        let intent = DesktopRevocation(origin: pairing.origin, deviceID: pairing.deviceID, token: pairing.token)
        var pending = try revocations.load()
        if !pending.contains(intent) { pending.append(intent); try revocations.save(pending) }
    }
    func hasPendingRevocation(_ pairing: RealtimeDevicePairing) throws -> Bool {
        try revocations.load().contains { $0.deviceID == pairing.deviceID && $0.token == pairing.token }
    }
    func hasPendingRevocations() throws -> Bool { try !revocations.load().isEmpty }
    func retryRevocations() async throws {
        for intent in try revocations.load() {
            _ = try await request(origin: intent.origin, deviceID: intent.deviceID, token: intent.token, action: "revoke", body: [:])
            var remaining = try revocations.load(); remaining.removeAll { $0 == intent }; try revocations.save(remaining)
        }
    }
    func resumeRevocations(report: @escaping (String?) -> Void) {
        guard revocationRetry == nil else { return }
        revocationRetry = Task { [weak self, sleep] in
            var attempt = 0
            defer { self?.revocationRetry = nil }
            while !Task.isCancelled {
                do {
                    guard let self else { return }
                    try await retryRevocations()
                    if try revocations.load().isEmpty { report(nil); return }
                    continue
                }
                catch { report("这台电脑已停止连接；云端解绑待重试：" + DesktopUserFacingError.message(error)) }
                do { try await sleep(AssistantReconnectBackoff.delay(attempt: attempt)); attempt += 1 }
                catch { return }
            }
        }
    }
    func stop() throws {
        let embeddedStop = Result { try embedded.stop() }
        // EOF also reaches the supervisors when this app is killed without shutdown.
        for pipe in lifelines { try pipe.fileHandleForWriting.close() }
        lifelines = []
        var failed = false
        for child in children { child.waitUntilExit(); failed = failed || child.terminationStatus != 0 }; children = []
        let auth = directory.appendingPathComponent("authorized_keys")
        if FileManager.default.fileExists(atPath: auth.path) { try FileManager.default.removeItem(at: auth) }
        if failed { throw CocoaError(.executableRuntimeMismatch) }
        try embeddedStop.get()
    }
    func shutdown() { lease?.cancel(); do { try stop() } catch { NSLog("SSH shutdown failed: %@", error.localizedDescription) } }
    private func request(_ pairing: RealtimeDevicePairing, action: String, body: [String: String]) async throws -> Data {
        try await request(origin: pairing.origin, deviceID: pairing.deviceID, token: pairing.token, action: action, body: body)
    }
    private func request(origin: String, deviceID: String, token: String, action: String, body: [String: String]) async throws -> Data {
        var request = URLRequest(url: URL(string: origin + "/v1/mac/ssh/" + action)!)
        request.httpMethod = "POST"; request.timeoutInterval = 20
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body.merging(["device_id": deviceID]) { _, id in id })
        let (data, response) = try await session.data(for: request, delegate: RealtimeNoRedirectDelegate())
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if action == "revoke", let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String,
           RealtimePublicControlAdapterError.unexpectedHTTPStatus(response.statusCode, code).isPairingRevoked { return data }
        guard response.statusCode == 200 else { throw NSError(domain: "OwnerMacSSH", code: response.statusCode, userInfo: [NSLocalizedDescriptionKey: "账户连接请求失败（HTTP \(response.statusCode)）"]) }
        return data
    }
    private func start(_ config: Provision) throws {
        if UserDefaults.standard.bool(forKey: "desktop.embeddedCUAEnabled") { try embedded.start() }
        var socketFD = socket(AF_INET, SOCK_STREAM, 0); defer { if socketFD >= 0 { close(socketFD) } }
        var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let port = try withUnsafeMutablePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { raw -> UInt16 in
                guard bind(socketFD, raw, length) == 0, getsockname(socketFD, raw, &length) == 0 else { throw POSIXError(.EADDRINUSE) }
                return UInt16(bigEndian: pointer.pointee.sin_port)
            }
        }
        func write(_ name: String, _ value: String) throws {
            try Data(value.utf8).write(to: directory.appendingPathComponent(name), options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: directory.appendingPathComponent(name).path)
        }
        try write("authorized_keys", config.authorized_key + "\n")
        let helper = Bundle.main.resourceURL!.appendingPathComponent("owner-ssh-audit").path
        func quoted(_ value: String) -> String { "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" }
        try write("sshd_config", [
            "Port \(port)", "ListenAddress 127.0.0.1",
            "HostKey \(quoted(directory.appendingPathComponent("host_key").path))",
            "AuthorizedKeysFile \(quoted(directory.appendingPathComponent("authorized_keys").path))",
            "PidFile none", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
            "UsePAM no", "StrictModes yes", "AllowUsers \(NSUserName())",
            "AllowTcpForwarding local", "PermitOpen 127.0.0.1:\(AndroidVirtualDevice.adbPort)", "GatewayPorts no", "AllowStreamLocalForwarding no", "PermitTTY no",
            "ForceCommand '\(helper.replacingOccurrences(of: "'", with: "'\"'\"'"))' '\(auditURL.path.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
        ].joined(separator: "\n") + "\n")
        let relay = config.relay
        let frp: [String: Any] = [
            "loginFailExit": false,
            "serverAddr": relay.server_addr, "serverPort": relay.server_port,
            "auth": ["method": "token", "token": relay.token], "transport": ["protocol": "wss", "tls": ["trustedCaFile": "/etc/ssl/cert.pem"]],
            "proxies": [["name": relay.proxy_name, "type": "stcp", "secretKey": relay.secret_key,
                         "localIP": "127.0.0.1", "localPort": port]]
        ]
        try write("frpc.json", String(decoding: JSONSerialization.data(withJSONObject: frp), as: UTF8.self))
        close(socketFD); socketFD = -1
        children.append(try supervise("/usr/sbin/sshd", ["-D", "-e", "-f", directory.appendingPathComponent("sshd_config").path]))
        children.append(try supervise(Bundle.main.resourceURL!.appendingPathComponent("frpc").path, ["-c", directory.appendingPathComponent("frpc.json").path]))
    }
    private func supervise(_ path: String, _ arguments: [String]) throws -> Process {
        let process = Process(), pipe = Pipe()
        guard fcntl(pipe.fileHandleForWriting.fileDescriptor, F_SETFD, FD_CLOEXEC) != -1 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno)!)
        }
        process.executableURL = Bundle.main.resourceURL!.appendingPathComponent("owner-ssh-audit")
        process.arguments = ["--supervise", path] + arguments
        process.standardInput = pipe; process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.standardError
        try process.run()
        pipe.fileHandleForReading.closeFile()
        lifelines.append(pipe)
        return process
    }
    private func launch(_ path: String, _ arguments: [String]) throws -> Process {
        let process = Process(); process.executableURL = URL(fileURLWithPath: path); process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.standardError
        try process.run(); return process
    }
}


struct DesktopRevocation: Codable, Equatable {
    let origin: String
    let deviceID: String
    let token: String
}
protocol DesktopRevocationPersisting {
    func load() throws -> [DesktopRevocation]
    func save(_ intents: [DesktopRevocation]) throws
}
/// Separate from active pairing: these credentials can only enter the revoke request path.
final class KeychainDesktopRevocations: DesktopRevocationPersisting {
    private let service: String
    init(service: String = KeychainRealtimeDevicePairingStore.service) { self.service = service }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "desktop-pending-revocations", kSecAttrSynchronizable as String: false,
         kSecUseDataProtectionKeychain as String: false]
    }
    func load() throws -> [DesktopRevocation] {
        var lookup = query; lookup[kSecReturnData as String] = true; lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let result = SecItemCopyMatching(lookup as CFDictionary, &item)
        if result == errSecItemNotFound { return [] }
        guard result == errSecSuccess, let data = item as? Data else { throw RealtimeDevicePairingError.unavailable }
        return try JSONDecoder().decode([DesktopRevocation].self, from: data)
    }
    func save(_ intents: [DesktopRevocation]) throws {
        if intents.isEmpty {
            let result = SecItemDelete(query as CFDictionary)
            guard result == errSecSuccess || result == errSecItemNotFound else { throw RealtimeDevicePairingError.unavailable }
            return
        }
        let data = try JSONEncoder().encode(intents)
        let result = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if result == errSecSuccess { return }
        guard result == errSecItemNotFound else { throw RealtimeDevicePairingError.unavailable }
        var item = query; item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw RealtimeDevicePairingError.unavailable }
    }
}
