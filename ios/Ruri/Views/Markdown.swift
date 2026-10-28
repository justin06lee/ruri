import SwiftUI

/// One block of a message written in markdown.
enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    /// `depth` counts nesting (0 is the outer list); `number` is nil for a bullet.
    case item(depth: Int, number: Int?, text: String)
    case code(language: String?, text: String)
    case quote(String)
    case rule
}

/// Splits markdown into its blocks. Small on purpose: headings, paragraphs,
/// bullet and numbered lists, fenced code, quotes and rules — what agents
/// write. Inline styles (bold, italic, code, links) stay in the text and are
/// read by `MarkdownBlock.attributed`.
enum MarkdownParser {
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")[...]

        func flush() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
            if !quote.isEmpty {
                blocks.append(.quote(quote.joined(separator: "\n")))
                quote = []
            }
        }

        while let line = lines.popFirst() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if let fence = fenceOpening(trimmed) {
                flush()
                var code: [String] = []
                let indent = line.prefix(while: { $0 == " " }).count
                while let next = lines.popFirst() {
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix(fence.marker) { break }
                    code.append(String(next.dropFirst(min(indent, next.prefix(while: { $0 == " " }).count))))
                }
                blocks.append(.code(language: fence.language, text: code.joined(separator: "\n")))
            } else if trimmed.isEmpty {
                flush()
            } else if let heading = heading(trimmed) {
                flush()
                blocks.append(heading)
            } else if isRule(trimmed) {
                flush()
                blocks.append(.rule)
            } else if let item = listItem(line) {
                flush()
                blocks.append(item)
            } else if trimmed.hasPrefix(">") {
                if paragraph.isEmpty == false { flush() }
                quote.append(String(trimmed.dropFirst().drop(while: { $0 == " " })))
            } else if !quote.isEmpty {
                flush()
                paragraph.append(trimmed)
            } else if case .item(let depth, let number, let text)? = blocks.last, paragraph.isEmpty,
                      line.hasPrefix(" "), !text.isEmpty {
                // A wrapped line belonging to the list item above.
                blocks[blocks.count - 1] = .item(depth: depth, number: number, text: text + "\n" + trimmed)
            } else {
                paragraph.append(trimmed)
            }
        }
        flush()
        return blocks
    }

    private static func fenceOpening(_ line: String) -> (marker: String, language: String?)? {
        for marker in ["```", "~~~"] where line.hasPrefix(marker) {
            let language = line.drop(while: { $0 == marker.first }).trimmingCharacters(in: .whitespaces)
            return (marker, language.isEmpty ? nil : language)
        }
        return nil
    }

    private static func heading(_ line: String) -> MarkdownBlock? {
        let hashes = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let rest = line.dropFirst(hashes)
        guard rest.first == " " else { return nil }
        return .heading(level: hashes, text: rest.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let stripped = line.filter { $0 != " " }
        guard stripped.count >= 3, let first = stripped.first, "-*_".contains(first) else { return false }
        return stripped.allSatisfy { $0 == first }
    }

    private static func listItem(_ line: String) -> MarkdownBlock? {
        let spaces = line.prefix(while: { $0 == " " || $0 == "\t" })
        let width = spaces.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let rest = line.dropFirst(spaces.count)
        let depth = min(width / 2, 4)
        if let marker = rest.first, "-*+".contains(marker), rest.dropFirst().first == " " {
            return .item(depth: depth, number: nil, text: rest.dropFirst(2).trimmingCharacters(in: .whitespaces))
        }
        let digits = rest.prefix(while: \.isNumber)
        if (1...9).contains(digits.count), let number = Int(digits) {
            let after = rest.dropFirst(digits.count)
            if let dot = after.first, ".)".contains(dot), after.dropFirst().first == " " {
                return .item(depth: depth, number: number, text: after.dropFirst(2).trimmingCharacters(in: .whitespaces))
            }
        }
        return nil
    }
}

extension MarkdownBlock {
    /// The block's text with its inline styles read — bold, italic, code,
    /// strikethrough and links — and everything else as written.
    static func attributed(_ text: String) -> AttributedString {
        var result = (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
        for run in result.runs {
            guard let intent = run.inlinePresentationIntent, intent.contains(.code) else { continue }
            result[run.range].font = .system(.subheadline, design: .monospaced)
            result[run.range].backgroundColor = Color(.tertiarySystemFill)
        }
        return result
    }

    /// Plain words for a collapsed view: styles kept, blocks flattened to
    /// lines — list items with their marker, code as it is.
    var flattened: AttributedString {
        switch self {
        case .heading(_, let text):
            var heading = Self.attributed(text)
            heading.inlinePresentationIntent = .stronglyEmphasized
            return heading
        case .paragraph(let text), .quote(let text):
            return Self.attributed(text)
        case .item(_, let number, let text):
            return AttributedString((number.map { "\($0). " } ?? "• ")) + Self.attributed(text)
        case .code(_, let text):
            var code = AttributedString(text)
            code.font = .system(.subheadline, design: .monospaced)
            return code
        case .rule:
            return AttributedString()
        }
    }
}

/// A message rendered from markdown: block by block when `whole`, or as a
/// few flattened lines (`lineLimit`) otherwise. Links open in the browser.
struct MarkdownText: View {
    var source: String
    var whole = true
    var lineLimit: Int?
    var font: Font = .subheadline
    /// Across the whole width; false hugs the text, for a bubble.
    var fill = true

    var body: some View {
        let blocks = MarkdownParser.parse(source)
        if whole {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    MarkdownBlockView(block: block, font: font)
                }
            }
            .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
        } else {
            Text(blocks.reduce(into: AttributedString()) { result, block in
                if !result.characters.isEmpty { result += AttributedString("\n") }
                result += block.flattened
            })
            .font(font)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct MarkdownBlockView: View {
    var block: MarkdownBlock
    var font: Font

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(MarkdownBlock.attributed(text))
                .font(level == 1 ? .headline : .subheadline.weight(.semibold))
                .padding(.top, 2)
        case .paragraph(let text):
            Text(MarkdownBlock.attributed(text)).font(font)
        case .item(let depth, let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(number.map { "\($0)." } ?? "•")
                    .font(font)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .frame(minWidth: 16, alignment: .trailing)
                Text(MarkdownBlock.attributed(text)).font(font)
            }
            .padding(.leading, CGFloat(depth) * 14)
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(10)
            }
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .quote(let text):
            HStack(spacing: 8) {
                Capsule().fill(.quaternary).frame(width: 3)
                Text(MarkdownBlock.attributed(text)).font(font).foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Divider()
        }
    }
}
