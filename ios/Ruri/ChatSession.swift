import Foundation
import Observation

/// One chat's conversation, live while its screen is open, and the prompts
/// sent into it from here.
///
/// The line is opened when the screen shows and the app is in front, and
/// again whenever it drops — at once after a line that was live, then
/// waiting longer each time. Each time it opens the Mac sends the whole
/// recent conversation, so whatever happened while it was down is there.
@MainActor
@Observable
final class ChatSession {
    enum Line: Equatable {
        case connecting
        case live
        /// The Mac can't be reached: what shows is what it last sent.
        case offline
        /// This phone's key reads the status only.
        case readOnly
        /// The chat isn't open on the Mac anymore.
        case gone
    }

    /// A prompt sent from here, until the chat has it.
    struct Outgoing: Identifiable, Equatable {
        enum State: Equatable {
            case sending
            /// Taken: sent now, or queued behind the running turn.
            case sent(SentAs)
            case failed(String)
        }

        var id: String
        var text: String
        var attachments: [Attachment] = []
        /// Sent to cut in on the turn that was running.
        var now = false
        /// A turn was running when it was sent: it is headed for the queue,
        /// and is shown there from the start.
        var behind = false
        var state: State
    }

    let chat: String
    private(set) var log = ChatLog()
    private(set) var line: Line = .connecting
    private(set) var outbox: [Outgoing] = []
    /// Queued prompts this phone has just asked the Mac to send now, until
    /// the Mac's next word on the queue says how they stand.
    private(set) var hurried: Set<String> = []
    /// Queued prompts this phone has just asked the Mac to take out.
    private(set) var dropped: Set<String> = []
    /// Cards this phone has just answered, until the Mac's next word says
    /// they are gone.
    private(set) var answered: Set<String> = []
    /// Something asked of the Mac that it couldn't do, in words to show.
    var problem: String?
    /// When the prompt box was last typed in here: words from another device
    /// don't land on top of what is being written.
    private var typedAt = Date.distantPast
    /// What was typed, on its way to the Mac.
    private var drafting: Task<Void, Never>?
    /// Files clipped on here that the Mac has yet to say its box holds: on
    /// their way, or staying here (a Mac out of reach, or from before boxes
    /// shared their files) to go with the prompt.
    private var attaching: Set<String> = []
    /// Files taken off here, or sent from here, that the Mac's box still
    /// lists: it has yet to hear.
    private var detaching: Set<String> = []
    /// The last word to the Mac on the box's files. Each waits for the one
    /// before, so a file taken off is never heard of before it was clipped
    /// on, and a prompt never goes ahead of the files it names.
    private var filing: Task<Void, Never>?
    /// Counts up when the box's files should be read again though the Mac
    /// said nothing new: something asked of it didn't happen.
    private(set) var boxTurns = 0

    private let model: RuriModel
    /// The computer the chat is on, by its device id: what is on its way
    /// still reaches it should the phone switch to another.
    private let machine: String?
    private var task: Task<Void, Never>?
    /// Attachments already in hand, by id: those sent from here, and those
    /// fetched from the Mac, so a bubble doesn't fetch what it just showed.
    private let files = NSCache<NSString, NSData>()

    /// Made up, for a look at the screen without a Mac: it never opens a line.
    private let made: Bool

    init(chat: String, model: RuriModel) {
        self.chat = chat
        self.model = model
        machine = model.mac?.deviceId
        made = false
    }

    #if DEBUG
    /// A conversation that is only its sample: Xcode's canvas, and the app
    /// run for a look at it (ios/demo/mac.sh).
    init(sample: ChatFrame, model: RuriModel) {
        chat = sample.chat
        self.model = model
        machine = nil
        made = true
        log.apply(sample)
        line = .live
    }

    /// The sample moves on: a frame as the Mac would send one.
    func apply(sample frame: ChatFrame) {
        log.apply(frame)
        settle()
    }
    #endif

    // MARK: the line

    func open() {
        guard !made, task == nil, line != .gone, line != .readOnly else { return }
        task = Task { await stayLive() }
    }

    func close() {
        task?.cancel()
        task = nil
        if line == .live { line = .connecting }
    }

