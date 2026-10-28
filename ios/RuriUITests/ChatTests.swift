import XCTest

/// A chat end to end against a real ruri (ios/demo/scratch-server.ts): its
/// conversation read, a prompt sent from the phone and its reply watched
/// arrive, and a second prompt queued behind a running turn. Runs only
/// when given a pairing link, as the tour does:
///
///     TEST_RUNNER_RURI_PAIR_LINK="ruri://pair?…" xcodebuild test …
final class ChatTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    @MainActor
    func testChat() throws {
        guard let text = env["RURI_PAIR_LINK"], let link = URL(string: text) else {
            throw XCTSkip("no RURI_PAIR_LINK: there is no ruri to pair with")
        }
        let app = XCUIApplication()
        app.launch()
        app.open(link)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Open"].waitForExistence(timeout: 3) { springboard.buttons["Open"].tap() }
        XCTAssertTrue(app.staticTexts["Projects"].waitForExistence(timeout: 30), "paired")

        let garden = app.buttons["project.garden"]
        XCTAssertTrue(garden.waitForExistence(timeout: 10))
        let lead = app.buttons["lead"]
        // a row redrawn by a live frame can take a tap as nothing: again
        for _ in 0..<3 where !lead.exists {
            tap(garden)
            _ = lead.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(lead.exists, "garden's lead")
        let field = app.descendants(matching: .any)["chat.field"]
        for _ in 0..<3 where !field.exists {
            tap(lead)
            _ = field.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(field.exists, "the lead's chat, with its field")

        // what was said before, in full
        XCTAssertTrue(
            app.staticTexts["Tomatoes went in bed three today."].waitForExistence(timeout: 20),
            "the conversation so far")
        pause(1)
        shoot("1 a conversation")

        // a prompt from the phone, and the reply arriving live
        field.tap()
        field.typeText("Reply with exactly this and nothing else: Beans go in bed four.")
        app.buttons["chat.send"].tap()
        pause(1)
        shoot("2 sent")
        XCTAssertTrue(
            app.staticTexts["Beans go in bed four."].waitForExistence(timeout: 90), "the reply, live")
        pause(1)
        shoot("3 the reply")

        // a slow turn, then a prompt behind it: queued
        field.tap()
        field.typeText(
            "Run exactly this with your Bash tool and nothing else: sleep 20 — then reply with just: Watered.")
        app.buttons["chat.send"].tap()
        pause(6)
        field.tap()
        field.typeText("Reply with exactly this and nothing else: Mulch is down.")
        app.buttons["chat.send"].tap()
        XCTAssertTrue(app.staticTexts["Queued"].waitForExistence(timeout: 15), "queued behind the running turn")
        pause(1)
        shoot("4 queued")
        XCTAssertTrue(app.staticTexts["Mulch is down."].waitForExistence(timeout: 120), "the queue moved on")
        pause(2)
        shoot("5 after the queue")
    }

    @MainActor
    private func tap(_ element: XCUIElement) {
        let settled = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: element)
        if XCTWaiter.wait(for: [settled], timeout: 4) == .completed {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    @MainActor
    private func shoot(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func pause(_ seconds: TimeInterval) {
        Thread.sleep(forTimeInterval: seconds)
    }
}
