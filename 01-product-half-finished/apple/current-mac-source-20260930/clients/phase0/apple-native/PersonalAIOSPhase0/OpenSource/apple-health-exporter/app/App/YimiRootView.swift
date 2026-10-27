import SwiftUI

/// Every page pushed on the root stack. A pushed page never owns a NavigationStack of its own: SwiftUI merges a nested
/// stack into this bound `[YimiRoute]` path and traps (`boundPathChange` → `swift_unexpectedError`; for example,
/// 她了解你 → 健康数据与诊断 pushed the exporter's TabView of stacks). Screens with their own stacks are presented modally.
enum YimiRoute: Hashable, CaseIterable { case chat, memory, health, contacts, payment, modelSettings, voiceprint, appearance }

/// UI-only state shared by the screens: the call cover (open / minimised, voice or video, where it grows from),
/// hold-to-talk, and the top toast. Session work stays in AssistantViewModel.
@MainActor
final class YimiUIState: ObservableObject {
    enum CallMode { case voice, video }
    @Published var path: [YimiRoute] = [] {
        didSet {
#if DEBUG
            if path.last == .chat, oldValue.last != .chat { beginChatOpenMeasurement() }
#endif
        }
    }
    @Published var chatScrollRequest: UInt64 = 0
#if DEBUG
    private var chatOpenStartedAt: TimeInterval?
    @Published private(set) var chatOpenLayoutSeconds: TimeInterval?

    private func beginChatOpenMeasurement() {
        guard ProcessInfo.processInfo.arguments.contains("-ui-testing") else { return }
        chatOpenLayoutSeconds = nil
        chatOpenStartedAt = ProcessInfo.processInfo.systemUptime
    }

    func recordChatLayout() {
        guard let started = chatOpenStartedAt else { return }
        chatOpenStartedAt = nil
        chatOpenLayoutSeconds = ProcessInfo.processInfo.systemUptime - started
    }
#endif
    @Published var chatCallID: String?
    @Published var callOpen = false
    @Published var callMinimized = false
    @Published var callMode: CallMode = .voice
    @Published var callStartedAt = Date()
    var timedCallID: String?
    @Published var listening = false
    @Published var listeningCancels = false
    @Published var toast: String?
    /// Where the cover grows from (the tapped button) and shrinks to (island or PiP).
    var callAnchor: UnitPoint = .center
    /// The hold-to-talk press the finger is on (minted on touch-down, cleared on lift), so a lift is never lost
    /// even when the window has not opened yet.
    var voicePress: UInt64?
    /// Bumped by every call open and hang-up: a late result of an earlier open never touches the cover.
    private var toastTask: Task<Void, Never>?

    func show(_ text: String) {
        toastTask?.cancel()
        withAnimation(Yimi.Motion.component) { toast = text }
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(Yimi.Motion.component) { self?.toast = nil }
        }
    }
}

/// Root of the 依米 app: the navigation stack (home → chat / memory, native swipe-back) under the call cover, the
/// minimised call (top island, plus a draggable PiP for video), the hold-to-talk surface and the toast.
struct YimiRootView: View {
    @ObservedObject var vm: AssistantViewModel
    let placeSensing: PlaceSensingService?
    @StateObject private var conversation: YimiConversation
    @StateObject private var ui = YimiUIState()
    @Environment(\.scenePhase) private var scenePhase

    init(vm: AssistantViewModel, placeSensing: PlaceSensingService? = nil) {
        self.vm = vm
        self.placeSensing = placeSensing
        _conversation = StateObject(wrappedValue: vm.conversation)
    }

