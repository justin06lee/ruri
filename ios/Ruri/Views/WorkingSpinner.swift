import SwiftUI

// What is at work is marked by the dragon's head (DragonHead.swift), as in
// ruri's window: this file keeps what else says how things stand.

extension View {
    /// While the Mac can't be reached, what is shown is the last picture of
    /// it: grayed out.
    func grayedWhenOffline(_ link: RuriModel.Link) -> some View {
        opacity(link == .offline ? 0.45 : 1)
    }
}
