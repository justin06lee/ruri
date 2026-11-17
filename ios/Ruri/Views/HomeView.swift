import SwiftUI

/// Home, the Mac's sidebar made a screen: what needs you, then every
/// project as the sidebar arranges it — folders, order and stars — each
/// with what it is doing now. Over them, the Mac's name
/// and whether the line to it is live; while it is down, how old the
/// picture is. The name switches to another paired computer, or pairs one.
struct HomeView: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var sheet: HomeSheet?
    @State private var path = NavigationPath()
    @State private var opener = Opener.shared

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Masthead(showMac: { sheet = .mac }, pairAnother: { sheet = .pair })
                    if model.link == .unpaired {
                        UnpairedCard { sheet = .pair }
                    }
                    if let report = model.report {
                        Group {
                            // every chat at work, wherever it is — and still
                            // in its place in the list below
                            let working = report.working
                            if !working.isEmpty {
                                RowSection(title: "Working now") {
                                    ForEach(working, id: \.chat.name) { item in
                                        if let id = item.id {
                                            NavigationLink(value: ChatRoute(id: id, name: item.title)) {
                                                ChatRow(chat: item.chat, opens: true)
                                            }
                                            .buttonStyle(RowPress())
                                            .accessibilityIdentifier("working.\(item.chat.name)")
                                        } else {
                                            ChatRow(chat: item.chat)
                                        }
                                    }
                                }
                            }
                            if let usage = report.usage, !usage.isEmpty {
                                UsageCard(usage: usage)
                            }
                            if !report.needsYou.isEmpty {
                                RowSection(title: "Needs you") {
                                    ForEach(report.needsYou) { need in
                                        NavigationLink(value: Destination.need(need)) {
                                            NeedRow(need: need)
                                        }
                                        .buttonStyle(RowPress())
                                        .accessibilityIdentifier("need.\(need.project)")
                                    }
                                }
                            }
                            if !report.projects.isEmpty {
                                SidebarList(report: report)
                            }
                        }
                        .grayedWhenOffline(model.link)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .background(palette.ground.ignoresSafeArea())
            .overlay {
                if let report = model.report, report.projects.isEmpty {
                    Unavailable(
                        symbol: "square.stack", title: "No projects open",
                        words: "Projects you open in ruri on \(report.computer) show up here."
                    )
                } else if model.report == nil {
                    NoPicture()
                }
            }
            .navigationTitle("ruri")
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Destination.Route.self) { route in
                switch route {
                case .chat(let chat): ChatView(route: chat)
                case .project(let name): ProjectView(name: name)
                }
            }
            // a project's own rows open its chats
            .navigationDestination(for: ChatRoute.self) { route in
                ChatView(route: route)
            }
            .refreshable { await model.refresh() }
            .sheet(item: $sheet) { shown in
                switch shown {
                case .mac: MacSheet { sheet = .pair }
                case .pair: PairSheet()
                }
            }
        }
        // a tapped notification opens its project
        .onChange(of: opener.project, initial: true) { _, _ in open() }
        // another computer: its own screens, from home
        .onChange(of: model.mac?.deviceId) { _, _ in
            path = NavigationPath()
            open()
        }
    }

    /// Open the project a tapped notification names — on the computer that
    /// sent it, switched to first (which comes back here).
    private func open() {
        guard let project = opener.project else { return }
        if let mac = opener.mac, mac != model.mac?.deviceId, model.macs.contains(where: { $0.deviceId == mac }) {
            sheet = nil
            model.switchTo(mac)
            return
        }
        opener.project = nil
        opener.mac = nil
        sheet = nil
        let found = model.report?.project(named: project)
        path = NavigationPath([found.map(Destination.project) ?? .project(project)])
    }
}

/// The sheets over home: the computer's, and pairing another.
enum HomeSheet: String, Identifiable {
    case mac, pair
    var id: String { rawValue }
}

/// Where a row on the home screen leads: straight to the conversation when
/// there is one chat to open, else to the project.
enum Destination {
    /// A project with a team opens on its chats; one that is only its lead
    /// opens that conversation.
    static func project(_ project: StatusProject) -> Route {
        if project.team.isEmpty, let chat = project.lead?.id {
            return .chat(ChatRoute(id: chat, name: project.name))
        }
        return .project(project.name)
    }

