#if DEBUG
import Foundation

// Made-up data: every screen without a Mac to pair with — in Xcode's canvas
// (Previews.swift), and in the app run for a look at it (ios/demo/mac.sh).

extension StatusReport {
    static var sample: StatusReport {
        let now = Date.now
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        var report = StatusReport(
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
        for at in report.projects.indices {
            report.projects[at].macId = "p-\(report.projects[at].name)"
            report.projects[at].starred = ["lighthouse", "atlas"].contains(report.projects[at].name) ? true : nil
        }
        report.usage = [
            StatusUsage(
                name: "Claude", fiveHour: 34, weekly: 12, scoped: .init(label: "Fable", percent: 92),
                resets: .init(fiveHour: now.addingTimeInterval(4_200), weekly: now.addingTimeInterval(5 * 86_400)),
                at: now
            ),
            StatusUsage(name: "Codex", fiveHour: 3, weekly: 41, at: now),
        ]
        report.sidebar = SidebarLayout(
            order: ["f-work", "p-garden", "p-atlas"],
            folders: [SidebarLayout.Folder(id: "f-work", name: "C & Tech", projects: ["p-lighthouse", "p-orchard"])]
        )
        return report
    }
}

extension ChatFrame {
    /// A conversation with a bit of everything in it: a prompt, steps, a
    /// reply written in markdown, another agent's message, a stop, and two
    /// prompts waiting in the queue.
    static var sample: ChatFrame {
        let now = Date.now
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        return ChatFrame(
            chat: "sample", name: "lighthouse", project: "lighthouse", state: .working,
            queue: [
                ChatQueued(id: "q1", text: "And log the swap in LAMP.md when it's done."),
                ChatQueued(id: "q2", text: "Then tell orchard the fog is in, so nobody rows out tonight."),
            ],
            items: [
                ChatItem(id: "u1", kind: .user, text: "Is the lamp ready for tonight? Fog is coming in.", at: ago(9)),
                ChatItem(
                    id: "t1", kind: .steps, text: "3 steps",
                    steps: ["Read: LAMP.md", "Bash: lamp status --json", "Grep: lens in docs/"], at: ago(9)
                ),
                ChatItem(
                    id: "a1", kind: .assistant,
                    text: """
                        **The lamp is ready**, with one thing to decide.

                        Fog is thick past the *north point* ([log](https://ruri.codes)), and the clear lens loses about a third of its reach in it.

                        - Red carries farther in fog
                        - Swapping takes `10 min`

                        ```sh
                        lamp swap --lens red --brightness 80
                        ```

                        Should I go ahead and fit the red lens?
                        """,
                    at: ago(8)
                ),
                ChatItem(id: "u2", kind: .user, text: "Yes, fit it. Keep the brightness at 80.", at: ago(6)),
                ChatItem(id: "l1", kind: .user, text: "Harvest is in. Nobody is on the water.", from: "orchard", at: ago(5)),
                ChatItem(id: "t2", kind: .steps, text: "1 step", steps: ["Bash: lamp swap --lens red --brightness 80"], at: ago(4)),
                ChatItem(id: "n1", kind: .note, text: "Stopped", at: ago(3)),
                ChatItem(id: "u3", kind: .user, text: "Sorry, carry on.", at: ago(2)),
                ChatItem(
                    id: "draft:m1", kind: .assistant, text: "Fitting the red lens now. The old one is out and", at: ago(0),
                    pending: true
                ),
            ]
        )
    }
}
#endif
