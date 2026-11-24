import Foundation
import Testing
import UIKit

@testable import Ruri

struct PairingLinkTests {
    @Test func readsACode() throws {
        let link = try PairingLink(
            parsing: "ruri://pair?v=1&name=Justin%27s%20MacBook&port=7775&fp=4HIJNkWiEixTxogoZdf7YaVvDlVyrqD9Mg0exX-5gAw&ticket=abc_-123&exp=1792612737&addr=100.101.102.103&addr=192.168.1.20&addr=justins-mbp.local\n"
        )
        #expect(link.name == "Justin's MacBook")
        #expect(link.port == 7775)
        #expect(link.fingerprint == "4HIJNkWiEixTxogoZdf7YaVvDlVyrqD9Mg0exX-5gAw")
        #expect(link.ticket == "abc_-123")
        #expect(link.addresses == ["100.101.102.103", "192.168.1.20", "justins-mbp.local"])
        #expect(link.expires == Date(timeIntervalSince1970: 1_792_612_737))
        #expect(!link.expired(now: Date(timeIntervalSince1970: 1_792_612_700)))
        #expect(link.expired(now: Date(timeIntervalSince1970: 1_792_612_900)))
    }

    @Test func readsAPlusAsASpace() throws {
        let link = try PairingLink(parsing: "ruri://pair?name=Justin%27s+Mac&port=7775&fp=f&ticket=t&a=10.0.0.2")
        #expect(link.name == "Justin's Mac")
        #expect(link.addresses == ["10.0.0.2"])
        #expect(link.expires == nil)
        #expect(!link.expired())
    }

    @Test func refusesWhatIsNotACode() {
        #expect(throws: PairingLink.Problem.notRuri) { try PairingLink(parsing: "https://ruri.codes/pair?fp=x") }
        #expect(throws: PairingLink.Problem.notRuri) { try PairingLink(parsing: "hello") }
        #expect(throws: PairingLink.Problem.newer) {
            try PairingLink(parsing: "ruri://pair?v=2&port=7775&fp=x&ticket=t&addr=1.2.3.4")
        }
        #expect(throws: PairingLink.Problem.incomplete) {
            try PairingLink(parsing: "ruri://pair?v=1&port=7775&ticket=t&addr=1.2.3.4")
        }
        #expect(throws: PairingLink.Problem.incomplete) {
            try PairingLink(parsing: "ruri://pair?v=1&port=99999&fp=x&ticket=t&addr=1.2.3.4")
        }
        #expect(throws: PairingLink.Problem.incomplete) {
            try PairingLink(parsing: "ruri://pair?v=1&port=7775&fp=x&ticket=t")
        }
    }

    @Test func triesTheLastAddressFirst() {
        var mac = PairedMac(
            name: "Mac", deviceId: "d", addresses: ["a", "b", "c"], port: 7775, fingerprint: "f",
            pairedAt: .now, lastAddress: nil
        )
        #expect(mac.tryOrder == ["a", "b", "c"])
        mac.lastAddress = "c"
        #expect(mac.tryOrder == ["c", "a", "b"])
        mac.lastAddress = "127.0.0.1"
        #expect(mac.tryOrder == ["127.0.0.1", "a", "b", "c"])
    }

    @Test func keepsEveryComputerPaired() {
        func mac(_ id: String, _ fingerprint: String, _ name: String = "Mac") -> PairedMac {
            PairedMac(
                name: name, deviceId: id, addresses: ["a"], port: 7775, fingerprint: fingerprint,
                pairedAt: .now, lastAddress: nil
            )
        }
        var paired = PairedMacs()
        #expect(paired.shown == nil)
        paired.add(mac("d1", "f1", "studio"))
        #expect(paired.add(mac("d2", "f2", "tenet")) == nil)
        // the last paired is shown; the first stays
        #expect(paired.macs.map(\.deviceId) == ["d1", "d2"])
        #expect(paired.shown?.name == "tenet")
        // the same computer paired again takes its old place, under its new id
        #expect(paired.add(mac("d3", "f1", "studio"))?.deviceId == "d1")
        #expect(paired.macs.map(\.deviceId) == ["d3", "d2"])
        #expect(paired.current == "d3")
        // two ruris on one computer are told apart by their doors
        #expect(paired.label(paired.macs[1]) == "tenet")
        var twin = mac("d4", "f4", "tenet")
        twin.port = 7776
        paired.add(twin)
        #expect(paired.label(paired.macs[1]) == "tenet · 7775")
        #expect(paired.label(twin) == "tenet · 7776")
        paired.remove("d4")
        // the one shown forgotten: the next is shown
        paired.current = "d3"
        paired.remove("d3")
        #expect(paired.shown?.deviceId == "d2")
        paired.remove("d2")
        #expect(paired.shown == nil)
    }

    @Test func aComputerSaysWhatItIs() {
        var mac = PairedMac(
            name: "tenet", deviceId: "d", addresses: [], port: 7775, fingerprint: "f", pairedAt: .now, lastAddress: nil
        )
        #expect(mac.kind == "Mac")
        mac.platform = "linux"
        #expect(mac.kind == "computer")
        #expect(mac.symbol == "server.rack")
    }

    @Test func writesAddressesAsURLs() {
        #expect(MacClient.url("192.168.1.20", port: 7775, path: "/status")?.absoluteString == "https://192.168.1.20:7775/status")
        #expect(MacClient.url("fe80::1", port: 7775, path: "/status")?.absoluteString == "https://[fe80::1]:7775/status")
        #expect(MacClient.url("mac.local", port: 7775, path: "/status")?.absoluteString == "https://mac.local:7775/status")
    }
}

