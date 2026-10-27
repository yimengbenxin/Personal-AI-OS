import LiveKit
import SwiftUI
import UIKit

/// Camera sharing and the paid avatar are separate controls on the same call.
struct YimiCallView: View {
    @ObservedObject var vm: AssistantViewModel
    @ObservedObject private var videoPreview: AssistantVideoPreviewModel
    @ObservedObject var conversation: YimiConversation
    @ObservedObject var ui: YimiUIState
    let actions: YimiActions
    @State private var selfFlip = 0.0
    @State private var swapped = false
    @State private var windowOffset = CGSize.zero
    @State private var windowScale: CGFloat = 1
    @GestureState private var windowDrag = CGSize.zero
    @GestureState private var windowMagnification: CGFloat = 1
    @State private var pendingPrice: AssistantAvatarPrice?
    @State private var showingPrice = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(vm: AssistantViewModel, conversation: YimiConversation, ui: YimiUIState, actions: YimiActions) {
        self.vm = vm
        self.videoPreview = vm.videoPreviewModel
        self.conversation = conversation
        self.ui = ui
        self.actions = actions
    }

    private var video: Bool { ui.callMode == .video }
    private var connecting: Bool { !(vm.call.isActive && vm.call.state == "live") }
    private var avatar: YimiCallAvatarPresentation {
        guard vm.call.avatarAllowed else { return .off }
        return YimiCallAvatarPresentation(requested: vm.videoCallRequested,
                                   firstFrame: vm.call.videoFrameRendered,
                                   failed: vm.componentVideoFailure)
    }
    private var failed: Bool { !vm.isDialing && (vm.callFailure != nil && !vm.componentVideoFailure || vm.call.state == "failed") }
    private var failureReason: String { vm.callFailure ?? vm.call.reason ?? "没接通，请重拨" }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 0) {
                    header
                    conversationControls.padding(.horizontal, 14).padding(.vertical, 10)
                    if video || vm.videoCallRequested && vm.call.avatarAllowed { videoStage.frame(height: geometry.size.height * 0.42) }
                    else { voiceStage }
                    muteStatus.padding(.horizontal, 14).padding(.bottom, 8)
                    avatarStatus.padding(.horizontal, 14).padding(.bottom, 10)
                    if let activity = vm.activities.last(where: { $0.card.state == .running }) ?? vm.activities.last {
                        YimiActivityPill(activity: activity).padding(.horizontal, 14).padding(.bottom, 12)
                    }
                    if vm.payment.available, let card = vm.payment.cards.first(where: { !$0.state.isTerminal }) ?? vm.payment.cards.first {
                        YimiPaymentCallBar(payment: vm.payment, card: card, onOpen: { actions.openChat() })
                            .padding(.horizontal, 14).padding(.bottom, 12)
                    }
                    ForEach(vm.voiceConfirmations) { item in
                        YimiConfirmCard(item: item, confirming: vm.confirmingVoice.contains(item.id) || vm.authenticatingVoice.contains(item.id)) { choice in
                            Task { if !(await vm.confirmVoice(item.id, choice: choice)) { ui.show(vm.lastError ?? "没确认上") } }
                        }
                        .padding(.horizontal, 14).padding(.bottom, 12)
                    }
                    captions.padding(.horizontal, 14).padding(.bottom, 18)
                    if failed {
                        Button("重拨") { actions.openCall(ui.callMode, .center) }
                            .font(.system(size: 17, weight: .semibold)).tint(Yimi.klein).padding(.bottom, 18)
                    }
                    controls.padding(.bottom, 18)
                }.frame(minHeight: geometry.size.height)
            }
        }
        .background(Yimi.ground.ignoresSafeArea())
        .task { await vm.refreshAppearance() }
        .animation(reduceMotion ? nil : Yimi.Motion.page, value: ui.callMode)
        .alert("打开数字人？", isPresented: $showingPrice) {
            Button("先不开", role: .cancel) { pendingPrice = nil }
                .accessibilityIdentifier("yimi.call.avatar.cancel")
            if pendingPrice != nil {
                Button("确认开启") {
                    guard let approved = pendingPrice, approved == vm.avatarPrice else {
                        ui.show("费用信息已变化，请重新确认")
                        pendingPrice = nil
                        return
                    }
                    pendingPrice = nil
                    Task { _ = await vm.setCallAvatarEnabled(true, confirmedQuote: approved) }
                }
                .disabled(connecting || vm.videoCallRequested || pendingPrice != vm.avatarPrice || !vm.call.avatarAllowed)
                .accessibilityIdentifier("yimi.call.avatar.confirm")
            }
        } message: {
            if let price = pendingPrice { Text("显示她的视频形象会产生费用。\n\(price.priceText)\n\(price.scopeText)") }
            else { Text("收费信息暂未取得，数字人保持关闭。你的镜头与声音继续。") }
        }
        .onChange(of: vm.callMuteState) { previous, current in
            if previous != current {
                UIAccessibility.post(notification: .announcement, argument: NSAttributedString(
                    string: current.announcementText, attributes: [.accessibilitySpeechQueueAnnouncement: true]))
            }
        }
        .onChange(of: vm.call.id) { _, _ in
            pendingPrice = nil; showingPrice = false; swapped = false
            windowOffset = .zero; windowScale = 1
        }
        .onChange(of: vm.videoCallRequested) { _, requested in
            if requested { swapped = false }
        }
        .onChange(of: vm.call.conversationMode) { _, mode in
            if mode == .thinking { pendingPrice = nil; showingPrice = false; swapped = false }
        }
    }

    // The media stage excludes subtitles and controls, so every clamped window stays clear of them.
    private var videoStage: some View {
        GeometryReader { geometry in
            let stage = geometry.size
            let frame = YimiCallWindowLayout.frame(in: stage,
                offset: CGSize(width: windowOffset.width + windowDrag.width, height: windowOffset.height + windowDrag.height),
                scale: windowScale * windowMagnification)
            let smallCamera = avatar == .on && !swapped
            ZStack(alignment: .topLeading) {
                Yimi.ground
                cameraCanvas
                    .frame(width: smallCamera ? frame.width : stage.width, height: smallCamera ? frame.height : stage.height)
                    .clipShape(RoundedRectangle(cornerRadius: smallCamera ? 18 : 0))
                    .position(smallCamera ? CGPoint(x: frame.midX, y: frame.midY) : CGPoint(x: stage.width / 2, y: stage.height / 2))
                    .zIndex(smallCamera ? 1 : 0)
                if vm.videoCallRequested && vm.call.avatarAllowed {
                    avatarCanvas
                        .frame(width: avatar == .on && swapped ? frame.width : stage.width,
                               height: avatar == .on && swapped ? frame.height : stage.height)
                        .clipShape(RoundedRectangle(cornerRadius: swapped ? 18 : 0))
                        .position(avatar == .on && swapped ? CGPoint(x: frame.midX, y: frame.midY) : CGPoint(x: stage.width / 2, y: stage.height / 2))
                        .opacity(avatar == .on ? 1 : 0.001)
                        .allowsHitTesting(false)
                        .zIndex(swapped ? 1 : 0)
                }
                if avatar == .on {
                    Color.clear.contentShape(Rectangle())
                        .frame(width: frame.width, height: frame.height)
                        .position(x: frame.midX, y: frame.midY)
                        .onTapGesture { swapped.toggle() }
                        .gesture(DragGesture(minimumDistance: 6)
                            .updating($windowDrag) { value, state, _ in state = value.translation }
                            .onEnded { value in
                                let result = YimiCallWindowLayout.frame(in: stage,
                                    offset: CGSize(width: windowOffset.width + value.translation.width, height: windowOffset.height + value.translation.height), scale: windowScale)
                                windowOffset = YimiCallWindowLayout.offset(for: result, in: stage)
                            })
                        .simultaneousGesture(MagnificationGesture()
                            .updating($windowMagnification) { value, state, _ in state = value }
                            .onEnded { windowScale = min(max(windowScale * $0, 0.8), 1.8) })
                        .accessibilityIdentifier("yimi.call.smallWindow")
                        .accessibilityLabel("小窗，点按交换大小画面")
                        .accessibilityHint("拖动移动，双指调整大小")
                        .accessibilityAddTraits(.isButton)
                        .accessibilityAction(named: "交换大小画面") { swapped.toggle() }
                        .accessibilityAdjustableAction { direction in
                            windowScale = min(max(windowScale + (direction == .increment ? 0.2 : -0.2), 0.8), 1.8)
                        }
                        .zIndex(2)
                }
            }.clipped()
        }
        .accessibilityIdentifier("yimi.call.videoStage")
    }

    private var avatarCanvas: some View {
        Group {
            if let view = videoPreview.artcRemoteView { ARTCVideoView(view: view) }
            else if let track = videoPreview.remoteVideoTrack { SwiftUIVideoView(track, layoutMode: .fill) }
            else { Color.clear }
        }
    }

    private var cameraCanvas: some View {
        ZStack(alignment: .bottomLeading) {
            if !vm.cameraEnabled { Yimi.ground }
            else if let view = videoPreview.artcLocalView { ARTCVideoView(view: view) }
            else if let track = videoPreview.localVideoTrack { SwiftUIVideoView(track, layoutMode: .fill) }
            else { Yimi.silhouette }
            Text(cameraLabel)
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(Yimi.ink)
                .padding(8).background(Yimi.surface.opacity(0.9), in: Capsule()).padding(12)
        }
        .rotation3DEffect(.degrees(selfFlip), axis: (0, 1, 0))
    }

    private var cameraLabel: String {
        guard vm.cameraEnabled else { return "镜头已关" }
        guard let camera = (videoPreview.localVideoTrack as? LocalVideoTrack)?.capturer as? CameraCapturer else { return "你的镜头" }
        return camera.position == .back ? "你面前 · 后置镜头" : "你 · 前置镜头"
    }

    private var muteStatus: some View {
        VStack(spacing: 6) {
            Text(vm.callMuteState.statusText).font(.system(size: 13, weight: .semibold))
                .accessibilityIdentifier("yimi.call.muteStatus")
                .accessibilityLabel(vm.callMuteState.announcementText)
            if vm.callMuteState == .failed {
                Text("你仍可能被听到").font(.system(size: 13)).foregroundStyle(Yimi.danger)
                HStack(spacing: 24) {
                    Button("重试静音") { Task { await vm.setMicrophoneEnabled(false) } }
                        .accessibilityIdentifier("yimi.call.retryMute")
                    Button("结束通话", role: .destructive, action: actions.endCall)
                        .accessibilityIdentifier("yimi.call.endAfterMuteFailure")
                }.font(.system(size: 15, weight: .semibold)).frame(minHeight: 44)
            }
        }.foregroundStyle(Yimi.ink2)
    }

    private var avatarStatus: some View {
        VStack(spacing: 4) {
            Text(vm.call.avatarAllowed ? avatar.label : "思考模式不提供数字人，镜头仍可使用").font(.footnote.weight(.semibold))
                .accessibilityIdentifier("yimi.call.avatarStatus")
            if vm.call.avatarAllowed && avatar == .waiting { Text("等待开启 · 她的画面正在准备，镜头与声音继续").font(.system(size: 13)) }
            if vm.call.avatarAllowed && avatar == .unavailable { Text("暂不可用 · 她的画面没接上，可在更多中重试或保持关闭").font(.system(size: 13)) }
        }.foregroundStyle(Yimi.ink2)
    }

    private var voiceStage: some View {
        ZStack {
            Yimi.ground.ignoresSafeArea()
            VStack(spacing: 22) {
                if vm.call.conversationMode == .thinking {
                    Image(systemName: "waveform").font(.system(size: 56)).foregroundStyle(Yimi.klein)
                        .frame(height: 196).accessibilityHidden(true)
                } else {
                    TimelineView(.animation(paused: reduceMotion)) { context in
                        let pulse = reduceMotion ? 0 : abs(sin(context.date.timeIntervalSinceReferenceDate * 2.2))
                        ZStack {
                            Circle().stroke(Yimi.tint2, lineWidth: 2)
                                .frame(width: 196, height: 196)
                                .scaleEffect(1 + pulse * 0.07)
                                .opacity(0.55 + pulse * 0.4)
                            YimiPortrait(breathes: !reduceMotion, snapshot: vm.callPortrait ?? .initial)
                                .frame(width: 168, height: 168)
                                .clipShape(Circle())
                        }
                    }
                }
                HStack(spacing: 8) {
                    LiveDot(size: 6)
                    VStack(spacing: 4) {
                        Text(vm.componentVideoFailure ? (vm.callFailure ?? "") : failed ? failureReason : connecting ? "正在接通…" : vm.voiceStatus.title)
                            .font(.system(size: 15)).foregroundStyle(Yimi.ink2)
                            .accessibilityIdentifier("yimi.voice.status")
                        Text(vm.voiceStatus.detail)
                            .font(.caption).foregroundStyle(Yimi.ink2)
                            .accessibilityIdentifier("yimi.voice.microphone")
                    }
                }
            }
            .padding(.vertical, 24)
        }
    }

    // MARK: chrome

    @ViewBuilder private var conversationControls: some View {
        if let mode = vm.call.conversationMode {
            VStack(spacing: 8) {
                Picker("通话模式", selection: Binding(get: { mode }, set: { selected in
                    Task { await vm.setCallConversationMode(selected) }
                })) {
                    Text(CallConversationMode.chat.label).tag(CallConversationMode.chat)
                        .accessibilityIdentifier("yimi.call.mode.chat")
                    Text(CallConversationMode.thinking.label).tag(CallConversationMode.thinking)
                        .accessibilityIdentifier("yimi.call.mode.thinking")
                }.pickerStyle(.segmented).frame(minHeight: 44)
                    .disabled(!vm.call.isActive || vm.call.pendingConversationMode != nil)
                    .accessibilityIdentifier("yimi.call.conversationMode")
                Text(mode.label).font(.caption).foregroundStyle(Yimi.ink2)
                    .accessibilityIdentifier("yimi.call.mode.confirmed")
                if let pending = vm.call.pendingConversationMode {
                    ViewThatFits(in: .horizontal) {
                        HStack { modePending(pending); modeResend }
                        VStack { modePending(pending); modeResend }
                    }
                }
                if let failure = vm.call.conversationModeFailure {
                    Text(failure).font(.callout).foregroundStyle(Yimi.danger)
                        .accessibilityIdentifier("yimi.call.mode.failure")
                }
                if let status = vm.call.thinkingStatus {
                    Text(status.text).font(.callout).foregroundStyle(Yimi.ink2)
                        .accessibilityIdentifier("yimi.call.thinking.status")
                    HStack {
                        if status.actions.contains("retry") {
                            Button(vm.call.thinkingRetryFailure != nil ? "重新发送重试" : vm.call.thinkingRetryPending ? "正在重试…" : "重试") {
                                Task { await vm.retryCallThinking() }
                            }.frame(minWidth: 44, minHeight: 44)
                                .disabled(!vm.call.canRetryThinking && vm.call.thinkingRetryFailure == nil)
                                .accessibilityIdentifier("yimi.call.thinking.retry")
                        }
                        if status.actions.contains("switch_to_chat") {
                            Button("切回聊天") { Task { await vm.setCallConversationMode(.chat) } }
                                .frame(minWidth: 44, minHeight: 44)
                                .disabled(vm.call.pendingConversationMode != nil)
                                .accessibilityIdentifier("yimi.call.thinking.switchToChat")
                        }
                    }.font(.body).tint(Yimi.klein)
                }
                if let failure = vm.call.thinkingRetryFailure {
                    Text(failure).font(.callout).foregroundStyle(Yimi.danger)
                        .accessibilityIdentifier("yimi.call.thinking.retryFailure")
                }
            }
        }
    }
    private func modePending(_ mode: CallConversationMode) -> some View {
        Text("正在切换到\(mode.label)…").font(.callout).foregroundStyle(Yimi.ink2)
            .accessibilityIdentifier("yimi.call.mode.pending")
    }
    private var modeResend: some View {
        Button("重新发送") { Task { await vm.resendCallConversationMode() } }
            .frame(minWidth: 44, minHeight: 44).tint(Yimi.klein)
            .accessibilityIdentifier("yimi.call.mode.resend")
    }

    private var header: some View {
        HStack {
            Button(action: actions.minimizeCall) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .background(video ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Yimi.paper), in: Circle())
            }
            .buttonStyle(PressScale())
            .foregroundStyle(Yimi.ink)
            .accessibilityLabel("收起通话")
            Spacer()
            VStack(spacing: 2) {
                HStack(spacing: 5) {
                    Image("YimMarkHeader").resizable().frame(width: 20, height: 20).accessibilityHidden(true)
                    Text("依米").font(.system(size: 17, weight: .semibold)).foregroundStyle(Yimi.ink)
                }
                Group { if failed { Text(failureReason) } else if connecting { Text("正在接通…") } else { CallClock(start: ui.callStartedAt) } }
                    .font(.system(size: 13).monospacedDigit()).foregroundStyle(Yimi.ink2)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("yimi.call.connection." + (vm.call.id ?? "pending"))
                    .accessibilityValue(connecting ? "未接通" : "已接通")
            }
            Spacer()
            Menu {
                Button(vm.call.avatarAllowed ? "数字人：" + avatar.optionState : "数字人：思考模式不可用") {
                    if vm.videoCallRequested { Task { _ = await vm.setCallAvatarEnabled(false) } }
                    else { pendingPrice = vm.avatarPrice; showingPrice = true }
                }.accessibilityIdentifier("yimi.call.avatarToggle")
                .accessibilityHint(vm.videoCallRequested ? "关闭她的画面，镜头和通话继续" : avatar == .unavailable ? "重试，开启前确认费用" : "打开前确认费用")
                .disabled(connecting || !vm.call.avatarAllowed)
                if avatar == .unavailable {
                    Button("保持关闭") { Task { _ = await vm.setCallAvatarEnabled(false) } }
                        .accessibilityIdentifier("yimi.call.keepAvatarOff")
                }
                if !vm.videoCallRequested {
                    Button("重新获取收费信息") { Task { await vm.refreshAppearance() } }
                        .accessibilityIdentifier("yimi.call.refreshAvatarPrice")
                }
                Button(vm.cameraEnabled ? "关闭镜头" : "打开镜头", action: actions.switchMode)
                    .accessibilityIdentifier("yimi.call.menu.camera")
                if video { Button("翻转镜头", action: flip).disabled(!vm.cameraEnabled).accessibilityIdentifier("yimi.call.menu.flipCamera") }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 20, weight: .semibold))
                    .frame(width: 44, height: 44).background(Yimi.paper, in: Circle())
            }
            .accessibilityLabel("更多通话选项")
            .accessibilityIdentifier("yimi.call.more")
        }
        .padding(.horizontal, 10).padding(.top, 6)
    }

    private var captions: some View {
        let lines = Array(conversation.callLines(vm.call.id).suffix(2))
        return Button(action: actions.openChat) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(lines) { line in
                    (Text(line.kind == .me ? "你：" : "依米：")
                        .foregroundStyle(line.kind == .me ? Yimi.ink2 : Yimi.klein)
                        .fontWeight(line.kind == .me ? .regular : .semibold)
                     + Text(YimiLongText.preview(line.text) ?? line.text).foregroundStyle(Yimi.ink))
                        .font(.system(size: 16)).lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Label("查看完整对话", systemImage: "chevron.right")
                    .font(.system(size: 12)).foregroundStyle(Yimi.ink2)
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(video ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(Yimi.paper),
                        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(PressScale())
        .accessibilityIdentifier("yimi.call.transcript")
        .accessibilityLabel("查看完整对话，通话继续")
        .animation(Yimi.Motion.component, value: lines)
    }

    private var controls: some View {
        HStack(alignment: .top) {
            control(vm.callMuteState == .confirmed ? "mic.slash" : "mic", title: vm.callMuteState.actionText,
                    on: vm.callMuteState == .confirmed, label: vm.callMuteState.actionText, identifier: "yimi.call.mute") {
                Task { await vm.setMicrophoneEnabled(vm.callMuteState == .confirmed) }
            }
            .disabled(connecting || (vm.callMuteState == .muting || vm.callMuteState == .unmuting))
            if video {
                control("camera.rotate", title: "翻转", label: "翻转镜头", identifier: "yimi.call.flipCamera", action: flip)
                    .disabled(connecting || !vm.cameraEnabled)
            }
            control("video", title: vm.cameraPhase == .opening ? "正在打开…" : vm.cameraEnabled ? "关摄像头" : "开视频", on: vm.cameraEnabled, label: "摄像头", identifier: "yimi.call.camera", action: actions.switchMode)
                .disabled(connecting)
            control("phone.down.fill", title: "挂断", tint: Yimi.danger, label: "挂断", identifier: "yimi.call.hangUp", action: actions.endCall)
        }
        .frame(maxWidth: .infinity)
    }

    private func control(_ icon: String, title: String, on: Bool = false, tint: Color? = nil, label: String, identifier: String,
                         action: @escaping () -> Void) -> some View {
        VStack(spacing: 8) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(tint != nil || on ? .white : Yimi.ink)
                    .frame(width: 62, height: 62)
                    .background(background(on: on, tint: tint), in: Circle())
            }
            .buttonStyle(PressScale())
            .accessibilityLabel(label)
            .accessibilityIdentifier(identifier)
            Text(title).font(.system(size: 12)).foregroundStyle(Yimi.ink2)
        }
        .frame(maxWidth: .infinity)
    }

    private func background(on: Bool, tint: Color?) -> AnyShapeStyle {
        if let tint { return AnyShapeStyle(tint) }
        if on { return AnyShapeStyle(Yimi.klein) }
        return video ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Yimi.paper)
    }

    /// Half-turn out, switch the camera, half-turn in. The label follows the camera that really switched.
    private func flip() {
        withAnimation(reduceMotion ? nil : .easeIn(duration: 0.17)) { selfFlip = reduceMotion ? 0 : 90 }
        Task {
            try? await Task.sleep(nanoseconds: 170_000_000)
            if vm.call.media != nil && vm.call.media?.audio_input != "gateway" {
                if await vm.switchARTCCamera() == nil { ui.show("镜头没翻过来") }
            } else if let camera = (videoPreview.localVideoTrack as? LocalVideoTrack)?.capturer as? CameraCapturer {
                do {
                    _ = try await camera.switchCameraPosition()
                } catch {
                    ui.show("镜头没翻过来")
                }
            } else {
                ui.show("摄像头还没打开")
            }
            selfFlip = reduceMotion ? 0 : -90
            withAnimation(reduceMotion ? nil : Yimi.Motion.component) { selfFlip = 0 }
        }
    }
}

