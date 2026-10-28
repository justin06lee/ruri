import SwiftUI

/// The Mac this iPhone is paired with: whether it is reachable, and a way
/// to unpair.
struct MacSheet: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.dismiss) private var dismiss
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
                Section {
                    Button("Unpair This iPhone", role: .destructive) {
                        confirming = true
                    }
                } footer: {
                    Text("Your Mac lists this iPhone until you remove it there too, in ruri's Settings → Devices.")
                }
            }
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
    }
}
