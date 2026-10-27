import SwiftUI
import UIKit

/// Level 2: the whole conversation (typed, spoken, her replies, call records) with hold-to-talk or keyboard input.
struct YimiChatView: View {
    @ObservedObject var vm: AssistantViewModel
    @ObservedObject var conversation: YimiConversation
    @ObservedObject var ui: YimiUIState
    let actions: YimiActions
    @State private var paymentDetailID: String?
    @State private var fullText: YimiFullText?
    @State private var typing = false
    @State private var sending = false
    @State private var selectedCardID: String?
    @State private var showQwenInstructions = false
    @State private var decidingRecovery = false
    @State private var recoveringEventID: String?
    @State private var expandedCalls: Set<String> = []
    @State private var scroll = YimiChatScrollState(tracksHistoryGestures: true)
    @State private var window = YimiChatWindow()
    @State private var dragging = false
    @State private var historyDragBegan = false
    @State private var lastMetrics: YimiChatScrollState.Metrics?
    @State private var contentHeight: CGFloat = 0
    @FocusState private var focused: Bool

    private func updateScroll(_ metrics: YimiChatScrollState.Metrics) {
        if dragging, let previous = lastMetrics, metrics.top != previous.top,
           abs(metrics.height - previous.height) < 1, metrics.viewport == previous.viewport {
            let older = scroll.drag(towardHistory: metrics.top > previous.top, began: !historyDragBegan)
            historyDragBegan = true
            if older { loadOlder() }
        }
        lastMetrics = metrics
        if scroll.update(metrics) { loadOlder() }
        contentHeight = metrics.height
#if DEBUG
        ui.recordChatLayout()
#endif
    }

    private func updateScrollPhase(_ interacting: Bool) {
        if interacting {
            if !dragging { historyDragBegan = false }
            dragging = true
        } else if dragging {
            dragging = false
            if historyDragBegan { scroll.endDrag() }
        }
    }

