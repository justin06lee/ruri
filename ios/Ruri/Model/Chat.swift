import Foundation

// What GET /chat answers, and each frame of GET /chat/live — the shapes are
// shared/protocol.ts's PhoneChatFrame and PhoneChatItem (server/phoneChat.ts).

/// Something attached to a prompt, as the Mac has it on file.
struct ChatAttachment: Codable, Hashable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case image
        case video
        case file

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .file
        }
    }

    var id: String
    var kind: Kind
    var mediaType: String
    var name: String
    var n: Int
    /// Where the Mac serves it. Empty until the Mac has it.
    var url: String
}

/// One thing said in a chat.
struct ChatItem: Codable, Hashable, Sendable, Identifiable {
    enum Kind: String, Codable, Sendable {
        /// The user's prompt — or another agent's message, with `from`.
        case user
        case assistant
        /// A run of tool calls, folded into one line.
        case steps
        /// ruri's own line: a turn stopped, or on an error.
        case note

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Kind(rawValue: raw) ?? .note
        }
    }

    var id: String
    var kind: Kind
    var text: String
    var steps: [String]?
    var from: String?
    var at: Date
    /// The reply still being written.
    var pending: Bool?
    var attachments: [ChatAttachment]?
}

/// A prompt waiting in the chat's queue, by the id it was sent with.
struct ChatQueued: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var text: String
    var attachments: [ChatAttachment]?
}

/// How the chat stands.
enum ChatState: String, Codable, Sendable {
    case working
    case needsYou = "needs-you"
    case idle

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ChatState(rawValue: raw) ?? .idle
    }
}

/// One frame: the whole conversation (`items`), or what changed in it.
struct ChatFrame: Codable, Sendable {
    var chat: String
    var name: String
    var project: String
    var state: ChatState
    var queue: [ChatQueued]
    var items: [ChatItem]?
    var upsert: [ChatItem]?
    var remove: [String]?
}

/// Where a prompt sent went.
enum SentAs: String, Codable, Sendable {
    /// Sent now: the chat is on it.
    case event
    /// Behind the turn that is running.
    case queued
    case other
    case failed

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SentAs(rawValue: raw) ?? .other
    }
}

struct SendAnswer: Codable, Sendable {
    var `as`: SentAs
}

/// A chat's conversation as the phone holds it, frames applied in order.
struct ChatLog: Equatable, Sendable {
    var name = ""
    var project = ""
    var state: ChatState = .idle
    var queue: [ChatQueued] = []
    private(set) var items: [ChatItem] = []

    /// Take one frame: the whole list replaces what is held; otherwise what
    /// is gone goes, what changed changes in place, and what is new goes
    /// after the rest.
    mutating func apply(_ frame: ChatFrame) {
        name = frame.name
        project = frame.project
        state = frame.state
        queue = frame.queue
        if let whole = frame.items {
            items = whole
            return
        }
        if let gone = frame.remove, !gone.isEmpty {
            let set = Set(gone)
            items.removeAll { set.contains($0.id) }
        }
        for item in frame.upsert ?? [] {
            if let at = items.firstIndex(where: { $0.id == item.id }) {
                items[at] = item
            } else {
                items.append(item)
            }
        }
    }

    /// Whether the chat has taken a prompt by this id: said, or queued.
    func holds(_ id: String) -> Bool {
        items.contains { $0.id == id } || queue.contains { $0.id == id }
    }
}

/// What POST /chat/send carries.
struct SendBody: Encodable, Sendable {
    var id: String
    var text: String
    var clientId: String
    var attachments: [Attachment]?
}
