import SwiftUI
import UIKit

// Only ever compiled by ios/demo/mac.sh: what the app needs to run on a Mac
// as a Mac Catalyst window, for a look at it without Xcode or a simulator.
// The phone's build never sees this file; the app's own call sites are
// under `#if targetEnvironment(macCatalyst)`.

/// The camera's scanner has no Mac Catalyst build (Views/QRScanner.swift is
/// left out): this stands in, saying there is nothing to scan with.
struct QRScanner: View {
    var found: (String) -> Void

    static var isAvailable: Bool { false }

    var body: some View { EmptyView() }
}

@MainActor
enum DevMac {
    /// Where the phone's key for its Mac is kept here, in place of the
    /// keychain, which takes nothing from an app without Xcode's signing
    /// (Connection/Keychain.swift).
    nonisolated(unsafe) static var keys: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: "keys") as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "keys") }
    }

    /// `mac.sh demo <screen>`: which screen to show on made-up data.
    static var screen: String? { UserDefaults.standard.string(forKey: "demo") }

    static func model() -> RuriModel {
        switch screen {
        case nil, "pair": RuriModel()
        default: RuriModel(demo: .sample)
        }
    }

    /// A window the size of an iPhone, and the pairing link `mac.sh run`
    /// was given.
    static func start(_ model: RuriModel) async {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            let size = CGSize(width: 402, height: 874)
            scene.sizeRestrictions?.minimumSize = size
            scene.sizeRestrictions?.maximumSize = size
            scene.titlebar?.titleVisibility = .hidden
            scene.titlebar?.toolbar = nil
        }
        watchForCues()
        guard screen == nil, let link = UserDefaults.standard.string(forKey: "pairLink") else { return }
        UserDefaults.standard.removeObject(forKey: "pairLink")
        await model.pair(link)
    }

    /// Asked through a cue file, since a Mac won't let one app put touches
    /// into another: `shot <path>` writes a JPEG of the window there, drawn
    /// by the app itself (no leave to record the screen needed), and
    /// `type <words>` puts words into the prompt's field as typing would.
    ///
    ///     echo "shot /tmp/home.jpg" > /tmp/ruri-phone-cue
    private static func watchForCues() {
        let cue = "/tmp/ruri-phone-cue"
        Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let asked = try? String(contentsOfFile: cue, encoding: .utf8) else { continue }
                try? FileManager.default.removeItem(atPath: cue)
                let line = asked.trimmingCharacters(in: .whitespacesAndNewlines)
                let rest = String(line.drop(while: { $0 != " " }).dropFirst())
                let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                guard let window = scenes.first?.keyWindow ?? scenes.first?.windows.first else { continue }
                if line.hasPrefix("shot "), !rest.isEmpty {
                    let format = UIGraphicsImageRendererFormat()
                    format.scale = 1.5
                    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                    }
                    try? image.jpegData(compressionQuality: 0.4)?.write(to: URL(fileURLWithPath: rest))
                } else if line.hasPrefix("type "), let field = field(in: window) {
                    field.becomeFirstResponder()
                    field.insertText(rest.replacingOccurrences(of: "\\n", with: "\n"))
                }
            }
        }
    }

    private static func field(in view: UIView) -> PromptTextView? {
        if let field = view as? PromptTextView { return field }
        for child in view.subviews {
            if let found = field(in: child) { return found }
        }
        return nil
    }

    struct Root: View {
        @Environment(RuriModel.self) private var model

        var body: some View {
            switch DevMac.screen {
            case "chat", "chat-live", "chat-late":
                NavigationStack { MadeChat(live: DevMac.screen == "chat-live", late: DevMac.screen == "chat-late") }
            case "project": NavigationStack { ProjectView(name: "orchard") }
            case "pair": PairView()
            case "mac": MacSheet()
            default: RootView()
            }
        }
    }

    /// The made-up conversation; `live`, a reply keeps being written, to
    /// watch the screen follow it.
    private struct MadeChat: View {
        var live: Bool
        /// Its conversation arrives a moment after the screen opens, as a
        /// real one does from the Mac.
        var late = false
        @Environment(RuriModel.self) private var model
        @State private var session: ChatSession?

        var body: some View {
            ZStack {
                // something to hang the task on before there is a session
                Color.clear
                if let session {
                    ChatView(route: ChatRoute(id: session.chat, name: "ruri"), made: session)
                }
            }
            .task {
                var empty = ChatFrame.sample
                empty.items = []
                empty.queue = []
                let made = ChatSession(sample: late ? empty : .sample, model: model)
                session = made
                if late {
                    try? await Task.sleep(for: .milliseconds(700))
                    var long = ChatFrame.sample
                    long.items = (1...40).map { n in
                        ChatItem(id: "m\(n)", kind: n % 2 == 0 ? .assistant : .user, text: "Message \(n): a line of the conversation, long enough to wrap onto a second line.", at: .now)
                    }
                    made.apply(sample: long)
                }
                guard live else { return }
                var frame = ChatFrame.sample
                frame.state = .working
                var words = "Counting, so there is something to follow:"
                for n in 1...400 {
                    try? await Task.sleep(for: .milliseconds(350))
                    if Task.isCancelled { return }
                    words += "\n\n\(n). Another line of the reply, written a beat after the last one."
                    frame.items = nil
                    frame.upsert = [
                        ChatItem(id: "draft:live", kind: .assistant, text: words, at: .now, pending: true)
                    ]
                    made.apply(sample: frame)
                }
            }
        }
    }
}
