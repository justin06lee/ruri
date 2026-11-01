import Observation
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// What is attached to the prompt being written, and what is still on its
/// way from the photo library.
@MainActor
@Observable
final class AttachmentPicking {
    private(set) var ready: [Attachment] = []
    private(set) var loading = 0
    var problem: String?

    func clear() {
        ready = []
    }

    func remove(_ attachment: Attachment) {
        ready.removeAll { $0.id == attachment.id }
    }

    /// Add a file. Pictures are made fit to send away from the screen.
    func add(_ data: Data, type: UTType?, name: String) async {
        let kind = Attaching.kind(of: type)
        var body = data
        var mediaType = type?.preferredMIMEType ?? "application/octet-stream"
        var named = name
        if kind == .image {
            let fitted = await Task.detached { Attaching.fitted(image: data, type: type) }.value
            guard let fitted else {
                problem = "That picture couldn't be read."
                return
            }
            body = fitted.data
            if fitted.mediaType != mediaType {
                named = (name as NSString).deletingPathExtension + ".jpg"
            }
            mediaType = fitted.mediaType
        }
        guard ready.count < Attaching.maxCount else {
            problem = "A prompt can take \(Attaching.maxCount) attachments."
            return
        }
        guard ready.reduce(0, { $0 + $1.data.count }) + body.count <= Attaching.maxBytes else {
            problem = "That's too much to send at once: a prompt can take about 100 MB."
            return
        }
        let attachment = Attachment(
            id: UUID().uuidString.lowercased(), kind: kind, mediaType: mediaType, name: named,
            n: Attaching.nextNumber(kind, among: ready), data: body
        )
        ready.append(attachment)
    }

    func load(_ picked: [PhotosPickerItem]) async {
        loading += picked.count
        for item in picked {
            defer { loading -= 1 }
            let type = item.supportedContentTypes.first
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                problem = "That item couldn't be loaded from your library."
                continue
            }
            let kind = Attaching.kind(of: type)
            let number = Attaching.nextNumber(kind, among: ready)
            let name = "\(kind == .video ? "video" : "photo")-\(number).\(type?.preferredFilenameExtension ?? "jpg")"
            await add(data, type: type, name: name)
        }
    }

    func load(files urls: [URL]) async {
        loading += urls.count
        for url in urls {
            defer { loading -= 1 }
            let opened = url.startAccessingSecurityScopedResource()
            defer { if opened { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
                problem = "\(url.lastPathComponent) couldn't be read."
                continue
            }
            await add(data, type: UTType(filenameExtension: url.pathExtension), name: url.lastPathComponent)
        }
    }

    #if DEBUG
    /// The UI test's way past the system's pickers, which run outside the app.
    func attachForTest() async {
        guard let path = ProcessInfo.processInfo.environment["RURI_TEST_ATTACH"], ready.isEmpty,
            let data = FileManager.default.contents(atPath: path)
        else { return }
        let url = URL(fileURLWithPath: path)
        await add(data, type: UTType(filenameExtension: url.pathExtension), name: url.lastPathComponent)
    }
    #endif
}

/// The plus beside the field: the library, the camera, or a file.
struct AttachButton: View {
    var picking: AttachmentPicking

    @State private var choosingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var choosingFiles = false

