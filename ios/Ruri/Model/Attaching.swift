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
    /// Base64 in JSON, which is what the Mac reads.
    var data: Data

    var marker: String { Attaching.marker(kind, n) }

    /// As a bubble shows it, until the Mac has it on file.
    var shown: ChatAttachment {
        ChatAttachment(id: id, kind: kind, mediaType: mediaType, name: name, n: n, url: "")
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, mediaType, name, n, data
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