    var body: some View {
        ZStack {
            Group {
            NavigationStack(path: $ui.path) {
                YimiHomeView(vm: vm, conversation: conversation, ui: ui, actions: actions)
                    .navigationDestination(for: YimiRoute.self) { route in
                        switch route {
                        case .chat: YimiChatView(vm: vm, conversation: conversation, ui: ui, actions: actions)
                        case .memory: YimiMemoryView(vm: vm, placeSensing: placeSensing)
                        case .health: YimiHealthView(vm: vm)
                        case .contacts: YimiContactsView(vm: vm)
                        case .payment: YimiPaymentSettingsView(payment: vm.payment, ownerOverride: vm.ownerOverride, onVoice: { ui.path.append(.voiceprint) })
                        case .modelSettings: YimiModelSettingsView(model: vm.modelSettings)
                        case .voiceprint: YimiPaymentVoiceprintView(vm: vm)
                        case .appearance: YimiAppearanceView(state: vm.appearanceState, terminals: vm.terminalState.terminals,
                            onRefresh: { Task { await vm.refreshAppearance() } },
                            onPrepare: { look, focus, version, quote in Task {
                                await vm.prepareAppearance(lookID: look, focus: focus, expectedVersion: version, quote: quote)
                            } }, onReconcile: { Task { await vm.reconcileAppearance() } },
                            onCancel: { Task { await vm.cancelAppearance() } },
                            onReuse: { version in Task { await vm.reuseAppearance(version) } },
                            receipts: vm.terminalState.avatarLoadedReceipts, profileVersion: vm.terminalState.avatarVersion,
                            onUpload: { try await vm.uploadAppearance($0) })
                        }
                    }
            }
            .tint(Yimi.klein)

            if ui.callOpen && !ui.callMinimized && !vm.call.isAmbient {
                YimiCallView(vm: vm, conversation: conversation, ui: ui, actions: actions)
                    .transition(.asymmetric(
                        insertion: .scale(scale: 0.12, anchor: ui.callAnchor).combined(with: .opacity),
                        removal: .scale(scale: ui.callOpen ? 0.2 : 0.92, anchor: ui.callAnchor).combined(with: .opacity)))
                    .zIndex(3)
            }
            if ui.callOpen && ui.callMinimized && !vm.call.isAmbient {
                YimiMinimizedCall(vm: vm, ui: ui, underNavigationBar: !ui.path.isEmpty, restore: actions.restoreCall)
                    .transition(.opacity)
                    .zIndex(4)
            }
            if vm.call.isActive && vm.call.isAmbient {
                VStack {
                    HStack(spacing: 10) {
                        Label("依米在和你说话", systemImage: "waveform")
                        Button("结束", role: .destructive) { Task { await vm.endCall() } }
                    }
                    .font(.system(size: 13, weight: .medium))
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, ui.path.isEmpty ? 58 : 8)
                    Spacer()
                }
                .zIndex(4)
            }
            if vm.cameraRequestVisible {
                YimiCameraRequestView(vm: vm, videoPreview: vm.videoPreviewModel)
                    .zIndex(7)
            }
            if ui.listening {
                YimiListeningSurface(conversation: conversation, ui: ui)
                    .transition(.asymmetric(insertion: .scale(scale: 0.05, anchor: .bottom).combined(with: .opacity),
                                            removal: .opacity))
                    .zIndex(5)
            }
            if let toast = ui.toast {
                VStack {
                    Text(toast)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Yimi.ground)
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .background(Yimi.ink, in: Capsule())
                        .padding(.top, 58)
                    Spacer()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
                .allowsHitTesting(false)
                .zIndex(6)
            }
            }
            .accessibilityHidden(vm.payment.appLock.covered || vm.payment.appLock.obscured)
        }
        .background(Yimi.ground)
        .background { YimiLockWindow(payment: vm.payment, lock: vm.payment.appLock).frame(width: 0, height: 0) }
        .task { await autoStart() }
        .onReceive(NotificationCenter.default.publisher(for: VoiceCallInputHealth.notice).receive(on: DispatchQueue.main)) { note in
            if let text = note.object as? String { ui.show(text) }
        }
        .onChange(of: vm.cameraRequestVisible) { _, visible in
            if visible { dismissKeyboard() }
        }
        .onChange(of: vm.callFailure) { _, reason in
            if let reason, !ui.callOpen { ui.show(reason) }
        }
        // `initial` reports the launch phase synchronously; a phase read inside `.task` can be a stale
        // `.inactive` that lands after `.active` and leaves the cover up with no unlock button.
        .onChange(of: scenePhase, initial: true) { old, phase in
            vm.payment.appLock.scene(phase)
            Task { await vm.sceneActivityChanged(phase == .active) }
            guard old != phase else { return }
            if phase == .active { Task { await autoStart() } }
            if phase == .background { Task { await conversation.saveNow() } }
        }
        .onChange(of: vm.openPaymentRequested) { _, requested in
            if requested {
                minimize()
                if ui.path.last != .chat { ui.path.append(.chat) }
                ui.chatScrollRequest &+= 1
                vm.openPaymentRequested = false
            }
        }
        .onChange(of: vm.notificationOpenRevision) { _, _ in
            minimize()
            if ui.path.last != .chat { ui.path.append(.chat) }
        }
        .onOpenURL { url in
            guard url.scheme == "paios", url.host == "call", vm.call.isActive, !vm.call.isAmbient else { return }
            ui.callOpen = true; ui.callMinimized = false
        }
        .onChange(of: vm.call.isActive) { was, now in
            // The call ended outside the UI (remote close, network): close the cover too.
            if was && !now && ui.callOpen && vm.call.state != "failed" && vm.callFailure == nil {
                withAnimation(Yimi.Motion.component) { ui.callOpen = false; ui.callMinimized = false }
            }
            // A call opened elsewhere on the same session (the Watch): show it.
            if !was && now && !ui.callOpen && !vm.call.isAmbient && vm.voiceEnrollment.callID != vm.call.id {
                ui.callMode = .voice
                ui.callStartedAt = Date()
                ui.callAnchor = .center
                withAnimation(Yimi.Motion.cover) { ui.callOpen = true; ui.callMinimized = false }
            }
        }
        .onChange(of: vm.componentVideoFailure) { _, failed in
            if failed && vm.call.isActive { ui.show("她的画面没接上") }
        }
        .onChange(of: vm.call.state) { _, state in
            // The call time counts from when she picks up (central's live), not from the tap.
            if state == "live" && vm.call.isActive && ui.timedCallID != vm.call.id {
                ui.timedCallID = vm.call.id; ui.callStartedAt = Date()
            }
        }
        .onChange(of: conversation.lastVoicePhase) { _, phase in
            // A released turn that ended before anything was sent (没听清 or a failure) says so.
            if phase == .failed, let outcome = vm.voiceTurn.unsentOutcome { ui.show(outcome) }
        }
        .onChange(of: vm.cameraPhase) { _, phase in
            guard vm.call.isActive else { return }
            // Show opening immediately; the preview remains a placeholder until capture starts.
            if phase == .opening || phase == .on {
                withAnimation(Yimi.Motion.page) { ui.callMode = .video }
            } else if ui.callMode == .video {
                withAnimation(Yimi.Motion.page) { ui.callMode = .voice }
            }
        }
    }

    /// Connect without a Start button: wait for the first session snapshot, then start; again on return to the app.
    /// A confirmed new Start supersedes an earlier unknown Stop. Returning to the app starts a media-free connection.
    private func autoStart() async {
#if DEBUG
        if conversation.hasActivityFixture {
            if !conversation.hasChatFixture, ui.path.isEmpty { ui.path = [.chat] }
            return
        }
#endif
        await vm.refreshNotificationPermissions(retryDirty: true)
        guard !Task.isCancelled, !vm.sessionState.isActive else { return }
        await vm.start()
    }

    private var actions: YimiActions {
        YimiActions(
            openCall: { mode, anchor in
                dismissKeyboard()
                if ui.callOpen && (vm.isDialing || (vm.callFailure == nil || vm.componentVideoFailure) && vm.call.state != "failed") { restore(); return }
                ui.callAnchor = anchor
                ui.callMode = mode
                ui.callStartedAt = Date()
                withAnimation(Yimi.Motion.cover) { ui.callOpen = true; ui.callMinimized = false }
                Task { await vm.startCall(video: mode == .video) }
            },
            minimizeCall: { minimize() },
            openChat: {
                minimize()
                ui.chatCallID = vm.call.id
                if let index = ui.path.firstIndex(of: .chat) { ui.path = Array(ui.path.prefix(index + 1)) }
                else { ui.path.append(.chat) }
                ui.chatScrollRequest &+= 1
            },
            restoreCall: { restore() },
            endCall: {
                ui.callAnchor = .center
                withAnimation(Yimi.Motion.component) { ui.callOpen = false; ui.callMinimized = false }
                // Ends an opening attempt too, and releases the call's microphone and camera.
                Task { await vm.endCall() }
            },
            switchMode: {
                if vm.call.isActive {
                    let enabled = !vm.cameraEnabled
                    Task {
                        if await vm.setCallCameraEnabled(enabled) {
                            withAnimation(Yimi.Motion.page) { ui.callMode = enabled ? .video : .voice }
                        }
                    }
                    return
                }
                if ui.callMode == .video {
                    withAnimation(Yimi.Motion.page) { ui.callMode = .voice }
                    ui.show("已关摄像头 · 转为语音通话")
                    Task { await vm.setCameraEnabled(false) }
                    return
                }
                // Opening follows the media owner immediately; success still waits for publication.
                ui.show("正在打开摄像头…")
                Task {
                    if await vm.setCameraEnabled(true) {
                        withAnimation(Yimi.Motion.page) { ui.callMode = .video }
                        ui.show("已打开视频")
                    } else {
                        ui.show("摄像头没打开" + (vm.lastError.map { "：" + $0 } ?? ""))
                    }
                }
            },
            send: { text in
                switch await conversation.send(text) {
                case .submitted: return true
                case .unavailable: ui.show("暂时无法发送，请稍后重试")
                case .failed(let reason): ui.show("没发出去：" + reason)
                }
                return false
            },
            beginVoice: {
                dismissKeyboard()
                let press = vm.nextVoicePress()
                ui.voicePress = press
                ui.listeningCancels = false
                Task {
                    let open = await conversation.beginVoice(press: press)
                    // Lifted meanwhile: the coordinator already cancelled (or will commit) this press.
                    guard ui.voicePress == press else { return }
                    if open {
                        withAnimation(Yimi.Motion.page) { ui.listening = true }
                    } else {
                        ui.show("语音还没准备好，稍等一下")
                    }
                }
            },
            endVoice: { cancel in
                // The lift is always recorded, also before the window opened (permission prompt, slow publish).
                guard let press = ui.voicePress else { return }
                ui.voicePress = nil
                let wasListening = ui.listening
                withAnimation(Yimi.Motion.component) { ui.listening = false }
                if cancel && wasListening { ui.show("已取消") }
                Task {
                    let committed = await conversation.endVoice(press: press, cancel: cancel)
                    if committed, ui.path.last != .chat { ui.path.append(.chat) }
                }
            }
        )
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func minimize() {
        ui.callAnchor = ui.callMode == .video ? UnitPoint(x: 0.86, y: 0.72) : UnitPoint(x: 0.5, y: 0.02)
        withAnimation(Yimi.Motion.page) { ui.callMinimized = true }
    }

    private func restore() {
        withAnimation(Yimi.Motion.page) { ui.callMinimized = false }
    }
}

