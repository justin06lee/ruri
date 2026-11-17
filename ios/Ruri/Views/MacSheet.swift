import SwiftUI

/// The Mac this iPhone is paired with: whether it is reachable, how the app
/// looks, what it is told of, and a way to unpair.
struct MacSheet: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Appearance.key) private var appearance = Appearance.system
    @State private var confirming = false

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
                    LabeledContent("Mac", value: model.report?.computer ?? model.mac?.name ?? "")
                    LabeledContent("Connection", value: connection)
                    if let mac = model.mac {
                        LabeledContent("Paired", value: mac.pairedAt.formatted(date: .abbreviated, time: .omitted))
                    }
                } footer: {
                    Text("Away from home, this iPhone reaches your Mac over Tailscale: keep it on, on both.")
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
                Section {
                    Button("Unpair This iPhone", role: .destructive) {
                        confirming = true
                    }
                    .foregroundStyle(palette.destructive)
                } footer: {
                    Text("Your Mac lists this iPhone until you remove it there too, in ruri's Settings → Devices.")
                }
                .formRows(palette)
            }
            .formSurface(palette)
            .navigationTitle("Your Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) {
                    dismiss()
                    model.unpair()
                }
            } message: {
                Text("To pair again, you'll need a new code from your Mac.")
            }
        }
        .presentationDetents([.medium, .large])
        // the sheet is its own window: it is dressed again
        .themed()
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