struct PinningTests {
    /// A certificate server/tlsCert.ts made, and the fingerprint its
    /// fingerprint() gave it.
    static let der = Data(
        base64Encoded: "MIIBPDCB46ADAgECAhAC0Lv+cyPjrcVwN8vrNpY0MAoGCCqGSM49BAMCMA8xDTALBgNVBAMMBHJ1cmkwHhcNMjYxMDIxMTkxNzM5WhcNNDYxMDIxMjAxNzM5WjAPMQ0wCwYDVQQDDARydXJpMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9dK/qcG410IPej7sRdvPNF0/ya4dx5gyhm9n35iB3TWq2Cr5VyBIGHWLc+kvfXkYHwcsZc/Yinj6IHRWDQa16aMhMB8wDAYDVR0TAQH/BAIwADAPBgNVHREECDAGggRydXJpMAoGCCqGSM49BAMCA0gAMEUCIEbTJZqnqx9mLySdLdE5y4ab3+mE31KuzffaD1MhmhksAiEAityZgqRZkR2+UjA08RMLDj+faQCFGTTVMos1AkSp5eQ="
    )!

    @Test func fingerprintsAsTheMacDoes() {
        #expect(Pinning.fingerprint(of: Self.der) == "4HIJNkWiEixTxogoZdf7YaVvDlVyrqD9Mg0exX-5gAw")
    }
}

struct EventStreamTests {
    private func read(_ text: String) -> [EventStream.Read] {
        var stream = EventStream()
        return text.utf8.map { stream.feed($0) }.filter { $0 != .nothing }
    }

    @Test func readsEventsAndComments() {
        let reads = read("event: status\ndata: {\"a\":1}\n\n: still here\n\nevent: status\ndata: {\"a\":2}\n\n")
        #expect(reads == [
            .event(.init(name: "status", data: "{\"a\":1}")),
            .comment,
            .event(.init(name: "status", data: "{\"a\":2}")),
        ])
    }

    @Test func readsCRLFAndManyDataLines() {
        let reads = read("event: status\r\ndata: one\r\ndata: two\r\n\r\ndata:three\n\n")
        #expect(reads == [
            .event(.init(name: "status", data: "one\ntwo")),
            .event(.init(name: "message", data: "three")),
        ])
    }

    @Test func waitsForTheBlankLine() {
        #expect(read("event: status\ndata: {}\n").isEmpty)
    }
}

struct StatusTests {
    static let json = """
        {
          "computer": "Justin's MacBook",
          "at": "2026-10-21T20:01:02.345Z",
          "needsYou": [
            { "project": "ruri", "who": "Lead", "reason": "question",
              "text": "Merge feat/ios-app now?", "since": "2026-10-21T19:58:57.123Z" }
          ],
          "projects": [
            { "name": "ruri", "state": "needs-you", "doingNow": "Lead asks: Merge feat/ios-app now?",
              "since": "2026-10-21T19:58:57.123Z",
              "lead": { "name": "Lead", "role": "lead", "state": "needs-you",
                        "lastWords": "Merge feat/ios-app now?", "lastActive": "2026-10-21T19:58:57.123Z" },
              "team": [
                { "name": "iPhone app", "role": "teammate", "duty": "Owns the iPhone app", "state": "working",
                  "doing": "Build the app", "lastWords": "" },
                { "name": "Liaison", "role": "liaison", "state": "dozing", "lastWords": "" }
              ] },
            { "name": "mira", "state": "idle", "doingNow": "", "team": [] }
          ]
        }
        """

