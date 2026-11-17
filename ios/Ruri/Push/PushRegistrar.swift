import Foundation

/// Asking iOS for a push token happens once a launch, from the app
/// delegate, and nowhere else. A token arriving never asks again — the loop
/// that kept midna's own app re-registering forever.
@MainActor
final class PushLaunch {
    static let shared = PushLaunch()
    private var asked = false

    /// Run `register` the first time only.
    func registerOnce(_ register: () -> Void) {
        guard !asked else { return }
        asked = true
        register()
    }
}

/// Hands this phone's push token to every paired computer — to each only
/// when it is new, the computer is new, or that one hasn't had it confirmed
/// in a week. A token iOS hands over again, unchanged, is no news: nothing
/// is sent.
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    /// Which APNs this build's token is good for.
    static let env: String = {
        #if DEBUG
            "sandbox"
        #else
            "production"
        #endif
    }()

    /// What a computer last confirmed it has.
    struct Confirmed: Codable, Equatable {
        var token: String
        var mac: String
        var env: String
        var at: Date
    }

    /// Hands the token to the paired computer `mac` (its device id); throws
    /// when it couldn't.
    typealias Deliver = @MainActor (_ mac: String, _ token: String, _ env: String) async throws -> Void

    /// How often a confirmed token is handed over again anyway.
    static let reconfirmAfter: TimeInterval = 7 * 24 * 3600
    /// How long after a failed try the next one waits.
    static let retryAfter: TimeInterval = 15 * 60

    /// The paired computers' device ids; none while unpaired.
    var macs: [String] = []
    var deliver: Deliver?
    /// How many times the token has been handed over, this launch.
    private(set) var posts = 0

    private let defaults: UserDefaults
    private let env: String
    /// The computers being handed the token now.
    private var sending: Set<String> = []
    /// When a try failed, by computer.
    private var failedAt: [String: Date] = [:]

    private static let tokenKey = "push.token"
    /// What each computer confirmed.
    private static let confirmedKey = "push.confirmedAll"
    /// What the one Mac confirmed, before there could be more.
    private static let oneConfirmedKey = "push.confirmed"

    init(defaults: UserDefaults = .standard, env: String = PushRegistrar.env) {
        self.defaults = defaults
        self.env = env
    }

    /// The token iOS gave last, as hex.
    var token: String? { defaults.string(forKey: Self.tokenKey) }

    /// What `mac` last confirmed it has.
    func confirmed(_ mac: String) -> Confirmed? {
        allConfirmed[mac]
    }

    private var allConfirmed: [String: Confirmed] {
        if let data = defaults.data(forKey: Self.confirmedKey),
           let all = try? JSONDecoder().decode([Confirmed].self, from: data)
        {
            return Dictionary(all.map { ($0.mac, $0) }) { _, last in last }
        }
        guard let data = defaults.data(forKey: Self.oneConfirmedKey),
              let one = try? JSONDecoder().decode(Confirmed.self, from: data)
        else { return [:] }
        return [one.mac: one]
    }

    /// iOS handed over a token (didRegisterForRemoteNotifications): keep
    /// it, and hand it on if the Mac doesn't have it. Never registers again.
    func received(_ deviceToken: Data, now: Date = .now) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        if hex != token {
            defaults.set(hex, forKey: Self.tokenKey)
            failedAt = [:]
        }
        await sync(now: now)
    }

    /// The paired computers changed (one paired, one forgotten): a new one
    /// needs the token.
    func macsChanged(_ ids: [String], now: Date = .now) async {
        guard ids != macs else { return }
        for id in ids where !macs.contains(id) { failedAt[id] = nil }
        macs = ids
        await sync(now: now)
    }

    /// The app came to the front: a try that failed may go again now —
    /// a computer may have let this phone send since.
    func retryNow() {
        failedAt = [:]
    }

    /// Whether `mac` needs the token handed over.
    func due(_ mac: String, now: Date = .now) -> Bool {
        guard let token, macs.contains(mac) else { return false }
        if let failed = failedAt[mac], now.timeIntervalSince(failed) < Self.retryAfter { return false }
        guard let confirmed = confirmed(mac), confirmed.token == token, confirmed.env == env else { return true }
        return now.timeIntervalSince(confirmed.at) > Self.reconfirmAfter
    }

    /// Hand the token to each computer that needs it, all at once: one
    /// asleep doesn't hold up the rest. Returns whether any took it.
    @discardableResult
    func sync(now: Date = .now) async -> Bool {
        guard let token, deliver != nil else { return false }
        let due = macs.filter { !sending.contains($0) && self.due($0, now: now) }
        guard !due.isEmpty else { return false }
        sending.formUnion(due)
        return await withTaskGroup(of: Bool.self) { group in
            for mac in due {
                group.addTask { await self.hand(token, to: mac, now: now) }
            }
            var took = false
            for await one in group where one { took = true }
            return took
        }
    }

    /// Hand the token to one computer; whether it took it.
    private func hand(_ token: String, to mac: String, now: Date) async -> Bool {
        defer { sending.remove(mac) }
        guard let deliver else { return false }
        posts += 1
        do {
            try await deliver(mac, token, env)
            var all = allConfirmed
            all[mac] = Confirmed(token: token, mac: mac, env: env, at: now)
            defaults.set(try JSONEncoder().encode(Array(all.values)), forKey: Self.confirmedKey)
            failedAt[mac] = nil
            return true
        } catch {
            failedAt[mac] = now
            return false
        }
    }
}
