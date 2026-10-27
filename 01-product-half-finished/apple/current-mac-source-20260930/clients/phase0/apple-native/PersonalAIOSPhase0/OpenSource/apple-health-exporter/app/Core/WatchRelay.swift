import Combine
import Foundation

/// A snapshot of the existing phone owners, never a second conversation or action authority.
struct WatchRelaySources {
    let ownerIdentity: String?
    let ownerPairingIdentity: String?
    let items: [YimiItem]
    let question: CentralQuestion?
    let errands: [CentralErrand]
    let care: CentralAmbientReply?
    let payments: [CentralPaymentCard]
    let serverReachable: Bool
    var ride: CentralRideFeedback? = nil
    var rideMetrics: WatchYimiRideMetrics? = nil
    var historyEpoch: String? = nil

    func state(revision: UInt64, scope: WatchBindingScope?, currentOwner: (String?, String?) -> Bool) -> WatchYimiState {
        let link: WatchYimiLink = scope == nil ? .watch_unregistered : serverReachable ? .ok : .server_unreachable
        let current = scope != nil && currentOwner(ownerIdentity, ownerPairingIdentity)
        let item = current ? items.last(where: { $0.kind == .her }) : nil
        let latest = item.map { item in
            let message = AssistantNotificationMessage.assistantReply(identifier: item.id, text: item.text,
                privacy: item.privacy, locked: true, active: false)
            let text = AssistantNotificationCenter.content(for: message).body
            let kind: WatchYimiLatestKind = item.recordKind == .call ? .call : item.recordKind == .ambient ? .ambient : .message
            return WatchYimiLatest(card_id: item.id, title: "依米", lines: [String(text.prefix(600))],
                created_at: Self.timestamp(item.date), kind: kind)
        }
        let question = (current ? question : nil).map {
            WatchYimiQuestion(card_id: $0.id, question: $0.question, options: $0.options.map {
                WatchYimiOption(id: $0.id, label: $0.label, lines: $0.lines, recommended: $0.recommended)
            }, expires_at: $0.expiresAt)
        }
        let errands = (current ? errands : []).map { errand in
            return WatchYimiErrand(job_id: errand.id, title: errand.title, step: errand.step,
                max_steps: errand.maxSteps, state: WatchYimiErrandState(rawValue: errand.state)!,
                started_at: errand.startedAt.map(Self.timestamp))
        }
        let care = (current ? care : nil).map { WatchYimiCare(care_id: $0.id, text: $0.text) }
        let count = current ? payments.filter { $0.state.canDecide }.count : 0
        return WatchYimiState(version: 1, kind: "yimi_state", rev: revision, link: link, scope: scope,
            latest: latest, question: question, errands: errands, care: care,
            payment_pending: WatchYimiPaymentPending(count: count,
                summary: count == 0 ? "" : "有\(count)笔付款等你确认。" + AssistantNotificationCenter.watchPaymentReadOnlyBody),
            ride: current && (ride != nil || rideMetrics != nil) ? WatchYimiRide(
                hr_zone: ride?.hr_zone, text: ride?.text, max_hr_bpm: ride?.max_hr_bpm, metrics: rideMetrics, feedback_at: ride?.at) : nil,
            history_epoch: historyEpoch)
    }

    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}

/// Owns only the Watch publication revision and the identity captured with that publication.
@MainActor
final class WatchRelay {
    private let sources: () -> WatchRelaySources
    private let isReachable: () -> Bool
    private let currentOwner: (String?, String?) -> Bool
    private let publish: (Data?, Data?) throws -> Void
    private let answerQuestion: (String, String) async -> Bool
    private let cancelErrand: (String, String) async -> Bool
    private let careSafe: (String) async -> Bool
    private let refreshCredential: () async throws -> Void
    private let defaults: UserDefaults
    private var projected: WatchRelaySources?
    private var lastState: WatchYimiState?
    private var bindingResolved = false
    private var scope: WatchBindingScope?
    private var bindingOwner: String?
    private var bindingPairing: String?
    private var credential: WatchCredential?
    private static let revisionKey = "paios.watch.yimi-state-revision.v2"

    init(sources: @escaping () -> WatchRelaySources, currentOwner: @escaping (String?, String?) -> Bool,
         publish: @escaping (Data?, Data?) throws -> Void,
         answerQuestion: @escaping (String, String) async -> Bool,
         cancelErrand: @escaping (String, String) async -> Bool,
         careSafe: @escaping (String) async -> Bool,
         refreshCredential: @escaping () async throws -> Void,
         defaults: UserDefaults = .standard, isReachable: @escaping () -> Bool = { true }) {
        self.sources = sources; self.currentOwner = currentOwner; self.publish = publish
        self.isReachable = isReachable
        self.answerQuestion = answerQuestion; self.cancelErrand = cancelErrand; self.careSafe = careSafe
        self.refreshCredential = refreshCredential; self.defaults = defaults
    }