    @Test func readsAReport() throws {
        let report = try StatusReport.decoder().decode(StatusReport.self, from: Data(Self.json.utf8))
        #expect(report.computer == "Justin's MacBook")
        #expect(report.needsYou.first?.reason == .question)
        #expect(report.projects.map(\.state) == [.needsYou, .idle])
        let ruri = try #require(report.project(named: "ruri"))
        #expect(ruri.lead?.role == .lead)
        #expect(ruri.team.map(\.state) == [.working, .idle])
        #expect(ruri.team.last?.role == .liaison)
        #expect(report.needs(of: "ruri").count == 1)
        #expect(report.needs(of: "mira").isEmpty)
        let since = try #require(ruri.since)
        #expect(abs(since.timeIntervalSince1970 - 1_792_612_737.123) < 0.001)
    }

    @Test func readsAccounts() throws {
        let json = """
            {
              "computer": "Mac", "at": "2026-11-17T09:00:00.000Z", "needsYou": [],
              "projects": [
                { "name": "ruri", "state": "idle", "doingNow": "", "id": "p-ruri",
                  "lead": { "name": "Lead", "role": "lead", "state": "idle", "lastWords": "", "id": "c-lead",
                            "accounts": { "claude": "work", "codex": "codex" } },
                  "team": [], "accounts": { "claude": "personal", "codex": "codex" } }
              ],
              "accounts": [
                { "id": "work", "name": "Work", "provider": "claude", "signedIn": true, "who": "me@work.dev" },
                { "id": "personal", "name": "Personal", "provider": "claude", "signedIn": false }
              ],
              "usage": [
                { "name": "Claude (Work)", "account": "work", "provider": "claude", "weekly": 66,
                  "scoped": { "label": "Fable", "percent": 100 } }
              ]
            }
            """
        let report = try StatusReport.decoder().decode(StatusReport.self, from: Data(json.utf8))
        #expect(report.accounts?.map(\.id) == ["work", "personal"])
        #expect(report.accounts?.last?.signedIn == false)
        let ruri = try #require(report.project(holding: "c-lead"))
        #expect(ruri.accounts?["claude"] == "personal")
        // its chat on an account of its own
        #expect(report.chat("c-lead")?.accounts?["claude"] == "work")
        let work = try #require(report.usage(of: "work"))
        #expect(work.fullest?.label == "Fable")
        #expect(work.fullest?.percent == 100)
        #expect(report.usage(of: "personal") == nil)
    }

    @Test func readsModels() throws {
        let json = """
            {
              "computer": "Mac mini", "at": "2026-11-19T09:00:00.000Z", "needsYou": [],
              "projects": [
                { "name": "ruri", "state": "idle", "doingNow": "", "id": "p-ruri",
                  "lead": { "name": "Lead", "role": "lead", "state": "idle", "lastWords": "", "id": "c-lead",
                            "model": "codex:gpt-6", "effort": "medium" },
                  "team": [
                    { "name": "Server", "role": "teammate", "state": "idle", "lastWords": "", "id": "c-server",
                      "model": "opencode:ollama/bonsai-2:latest", "effort": "high" },
                    { "name": "Old", "role": "teammate", "state": "idle", "lastWords": "", "id": "c-old",
                      "model": "opencode:zen/gone-model", "effort": "high" }
                  ] }
              ],
              "models": [
                { "id": "fable", "name": "Fable 5.2", "provider": "Claude", "harness": "claude",
                  "efforts": ["low", "high", "xhigh"], "defaultEffort": "high" },
                { "id": "codex:gpt-6", "name": "GPT-6", "provider": "Codex", "harness": "codex",
                  "efforts": ["low", "medium"], "defaultEffort": "medium" },
                { "id": "haiku", "name": "Haiku 4.5", "provider": "Claude", "harness": "claude" },
                { "id": "opencode:ollama/bonsai-2:latest", "name": "bonsai-2:latest", "provider": "Ollama",
                  "harness": "opencode", "local": true }
              ]
            }
            """
        let report = try StatusReport.decoder().decode(StatusReport.self, from: Data(json.utf8))
        #expect(report.model(of: "c-lead")?.name == "GPT-6")
        #expect(report.model(of: "c-lead")?.harness == "codex")
        #expect(report.model(of: "c-server")?.local == true)
        // a model the Mac no longer lists is still named, from its id
        #expect(report.model(of: "c-old") == nil)
        #expect(ModelMenu.roughName("opencode:zen/gone-model") == "gone-model")
        #expect(ModelMenu.roughName("codex:gpt-6") == "gpt-6")
        #expect(ModelMenu.roughName("claude-fable-5-2") == "claude-fable-5-2")
        // by who serves them, each lot in the Mac's order
        let groups = report.modelGroups
        #expect(groups.map(\.provider) == ["Claude", "Codex", "Ollama"])
        #expect(groups.first?.models.map(\.id) == ["fable", "haiku"])
        #expect(groups.map(\.local) == [false, false, true])
        #expect(ModelMenu.heading("Ollama", local: true, computer: "Mac mini") == "Ollama · on Mac mini")
        #expect(ModelMenu.heading("Claude", local: false, computer: "Mac mini") == "Claude")
    }

