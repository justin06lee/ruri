import Foundation
import Testing

@testable import Ruri

/// A fresh UserDefaults of its own.
private func scratch() -> UserDefaults {
    let name = "ruri.test.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
}

private let token = Data([0xAB, 0xCD, 0x01, 0x02] + Array(repeating: 0x7F, count: 28))

/// The token goes to the Mac once, and nothing a token's arrival does asks
/// iOS for another — midna's app looped doing that.
@MainActor
struct PushRegistrarTests {
    @Test func registersOnceALaunchAndPostsOnceAToken() async {
        let launch = PushLaunch()
        var registered = 0
        let registrar = PushRegistrar(defaults: scratch(), env: "sandbox")
        var posted: [String] = []
        registrar.macs = ["mac1"]
        registrar.deliver = { _, token, env in
            posted.append("\(env):\(token)")
            // a delivery that pokes the launch again changes nothing
            launch.registerOnce { registered += 1 }
        }
        launch.registerOnce { registered += 1 }
        for _ in 0..<5 {
            await registrar.received(token)
            launch.registerOnce { registered += 1 }
        }
        #expect(registered == 1)
        #expect(posted == ["sandbox:abcd0102" + String(repeating: "7f", count: 28)])
        #expect(registrar.posts == 1)
    }

    @Test func postsAgainOnlyForANewTokenOrANewMac() async {
        let defaults = scratch()
        let registrar = PushRegistrar(defaults: defaults, env: "production")
        var posted: [String] = []
        registrar.deliver = { mac, _, _ in posted.append(mac) }
        await registrar.received(token)
        #expect(posted.isEmpty)  // no Mac yet
        await registrar.macsChanged(["mac1"])
        #expect(posted == ["mac1"])
        await registrar.received(token)
        await registrar.macsChanged(["mac1"])
        #expect(posted == ["mac1"])
        // a second computer paired: only it needs the token
        await registrar.macsChanged(["mac1", "mac2"])
        #expect(posted == ["mac1", "mac2"])
        // a new token goes to both
        await registrar.received(Data(repeating: 0x11, count: 32))
        #expect(posted == ["mac1", "mac2", "mac1", "mac2"])
        // one forgotten: the other has it already
        await registrar.macsChanged(["mac2"])
        #expect(posted.count == 4)
        // the next launch remembers what each confirmed
        let next = PushRegistrar(defaults: defaults, env: "production")
        next.macs = ["mac1", "mac2"]
        next.deliver = { mac, _, _ in posted.append(mac) }
        await next.received(Data(repeating: 0x11, count: 32))
        #expect(posted.count == 4)
    }

    @Test func oneMacOutOfReachDoesntHoldUpTheOthers() async {
        let registrar = PushRegistrar(defaults: scratch(), env: "production")
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        var took: [String] = []
        registrar.macs = ["asleep", "awake"]
        registrar.deliver = { mac, _, _ in
            if mac == "asleep" { throw MacError.unreachable }
            took.append(mac)
        }
        await registrar.received(token, now: start)
        #expect(took == ["awake"])
        #expect(registrar.due("asleep", now: start.addingTimeInterval(60)) == false)
        #expect(registrar.due("asleep", now: start.addingTimeInterval(16 * 60)))
        #expect(registrar.due("awake", now: start.addingTimeInterval(16 * 60)) == false)
    }

    @Test func readsWhatTheOneMacConfirmedBefore() throws {
        let defaults = scratch()
        let one = PushRegistrar.Confirmed(token: "abc", mac: "mac1", env: "production", at: .now)
        defaults.set(try JSONEncoder().encode(one), forKey: "push.confirmed")
        #expect(PushRegistrar(defaults: defaults, env: "production").confirmed("mac1") == one)
    }

    @Test func aFailureWaitsBeforeTryingAgain() async {
        let registrar = PushRegistrar(defaults: scratch(), env: "production")
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        var tries = 0
        var fail = true
        registrar.macs = ["mac1"]
        registrar.deliver = { _, _, _ in
            tries += 1
            if fail { throw MacError.unreachable }
        }
        await registrar.received(token, now: start)
        #expect(tries == 1)
        #expect(await registrar.sync(now: start.addingTimeInterval(60)) == false)
        #expect(tries == 1)
        fail = false
        #expect(await registrar.sync(now: start.addingTimeInterval(16 * 60)))
        #expect(tries == 2)
        #expect(await registrar.sync(now: start.addingTimeInterval(17 * 60)) == false)
        // a week on, handed over again, once
        #expect(await registrar.sync(now: start.addingTimeInterval(8 * 24 * 3600)))
        #expect(tries == 3)
    }
}

