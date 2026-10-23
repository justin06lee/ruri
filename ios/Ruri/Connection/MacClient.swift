import Foundation

/// Why the Mac couldn't be read.
enum MacError: Error, Equatable {
    /// Nothing answered: the Mac is asleep, or off every network the phone
    /// is on.
    case unreachable
    /// The Mac answered, but no longer knows this phone's key.
    case notPaired
    /// The door refused, in its own words.
    case refused(String)
    /// The Mac's ruri says things this app can't read.
    case newer
    /// The Mac's ruri can't pair a phone yet.
    case outdated
}

/// One Mac's door — its sharing port — over a line pinned to its
/// certificate, showing the phone's key. It reads only what a phone's key
/// may: the Mac's hello, its status and the status's live stream.
final class MacClient: Sendable {
    /// What the live status sends.
    enum Live: Sendable {
        /// The picture changed.
        case report(StatusReport)
        /// The line is still open: nothing changed.
        case heard
    }

    let fingerprint: String
    private let key: String?
    private let session: URLSession

    init(fingerprint: String, key: String?) {
        self.fingerprint = fingerprint
        self.key = key
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(
            configuration: config,
            delegate: PinnedDelegate(fingerprint: fingerprint),
            delegateQueue: nil
        )
    }

    deinit {
        session.invalidateAndCancel()
    }

    /// An address and port as an https URL: names and IPv4 as they are,
    /// IPv6 in brackets.
    static func url(_ address: String, port: Int, path: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = "https"
        if address.contains(":") {
            parts.percentEncodedHost = "[\(address)]"
        } else {
            parts.host = address
        }
        parts.port = port
        parts.path = path
        return parts.url
    }

    private func request(_ address: String, port: Int, path: String, timeout: TimeInterval) throws -> URLRequest {
        guard let url = Self.url(address, port: port, path: path) else { throw MacError.unreachable }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        if let key { request.setValue(key, forHTTPHeaderField: "x-ruri-token") }
        return request
    }

    private static func check(_ response: URLResponse) throws {
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: return
        case 401, 403: throw MacError.notPaired
        default: throw MacError.unreachable
        }
    }

    /// The first of `addresses` to answer `attempt`, the rest let go. If none
    /// does, the most telling reason: the Mac's own words over silence.
    static func race<T: Sendable>(
        _ addresses: [String],
        _ attempt: @escaping @Sendable (String) async throws -> T
    ) async throws -> (address: String, value: T) {
        let won = await withTaskGroup(of: (String, Result<T, any Error>).self) { group in
            for address in addresses {
                group.addTask {
                    do { return (address, .success(try await attempt(address))) } catch {
                        return (address, .failure(error))
                    }
                }
            }
            var reason: any Error = MacError.unreachable
            for await (address, result) in group {
                switch result {
                case .success(let value):
                    group.cancelAll()
                    return Result<(String, T), any Error>.success((address, value))
                case .failure(let error as MacError) where error != .unreachable:
                    reason = error
                case .failure:
                    continue
                }
            }
            return .failure(reason)
        }
        let (address, value) = try won.get()
        return (address, value)
    }

    /// Where the Mac answers now, of `addresses`, and what it says of itself.
    /// With a key, only a hello that knows it counts.
    func find(_ addresses: [String], port: Int) async throws -> (address: String, value: Hello) {
        try await Self.race(addresses) { address in
            let (data, response) = try await self.session.data(
                for: self.request(address, port: port, path: "/remote/hello", timeout: 6)
            )
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let hello = try? JSONDecoder().decode(Hello.self, from: data),
                  hello.service == "ruri"
            else { throw MacError.unreachable }
            if self.key != nil, !hello.paired { throw MacError.notPaired }
            return hello
        }
    }

    /// Every project's state, once.
    func status(at address: String, port: Int) async throws -> StatusReport {
        let (data, response) = try await session.data(
            for: request(address, port: port, path: "/status", timeout: 10)
        )
        try Self.check(response)
        do {
            return try StatusReport.decoder().decode(StatusReport.self, from: data)
        } catch {
            throw MacError.newer
        }
    }

    /// Every project's state as it changes: a report on connecting, another
    /// whenever the picture changes, word that the line is open between.
    /// Ends when the Mac closes the line; throws when it is lost.
    func live(at address: String, port: Int) -> AsyncThrowingStream<Live, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // the Mac says something at least every 25s: 40s of silence
                    // is a line gone dead, given up so it can be opened again
                    var request = try self.request(address, port: port, path: "/status/live", timeout: 40)
                    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                    let (bytes, response) = try await self.session.bytes(for: request)
                    try Self.check(response)
                    let decoder = StatusReport.decoder()
                    var stream = EventStream()
                    for try await byte in bytes {
                        switch stream.feed(byte) {
                        case .nothing:
                            continue
                        case .comment:
                            continuation.yield(.heard)
                        case .event(let event):
                            guard event.name == "status" else { continue }
                            guard let report = try? decoder.decode(StatusReport.self, from: Data(event.data.utf8))
                            else { throw MacError.newer }
                            continuation.yield(.report(report))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Redeem a pairing code for this phone's key: find which of the code's
    /// addresses answers, over a line pinned to the code's fingerprint, then
    /// hand that one the ticket — once, since a ticket is good only once.
    static func pair(_ link: PairingLink, deviceName: String) async throws -> (mac: PairedMac, key: String) {
        let client = MacClient(fingerprint: link.fingerprint, key: nil)
        let (address, _) = try await client.find(link.addresses, port: link.port)
        var request = try client.request(address, port: link.port, path: "/pair/ticket", timeout: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["ticket": link.ticket, "name": deviceName])
        let (data, response) = try await client.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            if let said = try? JSONDecoder().decode(Refusal.self, from: data).error, !said.isEmpty {
                throw MacError.refused(said)
            }
            throw status == 404 ? MacError.outdated : MacError.unreachable
        }
        guard let answer = try? JSONDecoder().decode(PairingAnswer.self, from: data),
              answer.fingerprint == link.fingerprint
        else { throw MacError.newer }
        let mac = PairedMac(
            name: answer.name,
            deviceId: answer.deviceId,
            addresses: answer.addresses.isEmpty ? link.addresses : answer.addresses,
            port: answer.port,
            fingerprint: answer.fingerprint,
            pairedAt: .now,
            lastAddress: address
        )
        return (mac, answer.key)
    }
}
