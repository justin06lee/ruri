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

/// Hands this phone's push token to the paired Mac — only when it is new,
/// the Mac is new, or the Mac hasn't had it confirmed in a week. A token
/// iOS hands over again, unchanged, is no news: nothing is sent.
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

    /// What the Mac last confirmed it has.
    struct Confirmed: Codable, Equatable {
        var token: String
        var mac: String
        var env: String
        var at: Date
    }

    /// Hands the token to the paired Mac; throws when it couldn't.
    typealias Deliver = @MainActor (_ token: String, _ env: String) async throws -> Void

    /// How often a confirmed token is handed over again anyway.
    static let reconfirmAfter: TimeInterval = 7 * 24 * 3600
    /// How long after a failed try the next one waits.
    static let retryAfter: TimeInterval = 15 * 60

    /// The paired Mac's device id, and how to reach it; nil while unpaired.
    var mac: String?
    var deliver: Deliver?
    /// How many times the token has been handed over, this launch.
    private(set) var posts = 0

    private let defaults: UserDefaults
    private let env: String
    private var sending = false
    private var failedAt: Date?

    private static let tokenKey = "push.token"
    private static let confirmedKey = "push.confirmed"

    init(defaults: UserDefaults = .standard, env: String = PushRegistrar.env) {
        self.defaults = defaults
        self.env = env
    }

    /// The token iOS gave last, as hex.
    var token: String? { defaults.string(forKey: Self.tokenKey) }

    var confirmed: Confirmed? {
        guard let data = defaults.data(forKey: Self.confirmedKey) else { return nil }
        return try? JSONDecoder().decode(Confirmed.self, from: data)
    }

    /// iOS handed over a token (didRegisterForRemoteNotifications): keep
    /// it, and hand it on if the Mac doesn't have it. Never registers again.
    func received(_ deviceToken: Data, now: Date = .now) async {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        if hex != token {
            defaults.set(hex, forKey: Self.tokenKey)
            failedAt = nil
        }
        await sync(now: now)
    }

    /// The paired Mac changed (paired, unpaired): it may need the token.
    func macChanged(_ id: String?, now: Date = .now) async {
        guard id != mac else { return }
        mac = id
        failedAt = nil
        await sync(now: now)
    }

    /// The app came to the front: a try that failed may go again now —
    /// the Mac may have let this phone send since.
    func retryNow() {
        failedAt = nil
    }

    /// Whether the Mac needs the token handed over.
    func due(now: Date = .now) -> Bool {
        guard let token, let mac else { return false }
        if let failedAt, now.timeIntervalSince(failedAt) < Self.retryAfter { return false }
        guard let confirmed, confirmed.token == token, confirmed.mac == mac, confirmed.env == env else { return true }
        return now.timeIntervalSince(confirmed.at) > Self.reconfirmAfter
    }

    /// Hand the token over if the Mac needs it. Returns whether it did.
    @discardableResult
    func sync(now: Date = .now) async -> Bool {
        guard !sending, due(now: now), let token, let mac, let deliver else { return false }
        sending = true
        defer { sending = false }
        posts += 1
        do {
            try await deliver(token, env)
            let confirmed = Confirmed(token: token, mac: mac, env: env, at: now)
            defaults.set(try JSONEncoder().encode(confirmed), forKey: Self.confirmedKey)
            failedAt = nil
            return true
        } catch {
            failedAt = now
            return false
        }
    }
}
