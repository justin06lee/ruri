import CoreLocation
import Foundation
import Observation
import UserNotifications

/// What this phone wants to hear, as the user set it.
struct PushPrefs: Codable, Equatable, Sendable {
    enum Mode: String, Codable, Sendable, CaseIterable {
        /// Delivered without a sound or lighting the screen.
        case silent
        /// Held, and told in one summary when quiet ends.
        case batch
    }

    var finished = true
    var needsInput = true
    var quiet = true
    var mode: Mode = .silent
    /// When quiet begins, minutes after midnight: 21:30.
    var startMinute = 21 * 60 + 30
}

/// What the Mac is sent: the switches, and the nights ahead as times.
struct PushSettingsBody: Encodable, Equatable {
    struct Quiet: Encodable, Equatable {
        struct Window: Encodable, Equatable {
            var start: Double
            var end: Double
        }

        var on: Bool
        var mode: String
        var windows: [Window]
        var startMinute: Int
        var endMinute: Int
    }

    var finished: Bool
    var needsInput: Bool
    var quiet: Quiet
    /// The phone has more than one computer: each names itself in what it
    /// sends.
    var named: Bool

    init(_ prefs: PushPrefs, windows: [QuietWindow], named: Bool = false) {
        finished = prefs.finished
        needsInput = prefs.needsInput
        self.named = named
        let ms = { (date: Date) in (date.timeIntervalSince1970 * 1000).rounded() }
        quiet = Quiet(
            on: prefs.quiet,
            mode: prefs.mode.rawValue,
            windows: windows.map { Quiet.Window(start: ms($0.start), end: ms($0.end)) },
            startMinute: prefs.startMinute,
            endMinute: QuietHours.fallbackEnd
        )
    }
}

/// The phone's notification settings: kept here, sent to every paired
/// computer, each of which decides what to send and when. Fajr, which ends
/// quiet hours, is worked out here from a rough location found at most once
/// a day.
@MainActor
@Observable
final class Notifications {
    private(set) var prefs: PushPrefs
    private(set) var place: Place?
    /// Whether iOS lets ruri show notifications.
    private(set) var allowed: UNAuthorizationStatus = .notDetermined
    /// Whether the location may be read.
    private(set) var located: CLAuthorizationStatus = .notDetermined

    /// Sends the settings to the paired computer `mac` (its device id);
    /// throws when it couldn't.
    var deliver: (@MainActor (_ mac: String, PushSettingsBody) async throws -> Void)?
    /// The paired computers' device ids.
    var macs: [String] = []

    private let defaults: UserDefaults
    private let finder = PlaceFinder()
    /// The computers being told now.
    @ObservationIgnored private var sending: Set<String> = []

    private struct Sent: Codable, Equatable {
        var mac: String
        var prefs: PushPrefs
        var place: Place?
        var lastEnd: Date
        var named: Bool?
    }

