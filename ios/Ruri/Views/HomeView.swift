import SwiftUI

/// Home: what needs you, then every project — its name and what it is doing
/// now. The title is the Mac's name; while the line is down it says so,
/// and how old the picture is.
struct HomeView: View {
    @Environment(RuriModel.self) private var model
    @State private var showingMac = false

    var body: some View {
        NavigationStack {
            List {
                if model.link == .unpaired {
                    UnpairedSection()
                }
                if let report = model.report {
                    if !report.needsYou.isEmpty {
                        Section("Needs you") {
                            ForEach(report.needsYou) { need in
                                NavigationLink(value: need.project) {
                                    NeedRow(need: need)
                                }
                                .accessibilityIdentifier("need.\(need.project)")
                            }
                        }
                    }
                    Section("Projects") {
                        ForEach(report.projects) { project in
                            NavigationLink(value: project.name) {
                                ProjectRow(project: project)
                            }
                            .accessibilityIdentifier("project.\(project.name)")
                        }
                    }
                }
            }
            .grayedWhenOffline(model.link)
            .overlay {
                if let report = model.report, report.projects.isEmpty {
                    ContentUnavailableView(
                        "No Projects Open",
                        systemImage: "square.stack",
                        description: Text("Projects you open in ruri on \(report.computer) show up here.")
                    )
                } else if model.report == nil {
                    NoPicture()
                }
            }
            .navigationTitle(model.report?.computer ?? model.mac?.name ?? "ruri")
            .freshness()
            .navigationDestination(for: ChatRoute.self) { route in
                ChatView(route: route)
            }
            .navigationDestination(for: String.self) { name in
                ProjectView(name: name)
            }
            .refreshable { await model.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingMac = true
                    } label: {
                        Image(systemName: "desktopcomputer")
                    }
                    .accessibilityLabel("Your Mac")
                }
            }
            .sheet(isPresented: $showingMac) {
                MacSheet()
            }
        }
    }
}

/// Before the Mac's first picture has come.
private struct NoPicture: View {
    @Environment(RuriModel.self) private var model

    var body: some View {
        switch model.link {
        case .connecting, .live:
            ProgressView()
        case .offline:
            ContentUnavailableView {
                Label("\(model.mac?.name ?? "Your Mac") Is Asleep or Offline", systemImage: "moon.zzz")
            } description: {
                Text(
                    (model.heard.map { "Last seen \(Ago.long($0)). " } ?? "")
                        + "Away from home, keep Tailscale on, on this iPhone and the Mac."
                )
            } actions: {
                Button("Try Again") { Task { await model.refresh() } }
            }
        case .unpaired:
            EmptyView()
        }
    }
}

/// The Mac no longer knows this phone: it was removed there.
private struct UnpairedSection: View {
    @Environment(RuriModel.self) private var model

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Label("Not Paired", systemImage: "link")
                    .font(.headline)
                Text("\(model.mac?.name ?? "Your Mac") no longer knows this iPhone. Make a new code there to pair again.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
            Button("Pair Again") { model.unpair() }
        }
    }
}

extension View {
    /// Under the title, while the line is down: that it is, and how old the
    /// picture is.
    func freshness() -> some View {
        modifier(Freshness())
    }
}

private struct Freshness: ViewModifier {
    @Environment(RuriModel.self) private var model
    @State private var now = Date.now

    private var words: String? {
        switch model.link {
        case .live: nil
        case .connecting: model.report == nil ? nil : "Connecting…"
        case .offline: model.asleepWords(now: now)
        case .unpaired: "Not paired"
        }
    }

    func body(content: Content) -> some View {
        Group {
            if #available(iOS 26, *) {
                content.navigationSubtitle(words ?? "")
            } else {
                content.safeAreaInset(edge: .top, spacing: 0) {
                    if let words {
                        Text(words)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background(.bar)
                    }
                }
            }
        }
        .task(id: model.link) {
            // the age counts on while the line is down
            while model.link == .offline, !Task.isCancelled {
                now = .now
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}
