import Foundation

// v1 has no avatar, payment actions, audio replies or automatic listening.
// Dates are RFC 3339 strings; absent optional projections mean there is no current item.
enum WatchYimiError: Error, Equatable { case unsupportedKey(String), invalidValue, tooLarge }
enum WatchYimiLink: String, Codable, Sendable { case ok, server_unreachable, watch_unregistered }
enum WatchYimiLatestKind: String, Codable, Sendable { case message, ambient, call }
enum WatchYimiErrandState: String, Codable, Sendable { case waiting, running, stopping }

private struct WireKey: CodingKey {
    let stringValue: String; var intValue: Int? { nil }
    init(_ value: String) { stringValue = value }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}
private func timestamp(_ text: String) -> Bool {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = text.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
    return formatter.date(from: text) != nil
}
private struct Fields {
    let values: KeyedDecodingContainer<WireKey>
    init(_ decoder: Decoder, _ keys: String...) throws {
        values = try decoder.container(keyedBy: WireKey.self)
        for key in values.allKeys where !keys.contains(key.stringValue) { throw WatchYimiError.unsupportedKey(key.stringValue) }
    }
    func get<T: Decodable>(_ key: String) throws -> T { try values.decode(T.self, forKey: WireKey(key)) }
    func optional<T: Decodable>(_ key: String) throws -> T? { try values.decodeIfPresent(T.self, forKey: WireKey(key)) }
}

