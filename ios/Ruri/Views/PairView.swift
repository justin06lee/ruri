import SwiftUI

/// First launch, or after unpairing: how to pair with the Mac — scan the
/// code its Settings → Devices shows, or paste the link.
struct PairView: View {
    @Environment(RuriModel.self) private var model
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Image("Mark")
                .resizable()
                .scaledToFit()
                .frame(width: 112)
                .accessibilityHidden(true)
            Text("ruri")
                .font(.largeTitle.bold())
                .padding(.top, 18)
            Text("What your Mac is working on, at a glance.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
            Spacer()
            VStack(alignment: .leading, spacing: 14) {
                Step(number: 1, text: "On your Mac, open ruri's Settings, then Devices.")
                Step(number: 2, text: "Choose Pair a Phone.")
                Step(number: 3, text: "Scan the code with this iPhone's camera.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            Spacer()
            VStack(spacing: 14) {
                if QRScanner.isAvailable {
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan Code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
                PasteButton(payloadType: String.self) { texts in
                    let text = texts.first ?? ""
                    Task { @MainActor in await model.pair(text) }
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)
                Text("Away from home, turn on Tailscale on this iPhone and your Mac.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
        }
        .padding(24)
        .sheet(isPresented: $scanning) {
            ScanSheet { code in
                scanning = false
                Task { await model.pair(code) }
            }
        }
    }
}

private struct Step: View {
    var number: Int
    var text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.tint)
                .frame(width: 18)
            Text(text)
        }
    }
}

/// The camera, looking for a pairing code.
private struct ScanSheet: View {
    var found: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            QRScanner(found: found)
                .ignoresSafeArea()
                .navigationTitle("Scan the Code on Your Mac")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
    }
}
