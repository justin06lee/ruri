# ruri for iPhone

A quiet, read-only view of what ruri is running on your Mac. It shows what needs you first, then every project with a status dot (green working, grey idle, red stopped, orange needs you) and a line saying what it is doing now. Tap a project to see its lead's latest words and its teammates. Pull to refresh. While the app is open, the picture updates live. It never shows IDs, logs, tokens or costs. Replying from the phone comes in v1.1.

SwiftUI, iOS 17 or later, and no dependencies. The plan behind it is [docs/mobile-app.md](../docs/mobile-app.md).

## How it reaches the Mac

The app talks only to ruri's sharing door (Settings → Devices on the Mac; `server/sharing.ts`). That door is TLS with ruri's own certificate, and the app pins the certificate by its fingerprint. The phone's key can read only the status: `GET /remote/hello` to find the Mac, then `GET /status` and the live stream `GET /status/live`. Every other route refuses that key, the socket included.

**Pairing.** On the Mac, open Settings → Devices → Pair a phone. Scan the code it shows, either with the iPhone's Camera app (it offers "Open in ruri") or with Scan Code in the app. You can also press Copy link on the Mac and tap Paste on the app's first screen; Universal Clipboard carries the link across. The code is a `ruri://pair` link. It carries the Mac's addresses, the door's port, the certificate's fingerprint and a one-time ticket that lasts 15 minutes. The app redeems the ticket at `POST /pair/ticket` for its key, which it keeps in the keychain.

**Away from home: Tailscale.** Install Tailscale on the Mac and on the iPhone, sign both in to the same account, and keep it on. The door already listens on the Mac's tailnet address. Every time the app reaches the Mac, it learns the Mac's current addresses, so pair (or open the app once) while Tailscale is on on the Mac. The Mac has to be awake. If you want to check in from away, set the Mac to stay awake on power: System Settings → Battery → Options → Prevent automatic sleeping when the display is off.

## Run it in the simulator

```sh
make            # build, boot the simulator, install, launch
make test       # the unit tests, on the simulator
make build      # only the app
```

`SIM="iPhone 17 Pro" make` picks another simulator. The simulator has no camera. To pair it, run `xcrun simctl openurl booted "<the ruri://pair link>"`.

**Against a real ruri, never yours.** `bun ios/demo/scratch-server.ts` (from the repo root) starts a scratch ruri on a temp config. It sets up four temp projects with small teams, turns sharing on and prints a pairing link. Touch the `go` file it names to start real turns (haiku): one project at work, one asking a question, one waiting on a card. `make demo` does all of that and runs the UI test that tours the app (`RuriUITests/TourTests`), recording the simulator to `build/tour.mp4`. The UI test skips itself without a pairing link, so `make test` stays offline.

## Install it on your iPhone (free Apple ID, 7 days)

1. Open `ios/Ruri.xcodeproj` in Xcode 26.
2. Xcode → Settings → Accounts → **+** → Apple Account. Sign in. This makes a *Personal Team*.
3. Select the **Ruri** target → Signing & Capabilities → Team, and choose *Your Name (Personal Team)*. If Xcode says the bundle identifier is taken, change `com.justin06lee.ruri.phone` to anything unique, such as `com.yourname.ruri`.
4. Connect the iPhone by cable, unlock it, and tap **Trust**. Turn on Developer Mode in the iPhone's Settings → Privacy & Security → Developer Mode. The option appears once Xcode has seen the phone. The iPhone restarts; confirm Developer Mode after it does.
5. Choose the iPhone as the run destination at the top of the window, then press **⌘R**.
6. The first launch is refused as an "Untrusted Developer". On the iPhone, go to Settings → General → VPN & Device Management, choose your Apple ID, and tap **Trust**. Then open ruri.

A free team's signature lasts 7 days. After that the app won't open until you press ⌘R in Xcode again. The pairing and everything else stay. A free team allows 3 such apps per device. With the paid Developer account the signature lasts a year, and the app can go through TestFlight.

If Xcode says the iPhone's iOS is newer than it supports, update Xcode.
