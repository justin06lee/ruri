import Foundation

/// Where the phone roughly is: enough for the sun, no more.
struct Place: Codable, Equatable, Sendable {
    var latitude: Double
    var longitude: Double
    /// When it was found.
    var at: Date

    /// Rounded to a tenth of a degree (about 10 km): Fajr moves by seconds.
    init(latitude: Double, longitude: Double, at: Date = .now) {
        self.latitude = (latitude * 10).rounded() / 10
        self.longitude = (longitude * 10).rounded() / 10
        self.at = at
    }
}

/// Fajr, worked out on the phone from the sun's place — no network, no
/// table. The angle is ISNA's, 15° below the horizon, the convention most
/// North American mosques print; the formulas are PrayTimes.org's.
enum Fajr {
    /// How far below the horizon the sun is at Fajr.
    static let angle = 15.0
    /// The sun's upper edge at the horizon, with refraction: sunrise.
    static let sunriseAngle = 0.833

    /// Fajr on `day` (its calendar date where the phone is), at `place`; nil
    /// where the sky never gets that dark (far north in summer).
    static func time(on day: Date, at place: Place, calendar: Calendar = .current) -> Date? {
        morning(angle, on: day, at: place, calendar: calendar)
    }

    /// Sunrise, the same way — a check on the sun's place.
    static func sunrise(on day: Date, at place: Place, calendar: Calendar = .current) -> Date? {
        morning(sunriseAngle, on: day, at: place, calendar: calendar)
    }

    /// When, before noon, the sun is `angle` degrees below the horizon.
    private static func morning(_ angle: Double, on day: Date, at place: Place, calendar: Calendar) -> Date? {
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        guard let year = parts.year, let month = parts.month, let date = parts.day else { return nil }
        let jd = julian(year: year, month: month, day: date) - place.longitude / (15 * 24)
        // a first guess, then once more from where it landed
        var hours = 5.0
        for _ in 0..<2 {
            guard let found = beforeNoon(angle, jd: jd, portion: hours / 24, latitude: place.latitude) else {
                return nil
            }
            hours = found
        }
        // hours of the day by the sun at that longitude, made UTC
        let utc = hours - place.longitude / 15
        var gmt = Calendar(identifier: .gregorian)
        gmt.timeZone = TimeZone(identifier: "UTC")!
        guard let midnight = gmt.date(from: DateComponents(year: year, month: month, day: date)) else { return nil }
        return midnight.addingTimeInterval(utc * 3600)
    }

    private static func beforeNoon(_ angle: Double, jd: Double, portion: Double, latitude: Double) -> Double? {
        let (declination, equation) = sun(jd + portion)
        let noon = fixHour(12 - equation)
        let cosine =
            (-sin(radians(angle)) - sin(radians(declination)) * sin(radians(latitude)))
            / (cos(radians(declination)) * cos(radians(latitude)))
        guard (-1...1).contains(cosine) else { return nil }
        return noon - degrees(acos(cosine)) / 15
    }

    /// The sun's declination and the equation of time, for a Julian day.
    private static func sun(_ jd: Double) -> (declination: Double, equation: Double) {
        let d = jd - 2_451_545.0
        let g = fixAngle(357.529 + 0.985_600_28 * d)
        let q = fixAngle(280.459 + 0.985_647_36 * d)
        let l = fixAngle(q + 1.915 * sin(radians(g)) + 0.020 * sin(radians(2 * g)))
        let e = 23.439 - 0.000_000_36 * d
        let ra = fixHour(degrees(atan2(cos(radians(e)) * sin(radians(l)), cos(radians(l)))) / 15)
        let declination = degrees(asin(sin(radians(e)) * sin(radians(l))))
        return (declination, q / 15 - ra)
    }

    static func julian(year: Int, month: Int, day: Int) -> Double {
        var y = Double(year)
        var m = Double(month)
        if m <= 2 {
            y -= 1
            m += 12
        }
        let a = (y / 100).rounded(.down)
        let b = 2 - a + (a / 4).rounded(.down)
        return (365.25 * (y + 4716)).rounded(.down) + (30.6001 * (m + 1)).rounded(.down) + Double(day) + b - 1524.5
    }

    private static func radians(_ d: Double) -> Double { d * .pi / 180 }
    private static func degrees(_ r: Double) -> Double { r * 180 / .pi }
    private static func fixAngle(_ a: Double) -> Double { a - 360 * (a / 360).rounded(.down) }
    private static func fixHour(_ h: Double) -> Double { h - 24 * (h / 24).rounded(.down) }
}

/// One night's quiet.
struct QuietWindow: Codable, Equatable, Sendable {
    var start: Date
    var end: Date
}

/// The quiet nights ahead: from the chosen evening time until Fajr the next
/// morning — or until 05:30 without a place, or where Fajr never comes.
enum QuietHours {
    /// When quiet ends without Fajr to go by.
    static let fallbackEnd = 5 * 60 + 30
    /// How many nights the Mac is told at once.
    static let nights = 7

    /// The nights still to come, the one under way first.
    static func windows(
        from now: Date, startMinute: Int, place: Place?, nights: Int = nights, calendar: Calendar = .current
    ) -> [QuietWindow] {
        let today = calendar.startOfDay(for: now)
        var found: [QuietWindow] = []
        for offset in -1..<nights {
            guard let day = calendar.date(byAdding: .day, value: offset, to: today),
                  let start = calendar.date(byAdding: .minute, value: startMinute, to: day)
            else { continue }
            // an evening start ends the next morning; one after midnight,
            // the same morning
            let morning = startMinute >= 12 * 60 ? calendar.date(byAdding: .day, value: 1, to: day)! : day
            let end = end(on: morning, place: place, calendar: calendar)
            guard end > start, end > now else { continue }
            found.append(QuietWindow(start: start, end: end))
        }
        return Array(found.prefix(nights))
    }

    /// When quiet ends on the morning of `day`.
    static func end(on day: Date, place: Place?, calendar: Calendar = .current) -> Date {
        if let place, let fajr = Fajr.time(on: day, at: place, calendar: calendar) { return fajr }
        return calendar.date(byAdding: .minute, value: fallbackEnd, to: calendar.startOfDay(for: day))!
    }

    /// Whether `now` is inside one of `windows`.
    static func isQuiet(_ windows: [QuietWindow], at now: Date) -> Bool {
        windows.contains { $0.start <= now && now < $0.end }
    }
}
