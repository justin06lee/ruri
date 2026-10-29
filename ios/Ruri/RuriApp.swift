import SwiftUI

@main
struct RuriApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = RuriModel()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // a pairing code scanned with the Camera app opens here
                .onOpenURL { url in
                    Task { await model.pair(url.absoluteString) }
                }
        }
        .onChange(of: phase, initial: true) { _, phase in
            switch phase {
            case .active: model.wake()
            case .background: model.sleep()
            default: break
            }
        }
    }
}

/// Pairing until there is a Mac, then home — with pairing's progress and
/// troubles over either.
struct RootView: View {
    @Environment(RuriModel.self) private var model

    private var failed: Binding<Bool> {
        Binding {
            if case .failed = model.pairing { true } else { false }
        } set: { shown in
            if !shown { model.pairing = .idle }
        }
    }

    var body: some View {
        Group {
            if model.mac == nil {
                PairView()
            } else {
                HomeView()
            }
        }
        .overlay {
            if case .pairing(let name) = model.pairing {
                ZStack {
                    Color.black.opacity(0.15).ignoresSafeArea()
                    VStack(spacing: 14) {
                        ProgressView()
                            .controlSize(.large)
                        Text("Pairing with \(name)…")
                            .font(.subheadline)
                    }
                    .padding(28)
                    .background(.regularMaterial, in: .rect(cornerRadius: 20))
                }
                .transition(.opacity)
            }
        }
        .animation(.default, value: model.pairing)
        .alert("Couldn't Pair", isPresented: failed) {
            Button("OK") {}
        } message: {
            if case .failed(let words) = model.pairing { Text(words) }
        }
    }
}
