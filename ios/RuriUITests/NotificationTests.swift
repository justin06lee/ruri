import XCTest

/// A real notification, end to end, against a scratch ruri
/// (ios/demo/scratch-server.ts) whose Mac sends to APNs' sandbox: pair,
/// allow notifications, leave the app, and tap the first banner that comes
/// — it must open its project. Runs only when given a pairing link
/// (TEST_RUNNER_RURI_PAIR_LINK) and the scratch server's cue
/// (TEST_RUNNER_RURI_DEMO_CUE), which it writes once paired so the turns
/// start.
final class NotificationTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    @MainActor
    func testATappedNotificationOpensItsProject() throws {
        guard let text = env["RURI_PAIR_LINK"], let link = URL(string: text), let cue = env["RURI_DEMO_CUE"] else {
            throw XCTSkip("no RURI_PAIR_LINK and RURI_DEMO_CUE: there is no ruri to hear from")
        }
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        app.launch()
        app.open(link)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 3) { open.tap() }
        // paired: iOS asks whether ruri may notify
        let allow = springboard.alerts.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 30), "asked to allow notifications")
        allow.tap()
        XCTAssertTrue(app.staticTexts["Projects"].waitForExistence(timeout: 30), "paired, and the projects shown")
        // the token reaches the Mac; then the turns start
        sleep(8)
        FileManager.default.createFile(atPath: cue, contents: Data())

        XCUIDevice.shared.press(.home)
        let projects = ["orchard", "lighthouse", "atlas", "garden"]
        let named = NSPredicate(format: projects.map { "label CONTAINS '\($0)'" }.joined(separator: " OR "))
        let banner = springboard.descendants(matching: .any).matching(named).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 240), "a notification came")
        let said = banner.label
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "banner"
        shot.lifetime = .keepAlways
        add(shot)
        // tapped once it has settled, in its middle: a tap while it slides
        // in only sends it away
        sleep(1)
        banner.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        XCTAssertEqual(app.wait(for: .runningForeground, timeout: 10), true)
        let project = projects.first { said.contains($0) }
        XCTAssertNotNil(project, "the banner names a project: \(said)")
        if let project {
            XCTAssertTrue(app.navigationBars[project].waitForExistence(timeout: 10), "\(project) opened from: \(said)")
        }
        let opened = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        opened.name = "opened"
        opened.lifetime = .keepAlways
        add(opened)

        // the settings: Your Mac, then Notifications
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Your Mac"].tap()
        let settings = app.buttons["Notifications"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.switches["Quiet Hours"].waitForExistence(timeout: 5))
        sleep(2)
        let page = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        page.name = "settings"
        page.lifetime = .keepAlways
        add(page)
    }
}
