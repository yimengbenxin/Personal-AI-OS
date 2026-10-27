import Combine
import DesktopKit
import Foundation

@MainActor final class DesktopWeChatPreview: ObservableObject {
    @Published private(set) var policy = WeChatPreviewPolicy()
    @Published private(set) var status = "微信预览未开启"
    @Published private(set) var latest: [WeChatPreview] = []
    private let inbox: WeChatPreviewInbox
    private let session: URLSession
    private var task: Task<Void, Never>?
    private var context: (() -> (RealtimeDevicePairing?, Bool, String?))?
    private var generation = UUID()

    init(file: URL, session: URLSession = ProductionRealtimePublicControlProvider.makeSession()) throws {
        inbox = try WeChatPreviewInbox(file: file); self.session = session
    }
    func activate(context: @escaping () -> (RealtimeDevicePairing?, Bool, String?)) {
        self.context = context
        guard task == nil else { return }
        let generation = generation
        task = Task { [weak self] in
            guard let self else { return }
            let loaded = await inbox.policy()
            guard !Task.isCancelled, self.generation == generation else { return }
            policy = loaded
            while !Task.isCancelled {
                let (pairing, connected, pauseReason) = context()
                if !policy.enabled { status = "微信预览未开启" }
                else if !connected || pairing == nil { status = "电脑暂时离线，连接后继续整理" }
                else if let pauseReason { status = pauseReason }
                else if let pairing {
                    do {
                        let reader = try WeChatNotificationReader(database: WeChatNotificationReader.systemDatabase())
                        let batch = try await inbox.prepare(reader: reader, owner: pairing.userID)
                        try Task.checkCancellation()
                        if let batch {
                            latest = batch.previews; status = "正在交给依米整理…"
                            try await upload(batch, pairing: pairing)
                            try Task.checkCancellation()
                            try await inbox.acknowledge(batch.batch_id)
                            status = "预览已交给依米，摘要与草稿会出现在对话里"
                        } else { status = latest.isEmpty ? "等候选定聊天的新通知预览" : "预览已交给依米，摘要与草稿会出现在对话里" }
                    } catch is CancellationError { return }
                    catch let error as URLError where error.code == .cancelled { return }
                    catch { if self.generation == generation { status = error.localizedDescription } }
                }
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
            }
        }
    }
    func configure(enabled: Bool, names: String, owner: String) async throws {
        var next = WeChatPreviewPolicy()
        next.enabled = enabled
        next.chats = Array(Set(names.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })).sorted()
        guard !enabled || !next.chats.isEmpty else { throw NSError(domain: "WeChatPreview", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "请先填写允许预览的聊天或发送者名称。"] ) }
        guard next.chats.allSatisfy({ $0.utf16.count <= 256 && !["微信", "wechat"].contains($0.lowercased()) }) else {
            throw NSError(domain: "WeChatPreview", code: 1, userInfo: [NSLocalizedDescriptionKey: "请填写具体聊天或发送者名称，不能填写“微信”；每个名称最多 256 字。"])
        }
        stop()
        try await inbox.configure(next, owner: owner)
        policy = next; latest = []
        status = enabled ? "等候选定聊天的新通知预览" : "微信预览未开启，未上传的预览已清除"
        if let context { activate(context: context) }
    }
    func reset() async throws {
        stop(); try await inbox.reset(); policy = WeChatPreviewPolicy(); latest = []; status = "微信预览未开启"
        if let context { activate(context: context) }
    }
    func stop() { generation = UUID(); task?.cancel(); task = nil }
    func acceptTrustedHistoryEpoch(_ epoch: String) async throws {
        let previous = task
        stop(); await previous?.value
        try await inbox.acceptTrustedHistoryEpoch(epoch)
        latest = []
        if let context { activate(context: context) }
    }

    func upload(_ batch: WeChatPreviewBatch, pairing: RealtimeDevicePairing) async throws {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(batch)) as! [String: Any]
        object["device_id"] = pairing.deviceID
        var request = URLRequest(url: URL(string: pairing.origin + "/v1/mac/wechat/previews")!)
        request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("Bearer " + pairing.token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: object)
        let (data, response) = try await session.data(for: request, delegate: RealtimeNoRedirectDelegate())
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard response.statusCode == 202 else {
            throw NSError(domain: "WeChatPreview", code: response.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "微信预览未确认交付（HTTP \(response.statusCode)），保留原批次稍后重试。"])
        }
        struct Receipt: Decodable { let schema: String; let batch_id: String; let accepted_ids: [String] }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.schema == "paios.wechat-previews-response.v1", receipt.batch_id == batch.batch_id,
              receipt.accepted_ids.count == batch.previews.count,
              Set(receipt.accepted_ids.map { $0.uppercased() }) == Set(batch.previews.map(\.id)) else {
            throw NSError(domain: "WeChatPreview", code: 1, userInfo: [NSLocalizedDescriptionKey: "微信预览回执不匹配，尚未确认交付。"])
        }
    }
}
