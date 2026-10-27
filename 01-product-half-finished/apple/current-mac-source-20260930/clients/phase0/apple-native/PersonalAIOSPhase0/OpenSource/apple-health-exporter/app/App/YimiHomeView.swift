import SwiftUI

/// Level 1: 依米 herself (the hero), what she is doing for you, the conversation entry, and the dock
/// (voice call · hold to talk · video call).
struct YimiHomeView: View {
    @ObservedObject var vm: AssistantViewModel
    @ObservedObject var conversation: YimiConversation
    @ObservedObject var ui: YimiUIState
    let actions: YimiActions
    @State private var stopping: CentralErrand?
    @State private var explainingAmbient = false
    @State private var addingGlasses = false
    @State private var addingComputer = false
    @State private var showingTerminals = false
    @State private var addComputerAfterDevices = false
#if DEBUG
    @State private var internalMacPairing = false
#endif
    @AppStorage("paios.dismissed-macs") private var dismissedMacs = ""
    private static let ambientExplainedKey = "paios.ambient.explained"

    private var newComputers: [CentralTerminal] {
        vm.terminalState.terminals.filter { terminal in
            guard terminal.device_class == "mac", !dismissedMacs.contains("|" + terminal.device_id) else { return false }
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let fractional = formatter.date(from: terminal.paired_at); formatter.formatOptions = [.withInternetDateTime]
            guard let paired = fractional ?? formatter.date(from: terminal.paired_at) else { return false }
            return (0...86_400).contains(Date().timeIntervalSince(paired))
        }
    }
    private var terminalSheet: some View {
        NavigationStack {
            List(vm.terminalState.terminals) { terminal in
                VStack(alignment: .leading) {
                    Text(terminal.displayName)
                    Text(terminal.connected ? "已连接" : "离线").font(.caption)
                    if !terminal.isSelf {
                        Button("撤销", role: .destructive) { Task { await vm.revokeTerminal(terminal.device_id) } }
                    }
                    if terminal.device_class == "mac" {
                        Button(terminal.paused == true ? "继续" : "暂停依米操作电脑") {
                            Task { await vm.pauseDesktop(terminal.device_id, paused: terminal.paused != true) }
                        }
                    }
                }
            }.navigationTitle("设备")
                .safeAreaInset(edge: .bottom) {
                    Button("添加电脑", systemImage: "desktopcomputer") {
                        addComputerAfterDevices = true
                        showingTerminals = false
                    }.buttonStyle(.borderedProminent).tint(Yimi.klein).padding()
                        .accessibilityIdentifier("devices.addComputer")
                }
                .toolbar { Button("完成") { showingTerminals = false } }
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            hero
            if vm.ownerOverride.status?.enabled == true {
                HStack {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                    Text("最高权限")
                    YimiOwnerOverrideStatus(status: vm.ownerOverride.status)
                }
                    .font(.footnote).foregroundStyle(Yimi.klein).padding(.top, 8)
            }
            if vm.payment.available {
                YimiPaymentSummaryRow(payment: vm.payment, onOpen: { actions.openChat() })
                    .padding(.horizontal, 12).padding(.top, 10)
                if let approval = vm.payment.approvals.first {
                    YimiPaymentApprovalCard(payment: vm.payment, approval: approval).padding(.horizontal, 12).padding(.top, 10)
                }
            }
            ForEach(newComputers) { terminal in
                VStack(alignment: .leading, spacing: 8) {
                    Text("新电脑已连接：" + (terminal.label ?? "一台电脑"))
                    HStack {
                        Button("是我") { dismissedMacs += "|" + terminal.device_id }
                        Button("不是我，撤销", role: .destructive) { Task { await vm.revokeTerminal(terminal.device_id) } }
                    }
                }.padding(12)
            }
            if let item = vm.careCheckins.last, let identity = vm.careCheckinIdentity {
                YimiCareCard(item: item, answering: vm.careAnswering) {
                    Task { if !(await vm.careSafe(identity: identity)) { ui.show(vm.lastError ?? "还没告诉依米，请重试") } }
                }.padding(.horizontal, 12).padding(.top, 14)
            }
            if let outcome = vm.careOutcome { Text(outcome).font(.system(size: 13)).foregroundStyle(Yimi.ink3) }
            if let prompt = vm.voiceConfirmations.first {
                YimiConfirmCard(item: prompt, confirming: vm.confirmingVoice.contains(prompt.id) || vm.authenticatingVoice.contains(prompt.id)) { choice in
                    Task {
                        if await vm.confirmVoice(prompt.id, choice: choice) { ui.path.append(.chat) }
                        else { ui.show(vm.lastError ?? "没确认上") }
                    }
                }
                .padding(.horizontal, 12).padding(.top, 14)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if !vm.errands.isEmpty { errandCards.padding(.horizontal, 12).padding(.top, 14) }
            else if let activity { activityCard(activity).padding(.horizontal, 12).padding(.top, 14) }
            conversationCard.padding(.horizontal, 12).padding(.top, 10)
            dock
        }
        .sheet(isPresented: $addingGlasses) { YimiGlassesEnrollmentView() }
        .sheet(isPresented: $addingComputer) { YimiInternalMacPairingView(payment: vm.payment) }
        .sheet(isPresented: $showingTerminals, onDismiss: {
            if addComputerAfterDevices { addComputerAfterDevices = false; addingComputer = true }
        }) { terminalSheet }
#if DEBUG
        .sheet(isPresented: $internalMacPairing) { YimiInternalMacPairingView(payment: vm.payment) }
#endif
        .background(Yimi.ground)
        .toolbar(.hidden, for: .navigationBar)
        .animation(Yimi.Motion.component, value: activity?.title)
        .animation(Yimi.Motion.component, value: vm.errands)
        .animation(Yimi.Motion.component, value: vm.voiceConfirmations)
        .animation(Yimi.Motion.component, value: vm.ambientPhase)
        .confirmationDialog("打开随身模式？", isPresented: $explainingAmbient, titleVisibility: .visible) {
            Button("打开随身模式") {
                UserDefaults.standard.set(true, forKey: Self.ambientExplainedKey)
                setAmbient(true)
            }
        } message: {
            Text("随身模式会上传并记录这台手机听到的对话，App 在后台也是。只想说“依米”叫醒她，请在设备菜单打开本地唤醒。两个开关互不影响。")
        }
        .confirmationDialog("让依米停下这件事？", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }),
                            titleVisibility: .visible, presenting: stopping) { errand in
            Button("停下「\(errand.title)」", role: .destructive) { Task { await vm.cancelErrand(errand.id) } }
        } message: { _ in
            Text("她会马上停手；已经做完的步骤不会撤销。")
        }
    }

    /// What she is doing on the executor phone right now (live feed from the gateway), with a way to stop it.
    private var errandCards: some View {
        VStack(spacing: 8) {
            ForEach(vm.errands.prefix(2)) { errand in
                YimiErrandCard(errand: errand) { stopping = errand }
            }
            if vm.errands.count > 2 {
                Text("还有 \(vm.errands.count - 2) 件在办").font(.system(size: 12)).foregroundStyle(Yimi.ink3)
            }
        }
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            YimiPortrait()
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image("YimMarkHeader").resizable().frame(width: 28, height: 28).accessibilityHidden(true)
                    Text("依米")
                        .font(.system(size: 34, weight: .semibold))
                        .tracking(4)
                        .foregroundStyle(Yimi.klein)
                }
                HStack(spacing: 8) {
                    LiveDot()
                    Text(status).font(.system(size: 15)).foregroundStyle(Yimi.ink2)
                        .contentTransition(.opacity)
                }
            }
            .padding(.leading, 22).padding(.bottom, 20)
            VStack {
                HStack {
                    Button { ui.path.append(.memory) } label: {
                        Image(systemName: "heart")
                            .font(.system(size: 19, weight: .medium))
                            .frame(width: 44, height: 44)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .buttonStyle(PressScale())
                    .foregroundStyle(Yimi.ink)
                    .accessibilityLabel("她了解你")
                    Spacer()
                    VStack(alignment: .trailing, spacing: 6) {
                        YimiAmbientChip(phase: vm.ambientPhase) {
                            if vm.ambientEnabled { setAmbient(false) }
                            else if UserDefaults.standard.bool(forKey: Self.ambientExplainedKey) { setAmbient(true) }
                            else { explainingAmbient = true }
                        }
                        Text(vm.voiceStatus.title)
                            .font(.caption).foregroundStyle(Yimi.ink)
                            .accessibilityIdentifier("yimi.voice.status")
                        if let count = vm.voiceStatus.backgroundCount, count > 0, vm.voiceStatus.phase != .endedWithWork {
                            Text("后台事项 \(count) 件在办")
                                .font(.caption).foregroundStyle(Yimi.ink)
                                .accessibilityIdentifier("yimi.voice.background-count")
                        }
                        if vm.voiceStatus.title != vm.wakeStatus {
                            Text(vm.wakeStatus)
                                .font(.caption).foregroundStyle(Yimi.ink)
                                .accessibilityIdentifier("assistant.wakeStatus")
                        }
                    }
                }
                Spacer()
            }
            .padding(12)
        }
        .overlay(alignment: .topTrailing) {
            if PairedRealtimeRequestBodyProvider().isReady {
                Menu {
                    Button("她的样子", systemImage: "person.crop.square") { ui.path.append(.appearance) }
                        .accessibilityIdentifier("appearance.open")
                    Toggle("本地唤醒「依米」", isOn: Binding(get: { vm.wakeEnabled }, set: { enabled in
                        Task { await vm.setWakeEnabled(enabled) }
                    }))
                    .accessibilityIdentifier("yimi.voice.wake.toggle")
                    Button("添加眼镜", systemImage: "eyeglasses") { addingGlasses = true }
                    Button("添加电脑", systemImage: "desktopcomputer") { addingComputer = true }
                        .accessibilityIdentifier("assistant.addComputer")
#if DEBUG
                    Button("内部测试：扫描 Mac 二维码") { internalMacPairing = true }
#endif
                    Button("设备", systemImage: "laptopcomputer.and.iphone") { showingTerminals = true }
                    if vm.canManageWatchBinding {
                        Section("Apple Watch") {
                            Text(vm.watchBindingStatus)
                            Button("登记或更换 Watch", systemImage: "applewatch") {
                                Task { await vm.manageWatchBinding(revoke: false) }
                            }.disabled(vm.watchBindingBusy)
                                .accessibilityIdentifier("assistant.registerWatch")
                            Button("撤销 Watch", systemImage: "applewatch.slash", role: .destructive) {
                                Task { await vm.manageWatchBinding(revoke: true) }
                            }.disabled(vm.watchBindingBusy)
                                .accessibilityIdentifier("assistant.revokeWatch")
                        }
                    }
                } label: {
                    Label(vm.watchBindingBusy ? "正在更新设备…" : "设备", systemImage: "applewatch")
                        .font(.system(size: 14, weight: .semibold))
                        .padding(.horizontal, 12).frame(minHeight: 44)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .buttonStyle(PressScale()).foregroundStyle(Yimi.ink).padding(.trailing, 12).padding(.top, 64)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Yimi.Radius.hero, style: .continuous))
        .padding(.horizontal, 12).padding(.top, 6)
        .frame(maxHeight: .infinity)
    }

    private func setAmbient(_ on: Bool) {
        Task {
            let before = vm.lastError
            await vm.setAmbientEnabled(on)
            if vm.ambientEnabled != on || (vm.lastError != nil && vm.lastError != before) { ui.show(vm.lastError ?? "随身模式没打开") }
            else { ui.show(on ? (vm.ambientPhase == .on ? "随身模式已打开" : "随身模式已开启，收听暂时暂停") : "随身模式已关闭") }
        }
    }

    private var status: String {
        switch vm.sessionState {
        case .active: return vm.call.isActive ? "在和你通话" : vm.ambientPhase == .on ? "在呢 · 随身听着" : "在呢"
        case .failed: return "暂时没回应，下一次操作会再试"
        case .stopping: return "正在结束…"
        default: return "在呢"
        }
    }

    private struct Activity { let title: String; let detail: String }

    /// A request she is still answering (shown when no errand is running on the executor phone).
    private var activity: Activity? {
        switch vm.promptState {
        case .submitting, .partial:
            return Activity(title: "正在帮你处理", detail: conversation.chatItems.last(where: { $0.kind == .me })?.text ?? "")
        default:
            return nil
        }
    }

    private func activityCard(_ activity: Activity) -> some View {
        Button { ui.path.append(.chat) } label: {
            HStack(spacing: 14) {
                ProgressRing(progress: nil)
                VStack(alignment: .leading, spacing: 3) {
                    Text(activity.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Yimi.ink)
                    Text(activity.detail).font(.system(size: 13)).foregroundStyle(Yimi.ink2).lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold)).foregroundStyle(Yimi.ink3)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .background(Yimi.paper, in: RoundedRectangle(cornerRadius: Yimi.Radius.card, style: .continuous))
        }
        .buttonStyle(PressScale(scale: 0.97))
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var conversationCard: some View {
        Button { ui.path.append(.chat) } label: {
            HStack(spacing: 14) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(Yimi.klein)
                        .frame(width: 44, height: 44)
                        .background(Yimi.surface, in: Circle())
                    if conversation.unread > 0 {
                        Circle().fill(Yimi.klein).frame(width: 10, height: 10)
                            .overlay(Circle().stroke(Yimi.ground, lineWidth: 2)).offset(x: -4, y: 4)
                    }
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text("对话").font(.system(size: 16, weight: .semibold)).foregroundStyle(Yimi.ink)
                    Text(preview).font(.system(size: 13)).foregroundStyle(Yimi.ink2).lineLimit(1)
                }
                Spacer(minLength: 0)
                if let date = conversation.last?.date {
                    Text(date, format: .dateTime.hour().minute())
                        .font(.system(size: 12).monospacedDigit()).foregroundStyle(Yimi.ink3)
                        .frame(maxHeight: .infinity, alignment: .top).padding(.top, 2)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(Yimi.paper, in: RoundedRectangle(cornerRadius: Yimi.Radius.card, style: .continuous))
        }
        .buttonStyle(PressScale(scale: 0.97))
        .accessibilityLabel("对话")
    }

    private var preview: String {
        guard let last = conversation.last else { return "按住下面的按钮，或者点这里打字" }
        switch last.kind {
        case .me: return "你：" + (YimiLongText.preview(last.text) ?? last.text)
        case .her: return "依米：" + (YimiLongText.preview(last.text) ?? last.text)
        case .call: return "通话"
        }
    }

    private var dock: some View {
        HStack(alignment: .bottom) {
            dockSide(icon: "phone", title: "语音", label: "语音通话") { actions.openCall(.voice, UnitPoint(x: 0.24, y: 0.93)) }
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 84, height: 84)
                    .background(Yimi.klein, in: Circle())
                    .shadow(color: Yimi.klein.opacity(0.28), radius: 12, y: 8)
                    .scaleEffect(ui.listening ? 0.94 : 1)
                    .animation(Yimi.Motion.micro, value: ui.listening)
                    .modifier(HoldToTalk(ui: ui, actions: actions))
                    .accessibilityLabel("按住说话")
                    .accessibilityAddTraits(.isButton)
                Text("按住说话").font(.system(size: 12)).foregroundStyle(Yimi.ink2)
            }
            Spacer()
            dockSide(icon: "video", title: "视频", label: "视频通话") { actions.openCall(.video, UnitPoint(x: 0.76, y: 0.93)) }
        }
        .padding(.horizontal, 30).padding(.top, 14).padding(.bottom, 10)
    }

    private func dockSide(icon: String, title: String, label: String, action: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(Yimi.klein)
                    .frame(width: 56, height: 56)
                    .background(Yimi.tint, in: Circle())
            }
            .buttonStyle(PressScale())
            .accessibilityLabel(label)
            Text(title).font(.system(size: 12)).foregroundStyle(Yimi.ink2)
        }
    }
}

