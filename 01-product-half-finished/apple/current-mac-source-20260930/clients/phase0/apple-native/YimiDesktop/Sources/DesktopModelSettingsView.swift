import SwiftUI

struct DesktopModelSettingsView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    var onPublishKey: (() async -> Void)? = nil
    @State private var role: ModelSettingsRole?
    @State private var provider: ModelSettingsProvider?
    @State private var more = false
    @State private var undoRevision = ""
    @Environment(\.desktopRendering) private var rendering

    var body: some View {
        DesktopContentForm {
            Section {
                HStack {
                    Label(model.connected ? "已连接依米" : "尚未连接", systemImage: "network")
                    Spacer()
                    Button("刷新") { Task { await model.refresh() } }.disabled(model.busy || !model.connected)
                        .accessibilityIdentifier("modelSettings.refresh")
                }
                if !model.authorized {
                    Label("在 iPhone 上授权这台 Mac", systemImage: "lock")
                    Text("先发布这台 Mac 的设置公钥，再在 iPhone 的“模型与密钥”中授权。授权后用 Touch ID 确认修改。")
                        .font(.caption).foregroundStyle(Yimi.ink2)
                    if let onPublishKey {
                        Button("发布这台 Mac 的设置公钥") { Task { await onPublishKey() } }
                            .disabled(model.busy || !model.connected)
                            .accessibilityIdentifier("modelSettings.mac.publishKey")
                    }
                    Text("授权完成后点“刷新”，检查服务器授权状态。此页仍可查看当前设置。")
                        .font(.caption).foregroundStyle(Yimi.ink2)
                }
                if model.busy { ProgressView("正在与依米同步…") }
                if let error = model.error { Text(error).foregroundStyle(Yimi.danger).textSelection(.enabled) }
                if let message = model.message { Text(message).textSelection(.enabled) }
            }
            if let snapshot = model.snapshot {
                Section("保存与生效") {
                    LabeledContent("已保存", value: "版本 \(snapshot.desired)")
                    Text(snapshot.activationText)
                    if snapshot.revision != snapshot.desired {
                        Button("设置已更新，读取最新路由") { Task { await model.refresh() } }
                            .disabled(model.busy || !model.connected)
                    }
                    ForEach(snapshot.groups.keys.sorted(), id: \.self) { key in
                        if let group = snapshot.groups[key] {
                            LabeledContent(key, value: "已保存 \(group.desired) · 已生效 \(group.effective)")
                            Text(group.status).font(.caption).foregroundStyle(Yimi.ink2)
                            if let error = group.error { Text("应用失败，仍用原设置：" + error).foregroundStyle(Yimi.danger) }
                        }
                    }
                }
                Section("日常角色") {
                    ForEach(snapshot.roles.filter(isDaily), id: \.key) { item in roleRow(item) }
                    DisclosureGroup("更多角色", isExpanded: $more) {
                        ForEach(snapshot.roles.filter { !isDaily($0) }, id: \.key) { item in roleRow(item) }
                    }
                }
                Section("服务商与密钥") {
                    ForEach(snapshot.providers, id: \.id) { item in
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.display_name)
                                Text(item.base_url).font(.caption).foregroundStyle(Yimi.ink2).textSelection(.enabled)
                                if let credential = snapshot.credentials.first(where: { $0.credential_ref == item.credential_ref }) {
                                    Text(credential.configured ? "已配置 · 尾号 \(credential.last4 ?? "—") · 版本 \(credential.version)" : "未配置密钥")
                                        .font(.caption).foregroundStyle(Yimi.ink2)
                                    if let date = credential.updated_at { Text("更新于 " + date).font(.caption).foregroundStyle(Yimi.ink2) }
                                    if credential.test_status == "key_reentry_required" { Text("旧密钥已替换，请重新填写").foregroundStyle(Yimi.danger) }
                                }
                            }
                            Spacer()
                            Button(model.authorized && item.wire_protocol != "local_onnx" ? "设置…" : "查看…") { provider = item }
                                .accessibilityIdentifier("modelSettings.provider." + item.id)
                        }
                    }
                }
                if let usage = snapshot.usage { DesktopModelSettingsUsageView(model: model, usage: usage) }
                Section("改回去") {
                    if rendering { LabeledContent("要恢复的版本", value: undoRevision.isEmpty ? "未选择" : undoRevision) }
                    else { TextField("要恢复的版本", text: $undoRevision) }
                    Text("将先读取该版本的完整设置供你确认。旧密钥不会保留；已替换的密钥需重新填写。")
                        .font(.caption).foregroundStyle(Yimi.ink2)
                    Button("查看恢复内容…") {
                        if let revision = Int(undoRevision) { Task { await model.prepareUndo(revision: revision) } }
                    }.disabled(!model.canWrite || model.busy || Int(undoRevision) == nil)
                    if let target = model.undoSnapshot {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("恢复目标 · 版本 \(target.revision)").font(.headline)
                            ForEach(target.providers, id: \.id) { provider in
                                Text("\(provider.display_name) · \(provider.wire_protocol) · \(provider.base_url)")
                                    .font(.caption).textSelection(.enabled)
                            }
                            ForEach(target.roles, id: \.key) { role in
                                Text("\(role.displayName) · \(role.profile) · \(role.provider_ref ?? "继承") · \(role.model_id ?? role.inherit_from ?? "未指定")")
                                    .font(.caption).textSelection(.enabled)
                            }
                            ForEach(target.credentials, id: \.credential_ref) { credential in
                                Text("\(credential.credential_ref) · 密钥版本 \(credential.version) · " + (credential.configured ? "已配置 · 尾号 " + (credential.last4 ?? "—") : "未配置"))
                                    .font(.caption).textSelection(.enabled)
                                if credential.test_status == "key_reentry_required" {
                                    Text("此版本密钥已被替换，请在服务商设置中重新填写。").font(.caption).foregroundStyle(Yimi.danger)
                                }
                            }
                        }
                    }
                }
            } else {
                Section { Text(model.connected ? "刷新以读取模型与密钥设置。" : "连接依米后查看模型与密钥设置。").foregroundStyle(Yimi.ink2) }
            }
        }
        .formStyle(.grouped).tint(Yimi.klein).foregroundStyle(Yimi.ink)
        .background(Yimi.paper).navigationTitle("模型与密钥")
        .frame(minWidth: 580, minHeight: 430)
        .task(id: model.connected) { if !rendering, model.connected { await model.open() } }
        .sheet(isPresented: Binding(get: { role != nil }, set: { if !$0 { role = nil } })) {
            if let role { DesktopModelSettingsRoleEditor(model: model, original: role) }
        }
        .sheet(isPresented: Binding(get: { provider != nil }, set: { if !$0 { provider = nil } })) {
            if let provider { DesktopModelSettingsProviderEditor(model: model, original: provider) }
        }
        .sheet(isPresented: Binding(get: { model.review != nil && role == nil && provider == nil }, set: { if !$0 { model.discardReview() } })) {
            if let review = model.review { DesktopModelSettingsReviewView(model: model, review: review) }
        }
    }

    private func isDaily(_ role: ModelSettingsRole) -> Bool {
        role.isDaily
    }

    private func roleRow(_ role: ModelSettingsRole) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(role.displayName)
                Text("\(role.profile) · \(role.provider_ref ?? "继承") · \(role.model_id ?? role.inherit_from ?? "未指定")")
                    .font(.caption).foregroundStyle(Yimi.ink2)
                if !role.editable { Text("本地模型与执行器 · 只读").font(.caption).foregroundStyle(Yimi.ink2) }
                if role.disabled == true { Text("已停用").font(.caption).foregroundStyle(Yimi.ink2) }
            }
            Spacer()
            Button(model.authorized && role.editable ? "设置…" : "查看…") { self.role = role }
                .accessibilityIdentifier("modelSettings.role." + role.key)
        }
    }
}

