import SwiftUI
import UIKit

/// Where a chat's screen is reached from: the chat, and what to call it
/// until the Mac says.
struct ChatRoute: Hashable {
    var id: String
    var name: String
}

/// One chat's conversation, as the Mac shows it: the prompts on the right,
/// the replies in full, each run of tool calls folded into a line of steps
/// — live — with what is queued and the field to write in at its foot.
struct ChatView: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.scenePhase) private var phase
    @Environment(\.palette) private var palette
    var route: ChatRoute
    /// A conversation made up beforehand, for a look at the screen.
    var made: ChatSession?

    @State private var session: ChatSession?

    /// What the bar calls it: a teammate by its own name, a project's one
    /// chat — its lead — by the project's.
    private var name: String {
        guard let log = session?.log, !log.name.isEmpty else { return route.name }
        return log.name == "Lead" && !log.project.isEmpty ? log.project : log.name
    }

    var body: some View {
        ZStack {
            palette.paper.ignoresSafeArea()
            if let session {
                if session.line == .gone {
                    Unavailable(
                        symbol: "bubble.left.and.bubble.right", title: "Not open",
                        words: "This chat isn't open in ruri anymore."
                    )
                } else {
                    Conversation(session: session, name: name)
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                ChatTitle(name: name, state: session?.log.state ?? .idle, line: session?.line ?? .connecting)
            }
        }
        .toolbarBackground(palette.paper, for: .navigationBar)
        .onAppear {
            if session == nil { session = made ?? ChatSession(chat: route.id, model: model) }
            session?.open()
        }
        .onDisappear { session?.close() }
        .onChange(of: phase) { _, phase in
            switch phase {
            case .active: session?.reopen()
            case .background: session?.close()
            default: break
            }
        }
        .onChange(of: model.network) { session?.reopen() }
    }
}

/// The chat's name in the bar, and under it how it stands when that is
/// worth saying.
private struct ChatTitle: View {
    var name: String
    var state: ChatState
    var line: ChatSession.Line
    @Environment(\.palette) private var palette

    private var words: String? {
        switch line {
        case .offline: return "Mac asleep or offline"
        case .connecting: return "Connecting…"
        default: break
        }
        switch state {
        case .working: return "Working…"
        case .needsYou: return "Waiting on you"
        case .idle: return nil
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Text(name)
                .font(.ruri(.headline, .bold))
                .foregroundStyle(palette.ink)
                .lineLimit(1)
            if let words {
                Text(words)
                    .font(.ruri(.caption2))
                    .foregroundStyle(state == .needsYou && line == .live ? palette.accent : palette.inkSoft)
                    .lineLimit(1)
                    .transition(.opacity)
            }
        }
        .animation(.snappy(duration: 0.2), value: words)
        .accessibilityElement(children: .combine)
    }
}

/// The conversation and its foot. It keeps to its end while the reader is
/// there — a reply being written stays in view, and so does a prompt just
/// sent — and stays where it is once they have scrolled up to read.
private struct Conversation: View {
    var session: ChatSession
    var name: String
    @Environment(\.palette) private var palette
    @State private var position = ScrollPosition(edge: .bottom)
    /// The reader is at the end, so what arrives is followed.
    @State private var atEnd = true
    /// The conversation has been shown from its end once. Until then it
    /// isn't shown at all: it arrives from the Mac after the screen opens,
    /// and would otherwise flash from its top.
    @State private var landed = false

