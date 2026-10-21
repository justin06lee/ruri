import XCTest

/// The app end to end against a real ruri (ios/demo/scratch-server.ts):
/// paired by its link, the home screen watched as projects change, a
/// project opened, a teammate expanded, a refresh, the Mac's sheet. It runs
/// only when given a pairing link —
///
///     TEST_RUNNER_RURI_PAIR_LINK="ruri://pair?…" xcodebuild test …
///
/// — and, given TEST_RUNNER_RURI_DEMO_CUE, writes that file once paired,
/// the scratch server's cue to start its turns.
final class TourTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    @MainActor
    func testTour() throws {
        guard let text = env["RURI_PAIR_LINK"], let link = URL(string: text) else {
            throw XCTSkip("no RURI_PAIR_LINK: there is no ruri to pair with")
        }
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Choose Pair a Phone."].waitForExistence(timeout: 10), "the pairing screen")
        pause(2.5)

        // the Camera app would hand the link over just so
        app.open(link)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 3) { open.tap() }
        XCTAssertTrue(app.staticTexts["Projects"].waitForExistence(timeout: 30), "paired, and the projects shown")

        if let cue = env["RURI_DEMO_CUE"] {
            FileManager.default.createFile(atPath: cue, contents: Data())
        }
        // the turns start: something takes to work, something asks
        let lighthouse = app.buttons["need.lighthouse"]
        XCTAssertTrue(lighthouse.waitForExistence(timeout: 60), "the question shows under Needs you")
        pause(5)

        lighthouse.tap()
        XCTAssertTrue(app.staticTexts["Lead"].waitForExistence(timeout: 5))
        pause(4)
        back(app)

        let orchard = app.buttons["project.orchard"]
        XCTAssertTrue(orchard.waitForExistence(timeout: 5))
        orchard.tap()
        let harvest = app.descendants(matching: .any)["chat.Harvest"]
        XCTAssertTrue(harvest.waitForExistence(timeout: 5), "orchard's team")
        pause(2)
        harvest.tap()
        pause(4)
        back(app)

        app.collectionViews.firstMatch.swipeDown(velocity: .slow)
        pause(4)

        app.buttons["Your Mac"].tap()
        pause(3.5)
        app.buttons["Done"].tap()
        pause(3)
    }

    @MainActor
    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
        pause(1.5)
    }

    private func pause(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }
}