    @Test func aModelsLevel() {
        let fable = StatusModel(
            id: "fable", name: "Fable", provider: "Claude", efforts: ["low", "high", "xhigh"], defaultEffort: "high"
        )
        // its own while the model takes it, else the model's
        #expect(fable.effort(keeping: "xhigh") == "xhigh")
        #expect(fable.effort(keeping: "minimal") == "high")
        #expect(fable.effort(keeping: nil) == "high")
        let bare = StatusModel(id: "x", name: "X", provider: "Codex", efforts: ["low", "medium"])
        #expect(bare.effort(keeping: "xhigh") == "low")
        // a model with no levels leaves the chat's own alone, for when it leaves
        let local = StatusModel(id: "l", name: "bonsai", provider: "Ollama", local: true)
        #expect(local.effort(keeping: "xhigh") == "xhigh")
        #expect(StatusModel.word("xhigh") == "XHigh")
        #expect(StatusModel.word("medium") == "Medium")
    }

    @MainActor @Test func putsAChatOnAModelAtOnce() throws {
        var sample = StatusReport.sample
        sample.projects[0].lead?.effort = "xhigh"
        let model = RuriModel(demo: sample)
        let codex = try #require(model.report?.models?.first { $0.harness == "codex" })
        #expect(model.report?.chat("sample")?.model == "claude-fable-5-2")
        model.setChatModel(codex, for: "sample")
        // on it here before the Mac has answered, at a level it takes
        #expect(model.report?.chat("sample")?.model == codex.id)
        #expect(model.report?.chat("sample")?.effort == "medium")
        model.setChatModel(effort: "low", for: "sample")
        #expect(model.report?.chat("sample")?.effort == "low")
        #expect(model.report?.chat("sample")?.model == codex.id)
        // nothing asked is nothing done
        model.setChatModel(for: "sample")
        model.setChatModel(codex, for: "no-such-chat")
        #expect(model.report?.chat("sample")?.model == codex.id)
    }

    @Test func listsWhatIsWorking() throws {
        let report = try StatusReport.decoder().decode(StatusReport.self, from: Data(Self.json.utf8))
        // the iPhone app teammate is at work: named by its project and itself
        #expect(report.working.map(\.chat.name) == ["ruri · iPhone app"])
        #expect(report.working.map(\.title) == ["iPhone app"])
    }

    @Test func keepsWhatItReads() throws {
        let report = try StatusReport.decoder().decode(StatusReport.self, from: Data(Self.json.utf8))
        let again = try StatusReport.decoder().decode(
            StatusReport.self, from: StatusReport.encoder().encode(report)
        )
        #expect(again.projects.map(\.name) == report.projects.map(\.name))
        #expect(again.needsYou.first?.text == report.needsYou.first?.text)
    }

    @Test func saysHowLongAgo() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(Ago.short(now.addingTimeInterval(-30), now: now) == "now")
        #expect(Ago.short(now.addingTimeInterval(-300), now: now) == "5m")
        #expect(Ago.short(now.addingTimeInterval(-7_200), now: now) == "2h")
        #expect(Ago.long(now.addingTimeInterval(-12), now: now) == "12s ago")
        #expect(Ago.span(now.addingTimeInterval(-3_700), now: now) == "1 hour")
        #expect(Ago.span(now.addingTimeInterval(-600), now: now) == "10 minutes")
    }
}

