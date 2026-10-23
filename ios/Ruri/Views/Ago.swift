import Foundation

/// How long ago, as a list says it at a glance.
enum Ago {
    /// "now", "4m", "2h", "3d", then the date.
    static func short(_ date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<60: return "now"
        case ..<3_600: return "\(Int(seconds / 60))m"
        case ..<86_400: return "\(Int(seconds / 3_600))h"
        case ..<(7 * 86_400): return "\(Int(seconds / 86_400))d"
        default: return date.formatted(.dateTime.month(.abbreviated).day())
        }
    }

    /// "just now", "12s ago", "4m ago", "2h ago", then the day and time.
    static func long(_ date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        switch seconds {
        case ..<5: return "just now"
        case ..<60: return "\(Int(seconds))s ago"
        case ..<3_600: return "\(Int(seconds / 60))m ago"
        case ..<86_400: return "\(Int(seconds / 3_600))h ago"
        default: return date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        }
    }

    /// How long since: "a minute", "12 minutes", "2 hours", "3 days".
    static func span(_ date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        func count(_ n: Int, _ unit: String) -> String { n == 1 ? "1 \(unit)" : "\(n) \(unit)s" }
        switch seconds {
        case ..<90: return "a minute"
        case ..<3_600: return count(Int(seconds / 60), "minute")
        case ..<86_400: return count(Int(seconds / 3_600), "hour")
        default: return count(Int(seconds / 86_400), "day")
        }
    }
}
