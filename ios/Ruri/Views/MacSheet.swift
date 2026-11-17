import SwiftUI

/// The computer this iPhone shows: whether it is reachable, the others it
/// is paired with to switch to, how the app looks, what it is told of, and
/// a way to unpair.
struct MacSheet: View {
    /// Pair another computer: home's sheet takes over from this one.
    var pairAnother: () -> Void = {}
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Appearance.key) private var appearance = Appearance.system
    /// The computer asked to be unpaired from.
    @State private var unpairing: PairedMac?

    private var kind: String { model.mac?.kind ?? "Mac" }

    private var connection: String {
        switch model.link {
        case .live: "Live"
        case .connecting: "Connecting…"
        case .offline: model.asleepWords()
        case .unpaired: "Not paired"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(kind == "Mac" ? "Mac" : "Computer", value: model.report?.computer ?? model.mac?.name ?? "")
                    LabeledContent("Connection", value: connection)
                    if let mac = model.mac {
                        LabeledContent("Paired", value: mac.pairedAt.formatted(date: .abbreviated, time: .omitted))
                    }
                } footer: {
                    Text("Away from home, this iPhone reaches your \(kind) over Tailscale: keep it on, on both.")
                }
                .formRows(palette)
                Section {
                    ForEach(model.macs) { mac in
                        MacRow(mac: mac, label: model.label(mac), shown: mac.deviceId == model.mac?.deviceId) {
                            dismiss()
                            model.switchTo(mac.deviceId)
                        }
                        .swipeActions {
                            Button("Unpair", role: .destructive) { unpairing = mac }
                        }
                    }
                    Button(action: pairAnother) {
                        HStack(spacing: 12) {
                            Image(systemName: "plus")
                                .font(.system(size: 15, weight: .medium))
                                .frame(width: 24)
                            Text("Pair Another Computer…")
                        }
                        .foregroundStyle(palette.ink)
                    }
                    .accessibilityIdentifier("mac.pairAnother")
                } header: {
                    Text("Computers")
                } footer: {
                    Text("One is shown at a time; each tells this iPhone of its own projects.")
                }
                .formRows(palette)
                Section {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases) { appearance in
                            Text(appearance.label).tag(appearance)
                        }
                    }
                    NavigationLink("Notifications") {
                        NotificationsView()
                    }
                }
                .formRows(palette)
                if let mac = model.mac {
                    Section {
                        Button("Unpair from \(mac.name)", role: .destructive) {
                            unpairing = mac
                        }
                        .foregroundStyle(palette.destructive)
                    } footer: {
                        Text("\(mac.name) lists this iPhone until you remove it there too, in ruri's Settings → Devices.")
                    }
                    .formRows(palette)
                }
            }
            .formSurface(palette)
            .navigationTitle("Your \(kind)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                "Unpair from \(unpairing?.name ?? "it")?",
                isPresented: Binding { unpairing != nil } set: { if !$0 { unpairing = nil } },
                titleVisibility: .visible,
                presenting: unpairing
            ) { mac in
                Button("Unpair", role: .destructive) {
                    // the last one: back to pairing, with nothing left to show here
                    if model.macs.count == 1 { dismiss() }
                    model.unpair(mac.deviceId)
                }
            } message: { mac in
                Text("To pair with \(mac.name) again, you'll need a new code from it.")
            }
        }
        .presentationDetents([.medium, .large])
        // the sheet is its own window: it is dressed again
        .themed()
    }
}

/// A paired computer in the sheet's list: the one shown ticked, another
/// switched to with a tap.
private struct MacRow: View {
    var mac: PairedMac
    var label: String
    var shown: Bool
    var pick: () -> Void
    @Environment(\.palette) private var palette

    var body: some View {
        Button {
            if !shown { pick() }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: mac.symbol)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(palette.inkSoft)
                    .frame(width: 24)
                Text(label)
                    .foregroundStyle(palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if shown {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(palette.accent)
                }
            }
            .contentShape(.rect)
        }
        .accessibilityAddTraits(shown ? .isSelected : [])
        .accessibilityIdentifier("mac.\(label)")
    }
}

extension View {
    /// A form in the theme's shades: its groups a shade off its ground.
    /// Each section says its own rows' shade (`formRows`).
    func formSurface(_ palette: Palette) -> some View {
        scrollContentBackground(.hidden)
            .background(palette.ground.ignoresSafeArea())
    }

    /// A form section's rows, on the theme's raised shade.
    func formRows(_ palette: Palette) -> some View {
        listRowBackground(palette.raised)
    }
}
