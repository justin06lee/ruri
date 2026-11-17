import SwiftUI

/// Which account a project runs on, picked from the phone: a button in the
/// bar of the project's screens that names its Claude account, opening onto
/// each harness's accounts — who each is signed in as and how full its
/// fullest window is — so the one with room is the one you tap. The Mac
/// puts the project on it, as its own account chip does; a chat already
/// running keeps its account until its next start.
struct AccountMenu: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    var project: StatusProject

    private var accounts: [StatusAccount] { model.report?.accounts ?? [] }

    /// The account the project runs a harness on: its pick while that is
    /// still one of the harness's, else the harness's first.
    private func current(_ provider: String) -> StatusAccount? {
        let theirs = accounts.filter { $0.provider == provider }
        return theirs.first { $0.id == project.accounts?[provider] } ?? theirs.first
    }

    /// Under an account's name: who it is, and how full its fullest window.
    private func detail(_ account: StatusAccount) -> String {
        if account.signedIn == false { return "Not signed in" }
        let room = model.report?.usage(of: account.id)?.fullest.map { "\($0.label) \($0.percent)%" }
        return [account.who, room].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        if let macId = project.macId, let shown = current("claude") {
            let full = (model.report?.usage(of: shown.id)?.fullest?.percent ?? 0) >= 90
            Menu {
                ForEach(["claude", "codex"], id: \.self) { provider in
                    let theirs = accounts.filter { $0.provider == provider }
                    // a harness with one account has nothing to pick between
                    if theirs.count > 1 {
                        Section(provider == "claude" ? "Claude account" : "Codex account") {
                            ForEach(theirs) { account in
                                Button {
                                    model.setAccount(account, for: macId)
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
            .accessibilityLabel("Account: \(shown.name)")
            .accessibilityIdentifier("account")
        }
    }
}
