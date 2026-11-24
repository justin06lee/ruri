import SwiftUI

/// The foot of a chat: what is queued, standing over the field a prompt is
/// written in — the Mac's composer, made for a thumb.
///
/// A tap on the arrow sends; with a turn running the prompt waits in the
/// queue behind it. Held, the arrow cuts in: the turn stops and the prompt
/// goes in its place, as holding Enter does on the Mac. With nothing
/// written while a turn runs, the arrow is a stop.
struct Composer: View {
    var session: ChatSession
    var placeholder: String
    /// A prompt went out: the conversation should show its end.
    var sent: () -> Void

    @Environment(\.palette) private var palette
    @State private var draft = ""
    @State private var attachments = AttachmentPicking()
    @State private var editing = false

    /// A turn is running — at work, or waiting on a card: a prompt sent now
    /// would wait behind it.
    private var working: Bool { session.busy }

    private var empty: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.ready.isEmpty
    }

    /// Nothing written while a turn runs: the button stops the turn.
    private var stops: Bool { empty && working && attachments.loading == 0 }

    var body: some View {
        VStack(spacing: 8) {
            AskDock(session: session)
            QueueDock(session: session)
            if let problem = session.problem {
                Notice(text: problem) { session.problem = nil }
            }
            box
        }
        .glassGroup()
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background {
            // the conversation fades out under the field rather than
            // stopping at a line
            LinearGradient(
                stops: [.init(color: palette.paper.opacity(0), location: 0), .init(color: palette.paper, location: 0.35)],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
        }
        // the box is the same on every device: what is typed here goes out,
        // and what was typed elsewhere comes in when nobody is typing here
        .onChange(of: draft) { _, now in
            if now != session.log.draft { session.typed(now) }
        }
        .onChange(of: session.log.draft, initial: true) {
            if let words = session.draftFromElsewhere(replacing: draft) { draft = words }
        }
        // and so are its files: one clipped on here is handed to the Mac,
        // and one clipped on or taken off elsewhere shows or goes here
        .onChange(of: session.log.draftAttachments, initial: true) {
            attachments.take(session.boxFiles(holding: attachments.ready))
        }
        .onChange(of: session.boxTurns) {
            attachments.take(session.boxFiles(holding: attachments.ready))
        }
        .onAppear {
            attachments.added = { session.attached($0) }
        }
        .animation(.snappy(duration: 0.25), value: session.log.queue)
        .animation(.snappy(duration: 0.25), value: session.problem)
        #if DEBUG
        .task { await attachments.attachForTest() }
        #endif
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 6) {
            AttachmentStrip(picking: attachments, session: session) { gone in
                session.detached(gone)
                // words that pointed at it would point at nothing
                draft = Attaching.without(gone.marker, in: draft)
            }
            PromptField(
                text: $draft, placeholder: placeholder, palette: palette, editing: $editing,
                pasted: { providers in Task { await attachments.load(providers: providers) } },
                submit: { send(now: false) }
            )
            HStack(spacing: 10) {
                AttachButton(picking: attachments)
                // the model this chat runs on, where the Mac's box has it
                ModelMenu(chat: session.chat)
                Spacer(minLength: 0)
                if working, !empty {
                    Text("Hold to send now")
                        .font(.ruri(.caption))
                        .foregroundStyle(palette.inkFaint)
                        .transition(.opacity)
                }
                sendButton
            }
        }
        .padding(.top, 10)
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.bottom, 8)
        .fieldSurface(palette)
        .animation(.snappy(duration: 0.2), value: working && !empty)
    }

    private var sendButton: some View {
        HoldButton(
            holds: working && !empty,
            enabled: stops || (!empty && attachments.loading == 0),
            tap: { stops ? session.stop() : send(now: false) },
            hold: { send(now: true) }
        ) { pressed, progress in
            let live = stops || !empty
            ZStack {
                // the one control that leads is solid ink, as the system's
                // own send is solid; with nothing to send it is clear glass
                if live {
                    Circle().fill(palette.ink)
                } else {
                    Color.clear.glass(Circle(), fallback: palette.fill)
                }
                Image(systemName: stops ? "stop.fill" : "arrow.up")
                    .font(.system(size: stops ? 12 : 15, weight: .bold))
                    .foregroundStyle(live ? palette.paper : palette.inkFaint)
                // the hold, filling round the button
                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(palette.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(-4)
                    .opacity(progress > 0 ? 1 : 0)
            }
            .frame(width: 34, height: 34)
            .scaleEffect(pressed ? 0.9 : 1)
            .animation(.snappy(duration: 0.15), value: pressed)
            // a thumb's worth of room round a small mark
            .frame(width: 44, height: 44)
        }
        .accessibilityElement()
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(stops ? "Stop" : "Send")
        .accessibilityHint(working && !empty ? "Hold to send now, stopping the turn that is running." : "")
        .accessibilityAction { stops ? session.stop() : send(now: false) }
        .accessibilityAction(named: "Send Now") { send(now: true) }
        .accessibilityIdentifier("chat.send")
    }

    private func send(now: Bool) {
        guard !empty, attachments.loading == 0 else { return }
        session.send(draft, attachments: attachments.ready, now: now)
        draft = ""
        attachments.clear()
        sent()
    }
}

