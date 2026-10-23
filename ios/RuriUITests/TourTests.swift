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
        XCTAssertTrue(app.staticTexts["Choose Pair a phone."].waitForExistence(timeout: 10), "the pairing screen")
        pause(2.5)
        shoot("1 pairing")

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
        shoot("2 home")

        tap(lighthouse)
        XCTAssertTrue(app.staticTexts["Lead"].waitForExistence(timeout: 5))
        pause(4)
        shoot("3 a question")
        back(app)

        let orchard = app.buttons["project.orchard"]
        XCTAssertTrue(orchard.waitForExistence(timeout: 5))
        tap(orchard)
        let harvest = app.descendants(matching: .any)["chat.Harvest"]
        XCTAssertTrue(harvest.waitForExistence(timeout: 5), "orchard's team")
        pause(2)
        tap(harvest)
        pause(4)
        shoot("4 a team")
        back(app)

        app.collectionViews.firstMatch.swipeDown(velocity: .slow)
        pause(4)
        shoot("5 home again")

        tap(app.buttons["Your Mac"])
        // a tap while a row spins can miss: once more
        if !app.buttons["Done"].waitForExistence(timeout: 4) { tap(app.buttons["Your Mac"]) }
        pause(3.5)
        shoot("6 the Mac")
        tap(app.buttons["Done"])
        pause(3)

        // the Mac goes away: the last picture stays, grayed out
        if let cue = env["RURI_DEMO_CUE"] {
            FileManager.default.createFile(
                atPath: (cue as NSString).deletingLastPathComponent + "/down", contents: Data())
            XCTAssertTrue(
                app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Not reachable'")).firstMatch
                    .waitForExistence(timeout: 90),
                "the line is down, and the screen says so")
            pause(2)
            shoot("7 offline")
        }
    }

    /// A row redrawn by every live frame can be mid-change when the tap
    /// comes: tap where it is once it settles, or where it was.
    @MainActor
    private func tap(_ element: XCUIElement) {
        let settled = NSPredicate(format: "hittable == true")
        let wait = expectation(for: settled, evaluatedWith: element)
        if XCTWaiter.wait(for: [wait], timeout: 4) == .completed {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    /// A picture of the screen, kept with the test's results.
    @MainActor
    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    @MainActor
    private func back(_ app: XCUIApplication) {
        tap(app.navigationBars.buttons.element(boundBy: 0))
        pause(2)
    }

    private func pause(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }
}