/// mm:ss since the call started, ticking once a second.
struct CallClock: View {
    let start: Date
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(yimiClock(Int(context.date.timeIntervalSince(start))))
        }
    }
}

/// The call while minimised: an island at the top (both modes) and, for video, a PiP you can drag to either side.
/// Tapping either one brings the call back.
struct YimiMinimizedCall: View {
    @ObservedObject var vm: AssistantViewModel
    @ObservedObject private var videoPreview: AssistantVideoPreviewModel
    @ObservedObject var ui: YimiUIState
    var underNavigationBar = false
    let restore: () -> Void
    @State private var pipOffset = CGSize.zero
    @State private var drag = CGSize.zero
    @State private var onLeft = false

    init(vm: AssistantViewModel, ui: YimiUIState, underNavigationBar: Bool = false, restore: @escaping () -> Void) {
        self.vm = vm
        self.videoPreview = vm.videoPreviewModel
        self.ui = ui
        self.underNavigationBar = underNavigationBar
        self.restore = restore
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                Button(action: restore) {
                    HStack(spacing: 10) {
                        Circle().fill(Yimi.tint2).frame(width: 28, height: 28)
                        Image(systemName: vm.voiceStatus.symbol)
                        Group {
                            if !vm.isDialing && (vm.callFailure != nil && !vm.componentVideoFailure || vm.call.state == "failed") { Text("没接通 · 重拨") }
                            else if vm.call.state != "live" { Text("正在接通…") }
                            else { Text(vm.voiceStatus.compactTitle) }
                        }.font(.system(size: 14, weight: .semibold).monospacedDigit())
                    }
                    .foregroundStyle(.white)
                    .padding(.leading, 6).padding(.trailing, 14)
                    .frame(height: 40)
                    .background(Yimi.klein, in: Capsule())
                    .shadow(color: Yimi.klein.opacity(0.3), radius: 10, y: 6)
                }
                .buttonStyle(PressScale())
                .accessibilityLabel(ui.callMode == .video ? "回到视频通话" : "回到语音通话")
                .padding(.top, underNavigationBar ? 58 : 4)
                .animation(Yimi.Motion.component, value: underNavigationBar)
                .transition(.scale(scale: 0.3, anchor: .top).combined(with: .opacity))

                if ui.callMode == .video {
                    pip
                        .position(x: pipX(in: geo.size) + drag.width, y: geo.size.height - 250 + pipOffset.height + drag.height)
                        .gesture(DragGesture(minimumDistance: 6)
                            .onChanged { drag = $0.translation }
                            .onEnded { value in
                                let x = pipX(in: geo.size) + value.translation.width
                                pipOffset.height += value.translation.height
                                pipOffset.height = min(max(pipOffset.height, -(geo.size.height - 420)), 140)
                                drag = .zero
                                withAnimation(Yimi.Motion.snap) { onLeft = x < geo.size.width / 2 }
                            })
                        .onTapGesture(perform: restore)
                        .transition(.scale(scale: 0.7).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
    }

    private func pipX(in size: CGSize) -> CGFloat { onLeft ? 14 + 52 : size.width - 14 - 52 }

    private var pip: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
                if vm.videoCallRequested && vm.call.videoFrameRendered {
                    if let view = videoPreview.artcRemoteView { ARTCVideoView(view: view) }
                    else if let track = videoPreview.remoteVideoTrack { SwiftUIVideoView(track, layoutMode: .fill) }
                } else if vm.cameraEnabled {
                    if let view = videoPreview.artcLocalView { ARTCVideoView(view: view) }
                    else if let track = videoPreview.localVideoTrack { SwiftUIVideoView(track, layoutMode: .fill) }
                    else { Yimi.silhouette }
                } else { Yimi.ground }
            }
            Group {
                if !vm.isDialing && (vm.callFailure != nil && !vm.componentVideoFailure || vm.call.state == "failed") { Text("没接通") }
                else if vm.call.state != "live" { Text("正在接通…") }
                else { CallClock(start: ui.callStartedAt) }
            }
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .foregroundStyle(Yimi.ink)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(Yimi.surface.opacity(0.88), in: Capsule())
                .padding(8)
        }
        .frame(width: 104, height: 150)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Yimi.ground, lineWidth: 2))
        .shadow(color: .black.opacity(0.14), radius: 16, y: 10)
        .contentShape(Rectangle())
        .accessibilityLabel("回到视频通话")
        .accessibilityAddTraits(.isButton)
    }
}