    var body: some View {
        let all = conversation.chatItems
        let items = window.rows(all)
        let activityLayout = YimiActivityLayout(items: all, activities: vm.activities, consumer: vm.centralSnapshot)
        GeometryReader { geometry in
            ScrollViewReader { proxy in
            let viewport = geometry.size.height
            ScrollView {
                // Historical replies can contain tens of thousands of characters. Keep them out of eager layout.
                LazyVStack(spacing: 10) {
                    if items.isEmpty {
                        Text("和依米说点什么吧")
                            .font(.system(size: 14)).foregroundStyle(Yimi.ink3)
                            .padding(.top, 40)
                    }
                    ForEach(activityLayout.leading) { activity in
                        YimiActivityCard(activity: activity).padding(.trailing, 24)
                    }
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        VStack(spacing: 10) {
                            if showsDay(at: index, in: items) {
                                Text(item.date, format: .dateTime.month().day().hour().minute())
                                    .font(.system(size: 12)).foregroundStyle(Yimi.ink3).padding(.vertical, 4)
                            }
                            row(item)
                            ForEach(activityLayout.under[item.id] ?? []) { activity in
                                YimiActivityCard(activity: activity, collapsed: activity.collapsed(replyProcessedIDs: activityLayout.replyProcessedIDs))
                                    .padding(.trailing, 24)
                            }
                            .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                        }
                        .id(item.id)
                    }
                    if let outcome = vm.careOutcome { Text(outcome).font(.system(size: 13)).foregroundStyle(Yimi.ink3) }
                    if vm.typedRecoveryNeedsDecision {
                        Button("这件事的结果不确定 · 请求停下") {
                            recoveringEventID = vm.typedRecoveryEventID; decidingRecovery = true
                        }
                            .font(.system(size: 14, weight: .medium)).tint(Yimi.klein)
                    } else if let recovery = vm.typedRecoveryStatus {
                        Text(recovery).font(.system(size: 13)).foregroundStyle(Yimi.ink3)
                    }
                    if vm.payment.available {
                        ForEach(vm.payment.cards) { card in
                            YimiPaymentCard(payment: vm.payment, card: card, onDetails: { paymentDetailID = card.id })
                        }
                        ForEach(vm.payment.approvals) { approval in YimiPaymentApprovalCard(payment: vm.payment, approval: approval) }
                        if let error = vm.payment.error { Text(error).font(.system(size: 13)).foregroundStyle(Yimi.danger) }
                    }
                    ForEach(vm.voiceConfirmations) { item in
                        YimiConfirmCard(item: item, confirming: vm.confirmingVoice.contains(item.id) || vm.authenticatingVoice.contains(item.id)) { choice in
                            Task { if !(await vm.confirmVoice(item.id, choice: choice)) { ui.show(vm.lastError ?? "没确认上") } }
                        }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if let card = vm.questionCard {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            if card.deadline > context.date {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text(card.question ?? "请选择").font(.system(size: 16, weight: .semibold)).foregroundStyle(Yimi.ink)
                                    ForEach(card.options) { option in
                                        Button {
                                            guard !sending, card.deadline > Date() else { return }
                                            sending = true
                                            Task {
                                                if await vm.answerQuestion(cardID: card.id, optionID: option.id) { selectedCardID = card.id }
                                                sending = false
                                            }
                                        } label: {
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(option.label + (option.recommended ? " · 推荐" : "")).font(.system(size: 15, weight: .semibold))
                                                ForEach(option.lines.indices, id: \.self) { Text(option.lines[$0]).font(.system(size: 14)).foregroundStyle(Yimi.ink2) }
                                            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                        }
                                        .buttonStyle(.plain).foregroundStyle(Yimi.klein)
                                        .disabled(sending || selectedCardID == card.id || !vm.canAcceptPrompt)
                                    }
                                    Button("去千问里自己看") { showQwenInstructions.toggle() }.tint(Yimi.klein)
                                    if showQwenInstructions {
                                        Text("请手动打开千问，登录执行手机的同一账号，进入「生活帮手」的同一对话查看店铺卡片。")
                                            .font(.system(size: 14)).foregroundStyle(Yimi.ink2)
                                    }
                                    if selectedCardID == card.id { Text("已告诉依米你的选择").font(.system(size: 13)).foregroundStyle(Yimi.ink2) }
                                }
                                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                                .background(Yimi.surface, in: RoundedRectangle(cornerRadius: Yimi.Radius.card))
                            }
                        }
                        .id(card.id)
                    }
                    if vm.promptState == .submitting || vm.promptState == .partial, conversation.last?.kind == .me {
                        TypingDots().frame(maxWidth: .infinity, alignment: .leading)
                            .transition(.opacity)
                    }
                    Color.clear.frame(height: 1).id(latestMarkerID)
                }
                .padding(.horizontal, 14).padding(.vertical, 14)
                .frame(minHeight: viewport, alignment: .bottom)
                .animation(Yimi.Motion.component, value: vm.voiceConfirmations)
                .onGeometryChange(for: YimiChatScrollState.Metrics.self) { content in
                    let frame = content.frame(in: .named("chat"))
                    return .init(top: frame.minY, bottom: frame.maxY, viewport: viewport)
                } action: { updateScroll($0) }
            }
            .defaultScrollAnchor(.bottom)
            .coordinateSpace(name: "chat")
            .accessibilityIdentifier("yimi.chat.history")
#if DEBUG
            .accessibilityValue(ui.chatOpenLayoutSeconds.map { String($0) } ?? "")
#endif
            // Observe the scroll view's own pan; another DragGesture competes with native swipe-back.
            .modifier(YimiHistoryTracking(phaseChanged: updateScrollPhase, dragged: { towardHistory, began in
                if scroll.drag(towardHistory: towardHistory, began: began) { loadOlder() }
            }, ended: { scroll.endDrag() }))
            .onAppear { scrollToRequest(proxy) }
            .onChange(of: vm.notificationOpenRevision) { _, _ in scrollToRequest(proxy) }
            .onChange(of: ui.chatScrollRequest) { _, _ in scrollToRequest(proxy) }
            // A sliding history window can append equal-height rows. Follow both identity and size changes
            // while pinned; reading older history keeps its position.
            .onChange(of: contentHeight) { _, _ in followLatest(proxy) }
            .onChange(of: viewport) { _, _ in followLatest(proxy) }
            .onChange(of: focused) { _, _ in followLatest(proxy) }
            .onChange(of: items.last?.id) { _, _ in followLatest(proxy) }
            .onChange(of: conversation.sendRevision) { _, _ in showLatest(proxy) }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Yimi.paper)
        .safeAreaInset(edge: .bottom) { composer }
        .sheet(isPresented: Binding(get: { paymentDetailID != nil }, set: { if !$0 { paymentDetailID = nil } })) {
            if let id = paymentDetailID { YimiPaymentDetailSheet(payment: vm.payment, paymentID: id) }
        }
        .sheet(item: $fullText) { YimiFullTextPage(text: $0.text) }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    HStack(spacing: 5) {
                        Image("YimMarkHeader").resizable().frame(width: 20, height: 20).accessibilityHidden(true)
                        Text("依米").font(.system(size: 17, weight: .semibold))
                    }
                    HStack(spacing: 5) {
                        LiveDot(size: 6)
                        Text(status).font(.system(size: 12)).foregroundStyle(Yimi.ink2)
                    }
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { actions.openCall(.voice, UnitPoint(x: 0.8, y: 0.05)) } label: { Image(systemName: "phone") }
                    .accessibilityLabel("语音通话")
                Button { actions.openCall(.video, UnitPoint(x: 0.92, y: 0.05)) } label: { Image(systemName: "video") }
                    .accessibilityLabel("视频通话")
            }
        }
        .onAppear {
            conversation.chatVisible = !ui.callOpen || ui.callMinimized
            if !vm.promptText.isEmpty { typing = true }
        }
        .onChange(of: ui.callOpen && !ui.callMinimized) { _, covered in conversation.chatVisible = !covered }
        .onDisappear { conversation.chatVisible = false; ui.chatCallID = nil }
        .confirmationDialog("请求依米停下这件事", isPresented: $decidingRecovery, titleVisibility: .visible) {
            Button("请求依米停下", role: .destructive) {
                if let id = recoveringEventID { Task { await vm.requestCentralControl("cancel_run", eventID: id) } }
            }
        } message: {
            Text("依米会请求停止。已经执行的操作不会撤销，停止也要等确认。")
        }
    }

    private var status: String {
        if vm.call.isActive { return "通话中" }
        switch vm.promptState {
        case .submitting, .partial: return "正在想…"
        default: return "在呢"
        }
    }

    private func showsDay(at index: Int, in items: [YimiItem]) -> Bool {
        guard index > 0 else { return true }
        return items[index].date.timeIntervalSince(items[index - 1].date) > 15 * 60
    }

    private func loadOlder() {
        guard window.older(loaded: conversation.chatItems.count) else { return }
        if let seq = conversation.chatItems.compactMap(\.seq).min() {
            Task { await vm.olderTimeline(before: seq) }
        }
    }

    private func scrollToRequest(_ proxy: ScrollViewProxy) {
        if let url = vm.notificationOpenURL,
           let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath,
           let id = String(path.dropFirst()).removingPercentEncoding {
            scroll.readingHistory()
            proxy.scrollTo(url.host == "care" ? "her-" + id : id, anchor: .center)
        } else if let callID = ui.chatCallID {
            let id = "call-" + callID
            expandedCalls.insert(id)
            scroll.readingHistory()
            proxy.scrollTo(id, anchor: .top)
        } else {
            showLatest(proxy)
        }
    }

    private var latestMarkerID: String { "latest-" + (conversation.chatItems.last?.id ?? "empty") }

    private func showLatest(_ proxy: ScrollViewProxy) {
        scroll.showLatest()
        proxy.scrollTo(latestMarkerID, anchor: .bottom)
    }

    private func followLatest(_ proxy: ScrollViewProxy) {
        // Reposition after size changes even when the newest row identity is unchanged.
        if scroll.pinned { proxy.scrollTo(latestMarkerID, anchor: .bottom) }
    }

    @ViewBuilder
    private func row(_ item: YimiItem) -> some View {
        switch item.kind {
        case .me:
            VStack(alignment: .trailing, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    if item.isVoiceInput { Image(systemName: "mic.fill").font(.system(size: 12)).accessibilityLabel("语音") }
                    YimiBoundedText(text: item.text) { fullText = YimiFullText(id: item.id, text: item.text) }
                }
                    .font(.system(size: 16)).foregroundStyle(Yimi.ground)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Yimi.klein, in: BubbleShape(mine: true))
                    .frame(maxWidth: 300, alignment: .trailing)
                    .textSelection(.enabled)
                if let attachments = item.attachments {
                    ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
                        Label(attachment.name, systemImage: "doc").font(.caption).padding(6)
                            .background(Yimi.surface, in: RoundedRectangle(cornerRadius: 6))
                    }
                }
                deliveryNote(item)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .her:
            VStack(alignment: .leading, spacing: 4) {
                let content = item.replyContent
                VStack(alignment: .leading, spacing: 10) {
                    if let qr = content.qr {
                        let image = UIImage(cgImage: qr)
                        Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
                            .frame(maxWidth: 260).accessibilityLabel("依米发来的二维码")
                        ShareLink(item: Image(uiImage: image), preview: SharePreview("依米的二维码", image: Image(uiImage: image))) {
                            Label("分享/保存二维码", systemImage: "square.and.arrow.up")
                        }.font(.system(size: 14)).tint(Yimi.klein)
                    }
                    if !content.text.isEmpty {
                        YimiBoundedText(text: content.text) { fullText = YimiFullText(id: item.id, text: content.text) }
                    }
                }
                    .font(.system(size: 16)).foregroundStyle(Yimi.ink)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Yimi.surface, in: BubbleShape(mine: false))
                    .frame(maxWidth: 300, alignment: .leading)
                    .textSelection(.enabled)
                deliveryNote(item)
                if let identity = vm.careCheckinIdentity, vm.careCheckins.contains(where: { "her-" + $0.id == item.id }) {
                    Button(vm.careAnswering ? "正在告诉依米…" : "我没事") {
                        Task { if !(await vm.careSafe(identity: identity)) { ui.show(vm.lastError ?? "还没告诉依米，请重试") } }
                    }.disabled(vm.careAnswering).font(.system(size: 14, weight: .medium)).tint(Yimi.klein)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        case .call:
            // Only the call the session holds right now is live; a record whose call ended unseen (app closed, session
            // reset, gateway restart) is history, never "通话中".
            CallRecordCard(item: item, lines: conversation.callLines(String(item.id.dropFirst("call-".count))),
                live: vm.call.isActive && vm.call.id.map { "call-" + $0 } == item.id,
                expanded: Binding(get: { expandedCalls.contains(item.id) }, set: { expanded in
                    if expanded { expandedCalls.insert(item.id) } else { expandedCalls.remove(item.id) }
                }), openFull: { fullText = YimiFullText(id: $0.id, text: $0.text) })
        }
    }

    /// A request that failed or whose delivery is unknown says so and can be sent again as text (an unknown one may
    /// have arrived, so the resend may duplicate it). A request heard in 随身模式 is marked as such.
    @ViewBuilder
    private func deliveryNote(_ item: YimiItem) -> some View {
        if item.recordKind == .ambient {
            Text("来自随身对话").font(.system(size: 12)).foregroundStyle(Yimi.ink3)
        }
        switch item.delivery {
        case .unconfirmed, .failed:
            let failed = item.delivery == .failed
            Text(item.deliveryStatus ?? "").font(.system(size: 12)).foregroundStyle(failed ? Yimi.danger : Yimi.ink3)
            if conversation.canResend(item) {
                Button { Task { if await actions.send(item.text) { conversation.resent(item) } } } label: {
                    Text(failed ? "重发这段文字" : "重发这段文字（如已送达会重复）").font(.system(size: 12, weight: .medium)).foregroundStyle(Yimi.klein)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("yimi.voice.retry")
            }
        case .sending:
            if item.isQueued {
                Text(item.deliveryStatus ?? "").font(.system(size: 12)).foregroundStyle(Yimi.ink3)
                    .accessibilityIdentifier("yimi.message.queued")
            }
        case .none:
            EmptyView()
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            Button {
                typing.toggle()
                focused = typing
            } label: {
                Image(systemName: typing ? "mic" : "keyboard")
                    .font(.system(size: 20, weight: .medium))
                    .frame(width: 44, height: 44)
                    .foregroundStyle(Yimi.ink)
            }
            .accessibilityLabel(typing ? "切换到语音" : "切换到键盘")
            if typing {
                TextField("", text: $vm.promptText, prompt: Text("跟依米说…").foregroundStyle(Yimi.ink2), axis: .vertical)
                    .lineLimit(1...4)
                    .focused($focused)
                    .foregroundStyle(Yimi.ink)
                    .tint(Yimi.klein)
                    .accessibilityIdentifier("yimi.input")
                    .submitLabel(.return)
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .background(Yimi.paper, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .transition(.opacity)
                if !vm.promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(action: sendDraft) {
                        Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 36, height: 36).background(Yimi.klein, in: Circle())
                    }
                    .buttonStyle(PressScale())
                    .accessibilityLabel("发送")
                    .transition(.scale.combined(with: .opacity))
                }
            } else {
                Text(ui.listening ? "松开 发送" : "按住 说话")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(ui.listening ? .white : Yimi.ink)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(ui.listening ? Yimi.klein : Yimi.paper, in: Capsule())
                    .contentShape(Capsule())
                    .modifier(HoldToTalk(ui: ui, actions: actions))
                    .accessibilityLabel("按住说话")
                    .accessibilityAddTraits(.isButton)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(.bar)
        .animation(Yimi.Motion.component, value: vm.promptText.isEmpty)
    }

    /// The draft stays until the session took it; a refused send keeps the words for another try.
    private func sendDraft() {
        let text = vm.promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        Task {
            let taken = await actions.send(text)
            sending = false
            if taken, vm.promptText.trimmingCharacters(in: .whitespacesAndNewlines) == text { vm.promptText = "" }
        }
    }
}

/// A message body bounded for chat layout (YimiLongText): a long one shows its prefix and a link to the whole text.
struct YimiBoundedText: View {
    let text: String
    let openFull: () -> Void

    var body: some View {
        if let preview = YimiLongText.preview(text) {
            VStack(alignment: .leading, spacing: 8) {
                Text(preview)
                Button(action: openFull) { Text("查看全文").fontWeight(.semibold).underline() }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("yimi.message.fullText")
            }
        } else {
            Text(text)
        }
    }
}

struct YimiFullText: Identifiable {
    let id: String
    let text: String
}

/// The whole of a long message on its own page. UITextView lays out only what is on screen, so the length costs
/// nothing up front, and the text stays selectable.
struct YimiFullTextPage: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            YimiTextReader(text: text)
                .background(Yimi.paper)
                .navigationTitle("全文")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

private struct YimiTextReader: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = UIColor(Yimi.ink)
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 16, left: 14, bottom: 32, right: 14)
        view.accessibilityIdentifier = "yimi.message.fullText.page"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
    }
}