/// One running errand: title, app · step · elapsed time, and 停下.
struct YimiErrandCard: View {
    let errand: CentralErrand
    let stop: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            ProgressRing(progress: nil)
            VStack(alignment: .leading, spacing: 3) {
                Text(errand.title).font(.system(size: 16, weight: .semibold)).foregroundStyle(Yimi.ink).lineLimit(1)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(detail(at: context.date)).font(.system(size: 13).monospacedDigit()).foregroundStyle(Yimi.ink2).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if errand.state == "stopping" {
                Text("正在停下").font(.system(size: 13)).foregroundStyle(Yimi.ink3)
            } else {
                Button(action: stop) {
                    Text("停下").font(.system(size: 14, weight: .semibold)).foregroundStyle(Yimi.danger)
                        .padding(.horizontal, 14).frame(height: 32)
                        .background(Yimi.surface, in: Capsule())
                }
                .buttonStyle(PressScale())
                .accessibilityLabel("停下" + errand.title)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(Yimi.paper, in: RoundedRectangle(cornerRadius: Yimi.Radius.card, style: .continuous))
    }

    private func detail(at now: Date) -> String {
        var parts = [errand.app.isEmpty ? "手机" : errand.app]
        parts.append(errand.state == "waiting" ? "排队中" : errand.step > 0 ? "第 \(errand.step) 步" : "准备中")
        if let start = errand.startedAt { parts.append("已用 " + yimiClock(max(0, Int(now.timeIntervalSince(start))))) }
        return parts.joined(separator: " · ")
    }
}

/// 随身模式 on the hero: a quiet switch when off; Klein with the live pulse while she listens; honest about opening and
/// pausing (no session, a muted call, a refused microphone).
struct YimiAmbientChip: View {
    let phase: AssistantAmbientPhase
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(spacing: 7) {
                if phase == .on { LiveDot(size: 7) } else if phase == .starting { ProgressView().controlSize(.mini) }
                else { Image(systemName: "ear").font(.system(size: 14, weight: .semibold)) }
                Text(title).font(.system(size: 14, weight: .semibold)).contentTransition(.opacity)
            }
            .foregroundStyle(phase == .on ? Color.white : Yimi.ink)
            .padding(.horizontal, 14).frame(height: 44)
            .background(phase == .on ? AnyShapeStyle(Yimi.klein) : AnyShapeStyle(.ultraThinMaterial), in: Capsule())
        }
        .buttonStyle(PressScale())
        .accessibilityLabel("随身模式")
        .accessibilityValue(phase == .off ? "已关闭" : phase == .paused ? "已暂停" : "已打开")
    }

    private var title: String {
        switch phase {
        case .off: return "随身模式"
        case .starting: return "正在打开"
        case .on: return "随身听着"
        case .paused: return "随身 · 暂停"
        }
    }
}