    var body: some View {
        let rows = Transcript.rows(session)
        ScrollView {
            // every row is laid out, not only those in view: a lazy stack
            // kept to its end loses its place when rows change under it
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    RowView(row: row, session: session)
                        .equatable()
                        .padding(.top, index == 0 ? 0 : Transcript.gap(rows[index - 1], row))
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(atEnd ? .bottom : .top, for: .sizeChanges)
        .onScrollGeometryChange(for: Bool.self) { geometry in
            geometry.contentSize.height - geometry.visibleRect.maxY < 56
        } action: { _, now in
            atEnd = now
        }
        .scrollDismissesKeyboard(.interactively)
        .opacity(!landed && !rows.isEmpty ? 0 : session.line == .offline ? 0.5 : 1)
        // opened on its latest: once the first of it has arrived and been
        // laid out, straight to the end
        .task(id: rows.isEmpty) {
            guard !landed, !rows.isEmpty else { return }
            for _ in 0..<3 {
                position.scrollTo(edge: .bottom)
                try? await Task.sleep(for: .milliseconds(40))
            }
            atEnd = true
            landed = true
        }
        .overlay {
            if rows.isEmpty {
                if session.line == .connecting || session.line == .live && session.log.name.isEmpty {
                    ProgressView()
                } else if session.line == .live {
                    Text("Nothing said here yet")
                        .font(.ruri(.callout))
                        .foregroundStyle(palette.inkSoft)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if !atEnd {
                    Button {
                        toEnd()
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(palette.ink)
                            .frame(width: 36, height: 36)
                            .fieldSurface(palette, radius: 18)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Jump to the latest")
                    .accessibilityIdentifier("chat.latest")
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                }
                if session.line == .readOnly {
                    ReadOnlyNote { session.reopen() }
                } else {
                    Composer(session: session, placeholder: "Message \(name)…", sent: toEnd)
                }
            }
            .animation(.snappy(duration: 0.2), value: atEnd)
        }
    }

    private func toEnd() {
        atEnd = true
        withAnimation(.snappy(duration: 0.3)) { position.scrollTo(edge: .bottom) }
    }
}

/// In place of the field, on a phone that may only read.
private struct ReadOnlyNote: View {
    var again: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 10) {
            Text("This iPhone can only read. To send from here, open ruri on your Mac, go to Settings → Devices → Paired devices, and click Allow to send next to this iPhone.")
                .font(.ruri(.footnote))
                .foregroundStyle(palette.inkSoft)
                .multilineTextAlignment(.center)
            Button("Try Again", action: again)
                .font(.ruri(.footnote, .medium))
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .card(palette.paperDim)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}

// MARK: the rows

/// What a conversation shows, in order: what was said, the spinner while a
/// turn works, and prompts sent from here that the chat doesn't hold yet.
/// What waits in the queue stands over the field instead (Composer).
enum Transcript {
    /// A prompt on its way: light enough to compare on every redraw, which
    /// the files it carries are not.
    struct Sending: Equatable {
        var id: String
        var text: String
        var attachments: [ChatAttachment]
        var failed: String?
    }

    enum Row: Identifiable, Equatable {
        case item(ChatItem)
        case sending(Sending)
        case working

        var id: String {
            switch self {
            case .item(let item): item.id
            case .sending(let sending): "out:\(sending.id)"
            case .working: "working"
            }
        }

        /// Whose it is: runs of the same side sit close, like Messages.
        var side: Int {
            switch self {
            case .item(let item): item.kind == .user ? 0 : item.kind == .note ? 2 : 1
            case .sending: 0
            case .working: 1
            }
        }
    }

    @MainActor
    static func rows(_ session: ChatSession) -> [Row] {
        var rows = session.log.items.map(Row.item)
        // at work: the spinner under what it is on
        let writing = session.log.items.last?.pending == true
        if session.log.state == .working, !writing { rows.append(.working) }
        for outgoing in session.outbox where !session.log.holds(outgoing.id) {
            var failed: String?
            if case .failed(let why) = outgoing.state { failed = why }
            // one headed for the queue is shown there, unless it failed
            if outgoing.behind, failed == nil { continue }
            rows.append(
                .sending(Sending(id: outgoing.id, text: outgoing.text, attachments: outgoing.attachments.map(\.shown), failed: failed))
            )
        }
        return rows
    }

    static func gap(_ before: Row, _ row: Row) -> CGFloat {
        before.side == row.side ? 8 : 18
    }
}

private struct RowView: View, Equatable {
    var row: Transcript.Row
    var session: ChatSession

    nonisolated static func == (a: RowView, b: RowView) -> Bool {
        a.row == b.row && a.session === b.session
    }

    var body: some View {
        switch row {
        case .item(let item):
            switch item.kind {
            case .user:
                Bubble(text: item.text, from: item.from, attachments: item.attachments ?? [], session: session)
            case .assistant: Reply(item: item)
            case .steps: Steps(item: item)
            case .note: Note(text: item.text)
            }
        case .sending(let sending):
            Outgoing(sending: sending, session: session)
        case .working:
            WorkingSpinner()
                .padding(.vertical, 4)
        }
    }
}

/// ruri's own line: a turn stopped, or on an error.
private struct Note: View {
    var text: String
    @Environment(\.palette) private var palette

    var body: some View {
        Text(text)
            .font(.ruri(.footnote))
            .foregroundStyle(palette.inkSoft)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
    }
}

/// The user's prompt, on the right — or another agent's message, named.
private struct Bubble: View {
    var text: String
    var from: String?
    var under: String?
    var faded = false
    var failed = false
    var attachments: [ChatAttachment] = []
    var session: ChatSession?
    @Environment(\.palette) private var palette

    private var words: String {
        attachments.isEmpty ? text : Attaching.afterMarkers(text)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if let from {
                Text("From \(from)")
                    .font(.ruri(.caption))
                    .foregroundStyle(palette.inkSoft)
                    .padding(.trailing, 6)
            }
            if let session, !attachments.isEmpty {
                ForEach(attachments) { attachment in
                    SentAttachment(attachment: attachment, session: session)
                }
                .opacity(faded ? 0.55 : 1)
            }
            // a prompt that is only its files has nothing more to say
            if !words.isEmpty {
                MarkdownText(source: words, font: .ruri(.body), fill: false)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(palette.bubble, in: .rect(cornerRadius: 20, style: .continuous))
                    .opacity(faded ? 0.55 : 1)
                    .contextMenu {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = words }
                    }
            }
            if let under {
                Text(under)
                    .font(.ruri(.caption2))
                    .foregroundStyle(failed ? palette.destructive : palette.inkSoft)
                    .padding(.trailing, 6)
            }
        }
        // room on the left says whose it is, however long it runs
        .padding(.leading, 44)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A reply, in full, across the screen — with the spinner while it is
/// still being written, and a way to copy it once it is.
private struct Reply: View {
    var item: ChatItem
    @Environment(\.palette) private var palette
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownText(source: item.text, font: .ruri(.body))
                .textSelection(.enabled)
            if item.pending == true {
                WorkingSpinner()
            } else {
                Button {
                    UIPasteboard.general.string = item.text
                    copied = true
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(palette.inkFaint)
                        .frame(width: 30, height: 30, alignment: .leading)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied" : "Copy reply")
                .task(id: copied) {
                    guard copied else { return }
                    try? await Task.sleep(for: .seconds(1.6))
                    copied = false
                }
            }
        }
    }
}

/// A run of tool calls as one quiet chip, each step on a tap.
private struct Steps: View {
    var item: ChatItem
    @Environment(\.palette) private var palette
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "wrench.and.screwdriver")
                        .font(.system(size: 10, weight: .medium))
                    Text(item.text)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.ruriMono(.caption))
                .foregroundStyle(palette.inkSoft)
                .padding(.horizontal, 10)
                .frame(minHeight: 28)
                .background(palette.paperDim, in: .rect(cornerRadius: 8, style: .continuous))
                // taller to the finger than to the eye
                .padding(.vertical, 6)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.vertical, -6)
            if open {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array((item.steps ?? []).enumerated()), id: \.offset) { _, step in
                        Text(step)
                            .font(.ruriMono(.caption))
                            .foregroundStyle(palette.inkSoft)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(10)
                .background(palette.paperDim, in: .rect(cornerRadius: 8, style: .continuous))
                .transition(.opacity)
            }
        }
    }
}

/// A prompt sent from here, until the chat has it: sending, or not sent —
/// a tap to try again.
private struct Outgoing: View {
    var sending: Transcript.Sending
    var session: ChatSession
    @State private var asking = false

    var body: some View {
        Bubble(
            text: sending.text, under: sending.failed == nil ? "Sending…" : "Not sent · tap to try again",
            faded: sending.failed == nil, failed: sending.failed != nil,
            attachments: sending.attachments, session: session
        )
        .contentShape(.rect)
        .onTapGesture { if sending.failed != nil { asking = true } }
        .confirmationDialog(
            sending.failed ?? "", isPresented: $asking, titleVisibility: sending.failed == nil ? .hidden : .visible
        ) {
            Button("Try Again") { session.retry(sending.id) }
            Button("Delete", role: .destructive) { session.discard(sending.id) }
        }
    }
}

/// A screen with nothing to show, and why.
struct Unavailable: View {
    var symbol: String
    var title: String
    var words: String
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(palette.inkFaint)
                .padding(.bottom, 4)
            Text(title)
                .font(.ruri(.title3, .bold))
            Text(words)
                .font(.ruri(.callout))
                .foregroundStyle(palette.inkSoft)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
