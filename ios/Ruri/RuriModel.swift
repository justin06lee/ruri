import Foundation
import Network
import Observation

/// Everything the screens show: the computers this phone is paired with,
/// the one it shows, the last picture that one sent, and whether the line
/// to it is live.
///
/// One computer is shown at a time, and only its line is open: switching
/// closes it, shows the next one's last picture at once, and opens that
/// one's. Every paired computer has the push token and the notification
/// settings, so each tells the phone of its own projects.
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

    /// The one shown.
    private(set) var mac: PairedMac?
    /// Every computer paired, in the order paired.
    var macs: [PairedMac] { paired.macs }
    /// What one is called in a list: its name, told apart from another's.
    func label(_ mac: PairedMac) -> String { paired.label(mac) }
    private(set) var report: StatusReport?
    /// When the Mac was last heard from: what the picture is true as of.
    private(set) var heard: Date?
    private(set) var link: Link = .connecting
    var pairing: Pairing = .idle
    /// Counts the phone's network changing — Wi-Fi to cellular, onto
    /// Tailscale, back from nothing — so a chat's line can open again too.
    private(set) var network = 0
    /// What this phone wants to hear, and when it wants quiet.
    let notifications: Notifications

    private var key: String?
    private var client: MacClient?
    private var address: String?
    private var liveTask: Task<Void, Never>?
    private var awake = false
    private let paths = NWPathMonitor()
    private var lastPath: String?
    private var watching = false
    private var paired = PairedMacs()
    /// Made-up data, for a look at the screens: nothing is reached or kept.
    private let demo: Bool

    /// One pairing, kept before there could be more.
    private static let macKey = "pairedMac"
    private static let macsKey = "pairedMacs"

    init(demo: StatusReport? = nil, others: [PairedMac] = []) {
        notifications = Notifications()
        self.demo = demo != nil
        if let demo {
            let shown = PairedMac(
                name: demo.computer, deviceId: "demo", addresses: [], port: 0, fingerprint: "demo",
                pairedAt: .now, lastAddress: nil, platform: "darwin"
            )
            paired = PairedMacs(macs: [shown] + others, current: shown.deviceId)
            mac = shown
            report = demo
            heard = .now
            link = .live
            return
        }
        paired = Self.readPaired()
        // a pairing whose key this phone no longer has is no pairing
        paired.macs.removeAll { Keychain.read(account: $0.deviceId) == nil }
        if let shown = paired.shown { show(shown) }
        writePaired()
        watchNetwork()
        hearFromAll()
    }

    // MARK: notifications

    /// Point the push token and the notification settings at every paired
    /// computer: each tells this phone of its own projects.
    private func hearFromAll() {
        let registrar = PushRegistrar.shared
        registrar.deliver = { [weak self] mac, token, env in
            guard let self else { throw MacError.notPaired }
            let (client, address, port) = try await self.line(to: mac)
            try await client.pushToken(token, env: env, at: address, port: port)
        }
        notifications.deliver = { [weak self] mac, body in
            guard let self else { throw MacError.notPaired }
            let (client, address, port) = try await self.line(to: mac)
            try await client.pushSettings(body, at: address, port: port)
        }
        let ids = macs.map(\.deviceId)
        notifications.macs = ids
        Task {
            await registrar.macsChanged(ids)
            if !ids.isEmpty, awake { await notifications.wake() }
        }
    }

    // MARK: the phone's network

    /// When the network changes the Mac may answer somewhere else, or only
    /// now: find it again and open the line, without waiting out a backoff.
    private func watchNetwork() {
        guard !watching else { return }
        watching = true
        paths.pathUpdateHandler = { [weak self] path in
            let now =
                path.status == .satisfied
                ? path.availableInterfaces.map { "\($0.type)" }.joined(separator: ",") : "down"
            Task { @MainActor in self?.networkChanged(now) }
        }
        paths.start(queue: DispatchQueue(label: "ruri.network"))
    }

    private func networkChanged(_ now: String) {
        defer { lastPath = now }
        guard let lastPath, lastPath != now else { return }
        network += 1
        address = nil
        if now != "down" { restart() }
    }

    // MARK: a chat's line

    /// The way to the Mac for a chat's line: the client, where the Mac
    /// answers now, and its door.
    func line() async throws -> (client: MacClient, address: String, port: Int) {
        guard let client, let mac else { throw MacError.notPaired }
        return (client, try await reach(client, mac), mac.port)
    }

    /// The way to any paired computer, by its device id: the one shown
    /// goes by its own line; another is found afresh, for the moment — a
    /// prompt on its way when the phone switched still reaches its chat.
    func line(to id: String?) async throws -> (client: MacClient, address: String, port: Int) {
        guard let id, id != mac?.deviceId else { return try await line() }
        guard let other = macs.first(where: { $0.deviceId == id }),
              let key = Keychain.read(account: id)
        else { throw MacError.notPaired }
        let client = MacClient(fingerprint: other.fingerprint, key: key)
        let (address, _) = try await client.find(other.tryOrder, port: other.port)
        return (client, address, other.port)
    }

    /// A chat's line lost the Mac: look for it afresh next time.
    func lostTheMac() {
        address = nil
    }

    // MARK: the sidebar

    /// Put a project or a folder somewhere, here at once and then on the
    /// Mac, where every window follows. Should the Mac refuse, the next
    /// picture puts it back.
    func move(_ id: String, into folder: String?, before: String?) {
        guard let layout = report?.sidebar else { return }
        let moved = layout.moving(id, into: folder, before: before)
        guard moved != layout else { return }
        report?.sidebar = moved
        arrange(SidebarBody(do: .move, id: id, folderId: folder, beforeId: before))
    }

    /// Fold a folder shut, or open it — on the Mac too.
    func fold(_ folder: String, _ collapsed: Bool) {
        guard let layout = report?.sidebar else { return }
        report?.sidebar = layout.folding(folder, collapsed)
        arrange(SidebarBody(do: .fold, folderId: folder, collapsed: collapsed))
    }

    private func arrange(_ body: SidebarBody) {
        guard client != nil else { return }
        Task {
            do {
                let (client, address, port) = try await line()
                try await client.sidebar(body, at: address, port: port)
            } catch {
                await refresh()
            }
        }
    }

    // MARK: accounts

    /// Run a project on an account — here at once, then on the Mac, where
    /// every window follows. Should the Mac refuse, the next picture puts
    /// it back.
    func setAccount(_ account: StatusAccount, for project: String) {
        guard let at = report?.projects.firstIndex(where: { $0.macId == project }) else { return }
        report?.projects[at].accounts = (report?.projects[at].accounts ?? [:]).merging(
            [account.provider: account.id]
        ) { _, new in new }
        guard client != nil else { return }
        Task {
            do {
                let (client, address, port) = try await line()
                if try await !client.account(account.id, project: project, at: address, port: port) {
                    await refresh()
                }
            } catch {
                await refresh()
            }
        }
    }

    /// Run one chat on an account of its own — here at once, then on the
    /// Mac. Picking its project's account is following the project again.
    func setChatAccount(_ account: StatusAccount, for chat: String) {
        guard let project = report?.project(holding: chat),
              let at = report?.projects.firstIndex(where: { $0.name == project.name }) else { return }
        let follows = project.accounts?[account.provider] == account.id
        let mark = { (one: inout StatusChat) in
            guard one.id == chat else { return }
            one.accounts = (one.accounts ?? [:]).merging([account.provider: account.id]) { _, new in new }
        }
        if var lead = report?.projects[at].lead {
            mark(&lead)
            report?.projects[at].lead = lead
        }
        for index in report?.projects[at].team.indices ?? 0..<0 {
            if var member = report?.projects[at].team[index] {
                mark(&member)
                report?.projects[at].team[index] = member
            }
        }
        guard client != nil else { return }
        Task {
            do {
                let (client, address, port) = try await line()
                if try await !client.chatAccount(
                    follows ? nil : account.id, provider: account.provider, chat: chat, at: address, port: port
                ) {
                    await refresh()
                }
            } catch {
                await refresh()
            }
        }
    }

    // MARK: the app in front, or not

    /// The app came to the front: open the line.
    func wake() {
        awake = true
        if client != nil {
            Task {
                PushRegistrar.shared.retryNow()
                await PushRegistrar.shared.sync()
                await notifications.wake()
            }
        }
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
            let report = try await client.status(at: address, port: mac.port)
            // switched to another computer meanwhile: this one's picture is stale news
            guard mac.deviceId == self.mac?.deviceId else { return }
            take(report)
            if link != .live { restart() }
        } catch {
            guard mac.deviceId == self.mac?.deviceId else { return }
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
                    // switched away: what the last computer says is no longer shown
                    if Task.isCancelled { return }
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
                let wasLive = link == .live
                lost(error)
                // a Mac that no longer knows this phone won't on the next try
                if link == .unpaired {
                    liveTask = nil
                    return
                }
                // a line that was live goes straight back once before the
                // Mac is called unreachable: most drops are only the line
                if wasLive {
                    link = .connecting
                    continue
                }
            }
            try? await Task.sleep(for: wait)
            wait = min(wait * 2, .seconds(30))
        }
    }

    /// Where the Mac answers: the address that answered last, else whichever
    /// of its addresses answers first — learning where else it is now.
    private func reach(_ client: MacClient, _ mac: PairedMac) async throws -> String {
        if let address, mac.deviceId == self.mac?.deviceId { return address }
        let (address, hello) = try await client.find(mac.tryOrder, port: mac.port)
        guard var known = macs.first(where: { $0.deviceId == mac.deviceId }) else { return address }
        let shown = mac.deviceId == self.mac?.deviceId
        if shown { self.address = address }
        known.lastAddress = address
        if let addresses = hello.addresses, !addresses.isEmpty { known.addresses = addresses }
        if let name = hello.name { known.name = name }
        if let port = hello.port { known.port = port }
        if let platform = hello.platform { known.platform = platform }
        if known != macs.first(where: { $0.deviceId == mac.deviceId }) {
            paired.update(known)
            if shown { self.mac = known }
            writePaired()
        }
        return address
    }

    /// What the screens say while nothing answers: the Mac is asleep or off
    /// every network this phone is on, and when it was last heard from.
    func asleepWords(now: Date = .now) -> String {
        let kind = mac?.kind ?? "Mac"
        guard let heard else { return "\(kind) asleep or offline" }
        return "\(kind) asleep or offline · last seen \(Ago.long(heard, now: now))"
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

    // MARK: switching

    /// Show another paired computer: its last picture at once, then its
    /// line. A chat open on the last one closes with the screen.
    func switchTo(_ id: String) {
        guard id != mac?.deviceId, let next = macs.first(where: { $0.deviceId == id }) else { return }
        keep()
        if demo {
            mac = next
            report?.computer = next.name
            return
        }
        guard show(next) else {
            unpair(id)
            return
        }
        writePaired()
        restart()
    }

    /// Make `next` the one shown: its key, its client, its last picture.
    /// False when this phone has lost its key for it.
    @discardableResult
    private func show(_ next: PairedMac) -> Bool {
        guard let key = Keychain.read(account: next.deviceId) else { return false }
        liveTask?.cancel()
        liveTask = nil
        paired.current = next.deviceId
        mac = next
        self.key = key
        client = MacClient(fingerprint: next.fingerprint, key: key)
        address = nil
        let kept = Self.readKept(next.deviceId)
        report = kept?.report
        heard = kept?.heard
        link = .connecting
        return true
    }

    // MARK: pairing

    /// Pair with the computer a scanned or pasted code names, and show it.
    /// The ones paired before stay; one paired again takes its old place.
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
            do {
                try Keychain.save(key, account: mac.deviceId)
            } catch {
                // the Mac took the code, but this phone couldn't keep its key
                pairing = .failed(
                    "\(link.name) paired this iPhone, but the iPhone couldn't keep its key. Remove it on \(link.name) (Settings → Devices), then make a new code and try again."
                )
                return
            }
            keep()
            if let replaced = paired.add(mac), replaced.deviceId != mac.deviceId {
                Keychain.delete(account: replaced.deviceId)
                try? FileManager.default.removeItem(at: Self.keptURL(replaced.deviceId))
            }
            show(mac)
            address = mac.lastAddress
            writePaired()
            watchNetwork()
            pairing = .idle
            restart()
            hearFromAll()
            await refresh()
        } catch {
            pairing = .failed(Self.words(for: error, pairingWith: link.name))
        }
    }

    /// Forget a computer — the one shown, unless another is named: its key
    /// goes from this phone, and the next one paired is shown in its place.
    /// (The computer still lists this phone until it is removed there.)
    func unpair(_ id: String? = nil) {
        guard let id = id ?? mac?.deviceId else { return }
        Keychain.delete(account: id)
        try? FileManager.default.removeItem(at: Self.keptURL(id))
        paired.remove(id)
        if id == mac?.deviceId {
            liveTask?.cancel()
            liveTask = nil
            mac = nil
            key = nil
            client = nil
            address = nil
            report = nil
            heard = nil
            link = .connecting
            if let next = paired.shown, show(next) { restart() }
        }
        writePaired()
        pairing = .idle
        hearFromAll()
    }

    private func writePaired() {
        guard !demo else { return }
        if let data = try? JSONEncoder().encode(paired) {
            UserDefaults.standard.set(data, forKey: Self.macsKey)
        }
    }

    /// The computers paired — the one Mac paired before there could be
    /// more, and its last picture, taken into the list the first time.
    private static func readPaired() -> PairedMacs {
        let defaults = UserDefaults.standard
        if let data = defaults.data(forKey: macsKey), let paired = try? JSONDecoder().decode(PairedMacs.self, from: data) {
            return paired
        }
        guard let data = defaults.data(forKey: macKey), let mac = try? JSONDecoder().decode(PairedMac.self, from: data)
        else { return PairedMacs() }
        try? FileManager.default.moveItem(at: oldKeptURL, to: keptURL(mac.deviceId))
        defaults.removeObject(forKey: macKey)
        let paired = PairedMacs(macs: [mac], current: mac.deviceId)
        if let data = try? JSONEncoder().encode(paired) { defaults.set(data, forKey: macsKey) }
        return paired
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
        case .readOnly:
            "This iPhone can only read \(name)'s status. On \(name), open ruri's Settings → Devices → Paired devices and click Allow to send next to this iPhone."
        case .noChat: "That chat isn't open on \(name) anymore."
        case .unreachable, nil:
            "Couldn't reach \(name). Make sure this iPhone is on the same network as it, or on Tailscale."
        }
    }

    // MARK: the last picture, kept for the next launch

    private struct Kept: Codable {
        var report: StatusReport
        var heard: Date
    }

    /// Where the one Mac's picture was kept before there could be more.
    private static var oldKeptURL: URL {
        URL.applicationSupportDirectory.appending(path: "status.json")
    }

    /// Each computer's, by its device id.
    static func keptURL(_ id: String) -> URL {
        let safe = String(id.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == "-" })
        return URL.applicationSupportDirectory.appending(path: "status-\(safe).json")
    }

    private func keep() {
        guard !demo, let mac, let report, let heard else { return }
        let url = Self.keptURL(mac.deviceId)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try? StatusReport.encoder().encode(Kept(report: report, heard: heard)).write(to: url, options: .atomic)
    }

    private static func readKept(_ id: String) -> Kept? {
        guard let data = try? Data(contentsOf: keptURL(id)) else { return nil }
        return try? StatusReport.decoder().decode(Kept.self, from: data)
    }
}