    func observe(_ inputs: [AnyPublisher<Void, Never>], onFailure: @escaping (Error) -> Void) -> AnyCancellable {
        Publishers.MergeMany(inputs)
            .throttle(for: .milliseconds(250), scheduler: RunLoop.main, latest: true).sink { [weak self] in
            do { try self?.synchronize() } catch { onFailure(error) }
        }
    }

    func acceptsWorkoutSnapshot(_ scope: WatchBindingScope) -> Bool {
        guard bindingResolved, self.scope == scope, currentOwner(bindingOwner, bindingPairing) else { return false }
        let source = sources()
        return source.ownerIdentity == bindingOwner && source.ownerPairingIdentity == bindingPairing
    }

    /// A validated server receipt prepares the scope before credential issue; a reply then supplies its token.
    func projectBinding(_ authority: WatchCredentialAuthority?, credential: WatchCredential?) throws {
        let scope = authority?.scope
        if let credential, !bindingResolved || credential.scope != scope || self.scope != scope
            || !currentOwner(authority?.principal, authority?.pairingIdentity) {
            throw WatchCredentialError.staleAuthority
        }
        bindingOwner = authority?.principal
        bindingPairing = authority?.pairingIdentity
        self.scope = scope; self.credential = credential; bindingResolved = true
        do { try synchronize(force: true) }
        catch { self.credential = nil; throw error }
    }

    func synchronize(force: Bool = false) throws {
        guard bindingResolved, force || isReachable() else { return }
        let source = sources()
        let bindingOwner = bindingOwner, bindingPairing = bindingPairing
        let eligible: (String?, String?) -> Bool = { [currentOwner] principal, pairing in
            principal == bindingOwner && pairing == bindingPairing && currentOwner(principal, pairing)
        }
        let comparison = source.state(revision: 0, scope: scope, currentOwner: eligible)
        guard force || lastState != comparison || projected?.ownerIdentity != source.ownerIdentity
            || projected?.ownerPairingIdentity != source.ownerPairingIdentity else { return }
        let previous = defaults.dictionary(forKey: Self.revisionKey)
        let sameScope = previous != nil && previous?["watch_device_id"] as? String == scope?.watch_device_id
            && previous?["pair_version"] as? String == scope?.pair_version
        let revision = sameScope ? ((previous?["rev"] as? NSNumber)?.uint64Value ?? 0) + 1 : 1
        let state = source.state(revision: revision, scope: scope, currentOwner: eligible)
        let data: Data
        do { data = try state.encodedStrict() }
        catch {
            projected = nil; lastState = nil
            try publish(nil, nil)
            throw error
        }
        // Persist before publication so relaunch never rolls the Watch's monotonic revision back.
        var record: [String: Any] = ["rev": revision]
        if let scope { record["watch_device_id"] = scope.watch_device_id; record["pair_version"] = scope.pair_version }
        defaults.set(record, forKey: Self.revisionKey)
        try publish(data, credential.map { try JSONEncoder().encode($0) })
        projected = source; lastState = comparison
    }

    func handle(_ envelope: WatchLocalEnvelope) async -> Bool {
        guard let action = envelope.action, let args = envelope.args else { return false }
        do {
            try args.validate(for: action)
            switch action {
            case .stateRequest:
                try synchronize(force: true); return true
            case .credentialRefresh:
                try await refreshCredential(); return true
            case .cardAnswer, .errandStop, .careSafe:
                guard let projected, let scope, lastState?.scope == scope,
                      let identity = projected.ownerIdentity, let pairing = projected.ownerPairingIdentity,
                      identity == bindingOwner, pairing == bindingPairing, currentOwner(identity, pairing) else { return false }
                let live = sources()
                guard live.ownerIdentity == identity, live.ownerPairingIdentity == pairing else { return false }
                switch action {
                case .cardAnswer:
                    guard args.card_id == projected.question?.id, args.card_id == live.question?.id,
                          let card = live.question, card.deadline > Date(),
                          let option = args.option_id, card.options.contains(where: { $0.id == option }) else { return false }
                    return await answerQuestion(card.id, option)
                case .errandStop:
                    guard let id = args.job_id, projected.errands.contains(where: { $0.id == id }),
                          live.errands.contains(where: { $0.id == id }) else { return false }
                    return await cancelErrand(id, pairing)
                case .careSafe:
                    guard let id = args.care_id, projected.care?.id == id, live.care?.id == id else { return false }
                    return await careSafe(pairing)
                default: return false
                }
            case .requestVoiceSession, .stopCurrentSession: return false
            }
        } catch { return false }
    }
}
