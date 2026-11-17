import Foundation

// What GET /status answers, and each frame of GET /status/live — the shape
// is shared/protocol.ts's StatusReport. Values ruri adds later are read as
// the nearest one known, so a newer Mac never leaves the phone blank.

/// How a project, or one of its chats, stands.
enum StatusState: String, Codable, Hashable, Sendable {
    case working
    case idle
    case blocked
    case needsYou = "needs-you"

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = StatusState(rawValue: raw) ?? .idle
    }

    /// The word for it, as the screens say it.
    var label: String {
        switch self {
        case .working: "Working"
        case .idle: "Idle"
        case .blocked: "Stopped"
        case .needsYou: "Needs you"
        }
    }
}

/// One of a project's chats.
struct StatusChat: Codable, Hashable, Sendable {
    enum Role: String, Codable, Sendable {
        case lead, teammate, liaison

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Role(rawValue: raw) ?? .teammate
        }
    }

    var name: String
    var role: Role
    /// A teammate's duty, when it has one.
    var duty: String?
    var state: StatusState
    /// At work: what its turn is on.
    var doing: String?
    /// What it waits on the user for, else its last reply — trimmed.
    var lastWords: String
    /// When its last turn ended.
    var lastActive: Date?
    /// The chat's id (asked for with ?ids=1): what its conversation is read by.
    var id: String?
}

/// Something waiting on the user.
struct StatusNeed: Codable, Hashable, Sendable {
    enum Reason: String, Codable, Sendable {
        case question, card, error

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Reason(rawValue: raw) ?? .question
        }
    }

    var project: String
    /// The chat waiting: "Lead", a teammate's name.
    var who: String
    var reason: Reason
    var text: String
    var since: Date
    /// With ?ids=1: the chat waiting.
    var chatId: String?
}

/// A project.
struct StatusProject: Codable, Hashable, Sendable, Identifiable {
    var name: String
    var state: StatusState
    /// One line: what needs the user, what stopped, who is at work on what,
    /// or — at rest — the lead's last words.
    var doingNow: String
    /// Working: since the stretch began; needs you: since it waits;
    /// otherwise when it was last active.
    var since: Date?
    var lead: StatusChat?
    /// Its teammates, and its liaison once it has one.
    var team: [StatusChat]
    /// Starred in the sidebar.
    var starred: Bool?
    /// How the Mac knows it (asked for with ?ids=1): what the sidebar's
    /// layout names it by.
    var macId: String?

    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, state, doingNow, since, lead, team, starred
        case macId = "id"
    }
}

/// The sidebar as the Mac arranges it: the top level in order — folders and
/// the projects in none, by id — and each folder's projects.
/// (shared/sidebar.ts's SidebarLayout.)
struct SidebarLayout: Codable, Hashable, Sendable {
    struct Folder: Codable, Hashable, Sendable, Identifiable {
        var id: String
        var name: String
        var collapsed: Bool?
        var projects: [String]
    }

    var order: [String]
    var folders: [Folder]

    func folder(_ id: String) -> Folder? { folders.first { $0.id == id } }

    /// The folder a project is in, if any.
    func folder(holding project: String) -> Folder? { folders.first { $0.projects.contains(project) } }

    /// Something put somewhere, as the Mac does it (moveInLayout): a project
    /// into `folder` (else the top level), before `before` there (else at
    /// the end); a folder only ever along the top level. Anything that
    /// doesn't make sense changes nothing.
    func moving(_ id: String, into folder: String? = nil, before: String? = nil) -> SidebarLayout {
        let isFolder = folders.contains { $0.id == id }
        guard isFolder || order.contains(id) || self.folder(holding: id) != nil, before != id else { return self }
        let into = isFolder ? nil : folder
        if let into, self.folder(into) == nil { return self }
        var order = order.filter { $0 != id }
        var folders = folders.map { folder in
            var folder = folder
            folder.projects.removeAll { $0 == id }
            return folder
        }
        func put(_ list: inout [String]) {
            if let before, let at = list.firstIndex(of: before) { list.insert(id, at: at) } else { list.append(id) }
        }
        if let into, let at = folders.firstIndex(where: { $0.id == into }) {
            put(&folders[at].projects)
        } else {
            put(&order)
        }
        folders.sort { (order.firstIndex(of: $0.id) ?? .max) < (order.firstIndex(of: $1.id) ?? .max) }
        return SidebarLayout(order: order, folders: folders)
    }

    func folding(_ id: String, _ collapsed: Bool) -> SidebarLayout {
        var layout = self
        if let at = layout.folders.firstIndex(where: { $0.id == id }) { layout.folders[at].collapsed = collapsed }
        return layout
    }
}

/// Every open project's state, and what needs the user.
struct StatusReport: Codable, Hashable, Sendable {
    /// The Mac's name.
    var computer: String
    /// When it was read.
    var at: Date
    /// Oldest first.
    var needsYou: [StatusNeed]
    /// Those needing the user first, then stopped, at work, at rest.
    var projects: [StatusProject]
    /// With ?ids=1, from a Mac that keeps one: how its sidebar is arranged.
    var sidebar: SidebarLayout?

    func project(named name: String) -> StatusProject? {
        projects.first { $0.name == name }
    }

    func needs(of project: String) -> [StatusNeed] {
        needsYou.filter { $0.project == project }
    }
}

extension StatusReport {
    /// ruri writes its times as JavaScript does — ISO 8601, milliseconds
    /// and all — which JSONDecoder's own .iso8601 won't read.
    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) {
                return date
            }
            if let date = try? Date.ISO8601FormatStyle().parse(text) { return date }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "not an ISO 8601 date: \(text)")
            )
        }
        return decoder
    }

    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}
