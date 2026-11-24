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
        default: RuriModel(demo: .sample, others: others)
        }
    }

    /// The made-up computers paired beside the sample's: a Linux box on the
    /// tailnet.
    static let others = [
        PairedMac(
            name: "tenet", deviceId: "demo-tenet", addresses: [], port: 0, fingerprint: "demo-tenet",
            pairedAt: .now, lastAddress: nil, platform: "linux"
        )
    ]

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
        watchForCues(model)
        guard screen == nil, let link = UserDefaults.standard.string(forKey: "pairLink") else { return }
        UserDefaults.standard.removeObject(forKey: "pairLink")
        await model.pair(link)
    }

    /// Asked through a cue file, since a Mac won't let one app put touches
    /// into another: `shot <path>` writes a JPEG of the window there, drawn
    /// by the app itself (no leave to record the screen needed), and
    /// `type <words>` puts words into the prompt's field as typing would.
    /// For more than one computer: `pair <link>` pairs another, `switch <n>`
    /// shows the nth paired (from 0), `forget <n>` unpairs it, `open <n>
    /// <project>` is a notification from the nth tapped, and `state <path>`
    /// writes what the model holds there, as JSON.
    ///
    ///     echo "shot /tmp/home.jpg" > /tmp/ruri-phone-cue
    private static func watchForCues(_ model: RuriModel) {
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
                } else if line.hasPrefix("pair ") {
                    await model.pair(rest)
                } else if line.hasPrefix("switch "), let n = Int(rest), model.macs.indices.contains(n) {
                    model.switchTo(model.macs[n].deviceId)
                } else if line.hasPrefix("open "), let n = Int(rest.prefix { $0 != " " }), model.macs.indices.contains(n) {
                    // as a tapped notification from the nth computer would
                    Opener.shared.mac = model.macs[n].deviceId
                    Opener.shared.project = String(rest.drop { $0 != " " }.dropFirst())
                } else if line.hasPrefix("forget "), let n = Int(rest), model.macs.indices.contains(n) {
                    model.unpair(model.macs[n].deviceId)
                } else if line.hasPrefix("state "), !rest.isEmpty {
                    let state: [String: Any] = [
                        "shown": model.mac?.deviceId ?? "",
                        "macs": model.macs.map { ["id": $0.deviceId, "name": $0.name, "platform": $0.platform ?? "", "port": $0.port] as [String: Any] },
                        "link": "\(model.link)",
                        "computer": model.report?.computer ?? "",
                        "projects": model.report?.projects.map(\.name) ?? [],
                        "pairing": "\(model.pairing)",
                    ]
                    if let data = try? JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys]) {
                        try? data.write(to: URL(fileURLWithPath: rest))
                    }
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
            case "chat", "chat-live", "chat-late", "chat-ask", "chat-question", "chat-running", "chat-table":
                NavigationStack { MadeChat(live: DevMac.screen == "chat-live", late: DevMac.screen == "chat-late") }
            case "project": NavigationStack { ProjectView(name: "orchard") }
            case "pair": PairView()
            case "pair-another": PairSheet()
            case "mac": MacSheet()
            default: RootView()
            }
        }
    }

    /// The made-up cards a chat waits at: `chat-ask`, leave to use a tool
    /// with a message behind it; `chat-question`, two questions.
    static var asks: [ChatAsk]? {
        switch screen {
        case "chat-ask":
            [
                ChatAsk(
                    id: "a1", kind: .permission, title: "Bash",
                    detail: "git push origin master && make self-update NOW=1"
                ),
                ChatAsk(
                    id: "a2", kind: .message, title: "Message orchard · Harvest",
                    detail: "How many crates came in on Sunday?"
                ),
            ]
        case "chat-question":
            [
                ChatAsk(
                    id: "q1", kind: .question, title: "Which lens should the lamp use tonight?",
                    questions: [
                        ChatQuestion(
                            question: "Which lens should the lamp use tonight?", header: "Lens",
                            options: [
                                .init(label: "Red", description: "Easier on the eyes, shorter reach"),
                                .init(label: "Clear", description: "Full reach, as it is now"),
                            ],
                            multi: false, other: true
                        ),
                        ChatQuestion(
                            question: "Where should the swap be logged?", header: "Log",
                            options: [.init(label: "LAMP.md"), .init(label: "The keeper's book")],
                            multi: true, other: true
                        ),
                    ]
                )
            ]
        default: nil
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
                var first = late ? empty : ChatFrame.sample
                if let asks = DevMac.asks {
                    first.asks = asks
                    first.queue = []
                    first.state = .needsYou
                }
                // `chat-table`: a reply with a table that fits the screen and
                // one that doesn't
                if DevMac.screen == "chat-table" {
                    first.queue = []
                    first.state = .idle
                    first.items = [
                        ChatItem(id: "u1", kind: .user, text: "How do the lenses compare?", at: .now),
                        ChatItem(
                            id: "a1", kind: .assistant,
                            text: """
                                Two lenses, side by side:

                                | Lens | Reach | In fog |
                                |:-----|------:|:------:|
                                | Clear | 18 nm | **poor** |
                                | Red | 12 nm | good |

                                And the swaps this month, which is wider than the screen:

                                | Night | Lens fitted | Fitted by | Minutes | What was noted in the keeper's log |
                                |---|---|---|--:|---|
                                | Mon 3rd | Red | `lamp swap --lens red` | 10 | Fog from dusk; the clear lens went back in at first light, and nobody was on the water. |
                                | Thu 6th | Clear | the keeper | 12 | A dry night. |

                                That's all of them.
                                """,
                            at: .now
                        ),
                    ]
                }
                // `chat-running`: the turn has ended, and a script it left
                // going and an agent are still at it
                if DevMac.screen == "chat-running" {
                    first.queue = []
                    first.state = .idle
                    first.running = [
                        ChatRunning(
                            key: "s1", kind: .script, title: "Resize the lamp's photos",
                            doing: "[212/340] resizing photos/lens-0212.png", since: .now.addingTimeInterval(-380),
                            printed: .now.addingTimeInterval(-3)
                        ),
                        ChatRunning(
                            key: "s2", kind: .script, title: "Run the migration",
                            doing: "still indexing… 95s", since: .now.addingTimeInterval(-200),
                            printed: .now.addingTimeInterval(-95)
                        ),
                        ChatRunning(
                            key: "a1", kind: .agent, title: "Check the keeper's log for last night",
                            doing: "Read: LAMP.md", since: .now.addingTimeInterval(-64)
                        ),
                    ]
                }
                let made = ChatSession(sample: first, model: model)
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
