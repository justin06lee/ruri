import SwiftUI

/// A project: what in it needs you, its lead's latest words, then its team
/// — each with its duty, how it stands and its last words.
struct ProjectView: View {
    @Environment(RuriModel.self) private var model
    var name: String

    var body: some View {
        Group {
            if let project = model.report?.project(named: name) {
                List {
                    let needs = model.report?.needs(of: name) ?? []
                    if !needs.isEmpty {
                        Section("Needs you") {
                            ForEach(needs) { need in
                                if let chat = need.chatId {
                                    NavigationLink(value: ChatRoute(id: chat, name: need.who)) {
                                        NeedRow(need: need, showProject: false)
                                    }
                                } else {
                                    NeedRow(need: need, showProject: false)
                                }
                            }
                        }
                    }
                    if let lead = project.lead {
                        Section("Lead") {
                            linked(lead, whole: true)
                                .accessibilityIdentifier("lead")
                        }
                    }
                    if !project.team.isEmpty {
                        Section("Team") {
                            ForEach(project.team, id: \.name) { chat in
                                linked(chat)
                                    .accessibilityIdentifier("chat.\(chat.name)")
                            }
                        }
                    }
                }
                .grayedWhenOffline(model.link)
                .navigationTitle(project.name)
                .projectSubtitle(project)
            } else {
                ContentUnavailableView(
                    "Not Open",
                    systemImage: "square.stack",
                    description: Text("\(name) isn't open in ruri anymore.")
                )
                .navigationTitle(name)
            }
        }
        .refreshable { await model.refresh() }
    }

    /// A chat's row, opening its conversation when the Mac named it.
    @ViewBuilder
    private func linked(_ chat: StatusChat, whole: Bool = false) -> some View {
        if let id = chat.id {
            NavigationLink(value: ChatRoute(id: id, name: chat.name)) {
                ChatRow(chat: chat, whole: whole, opens: true)
            }
        } else {
            ChatRow(chat: chat, whole: whole)
        }
    }
}

extension View {
    /// Under a project's name: how it stands, and since when.
    @ViewBuilder
    fileprivate func projectSubtitle(_ project: StatusProject) -> some View {
        let words: String =
            switch (project.state, project.since) {
            case (.working, let since?): "Working for \(Ago.span(since))"
            case (.needsYou, let since?): "Waiting on you for \(Ago.span(since))"
            case (.blocked, let since?): "Stopped \(Ago.long(since))"
            case (.idle, let since?): "Idle · last active \(Ago.long(since))"
            case (let state, nil): state.label
            }
        if #available(iOS 26, *) {
            navigationSubtitle(words)
        } else {
            self
        }
    }
}
