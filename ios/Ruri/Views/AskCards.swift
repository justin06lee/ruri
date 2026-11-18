import SwiftUI

/// The cards a chat waits at, over the prompt field: leave to use a tool
/// or to message another chat, allowed or refused; a question, answered.
/// The oldest shows, with how many wait behind it — answering one brings
/// the next.
struct AskDock: View {
    var session: ChatSession
    @Environment(\.palette) private var palette

    var body: some View {
        let asks = session.asks
        if let ask = asks.first {
            VStack(alignment: .leading, spacing: 6) {
                if asks.count > 1 {
                    Text("\(asks.count - 1) more waiting on you")
                        .font(.ruri(.caption))
                        .foregroundStyle(palette.inkFaint)
                        .padding(.leading, 6)
                }
                Group {
                    if ask.onMac == true {
                        OnMacCard(ask: ask)
                    } else if ask.kind == .question {
                        QuestionCard(ask: ask, session: session)
                    } else {
                        LeaveCard(ask: ask, session: session)
                    }
                }
                // each card keeps what was picked and typed as its own
                .id(ask.id)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("ask.dock")
        }
    }
}

/// What a card sits on: glass where the system has it, the theme's raised
/// shade before.
private struct AskSurface<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glass(RoundedRectangle(cornerRadius: 20, style: .continuous), interactive: false, fallback: palette.paperDim)
    }
}

/// The line over a card: what kind it is, and who asks.
private struct AskHead: View {
    var symbol: String
    var words: String
    var byAgent: Bool
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
            Text(byAgent ? "\(words) · asked by your agent" : words)
                .font(.ruri(.caption, .medium))
                .lineLimit(1)
        }
        .foregroundStyle(palette.inkSoft)
    }
}

/// Leave to use a tool, or to send a message: what it would do, in full
/// behind a tap, and the two answers.
private struct LeaveCard: View {
    var ask: ChatAsk
    var session: ChatSession
    @Environment(\.palette) private var palette
    @State private var whole = false

    private var message: Bool { ask.kind == .message }

