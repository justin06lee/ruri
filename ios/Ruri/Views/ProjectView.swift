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
                                NeedRow(need: need, showProject: false)
                            }
                        }
                    }
                    if let lead = project.lead {
                        Section("Lead") {
                            ChatRow(chat: lead, whole: true)
                        }
                    }
                    if !project.team.isEmpty {
                        Section("Team") {
                            ForEach(project.team, id: \.name) { chat in
                                ChatRow(chat: chat)
                                    .accessibilityIdentifier("chat.\(chat.name)")
                            }
                        }
                    }
                }
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
