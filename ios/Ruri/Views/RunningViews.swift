import SwiftUI

/// What the chat has running beside its conversation, over the prompt
/// field: each script the model left in the background and each agent at
/// work, with its newest line and how it stands — the cards the Mac's chat
/// shows. A tap opens one (the sheet is the composer's: this dock goes when
/// the last of them ends, and what is being read should not go with it).
struct RunningDock: View {
    var session: ChatSession
    @Binding var opened: ChatRunning?

    /// How many rows show before the rest are only counted.
    private let shown = 3

    var body: some View {
        let running = session.log.running
        if !running.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(running.suffix(shown)) { one in
                    Button {
                        opened = one
                    } label: {
                        RunningRow(running: one)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chat.running")
                }
                if running.count > shown {
                    More(count: running.count - shown)
                }
            }
            .transition(.opacity)
        }
    }
}

private struct More: View {
    var count: Int
    @Environment(\.palette) private var palette

    var body: some View {
        Text("and \(count) more running")
            .font(.ruri(.caption))
            .foregroundStyle(palette.inkFaint)
            .padding(.leading, 14)
    }
}

/// One of them: what it is for, the newest thing it printed or did, and
/// whether it is printing or how long it has been quiet.
private struct RunningRow: View {
    var running: ChatRunning
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: running.kind == .script ? "terminal" : "person.crop.circle")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(palette.inkSoft)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(running.title)
                    .font(.ruri(.footnote, .medium))
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                if let doing = running.doing {
                    Text(doing)
                        .font(running.kind == .script ? .ruriMono(.caption) : .ruri(.caption))
                        .foregroundStyle(palette.inkSoft)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // counted by the second, as the Mac's card counts it
            TimelineView(.periodic(from: .now, by: 1)) { moment in
                Text(running.standing(now: moment.date))
                    .font(.ruri(.caption))
                    .monospacedDigit()
                    .foregroundStyle(palette.inkFaint)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(palette.inkFaint)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glass(RoundedRectangle(cornerRadius: 14, style: .continuous), fallback: palette.paperDim)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(running.kind == .script ? "Shows what it has printed." : "Shows what it has done.")
    }
}

/// One opened: a script's command and what it has printed so far, in the
/// stretches it arrived in, or an agent's own side of the conversation —
/// read again every couple of seconds for as long as it runs.
struct RunningSheet: View {
    var session: ChatSession
    var key: String
    /// As the dock had it when it was opened: its name, until the chat says
    /// more.
    var opened: ChatRunning

    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @State private var page: RunningPage?
    @State private var problem: String?

    /// As the chat has it now; gone from there once it has ended.
    private var live: ChatRunning? { session.log.running.first { $0.key == key } }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let page {
                        ForEach(page.items) { item in
                            Piece(item: item, script: opened.kind == .script)
                        }
                        if page.items.isEmpty {
                            Words(text: "Nothing to show yet.")
                        }
                    } else if let problem {
                        Words(text: problem)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    }
                }
                .padding(16)
            }
            // what it printed last is what was asked about
            .defaultScrollAnchor(.bottom)
            .background(palette.paper)
            .navigationTitle(opened.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    TimelineView(.periodic(from: .now, by: 1)) { moment in
                        Text(standing(now: moment.date))
                            .font(.ruri(.caption))
                            .monospacedDigit()
                            .foregroundStyle(palette.inkSoft)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task(id: key) { await follow() }
    }

    private func standing(now: Date) -> String {
        if let live { return live.standing(now: now) }
        guard let page else { return "" }
        return page.running ? "running" : "ended"
    }

    /// Read it now, and again every couple of seconds until it has ended.
    private func follow() async {
        while !Task.isCancelled {
            do {
                let read = try await session.page(of: opened)
                page = read
                problem = nil
                if !read.running { return }
            } catch let error as MacError where error == .outdated {
                problem = "Update ruri on your Mac to look at this from your iPhone."
                return
            } catch let error as MacError where error == .noChat {
                problem = "It isn't there anymore."
                return
            } catch {
                if page == nil { problem = "Couldn't reach your Mac." }
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}

/// One piece of an opened script or agent: the command, a stretch of what
/// was printed or said, or ruri's own line where it went quiet.
private struct Piece: View {
    var item: ChatItem
    var script: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        switch item.kind {
        case .note:
            Words(text: item.text)
        case .steps:
            Words(text: (item.steps ?? []).joined(separator: "\n"))
        case .user, .assistant:
            VStack(alignment: .leading, spacing: 4) {
                MarkdownText(source: item.text, font: .ruri(.subheadline))
                    .textSelection(.enabled)
                Text(item.at.formatted(date: .omitted, time: .standard))
                    .font(.ruri(.caption2))
                    .monospacedDigit()
                    .foregroundStyle(palette.inkFaint)
            }
        }
    }
}

private struct Words: View {
    var text: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(.ruri(.footnote))
            .foregroundStyle(palette.inkSoft)
            .frame(maxWidth: .infinity, alignment: .center)
            .multilineTextAlignment(.center)
            .padding(.vertical, 2)
    }
}