struct MarkdownTests {
    @Test func splitsBlocks() {
        let blocks = MarkdownParser.parse("""
        ## Plan
        Do **this** first,
        then that.

        - one
          - nested
        2. two

        ```sh
        make test
          indented
        ```
        > quoted
        ---
        """)
        #expect(blocks == [
            .heading(level: 2, text: "Plan"),
            .paragraph("Do **this** first,\nthen that."),
            .item(depth: 0, number: nil, text: "one"),
            .item(depth: 1, number: nil, text: "nested"),
            .item(depth: 0, number: 2, text: "two"),
            .code(language: "sh", text: "make test\n  indented"),
            .quote("quoted"),
            .rule,
        ])
    }

    @Test func readsATable() {
        let blocks = MarkdownParser.parse("""
        Here it is:

        | Build | Size | Notes |
        |:------|-----:|:-----:|
        | desktop | 212 MB | **notarized** |
        | phone | 9 MB |
        | `a \\| b` | 1 \\| 2 | x | extra |

        After it.
        """)
        #expect(blocks == [
            .paragraph("Here it is:"),
            .table(
                header: ["Build", "Size", "Notes"],
                columns: [.leading, .trailing, .center],
                rows: [
                    ["desktop", "212 MB", "**notarized**"],
                    // a short row is filled out, a long one cut to the header
                    ["phone", "9 MB", ""],
                    // an escaped bar is the cell's own, in code too
                    ["`a | b`", "1 | 2", "x"],
                ]
            ),
            .paragraph("After it."),
        ])
    }

    @Test func aTableNeedsItsRowOfDashes() {
        // no leading or trailing bars is still a table
        #expect(MarkdownParser.parse("a | b\n--- | ---\n1 | 2") == [
            .table(header: ["a", "b"], columns: [.leading, .leading], rows: [["1", "2"]])
        ])
        // words with a bar in them are words, and so is a header still
        // waiting for its dashes (a reply being written)
        #expect(MarkdownParser.parse("yes | no") == [.paragraph("yes | no")])
        #expect(MarkdownParser.parse("| a | b |") == [.paragraph("| a | b |")])
        // dashes for another number of columns are not this header's
        #expect(MarkdownParser.parse("| a | b |\n|---|") == [.paragraph("| a | b |\n|---|")])
        // a rule under a line with a bar is a rule
        #expect(MarkdownParser.parse("a | b\n---") == [.paragraph("a | b"), .rule])
        // collapsed, a table reads a row a line
        let table = MarkdownParser.parse("| a | b |\n|---|---|\n| 1 | 2 |")[0]
        #expect(String(table.flattened.characters) == "a · b\n1 · 2")
    }

    @Test func keepsWhatIsNotMarkdown() {
        #expect(MarkdownParser.parse("#nospace is a tag\n3.14 is pi\n-5 degrees") ==
            [.paragraph("#nospace is a tag\n3.14 is pi\n-5 degrees")])
        #expect(MarkdownParser.parse("   \n") == [])
    }

    @Test func aFenceLeftOpenTakesTheRest() {
        #expect(MarkdownParser.parse("```\nlet x = 1\nlet y = 2") == [.code(language: nil, text: "let x = 1\nlet y = 2")])
    }

    @Test func readsInlineStylesAndLinks() {
        let text = MarkdownBlock.attributed("**bold** and `code` and [ruri](https://ruri.codes)")
        #expect(String(text.characters) == "bold and code and ruri")
        let runs = Array(text.runs)
        #expect(runs.first?.inlinePresentationIntent == .stronglyEmphasized)
        #expect(runs.contains { $0.link == URL(string: "https://ruri.codes") })
        #expect(runs.contains { $0.inlinePresentationIntent == .code })
    }

    @Test func flattensForACollapsedView() {
        let flat = MarkdownBlock.item(depth: 0, number: 3, text: "third").flattened
        #expect(String(flat.characters) == "3. third")
    }
}

struct ChatLogTests {
    private func item(_ id: String, _ text: String = "") -> ChatItem {
        ChatItem(id: id, kind: .assistant, text: text, at: .now)
    }

    private func frame(items: [ChatItem]? = nil, upsert: [ChatItem]? = nil, remove: [String]? = nil) -> ChatFrame {
        ChatFrame(chat: "c", name: "ruri", project: "ruri", state: .working, queue: [], items: items, upsert: upsert, remove: remove)
    }

