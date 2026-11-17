#if DEBUG
import SwiftUI

// Xcode's canvas, on made-up data (Samples.swift): every screen without a
// Mac to pair with.

#Preview("Home") {
    HomeView()
        .environment(RuriModel(demo: .sample))
        .themed()
}

#Preview("A project") {
    NavigationStack {
        ProjectView(name: "orchard")
    }
    .environment(RuriModel(demo: .sample))
    .themed()
}

#Preview("A chat") {
    let model = RuriModel(demo: .sample)
    NavigationStack {
        ChatView(route: ChatRoute(id: "sample", name: "lighthouse"), made: ChatSession(sample: .sample, model: model))
    }
    .environment(model)
    .themed()
}

#Preview("Pairing") {
    PairView()
        .environment(RuriModel(demo: nil))
        .themed()
}
#endif
