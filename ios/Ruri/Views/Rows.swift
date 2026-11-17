import SwiftUI

extension StatusNeed.Reason {
    var symbol: String {
        switch self {
        case .question: "questionmark.bubble"
        case .card: "hand.raised"
        case .error: "exclamationmark.triangle"
        }
    }
}

extension StatusNeed: Identifiable {
    var id: String { "\(project)·\(who)·\(reason.rawValue)·\(since.timeIntervalSince1970)" }
}

/// Something waiting on the user: who, what it asks, and since when.
struct NeedRow: View {
    var need: StatusNeed
    /// On the home screen, which project; on a project's own, only who.
    var showProject = true
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: need.reason.symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(need.reason == .error ? palette.destructive : palette.accent)
                .frame(width: 20, height: 22)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(showProject ? need.project : need.who)
                        .font(.ruri(.body, .medium))
                        .foregroundStyle(palette.ink)
                    if showProject, need.who != "Lead" {
                        Text(need.who)
                            .font(.ruri(.subheadline))
                            .foregroundStyle(palette.inkSoft)
                    }
                    Spacer(minLength: 8)
                    Text(Ago.short(need.since))
                        .font(.ruri(.footnote))
                        .foregroundStyle(palette.inkFaint)
                        .monospacedDigit()
                }
                .lineLimit(1)
                MarkdownText(source: need.text, whole: false, lineLimit: 4, font: .ruri(.subheadline))
                    .foregroundStyle(palette.inkSoft)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A project on the home screen: how it stands, its name, and one line of
/// what it is doing now.
struct ProjectRow: View {
    var project: StatusProject
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StateGlyph(state: project.state)
                .frame(width: 20, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(project.name)
                        .font(.ruri(.body, .medium))
                        .foregroundStyle(palette.ink)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let since = project.since {
                        Text(Ago.short(since))
                            .font(.ruri(.footnote))
                            .foregroundStyle(palette.inkFaint)
                            .monospacedDigit()
                    }
                }
                MarkdownText(
                    source: project.doingNow.isEmpty ? project.state.label : project.doingNow,
                    whole: false, lineLimit: 2, font: .ruri(.subheadline)
                )
                .foregroundStyle(palette.inkSoft)
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// One of a project's chats: its name and duty, and what it is on or
/// last said — a line or two, the whole of it on a tap.
struct ChatRow: View {
    var chat: StatusChat
    /// Shown whole, with no tap needed: the lead's card.
    var whole = false
    /// A tap opens its conversation rather than the rest of its words.
    var opens = false
    @Environment(\.palette) private var palette
    @State private var expanded = false

    private var full: Bool { whole || expanded }

    /// At work, what its turn is on; otherwise its last words.
    private var words: String {
        if chat.state == .working, let doing = chat.doing, !doing.isEmpty { return doing }
        return chat.lastWords
    }

    private var duty: String? {
        if let duty = chat.duty, !duty.isEmpty { return duty }
        return chat.role == .liaison ? "Takes other projects' messages" : nil
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StateGlyph(state: chat.state)
                .frame(width: 20, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(chat.name)
                        .font(.ruri(.body, .medium))
                        .foregroundStyle(palette.ink)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if chat.state != .working, let active = chat.lastActive {
                        Text(Ago.short(active))
                            .monospacedDigit()
                            .font(.ruri(.footnote))
                            .foregroundStyle(palette.inkFaint)
                    }
                }
                if let duty {
                    Text(duty)
                        .font(.ruri(.footnote))
                        .foregroundStyle(palette.inkFaint)
                        .lineLimit(full ? nil : 1)
                }
                if !words.isEmpty {
                    MarkdownText(source: words, whole: full, lineLimit: 2, font: .ruri(.subheadline))
                        .foregroundStyle(chat.state == .working || whole ? palette.ink : palette.inkSoft)
                        .padding(.top, duty == nil ? 0 : 3)
                }
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        // a row that opens its chat takes no tap of its own: a gesture
        // here would swallow the link's
        .onTapGesture(count: 1, perform: expand)
        .allowsHitTesting(!opens)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(whole && !opens ? [] : .isButton)
    }

    private func expand() {
        guard !whole else { return }
        withAnimation(.snappy) { expanded.toggle() }
    }
}

/// Before a name: the spinner while it works, a dot in the accent while it
/// waits on you, a mark where it stopped, and a faint zzz at rest.
struct StateGlyph: View {
    var state: StatusState
    @Environment(\.palette) private var palette

    var body: some View {
        switch state {
        case .working:
            WorkingSpinner()
        case .needsYou:
            Circle()
                .fill(palette.accent)
                .frame(width: 8, height: 8)
                .accessibilityLabel("Waiting on you")
        case .blocked:
            Image(systemName: "exclamationmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(palette.destructive)
                .accessibilityLabel("Stopped")
        case .idle:
            Image(systemName: "zzz")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(palette.inkFaint)
                .accessibilityLabel("Idle")
        }
    }
}

/// Rows in one card, a hair of a line between them.
struct RowGroup<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 0) {
            Group(subviews: content) { rows in
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 {
                        palette.hairline
                            .frame(height: 0.5)
                            .padding(.leading, 40)
                    }
                    row
                }
            }
        }
        .background(palette.raised)
        .clipShape(.rect(cornerRadius: 18, style: .continuous))
    }
}

/// A group of rows under its small label.
struct RowSection<Content: View>: View {
    var title: String
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .sectionLabel(palette)
                .accessibilityAddTraits(.isHeader)
            RowGroup { content }
        }
    }
}
