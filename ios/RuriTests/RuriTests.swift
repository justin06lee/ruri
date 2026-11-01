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