    private static let prefsKey = "push.prefs"
    private static let placeKey = "push.place"
    /// What each computer was sent.
    private static let sentKey = "push.sentAll"
    /// What the one Mac was sent, before there could be more.
    private static let oneSentKey = "push.sent"
    private static let askedKey = "push.asked"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        prefs = (defaults.data(forKey: Self.prefsKey)).flatMap { try? JSONDecoder().decode(PushPrefs.self, from: $0) }
            ?? PushPrefs()
        place = (defaults.data(forKey: Self.placeKey)).flatMap { try? JSONDecoder().decode(Place.self, from: $0) }
    }

    /// The settings changed: keep them, and tell the Mac.
    func set(_ prefs: PushPrefs) {
        guard prefs != self.prefs else { return }
        self.prefs = prefs
        defaults.set(try? JSONEncoder().encode(prefs), forKey: Self.prefsKey)
        Task { await sync() }
    }

    /// When tonight's quiet ends, if it is on.
    func tonightEnds(now: Date = .now) -> Date? {
        QuietHours.windows(from: now, startMinute: prefs.startMinute, place: place, nights: 1).first?.end
    }

    /// The app came to the front: ask once for what it needs, find the
    /// place if a day old, and tell the Mac if what it has runs short.
    func wake() async {
        allowed = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        located = CLLocationManager().authorizationStatus
        if !macs.isEmpty, !defaults.bool(forKey: Self.askedKey) {
            defaults.set(true, forKey: Self.askedKey)
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            allowed = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            // quiet hours are on from the start: they end at Fajr here
            if prefs.quiet { await locate() }
        } else if prefs.quiet, located == .authorizedWhenInUse || located == .authorizedAlways,
            (place?.at).map({ Date.now.timeIntervalSince($0) > 24 * 3600 }) ?? true
        {
            await locate()
        }
        await sync()
    }

    /// Find where the phone is, roughly, asking the first time.
    func locate() async {
        if let found = await finder.find() {
            let next = Place(latitude: found.coordinate.latitude, longitude: found.coordinate.longitude)
            if next.latitude != place?.latitude || next.longitude != place?.longitude || place == nil {
                place = next
            } else {
                place?.at = next.at
            }
            defaults.set(try? JSONEncoder().encode(place), forKey: Self.placeKey)
        }
        located = CLLocationManager().authorizationStatus
    }

    /// Tell each computer whose settings are out of date: other switches,
    /// another place, another computer beside it, or fewer than three nights
    /// left.
    /// All at once: one asleep doesn't hold up the rest.
    func sync(now: Date = .now) async {
        guard !macs.isEmpty, deliver != nil else { return }
        let windows = QuietHours.windows(from: now, startMinute: prefs.startMinute, place: place, calendar: .current)
        let named = macs.count > 1
        let sent = allSent
        let due = macs.filter { mac in
            guard !sending.contains(mac) else { return false }
            guard let last = sent[mac] else { return true }
            return last.prefs != prefs || last.place?.latitude != place?.latitude
                || last.place?.longitude != place?.longitude || (last.named ?? false) != named
                || last.lastEnd <= now.addingTimeInterval(3 * 24 * 3600)
        }
        guard !due.isEmpty else { return }
        sending.formUnion(due)
        let body = PushSettingsBody(prefs, windows: windows, named: named)
        let lastEnd = windows.last?.end ?? now
        await withTaskGroup(of: Void.self) { group in
            for mac in due {
                let record = Sent(mac: mac, prefs: prefs, place: place, lastEnd: lastEnd, named: named)
                group.addTask { await self.tell(mac, body, record) }
            }
        }
    }

    /// Send one computer the settings, and note what it has.
    private func tell(_ mac: String, _ body: PushSettingsBody, _ record: Sent) async {
        defer { sending.remove(mac) }
        guard let deliver else { return }
        do {
            try await deliver(mac, body)
            var sent = allSent
            sent[mac] = record
            defaults.set(try? JSONEncoder().encode(Array(sent.values)), forKey: Self.sentKey)
        } catch {
            // the next time the app comes to the front
        }
    }

    private var allSent: [String: Sent] {
        if let data = defaults.data(forKey: Self.sentKey), let all = try? JSONDecoder().decode([Sent].self, from: data) {
            return Dictionary(all.map { ($0.mac, $0) }) { _, last in last }
        }
        guard let data = defaults.data(forKey: Self.oneSentKey), let one = try? JSONDecoder().decode(Sent.self, from: data)
        else { return [:] }
        return [one.mac: one]
    }
}

/// One rough location, asked for when needed.
@MainActor
final class PlaceFinder: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: CheckedContinuation<CLLocation?, Never>?
    private var asking = false

    func find() async -> CLLocation? {
        guard waiting == nil else { return nil }
        return await withCheckedContinuation { continuation in
            waiting = continuation
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyReduced
            asking = false
            go()
            Task {
                try? await Task.sleep(for: .seconds(20))
                self.finish(nil)
            }
        }
    }

    private func go() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways:
            guard !asking else { return }
            asking = true
            manager.requestLocation()
        default:
            finish(nil)
        }
    }

    private func finish(_ location: CLLocation?) {
        guard let waiting else { return }
        self.waiting = nil
        waiting.resume(returning: location)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard waiting != nil, manager.authorizationStatus != .notDetermined else { return }
        go()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        finish(locations.last)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        finish(nil)
    }
}
