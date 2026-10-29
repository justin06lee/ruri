import SwiftUI

/// Where a chat's screen is reached from: the chat, and what to call it
/// until the Mac says.
struct ChatRoute: Hashable {
    var id: String
    var name: String
}

/// One chat's conversation, as the web app shows it: the prompts on the
/// right, the replies in full, each run of tool calls folded into a line
/// of steps — live — and a field at the foot to send it a prompt.
struct ChatView: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.scenePhase) private var phase
    var route: ChatRoute

    @State private var session: ChatSession?
    @State private var draft = ""
    @FocusState private var typing: Bool

    var body: some View {
        Group {
            if let session {
                conversation(session)
            } else {
                Color.clear
            }
        }
        .navigationTitle(session?.log.name.isEmpty == false ? session!.log.name : route.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let session { StateMark(state: session.log.state) }
            }
        }
        .onAppear {
            if session == nil { session = ChatSession(chat: route.id, model: model) }
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

    @ViewBuilder
    private func conversation(_ session: ChatSession) -> some View {
        if session.line == .gone {
            ContentUnavailableView(
                "Not Open",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("This chat isn't open in ruri anymore.")
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    let rows = Self.rows(session)
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        RowView(row: row, session: session)
                            .padding(.top, index == 0 ? 12 : Self.gap(rows[index - 1], row))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .opacity(session.line == .offline ? 0.45 : 1)
            .overlay {
                if session.log.items.isEmpty, session.outbox.isEmpty {
                    if session.line == .connecting || session.line == .live && session.log.name.isEmpty {
                        ProgressView()
                    } else if session.line == .live {
                        Text("Nothing said here yet")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                composer(session)
            }
        }
    }

    // MARK: the rows

    enum Row: Identifiable {
        case item(ChatItem)
        case queued(ChatQueued)
        case outgoing(ChatSession.Outgoing)
        case typing

        var id: String {
            switch self {
            case .item(let item): item.id
            case .queued(let queued): "queued:\(queued.id)"
            case .outgoing(let outgoing): "out:\(outgoing.id)"
            case .typing: "typing"
            }
        }

        /// Whose it is: runs of the same side sit close, like Messages.
        var side: Int {
            switch self {
            case .item(let item): item.kind == .user ? 0 : item.kind == .note ? 2 : 1
            case .queued, .outgoing: 0
            case .typing: 1
            }
        }
    }

    static func rows(_ session: ChatSession) -> [Row] {
        var rows = session.log.items.map(Row.item)
        // at work: the spinner under what it is on, above what waits
        let writing = session.log.items.last?.pending == true
        if session.log.state == .working, !writing { rows.append(.typing) }
        rows += session.log.queue.map(Row.queued)
        rows += session.outbox.filter { !session.log.holds($0.id) }.map(Row.outgoing)
        return rows
    }

    static func gap(_ before: Row, _ row: Row) -> CGFloat {
        before.side == row.side ? 6 : 16
    }

    // MARK: the field

    @ViewBuilder
    private func composer(_ session: ChatSession) -> some View {
        Group {
            if session.line == .readOnly {
                VStack(spacing: 6) {
                    Text("This iPhone can only read. To send from here, open ruri on your Mac, go to Settings → Devices → Paired devices, and click Allow to send next to this iPhone.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Try Again") { session.reopen() }
                        .font(.footnote)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Message", text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($typing)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 19, style: .continuous)
                                .strokeBorder(Color(.separator), lineWidth: 1)
                        )
                        .accessibilityIdentifier("chat.field")
                    Button {
                        session.send(draft)
                        draft = ""
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                            .symbolRenderingMode(.hierarchical)
                    }
                    .tint(.primary)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier("chat.send")
                    .padding(.bottom, 2)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
        .background(.bar)
    }
}

/// How the chat stands, in the toolbar: a spinner while it works, a raised
/// hand while it waits on you, nothing at rest.
private struct StateMark: View {
    var state: ChatState

    var body: some View {
        switch state {
        case .working:
            WorkingSpinner()
        case .needsYou:
            Image(systemName: "hand.raised")
                .foregroundStyle(.orange)
                .accessibilityLabel("Waiting on you")
        case .idle:
            EmptyView()
        }
    }
}

private struct RowView: View {
    var row: ChatView.Row
    var session: ChatSession

    var body: some View {
        switch row {
        case .item(let item):
            switch item.kind {
            case .user: Bubble(text: item.text, from: item.from)
            case .assistant: Reply(item: item)
            case .steps: Steps(item: item)
            case .note:
                Text(item.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        case .queued(let queued):
            Bubble(text: queued.text, under: "Queued", faded: true)
        case .outgoing(let outgoing):
            Outgoing(outgoing: outgoing, session: session)
        case .typing:
            WorkingSpinner()
                .padding(.vertical, 4)
        }
    }
}

/// The user's prompt, on the right — or another agent's message, named.
private struct Bubble: View {
    var text: String
    var from: String?
    var under: String?
    var faded = false
    var failed = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            if let from {
                Text("From \(from)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            MarkdownText(source: text, font: .body, fill: false)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 13)
                .padding(.vertical, 8)
                .background(Color(.systemGray5), in: .rect(cornerRadius: 18, style: .continuous))
                .opacity(faded ? 0.55 : 1)
            if let under {
                Text(under)
                    .font(.caption2)
                    .foregroundStyle(failed ? .red : .secondary)
            }
        }
        .frame(maxWidth: 300, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// A reply, in full, across the screen — with the spinner while it is
/// still being written.
private struct Reply: View {
    var item: ChatItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownText(source: item.text, font: .body)
                .textSelection(.enabled)
            if item.pending == true { WorkingSpinner() }
        }
    }
}

/// A run of tool calls as one quiet line, each step on a tap.
private struct Steps: View {
    var item: ChatItem
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(item.text)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array((item.steps ?? []).enumerated()), id: \.offset) { _, step in
                        Text(step)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(.leading, 2)
            }
        }
    }
}

/// A prompt sent from here, until the chat has it: sending, queued, or
/// not sent — a tap to try again.
private struct Outgoing: View {
    var outgoing: ChatSession.Outgoing
    var session: ChatSession
    @State private var asking = false

    private var under: String {
        switch outgoing.state {
        case .sending: "Sending…"
        case .sent(.queued): "Queued"
        case .sent: "Sent"
        case .failed: "Not Sent · Tap to Try Again"
        }
    }

    private var failed: Bool {
        if case .failed = outgoing.state { true } else { false }
    }

    var body: some View {
        Bubble(text: outgoing.text, under: under, faded: outgoing.state == .sending, failed: failed)
            .contentShape(.rect)
            .onTapGesture { if failed { asking = true } }
            .confirmationDialog(
                failedWords ?? "", isPresented: $asking, titleVisibility: failedWords == nil ? .hidden : .visible
            ) {
                Button("Try Again") { session.retry(outgoing.id) }
                Button("Delete", role: .destructive) { session.discard(outgoing.id) }
            }
    }

    private var failedWords: String? {
        if case .failed(let why) = outgoing.state { why } else { nil }
    }
}