    @Test func readsTheCardsAChatWaitsAt() throws {
        let json = """
        {"chat":"c","name":"ruri","project":"ruri","state":"needs-you","queue":[],"asks":[
          {"id":"p","kind":"permission","title":"Bash","detail":"rm -rf dist","byAgent":true},
          {"id":"q","kind":"question","title":"Which?","questions":[
            {"question":"Which?","header":"Approach","options":[{"label":"Rewrite","description":"from scratch"},{"label":"Patch"}],"multi":false,"other":true},
            {"question":"How many?","header":"","options":[],"multi":false,"other":true,"optional":true,"number":true}]},
          {"id":"s","kind":"question","title":"The key?","questions":[],"onMac":true},
          {"id":"n","kind":"something new","title":"x"}]}
        """
        var log = ChatLog()
        log.apply(try JSONDecoder().decode(ChatFrame.self, from: Data(json.utf8)))
        #expect(log.asks.map(\.id) == ["p", "q", "s", "n"])
        #expect(log.asks[0].byAgent == true && log.asks[0].detail == "rm -rf dist")
        #expect(log.asks[1].questions?.map(\.options.count) == [2, 0])
        #expect(log.asks[1].questions?[1].number == true)
        #expect(log.asks[2].onMac == true)
        // a kind this app doesn't know is shown as leave to give
        #expect(log.asks[3].kind == .permission)
        // the next frame without them: answered
        log.apply(frame(upsert: []))
        #expect(log.asks.isEmpty)
    }

    @Test func anAnswerSaysOnlyWhatItIs() throws {
        func sent(_ body: AnswerBody) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as! [String: Any]
        }
        let allow = try sent(AnswerBody(id: "c", ask: "p", allow: false))
        #expect(allow.keys.sorted() == ["allow", "ask", "id"] && allow["allow"] as? Bool == false)
        #expect(try sent(AnswerBody(id: "c", ask: "q", dismiss: true)).keys.sorted() == ["ask", "dismiss", "id"])
        let answers = try sent(AnswerBody(id: "c", ask: "q", answers: [ChatAnswered(picked: ["Patch"]), ChatAnswered(other: "three")]))
        let each = answers["answers"] as! [[String: Any]]
        #expect(each[0]["picked"] as? [String] == ["Patch"] && each[0]["other"] == nil)
        #expect(each[1]["picked"] as? [String] == [] && each[1]["other"] as? String == "three")
        #expect(ChatAnswered(other: "  ").given == false && ChatAnswered(picked: ["a"]).given)
    }

    @Test func takesTheWholeThenWhatChanged() {
        var log = ChatLog()
        log.apply(frame(items: [item("a", "1"), item("draft:m", "Hel")]))
        log.apply(frame(upsert: [item("b", "2")], remove: ["draft:m"]))
        #expect(log.items.map(\.id) == ["a", "b"])
        log.apply(frame(upsert: [item("a", "one")]))
        #expect(log.items.map(\.text) == ["one", "2"])
        log.apply(frame(items: [item("z")]))
        #expect(log.items.map(\.id) == ["z"])
    }

    @Test func knowsAPromptItHolds() {
        var log = ChatLog()
        var whole = frame(items: [ChatItem(id: "p1", kind: .user, text: "hi", at: .now)])
        whole.queue = [ChatQueued(id: "p2", text: "next")]
        log.apply(whole)
        #expect(log.holds("p1") && log.holds("p2") && !log.holds("p3"))
    }

    @Test func readsTheMacsFrame() throws {
        let json = #"{"chat":"c","name":"ruri","project":"ruri","state":"needs-you","queue":[],"items":[{"id":"t","kind":"steps","text":"2 steps","steps":["Read: a","Bash: b"],"at":"2026-10-27T10:00:00.000Z"},{"id":"x","kind":"something-new","text":"?","at":"2026-10-27T10:00:01Z"}]}"#
        let frame = try StatusReport.decoder().decode(ChatFrame.self, from: Data(json.utf8))
        #expect(frame.state == .needsYou)
        #expect(frame.items?.first?.steps?.count == 2)
        #expect(frame.items?.last?.kind == .note)
    }
}

struct AttachingTests {
    private func image(_ n: Int, kind: ChatAttachment.Kind = .image) -> Ruri.Attachment {
        Ruri.Attachment(id: "a\(n)", kind: kind, mediaType: "image/png", name: "x.png", n: n, data: Data([1]))
    }

    @Test func numbersEachKindOnItsOwn() {
        let held = [image(1), image(3), image(1, kind: .file)]
        #expect(Attaching.nextNumber(.image, among: held) == 4)
        #expect(Attaching.nextNumber(.file, among: held) == 2)
        #expect(Attaching.nextNumber(.video, among: held) == 1)
    }