struct WatchYimiLatest: Codable, Equatable, Sendable {
    let card_id: String; let title: String; let lines: [String]; let created_at: String; let kind: WatchYimiLatestKind
}
extension WatchYimiLatest {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "card_id", "title", "lines", "created_at", "kind")
        card_id = try f.get("card_id"); title = try f.get("title"); lines = try f.get("lines"); created_at = try f.get("created_at"); kind = try f.get("kind")
        guard !card_id.isEmpty, timestamp(created_at), lines.reduce(0, { $0 + $1.count }) <= 600 else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiOption: Codable, Equatable, Sendable {
    let id: String; let label: String; let lines: [String]; let recommended: Bool
}
extension WatchYimiOption {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "id", "label", "lines", "recommended")
        id = try f.get("id"); label = try f.get("label"); lines = try f.get("lines"); recommended = try f.get("recommended")
        guard !id.isEmpty else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiQuestion: Codable, Equatable, Sendable {
    let card_id: String; let question: String?; let options: [WatchYimiOption]; let expires_at: String
}
extension WatchYimiQuestion {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "card_id", "question", "options", "expires_at")
        card_id = try f.get("card_id"); question = try f.optional("question"); options = try f.get("options"); expires_at = try f.get("expires_at")
        guard !card_id.isEmpty, timestamp(expires_at), (2...5).contains(options.count), options.filter(\.recommended).count <= 1, Set(options.map(\.id)).count == options.count else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiErrand: Codable, Equatable, Sendable {
    let job_id: String; let title: String; let step: Int; let max_steps: Int; let state: WatchYimiErrandState; let started_at: String?
}
extension WatchYimiErrand {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "job_id", "title", "step", "max_steps", "state", "started_at")
        job_id = try f.get("job_id"); title = try f.get("title"); step = try f.get("step"); max_steps = try f.get("max_steps"); state = try f.get("state"); started_at = try f.optional("started_at")
        guard !job_id.isEmpty, started_at.map(timestamp) ?? true, step >= 0, max_steps >= step else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiCare: Codable, Equatable, Sendable {
    let care_id: String; let text: String
}
extension WatchYimiCare {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "care_id", "text"); care_id = try f.get("care_id"); text = try f.get("text")
        guard !care_id.isEmpty else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiPaymentPending: Codable, Equatable, Sendable {
    let count: Int; let summary: String
}
extension WatchYimiPaymentPending {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "count", "summary"); count = try f.get("count"); summary = try f.get("summary")
        guard count >= 0, !summary.contains(where: { $0.isNewline }) else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiRideMetrics: Codable, Equatable, Sendable {
    let ride_id: String
    let workout_id: String?
    let ended: Bool
    let speed_kmh: Double?
    let avg_kmh: Double
    let max_kmh: Double
    let distance_m: Double
    let elapsed_s: Double
    let moving_s: Double
    let hr_bpm: Double?
    let hr_avg: Double?
    let hr_max: Double?
    let kcal: Double?
    /// The phone's own climb for this ride (its altitude readings); absent when it has none.
    var elev_gain_m: Double? = nil
    /// Original sensor sample times, not the time the phone relayed the state.
    var hr_sample_at: String? = nil
    var speed_sample_at: String? = nil

    func matches(workoutID: String?) -> Bool { workout_id != nil && workout_id == workoutID }
}
extension WatchYimiRideMetrics {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "ride_id", "workout_id", "ended", "speed_kmh", "avg_kmh", "max_kmh",
            "distance_m", "elapsed_s", "moving_s", "hr_bpm", "hr_avg", "hr_max", "kcal", "elev_gain_m", "hr_sample_at", "speed_sample_at")
        ride_id = try f.get("ride_id"); workout_id = try f.optional("workout_id"); ended = try f.get("ended")
        speed_kmh = try f.optional("speed_kmh"); avg_kmh = try f.get("avg_kmh"); max_kmh = try f.get("max_kmh")
        distance_m = try f.get("distance_m"); elapsed_s = try f.get("elapsed_s"); moving_s = try f.get("moving_s"); hr_bpm = try f.optional("hr_bpm")
        hr_avg = try f.optional("hr_avg"); hr_max = try f.optional("hr_max"); kcal = try f.optional("kcal")
        elev_gain_m = try f.optional("elev_gain_m")
        hr_sample_at = try f.optional("hr_sample_at"); speed_sample_at = try f.optional("speed_sample_at")
        let values = [speed_kmh, avg_kmh, max_kmh, distance_m, elapsed_s, moving_s, hr_bpm, hr_avg, hr_max, kcal, elev_gain_m].compactMap { $0 }
        guard !ride_id.isEmpty, workout_id.map({ !$0.isEmpty }) ?? true,
              values.allSatisfy({ $0.isFinite && $0 >= 0 }),
              hr_sample_at.map(timestamp) ?? true, speed_sample_at.map(timestamp) ?? true else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiRide: Codable, Equatable, Sendable {
    let hr_zone: Int?; let text: String?; let max_hr_bpm: Int?
    var metrics: WatchYimiRideMetrics? = nil
    var feedback_at: String? = nil
}
extension WatchYimiRide {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "hr_zone", "text", "max_hr_bpm", "metrics", "feedback_at")
        hr_zone = try f.optional("hr_zone"); text = try f.optional("text"); max_hr_bpm = try f.optional("max_hr_bpm"); metrics = try f.optional("metrics")
        feedback_at = try f.optional("feedback_at")
        guard hr_zone.map({ (1...5).contains($0) }) ?? true, max_hr_bpm.map({ $0 > 0 }) ?? true,
              feedback_at.map(timestamp) ?? true else { throw WatchYimiError.invalidValue }
    }
}
// Binding scope. `scope` is the server's formal watch binding exactly as the credential
// response returns it (watch_device_id + pair_version); the owning iPhone relays it unchanged and neither side derives one.
// The latest merged application context's yimi_state.scope is the watch's current scope. A different value (nil means
// unregistered or revoked) clears all old-scope content, credential, pending requests/receipts and active turns, and that
// state's rev becomes the new baseline; within one scope rev only increases. sendMessage states never change the scope.
// A credential applies only when its scope equals the current one; a refresh keeps the scope and replaces token and expiry.
struct WatchBindingScope: Codable, Equatable, Sendable {
    let watch_device_id: String; let pair_version: String
}
extension WatchBindingScope {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "watch_device_id", "pair_version")
        watch_device_id = try f.get("watch_device_id"); pair_version = try f.get("pair_version")
        guard UUID(uuidString: watch_device_id) != nil,
              pair_version.range(of: "^[1-9][0-9]{0,37}$", options: .regularExpression) != nil else { throw WatchYimiError.invalidValue }
    }
}
struct WatchYimiState: Codable, Equatable, Sendable {
    static let maximumEncodedBytes = 8 * 1024
    let version: Int; let kind: String; let rev: UInt64; let link: WatchYimiLink; let scope: WatchBindingScope?
    let latest: WatchYimiLatest?; let question: WatchYimiQuestion?; let errands: [WatchYimiErrand]
    let care: WatchYimiCare?; let payment_pending: WatchYimiPaymentPending; let ride: WatchYimiRide?
    var history_epoch: String? = nil

