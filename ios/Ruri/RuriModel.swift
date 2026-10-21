import Foundation
import Observation

/// Everything the screens show: the Mac this phone is paired with, the last
/// picture it sent, and whether the line to it is live.
///
/// While the app is in front, the live status stays open, and is opened
/// again — the Mac found again first, if need be — whenever it drops. In the
/// background it is closed: iOS ends sockets there anyway.
@MainActor
@Observable
final class RuriModel {
    enum Link: Equatable {
        /// Finding the Mac, or opening the line.
        case connecting
        /// The line is open: the picture is the Mac's as it is now.
        case live
        /// The Mac can't be reached; the picture is the last one it sent.
        case offline
        /// The Mac no longer knows this phone.
        case unpaired
    }

    enum Pairing: Equatable {
        case idle
        case pairing(String)
        case failed(String)
    }

    private(set) var mac: PairedMac?
    private(set) var report: StatusReport?
    /// When the Mac was last heard from: what the picture is true as of.
    private(set) var heard: Date?
    private(set) var link: Link = .connecting
    var pairing: Pairing = .idle

    private var key: String?
    private var client: MacClient?
    private var address: String?
    private var liveTask: Task<Void, Never>?
    private var awake = false

    private static let macKey = "pairedMac"

    init(demo: StatusReport? = nil) {
        if let demo {
            mac = PairedMac(
                name: demo.computer, deviceId: "", addresses: [], port: 0, fingerprint: "",
                pairedAt: .now, lastAddress: nil
            )
            report = demo
            heard = .now
            link = .live
            return
        }
        guard let data = UserDefaults.standard.data(forKey: Self.macKey),
              let mac = try? JSONDecoder().decode(PairedMac.self, from: data),
              let key = Keychain.read(account: mac.deviceId)
        else { return }
        self.mac = mac
        self.key = key
        client = MacClient(fingerprint: mac.fingerprint, key: key)
        if let kept = Self.readKept() {
            report = kept.report
            heard = kept.heard
        }
    }

    // MARK: the app in front, or not

    /// The app came to the front: open the line.
    func wake() {
        awake = true
        guard client != nil, liveTask == nil else { return }
        liveTask = Task { await self.stayLive() }
    }

    /// The app went to the background: close it.
    func sleep() {
        awake = false
        liveTask?.cancel()
        liveTask = nil
        if link == .live { link = .connecting }
        keep()
    }

    /// Pull to refresh: read the picture once, now, and open the line again
    /// if it was down.
    func refresh() async {
        guard let client, let mac else { return }
        do {
            let address = try await reach(client, mac)
            take(try await client.status(at: address, port: mac.port))
            if link != .live { restart() }
        } catch {
            lost(error)
        }
    }

    private func restart() {
        liveTask?.cancel()
        liveTask = nil
        if awake { wake() }
    }

    /// Keep the line open while the app is in front: on a drop, find the
    /// Mac again and reopen it, waiting longer each time it fails.
    private func stayLive() async {
        var wait: Duration = .seconds(1)
        while !Task.isCancelled, let client, let mac {
            do {
                let address = try await reach(client, mac)
                for try await news in client.live(at: address, port: mac.port) {
                    switch news {
                    case .report(let report): take(report)
                    case .heard: heard = .now
                    }
                    link = .live
                    wait = .seconds(1)
                }
                // the Mac closed the line: open it again
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                lost(error)
                // a Mac that no longer knows this phone won't on the next try
                if link == .unpaired {
                    liveTask = nil
                    return
                }
            }
            try? await Task.sleep(for: wait)
            wait = min(wait * 2, .seconds(30))
        }
    }

    /// Where the Mac answers: the address that answered last, else whichever
    /// of its addresses answers first — learning where else it is now.
    private func reach(_ client: MacClient, _ mac: PairedMac) async throws -> String {
        if let address { return address }
        let (address, hello) = try await client.find(mac.tryOrder, port: mac.port)
        self.address = address
        var known = mac
        known.lastAddress = address
        if let addresses = hello.addresses, !addresses.isEmpty { known.addresses = addresses }
        if let name = hello.name { known.name = name }
        if let port = hello.port { known.port = port }
        if known != self.mac { save(known) }
        return address
    }

    private func take(_ report: StatusReport) {
        self.report = report
        heard = .now
        link = .live
    }

    private func lost(_ error: any Error) {
        address = nil
        link = (error as? MacError) == .notPaired ? .unpaired : .offline
        keep()
    }

    // MARK: pairing

    /// Pair with the Mac a scanned or pasted code names — in place of any
    /// paired before.
    func pair(_ text: String) async {
        let link: PairingLink
        do {
            link = try PairingLink(parsing: text)
            if link.expired() { throw PairingLink.Problem.expired(link.name) }
        } catch {
            pairing = .failed(error.localizedDescription)
            return
        }
        pairing = .pairing(link.name)
        do {
            let (mac, key) = try await MacClient.pair(link, deviceName: Self.deviceName)
            forget()
            try Keychain.save(key, account: mac.deviceId)
            save(mac)
            self.key = key
            client = MacClient(fingerprint: mac.fingerprint, key: key)
            address = mac.lastAddress
            self.link = .connecting
            pairing = .idle
            restart()
            await refresh()
        } catch {
            pairing = .failed(Self.words(for: error, pairingWith: link.name))
        }
    }

    /// Forget the Mac: its key goes from this phone. (The Mac still lists
    /// this phone until it is removed there.)
    func unpair() {
        forget()
        pairing = .idle
    }

    private func forget() {
        liveTask?.cancel()
        liveTask = nil
        if let mac { Keychain.delete(account: mac.deviceId) }
        UserDefaults.standard.removeObject(forKey: Self.macKey)
        try? FileManager.default.removeItem(at: Self.keptURL)
        mac = nil
        key = nil
        client = nil
        address = nil
        report = nil
        heard = nil
        link = .connecting
    }

    private func save(_ mac: PairedMac) {
        self.mac = mac
        if let data = try? JSONEncoder().encode(mac) {
            UserDefaults.standard.set(data, forKey: Self.macKey)
        }
    }

    /// How this phone is listed on the Mac.
    private static var deviceName: String {
        #if canImport(UIKit)
            "iPhone"
        #else
            "a phone"
        #endif
    }

    static func words(for error: any Error, pairingWith name: String) -> String {
        switch error as? MacError {
        case .refused(let said): said
        case .outdated: "The ruri on \(name) can't pair a phone yet. Update it, then try again."
        case .newer: "\(name) runs a newer ruri than this app. Update the app, then try again."
        case .notPaired: "\(name) didn't accept this iPhone. Make a new code there and scan it."
        case .unreachable, nil:
            "Couldn't reach \(name). Make sure this iPhone is on the same network as it, or on Tailscale."
        }
    }

    // MARK: the last picture, kept for the next launch

    private struct Kept: Codable {
        var report: StatusReport
        var heard: Date
    }

    private static var keptURL: URL {
        URL.applicationSupportDirectory.appending(path: "status.json")
    }

    private func keep() {
        guard let report, let heard else { return }
        let url = Self.keptURL
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? StatusReport.encoder().encode(Kept(report: report, heard: heard)).write(to: url, options: .atomic)
    }

    private static func readKept() -> Kept? {
        guard let data = try? Data(contentsOf: keptURL) else { return nil }
        return try? StatusReport.decoder().decode(Kept.self, from: data)
    }
}
