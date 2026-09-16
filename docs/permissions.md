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

It is idempotent: an identity already in the keychain is left alone. `make build` runs it first (a refused keychain prompt falls back to an ad-hoc build rather than stopping), then builds with `CSC_NAME="ruri dev"`, `hardenedRuntime: false` and no notarization — there is no Apple developer account behind this app, so the bundle is not notarized and Gatekeeper is not involved (it is installed by `make`, never downloaded). `make install` and `make update` do not touch the grants.

Check a build with:

```sh
codesign -dvv dist-app/mac-arm64/ruri.app      # Authority=ruri dev
codesign -d -r- dist-app/mac-arm64/ruri.app    # designated => identifier "com.justin06lee.ruri" and certificate leaf = H"…"
```

The designated requirement — the bundle id and the certificate's hash — is what macOS files the grants under, and it is the same for every build signed with the identity. So the grants survive `make update`, and the app asks for nothing on launch.

## The ad-hoc fallback

Without the identity (a machine where `make identity` was never run, or its prompt refused), the build is ad-hoc-signed and the old dance still happens, narrower than before: `make reset-permissions` quits System Settings (it caches the table, and an open pane hides the reset) and runs `tccutil reset <service> com.justin06lee.ruri` for exactly the nine services above — never `All`, never another bundle id — and the first launch of the new build asks for each grant again (`askAgainIfNewBuild`, which checks the bundle's signature with `codesign -dv` and does nothing for a build signed with the identity). Dev runs and test harnesses are not builds and are left alone.