    func encodedStrict() throws -> Data {
        let data = try JSONEncoder().encode(self)
        guard data.count <= Self.maximumEncodedBytes else { throw WatchYimiError.tooLarge }
        _ = try JSONDecoder().decode(Self.self, from: data)
        return data
    }
    static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= maximumEncodedBytes else { throw WatchYimiError.tooLarge }
        return try JSONDecoder().decode(Self.self, from: data)
    }
}
extension WatchYimiState {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "version", "kind", "rev", "link", "scope", "latest", "question", "errands", "care", "payment_pending", "ride", "history_epoch")
        version = try f.get("version"); kind = try f.get("kind"); rev = try f.get("rev"); link = try f.get("link"); scope = try f.optional("scope")
        latest = try f.optional("latest"); question = try f.optional("question"); errands = try f.get("errands")
        care = try f.optional("care"); payment_pending = try f.get("payment_pending"); ride = try f.optional("ride")
        history_epoch = try f.optional("history_epoch")
        if let history_epoch, history_epoch.range(of: "^[a-f0-9]{32}$", options: .regularExpression) == nil { throw WatchYimiError.invalidValue }
        guard version == 1, kind == "yimi_state", (link == .watch_unregistered) == (scope == nil) else { throw WatchYimiError.invalidValue }
        guard try JSONEncoder().encode(self).count <= Self.maximumEncodedBytes else { throw WatchYimiError.tooLarge }
    }
}
struct WatchCredential: Codable, Equatable, Sendable {
    let version: Int; let kind: String; let token: String; let expires_at: String; let server: String; let scope: WatchBindingScope
}
extension WatchCredential {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "version", "kind", "token", "expires_at", "server", "scope")
        version = try f.get("version"); kind = try f.get("kind"); token = try f.get("token"); expires_at = try f.get("expires_at"); server = try f.get("server")
        scope = try f.get("scope")
        guard version == 1, kind == "watch_credential", !token.isEmpty, timestamp(expires_at),
              let url = URL(string: server), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { throw WatchYimiError.invalidValue }
    }
}
// The action selects the exact args shape. Empty actions carry {}. No arbitrary dictionaries.
struct WatchYimiActionArguments: Codable, Equatable, Sendable {
    let card_id: String?; let option_id: String?; let job_id: String?; let care_id: String?
    init(card_id: String? = nil, option_id: String? = nil, job_id: String? = nil, care_id: String? = nil) {
        self.card_id = card_id; self.option_id = option_id; self.job_id = job_id; self.care_id = care_id
    }
    func validate(for action: WatchAssistantAction) throws {
        let fields = ["card_id": card_id, "option_id": option_id, "job_id": job_id, "care_id": care_id].compactMapValues { $0 }
        let expected: Set<String>
        switch action {
        case .cardAnswer: expected = ["card_id", "option_id"]
        case .errandStop: expected = ["job_id"]
        case .careSafe: expected = ["care_id"]
        case .stateRequest, .credentialRefresh: expected = []
        case .requestVoiceSession, .stopCurrentSession: throw WatchYimiError.invalidValue
        }
        guard Set(fields.keys) == expected, fields.values.allSatisfy({ !$0.isEmpty }) else { throw WatchYimiError.invalidValue }
    }
}
extension WatchYimiActionArguments {
    init(from decoder: Decoder) throws {
        let f = try Fields(decoder, "card_id", "option_id", "job_id", "care_id")
        guard try f.values.allKeys.allSatisfy({ try !f.values.decodeNil(forKey: $0) }) else { throw WatchYimiError.invalidValue }
        card_id = try f.optional("card_id"); option_id = try f.optional("option_id"); job_id = try f.optional("job_id"); care_id = try f.optional("care_id")
    }
}
