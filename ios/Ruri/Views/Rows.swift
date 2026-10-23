import SwiftUI

extension StatusNeed.Reason {
    var symbol: String {
        switch self {
        case .question: "questionmark.bubble"
        case .card: "hand.raised"
        case .error: "exclamationmark.triangle"
        }
    }

    var tint: Color { self == .error ? .red : .orange }
}

extension StatusNeed: Identifiable {
    var id: String { "\(project)·\(who)·\(reason.rawValue)·\(since.timeIntervalSince1970)" }
}

/// Something waiting on the user: who, what it asks — in full — and since
/// when.
struct NeedRow: View {
    var need: StatusNeed
    /// On the home screen, which project; on a project's own, only who.
    var showProject = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: need.reason.symbol)
                .font(.subheadline)
                .foregroundStyle(need.reason.tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(showProject ? need.project : need.who)
                        .font(.body.weight(.semibold))
                    if showProject {
                        Text(need.who)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Text(Ago.short(need.since))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .lineLimit(1)
                Text(need.text)
                    .font(.subheadline)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// A project on the home screen: its dot, its name, and one line of what
/// it is doing now.
struct ProjectRow: View {
    var project: StatusProject

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            StatusDot(state: project.state)
                .onFirstLine()
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(project.name)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let since = project.since {
                        Text(Ago.short(since))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                }
                Text(project.doingNow.isEmpty ? project.state.label : project.doingNow)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// One of a project's chats: its dot, name and duty, and what it is on or
/// last said — a line or two, the whole of it on a tap.
struct ChatRow: View {
    var chat: StatusChat
    /// Shown whole, with no tap needed: the lead's card.
    var whole = false
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
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            StatusDot(state: chat.state)
                .onFirstLine()
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(chat.name)
                        .font(.body.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Group {
                        if chat.state == .working {
                            Text("Working")
                        } else if let active = chat.lastActive {
                            Text(Ago.short(active)).monospacedDigit()
                        }
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                if let duty {
                    Text(duty)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(full ? nil : 1)
                }
                if !words.isEmpty {
                    Text(words)
                        .font(.subheadline)
                        .foregroundStyle(chat.state == .working || whole ? .primary : .secondary)
                        .lineLimit(full ? nil : 2)
                        .padding(.top, duty == nil ? 0 : 2)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(.rect)
        .onTapGesture {
            guard !whole else { return }
            withAnimation(.snappy) { expanded.toggle() }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(whole ? [] : .isButton)
    }
}
