import SwiftUI

/// A project with a team: what in it needs you, its lead's latest words,
/// then its teammates — each with its duty, how it stands and its last
/// words. A row opens that chat's conversation.
struct ProjectView: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    var name: String

    var body: some View {
        Group {
            if let project = model.report?.project(named: name) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text(Self.standing(project))
                            .font(.ruri(.footnote))
                            .foregroundStyle(palette.inkSoft)
                            .padding(.horizontal, 6)
                            .padding(.bottom, -12)
                        let needs = model.report?.needs(of: name) ?? []
                        if !needs.isEmpty {
                            RowSection(title: "Needs you") {
                                ForEach(needs) { need in
                                    if let chat = need.chatId {
                                        NavigationLink(value: ChatRoute(id: chat, name: need.who)) {
                                            NeedRow(need: need, showProject: false)
                                        }
                                        .buttonStyle(RowPress())
                                    } else {
                                        NeedRow(need: need, showProject: false)
                                    }
                                }
                            }
                        }
                        if let lead = project.lead {
                            RowSection(title: "Lead") {
                                linked(lead, whole: true)
                                    .accessibilityIdentifier("lead")
                            }
                        }
                        if !project.team.isEmpty {
                            RowSection(title: "Team") {
                                ForEach(project.team, id: \.name) { chat in
                                    linked(chat)
                                        .accessibilityIdentifier("chat.\(chat.name)")
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .padding(.bottom, 32)
                    .grayedWhenOffline(model.link)
                }
                .refreshable { await model.refresh() }
                .navigationTitle(project.name)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        AccountMenu(project: project)
                    }
                }
            } else {
                Unavailable(symbol: "square.stack", title: "Not open", words: "\(name) isn't open in ruri anymore.")
                    .navigationTitle(name)
            }
        }
        .background(palette.ground.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .barBackground(palette.ground)
    }

    /// A chat's row, opening its conversation when the Mac named it.
    @ViewBuilder
    private func linked(_ chat: StatusChat, whole: Bool = false) -> some View {
        if let id = chat.id {
            NavigationLink(value: ChatRoute(id: id, name: chat.name)) {
                ChatRow(chat: chat, whole: whole, opens: true)
            }
            .buttonStyle(RowPress())
        } else {
            ChatRow(chat: chat, whole: whole)
        }
    }

    /// Under a project's name: how it stands, and since when.
    static func standing(_ project: StatusProject) -> String {
        switch (project.state, project.since) {
        case (.working, let since?): "Working for \(Ago.span(since))"
        case (.needsYou, let since?): "Waiting on you for \(Ago.span(since))"
        case (.blocked, let since?): "Stopped \(Ago.long(since))"
        case (.idle, let since?): "Idle · last active \(Ago.long(since))"
        case (let state, nil): state.label
        }
    }
}
