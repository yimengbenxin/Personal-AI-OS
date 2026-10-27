import SwiftUI

struct YimiModelSettingsView: View {
    @ObservedObject var model: AssistantModelSettingsModel

    var body: some View {
        List {
            if let snapshot = model.snapshot {
                Section {
                    Text(snapshot.activationText).font(.headline)
                    if snapshot.revision != snapshot.desired {
                        Button("设置已更新，读取最新路由") { Task { await model.refresh() } }
                            .disabled(model.busy || !model.connected)
                    }
                    LabeledContent("已保存版本", value: "\(snapshot.desired)")
                    ForEach(snapshot.groups.keys.sorted(), id: \.self) { key in
                        if let group = snapshot.groups[key] {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(key).font(.subheadline.weight(.medium))
                                Text("期望 v\(group.desired) · 实际 v\(group.effective) · \(group.status)")
                                    .font(.caption).foregroundStyle(Yimi.ink2)
                                if let error = group.error { Text(error).font(.caption).foregroundStyle(Yimi.danger) }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                Section("日常角色") {
                    ForEach(snapshot.roles.filter { isDaily($0) }, id: \.key) { role in
                        roleLink(role, snapshot: snapshot)
                    }
                    NavigationLink("更多角色") {
                        List {
                            ForEach(snapshot.roles.filter { !isDaily($0) }, id: \.key) { role in
                                roleLink(role, snapshot: snapshot)
                            }
                        }.navigationTitle("更多角色").tint(Yimi.klein)
                    }
                }
                Section {
                    NavigationLink("用量与提醒") { YimiModelUsageView(model: model) }
                    NavigationLink("授权 Mac") { YimiModelMacAuthorizationView(model: model) }
                    NavigationLink("改回去") { YimiModelUndoView(model: model) }
                }
                Section("服务商与密钥") {
                    ForEach(snapshot.providers, id: \.id) { provider in
                        NavigationLink {
                            YimiModelProviderView(model: model, provider: provider)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(provider.display_name)
                                Text(provider.wire_protocol).font(.caption).foregroundStyle(Yimi.ink2)
                            }.padding(.vertical, 4)
                        }.accessibilityIdentifier("modelSettings.provider." + provider.id)
                    }
                }
            } else if model.busy { ProgressView("正在读取模型设置") }
            else { Text(model.connected ? "暂未取得设置" : "连接依米后查看模型设置").foregroundStyle(Yimi.ink2) }
            if let message = model.message { Section { Text(message).foregroundStyle(Yimi.ink2) } }
            if let error = model.error { Section { Text(error).foregroundStyle(Yimi.danger).textSelection(.enabled) } }
            if !model.authorized { Section { Text("当前设备未获模型设置权限").foregroundStyle(Yimi.ink2) } }
        }
        .navigationTitle("模型与密钥").navigationBarTitleDisplayMode(.inline)
        .tint(Yimi.klein).scrollContentBackground(.hidden).background(Yimi.ground)
        .task { await model.open() }.refreshable { await model.refresh() }
        .sheet(isPresented: Binding(get: { model.review != nil }, set: { if !$0 { model.discardReview() } })) {
            YimiModelSettingsConfirmationSheet(model: model)
        }
    }

    private func isDaily(_ role: ModelSettingsRole) -> Bool {
        role.isDaily
    }

    private func roleLink(_ role: ModelSettingsRole, snapshot: ModelSettingsSnapshot) -> some View {
        NavigationLink {
            YimiModelRoleView(model: model, role: role, providers: snapshot.providers)
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(role.displayName)
                Text([role.profile, role.provider_ref, role.model_id].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Yimi.ink2)
                if !role.editable { Text("本地能力 · 只读").font(.caption).foregroundStyle(Yimi.ink2) }
            }.padding(.vertical, 5)
        }.accessibilityIdentifier("modelSettings.role." + role.key)
    }
}

struct YimiModelUndoView: View {
    @ObservedObject var model: AssistantModelSettingsModel
    @State private var revision = ""
    var body: some View {
        Form {
            Section {
                TextField("目标版本号", text: $revision).keyboardType(.numberPad)
                Text("先读取该版本的完整差异，核对服务商、模型和密钥版本，再确认改回去。")
                    .font(.footnote).foregroundStyle(Yimi.ink2)
                Text("服务器不保留旧密钥。如果该版本的密钥已被替换，需要重新填写。")
                    .font(.footnote).foregroundStyle(Yimi.ink2)
                Button("查看版本差异") {
                    if let value = Int(revision) { Task { await model.prepareUndo(revision: value) } }
                }.frame(minHeight: 44).disabled(!model.canWrite || model.busy || !(Int(revision).map { $0 >= 0 } ?? false))
            }
            if let error = model.error { Section { Text(error).foregroundStyle(Yimi.danger) } }
            if let target = model.undoSnapshot {
                Section("目标版本 \(target.revision)") {
                    ForEach(target.providers) { provider in Text(provider.display_name + " · " + provider.base_url) }
                    ForEach(target.roles, id: \.key) { role in
                        Text(role.routeDescription)
                    }
                    ForEach(target.credentials, id: \.credential_ref) { credential in
                        Text(credential.credential_ref + " · v\(credential.version) · " + (credential.configured ? "已配置" : "请重新填写密钥"))
                    }
                }
            }
        }.navigationTitle("改回去").tint(Yimi.klein)
    }
}