    /// Open it again now: the app came back to the front, or the network
    /// changed under it.
    func reopen() {
        close()
        // a key that read the status only may have been let send since
        if line == .readOnly { line = .connecting }
        open()
    }

    private func stayLive() async {
        var wait: Duration = .seconds(1)
        while !Task.isCancelled {
            do {
                let (client, address, port) = try await model.line(to: machine)
                for try await news in client.chatLive(chat, at: address, port: port) {
                    if case .frame(let frame) = news {
                        log.apply(frame)
                        settle()
                    }
                    // said only when it changes: every word here redraws the chat
                    if line != .live { line = .live }
                    wait = .seconds(1)
                }
                // the Mac closed the line: open it again
                continue
            } catch is CancellationError {
                return
            } catch let error as MacError where error == .readOnly || error == .noChat {
                line = error == .readOnly ? .readOnly : .gone
                task = nil
                return
            } catch {
                if Task.isCancelled { return }
                model.lostTheMac()
                // most drops are only the line: straight back, once
                if line == .live {
                    line = .connecting
                    continue
                }
                line = .offline
            }
            try? await Task.sleep(for: wait)
            wait = min(wait * 2, .seconds(30))
        }
    }

    /// Prompts the chat has taken — said, or in its queue — leave the outbox,
    /// and what was asked of a queued prompt is forgotten once it has gone.
    private func settle() {
        outbox.removeAll { outgoing in
            if case .failed = outgoing.state { return false }
            return log.holds(outgoing.id)
        }
        let waiting = Set(log.queue.map(\.id))
        if !hurried.isSubset(of: waiting) { hurried.formIntersection(waiting) }
        if !dropped.isSubset(of: waiting) { dropped.formIntersection(waiting) }
        let asked = Set(log.asks.map(\.id))
        if !answered.isSubset(of: asked) { answered.formIntersection(asked) }
    }

    // MARK: the cards it waits at

    /// The cards still to answer: those the Mac holds, less the ones just
    /// answered from here.
    var asks: [ChatAsk] { log.asks.filter { !answered.contains($0.id) } }

    /// Allow what a card asks leave for, or refuse it.
    func allow(_ ask: ChatAsk, _ allow: Bool) {
        say(ask, AnswerBody(id: chat, ask: ask.id, allow: allow))
    }

    /// Answer a card's questions, one answer each, in order.
    func answer(_ ask: ChatAsk, _ answers: [ChatAnswered]) {
        say(ask, AnswerBody(id: chat, ask: ask.id, answers: answers))
    }

    /// Wave a question away, unanswered.
    func dismiss(_ ask: ChatAsk) {
        say(ask, AnswerBody(id: chat, ask: ask.id, dismiss: true))
    }

    /// Give a card its answer: it leaves the screen at once, and comes back
    /// with the Mac's reason should the Mac not take it.
    private func say(_ ask: ChatAsk, _ body: AnswerBody) {
        guard !made, !answered.contains(ask.id) else { return }
        answered.insert(ask.id)
        act(undo: { self.answered.remove(ask.id) }) { client, address, port in
            let result = try await client.answer(body, at: address, port: port)
            guard !result.ok else { return }
            // a card that is gone is no trouble: the next frame drops it
            if self.log.asks.contains(where: { $0.id == ask.id }) { self.answered.remove(ask.id) }
            self.problem = result.error ?? "Your Mac didn't take that answer."
        }
    }

    // MARK: sending

    /// Whether a prompt sent now would wait behind a turn.
    var busy: Bool { log.state != .idle }

    /// Send a prompt. With a turn running it waits in the queue behind it —
    /// or, sent `now`, cuts in: the turn stops and this goes in its place.
    func send(_ text: String, attachments: [Attachment] = [], now: Bool = false) {
        let words = Attaching.prompt(text, naming: attachments)
        guard !words.isEmpty else { return }
        for attachment in attachments {
            if let data = attachment.data { files.setObject(data as NSData, forKey: attachment.id as NSString) }
        }
        // they leave the box with the prompt: the Mac takes them out of its
        // own when it takes the prompt, and until it says so they stay gone
        let sent = Set(attachments.map(\.id))
        attaching.subtract(sent)
        detaching.formUnion(sent)
        let outgoing = Outgoing(
            id: UUID().uuidString.lowercased(), text: words, attachments: attachments, now: now && busy,
            behind: busy, state: .sending
        )
        outbox.append(outgoing)
        deliver(outgoing.id)
    }

