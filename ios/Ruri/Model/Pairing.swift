import Foundation

/// What a "Pair a phone" code holds, on the Mac's Settings → Devices:
///
///     ruri://pair?v=1&name=<Mac>&port=<door>&fp=<fingerprint>&ticket=<ticket>&exp=<epoch s>&addr=<address>&addr=…
///
/// (server/sharing.ts pairLink writes it: tailnet addresses first, then the
/// LAN's, then names.)
/// The camera is the trusted channel: the fingerprint in the code is the
/// Mac's certificate, so the phone needs nothing else to know it is talking
/// to that Mac — it redeems the one-time ticket for its key over a line
/// pinned to it.
struct PairingLink: Equatable, Sendable {
    /// The Mac's name.
    var name: String
    /// Where it might be reached: every network it is on, then its names.
    var addresses: [String]
    /// The door's port.
    var port: Int
    /// SHA-256 of its certificate, base64url (server/tlsCert.ts).
    var fingerprint: String
    /// Good once, for a few minutes.
    var ticket: String
    /// When the ticket runs out, if the code says.
    var expires: Date?

    /// The version of the code this app reads.
    static let version = 1

    enum Problem: LocalizedError, Equatable {
        case notRuri
        case newer
        case incomplete
        case expired(String)

        var errorDescription: String? {
            switch self {
            case .notRuri: "That isn't a ruri pairing code."
            case .newer: "That code is from a newer ruri. Update this app, then scan it again."
            case .incomplete: "That pairing code is incomplete. Make a new one on your Mac."
            case .expired(let name): "That code has run out. Make a new one on \(name) (Settings, Devices, Pair a phone)."
            }
        }
    }

    init(name: String, addresses: [String], port: Int, fingerprint: String, ticket: String, expires: Date? = nil) {
        self.name = name
        self.addresses = addresses
        self.port = port
        self.fingerprint = fingerprint
        self.ticket = ticket
        self.expires = expires
    }

    /// A code as scanned or pasted.
    init(parsing text: String) throws(Problem) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed),
              parts.scheme?.lowercased() == "ruri",
              parts.host?.lowercased() == "pair"
        else { throw .notRuri }
        // read as a form is: "+" is a space (URLSearchParams writes one so),
        // and %2B a plus
        let items: [(name: String, value: String)] = (parts.percentEncodedQuery ?? "")
            .split(separator: "&")
            .map { pair in
                let halves = pair.split(separator: "=", maxSplits: 1).map {
                    $0.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? ""
                }
                return (halves[0], halves.count > 1 ? halves[1] : "")
            }
        func one(_ name: String) -> String? {
            items.first { $0.name == name }.flatMap { $0.value.isEmpty ? nil : $0.value }
        }
        if let v = one("v"), (Int(v) ?? .max) > Self.version { throw .newer }
        let addresses = items.filter { ($0.name == "addr" || $0.name == "a") && !$0.value.isEmpty }.map(\.value)
        guard let fingerprint = one("fp"),
              let ticket = one("ticket"),
              let port = one("port").flatMap(Int.init), (1...65535).contains(port),
              !addresses.isEmpty
        else { throw .incomplete }
        self.init(
            name: one("name") ?? "your Mac",
            addresses: addresses,
            port: port,
            fingerprint: fingerprint,
            ticket: ticket,
            expires: one("exp").flatMap(TimeInterval.init).map { Date(timeIntervalSince1970: $0) }
        )
    }

    /// Whether the ticket has run out by this phone's clock — a minute's
    /// grace, for one a little off the Mac's.
    func expired(now: Date = .now) -> Bool {
        expires.map { $0.addingTimeInterval(60) < now } ?? false
    }

    init(url: URL) throws(Problem) {
        try self.init(parsing: url.absoluteString)
    }
}

/// What the Mac answers a redeemed ticket with: the phone's key, and how to
/// find and trust the Mac from now on (server/sharing.ts, Pairing).
struct PairingAnswer: Decodable, Sendable {
    var deviceId: String
    var key: String
    var name: String
    var addresses: [String]
    var port: Int
    var fingerprint: String
}

/// The Mac this phone is paired with. Its key is kept apart, in the
/// keychain.
struct PairedMac: Codable, Equatable, Sendable {
    var name: String
    /// How the Mac knows this phone — never shown.
    var deviceId: String
    var addresses: [String]
    var port: Int
    var fingerprint: String
    var pairedAt: Date
    /// The address that answered last, tried first next time.
    var lastAddress: String?

    /// The addresses in the order to try them: the last one to answer first.
    var tryOrder: [String] {
        guard let lastAddress else { return addresses }
        return [lastAddress] + addresses.filter { $0 != lastAddress }
    }
}

/// What GET /remote/hello answers a paired phone: the Mac's name, and where
/// else it may be reached now.
struct Hello: Decodable, Sendable {
    var service: String
    var paired: Bool
    var name: String?
    var addresses: [String]?
    var port: Int?
}

/// What the door says when it refuses: { ok: false, error }.
struct Refusal: Decodable, Sendable {
    var error: String?
}