    @Test func everyFileIsNamedInWhatGoesOut() {
        #expect(Attaching.prompt("  fix this  ", naming: []) == "fix this")
        #expect(Attaching.prompt("", naming: []) == "")
        #expect(Attaching.prompt("[image #1] fix this", naming: [image(1)]) == "[image #1] fix this")
        #expect(Attaching.prompt("fix this", naming: [image(1)]) == "[image #1] fix this")
        #expect(Attaching.prompt("", naming: [image(1), image(1, kind: .file)]) == "[image #1] [file #1]")
    }

    @Test func aBubbleLeavesOutTheMarkersLeadingIt() {
        #expect(Attaching.afterMarkers("[image #1]") == "")
        #expect(Attaching.afterMarkers(" [image #1] [file #2] ") == "")
        #expect(Attaching.afterMarkers("[image #1] fix this") == "fix this")
        #expect(Attaching.afterMarkers("fix [image #1] and this") == "fix [image #1] and this")
        #expect(Attaching.afterMarkers("") == "")
    }

    private func held(_ n: Int) -> ChatAttachment {
        ChatAttachment(id: "a\(n)", kind: .image, mediaType: "image/png", name: "x.png", n: n, url: "/uploads/a\(n).png")
    }

    @Test func theBoxShowsWhatTheMacHoldsAndWhatIsOnItsWayThere() {
        // clipped on at the Mac: shown here, with no bytes of its own
        let fromMac = Attaching.box(mac: [held(1)], here: [], attaching: [], detaching: [])
        #expect(fromMac.map(\.id) == ["a1"])
        #expect(fromMac[0].data == nil)
        #expect(fromMac[0].url == "/uploads/a1.png")
        // clipped on here, and the Mac has yet to say it holds it: it stays
        #expect(Attaching.box(mac: [], here: [image(2)], attaching: ["a2"], detaching: []).map(\.id) == ["a2"])
        // once the Mac lists it, it keeps its bytes and takes the Mac's number
        var renumbered = held(2)
        renumbered.n = 5
        let landed = Attaching.box(mac: [held(1), renumbered], here: [image(2)], attaching: [], detaching: [])
        #expect(landed.map(\.id) == ["a1", "a2"])
        #expect(landed[1].data == Data([1]))
        #expect(landed[1].n == 5)
        // taken off at the Mac: gone here, since nothing says it is on its way
        #expect(Attaching.box(mac: [], here: [image(1)], attaching: [], detaching: []).isEmpty)
        // taken off here, and the Mac still lists it: it stays gone
        #expect(Attaching.box(mac: [held(1), held(2)], here: [], attaching: [], detaching: ["a1"]).map(\.id) == ["a2"])
    }

    @Test func aFileTakenOffTakesItsMarkerOutOfTheWords() {
        #expect(Attaching.without("[image #1]", in: "look at [image #1] here") == "look at here")
        #expect(Attaching.without("[image #1]", in: "[image #1] look") == "look")
        #expect(Attaching.without("[image #1]", in: "look [image #1]") == "look")
        #expect(Attaching.without("[image #1]", in: "[image #1]") == "")
        #expect(Attaching.without("[image #1]", in: "[image #10] stays") == "[image #10] stays")
        #expect(Attaching.without("[image #2]", in: "nothing named") == "nothing named")
    }

    @Test func aMarkerFromTheMacReadsWithAPlainSpace() {
        #expect(Attaching.plain("see [image\u{00A0}#1] and [file\u{00A0}#12]") == "see [image #1] and [file #12]")
        #expect(Attaching.plain("[image #1] stays") == "[image #1] stays")
        #expect(Attaching.plain("10\u{00A0}km") == "10\u{00A0}km")
        var log = ChatLog()
        var frame = ChatFrame(chat: "c", name: "n", project: "p", state: .idle, queue: [])
        frame.draft = "look at [image\u{00A0}#2]"
        log.apply(frame)
        #expect(log.draft == "look at [image #2]")
    }