    // MARK: the prompt box, the same on every device

    /// The box was typed in: the Mac hears it half a second after the typing
    /// pauses, and every window's box takes it.
    func typed(_ text: String) {
        typedAt = .now
        drafting?.cancel()
        guard !made, text != log.draft else {
            drafting = nil
            return
        }
        drafting = Task {
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            do {
                let (client, address, port) = try await model.line(to: machine)
                try await client.draft(text, chat: chat, at: address, port: port)
            } catch {
                // a Mac from before boxes were shared, or one out of reach:
                // the words stay in this phone's box
            }
            if !Task.isCancelled { drafting = nil }
        }
    }

    /// Words another device wrote in the box, for this one to take — nil
    /// while it is being typed in here, or what was typed is still on its
    /// way, or there is nothing new.
    func draftFromElsewhere(replacing current: String) -> String? {
        guard drafting == nil, Date.now.timeIntervalSince(typedAt) > 2, log.draft != current else { return nil }
        return log.draft
    }

    // MARK: the box's files, the same on every device

    /// The files the box shows: what the Mac says it holds, with what this
    /// phone has done since that it has yet to hear of.
    func boxFiles(holding here: [Attachment]) -> [Attachment] {
        let listed = Set(log.draftAttachments.map(\.id))
        // the Mac lists it: it is the box's now, on every device
        attaching.subtract(listed)
        // the Mac no longer lists it: it has heard
        detaching.formIntersection(listed)
        return Attaching.box(mac: log.draftAttachments, here: here, attaching: attaching, detaching: detaching)
    }

    /// A file was clipped on here: the Mac is handed it, and every window's
    /// box shows it. Should the Mac not take it, it stays here and goes
    /// with the prompt.
    func attached(_ attachment: Attachment) {
        guard let data = attachment.data else { return }
        files.setObject(data as NSData, forKey: attachment.id as NSString)
        attaching.insert(attachment.id)
        guard !made else { return }
        file {
            // taken off again before its turn came
            guard self.attaching.contains(attachment.id) else { return }
            guard let (client, address, port) = try? await self.model.line(to: self.machine) else { return }
            try? await client.draft(add: [attachment], chat: self.chat, at: address, port: port)
        }
    }

    /// A file was taken off here: it leaves every window's box. Should the
    /// Mac not hear of one it holds, it comes back, with why.
    func detached(_ attachment: Attachment) {
        let local = attaching.remove(attachment.id) != nil
        detaching.insert(attachment.id)
        guard !made else { return }
        file {
            do {
                let (client, address, port) = try await self.model.line(to: self.machine)
                try await client.draft(remove: [attachment.id], chat: self.chat, at: address, port: port)
            } catch {
                // one that never left this phone is simply gone
                guard !local, self.log.draftAttachments.contains(where: { $0.id == attachment.id }) else { return }
                self.detaching.remove(attachment.id)
                self.boxTurns += 1
                self.problem = "Couldn't reach your Mac: the attachment is still there."
            }
        }
    }

    /// Say something to the Mac about the box's files, after whatever was
    /// said before.
    private func file(_ say: @escaping @MainActor () async -> Void) {
        let before = filing
        filing = Task {
            await before?.value
            await say()
        }
    }

    // MARK: what it has running

    /// One script or agent the chat has running, opened.
    func page(of running: ChatRunning) async throws -> RunningPage {
        #if DEBUG
        // a made-up chat has a made-up page: something to look at
        if made { return .sample }
        #endif
        let (client, address, port) = try await model.line(to: machine)
        return try await client.running(running.key, chat: chat, at: address, port: port)
    }

    // MARK: the queue, and stopping

    /// A queued prompt held down: it goes now, cutting in on a running turn.
    func sendNow(_ id: String) {
        guard !hurried.contains(id), !dropped.contains(id) else { return }
        hurried.insert(id)
        act(undo: { self.hurried.remove(id) }) { client, address, port in
            try await client.queue(QueueBody(id: self.chat, do: .now, itemId: id), at: address, port: port)
        }
    }

