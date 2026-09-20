# macOS permissions

ruri asks macOS for nine privacy grants, and each has a reason (`desktop/permissions.ts`, `ABOUT`):

| Grant | Why |
|---|---|
| Accessibility | driving native apps in the bridge — clicks, typing, the UI tree |
| Screen Recording | photographing apps and windows a session is looking at |
| Automation | AppleScript to System Events, which the bridge and `app_ui` use |
| Full Disk Access | sessions reading and writing anywhere without a prompt per folder |
| Desktop folder | projects and files that live on the Desktop |
| Documents folder | projects and files under Documents |
| Downloads folder | files a session picks up from Downloads |
| Removable volumes | projects on an external drive — `git` in a checkout there fails without this |
| Network volumes | projects on a network share |

Settings → **Permissions** shows each grant as macOS actually holds it (read from the privacy database, not guessed), asks for any of them by hand, and lists the database's own rows for ruri, the harness CLIs, and the shell — so a feature that broke can be told apart from a grant that lapsed. A checkout on an external drive whose `git` fails with "Operation not permitted" is the classic case: that is Removable Volumes, not git.

## Why grants used to lapse on every build

macOS ties every privacy grant to the app's code signature. An ad-hoc-signed app is re-signed by every build, so a grant made to the last build is void for this one while its switch in System Settings still reads "on". That was the shape of every "it worked yesterday" permission bug, and for a long time `make` worked around it by resetting ruri's rows (`tccutil reset All com.justin06lee.ruri`) before every install and having the new build ask for everything again — nine dialogs per build.

## The signing identity

Builds are now signed with a stable identity instead. `make identity` creates, once, a self-signed code-signing certificate named **`ruri dev`** in the login keychain:

1. `openssl req -x509` with `keyUsage = digitalSignature` and `extendedKeyUsage = codeSigning` (Apple's own `/usr/bin/openssl`, whose PKCS#12 output the keychain accepts);
2. exported to PKCS#12 and `security import`ed into `~/Library/Keychains/login.keychain-db` with `-T /usr/bin/codesign`, so codesign may use the key;
3. `security add-trusted-cert -r trustRoot -p codeSign` on the user keychain, so the certificate is *valid* for code signing — no sudo, no Apple developer account.

It is idempotent: an identity already in the keychain is left alone. `make build` runs it first (a refused keychain prompt falls back to an ad-hoc build rather than stopping), then builds with `CSC_NAME="ruri dev"`, `hardenedRuntime: false` and no notarization. `make install` and `make update` do not touch the grants.

That identity is enough for everything on this machine, and — since ruri now updates itself from its own releases — for the grants to survive an update too, as long as every release is signed with the same one. It is not enough for anyone else: see below.

Check a build with:

```sh
codesign -dvv dist-app/mac-arm64/ruri.app      # Authority=ruri dev
codesign -d -r- dist-app/mac-arm64/ruri.app    # designated => identifier "com.justin06lee.ruri" and certificate leaf = H"…"
```

The designated requirement — the bundle id and the certificate's hash — is what macOS files the grants under, and it is the same for every build signed with the identity. So the grants survive `make update`, and the app asks for nothing on launch.

## The ad-hoc fallback

Without the identity (a machine where `make identity` was never run, or its prompt refused), the build is ad-hoc-signed and the old dance still happens, narrower than before: `make reset-permissions` quits System Settings (it caches the table, and an open pane hides the reset) and runs `tccutil reset <service> com.justin06lee.ruri` for exactly the nine services above — never `All`, never another bundle id — and the first launch of the new build asks for each grant again (`askAgainIfNewBuild`, which checks the bundle's signature with `codesign -dv` and does nothing for a build signed with the identity). Dev runs and test harnesses are not builds and are left alone.

## Updates, and what they do to the grants

ruri updates itself from its own GitHub releases ([subaru](https://github.com/justin06lee/subaru), wired up in `desktop/main.ts`). Once a day it reads the latest release; a newer tag than the running build asks, and *Update now* downloads the bundle, checks it against the published checksum, swaps it for the running one and relaunches.

It runs in **signed** mode, which is the whole point as far as this document is concerned. Before it replaces anything it reads the running bundle's designated requirement and checks the downloaded one against it — the same check macOS makes when it decides whether two builds are the same app. Satisfied, every grant carries over and nothing is reset. Not satisfied, the download is refused and the running app stays exactly as it was, which is a great deal better than silently becoming a stranger to macOS and losing Accessibility mid-session.

What that asks of releases: **every one of them must be signed with the same identity**. `make release` does that. A release signed with a different certificate — or not signed at all — is refused by the running app, and the way out is `RURI_UPDATE_SIGNING=unsigned`, which goes back to resetting the grants on each update. `RURI_NO_UPDATE=1` turns the updater off, and `RURI_UPDATE_POLICY` takes `prompt`, `notify`, `auto` or `off`.

The relaunch is an ordinary quit, so ruri's teardown runs: sessions are closed and the archive's debounced transcript and draft writes are flushed before anything is replaced.

## Handing it to someone else: Gatekeeper and notarization

The `ruri dev` identity is self-signed, which means it answers "who made this?" with a certificate nobody has ever heard of. On the machine that made it that is fine. On anyone else's, macOS refuses to open a downloaded copy at all — *"ruri" cannot be opened because Apple cannot check it for malicious software* — and the only way past it is right-click → Open, or clearing the quarantine attribute by hand:

```bash
xattr -dr com.apple.quarantine /Applications/ruri.app
```

Making that warning go away is **notarization**: Apple is sent the bundle, scans it, and records that it did; stapling writes that record into the bundle so the downloading machine never has to ask. It needs three things this repository cannot create for you:

1. **An Apple Developer Program membership** — $99 a year, at [developer.apple.com/programs](https://developer.apple.com/programs/). There is no free tier for this; a free Apple ID can sign for local development but cannot be issued a Developer ID.
2. **A "Developer ID Application" certificate**, from Xcode (*Settings → Accounts → Manage Certificates → + → Developer ID Application*) or the developer portal. Keep it in the login keychain; export it as a `.p12` for CI.
3. **Notarization credentials** for `notarytool`. Store them once and refer to them by name:

   ```bash
   xcrun notarytool store-credentials ruri-notary \
     --apple-id you@example.com --team-id ABCDE12345 \
     --password <app-specific-password>   # appleid.apple.com → Sign-In and Security
   ```

With those in place nothing in the build needs changing:

```bash
make signing                      # says what this machine can currently do
NOTARY_PROFILE=ruri-notary make release
```

`make release` signs with the Developer ID when it finds one (turning on the hardened runtime, which notarization requires, with the entitlements in `build/entitlements.mac.plist`), notarizes, staples, zips the bundle with `ditto`, writes `checksums.txt` and publishes the GitHub release the updater reads. Without a Developer ID it signs with `ruri dev` and skips notarization, saying so rather than pretending. `.github/workflows/release.yml` does the same from a `v*` tag once the certificate and credentials are repository secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).

One thing to know before switching: moving from `ruri dev` to a Developer ID **changes the signature**, so it is exactly the case the updater refuses. Everyone already running a `ruri dev` build has to install the first Developer ID build by hand — and grants them again once — after which updates carry them as before.