    @Test func aFileTheMacHoldsGoesByItsIdAlone() throws {
        let named = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Ruri.Attachment(held: held(1)))) as? [String: Any]
        #expect(named?["id"] as? String == "a1")
        #expect(named?["data"] == nil)
        #expect(named?["url"] == nil)
        let whole = try JSONSerialization.jsonObject(with: JSONEncoder().encode(image(1))) as? [String: Any]
        #expect(whole?["data"] as? String == "AQ==")
    }

    @Test func aFrameSaysWhatTheChatHasRunning() throws {
        let json = """
        {"chat":"c","name":"n","project":"p","state":"idle","queue":[],
         "running":[
          {"key":"s1","kind":"script","title":"Resize the photos","doing":"[12/340] a.png",
           "since":"2026-11-24T10:00:00.000Z","printed":"2026-11-24T10:03:00.000Z"},
          {"key":"a1","kind":"helper","title":"Explore","since":"2026-11-24T10:01:00.000Z"}]}
        """
        var log = ChatLog()
        log.apply(try StatusReport.decoder().decode(ChatFrame.self, from: Data(json.utf8)))
        #expect(log.running.map(\.key) == ["s1", "a1"])
        #expect(log.running[0].kind == .script)
        // a kind from a newer Mac reads as an agent
        #expect(log.running[1].kind == .agent)
        let script = log.running[0]
        let printed = try #require(script.printed)
        // printing, then quiet for as long as it has been
        #expect(script.standing(now: printed.addingTimeInterval(4)) == "printing")
        #expect(script.standing(now: printed.addingTimeInterval(125)) == "quiet 2m 05s")
        // an agent by how long it has been going
        #expect(log.running[1].standing(now: log.running[1].since.addingTimeInterval(42)) == "42s")
        #expect(ChatRunning.span(2 * 3_600 + 14 * 60 + 3) == "2h 14m")
        // a frame that says nothing of them: nothing is running
        log.apply(ChatFrame(chat: "c", name: "n", project: "p", state: .idle, queue: []))
        #expect(log.running.isEmpty)
    }

    @Test func aFrameSaysWhatTheBoxHolds() throws {
        let json = """
        {"chat":"c","name":"n","project":"p","state":"idle","queue":[],
         "draftAttachments":[{"id":"a1","kind":"image","mediaType":"image/png","name":"x.png","n":1,"url":"/uploads/a1.png"}]}
        """
        var log = ChatLog()
        log.apply(try StatusReport.decoder().decode(ChatFrame.self, from: Data(json.utf8)))
        #expect(log.draftAttachments == [held(1)])
        // a frame that says nothing of them: the box holds none
        log.apply(ChatFrame(chat: "c", name: "n", project: "p", state: .idle, queue: []))
        #expect(log.draftAttachments.isEmpty)
    }

    @Test func knowsAKindByItsType() {
        #expect(Attaching.kind(of: .heic) == .image)
        #expect(Attaching.kind(of: .quickTimeMovie) == .video)
        #expect(Attaching.kind(of: .pdf) == .file)
        #expect(Attaching.kind(of: nil) == .file)
    }

    private func picture(side: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side / 2), format: format).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side / 2))
        }
    }

    @Test func aSmallPictureGoesAsItIs() throws {
        let png = try #require(picture(side: 100).pngData())
        let fitted = try #require(Attaching.fitted(image: png, type: .png))
        #expect(fitted.mediaType == "image/png")
        #expect(fitted.data == png)
    }

    @Test func whatTheModelCantTakeBecomesAJPEGOfASensibleSize() throws {
        // not a type the model takes, and over the side kept
        let png = try #require(picture(side: 3000).pngData())
        let fitted = try #require(Attaching.fitted(image: png, type: .heic))
        #expect(fitted.mediaType == "image/jpeg")
        let image = try #require(UIImage(data: fitted.data))
        #expect(max(image.size.width, image.size.height) * image.scale == 2048)
    }

    @Test func notAPictureIsNoPicture() {
        #expect(Attaching.fitted(image: Data([1, 2, 3]), type: .heic) == nil)
    }

    @Test func aSendCarriesItsFilesInBase64() throws {
        let body = SendBody(id: "c", text: "[image #1]", clientId: "p", attachments: [image(1)])
        let json = try #require(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any]
        )
        let file = try #require((json["attachments"] as? [[String: Any]])?.first)
        #expect(file["data"] as? String == "AQ==")
        #expect(file["kind"] as? String == "image")
        #expect(file["n"] as? Int == 1)
        #expect(Set(file.keys) == ["id", "kind", "mediaType", "name", "n", "data"])
    }

    @Test func readsAPromptsAttachments() throws {
        let json = """
            {"id":"u","kind":"user","text":"[image #1]","at":"2026-10-30T00:00:00.000Z",
             "attachments":[{"id":"a","kind":"image","mediaType":"image/jpeg","name":"p.jpg","n":1,"url":"/uploads/a-p.jpg"}]}
            """
        let item = try StatusReport.decoder().decode(ChatItem.self, from: Data(json.utf8))
        #expect(item.attachments?.first?.url == "/uploads/a-p.jpg")
        #expect(item.attachments?.first?.kind == .image)
    }
}