/// Chat bubble with a tightened corner toward its sender.
struct BubbleShape: Shape {
    let mine: Bool
    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: mine ? 20 : 6,
                               bottomTrailingRadius: mine ? 6 : 20, topTrailingRadius: 20, style: .continuous)
            .path(in: rect)
    }
}

/// One folded manual call; its transcript is read from the shared timeline.
struct CallRecordCard: View {
    let item: YimiItem
    let lines: [YimiItem]
    /// Whether this is the session's current live call (the one authority on a call being in progress).
    let live: Bool
    @Binding var expanded: Bool
    let openFull: (YimiItem) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation(Yimi.Motion.component) { expanded.toggle() } } label: {
                HStack {
                    Image(systemName: "phone.fill").font(.system(size: 13)).foregroundStyle(Yimi.klein)
                    Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Yimi.ink)
                    if live { CallClock(start: item.date).font(.system(size: 13).monospacedDigit()).foregroundStyle(Yimi.ink2) }
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(Yimi.ink3)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }.frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(title + (expanded ? "，收起对话" : "，展开对话"))
            .accessibilityIdentifier("yimi.call.record." + item.id)
            .accessibilityValue(live ? "通话中" : "已结束")
            ForEach(expanded ? lines : Array(lines.suffix(2))) { line in
                HStack(alignment: .top, spacing: 6) {
                    Text(line.role == "user" ? "你" : line.role == "main_agent" ? "依米·补充" : "依米")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(line.kind == .me ? Yimi.ink2 : Yimi.klein)
                    YimiBoundedText(text: line.text) { openFull(line) }
                        .font(.system(size: 14)).foregroundStyle(Yimi.ink).textSelection(.enabled)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Yimi.surface, in: RoundedRectangle(cornerRadius: Yimi.Radius.card, style: .continuous))
    }

    private var title: String {
        if live { return "通话中" }
        guard let end = item.endedAt else { return "通话" } // ended without its end being seen: no duration to show
        return "通话 " + yimiClock(Int(end.timeIntervalSince(item.date)))
    }
}

