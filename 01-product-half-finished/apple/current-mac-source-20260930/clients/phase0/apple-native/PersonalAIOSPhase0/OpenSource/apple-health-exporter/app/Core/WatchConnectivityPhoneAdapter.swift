import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

protocol WatchPhoneConnectivitySending: AnyObject {
    var isActivated: Bool { get }
    func activate()
    var isReachable: Bool { get }
    var receivedApplicationContext: [String: Any] { get }
    var applicationContext: [String: Any] { get }
    func updateApplicationContext(_ applicationContext: [String: Any]) throws
    func sendMessage(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)?, errorHandler: ((Error) -> Void)?)
    func enqueueUserInfo(_ userInfo: [String: Any])
}
#if canImport(WatchConnectivity)
extension WCSession: WatchPhoneConnectivitySending {
    var isActivated: Bool { activationState == .activated }
    func enqueueUserInfo(_ userInfo: [String: Any]) { transferUserInfo(userInfo) }
}
#endif

/// Framing and delivery only. Business decisions belong to the injected action owner.
final class WatchConnectivityPhoneAdapter: NSObject, AssistantWatchControlSending, @unchecked Sendable {
    typealias ActionHandler = @Sendable (WatchLocalEnvelope) async -> Bool
    typealias TransferHintHandler = @Sendable (WatchLocalTransferHint) async -> Void
    typealias MetricHandler = WatchRideHandler.MetricHandler
    private let sender: any WatchPhoneConnectivitySending
    private let ledger: WatchLocalRequestLedger
    private let ride: WatchRideHandler
    private let deliveries = WatchLocalAsyncDeliveryChain()
    private let transferHintHandler: TransferHintHandler
    private let pairingChangeHandler: @Sendable () async -> Void
    private let unreachableHandler: @Sendable () async -> Void
    private let handlerLock = NSLock()
    private var appearanceReceiptHandler: @Sendable (Data) async -> Void = { _ in }
    private var actionHandler: ActionHandler
    private var workoutSnapshotHandler: @Sendable (WatchCyclingWorkoutSnapshot) async -> Void = { _ in }
    private var activationHandler: @Sendable () async -> Void = {}
    private var reachabilityHandler: @Sendable () async -> Void = {}
    private let contextLock = NSLock()
    private var context: [String: Any]
#if os(iOS)
    private let identity: WatchIdentityHandler
#endif
    init(sender: any WatchPhoneConnectivitySending,
         ledger: WatchLocalRequestLedger = WatchLocalRequestLedger(),
         actionHandler: @escaping ActionHandler = { _ in false },
         transferHintHandler: @escaping TransferHintHandler = { _ in },
         metricLedger: WatchCyclingMetricSequenceLedger = WatchCyclingMetricSequenceLedger(),
         metricHandler: @escaping MetricHandler = { _ in },
         pairingChangeHandler: @escaping @Sendable () async -> Void = {},
         unreachableHandler: @escaping @Sendable () async -> Void = {},
         controlSequence: WatchSenderSequence = WatchSenderSequence(key: "paios.phone.workout-control-sequence.v1", defaults: .standard, clock: { Date() })) {
        self.sender = sender; self.ledger = ledger
        self.actionHandler = actionHandler; self.transferHintHandler = transferHintHandler
        self.pairingChangeHandler = pairingChangeHandler; self.unreachableHandler = unreachableHandler
        context = sender.applicationContext
        ride = WatchRideHandler(sender: sender, ledger: metricLedger, handler: metricHandler, sequence: controlSequence)
#if os(iOS)
        identity = WatchIdentityHandler(sender: sender)
#endif
        super.init()
#if canImport(WatchConnectivity)
        (sender as? WCSession)?.delegate = self
#endif
    }
    func setWorkoutSnapshotHandler(_ handler: @escaping @Sendable (WatchCyclingWorkoutSnapshot) async -> Void) {
        handlerLock.withLock { workoutSnapshotHandler = handler }
    }
    private func receiveWorkoutSnapshot(_ context: [String: Any], resolved: Bool = false) {
        guard let stateData = contextLock.withLock({ self.context["yimi_state"] as? Data }),
              let state = try? WatchYimiState.decodeStrict(stateData), let scope = state.scope else { return }
        if !resolved {
            ride.recoverWorkout(context: context, scope: scope) { [weak self] data in
                self?.receiveWorkoutSnapshot([WatchCyclingWorkoutSnapshot.contextKey: data], resolved: true)
            }
            return
        }
        guard let bytes = context[WatchCyclingWorkoutSnapshot.contextKey] as? Data,
              let snapshot = try? WatchCyclingWorkoutSnapshot.decodeStrict(bytes), snapshot.scope == scope else { return }
        let handler = handlerLock.withLock { workoutSnapshotHandler }
        deliveries.enqueue { await handler(snapshot) }
    }
    func setActionHandler(_ handler: @escaping ActionHandler) { handlerLock.withLock { actionHandler = handler } }
    func setActivationHandler(_ handler: @escaping @Sendable () async -> Void) { handlerLock.withLock { activationHandler = handler } }
    var isReachable: Bool { sender.isActivated && sender.isReachable }
    func setReachabilityHandler(_ handler: @escaping @Sendable () async -> Void) {
        handlerLock.withLock { reachabilityHandler = handler }
    }
    func setAppearanceReceiptHandler(_ handler: @escaping @Sendable (Data) async -> Void) {
        handlerLock.withLock { appearanceReceiptHandler = handler }
    }
    private func publishContext(_ values: [String: Data?], liveKey: String) throws {
        try contextLock.withLock {
            var next = context
            for (key, value) in values { next[key] = value }
            try sender.updateApplicationContext(next); context = next
            if let data = values[liveKey] ?? nil, sender.isReachable {
                sender.sendMessage([liveKey: data], replyHandler: nil, errorHandler: nil)
            }
        }
    }
    func publishAppearance(_ data: Data?) throws {
        try publishContext(["yimi_appearance": data], liveKey: "yimi_appearance")
    }
    private func receiveAppearanceReceipt(_ message: [String: Any]) {
        guard let data = message["yimi_appearance_receipt"] as? Data else { return }
        let handler = handlerLock.withLock { appearanceReceiptHandler }
        deliveries.enqueue { await handler(data) }
    }
    func activate() { sender.activate() }
    func sendCyclingControl(_ command: AssistantCyclingControlCommand) async -> AssistantWatchControlDeliveryStatus {
        await ride.sendCyclingControl(command)
    }
    func publishYimiState(_ data: Data?, credential: Data?) throws {
        try publishContext(["yimi_state": data, "watch_credential": credential], liveKey: "yimi_state")
        // Binding publication can be the first authorized point after cold activation.
        receiveWorkoutSnapshot(sender.receivedApplicationContext)
    }
#if os(iOS)
    func requestInstallationIdentity(nonce: String, rebind: Bool = false) async -> WatchInstallationIdentityReply? {
        await identity.requestInstallationIdentity(nonce: nonce, rebind: rebind)
    }
    func closeInstallationIdentityChannel() { identity.closeInstallationIdentityChannel() }
    func setPhysicalReachabilityTimeoutForTests(_ value: UInt64) { identity.setPhysicalReachabilityTimeoutForTests(value) }
    func setInstallationIdentityContextDiagnosticHandlerForTests(_ handler: @escaping @Sendable (WatchInstallationIdentityContextDiagnostic) -> Void) {
        identity.setInstallationIdentityContextDiagnosticHandlerForTests(handler)
    }
#endif
    func activationChanged(isActivated: Bool, error: Error?) {
#if os(iOS)
        identity.activated(isActivated, error: error)
#endif
        if isActivated, error == nil {
            receiveApplicationContext(sender.receivedApplicationContext)
            let handler = handlerLock.withLock { activationHandler }
            deliveries.enqueue { await handler() }
        }
    }
    func pairingChanged() {
#if os(iOS)
        identity.pairingChanged()
#endif
        deliveries.enqueue { [self] in
            await ledger.clear(); await ride.clear(); await pairingChangeHandler()
        }
        sender.activate()
    }
    func reachabilityChanged() {
#if os(iOS)
        identity.reachabilityChanged()
#endif
        if !sender.isReachable { deliveries.enqueue { [unreachableHandler] in await unreachableHandler() } }
        else {
            receiveWorkoutSnapshot(sender.receivedApplicationContext)
            let handler = handlerLock.withLock { reachabilityHandler }
            deliveries.enqueue { await handler() }
        }
    }
    func receiveMessage(_ message: [String: Any], replyHandler: (([String: Any]) -> Void)? = nil) {
        receiveAppearanceReceipt(message)
        let data = message["payload"] as? Data
        deliveries.enqueue { [self] in
            if await ride.processMetricIfPresent(data) { replyHandler?([:]); return }
            let reply = await process(data)
            if let replyHandler { replyHandler(reply) }
            else if sender.isReachable { sender.sendMessage(reply, replyHandler: nil, errorHandler: nil) }
        }
    }
    func receiveApplicationContext(_ applicationContext: [String: Any]) {
        receiveAppearanceReceipt(applicationContext)
        receiveWorkoutSnapshot(applicationContext)
#if os(iOS)
        if identity.receiveContext(applicationContext) { return }
#endif
        let data = applicationContext["payload"] as? Data
        deliveries.enqueue { [ride] in _ = await ride.processMetricIfPresent(data) }
    }
    func receiveUserInfo(_ userInfo: [String: Any]) {
        guard let data = userInfo["payload"] as? Data else { return }
        if WatchRideHandler.declaresCyclingMetricKind(data) {
            deliveries.enqueue { [ride] in _ = await ride.processMetricIfPresent(data) }; return
        }
        if let hint = try? WatchLocalTransferHint.decodeStrict(data) { Task { [transferHintHandler] in await transferHintHandler(hint) } }
    }
    func waitForPendingDeliveries() async { await deliveries.waitUntilIdle() }
    private func process(_ data: Data?) async -> [String: Any] {
        guard let data, let request = try? WatchLocalEnvelope.decodeStrict(data), request.kind == .request,
              let action = request.action else { return message(.malformedAcknowledgement) }
        let status: WatchLocalAckStatus
        var detail: String?
        if action == .requestVoiceSession || action == .stopCurrentSession {
            status = .rejected; detail = "legacy_watch_call_disabled"
        } else {
            switch await ledger.classify(request) {
            case .new:
                let handler = handlerLock.withLock { actionHandler }
                status = await handler(request) ? .accepted : .rejected
            case .duplicate: status = .duplicate
            case .conflict: status = .conflict; detail = "request_id_reused_with_other_arguments"
            case .stale: status = .rejected; detail = "stale_or_out_of_order"
            }
        }
        return message(WatchLocalEnvelope(kind: .acknowledgement, action: action, requestID: request.requestID,
                                         sequence: request.sequence, status: status, detail: detail, version: request.version))
    }
    private func message(_ envelope: WatchLocalEnvelope) -> [String: Any] {
        guard let data = try? envelope.encodedStrict() else { return [:] }
        return ["payload": data]
    }
}
#if canImport(WatchConnectivity)
extension WatchConnectivityPhoneAdapter: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        activationChanged(isActivated: state == .activated, error: error)
    }
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { pairingChanged() }
    func sessionReachabilityDidChange(_ session: WCSession) { reachabilityChanged() }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        receiveMessage(message, replyHandler: replyHandler)
    }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { receiveMessage(message) }
    func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) { receiveApplicationContext(context) }
    func session(_ session: WCSession, didReceiveUserInfo info: [String: Any] = [:]) { receiveUserInfo(info) }
}
#endif
