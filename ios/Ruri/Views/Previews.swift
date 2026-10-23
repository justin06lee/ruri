#if DEBUG
import SwiftUI

// Xcode's canvas, with a made-up Mac: every screen without one to pair with.

extension StatusReport {
    static var sample: StatusReport {
        let now = Date.now
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        return StatusReport(
            computer: "Justin's MacBook Pro",
            at: now,
            needsYou: [
                StatusNeed(
                    project: "lighthouse", who: "Lead", reason: .question,
                    text: "Should the lamp switch to the red lens tonight?", since: ago(4)
                ),
                StatusNeed(
                    project: "atlas", who: "Maps", reason: .card,
                    text: "Write MAPS-LEGEND.md", since: ago(1)
                ),
            ],
            projects: [
                StatusProject(
                    name: "lighthouse", state: .needsYou,
                    doingNow: "Lead asks: Should the lamp switch to the red lens tonight?", since: ago(4),
                    lead: StatusChat(
                        name: "Lead", role: .lead, state: .needsYou,
                        lastWords: "Should the lamp switch to the red lens tonight?", lastActive: ago(4)
                    ),
                    team: [
                        StatusChat(
                            name: "Lamp", role: .teammate, duty: "Keeps the lamp's log", state: .idle,
                            lastWords: "Wick trimmed, oil topped up.", lastActive: ago(26)
                        ),
                    ]
                ),
                StatusProject(
                    name: "orchard", state: .working,
                    doingNow: "Harvest: Weigh the last crates and say how many pounds in all", since: ago(12),
                    lead: StatusChat(
                        name: "Lead", role: .lead, state: .idle,
                        lastWords: "Harvest is weighing the last crates; I'll pass on the total.", lastActive: ago(12)
                    ),
                    team: [
                        StatusChat(
                            name: "Harvest", role: .teammate, duty: "What was picked and when", state: .working,
                            doing: "Weigh the last crates and say how many pounds in all",
                            lastWords: "Picked forty pounds of apples on Sunday.", lastActive: ago(40)
                        ),
                        StatusChat(
                            name: "Trees", role: .teammate,
                            duty: "Which tree grows where, and what each one needs through the year",
                            state: .idle,
                            lastWords: "Twelve apple trees and four pears, all marked on the plan, the two by the gate pruned back.",
                            lastActive: ago(95)
                        ),
                        StatusChat(
                            name: "Liaison", role: .liaison, state: .idle,
                            lastWords: "Handed grove's question to Trees.", lastActive: ago(300)
                        ),
                    ]
                ),
                StatusProject(
                    name: "garden", state: .blocked,
                    doingNow: "Beds: Stopped on an error: usage limit reached", since: ago(50),
                    lead: StatusChat(name: "Lead", role: .lead, state: .idle, lastWords: "Beds is on it.", lastActive: ago(52)),
                    team: [
                        StatusChat(
                            name: "Beds", role: .teammate, duty: "What is planted in each bed", state: .blocked,
                            lastWords: "Stopped on an error: usage limit reached", lastActive: ago(50)
                        ),
                    ]
                ),
                StatusProject(
                    name: "atlas", state: .idle, doingNow: "The maps are filed.", since: ago(180),
                    lead: StatusChat(name: "Lead", role: .lead, state: .idle, lastWords: "The maps are filed.", lastActive: ago(180)),
                    team: []
                ),
            ]
        )
    }
}

#Preview("Home") {
    HomeView()
        .environment(RuriModel(demo: .sample))
}

#Preview("A project") {
    NavigationStack {
        ProjectView(name: "orchard")
    }
    .environment(RuriModel(demo: .sample))
}

#Preview("Pairing") {
    PairView()
        .environment(RuriModel(demo: nil))
}
#endif