    var body: some View {
        Menu {
            Button("Photo Library", systemImage: "photo.on.rectangle") { choosingPhotos = true }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take Photo", systemImage: "camera") { takingPhoto = true }
            }
            Button("Choose File", systemImage: "folder") { choosingFiles = true }
        } label: {
            Image(systemName: "plus.circle.fill")
                .font(.system(size: 30))
                .symbolRenderingMode(.hierarchical)
        }
        .tint(.primary)
        .accessibilityLabel("Attach")
        .accessibilityIdentifier("chat.attach")
        .padding(.bottom, 2)
        .photosPicker(
            isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: Attaching.maxCount,
            selectionBehavior: .ordered, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current
        )
        .onChange(of: photos) {
            guard !photos.isEmpty else { return }
            let picked = photos
            photos = []
            Task { await picking.load(picked) }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { data in
                let number = Attaching.nextNumber(.image, among: picking.ready)
                Task { await picking.add(data, type: .jpeg, name: "photo-\(number).jpg") }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result {
                Task { await picking.load(files: urls) }
            }
        }
        .alert(
            "Couldn't Attach",
            isPresented: Binding(get: { picking.problem != nil }, set: { if !$0 { picking.problem = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(picking.problem ?? "")
        }
    }
}

/// The camera, handing back one photo.
private struct CameraPicker: UIViewControllerRepresentable {
    var took: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(
            _ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
                parent.took(data)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// What is attached so far, above the field, each with a way to take it off.
struct AttachmentStrip: View {
    var picking: AttachmentPicking

    var body: some View {
        if !picking.ready.isEmpty || picking.loading > 0 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(picking.ready) { attachment in
                        Pending(attachment: attachment) {
                            withAnimation(.snappy) { picking.remove(attachment) }
                        }
                    }
                    if picking.loading > 0 {
                        ProgressView()
                            .frame(width: Pending.side, height: Pending.side)
                            .background(Color(.systemGray5), in: .rect(cornerRadius: 12, style: .continuous))
                    }
                }
                // room for the corner of the button that takes one off
                .padding(.top, 6)
                .padding(.trailing, 6)
            }
            .accessibilityIdentifier("chat.attachments")
        }
    }
}

private struct Pending: View {
    static let side: CGFloat = 64

    var attachment: Attachment
    var remove: () -> Void

    var body: some View {
        Preview(kind: attachment.kind, name: attachment.name, data: attachment.data)
            .frame(width: Self.side, height: Self.side)
            .clipShape(.rect(cornerRadius: 12, style: .continuous))
            .overlay(alignment: .topTrailing) {
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, Color(.darkGray))
                        .frame(width: 44, height: 44, alignment: .topTrailing)
                        .contentShape(.rect)
                }
                .offset(x: 6, y: -6)
                .accessibilityLabel("Remove \(attachment.name)")
            }
    }
}

/// A picture when it is one, else a mark for its kind and its name.
private struct Preview: View {
    var kind: ChatAttachment.Kind
    var name: String
    var data: Data?

    var body: some View {
        if kind == .image, let data, let image = UIImage(data: data) {
            Color.clear.overlay {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            }
            .clipped()
            .accessibilityLabel(name)
        } else {
            VStack(spacing: 4) {
                Image(systemName: kind == .video ? "play.rectangle" : kind == .image ? "photo" : "doc")
                    .font(.title3)
                Text(name)
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(6)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemGray5))
        }
    }
}

/// An attachment in a bubble: a picture as itself, anything else by its
/// name. A tap opens it in Quick Look, which zooms, plays and shares.
struct SentAttachment: View {
    var attachment: ChatAttachment
    var session: ChatSession

    @State private var data: Data?
    @State private var opened: URL?
    @State private var opening = false

    private var side: CGSize {
        attachment.kind == .image ? CGSize(width: 220, height: 220) : CGSize(width: 220, height: 64)
    }

    var body: some View {
        Button {
            Task { await open() }
        } label: {
            Preview(kind: attachment.kind, name: attachment.name, data: data)
                .frame(width: side.width, height: side.height)
                .clipShape(.rect(cornerRadius: 14, style: .continuous))
                .overlay { if opening { ProgressView() } }
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat.attachment")
        .quickLookPreview($opened)
        .task(id: attachment.id) {
            guard attachment.kind == .image else { return }
            data = try? await session.file(attachment)
        }
    }

    private func open() async {
        opening = true
        defer { opening = false }
        guard let bytes = try? await session.file(attachment) else { return }
        let folder = FileManager.default.temporaryDirectory.appending(path: attachment.id, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appending(path: (attachment.name as NSString).lastPathComponent)
        guard (try? bytes.write(to: file, options: .atomic)) != nil else { return }
        opened = file
    }
}