struct FajrTests {
    private func local(_ zone: String, _ y: Int, _ m: Int, _ d: Int) -> (Calendar, Date) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        return (calendar, calendar.date(from: DateComponents(year: y, month: m, day: d, hour: 12))!)
    }

    private func clock(_ date: Date?, _ calendar: Calendar) -> Int {
        guard let date else { return -1 }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return parts.hour! * 60 + parts.minute!
    }

    @Test func sanFrancisco() {
        // NOAA's formulas give Fajr (15°) 6:17 and sunrise 7:30, PDT
        let (calendar, day) = local("America/Los_Angeles", 2026, 10, 28)
        let place = Place(latitude: 37.7749, longitude: -122.4194)
        let fajr = clock(Fajr.time(on: day, at: place, calendar: calendar), calendar)
        let sunrise = clock(Fajr.sunrise(on: day, at: place, calendar: calendar), calendar)
        #expect(abs(fajr - (6 * 60 + 17)) <= 3)
        #expect(abs(sunrise - (7 * 60 + 30)) <= 3)
    }

    @Test func eastOfGreenwichIsTheSameMorning() {
        // Tokyo: Fajr 4:47 JST, on the 28th, not the day before
        let (calendar, day) = local("Asia/Tokyo", 2026, 10, 28)
        let fajr = Fajr.time(on: day, at: Place(latitude: 35.68, longitude: 139.69), calendar: calendar)
        #expect(abs(clock(fajr, calendar) - (4 * 60 + 47)) <= 3)
        #expect(calendar.component(.day, from: fajr!) == 28)
    }

    @Test func noFajrFarNorthInSummerFallsBackTo0530() {
        let (calendar, day) = local("Europe/Oslo", 2026, 6, 21)
        let tromso = Place(latitude: 69.65, longitude: 18.96)
        #expect(Fajr.time(on: day, at: tromso, calendar: calendar) == nil)
        #expect(clock(QuietHours.end(on: day, place: tromso, calendar: calendar), calendar) == 5 * 60 + 30)
    }
}

struct QuietHoursTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }

    private func at(_ d: Int, _ h: Int, _ m: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: d, hour: h, minute: m))!
    }

    private let sf = Place(latitude: 37.77, longitude: -122.42)

    @Test func eachNightFrom2130UntilFajr() {
        let windows = QuietHours.windows(from: at(28, 14), startMinute: 21 * 60 + 30, place: sf, calendar: calendar)
        #expect(windows.count == 7)
        #expect(windows[0].start == at(28, 21, 30))
        let fajr = calendar.dateComponents([.day, .hour], from: windows[0].end)
        #expect(fajr.day == 29 && fajr.hour == 6)
        #expect(!QuietHours.isQuiet(windows, at: at(28, 21, 29)))
        #expect(QuietHours.isQuiet(windows, at: at(28, 23)))
        #expect(QuietHours.isQuiet(windows, at: at(29, 6)))
        #expect(!QuietHours.isQuiet(windows, at: at(29, 6, 30)))
    }

    @Test func theNightUnderWayComesFirst() {
        let windows = QuietHours.windows(from: at(29, 3), startMinute: 21 * 60 + 30, place: sf, calendar: calendar)
        #expect(windows[0].start == at(28, 21, 30))
        #expect(QuietHours.isQuiet(windows, at: at(29, 3)))
    }

    @Test func withoutAPlaceUntil0530() {
        let windows = QuietHours.windows(from: at(28, 14), startMinute: 22 * 60, place: nil, calendar: calendar)
        #expect(windows[0].start == at(28, 22))
        #expect(windows[0].end == at(29, 5, 30))
    }

    @Test func theMacIsSentTimesInMilliseconds() throws {
        let window = QuietWindow(start: Date(timeIntervalSince1970: 100), end: Date(timeIntervalSince1970: 200))
        var prefs = PushPrefs()
        prefs.mode = .batch
        let body = PushSettingsBody(prefs, windows: [window])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! [String: Any]
        let quiet = json["quiet"] as! [String: Any]
        #expect(json["finished"] as? Bool == true)
        #expect(quiet["mode"] as? String == "batch")
        #expect(quiet["startMinute"] as? Int == 1290)
        #expect(quiet["endMinute"] as? Int == 330)
        let first = (quiet["windows"] as! [[String: Any]])[0]
        #expect(first["start"] as? Double == 100_000)
        #expect(first["end"] as? Double == 200_000)
        #expect(json["named"] as? Bool == false)
        let named = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(PushSettingsBody(prefs, windows: [window], named: true))
        ) as! [String: Any]
        #expect(named["named"] as? Bool == true)
    }
}

/// The settings go to every computer paired, each once, and again when a
/// second one makes them name themselves.
@MainActor
struct NotificationsTests {
    @Test func eachMacIsToldOnce() async {
        let notifications = Notifications(defaults: scratch())
        var told: [String: Bool] = [:]
        notifications.deliver = { mac, body in told[mac] = body.named }
        notifications.macs = ["mac1"]
        await notifications.sync()
        #expect(told == ["mac1": false])
        told = [:]
        await notifications.sync()
        #expect(told.isEmpty)
        // a second computer: both name themselves now
        notifications.macs = ["mac1", "mac2"]
        await notifications.sync()
        #expect(told == ["mac1": true, "mac2": true])
    }

    @Test func oneSlowToAnswerDoesntHoldUpOnePairedMeanwhile() async {
        let notifications = Notifications(defaults: scratch())
        var told: [String] = []
        var release: CheckedContinuation<Void, Never>?
        notifications.deliver = { mac, _ in
            if mac == "asleep" { await withCheckedContinuation { release = $0 } }
            told.append(mac)
        }
        notifications.macs = ["asleep"]
        let first = Task { await notifications.sync() }
        while release == nil { await Task.yield() }
        notifications.macs = ["asleep", "new"]
        await notifications.sync()
        #expect(told == ["new"])
        release?.resume()
        await first.value
        #expect(told == ["new", "asleep"])
    }
}
