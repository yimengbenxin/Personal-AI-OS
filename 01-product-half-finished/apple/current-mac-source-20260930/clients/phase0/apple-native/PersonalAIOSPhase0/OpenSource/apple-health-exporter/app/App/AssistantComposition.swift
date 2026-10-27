import Combine
import Darwin
import Foundation
import LiveKit
import OSLog
import UIKit
#if canImport(WatchConnectivity)
import WatchConnectivity
#endif

#if DEBUG
private struct PhysicalCanaryRuntime {
    let bootstrap: any AssistantBootstrapProviding
    let realtime: any AssistantRealtimeTransporting
    let watchBinding: CyclingWatchOriginBinding?
    let startupWarning: String?

    static func make(
        videoTrackObserver: @escaping AssistantVideoTrackObserver
    ) -> PhysicalCanaryRuntime {
        let diagnostics = PhysicalCanaryDiagnostics()
        switch PhysicalCanaryProtectedInputFile
            .consumeFromApplicationContainer() {
        case .success(let configuration):
            diagnostics.record(.configurationAdmitted)
            let bootstrap = PhysicalCanaryBootstrapProvider(
                configuration: configuration,
                diagnostics: diagnostics
            )
            let encryption = PhysicalCanaryEncryptionProvider(
                keyData: configuration.e2eeKeyData,
                diagnostics: diagnostics
            )
            let roomOperator = SystemLiveKitRoomOperator(
                encryptionProvider: encryption,
                videoTrackObserver: videoTrackObserver
            )
            return PhysicalCanaryRuntime(
                bootstrap: bootstrap,
                realtime: LiveKitSessionAdapter(
                    roomOperator: roomOperator
                ),
                watchBinding: configuration.watchBinding,
                startupWarning: nil
            )
        case .failure(let error):
            switch error {
            case .missingInputCount(let count):
                diagnostics.record(.missingInputs(count))
            case .invalidInputCount(let count):
                diagnostics.record(.invalidInputs(count))
            }
            let roomOperator = SystemLiveKitRoomOperator(
                encryptionProvider:
                    UnavailableLiveKitEncryptionOptionsProvider(),
                videoTrackObserver: videoTrackObserver
            )
            return PhysicalCanaryRuntime(
                bootstrap: UnconfiguredAssistantBootstrapProvider(),
                realtime: LiveKitSessionAdapter(
                    roomOperator: roomOperator
                ),
                watchBinding: nil,
                startupWarning: error.countOnlyCode
            )
        }
    }
}
#endif

private final class AssistantWatchControlRelay:
    AssistantWatchControlSending, @unchecked Sendable {
    private let lock = NSLock()
    private weak var target: (any AssistantWatchControlSending)?

    func bind(_ target: any AssistantWatchControlSending) {
        lock.lock()
        self.target = target
        lock.unlock()
    }

    func sendCyclingControl(
        _ command: AssistantCyclingControlCommand
    ) async -> AssistantWatchControlDeliveryStatus {
        lock.lock()
        let current = target
        lock.unlock()
        guard let current else {
            return .unreachable
        }
        return await current.sendCyclingControl(command)
    }
}

@MainActor
final class AssistantComposition: ObservableObject {
    let viewModel: AssistantViewModel
    let localOperationDatabase: AssistantLocalOperationDatabase?
    private(set) var placeSensing: PlaceSensingService?
    private let locationService: LocationService
    private var protectedDataObserver: AnyCancellable?
    @Published private(set) var degradedReason: String?

#if canImport(WatchConnectivity)
    let watchAdapter: WatchConnectivityPhoneAdapter
    private var watchRelay: WatchRelay?
    private var watchCredentialLifecycle: WatchCredentialLifecycle?
    private var watchObservation: AnyCancellable?
    private var watchIdentityObservation: AnyCancellable?
    private var watchActivated = false
#endif

