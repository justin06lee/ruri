import Foundation

/// Server-sent events, read a byte at a time: GET /status/live sends
/// `event: status` with the report on one `data:` line, a blank line after
/// each, and a `: still here` comment when quiet.
///
/// Bytes are split into lines here rather than with AsyncBytes.lines, which
/// drops the blank lines that end each event.
struct EventStream {
    struct Event: Equatable, Sendable {
        var name: String
        var data: String
    }

    /// What one line meant.
    enum Read: Equatable, Sendable {
        /// Nothing yet: part of an event, or a line still coming.
        case nothing
        /// A comment: the line is still open.
        case comment
        /// An event, whole.
        case event(Event)
    }

    private var line: [UInt8] = []
    private var lastWasCR = false
    private var name = ""
    private var data: [String] = []

    /// The next byte off the line.
    mutating func feed(_ byte: UInt8) -> Read {
        switch byte {
        case UInt8(ascii: "\n") where lastWasCR:
            lastWasCR = false
            return .nothing
        case UInt8(ascii: "\n"), UInt8(ascii: "\r"):
            lastWasCR = byte == UInt8(ascii: "\r")
            let text = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            return take(text)
        default:
            lastWasCR = false
            line.append(byte)
            return .nothing
        }
    }

    /// One whole line.
    mutating func take(_ text: String) -> Read {
        if text.isEmpty {
            defer {
                name = ""
                data = []
            }
            guard !data.isEmpty else { return .nothing }
            return .event(Event(name: name.isEmpty ? "message" : name, data: data.joined(separator: "\n")))
        }
        if text.hasPrefix(":") { return .comment }
        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(text)
            value = ""
        }
        switch field {
        case "event": name = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return .nothing
    }
}