private struct YimiGlassesEnrollmentView: View {
    var deviceClass: RealtimeTerminalClass = .glasses
    private var isMac: Bool { deviceClass == .mac }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var enrollment: RealtimeGlassesEnrollment?
    @State private var qr: CGImage?
    @State private var error: String?
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Text(isMac ? "添加电脑" : "让眼镜看向二维码")
                        .font(.title2.weight(.semibold)).foregroundStyle(Yimi.ink)
                    Text(isMac ? "打开电脑上的依米，选择“添加这台电脑”，用电脑摄像头扫描下方二维码。" : "打开眼镜上的依米，选择配对，用眼镜摄像头扫描下方二维码。")
                        .font(.body).foregroundStyle(Yimi.ink2).multilineTextAlignment(.center)
                    if let enrollment, let qr {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if context.date < enrollment.expiresAt && scenePhase == .active {
                                Image(decorative: qr, scale: 1).interpolation(.none).resizable().scaledToFit()
                                    .frame(maxWidth: 280).padding(20).background(.white).accessibilityHidden(true)
                                Text("剩余 \(max(0, Int(enrollment.expiresAt.timeIntervalSince(context.date)))) 秒 · 仅可使用一次")
                                    .font(.callout.monospacedDigit()).foregroundStyle(Yimi.ink2)
                            } else {
                                Text("二维码已隐藏，请重新生成后扫描。")
                                Button("重新生成") { attempt += 1 }.buttonStyle(.borderedProminent)
                            }
                        }
                    } else if let error {
                        Text(error).foregroundStyle(Yimi.danger).multilineTextAlignment(.center)
                        Button("重试") { attempt += 1 }.buttonStyle(.borderedProminent)
                    } else {
                        ProgressView("正在生成二维码…")
                    }
                    if isMac, let enrollment, enrollment.expiresAt > Date(), scenePhase == .active {
                        Button("复制配对码（没有摄像头时）") { UIPasteboard.general.string = String(data: enrollment.qrData, encoding: .utf8) }
                    }
                    Text(isMac ? "二维码用于授权你的电脑，请勿转发。" : "二维码用于授权你的眼镜，请勿转发。")
                        .font(.footnote).foregroundStyle(Yimi.ink2)
                }
                .padding(24).frame(maxWidth: .infinity)
            }
            .background(Yimi.ground).navigationTitle(isMac ? "添加电脑" : "添加眼镜").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .tint(Yimi.klein)
        }
        .task(id: attempt) { await generate() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { enrollment = nil; qr = nil; error = "二维码已隐藏，请重新生成。" }
        }
    }

    @MainActor private func generate() async {
        enrollment = nil; qr = nil; error = nil
        do {
            guard let pairing = try PairedRealtimeRequestBodyProvider().pairing() else {
                error = "请先配对这台 iPhone，再添加眼镜。"; return
            }
            let result = try await ProductionRealtimePublicControlProvider.terminalEnrollment(pairing: pairing, deviceClass: deviceClass)
            try Task.checkCancellation()
            guard try PairedRealtimeRequestBodyProvider().pairing() == pairing, scenePhase == .active else {
                error = "手机配对已变化，请重新生成。"; return
            }
            guard let image = QRCode.image(result.qrData) else {
                error = "二维码生成失败，请重试。"; return
            }
            qr = image; enrollment = result
        } catch is CancellationError {
            return
        } catch {
            self.error = "无法生成二维码。请检查手机配对和网络后重试。"
        }
    }
}