    init(
        canonicalRequestBodyProvider:
            (any RealtimeCanonicalRequestBodyProviding)? = nil
    ) {
        var localDatabase: AssistantLocalOperationDatabase?
        var warning: String?

        do {
            let url = try AssistantLocalOperationDatabase.defaultURL()
            localDatabase = try AssistantLocalOperationDatabase(url: url)
        } catch {
            warning = "local_operation_storage_unavailable"
        }

        let watchControlRelay = AssistantWatchControlRelay()
        let permissionProvider = MediaPermissionCoordinator()
        let locationService = LocationService()
        let videoPreviewModel = AssistantVideoPreviewModel()
        let videoTrackObserver: AssistantVideoTrackObserver = {
            [weak videoPreviewModel] update in
            videoPreviewModel?.update(update)
        }
        let resolvedCanonicalBodyProvider:
            any RealtimeCanonicalRequestBodyProviding =
                canonicalRequestBodyProvider
                ?? PairedRealtimeRequestBodyProvider()
        let pairingReady =
            canonicalRequestBodyProvider != nil
                || (resolvedCanonicalBodyProvider
                    as? PairedRealtimeRequestBodyProvider)?
                    .isReady == true

#if DEBUG && targetEnvironment(simulator)
        let bootstrap: any AssistantBootstrapProviding =
            AssistantLoopbackProvider()
        let realtime: any AssistantRealtimeTransporting =
            AssistantLoopbackRealtimeTransport()
        let cyclingWatchOriginBinding: CyclingWatchOriginBinding? = nil
#elseif DEBUG && os(iOS) && !targetEnvironment(simulator)
        let productionBootstrap =
            ProductionRealtimePublicControlProvider(
                settingsStore: UserDefaultsSettingsStore(),
                credentialStore: PairedRealtimeCredentialStore(),
                canonicalBodyProvider: resolvedCanonicalBodyProvider,
                pendingStopDatabase: localDatabase,
                requiresDurableStop: true
            )
        let bootstrap: any AssistantBootstrapProviding =
            productionBootstrap
        let roomOperator = SystemLiveKitRoomOperator(
            encryptionProvider:
                ProductionLiveKitEncryptionOptionsProvider(
                    control: productionBootstrap
                ),
            videoTrackObserver: videoTrackObserver
        )
        let realtime: any AssistantRealtimeTransporting =
            LiveKitSessionAdapter(roomOperator: roomOperator)
        // A formal watch is named only by a watch-binding receipt; an unpaired watch is a normal state.
        let cyclingWatchOriginBinding: CyclingWatchOriginBinding? = nil
        if !pairingReady {
            warning = warning ?? "device_not_paired"
        }
#elseif DEBUG
        let bootstrap: any AssistantBootstrapProviding =
            AssistantLoopbackProvider()
        let realtime: any AssistantRealtimeTransporting =
            AssistantLoopbackRealtimeTransport()
        let cyclingWatchOriginBinding: CyclingWatchOriginBinding? = nil
#else
        let productionBootstrap =
            ProductionRealtimePublicControlProvider(
                settingsStore: UserDefaultsSettingsStore(),
                credentialStore: PairedRealtimeCredentialStore(),
                canonicalBodyProvider: resolvedCanonicalBodyProvider,
                pendingStopDatabase: localDatabase,
                requiresDurableStop: true
            )
        let bootstrap: any AssistantBootstrapProviding =
            productionBootstrap
        let roomOperator = SystemLiveKitRoomOperator(
            encryptionProvider:
                ProductionLiveKitEncryptionOptionsProvider(
                    control: productionBootstrap
                ),
            videoTrackObserver: videoTrackObserver
        )
        let realtime: any AssistantRealtimeTransporting =
            LiveKitSessionAdapter(roomOperator: roomOperator)
        let cyclingWatchOriginBinding: CyclingWatchOriginBinding? = nil
        if !pairingReady {
            warning = warning ?? "device_not_paired"
        }
#endif

        let coordinator = AssistantSessionCoordinator(
            bootstrapProvider: bootstrap,
            realtime: realtime,
            mediaPermissions: permissionProvider,
            locationService: locationService,
            receipts: AppleReceiptStore(
                localPendingCache: localDatabase
            ),
            cyclingWatchOriginBinding: cyclingWatchOriginBinding,
            watchControl: watchControlRelay,
            moveSensors: MoveSessionSensors(),
            ringback: CallRingback(),
            artc: AliyunARTCCallClient(preview: videoPreviewModel),
            localDatabase: localDatabase
        )
        self.viewModel = AssistantViewModel(
            coordinator: coordinator,
            permissionProvider: permissionProvider,
            locationService: locationService,
            resultStreaming: AssistantResultStreamReducer(),
            mediaLifecycle: AssistantMediaLifecycle(),
            networkMonitor: NetworkPathMonitor(),
            notificationCenter: AssistantNotificationCenter(),
            videoPreviewModel: videoPreviewModel,
            startupWarning: warning
        )
        self.localOperationDatabase = localDatabase
        self.locationService = locationService
        self.degradedReason = warning

#if canImport(WatchConnectivity)
        let adapter = WatchConnectivityPhoneAdapter(sender: WCSession.default,
            metricHandler: { await coordinator.handleCyclingMetric($0) },
            pairingChangeHandler: { await coordinator.watchPairingChanged() },
            unreachableHandler: { await coordinator.watchBecameUnreachable() })
        self.watchAdapter = adapter
        watchControlRelay.bind(adapter)
#if os(iOS)
        let vm = self.viewModel
        let pairedBody = resolvedCanonicalBodyProvider as? PairedRealtimeRequestBodyProvider
        let production = bootstrap as? ProductionRealtimePublicControlProvider
        let lifecycle = production.map { provider in
            WatchCredentialLifecycle(provider: provider, deliver: { [weak self] authority, value in
                try await MainActor.run {
                    try self?.watchRelay?.projectBinding(authority, credential: value)
                    if value != nil, self?.degradedReason == "watch_credential_unavailable" { self?.degradedReason = nil }
                }
            }, onFailure: { [weak self] error in
                guard error as? WatchCredentialError != .staleAuthority else { return }
                await MainActor.run { self?.degradedReason = "watch_credential_unavailable" }
            })
        }
        self.watchCredentialLifecycle = lifecycle
        let relay = WatchRelay(sources: { [unowned vm] in
            let owner = vm.ownerProjectionIdentity
            return WatchRelaySources(ownerIdentity: (try? pairedBody?.pairing())?.userID,
                ownerPairingIdentity: owner, items: adapter.isReachable ? vm.conversation.watchItems : [],
                question: vm.questionCard, errands: vm.errands,
                care: vm.careCheckinIdentity == owner ? vm.careCheckins.last : nil,
                payments: vm.payment.cards,
                serverReachable: vm.sessionState.isActive, ride: vm.watchRideFeedback, rideMetrics: vm.watchRideMetrics,
                historyEpoch: vm.terminalState.historyEpoch)
        }, currentOwner: { principal, ownerPairing in
            guard let pairing = try? pairedBody?.pairing() else { return false }
            return principal == pairing.userID
                && ownerPairing == CentralOwnerDataIdentity.pairing(pairing)
                && RealtimePairingSessionIdentity.shared.matches(ownerPairing)
        },
           publish: {
               try adapter.publishYimiState($0, credential: $1)
               WatchAppearanceRelay.shared.project($0)
           },
           answerQuestion: { [unowned vm] in await vm.answerQuestion(cardID: $0, optionID: $1) },
           cancelErrand: { [unowned vm] in await vm.cancelErrand($0, identity: $1) },
           careSafe: { [unowned vm] in await vm.careSafe(identity: $0) },
           refreshCredential: {
               guard let lifecycle else { throw WatchCredentialError.staleAuthority }
               await lifecycle.refresh()
           }, isReachable: { adapter.isReachable })
        WatchAppearanceRelay.shared.attach(adapter)
        self.watchRelay = relay
        adapter.setActionHandler { [weak relay] in await relay?.handle($0) ?? false }
        adapter.setWorkoutSnapshotHandler { [weak relay] snapshot in
            let owner = RealtimePairingSessionIdentity.shared.snapshot()
            guard let identity = owner.identity,
                  await relay?.acceptsWorkoutSnapshot(snapshot.scope) == true,
                  RealtimePairingSessionIdentity.shared.snapshot() == owner else { return }
            await coordinator.handleCyclingWorkoutSnapshot(snapshot, identity: identity)
        }
        adapter.setActivationHandler { [weak self, weak lifecycle] in
            await MainActor.run { self?.refreshWatch(force: true) }
            await lifecycle?.synchronize()
        }
        adapter.setReachabilityHandler { [weak self] in
            await MainActor.run { self?.refreshWatch(force: true) }
        }
        watchObservation = relay.observe([
            vm.conversation.watchChanges,
            vm.watchSessionChanges,
            vm.$ownerProjectionIdentity.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            vm.$questionCard.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            vm.$errands.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            vm.$careCheckins.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            vm.$careCheckinIdentity.removeDuplicates().map { _ in () }.eraseToAnyPublisher(),
            vm.payment.$cards.map { $0.filter { $0.state.canDecide }.count }
                .removeDuplicates().map { _ in () }.eraseToAnyPublisher()
        ]) { [weak self] _ in self?.degradedReason = "watch_state_publication_failed" }
        watchIdentityObservation = NotificationCenter.default.publisher(for: RealtimePairingSessionIdentity.didChange)
            .receive(on: RunLoop.main).sink { [weak lifecycle] notification in
                guard let change = notification.userInfo?[RealtimePairingSessionIdentity.snapshotKey]
                    as? RealtimePairingSessionIdentity.Snapshot,
                      change == RealtimePairingSessionIdentity.shared.snapshot() else { return }
                Task {
                    guard change == RealtimePairingSessionIdentity.shared.snapshot() else { return }
                    await lifecycle?.suspend()
                    if change.identity != nil { await lifecycle?.synchronize() }
                }
            }
        if let production {
            Task {
                await production.bindWatchChannel(adapter)
                await production.setWatchCredentialObserver { [weak production, weak lifecycle] in
                    guard let production else { return }
                    if await production.watchBindingCanResolve() { await lifecycle?.synchronize() }
                    else { await lifecycle?.suspend() }
                }
            }
            self.viewModel.configureWatchBindingActions(register: {
                let receipt = try await production.registerWatchFromUserAction(using: adapter)
                await lifecycle?.synchronize()
                return "Watch 已登记（版本 " + receipt.pairVersion + "）"
            }, revoke: {
                await lifecycle?.suspend()
                let receipt = try await production.revokeWatchFromUserAction()
                await lifecycle?.invalidate()
                return "Watch 已撤销（版本 " + receipt.pairVersion + "）"
            })
        }
#endif
#endif
        locationService.onPlaceStateNeeded = { [weak self] in self?.restorePlaceSensing() }
        protectedDataObserver = NotificationCenter.default.publisher(for: UIApplication.protectedDataDidBecomeAvailableNotification)
            .receive(on: RunLoop.main).sink { [weak self] _ in self?.restorePlaceSensing() }
        restorePlaceSensing()
    }

#if canImport(WatchConnectivity)
    private func refreshWatch(force: Bool = false) {
        do { try watchRelay?.synchronize(force: force) }
        catch { degradedReason = "watch_state_publication_failed" }
    }

    func activateWatchIfNeeded() {
        guard !watchActivated else {
            return
        }
        watchActivated = true
        // WCSession activation can wait on simulator pairing; keep it off
        // the launch-critical scene transition while retaining the adapter.
        Task { @MainActor [weak self] in
            self?.watchAdapter.activate()
        }
    }
#endif

    /// Relaunched by a visit or region before the first unlock, the place state is unreadable: monitoring stays as the
    /// OS persisted it, and the service is built once the state can be read (unlock, or the next place callback).
    func restorePlaceSensing() {
        if placeSensing == nil {
            do {
                placeSensing = try PlaceSensingService(database: localOperationDatabase
                    ?? AssistantLocalOperationDatabase(url: AssistantLocalOperationDatabase.defaultURL()), location: locationService)
            } catch {
                Logger(subsystem: "ai.paios.personal.phase0", category: "places").error("Place state unreadable; monitoring left as is")
                return
            }
        }
        Task { [placeSensing] in await placeSensing?.flush(force: true) }
    }

    func flushPlaces() async -> Bool { await placeSensing?.flush() ?? true }

    static func makeViewModel() -> AssistantViewModel {
        AssistantComposition().viewModel
    }
}