/// What screens may ask for; one implementation, owned by the root.
struct YimiActions {
    var openCall: (YimiUIState.CallMode, UnitPoint) -> Void
    var minimizeCall: () -> Void
    var openChat: () -> Void
    var restoreCall: () -> Void
    var endCall: () -> Void
    var switchMode: () -> Void
    /// True once the session took the text (the composer may clear it).
    var send: (String) async -> Bool
    var beginVoice: () -> Void
    var endVoice: (_ cancel: Bool) -> Void
}

/// Hold-to-talk gesture shared by the home button and the chat bar: press to listen, slide up 90 pt to cancel,
/// release to send.
struct HoldToTalk: ViewModifier {
    @ObservedObject var ui: YimiUIState
    let actions: YimiActions
    @State private var pressing = false

    func body(content: Content) -> some View {
        content
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { value in
                    if !pressing { pressing = true; actions.beginVoice() }
                    let cancels = value.translation.height < -90
                    if cancels != ui.listeningCancels { withAnimation(Yimi.Motion.micro) { ui.listeningCancels = cancels } }
                }
                .onEnded { _ in
                    pressing = false
                    actions.endVoice(ui.listeningCancels)
                })
            .sensoryFeedback(.impact(weight: .medium), trigger: pressing)
    }
}

/// Full-screen listening surface: Klein blue while listening, grey once the finger slides up to cancel.
struct YimiListeningSurface: View {
    @ObservedObject var conversation: YimiConversation
    @ObservedObject var ui: YimiUIState

    var body: some View {
        ZStack {
            (ui.listeningCancels ? Yimi.cancel : Yimi.klein).ignoresSafeArea()
            VStack(spacing: 22) {
                Spacer()
                // The microphone opens on press; until central's window records, words would be lost.
                Text(!conversation.listeningText.isEmpty ? conversation.listeningText
                     : conversation.lastVoicePhase == .recording ? "依米在听…" : "准备中…")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(.white.opacity(conversation.listeningText.isEmpty ? 0.6 : 1))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                    .frame(minHeight: 110, alignment: .bottom)
                    .animation(Yimi.Motion.component, value: conversation.listeningText)
                WaveBars()
                Text(ui.listeningCancels ? "松开取消" : "松开发送 · 上滑取消")
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.78))
                Spacer().frame(height: 150)
            }
        }
        .animation(Yimi.Motion.component, value: ui.listeningCancels)
        .allowsHitTesting(false)
    }
}