extension View {
    /// The field's surface: glass where the system has it, else a raised
    /// sheet with the Mac's soft edge.
    @ViewBuilder
    func fieldSurface(_ palette: Palette, radius: CGFloat = 24) -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular, in: .rect(cornerRadius: radius, style: .continuous))
        } else {
            background(palette.raised, in: .rect(cornerRadius: radius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(palette.hairline, lineWidth: 0.5)
                }
                .shadow(color: .black.opacity(palette.dark ? 0.3 : 0.07), radius: 10, y: 2)
        }
    }
}

/// What is waiting in the chat's queue, newest last, over the field. Each
/// card held down goes now; its cross takes it out.
private struct QueueDock: View {
    var session: ChatSession
    @Environment(\.palette) private var palette

    /// How many cards show before the rest are only counted.
    private let shown = 3

    /// Prompts on their way to the queue, then those the Mac holds in it.
    private var cards: [QueuedCard.Model] {
        let held = session.log.queue.filter { !session.dropped.contains($0.id) }.map { queued in
            QueuedCard.Model(
                id: queued.id, text: queued.text, files: queued.attachments?.count ?? 0,
                state: queued.now == true || session.hurried.contains(queued.id) ? .going : .waiting
            )
        }
        let coming = session.outbox.filter { $0.behind && !session.log.holds($0.id) }.compactMap { outgoing in
            if case .failed = outgoing.state { return nil as QueuedCard.Model? }
            return QueuedCard.Model(
                id: outgoing.id, text: outgoing.text, files: outgoing.attachments.count,
                state: outgoing.now ? .going : .sending
            )
        }
        return held + coming
    }

    var body: some View {
        let cards = cards
        if !cards.isEmpty {
            VStack(alignment: .trailing, spacing: 6) {
                if session.log.held {
                    HStack(spacing: 10) {
                        Text("The queue is standing by since the stop.")
                            .font(.ruri(.footnote))
                            .foregroundStyle(palette.inkSoft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Send") { session.sendOn() }
                            .font(.ruri(.footnote, .medium))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 32)
                            .glass(Capsule(), fallback: palette.fill)
                            .foregroundStyle(palette.ink)
                            .accessibilityIdentifier("queue.send")
                    }
                    .padding(.leading, 6)
                }
                if cards.count > shown {
                    Text("\(cards.count - shown) more waiting")
                        .font(.ruri(.caption))
                        .foregroundStyle(palette.inkFaint)
                        .padding(.trailing, 6)
                }
                ForEach(cards.suffix(shown)) { card in
                    QueuedCard(card: card, session: session)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

/// One queued prompt: its words in a line or two, and how it stands. Held
/// down it goes now, the hold filling across it.
private struct QueuedCard: View {
    struct Model: Identifiable, Equatable {
        enum Standing: Equatable {
            /// Still on its way to the Mac.
            case sending
            case waiting
            /// Cutting in: it goes the moment the running turn has stopped.
            case going
        }

        var id: String
        var text: String
        var files: Int
        var state: Standing
    }

    var card: Model
    var session: ChatSession
    @Environment(\.palette) private var palette

    private var words: String {
        let said = Attaching.afterMarkers(card.text)
        if !said.isEmpty { return said }
        return card.files == 1 ? "1 attachment" : "\(card.files) attachments"
    }

    private var label: String {
        switch card.state {
        case .sending: "Sending…"
        case .waiting: "Queued · hold to send now"
        case .going: "Sending now…"
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 4) {
            HoldButton(holds: card.state == .waiting, hold: { session.sendNow(card.id) }) { pressed, progress in
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(.ruri(.caption))
                        .foregroundStyle(palette.inkSoft)
                    Text(words)
                        .font(.ruri(.callout))
                        .foregroundStyle(palette.ink)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 9)
                .padding(.leading, 14)
                .opacity(pressed ? 0.7 : 1)
                .background(alignment: .leading) {
                    // the hold, filling from the left
                    GeometryReader { box in
                        palette.fill.frame(width: box.size.width * progress)
                    }
                    .padding(.trailing, -44)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAction(named: "Send Now") { session.sendNow(card.id) }
            .accessibilityIdentifier("queue.card")
            if card.state == .waiting {
                Button {
                    session.remove(card.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(palette.inkSoft)
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Remove from the queue")
                .accessibilityIdentifier("queue.remove")
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 44, height: 44)
            }
        }
        .clipShape(.rect(cornerRadius: 18, style: .continuous))
        .glass(RoundedRectangle(cornerRadius: 18, style: .continuous), fallback: palette.paperDim)
        .frame(maxWidth: 320, alignment: .trailing)
    }
}

/// A line saying something couldn't be done, put away with a tap.
private struct Notice: View {
    var text: String
    var dismiss: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button(action: dismiss) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.circle")
                Text(text)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
            }
            .font(.ruri(.footnote))
            .foregroundStyle(palette.inkSoft)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .glass(RoundedRectangle(cornerRadius: 14, style: .continuous), interactive: false, fallback: palette.paperDim)
        }
        .buttonStyle(.plain)
        .transition(.opacity)
        .task(id: text) {
            // it says its piece, then goes
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { dismiss() }
        }
    }
}
