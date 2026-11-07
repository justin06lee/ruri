# ruri on the iPhone: plan

Built in [ios/](../ios/README.md): native SwiftUI, QR pairing, Tailscale away from home, read-only v1. The decisions below were made that way.

The goal: Justin opens his phone and sees what is running on his Mac without asking anyone. He sees which projects are at work, idle, blocked or waiting on him, what each one is doing right now, and what each one last finished. Convenience comes first. The bigger ruri overhaul comes later.

Each choice marked **Decision (Justin)** is his to make. The recommendation follows it.

## v1 scope

- **Projects.** One row per project, with a status dot (working · idle · blocked · needs you) and a single line saying what it is doing now. Projects that need him sort to the top, then working, then the rest by when they were last active. Hidden projects are left out.
- **A project.** Its lead first, then its teammates and its liaison. Each row shows its state and its last words (the latest reply, trimmed), or the card or question it is waiting on.
- **Needs you.** One list across every project: an unanswered question a lead ended its turn on, a card waiting on a permission or a question, and work that stopped on an error. Each entry shows which project, who, what it asks, and for how long.
- **Freshness.** Pull to refresh, plus live updates while the app is open.
- **Read-only.** One exception is possible: **sending a short message to a lead. It is cheap.** The server already has the composer's send path, which queues the message behind a busy turn. A phone needs one POST route over that path, and the app needs a text field. That is about half a day of work. **Decision (Justin):** put it in v1 or v1.1. Recommendation: v1.1, so that v1 ships read-only and the trust question waits.
- **v1.1:** push notifications for "needs you" and "team done". ProjectWatch already raises exactly these events for midna's hooks (`project.blocked`, `project.idle`). The Mac can send them to APNs itself with a .p8 key, and no relay is needed.
- **Not in the app:** transcripts, logs, tool calls, IDs, tokens, cost, models, context gauges.

## v2: the conversation, and prompting from the phone

Justin asked for both (2026-10-27): each chat's whole conversation, live, and a composer that sends into it. Built in `server/phoneChat.ts`:

- `GET /chat?id=<chat>`: the chat's last 150 things said: his prompts and the replies in full, each run of tool calls folded into one "N steps" line, and a note where a turn stopped. It also gives the chat's state (working, needs you, idle) and the prompts waiting in its queue. Chat ids come from `/status?ids=1`.
- `GET /chat/live?id=<chat>`: the same over SSE. The first frame is whole; after that a frame carries only what is new or changed (`upsert`) and what is gone (`remove`), or the whole list again when the order changed. A reply being written comes as a `pending` item. Reconnecting sends the whole conversation again, so nothing missed is lost.
- `POST /chat/send` with `{ id, text, clientId, attachments? }`: sent the way the web composer sends (the `send` handler). `attachments` are `{ id, kind, mediaType, name, n, data }` with the file as base64, at most 20; the conversation hands them back with a `url`, and a phone's key may `GET /uploads/*` to fetch them. It answers `event` (sent now), `queued` (behind the running turn) or `failed`. The same `clientId` sent twice is answered, not run twice, so the phone can retry after a dropped line.
- **Scope.** A phone code now pairs with the key scope `phone`: the status and these three routes. A phone paired before keeps the scope `status`. Its key does not quietly gain sending, and `/chat*` refuses it with "pair it again".

## v3: notifications

Justin asked (2026-10-28) to hear when a session finishes or asks something, through midna's plan. Awareness only: nothing to act on in the notification, and tapping it opens the project. Built in `server/phonePush.ts` and `ios/Ruri/Push/`:

- **Sender.** The Mac's ruri posts straight to APNs over HTTP/2: `api.push.apple.com` for TestFlight builds, the sandbox for Xcode debug builds (the phone says which with its token). It signs an ES256 provider token with the team's APNs key (699PDG8BFP, team 65UN46K6FA, topic `com.justin06lee.ruri.phone`), read from `~/.local/share/ruri/apns/AuthKey_699PDG8BFP.p8`. It is never in `~/.config` (a public dotfiles repo), the repo or the secrets vault, whose secrets reach every agent's shell. `RURI_APNS_KEY_FILE` and `RURI_APNS_HOST` point elsewhere for a test.
- **Events.** The same ones midna hears (`onProjectEvent`): `project.idle` becomes "finished", with the first sentence of the lead's last reply (markdown stripped, at most 120 characters). `project.blocked` becomes "needs input", with the question, the card or the error. The project name is the title and the thread; a collapse id per project and kind keeps one of each on the lock screen.
- **Routes**, through sharing's door for a `phone` key only: `POST /phone/push` `{ token, env }`, `POST /phone/push/settings`, `GET /phone/push`. Stored in `phone-push.json` (0600). The same token again is no news: nothing is written. A key may change its token ten times an hour. A token APNs calls gone is dropped. A phone paired again takes its token from its old pairing, so it never hears a thing twice.
- **Register once.** The app asks iOS for a token once per launch, from the app delegate. The token callback only compares and posts, and only when the token is new, the Mac is new, or a week has passed. This avoids the loop midna's own app fell into.
- **Quiet hours.** These are on by default, from 21:30 until Fajr. The phone works out Fajr itself from a coarse location (ISNA, 15°; 05:30 without one) and sends the Mac the next seven nights as times. If they run out, the Mac falls back to 21:30–05:30 by its own clock. In them a notification comes passive, with no sound (Deliver Quietly), or is held for one "While you slept" summary at their end (Summary at the End). The summary survives a relaunch.
- **Not yet:** the payload passes through Apple in the clear. A key shared at pairing could encrypt it, decrypted on the phone by a notification service extension. The Jetson relay could carry pushes later.

