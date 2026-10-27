import Foundation

/// The public display snapshot. The server owns task state and completion decisions.
struct CentralActivityUpdate: Codable, Equatable, Sendable {
    let operation: String
    let session_id: String
    let processed_event_id: String
    let card: CentralActivityCard
}

struct CentralActivityProgress: Codable, Equatable, Sendable {
    let version: Int
    let value: Double
    let total: Double
    var accessibilityLabel: String { "进度 " + (value / total).formatted(.percent.precision(.fractionLength(0))) }
}

struct CentralActivityCard: Codable, Equatable, Sendable, Identifiable {
    enum State: String, Codable, Sendable { case running, succeeded, failed, partial, cancelled, unknown, waiting }
    enum Source: String, Codable, Sendable { case agent_intent, subagent_goal, tool_status, generic }
    struct Counts: Codable, Equatable, Sendable {
        let total: Int
        let running: Int
        let succeeded: Int
        let failed: Int
        let cancelled: Int
        let partial: Int?
        var unknown: Int? = nil
        var waiting: Int? = nil
    }
    struct Item: Codable, Equatable, Sendable, Identifiable {
        enum Kind: String, Codable, Sendable { case subagent, errand, task }
        enum State: String, Codable, Sendable { case running, succeeded, failed, partial, cancelled, unknown, waiting }
        let id: String
        let kind: Kind
        let state: State
        let summary: String
        let step_summary: String?
        let started_at: String
        let elapsed_ms: Int
        let completed_at: String?
        let failure_reason: String?
        var progress: CentralActivityProgress? = nil
        var statusLabel: String {
            switch state {
            case .running: return "正在做"
            case .succeeded: return "已完成"
            case .failed: return "未办成"
            case .partial: return "部分完成"
            case .cancelled: return "已取消"
            case .unknown: return "结果待核对"
            case .waiting: return "正在等待"
            }
        }
    }
    let id: String
    let revision: Int
    let state: State
    let summary: String
    let step_summary: String?
    let summary_source: Source
    let started_at: String
    let observed_at: String
    let last_progress_at: String
    let elapsed_ms: Int
    let completed_at: String?
    let counts: Counts
    let items: [Item]
    let omitted_items: Int
    let failure_reason: String?
    var progress: CentralActivityProgress? = nil
}

/// Local presentation time starts on arrival, independent of device/server clock skew.
struct ActivityPresentation: Identifiable, Equatable, Sendable {
    let update: CentralActivityUpdate
    let arrivedAt: Date
    var id: String { card.id }
    var card: CentralActivityCard { update.card }
    var processedEventID: String { update.processed_event_id }
    func elapsed(at now: Date) -> Int {
        card.elapsed_ms + (card.state == .running || card.state == .waiting ? Int(max(0, now.timeIntervalSince(arrivedAt)) * 1000) : 0)
    }
    func slowSeconds(at now: Date) -> Int? {
        guard card.state == .running else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let observed = formatter.date(from: card.observed_at),
              let progress = formatter.date(from: card.last_progress_at) else { return nil }
        let seconds = Int(max(0, observed.timeIntervalSince(progress)) + max(0, now.timeIntervalSince(arrivedAt)))
        return seconds >= 30 ? seconds : nil
    }
    func collapsed(replyProcessedIDs: Set<String>) -> Bool {
        card.state == .succeeded && replyProcessedIDs.contains(processedEventID)
    }
    var heading: String {
        switch card.state {
        case .running: return "依米正在做"
        case .succeeded: return "已完成"
        case .failed: return "结果待核对"
        case .partial: return "部分完成"
        case .cancelled: return "已取消"
        case .unknown: return "结果待核对"
        case .waiting: return "正在等待"
        }
    }
    var pill: String {
        if let reason = card.failure_reason { return "\(heading) · \(reason)" }
        if card.state != .running { return "\(heading) · \(card.summary)" }
        return card.step_summary ?? card.summary
    }
    func accessibilityLabel(at now: Date) -> String {
        var parts = [heading, card.summary]
        if let step = card.step_summary { parts.append(step) }
        if let progress = card.progress { parts.append(progress.accessibilityLabel) }
        if let reason = card.failure_reason { parts.append(reason) }
        if let seconds = slowSeconds(at: now) { parts.append("这一步较慢，\(seconds) 秒没有新进度") }
        parts.append("用时 \(Self.duration(elapsed(at: now)))")
        return parts.joined(separator: "，") + "。"
    }
    static func duration(_ milliseconds: Int) -> String {
        let seconds = milliseconds / 1000
        if seconds < 60 { return "\(seconds)秒" }
        if seconds < 3600 { return String(format: "%d分%02d秒", seconds / 60, seconds % 60) }
        return String(format: "%d小时%02d分%02d秒", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }
}

struct CentralActivityStore: Equatable, Sendable {
    private(set) var cards: [ActivityPresentation] = []
    mutating func accept(_ update: CentralActivityUpdate, at date: Date = Date()) {
        let next = ActivityPresentation(update: update, arrivedAt: date)
        if let index = cards.firstIndex(where: { $0.id == update.card.id }) {
            guard update.card.revision > cards[index].card.revision else { return }
            cards[index] = next
        } else { cards.append(next) }
    }
}

/// Index anchors once for the whole history, including rows outside the visible tail.
struct YimiActivityLayout {
    let replyProcessedIDs: Set<String>
    private(set) var leading: [ActivityPresentation] = []
    private(set) var under: [String: [ActivityPresentation]] = [:]
    /// Compatibility view of cards without request/reply anchors; their display slots are above.
    private(set) var unanchored: [ActivityPresentation] = []
    private var anchors: [String: String] = [:]

    init(items: [YimiItem], activities: [ActivityPresentation], consumer: AssistantCentralTextConsumer?) {
        guard !activities.isEmpty else { replyProcessedIDs = []; return }
        let needed = Set(activities.map(\.processedEventID))
        var requests: [String: [String]] = [:], replies: [String: [String]] = [:]
        for item in items {
            if item.kind == .her, let id = item.processedEventID, needed.contains(id) { replies[id, default: []].append(item.id) }
            if item.kind == .me, let id = item.activityProcessedEventID(consumer: consumer), needed.contains(id) { requests[id, default: []].append(item.id) }
        }
        replyProcessedIDs = Set(replies.keys)
        for activity in activities {
            let id = activity.processedEventID
            let rows = activity.collapsed(replyProcessedIDs: replyProcessedIDs)
                ? replies[id] ?? [] : requests[id] ?? replies[id] ?? []
            if !rows.isEmpty {
                anchors[activity.id] = rows[0]
                for row in rows { under[row, default: []].append(activity) }
            } else {
                unanchored.append(activity)
                // Wire decoding guarantees UTC timestamps. Replay arrival time is only an elapsed-time clock.
                let started = (ISO8601.utc.date(from: activity.card.started_at)
                    ?? ISO8601.basic.date(from: activity.card.started_at))!
                let next = items.firstIndex { $0.date > started } ?? items.endIndex
                if next == items.startIndex { leading.append(activity) }
                else { under[items[next - 1].id, default: []].append(activity) }
            }
        }
    }

    func anchor(for activity: ActivityPresentation) -> String? { anchors[activity.id] }
}
