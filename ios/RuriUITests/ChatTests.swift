import UIKit
import XCTest

/// A chat end to end against a real ruri (ios/demo/scratch-server.ts): its
/// conversation read, a prompt sent from the phone and its reply watched
/// arrive, prompts queued behind a running turn, one held to send it now,
/// the send button held to cut in, and words pasted. Runs only
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

        let field = openLead(app)

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

        // a slow turn, then two prompts behind it: queued, over the field
        tap(field)
        field.typeText(
            "Run exactly this with your Bash tool and nothing else (a computation, not a wait): python3 -c \"import hashlib; h=b'x'; [h:=hashlib.sha256(h).digest() for _ in range(80000000)]; print(h.hex()[:8])\" — then reply with just what it printed.")
        app.buttons["chat.send"].tap()
        pause(6)
        tap(field)
        field.typeText("Reply with exactly this and nothing else: Mulch is down.")
        app.buttons["chat.send"].tap()
        tap(field)
        field.typeText("Reply with exactly this and nothing else: Compost is turned.")
        app.buttons["chat.send"].tap()
        let cards = app.descendants(matching: .any).matching(identifier: "queue.card")
        XCTAssertTrue(cards.firstMatch.waitForExistence(timeout: 15), "queued behind the running turn")
        pause(1)
        shoot("4 queued")

        // the second card held down goes now: the turn stops and it cuts in
        XCTAssertEqual(cards.count, 2)
        cards.element(boundBy: 1).press(forDuration: 1.2)
        XCTAssertTrue(app.staticTexts["Compost is turned."].waitForExistence(timeout: 90), "sent now, by a hold")
        XCTAssertTrue(app.staticTexts["Mulch is down."].waitForExistence(timeout: 90), "the rest of the queue after it")
        pause(2)
        shoot("5 after the queue")

        // the send button held down cuts in too
        tap(field)
        field.typeText(
            "Run exactly this with your Bash tool and nothing else (a computation, not a wait): python3 -c \"import hashlib; h=b'y'; [h:=hashlib.sha256(h).digest() for _ in range(80000000)]; print(h.hex()[:8])\" — then reply with just what it printed.")
        app.buttons["chat.send"].tap()
        pause(6)
        tap(field)
        field.typeText("Reply with exactly this and nothing else: Peas go in bed five.")
        app.buttons["chat.send"].press(forDuration: 1.2)
        XCTAssertTrue(app.staticTexts["Peas go in bed five."].waitForExistence(timeout: 90), "cut in by holding send")
        shoot("6 cut in")

        // the conversation stays on screen after a send, at its end
        XCTAssertTrue(app.staticTexts["Beans go in bed four."].exists, "what was said before is still there")
    }

    /// Words pasted into the field, from the menu a long press brings up.
    @MainActor
    func testPaste() throws {
        guard let text = env["RURI_PAIR_LINK"], let link = URL(string: text) else {
            throw XCTSkip("no RURI_PAIR_LINK: there is no ruri to pair with")
        }
        let app = XCUIApplication()
        app.launch()
        app.open(link)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Open"].waitForExistence(timeout: 3) { springboard.buttons["Open"].tap() }
        let field = openLead(app)
        UIPasteboard.general.string = "pasted words"
        tap(field)
        field.press(forDuration: 1.2)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "the menu offers Paste")
        paste.tap()
        // iOS may ask whether the app may paste: allow it
        let allow = springboard.buttons["Allow Paste"]
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        XCTAssertEqual(field.value as? String, "pasted words")
    }

    /// A picture and a file from the phone, read by a real model. The system's
    /// pickers run outside the app, so the file goes in through a debug hook,
    /// and the picker is only seen to open. Needs TEST_RUNNER_RURI_TEST_IMAGE
    /// (a plain red PNG) and TEST_RUNNER_RURI_TEST_FILE (a note that says
    /// the secret word is plum).
    @MainActor
    func testAttaching() throws {
        guard let text = env["RURI_PAIR_LINK"], let link = URL(string: text),
            let picture = env["RURI_TEST_IMAGE"], let note = env["RURI_TEST_FILE"]
        else {
            throw XCTSkip("no RURI_PAIR_LINK, RURI_TEST_IMAGE or RURI_TEST_FILE")
        }
        let app = XCUIApplication()
        app.launchEnvironment["RURI_TEST_ATTACH"] = picture
        app.launch()
        app.open(link)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Open"].waitForExistence(timeout: 3) { springboard.buttons["Open"].tap() }
        let field = openLead(app)

        // the picture sits above the field, the words left to you
        XCTAssertTrue(app.descendants(matching: .any)["chat.attachments"].waitForExistence(timeout: 10), "the strip")
        pause(1)
        shoot("a1 attached")

        // the plus opens its menu, and the library its picker
        app.buttons["chat.attach"].tap()
        XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 5), "the menu")
        XCTAssertTrue(app.buttons["Choose File"].exists, "the menu's files")
        shoot("a2 menu")
        app.buttons["Photo Library"].tap()
        pause(3)
        shoot("a3 library")
        if app.buttons["Cancel"].waitForExistence(timeout: 5) { app.buttons["Cancel"].tap() }
        pause(1)

        // the model sees it
        tap(field)
        field.typeText("What single colour fills this picture? Reply with one word, lowercase.")
        app.buttons["chat.send"].tap()
        pause(1)
        shoot("a4 sent")
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "red")).firstMatch
                .waitForExistence(timeout: 90), "the model saw a red picture")
        // and the bubble shows it, fetched back from the Mac
        XCTAssertTrue(app.descendants(matching: .any)["chat.attachment"].waitForExistence(timeout: 10), "the bubble's picture")
        pause(2)
        shoot("a5 the reply")

        // a tap opens it in Quick Look
        tap(app.descendants(matching: .any)["chat.attachment"].firstMatch)
        XCTAssertTrue(app.otherElements["QLPreviewControllerView"].waitForExistence(timeout: 15), "quick look")
        pause(5)
        shoot("a6 quick look")
        // and there is a way back: its bar comes with a tap, a swipe down closes it
        let closed = app.buttons["chat.send"]
        app.otherElements["QLPreviewControllerView"].tap()
        pause(2)
        let buttons = app.otherElements["QLPreviewControllerView"].buttons.allElementsBoundByIndex.map { "\($0.identifier)|\($0.label)" }
        let found = XCTAttachment(string: buttons.joined(separator: "\n"))
        found.name = "a6 buttons"
        found.lifetime = .keepAlways
        add(found)
        shoot("a6b its bar")
        app.otherElements["QLPreviewControllerView"].swipeDown(velocity: .fast)
        pause(2)
        XCTAssertTrue(closed.waitForExistence(timeout: 5) && closed.isHittable, "back from quick look")

        // a file goes the same way, as a path the model opens
        app.terminate()
        app.launchEnvironment["RURI_TEST_ATTACH"] = note
        app.launch()
        let again = openLead(app)
        XCTAssertTrue(app.descendants(matching: .any)["chat.attachments"].waitForExistence(timeout: 10), "the file's strip")
        pause(1)
        shoot("a7 a file")
        tap(again)
        again.typeText("What is the secret word in this file? Reply with just the word, lowercase.")
        app.buttons["chat.send"].tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "plum")).firstMatch
                .waitForExistence(timeout: 90), "the model read the file")
        pause(2)
        shoot("a8 file read")
    }

    /// Garden's chat — a project with no team opens straight on its lead's
    /// conversation — and its field.
    @MainActor
    private func openLead(_ app: XCUIApplication) -> XCUIElement {
        XCTAssertTrue(app.staticTexts["Projects"].waitForExistence(timeout: 30), "paired")
        let garden = app.buttons["project.garden"]
        XCTAssertTrue(garden.waitForExistence(timeout: 10))
        let field = app.descendants(matching: .any)["chat.field"]
        // a row redrawn by a live frame can take a tap as nothing: again
        for _ in 0..<3 where !field.exists {
            tap(garden)
            _ = field.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(field.exists, "garden's chat, with its field")
        return field
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