    /// What needs you opens on the chat that is waiting.
    static func need(_ need: StatusNeed) -> Route {
        if let chat = need.chatId {
            return .chat(ChatRoute(id: chat, name: need.who == "Lead" ? need.project : need.who))
        }
        return .project(need.project)
    }

    enum Route: Hashable {
        case chat(ChatRoute)
        case project(String)
    }
}

/// The app's name over the Mac's, and the way to the Mac's sheet. The
/// Mac's name opens the computers this phone is paired with: one picked is
/// shown, or another paired.
private struct Masthead: View {
    var showMac: () -> Void
    var pairAnother: () -> Void
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var now = Date.now

    private var mac: String { model.mac.map(model.label) ?? model.report?.computer ?? "your Mac" }

    /// The computer shown, picked from the menu.
    private var shown: Binding<String> {
        Binding { model.mac?.deviceId ?? "" } set: { model.switchTo($0) }
    }

    private var words: String {
        switch model.link {
        case .live: mac
        case .connecting: model.report == nil ? "Finding \(mac)…" : "Connecting to \(mac)…"
        case .offline: model.asleepWords(now: now)
        case .unpaired: "Not paired"
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("ruri")
                    .font(.ruri(.largeTitle, .bold))
                    .foregroundStyle(palette.ink)
                    .accessibilityAddTraits(.isHeader)
                Menu {
                    Picker("Computer", selection: shown) {
                        ForEach(model.macs) { mac in
                            Label(model.label(mac), systemImage: mac.symbol).tag(mac.deviceId)
                        }
                    }
                    .pickerStyle(.inline)
                    Button("Pair Another Computer…", systemImage: "plus", action: pairAnother)
                } label: {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(model.link == .live ? Color(hex: 0x30B855) : palette.inkFaint.opacity(0.6))
                            .frame(width: 7, height: 7)
                        Text(words)
                            .font(.ruri(.footnote))
                            .foregroundStyle(palette.inkSoft)
                            .lineLimit(1)
                            .contentTransition(.opacity)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(palette.inkFaint)
                            .accessibilityHidden(true)
                    }
                    .contentShape(.rect)
                }
                .accessibilityIdentifier("home.status")
                .accessibilityHint("Switches to another computer, or pairs one")
            }
            Spacer(minLength: 8)
            Button(action: showMac) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(palette.ink)
                    .frame(width: 44, height: 44)
                    .glass(Circle(), fallback: palette.raised)
            }
            .accessibilityLabel("Your Mac")
        }
        .padding(.top, 6)
        .task(id: model.link) {
            // the age counts on while the line is down
            while model.link == .offline, !Task.isCancelled {
                now = .now
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}

/// Before the Mac's first picture has come.
private struct NoPicture: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        switch model.link {
        case .connecting, .live:
            ProgressView()
        case .offline:
            VStack(spacing: 18) {
                Unavailable(
                    symbol: "moon.zzz", title: "\(model.mac?.name ?? "Your Mac") is asleep or offline",
                    words: (model.heard.map { "Last seen \(Ago.long($0)). " } ?? "")
                        + "Away from home, keep Tailscale on, on this iPhone and the Mac."
                )
                .frame(maxHeight: 220)
                Button("Try Again") { Task { await model.refresh() } }
                    .buttonStyle(QuietButton())
                    .frame(width: 160)
            }
        case .unpaired:
            EmptyView()
        }
    }
}

/// The Mac no longer knows this phone: it was removed there. Paired again,
/// it takes its old place.
private struct UnpairedCard: View {
    var pairAgain: () -> Void
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Not paired", systemImage: "link")
                    .font(.ruri(.body, .bold))
                Text("\(model.mac?.name ?? "Your Mac") no longer knows this iPhone. Make a new code there to pair again.")
                    .font(.ruri(.subheadline))
                    .foregroundStyle(palette.inkSoft)
            }
            Button("Pair Again", action: pairAgain)
                .buttonStyle(PrimaryButton())
        }
        .padding(16)
        .card(palette.raised)
    }
}