struct DesktopModelSettingsUsageView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    let usage: ModelSettingsUsage
    @State private var pause = false
    @State private var reserve = "1"
    @Environment(\.desktopRendering) private var rendering
    init(model: AssistantModelSettingsModel, usage: ModelSettingsUsage) {
        self.model = model; self.usage = usage
        _pause = State(initialValue: usage.pause_on_limit)
        _reserve = State(initialValue: String(usage.owner_reserve_cny))
    }
    var body: some View {
        Section("用量与提醒") {
            LabeledContent("今日已知费用", value: "¥\(usage.known_cny.formatted(.number.precision(.fractionLength(2))))")
            LabeledContent("估算费用", value: "约 ¥\(usage.estimated_cny.formatted(.number.precision(.fractionLength(2))))")
            LabeledContent("费用未知", value: "\(usage.unknown_attempts) 次")
            LabeledContent("外币请求", value: "\(usage.foreign_currency_attempts) 次")
            LabeledContent("每日提醒", value: "¥\(usage.threshold_cny.formatted()) · 上海日期 \(usage.local_date)")
            Text(usage.subscription_remaining).font(.caption).foregroundStyle(Yimi.ink2)
            DesktopCheckbox(title: "超过每日已知费用阈值时暂停新增付费工作", isOn: $pause)
                .disabled(!model.canWrite || model.busy)
            if rendering { LabeledContent("主人对话保留额（元，至少 1 元）", value: reserve) }
            else { TextField("主人对话保留额（元，至少 1 元）", text: $reserve).disabled(!model.canWrite || model.busy) }
            Text("默认只提醒。估算和未知费用不会触发自动暂停。暂停后保留主人对话额度。")
                .font(.caption).foregroundStyle(Yimi.ink2)
            Button("审阅预算策略…") {
                if let value = Double(reserve) { Task { await model.prepareBudget(pauseOnLimit: pause, reserve: value) } }
            }.disabled(!model.canWrite || model.busy || !(Double(reserve).map { $0.isFinite && $0 >= 1 } ?? false))
            LabeledContent("付费工作", value: usage.paused ? "已暂停" : "可继续")
            Button("恢复今天的工作…") { Task { await model.prepareResume() } }
                .disabled(!model.canWrite || model.busy)
                .accessibilityIdentifier("modelSettings.usage.resume")
            Text("恢复不需要主脑在线。确认后自动继续排队工作；明天重新判断预算。")
                .font(.caption).foregroundStyle(Yimi.ink2)
        }
        .onAppear { pause = usage.pause_on_limit; reserve = String(usage.owner_reserve_cny) }
        .onChange(of: usage.pause_on_limit) { pause = $0 }
        .onChange(of: usage.owner_reserve_cny) { reserve = String($0) }
    }
}
