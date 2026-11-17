import SwiftUI
import UIKit

/// How long a press is held before it counts as one: the Mac's hold on
/// Enter (web/src/components/Composer.tsx, CUT_IN_HOLD_MS).
let holdSeconds = 0.6

/// Something that does one thing on a tap and another when held down: the
/// send button, which sends on a tap and cuts in when held, and a queued
/// prompt, which goes now when held. The label is told how far the hold
/// has come, to draw it filling.
///
/// It reads the touch itself rather than stacking a tap and a long press,
/// which would each fire on the same finger. So it belongs where nothing
/// scrolls under it.
struct HoldButton<Label: View>: View {
    /// Whether holding does anything; without it a press is only a tap.
    var holds = true
    var enabled = true
    var tap: (() -> Void)?
    var hold: () -> Void
    @ViewBuilder var label: (_ pressed: Bool, _ progress: Double) -> Label

    /// True for as long as a finger is down; the system puts it back when
    /// the touch ends or is taken away.
    @GestureState private var touching = false
    @State private var pressed = false
    @State private var progress = 0.0
    /// This press is over — it became a hold, or wandered off — though the
    /// finger is still down.
    @State private var spent = false
    @State private var timer: Task<Void, Never>?

    /// How far the finger may wander and still be pressing.
    private let reach: CGFloat = 44

    private func far(_ value: DragGesture.Value) -> Bool {
        abs(value.translation.width) > reach || abs(value.translation.height) > reach
    }

    var body: some View {
        label(pressed, progress)
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .updating($touching) { _, state, _ in state = true }
                    .onChanged { value in
                        guard !spent else { return }
                        if !pressed { begin() }
                        if far(value) {
                            spent = true
                            release()
                        }
                    }
                    .onEnded { value in
                        let tapped = pressed && !spent && !far(value)
                        release()
                        spent = false
                        if tapped { tap?() }
                    }
            )
            // a touch the system took away never ends: nothing fires for it
            .onChange(of: touching) { _, now in
                guard !now else { return }
                Task { @MainActor in
                    release()
                    spent = false
                }
            }
            .allowsHitTesting(enabled)
            .opacity(enabled ? 1 : 0.35)
            .onDisappear { release() }
    }

    private func begin() {
        pressed = true
        guard holds else { return }
        withAnimation(.linear(duration: holdSeconds)) { progress = 1 }
        timer = Task { @MainActor in
            try? await Task.sleep(for: .seconds(holdSeconds))
            guard !Task.isCancelled, pressed, touching else { return }
            spent = true
            timer = nil
            pressed = false
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            withAnimation(.easeOut(duration: 0.2)) { progress = 0 }
            hold()
        }
    }

    private func release() {
        timer?.cancel()
        timer = nil
        pressed = false
        if progress != 0 { withAnimation(.easeOut(duration: 0.15)) { progress = 0 } }
    }
}
