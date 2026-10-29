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
    /// This phone's key reads the status only: it was paired before phones
    /// could see and send chats.
    case readOnly
    /// The chat isn't open on the Mac anymore.
    case noChat
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
    /// One-off requests: the status, a prompt sent, a pairing. Each sets its
    /// own timeout; the session's is never the shorter.
    private let session: URLSession
    /// Finding the Mac: patient, since a tailnet path that has been idle can
    /// take many seconds to come up, and it waits out a network still
    /// coming up rather than failing at once.
    private let finder: URLSession
    /// The live streams. The Mac speaks at least every 25s; the request
    /// timeout here is how long silence may last, so it is the stream's.
    private let streams: URLSession
    /// Asked by every task as well as every session (Pinning.swift).
    private let pinned: PinnedDelegate

    /// How long the first try at an address may take to answer the hello,
    /// and each try after it.
    static let findTimeout: TimeInterval = 20
    static let retryTimeout: TimeInterval = 12
    /// How many more times a tailnet address is tried before the Mac is
    /// called asleep or offline.
    static let tailnetRetries = 2
    /// Silence on a live stream, in seconds, before it is a line gone dead.
    static let streamSilence: TimeInterval = 40

    init(fingerprint: String, key: String?) {
        self.fingerprint = fingerprint
        self.key = key
        pinned = PinnedDelegate(fingerprint: fingerprint)
        session = Self.makeSession(pinned, timeout: 20, waits: false)
        finder = Self.makeSession(pinned, timeout: Self.findTimeout, waits: true, resource: Self.findTimeout + 5)
        streams = Self.makeSession(pinned, timeout: Self.streamSilence, waits: false)
    }

    private static func makeSession(
        _ pinned: PinnedDelegate, timeout: TimeInterval, waits: Bool, resource: TimeInterval? = nil
    ) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        if let resource { config.timeoutIntervalForResource = resource }
        config.waitsForConnectivity = waits
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(
            configuration: config,
            delegate: pinned,
            delegateQueue: nil
        )
    }

    deinit {
        session.invalidateAndCancel()
        finder.invalidateAndCancel()
        streams.invalidateAndCancel()
    }

    /// An address on a tailnet: Tailscale's 100.64.0.0/10, its IPv6 range,
    /// or a MagicDNS name.
    static func isTailnet(_ address: String) -> Bool {
        let host = address.lowercased()
        if host.hasSuffix(".ts.net") || host.hasPrefix("fd7a:115c:a1e0:") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
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

    private func request(
        _ address: String, port: Int, path: String, query: [URLQueryItem] = [], timeout: TimeInterval
    ) throws -> URLRequest {
        guard var url = Self.url(address, port: port, path: path) else { throw MacError.unreachable }
        if !query.isEmpty { url.append(queryItems: query) }
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
    /// With a key, only a hello that knows it counts. A tailnet address that
    /// doesn't answer is tried again — a cold path often answers the second
    /// time — before the Mac is called unreachable.
    func find(_ addresses: [String], port: Int) async throws -> (address: String, value: Hello) {
        try await Self.race(addresses) { address in
            let tries = Self.isTailnet(address) ? 1 + Self.tailnetRetries : 1
            var reason: any Error = MacError.unreachable
            for attempt in 0..<tries {
                if attempt > 0 { try await Task.sleep(for: .seconds(attempt)) }
                do {
                    return try await self.hello(at: address, port: port, timeout: attempt == 0 ? Self.findTimeout : Self.retryTimeout)
                } catch let error as MacError where error != .unreachable {
                    // the Mac answered: trying again won't change its words
                    throw error
                } catch {
                    if Task.isCancelled { throw CancellationError() }
                    reason = error
                }
            }
            throw reason
        }
    }

    private func hello(at address: String, port: Int, timeout: TimeInterval) async throws -> Hello {
        let (data, response) = try await finder.data(
            for: request(address, port: port, path: "/remote/hello", timeout: timeout), delegate: pinned
        )
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let hello = try? JSONDecoder().decode(Hello.self, from: data),
              hello.service == "ruri"
        else { throw MacError.unreachable }
        if key != nil, !hello.paired { throw MacError.notPaired }
        return hello
    }

    /// The status with each chat's id, which its conversation is read by.
    private static let ids = [URLQueryItem(name: "ids", value: "1")]

    /// Every project's state, once.
    func status(at address: String, port: Int) async throws -> StatusReport {
        let (data, response) = try await session.data(
            for: request(address, port: port, path: "/status", query: Self.ids, timeout: 10), delegate: pinned
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
                    var request = try self.request(
                        address, port: port, path: "/status/live", query: Self.ids, timeout: Self.streamSilence
                    )
                    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                    let (bytes, response) = try await self.streams.bytes(for: request, delegate: self.pinned)
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

    /// What a chat's live line sends.
    enum ChatLive: Sendable {
        case frame(ChatFrame)
        /// The line is still open: nothing changed.
        case heard
    }

    /// A chat's answer, read: 403 here is a key that reads the status only,
    /// not one the Mac has forgotten.
    private static func checkChat(_ response: URLResponse) throws {
        switch (response as? HTTPURLResponse)?.statusCode {
        case 200: return
        case 401: throw MacError.notPaired
        case 403: throw MacError.readOnly
        case 404: throw MacError.noChat
        default: throw MacError.unreachable
        }
    }

    /// A chat's conversation as it changes: the whole of it on connecting,
    /// then what changed. Ends when the Mac closes the line; throws when it
    /// is lost.
    func chatLive(_ chat: String, at address: String, port: Int) -> AsyncThrowingStream<ChatLive, any Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = try self.request(
                        address, port: port, path: "/chat/live",
                        query: [URLQueryItem(name: "id", value: chat)], timeout: Self.streamSilence
                    )
                    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                    let (bytes, response) = try await self.streams.bytes(for: request, delegate: self.pinned)
                    try Self.checkChat(response)
                    let decoder = StatusReport.decoder()
                    var stream = EventStream()
                    for try await byte in bytes {
                        switch stream.feed(byte) {
                        case .nothing:
                            continue
                        case .comment:
                            continuation.yield(.heard)
                        case .event(let event):
                            if event.name == "gone" { throw MacError.noChat }
                            guard event.name == "chat" else { continue }
                            guard let frame = try? decoder.decode(ChatFrame.self, from: Data(event.data.utf8))
                            else { throw MacError.newer }
                            continuation.yield(.frame(frame))
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

    /// Send a prompt into a chat, under the phone's own id for it: sent
    /// twice — after a dropped line — the Mac answers rather than runs it.
    func send(_ text: String, to chat: String, id: String, at address: String, port: Int) async throws -> SentAs {
        var request = try request(address, port: port, path: "/chat/send", timeout: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(["id": chat, "text": text, "clientId": id])
        let (data, response) = try await session.data(for: request, delegate: pinned)
        try Self.checkChat(response)
        guard let answer = try? JSONDecoder().decode(SendAnswer.self, from: data) else { throw MacError.newer }
        return answer.as
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
        let (data, response) = try await client.session.data(for: request, delegate: client.pinned)
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