    /// Take a prompt out of the queue.
    func remove(_ id: String) {
        guard !dropped.contains(id) else { return }
        dropped.insert(id)
        act(undo: { self.dropped.remove(id) }) { client, address, port in
            try await client.queue(QueueBody(id: self.chat, do: .remove, itemId: id), at: address, port: port)
        }
    }

    /// Send on a queue that has been standing by since a stop.
    func sendOn() {
        act(undo: {}) { client, address, port in
            try await client.queue(QueueBody(id: self.chat, do: .send), at: address, port: port)
        }
    }

    /// Stop the turn that is running. What is queued stands by.
    func stop() {
        act(undo: {}) { client, address, port in
            try await client.stop(self.chat, at: address, port: port)
        }
    }

    /// Ask the Mac for something small; on a failure put the screen back
    /// and say why.
    private func act(
        undo: @escaping @MainActor () -> Void,
        _ ask: @escaping @MainActor (MacClient, String, Int) async throws -> Void
    ) {
        guard !made else { return }
        Task {
            do {
                let (client, address, port) = try await model.line(to: machine)
                try await ask(client, address, port)
            } catch {
                undo()
                switch error as? MacError {
                case .outdated: problem = "Update ruri on your Mac to do this from your iPhone."
                case .noChat: problem = "This chat isn't open anymore."
                case .readOnly, .notPaired: problem = "This iPhone can't do that here."
                default:
                    model.lostTheMac()
                    problem = "Couldn't reach your Mac."
                }
            }
        }
    }

    func retry(_ id: String) {
        guard let at = outbox.firstIndex(where: { $0.id == id }) else { return }
        outbox[at].state = .sending
        deliver(id)
    }

    func discard(_ id: String) {
        // its files never went: any the Mac's box still holds show again
        if let gone = outbox.first(where: { $0.id == id }) {
            detaching.subtract(gone.attachments.map(\.id))
            boxTurns += 1
        }
        outbox.removeAll { $0.id == id }
    }

    /// Hand a prompt to the Mac, trying again over a dropped line: it is
    /// sent under the same id every time, so the Mac runs it once.
    private func deliver(_ id: String) {
        Task {
            // after its files: one still on its way to the Mac's box must
            // land there first, for the prompt to take it out again
            await filing?.value
            var tries = 0
            while let outgoing = outbox.first(where: { $0.id == id }) {
                do {
                    let (client, address, port) = try await model.line(to: machine)
                    // a file the Mac's box holds goes by its id alone
                    let boxed = Set(log.draftAttachments.map(\.id))
                    let files = outgoing.attachments.map { attachment in
                        var named = attachment
                        if boxed.contains(attachment.id) { named.data = nil }
                        return named
                    }
                    let went = try await client.send(
                        outgoing.text, attachments: files, now: outgoing.now, to: chat, id: id,
                        at: address, port: port
                    )
                    mark(id, went == .failed ? .failed("ruri couldn't take it.") : .sent(went))
                    settle()
                    return
                } catch let error as MacError where error == .readOnly || error == .noChat || error == .notPaired {
                    mark(id, .failed(error == .noChat ? "This chat isn't open anymore." : "This iPhone can't send here."))
                    return
                } catch {
                    tries += 1
                    model.lostTheMac()
                    if tries >= 3 {
                        mark(id, .failed("Not sent: the Mac is asleep or offline."))
                        return
                    }
                    try? await Task.sleep(for: .seconds(1.5))
                }
            }
        }
    }

    // MARK: attachments

    /// An attachment's bytes: in hand, or from the Mac.
    func file(_ attachment: ChatAttachment) async throws -> Data {
        if let held = files.object(forKey: attachment.id as NSString) { return held as Data }
        let (client, address, port) = try await model.line(to: machine)
        let data = try await client.attachment(attachment.url, at: address, port: port)
        files.setObject(data as NSData, forKey: attachment.id as NSString)
        return data
    }

    private func mark(_ id: String, _ state: Outgoing.State) {
        guard let at = outbox.firstIndex(where: { $0.id == id }) else { return }
        outbox[at].state = state
    }
}
