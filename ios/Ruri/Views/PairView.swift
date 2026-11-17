import SwiftUI

/// First launch, or after unpairing: how to pair with the Mac — scan the
/// code its Settings → Devices shows, or paste the link.
struct PairView: View {
    @Environment(RuriModel.self) private var model
    @Environment(\.palette) private var palette
    @State private var scanning = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 12)
            Image("Mark")
                .resizable()
                .scaledToFit()
                .frame(width: 96)
                .accessibilityHidden(true)
            Text("ruri")
                .font(.ruri(.largeTitle, .bold))
                .padding(.top, 16)
            Text("What your Mac is working on, and a way to talk to it.")
                .font(.ruri(.callout))
                .foregroundStyle(palette.inkSoft)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
            Spacer(minLength: 12)
            VStack(alignment: .leading, spacing: 14) {
                Step(number: 1, text: "On your Mac, open ruri's Settings, then Devices.")
                Step(number: 2, text: "Choose Pair a phone.")
                Step(number: 3, text: "Scan the code with this iPhone's camera.")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .card(palette.raised)
            Spacer(minLength: 12)
            VStack(spacing: 12) {
                if QRScanner.isAvailable {
                    Button {
                        scanning = true
                    } label: {
                        Label("Scan Code", systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(PrimaryButton())
                }
                PasteButton(payloadType: String.self) { texts in
                    let text = texts.first ?? ""
                    Task { @MainActor in await model.pair(text) }
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)
                .tint(palette.ink)
                Text("Away from home, turn on Tailscale on this iPhone and your Mac.")
                    .font(.ruri(.footnote))
                    .foregroundStyle(palette.inkSoft)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(palette.ground.ignoresSafeArea())
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
    @Environment(\.palette) private var palette

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(number)")
                .font(.ruri(.subheadline, .bold))
                .foregroundStyle(palette.inkFaint)
                .frame(width: 16)
            Text(text)
                .font(.ruri(.callout))
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
