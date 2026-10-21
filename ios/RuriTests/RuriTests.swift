import Foundation
import Testing

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