## How it connects

**What already exists.** Settings → Devices (`server/sharing.ts`) opens a second door, port 7775, on every network the Mac is on: LAN, tailnet or makima. The door is TLS with ruri's own certificate (`server/tlsCert.ts`), which a device pins by fingerprint. Every request through it must carry a per-device key. The Mac stores only a hash of each key, and each key can be revoked one at a time. A device gets its key by proving the six words of an invite, without the words ever crossing the wire (`server/invite.ts`). Requests that come in through the door are served by the same routes and socket as the local window (`server/routes.ts`, `server/socket.ts`). So a route added once is reachable from the phone with nothing more. (`server/hostLink.ts` is the server↔Electron-shell link and plays no part here.)

**What the web client uses, and why the phone should not.** The window speaks the full WebSocket protocol (`shared/protocol.ts`). On connect it receives a snapshot of everything: projects, leads' transcript tails, prefs and gauges. That is far too much for a phone, and it couples the app to every UI change.

**What the phone uses instead (built in step 2):**
- `GET /status`: the whole picture in one compact JSON, about a few KB.
- `GET /status/live`: the same picture over Server-Sent Events. It sends one frame on connect and a new frame whenever the picture changes, with a keep-alive comment every 25s. SSE is plain HTTP, so URLSession reads it with `bytes(for:)`. The app reconnects when it comes to the foreground. iOS kills sockets in the background, and pushes cover that case (v1.1).
- Auth: the paired device key in the `x-ruri-token` header, sent over the pinned-TLS door. On the Mac's own port the routes need the local token, so other processes on the Mac can't read the status.

**What is missing for a phone:**
1. **Pairing by QR code.** **Decision (Justin):** QR or six words. The six words work on a phone, but the app would need scrypt, which CryptoKit doesn't have, so it would take a small package. Recommendation: QR. Settings → Devices → "Pair a phone" shows a QR code holding the addresses, the port, the certificate fingerprint and a one-time ticket that lasts 15 minutes. The camera is an out-of-band channel, so the fingerprint in the QR alone proves the Mac's identity, and the phone just redeems the ticket for its key. The server side is about half a day, mostly reusing `pairDirect`.
2. **A read-only key.** Today a paired device can do everything the window can. Recommendation: phone keys are scoped to `/status*` (and to the message route, if he chooses it), and every other route refuses them. This is a small change in `sharing.ts`.
3. **The Mac must be awake.** If the Mac sleeps, the phone shows "Mac asleep · last seen 10:42". Nothing about that can be fixed in ruri.

**Reaching the Mac away from home.** **Decision (Justin):** Tailscale or a relay. Recommendation: **Tailscale.** The phone runs the Tailscale iOS app, and ruri's door already listens on the Mac's tailnet address. The work is zero, the door is never on the public internet, and it is the direction midna is already going. makima has no iOS client. A relay would mean a hosted server, an account system and a public endpoint to defend, all to solve a problem Tailscale already solves. An option for later: a setting that binds the door to the tailnet interface only.

## Stack

**Decision (Justin):** native SwiftUI or Expo/React Native. Recommendation: **SwiftUI.**
- Pinning ruri's self-signed certificate takes a few lines with a `URLSessionDelegate` in Swift. In React Native it takes a native module anyway.
- The best Apple feel, and it matches his taste: `List`, `refreshable`, SF Symbols, and later widgets and Live Activities (a "2 projects working" Lock Screen activity) and APNs, all first-class.
- What would be shared with ruri's TypeScript is a single JSON shape, which is a few dozen lines of Codable. Little is lost.
- Shipping: TestFlight and installing on his own device need the Apple Developer account Justin is getting ($99/yr). Until it arrives, a free account can run the app on his own phone from Xcode for 7 days at a time.

## Look

Apple-native and quiet, in system colours, with light and dark modes. Taste rule 0: show the state and what needs him, and hide the internals.
- Home is a grouped list. "Needs you" sits on top with an orange dot and the question in full. Below it are the projects, each with a small dot (green working, grey idle, red blocked, orange needs you) and one line of what it is doing now, in secondary text. The title bar shows the Mac's name, plus "updated 12s ago" when the app is offline.
- A project screen shows the lead's latest words in a card, then the teammates, each with its name, duty, state and last words, in one or two lines that expand on tap.
- No IDs, tokens, costs, models, file paths or logs by default. The API leaves them out unless asked (`?ids=1`).
