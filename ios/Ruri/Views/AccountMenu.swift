import SwiftUI

/// Which account a project — or one chat in it — runs on, picked from the
/// phone: a button in the bar naming the account, opening onto each
/// harness's accounts with who each is signed in as and how full its
/// fullest window is, so the one with room is the one you tap. On a
/// project's screen it picks the project's; on a chat's, that chat's own
/// (picking the project's is following the project again). The Mac does
/// it as its own account chip and row menu do; a chat already running
/// keeps its account until its next start.
///
/// The button names the account of the harness the chat's model runs on,
/// so a chat on a Codex model shows its Codex account. A chat on a model
/// with no account — one running on the Mac itself — has no button.
struct AccountMenu: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    var project: StatusProject
    /// The chat this is for, when it is one chat's rather than the project's.
    var chat: String?

    private var accounts: [StatusAccount] { model.report?.accounts ?? [] }

    /// The harness whose account the button names: the one the chat's
    /// model runs on — Claude's for a project, and until the Mac says.
    private var harness: String {
        guard let chat, let on = model.report?.model(of: chat) else { return "claude" }
        return on.harness ?? "claude"
    }

    /// The account the project runs a harness on: its pick while that is
    /// still one of the harness's, else the harness's first.
    private func projects(_ provider: String) -> StatusAccount? {
        let theirs = accounts.filter { $0.provider == provider }
        return theirs.first { $0.id == project.accounts?[provider] } ?? theirs.first
    }

    /// What this menu is for runs on: the chat's own, else the project's.
    private func current(_ provider: String) -> StatusAccount? {
        guard let chat, let own = model.report?.chat(chat)?.accounts?[provider] else { return projects(provider) }
        return accounts.first { $0.id == own && $0.provider == provider } ?? projects(provider)
    }

    /// Under an account's name: who it is, how full its fullest window, and
    /// — in a chat's menu — which is the project's.
    private func detail(_ account: StatusAccount) -> String {
        if account.signedIn == false { return "Not signed in" }
        let room = model.report?.usage(of: account.id)?.fullest.map { "\($0.label) \($0.percent)%" }
        let mark = chat != nil && projects(account.provider)?.id == account.id ? "project's" : nil
        return [mark, account.who, room].compactMap { $0 }.joined(separator: " · ")
    }

    private func pick(_ account: StatusAccount, macId: String) {
        if let chat {
            model.setChatAccount(account, for: chat)
        } else {
            model.setAccount(account, for: macId)
        }
    }

    var body: some View {
        if let macId = project.macId, let shown = current(harness) {
            let full = (model.report?.usage(of: shown.id)?.fullest?.percent ?? 0) >= 90
            Menu {
                ForEach(["claude", "codex"], id: \.self) { provider in
                    let theirs = accounts.filter { $0.provider == provider }
                    // a harness with one account has nothing to pick between
                    if theirs.count > 1 {
                        Section(Self.heading(provider, chat: chat != nil)) {
                            ForEach(theirs) { account in
                                Button {
                                    pick(account, macId: macId)
                                } label: {
                                    if account.id == current(provider)?.id {
                                        Label {
                                            Text(account.name)
                                            Text(detail(account))
                                        } icon: {
                                            Image(systemName: "checkmark")
                                        }
                                    } else {
                                        Text(account.name)
                                        Text(detail(account))
                                    }
                                }
                                .disabled(account.signedIn == false)
                                .accessibilityIdentifier("account.\(account.id)")
                            }
                        }
                    }
                }
            } label: {
                Label(shown.name, systemImage: "person.crop.circle")
                    .labelStyle(.titleAndIcon)
                    .font(.ruri(.subheadline, .medium))
                    .foregroundStyle(full ? palette.destructive : palette.ink)
            }
            .accessibilityLabel("\(chat == nil ? "Project's account" : "This chat's account"): \(shown.name)")
            .accessibilityIdentifier("account")
        }
    }

    static func heading(_ provider: String, chat: Bool) -> String {
        let harness = provider == "claude" ? "Claude" : "Codex"
        return chat ? "\(harness) account for this chat" : "\(harness) account for the project"
    }
}
