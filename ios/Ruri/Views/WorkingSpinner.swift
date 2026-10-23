import SwiftUI

/// The small system spinner: what is at work. Nothing else is marked — a
/// chat that waits, rests or stopped says so in words.
struct WorkingSpinner: View {
    var body: some View {
        ProgressView()
            .controlSize(.small)
            .scaleEffect(0.8)
            .frame(width: 16, height: 16)
            .accessibilityLabel("Working")
    }
}

extension View {
    /// While the Mac can't be reached, what is shown is the last picture of
    /// it: grayed out.
    func grayedWhenOffline(_ link: RuriModel.Link) -> some View {
        opacity(link == .offline ? 0.45 : 1)
    }
}
