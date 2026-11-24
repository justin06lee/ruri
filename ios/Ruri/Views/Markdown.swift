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
    /// A table: its header's cells, how each column is set, and its rows,
    /// each as wide as the header.
    case table(header: [String], columns: [Column], rows: [[String]])

    /// How a table's column is set, as its delimiter row says (`:--`,
    /// `:-:`, `--:`).
    enum Column: Equatable {
        case leading, center, trailing
    }
}

/// Splits markdown into its blocks. Small on purpose: headings, paragraphs,
/// bullet and numbered lists, fenced code, quotes, rules and tables — what
/// agents write. Inline styles (bold, italic, code, links) stay in the text and are
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
            } else if let header = cells(trimmed), let columns = lines.first.flatMap(delimiter),
                      columns.count == header.count {
                // a row of cells with a row of dashes under it is a table;
                // until the dashes arrive (a reply being written) it reads
                // as the words it is
                flush()
                lines.removeFirst()
                var rows: [[String]] = []
                while let next = lines.first, !next.trimmingCharacters(in: .whitespaces).isEmpty,
                      let row = cells(next.trimmingCharacters(in: .whitespaces)) {
                    lines.removeFirst()
                    // as wide as its header: short rows filled out, long ones cut
                    rows.append((0..<header.count).map { $0 < row.count ? row[$0] : "" })
                }
                blocks.append(.table(header: header, columns: columns, rows: rows))
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

    /// A table row's cells, or nil for a line with no bar in it. A bar
    /// inside `code`, or written `\|` (there too), is the cell's own.
    private static func cells(_ line: String) -> [String]? {
        guard line.contains("|") else { return nil }
        var text = Substring(line)
        if text.hasPrefix("|") { text = text.dropFirst() }
        if text.hasSuffix("|"), !text.hasSuffix("\\|") { text = text.dropLast() }
        var out: [String] = []
        var cell = ""
        var inCode = false
        var escaped = false
        for character in text {
            if escaped {
                // only a bar is unescaped here: the rest is the inline reader's
                if character != "|" { cell.append("\\") }
                cell.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "`" {
                inCode.toggle()
                cell.append(character)
            } else if character == "|", !inCode {
                out.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else {
                cell.append(character)
            }
        }
        if escaped { cell.append("\\") }
        out.append(cell.trimmingCharacters(in: .whitespaces))
        return out
    }

    /// The row under a table's header, dashes with a colon where a column
    /// is set to one side — or nil for any other line.
    private static func delimiter(_ line: String) -> [MarkdownBlock.Column]? {
        guard let marks = cells(line.trimmingCharacters(in: .whitespaces)) else { return nil }
        var columns: [MarkdownBlock.Column] = []
        for mark in marks {
            let dashes = mark.drop(while: { $0 == ":" }).prefix(while: { $0 == "-" })
            let after = mark.drop(while: { $0 == ":" }).dropFirst(dashes.count)
            guard !dashes.isEmpty, after.isEmpty || after == ":", mark.prefix(while: { $0 == ":" }).count <= 1
            else { return nil }
            let left = mark.hasPrefix(":")
            let right = mark.hasSuffix(":")
            columns.append(left && right ? .center : right ? .trailing : .leading)
        }
        return columns
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
            result[run.range].font = .ruriMono(.subheadline)
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
            code.font = .ruriMono(.subheadline)
            return code
        case .rule:
            return AttributedString()
        case .table(let header, _, let rows):
            // a row a line, its cells apart
            return ([header] + rows).enumerated().reduce(into: AttributedString()) { result, row in
                if row.offset > 0 { result += AttributedString("\n") }
                for (at, cell) in row.element.enumerated() {
                    if at > 0 { result += AttributedString(" · ") }
                    result += Self.attributed(cell)
                }
            }
        }
    }
}

/// A message rendered from markdown: block by block when `whole`, or as a
/// few flattened lines (`lineLimit`) otherwise. Links open in the browser.
struct MarkdownText: View {
    var source: String
    var whole = true
    var lineLimit: Int?
    var font: Font = .ruri(.subheadline)
    /// Across the whole width; false hugs the text, for a bubble.
    var fill = true

    var body: some View {
        let blocks = MarkdownCache.blocks(source)
        if whole {
            VStack(alignment: .leading, spacing: 10) {
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

/// Blocks already parsed, by their source: a conversation is drawn again
/// with every word that arrives, and what was said before hasn't changed.
@MainActor
enum MarkdownCache {
    private final class Parsed {
        let blocks: [MarkdownBlock]
        init(_ blocks: [MarkdownBlock]) { self.blocks = blocks }
    }

    private static let cache: NSCache<NSString, Parsed> = {
        let cache = NSCache<NSString, Parsed>()
        cache.countLimit = 600
        return cache
    }()

    static func blocks(_ source: String) -> [MarkdownBlock] {
        let key = source as NSString
        if let held = cache.object(forKey: key) { return held.blocks }
        let blocks = MarkdownParser.parse(source)
        cache.setObject(Parsed(blocks), forKey: key)
        return blocks
    }
}

private struct MarkdownBlockView: View {
    var block: MarkdownBlock
    var font: Font
    @Environment(\.palette) private var palette

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(MarkdownBlock.attributed(text))
                .font(level == 1 ? .ruri(.title3, .bold) : level == 2 ? .ruri(.headline, .bold) : .ruri(.callout, .bold))
                .padding(.top, 4)
        case .paragraph(let text):
            Text(MarkdownBlock.attributed(text)).font(font).lineSpacing(3)
        case .item(let depth, let number, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(number.map { "\($0)." } ?? "•")
                    .font(font)
                    .foregroundStyle(palette.inkFaint)
                    .monospacedDigit()
                    .frame(minWidth: 16, alignment: .trailing)
                Text(MarkdownBlock.attributed(text)).font(font).lineSpacing(3)
            }
            .padding(.leading, CGFloat(depth) * 14)
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.ruriMono(.footnote))
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(12)
            }
            .background(palette.paperDim, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .quote(let text):
            HStack(spacing: 10) {
                Capsule().fill(palette.fill).frame(width: 3)
                Text(MarkdownBlock.attributed(text)).font(font).lineSpacing(3).foregroundStyle(palette.inkSoft)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            palette.hairline.frame(height: 1)
        case .table(let header, let columns, let rows):
            MarkdownTable(header: header, columns: columns, rows: rows, font: font)
        }
    }
}

/// A table as a grid: columns as wide as what is in them, up to a width
/// past which a cell's words wrap; wider than the screen, it scrolls
/// sideways rather than squeezing.
private struct MarkdownTable: View {
    var header: [String]
    var columns: [MarkdownBlock.Column]
    var rows: [[String]]
    var font: Font
    @Environment(\.palette) private var palette

    /// A column is never wider than this.
    private let widest: CGFloat = 220

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(header.indices, id: \.self) { column in
                        cell(header[column], column: column, heading: true)
                    }
                }
                ForEach(rows.indices, id: \.self) { row in
                    line(heavy: row == 0)
                    GridRow {
                        ForEach(header.indices, id: \.self) { column in
                            cell(rows[row][column], column: column, heading: false)
                        }
                    }
                }
            }
            .background(palette.paper)
            .clipShape(.rect(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(palette.hairline, lineWidth: 1)
            }
        }
    }

    /// The rule between two rows; the one under the header a little firmer.
    private func line(heavy: Bool) -> some View {
        (heavy ? palette.inkFaint.opacity(0.5) : palette.hairline)
            .frame(height: 1)
            .gridCellUnsizedAxes(.horizontal)
    }

    private func cell(_ text: String, column: Int, heading: Bool) -> some View {
        let side = column < columns.count ? columns[column] : .leading
        var words = MarkdownBlock.attributed(text)
        if heading { words.inlinePresentationIntent = .stronglyEmphasized }
        return Text(words)
            .font(font)
            .lineSpacing(2)
            .multilineTextAlignment(side == .center ? .center : side == .trailing ? .trailing : .leading)
            .frame(maxWidth: widest, alignment: side == .center ? .center : side == .trailing ? .trailing : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: side == .center ? .center : side == .trailing ? .trailing : .leading)
            .background(heading ? palette.paperDim : Color.clear)
    }
}
