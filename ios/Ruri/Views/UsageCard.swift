import SwiftUI

/// How much of each harness's limits is used, the Mac's gauges made small:
/// a row per harness, a thin bar per window, and when each fills up again.
struct UsageCard: View {
    var usage: [StatusUsage]

    var body: some View {
        RowSection(title: "Limits") {
            ForEach(usage) { harness in
                UsageRow(harness: harness)
            }
        }
    }
}

private struct UsageRow: View {
    var harness: StatusUsage
    @Environment(\.palette) private var palette

    private var gauges: [(label: String, percent: Int, resets: Date?)] {
        var gauges: [(String, Int, Date?)] = []
        if let five = harness.fiveHour { gauges.append(("5h", five, harness.resets?.fiveHour)) }
        if let week = harness.weekly { gauges.append(("Week", week, harness.resets?.weekly)) }
        if let scoped = harness.scoped { gauges.append((scoped.label, scoped.percent, harness.resets?.scoped)) }
        return gauges
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(harness.name)
                .font(.ruri(.subheadline, .medium))
                .foregroundStyle(palette.ink)
            HStack(alignment: .top, spacing: 14) {
                ForEach(gauges, id: \.label) { gauge in
                    Gauge(label: gauge.label, percent: gauge.percent, resets: gauge.resets)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// One window: its name and how full, a thin bar, and when it empties.
private struct Gauge: View {
    var label: String
    var percent: Int
    var resets: Date?
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .foregroundStyle(palette.inkSoft)
                Spacer(minLength: 4)
                Text("\(percent)%")
                    .foregroundStyle(palette.ink)
                    .monospacedDigit()
            }
            .font(.ruri(.footnote))
            GeometryReader { box in
                Capsule()
                    .fill(palette.fill)
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(percent >= 90 ? palette.destructive : palette.ink)
                            .frame(width: box.size.width * CGFloat(min(max(percent, 0), 100)) / 100)
                    }
            }
            .frame(height: 4)
            if let resets {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(Self.words(resets, now: context.date))
                        .font(.ruri(.caption2))
                        .foregroundStyle(palette.inkFaint)
                        .lineLimit(1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label): \(percent) percent used")
    }

    /// When it fills up again: "in 2h 10m" today, else the day and time.
    static func words(_ date: Date, now: Date = .now) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return "resetting" }
        if seconds < 3_600 { return "in \(max(1, Int(seconds / 60)))m" }
        if seconds < 86_400 {
            let hours = Int(seconds / 3_600)
            let minutes = Int(seconds.truncatingRemainder(dividingBy: 3_600) / 60)
            return minutes == 0 ? "in \(hours)h" : "in \(hours)h \(minutes)m"
        }
        return date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}
