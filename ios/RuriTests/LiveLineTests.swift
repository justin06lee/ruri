import Foundation
import Testing

@testable import Ruri

/// Which addresses get the tailnet's patience.
struct TailnetTests {
    @Test func knowsATailnetAddress() {
        #expect(MacClient.isTailnet("100.98.7.42"))
        #expect(MacClient.isTailnet("100.64.0.1"))
        #expect(MacClient.isTailnet("100.127.255.254"))
        #expect(MacClient.isTailnet("justins-mbp.tail1234.ts.net"))
        #expect(MacClient.isTailnet("fd7a:115c:a1e0::1"))
        #expect(!MacClient.isTailnet("100.128.0.1"))
        #expect(!MacClient.isTailnet("192.168.1.20"))
        #expect(!MacClient.isTailnet("justins-mbp.local"))
    }

    @Test func aStreamOutlastsTheMacsSilence() {
        // the Mac says something every 25s; the stream gives up only past that
        #expect(MacClient.streamSilence > 25)
        #expect(MacClient.findTimeout >= 20)
    }
}

/// The live status held open against a real ruri (ios/demo/scratch-server.ts)
/// for over two minutes with nothing changing: only the 25s heartbeats come,
/// and the line must not drop between them. Runs only when given a pairing
/// link: TEST_RUNNER_RURI_PAIR_LINK="ruri://pair?…" xcodebuild test …
struct LiveLineTests {
    @Test(.timeLimit(.minutes(4)))
    func theLiveStatusStaysOpenThroughSilence() async throws {
        guard let text = ProcessInfo.processInfo.environment["RURI_PAIR_LINK"] else { return }
        let link = try PairingLink(parsing: text)
        let (mac, key) = try await MacClient.pair(link, deviceName: "live-line test")
        let client = MacClient(fingerprint: mac.fingerprint, key: key)
        // over the tailnet when the Mac is on one: the path the phone was
        // losing, where the stream is the first task on its connection
        let (found, _) = try await client.find(mac.tryOrder, port: mac.port)
        let address = mac.addresses.first(where: MacClient.isTailnet) ?? found

        let hold: TimeInterval = 135
        let start = Date.now
        var reports = 0
        var heartbeats: [TimeInterval] = []
        var ended: String?
        do {
            for try await news in client.live(at: address, port: mac.port) {
                switch news {
                case .report: reports += 1
                case .heard: heartbeats.append(Date.now.timeIntervalSince(start))
                }
                if Date.now.timeIntervalSince(start) >= hold { break }
            }
            if Date.now.timeIntervalSince(start) < hold { ended = "the Mac closed the line" }
        } catch {
            ended = "\(error)"
        }
        let held = Date.now.timeIntervalSince(start)
        print("live line over \(address) held \(Int(held))s: \(reports) report(s), heartbeats at \(heartbeats.map { Int($0) })")
        #expect(ended == nil, "the line dropped after \(Int(held))s: \(ended ?? "")")
        #expect(held >= hold)
        #expect(reports >= 1, "the picture on connecting")
        #expect(heartbeats.count >= 4, "a heartbeat every 25s")
    }
}
