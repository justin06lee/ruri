import SwiftUI

/// First launch, or after unpairing: how to pair with the Mac — scan the
/// code its Settings → Devices shows, or paste the link. From home, in a
/// sheet (`adding`), the same for another computer.
struct PairView: View {
    /// Another computer, beside those paired.
    var adding = false
    /// Pairing has begun: its progress shows over home.
    var started: () -> Void = {}
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
            Text(adding ? "Another computer" : "ruri")
                .font(.ruri(.largeTitle, .bold))
                .padding(.top, 16)
            Text(
                adding
                    ? "Pair a Mac, or ruri on any computer: switch between them from the name on home."
                    : "What your Mac is working on, and a way to talk to it."
            )
                .font(.ruri(.callout))
                .foregroundStyle(palette.inkSoft)
                .multilineTextAlignment(.center)
                .padding(.top, 4)
            Spacer(minLength: 12)
            VStack(alignment: .leading, spacing: 14) {
                Step(number: 1, text: adding ? "On that computer, open ruri's Settings, then Devices." : "On your Mac, open ruri's Settings, then Devices.")
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
                    Task { @MainActor in
                        started()
                        await model.pair(text)
                    }
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)
                .tint(palette.ink)
                Text(adding ? "Away from home, turn on Tailscale on this iPhone and that computer." : "Away from home, turn on Tailscale on this iPhone and your Mac.")
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
                started()
                Task { await model.pair(code) }
            }
        }
    }
}

/// Pairing another computer, over home: the same steps in a sheet, which
/// closes as pairing begins — its progress, and any trouble, show over home.
struct PairSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            PairView(adding: true) { dismiss() }
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
        }
        // the sheet is its own window: it is dressed again
        .themed()
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