/// "依米 is typing" while a request is in flight.
struct TypingDots: View {
    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    Circle().fill(Yimi.ink3).frame(width: 7, height: 7)
                        .opacity(0.35 + 0.65 * max(0, sin(t * 5.5 - Double(i) * 0.9)))
                        .offset(y: -3 * max(0, sin(t * 5.5 - Double(i) * 0.9)))
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .background(Yimi.surface, in: BubbleShape(mine: false))
        }
        .accessibilityLabel("依米正在输入")
    }
}

/// One pending "确认是我": what was heard, how long it can still be answered, and the tap. It disappears when it
/// expires (and when central's next snapshot no longer lists it).
struct YimiConfirmCard: View {
    let item: CentralVoiceConfirmation
    let confirming: Bool
    let confirm: (CentralVoiceConfirmationChoice?) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = Int(item.deadline.timeIntervalSince(context.date).rounded(.up))
            if left > 0 {
                HStack(spacing: 12) {
                    Image(systemName: item.isNativeApproval ? "hand.raised" : "person.wave.2").font(.system(size: 19, weight: .medium)).foregroundStyle(Yimi.klein)
                        .frame(width: 40, height: 40).background(Yimi.surface, in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        if item.isNativeApproval {
                            Text(item.text ?? "").font(.system(size: 15, weight: .semibold)).foregroundStyle(Yimi.ink)
                        } else {
                            Text("刚才这句不太确定是你说的").font(.system(size: 15, weight: .semibold)).foregroundStyle(Yimi.ink)
                            Text("确认时需要 Face ID").font(.system(size: 12)).foregroundStyle(Yimi.ink3)
                        }
                        if !item.isNativeApproval, let text = item.text, !text.isEmpty {
                            Text("「" + text + "」").font(.system(size: 13)).foregroundStyle(Yimi.ink2).lineLimit(2)
                        }
                        Text("\(left) 秒内可确认").font(.system(size: 12).monospacedDigit()).foregroundStyle(Yimi.ink3)
                    }
                    Spacer(minLength: 0)
                    if item.isNativeApproval {
                        VStack(spacing: 8) {
                            Button("同意") { confirm(.approve) }
                            Button("不允许") { confirm(.deny) }
                        }
                        .buttonStyle(.bordered).disabled(confirming)
                    } else {
                        Button { confirm(nil) } label: {
                            ZStack {
                                Text("确认是我").opacity(confirming ? 0 : 1)
                                if confirming { ProgressView().tint(.white) }
                            }
                            .font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 14).frame(height: 34)
                            .background(Yimi.klein, in: Capsule())
                        }
                        .buttonStyle(PressScale())
                        .disabled(confirming)
                        .accessibilityLabel("确认是我说的")
                        .accessibilityIdentifier("voice-identity-confirm-" + item.id)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(Yimi.tint, in: RoundedRectangle(cornerRadius: Yimi.Radius.card, style: .continuous))
            }
        }
    }
}

struct YimiCareCard: View {
    let item: CentralAmbientReply
    let answering: Bool
    let answer: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(item.text)
            Button(answering ? "正在告诉依米…" : "我没事", action: answer).disabled(answering)
        }.padding(14).background(Yimi.tint, in: RoundedRectangle(cornerRadius: Yimi.Radius.card))
    }
}

/// iOS 18 reports scrolling directly. Earlier releases need the existing gesture observation.
private struct YimiHistoryTracking: ViewModifier {
    let phaseChanged: (Bool) -> Void
    let dragged: (Bool, Bool) -> Void
    let ended: () -> Void
    @State private var dragging = false

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollPhaseChange { _, phase in
                phaseChanged(phase == .interacting)
            }
        } else {
            content.simultaneousGesture(DragGesture().onChanged { value in
                dragged(value.translation.height > abs(value.translation.width), !dragging)
                dragging = true
            }.onEnded { _ in
                dragging = false
                ended()
            })
        }
    }
}