    var body: some View {
        AskSurface {
            AskHead(
                symbol: message ? "paperplane" : "hand.raised",
                words: message ? "Wants to send a message" : "Wants to use a tool",
                byAgent: ask.byAgent == true
            )
            Text(ask.title)
                .font(.ruri(.body, .medium))
                .foregroundStyle(palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            if let detail = ask.detail, !detail.isEmpty {
                let words = Text(detail)
                    .font(message ? .ruri(.callout) : .ruriMono(.callout))
                    .foregroundStyle(palette.ink)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                Button {
                    whole.toggle()
                } label: {
                    Group {
                        if whole {
                            // all of it, in a box that scrolls once it is long
                            Fitted(height: 240) { words }
                        } else {
                            words.lineLimit(4)
                        }
                    }
                    .background(palette.fill, in: .rect(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityHint(whole ? "Shows less" : "Shows it all")
                .accessibilityIdentifier("ask.detail")
            }
            HStack(spacing: 10) {
                Button(message ? "Don't Send" : "Deny") { session.allow(ask, false) }
                    .buttonStyle(QuietButton())
                    .accessibilityIdentifier("ask.deny")
                Button(message ? "Send It" : "Allow") { session.allow(ask, true) }
                    .buttonStyle(PrimaryButton())
                    .accessibilityIdentifier("ask.allow")
            }
        }
    }
}

/// A question the phone can't take: a page to open, or a secret to type.
private struct OnMacCard: View {
    var ask: ChatAsk
    @Environment(\.palette) private var palette

    var body: some View {
        AskSurface {
            AskHead(symbol: "questionmark.bubble", words: "Asks a question", byAgent: ask.byAgent == true)
            Text(ask.title)
                .font(.ruri(.body, .medium))
                .foregroundStyle(palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Label("Answer this one on your Mac.", systemImage: "desktopcomputer")
                .font(.ruri(.footnote))
                .foregroundStyle(palette.inkSoft)
        }
    }
}

/// A card of questions, one on screen at a time: pick from what is
/// offered, or type words of one's own; the last one sends them all.
private struct QuestionCard: View {
    var ask: ChatAsk
    var session: ChatSession
    @Environment(\.palette) private var palette
    @State private var answers: [ChatAnswered] = []
    @State private var at = 0
    @State private var typing: Set<Int> = []
    @FocusState private var focused: Bool

    private var questions: [ChatQuestion] { ask.questions ?? [] }

    /// Whether the question on screen has what it needs to move on.
    private func done(_ index: Int) -> Bool {
        guard questions.indices.contains(index), answers.indices.contains(index) else { return false }
        return questions[index].optional == true || answers[index].given
    }

    var body: some View {
        AskSurface {
            HStack {
                AskHead(
                    symbol: "questionmark.bubble",
                    words: questions.count > 1 ? "Question \(at + 1) of \(questions.count)" : "Asks a question",
                    byAgent: ask.byAgent == true
                )
                Spacer(minLength: 8)
                Button {
                    session.dismiss(ask)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(palette.inkSoft)
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .accessibilityLabel("Dismiss the question")
                .accessibilityIdentifier("ask.dismiss")
            }
            if questions.indices.contains(at), answers.indices.contains(at) {
                // many options stay on a screen with the keyboard up
                Fitted(height: 300) { one(questions[at], at) }
            }
            HStack(spacing: 10) {
                if at > 0 {
                    Button("Back") { at -= 1 }
                        .buttonStyle(QuietButton())
                }
                Button(at < questions.count - 1 ? "Next" : "Send") {
                    if at < questions.count - 1 {
                        at += 1
                    } else {
                        focused = false
                        session.answer(ask, answers)
                    }
                }
                .buttonStyle(PrimaryButton())
                .disabled(!done(at) || (at == questions.count - 1 && !questions.indices.allSatisfy(done)))
                .accessibilityIdentifier("ask.send")
            }
        }
        .onAppear {
            if answers.count != questions.count {
                answers = questions.map { _ in ChatAnswered() }
                // a question with nothing to pick from is typed from the start
                typing = Set(questions.indices.filter { questions[$0].options.isEmpty })
            }
        }
    }

    @ViewBuilder
    private func one(_ question: ChatQuestion, _ index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                if !question.header.isEmpty {
                    Text(question.header)
                        .font(.ruri(.caption, .medium))
                        .foregroundStyle(palette.inkFaint)
                }
                Text(question.question)
                    .font(.ruri(.body, .medium))
                    .foregroundStyle(palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                if let hint = question.hint, !hint.isEmpty {
                    Text(hint)
                        .font(.ruri(.footnote))
                        .foregroundStyle(palette.inkSoft)
                }
            }
            VStack(spacing: 0) {
                ForEach(question.options, id: \.label) { option in
                    OptionRow(
                        label: option.label, detail: option.description,
                        on: answers[index].picked.contains(option.label), multi: question.multi
                    ) { pick(option.label, question, index) }
                }
                if question.other, !question.options.isEmpty {
                    OptionRow(
                        label: "Other", detail: "Answer in your own words",
                        on: typing.contains(index), multi: question.multi
                    ) { own(question, index) }
                }
            }
            .background(palette.fill, in: .rect(cornerRadius: 14, style: .continuous))
            .clipShape(.rect(cornerRadius: 14, style: .continuous))
            if typing.contains(index) {
                TextField(
                    "Your answer…",
                    text: Binding { answers[index].other ?? "" } set: { answers[index].other = $0 },
                    axis: .vertical
                )
                .lineLimit(1...4)
                .font(.ruri(.body))
                .keyboardType(question.number == true ? .decimalPad : .default)
                .focused($focused)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(palette.fill, in: .rect(cornerRadius: 14, style: .continuous))
                .accessibilityIdentifier("ask.other")
            }
        }
    }

    /// An option tapped: one answer takes its place, several are added to
    /// or taken from.
    private func pick(_ label: String, _ question: ChatQuestion, _ index: Int) {
        if question.multi {
            if let was = answers[index].picked.firstIndex(of: label) {
                answers[index].picked.remove(at: was)
            } else {
                answers[index].picked.append(label)
            }
            return
        }
        answers[index].picked = [label]
        // words of one's own stood in for the options: they give way
        typing.remove(index)
        answers[index].other = nil
    }

    /// "Other" tapped: a box for words of one's own, which stand in for the
    /// options of a question that takes one answer.
    private func own(_ question: ChatQuestion, _ index: Int) {
        if typing.contains(index) {
            typing.remove(index)
            answers[index].other = nil
            return
        }
        typing.insert(index)
        if !question.multi { answers[index].picked = [] }
        focused = true
    }
}

/// What is in it at its own height, until that is more than `height`:
/// then that tall, and scrolling.
private struct Fitted<Content: View>: View {
    var height: CGFloat
    @ViewBuilder var content: Content
    /// How tall what is in it is, once it has been laid out.
    @State private var tall: CGFloat = 1

    var body: some View {
        ScrollView {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tall = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(height: min(max(tall, 1), height))
    }
}

/// One thing to pick: its mark, its words, and a line under them.
private struct OptionRow: View {
    var label: String
    var detail: String?
    var on: Bool
    var multi: Bool
    var tap: () -> Void
    @Environment(\.palette) private var palette

    private var mark: String {
        if multi { return on ? "checkmark.square.fill" : "square" }
        return on ? "largecircle.fill.circle" : "circle"
    }

    var body: some View {
        Button(action: tap) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: mark)
                    .font(.system(size: 16))
                    .foregroundStyle(on ? palette.accent : palette.inkFaint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(.ruri(.callout, .medium))
                        .foregroundStyle(palette.ink)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.ruri(.footnote))
                            .foregroundStyle(palette.inkSoft)
                    }
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .padding(.vertical, 4)
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
