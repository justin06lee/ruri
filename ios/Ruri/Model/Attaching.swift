import Foundation
import UIKit
import UniformTypeIdentifiers

/// A file on its way to a chat. Its marker in the prompt, [image #1], is how
/// the words point at it, the way they do in ruri on the Mac. The field never
/// shows one: a caret landing inside a marker would break it and lose the file.
struct Attachment: Encodable, Equatable, Identifiable, Sendable {
    var id: String
    var kind: ChatAttachment.Kind
    var mediaType: String
    var name: String
    var n: Int
    /// Base64 in JSON, which is what the Mac reads. None for a file clipped
    /// on at another device: the Mac holds it, and takes it by its id.
    var data: Data?
    /// Where the Mac serves it, once the Mac has said the box holds it.
    var url = ""

    var marker: String { Attaching.marker(kind, n) }

    /// As a bubble shows it: from the Mac once it is on file there.
    var shown: ChatAttachment {
        ChatAttachment(id: id, kind: kind, mediaType: mediaType, name: name, n: n, url: url)
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, mediaType, name, n, data
    }
}

extension Attachment {
    /// A file the Mac's box holds, clipped on at another device.
    init(held: ChatAttachment) {
        self.init(
            id: held.id, kind: held.kind, mediaType: held.mediaType, name: held.name, n: held.n, data: nil,
            url: held.url
        )
    }
}

/// The working parts of attaching: markers for what goes out, and files made
/// fit to send.
enum Attaching {
    /// All of a prompt's files, as sent. The Mac takes about 140 MB.
    static let maxBytes = 100_000_000
    static let maxCount = 20
    /// A picture past this is sent smaller: the model reads no more of it.
    static let imageSide: CGFloat = 2048
    /// A picture this small, in a type the model takes, goes as it is.
    static let imageKeepBytes = 3_500_000
    private static let modelTakes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

    static func marker(_ kind: ChatAttachment.Kind, _ n: Int) -> String {
        "[\(kind.rawValue) #\(n)]"
    }

    /// The next number of a kind: a marker never comes to mean another file.
    static func nextNumber(_ kind: ChatAttachment.Kind, among attachments: [Attachment]) -> Int {
        (attachments.filter { $0.kind == kind }.map(\.n).max() ?? 0) + 1
    }

    /// What goes out: the words, led by the marker of any file they don't
    /// name, so the model is told of every one.
    static func prompt(_ draft: String, naming attachments: [Attachment]) -> String {
        let words = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let unnamed = attachments.map(\.marker).filter { !words.contains($0) }
        return (unnamed + (words.isEmpty ? [] : [words])).joined(separator: " ")
    }

    /// A prompt's words as its bubble shows them, past the markers leading
    /// it: the files themselves sit just above.
    static func afterMarkers(_ text: String) -> String {
        String(text.trimmingPrefix(/(?:\s*\[(?:image|video|file|region) #\d+\])+\s*/))
    }

    /// The files the prompt box shows, the same on every device: what the
    /// Mac says the box holds — less what was just taken off here, which it
    /// has yet to hear — and what was clipped on here that it has yet to
    /// say it holds. A file in hand keeps its bytes; its number is the Mac's.
    static func box(
        mac: [ChatAttachment], here: [Attachment], attaching: Set<String>, detaching: Set<String>
    ) -> [Attachment] {
        let listed = Set(mac.map(\.id))
        let held = mac.filter { !detaching.contains($0.id) }.map { theirs in
            guard var ours = here.first(where: { $0.id == theirs.id }) else { return Attachment(held: theirs) }
            ours.n = theirs.n
            ours.url = theirs.url
            return ours
        }
        return held + here.filter { attaching.contains($0.id) && !listed.contains($0.id) }
    }

    /// Markers as this phone writes and looks for them, with a plain space.
    /// A window on the Mac keeps the space inside one unbreakable, so its
    /// chip never wraps in two, and a Mac from before it said them plainly
    /// sends its box that way.
    static func plain(_ text: String) -> String {
        text.replacing(/\[(image|video|file|region)\u{00A0}#(\d+)\]/) { "[\($0.1) #\($0.2)]" }
    }

    /// The words without a file's marker: the file was taken off, and words
    /// that point at nothing would only mislead. The space the marker stood
    /// in closes up.
    static func without(_ marker: String, in text: String) -> String {
        guard text.contains(marker) else { return text }
        return text
            .replacingOccurrences(of: " " + marker + " ", with: " ")
            .replacingOccurrences(of: marker + " ", with: "")
            .replacingOccurrences(of: " " + marker, with: "")
            .replacingOccurrences(of: marker, with: "")
    }

    /// A file's bytes where Quick Look can open them: a folder of its own,
    /// under its own name.
    static func opened(_ data: Data, id: String, name: String) -> URL? {
        let folder = FileManager.default.temporaryDirectory.appending(path: id, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: (name as NSString).lastPathComponent)
        guard (try? data.write(to: file, options: .atomic)) != nil else { return nil }
        return file
    }

    static func kind(of type: UTType?) -> ChatAttachment.Kind {
        guard let type else { return .file }
        if type.conforms(to: .image) { return .image }
        if type.conforms(to: .movie) || type.conforms(to: .video) { return .video }
        return .file
    }

    /// A picture as it should be sent: as it is when small and in a type the
    /// model takes, else a JPEG of a sensible size. HEIC, what the camera
    /// roll holds, is not one the model takes. Nil for what isn't a picture.
    static func fitted(image data: Data, type: UTType?) -> (data: Data, mediaType: String)? {
        if let mime = type?.preferredMIMEType, modelTakes.contains(mime), data.count <= imageKeepBytes {
            return (data, mime)
        }
        guard let image = UIImage(data: data) else { return nil }
        let longest = max(image.size.width, image.size.height) * image.scale
        let scale = min(1, imageSide / max(longest, 1))
        let size = CGSize(width: image.size.width * image.scale * scale, height: image.size.height * image.scale * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let drawn = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return drawn.jpegData(compressionQuality: 0.85).map { ($0, "image/jpeg") }
    }
}
