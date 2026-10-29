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
        var state: State
    }

    let chat: String
    private(set) var log = ChatLog()
    private(set) var line: Line = .connecting
    private(set) var outbox: [Outgoing] = []

    private let model: RuriModel
    private var task: Task<Void, Never>?

    init(chat: String, model: RuriModel) {
        self.chat = chat
        self.model = model
    }

    // MARK: the line

    func open() {
        guard task == nil, line != .gone, line != .readOnly else { return }
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
        open()
    }

    private func stayLive() async {
        var wait: Duration = .seconds(1)
        while !Task.isCancelled {
            do {
                let (client, address, port) = try await model.line()
                for try await news in client.chatLive(chat, at: address, port: port) {
                    if case .frame(let frame) = news {
                        log.apply(frame)
                        settle()
                    }
                    line = .live
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

    /// Prompts the chat has taken — said, or in its queue — leave the outbox.
    private func settle() {
        outbox.removeAll { outgoing in
            if case .failed = outgoing.state { return false }
            return log.holds(outgoing.id)
        }
    }

    // MARK: sending

    func send(_ text: String) {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        let outgoing = Outgoing(id: UUID().uuidString.lowercased(), text: words, state: .sending)
        outbox.append(outgoing)
        deliver(outgoing.id)
    }

    func retry(_ id: String) {
        guard let at = outbox.firstIndex(where: { $0.id == id }) else { return }
        outbox[at].state = .sending
        deliver(id)
    }

    func discard(_ id: String) {
        outbox.removeAll { $0.id == id }
    }

    /// Hand a prompt to the Mac, trying again over a dropped line: it is
    /// sent under the same id every time, so the Mac runs it once.
    private func deliver(_ id: String) {
        Task {
            var tries = 0
            while let outgoing = outbox.first(where: { $0.id == id }) {
                do {
                    let (client, address, port) = try await model.line()
                    let went = try await client.send(outgoing.text, to: chat, id: id, at: address, port: port)
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

    private func mark(_ id: String, _ state: Outgoing.State) {
        guard let at = outbox.firstIndex(where: { $0.id == id }) else { return }
        outbox[at].state = state
    }
}
