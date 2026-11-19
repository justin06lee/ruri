import SwiftUI

/// Which model one chat runs on, and how hard it thinks, picked from the
/// phone: a button in the prompt box naming the model, opening onto the
/// models the Mac's own picker offers — grouped by who serves them, the
/// ones running on the Mac itself marked so — and, under them, the
/// reasoning levels the chat's model takes. The Mac does it as the pickers
/// in its prompt box do; a turn already running finishes on the model it
/// started with.
///
/// Nothing is shown for a chat the Mac says no model for: an older ruri, or
/// a status that hasn't come yet.
struct ModelMenu: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    var chat: String

    private var standing: StatusChat? { model.report?.chat(chat) }

    /// A name for a model the Mac's list doesn't hold: the end of its id.
    /// ("opencode:ollama/bonsai-2:latest" is "bonsai-2:latest", "codex:gpt-6"
    /// is "gpt-6", one of Claude's is as it is.)
    static func roughName(_ id: String) -> String {
        if let slash = id.lastIndex(of: "/") { return String(id[id.index(after: slash)...]) }
        if let colon = id.firstIndex(of: ":") { return String(id[id.index(after: colon)...]) }
        return id
    }

    /// A lot's heading: who serves it, and that it is on the Mac when it is.
    static func heading(_ provider: String, local: Bool, computer: String?) -> String {
        guard local else { return provider }
        return "\(provider) · on \(computer ?? "the computer")"
    }

    var body: some View {
        if let report = model.report, let on = standing?.model, !(report.models ?? []).isEmpty {
            let current = report.model(of: chat)
            let level = current?.effort(keeping: standing?.effort)
            Menu {
                ForEach(report.modelGroups, id: \.provider) { group in
                    Section(Self.heading(group.provider, local: group.local, computer: report.computer)) {
                        ForEach(group.models) { one in
                            Button {
                                if one.id != on { model.setChatModel(one, for: chat) }
                            } label: {
                                if one.id == on {
                                    Label(one.name, systemImage: "checkmark")
                                } else {
                                    Text(one.name)
                                }
                            }
                            .accessibilityIdentifier("model.\(one.id)")
                        }
                    }
                }
                if let levels = current?.efforts, !levels.isEmpty {
                    Section("Reasoning") {
                        ForEach(levels, id: \.self) { effort in
                            Button {
                                if effort != level { model.setChatModel(effort: effort, for: chat) }
                            } label: {
                                if effort == level {
                                    Label(StatusModel.word(effort), systemImage: "checkmark")
                                } else {
                                    Text(StatusModel.word(effort))
                                }
                            }
                            .accessibilityIdentifier("effort.\(effort)")
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(current?.name ?? Self.roughName(on))
                        .lineLimit(1)
                    if let level, current?.efforts?.isEmpty == false {
                        Text(StatusModel.word(level))
                            .foregroundStyle(palette.inkFaint)
                    }
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(palette.inkFaint)
                }
                .font(.ruri(.caption, .medium))
                .foregroundStyle(palette.inkSoft)
                .padding(.horizontal, 12)
                .frame(height: 34)
                .glass(Capsule(), fallback: palette.fill)
                // a thumb's worth of room round a small mark
                .frame(height: 44)
                .contentShape(.rect)
            }
            .accessibilityLabel("This chat's model: \(current?.name ?? Self.roughName(on))")
            .accessibilityIdentifier("chat.model")
        }
    }
}
