import SwiftUI

extension StatusState {
    /// Green at work, grey at rest, red stopped, orange waiting on you.
    var tint: Color {
        switch self {
        case .working: .green
        case .idle: Color(.systemGray3)
        case .blocked: .red
        case .needsYou: .orange
        }
    }
}

/// A small dot for how something stands; one at work breathes.
struct StatusDot: View {
    var state: StatusState

    var body: some View {
        Image(systemName: "circle.fill")
            .font(.system(size: 9))
            .foregroundStyle(state.tint)
            .symbolEffect(.pulse, options: .repeating, isActive: state == .working)
            .accessibilityLabel(state.label)
    }
}

extension View {
    /// Sits a leading dot or symbol on the first line of text beside it.
    func onFirstLine(_ nudge: CGFloat = 0) -> some View {
        alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 + nudge }
    }
}
