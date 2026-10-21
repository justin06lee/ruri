# ruri — App shell, state and tooling

One layer of ruri's stack, owning `web/src/, web/index.html, eslint.config.js, scripts/run-tests.ts, vite.config.ts, scripts/session-settings.ts, scripts/sharing.ts, Makefile, package.json, scripts/build-main.ts, scripts/make-icon.sh, build/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer app-shell` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer app-shell add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer is the web app shell: entry HTML, React root, global zustand store with socket wiring, local-first prefs, and global manga-theme styles. It freezes a window nobody can see (minimised, hidden, another Space, or fully covered, not merely unfocused): inbound updates are held with only the latest kept and applied in one redraw on wake, while agents and terminals keep running. It also carries the Linux shell adaptations: Permissions settings renders a no-grants message instead of macOS calls and shortcuts use Ctrl on Linux. Newcomers must grasp that store.ts is the single state/socket hub all feature layers read, that held.ts owns the asleep hold-and-catch-up, and that styles.css plus the beat/awake/spin clocks define how anything may look or move.

## Where to change what

- **App root and page routing:** web/src/App.tsx, web/src/main.tsx, web/index.html
- **Global store, socket and prefs:** web/src/store.ts, web/src/prefs.ts
- **Asleep frozen hold and catch-up:** web/src/lib/held.ts, web/src/store.ts
- **Global manga theme styles:** web/src/styles.css
- **Animation clocks:** web/src/lib/beat.ts, web/src/lib/spin.ts, web/src/lib/awake.ts
- **Fixture eyeball mode:** web/src/fixture.ts, web/src/store.ts
- **Art tuner dev tool:** vite.config.ts
- **Shared chat card pieces:** web/src/components/chat/AgentCard.tsx, web/src/components/chat/Icon.tsx, web/src/components/chat/empty.ts
- **Build, lint and script tests:** vite.config.ts, eslint.config.js, scripts/run-tests.ts
- **Settings permissions Linux copy:** web/src/components/Settings.tsx
- **Terminal and composer Linux keys:** web/src/components/Terminal.tsx, web/src/components/Composer.tsx, web/src/components/Switcher.tsx, web/src/components/Sketch.tsx
- **Team page roster:** web/src/components/TeamPage.tsx, web/src/components/ChatPane.tsx, web/src/store.ts, web/src/styles.css
- **Chat pane and continuation display:** web/src/components/ChatPane.tsx, web/src/components/PermissionBanner.tsx, web/src/components/Exchange.tsx, web/src/store.ts
- **Sidebar project rows and session navigation:** web/src/components/Sidebar.tsx, web/src/components/ChatPane.tsx, web/src/store.ts
- **Home board and queue:** web/src/components/HomeBoard.tsx, web/src/components/Queue.tsx, web/src/styles.css
- **Project hooks state and styling:** web/src/store.ts, web/src/styles.css
- **Packaging and release artifacts:** Makefile, package.json, scripts/build-main.ts, build/

## How it works

- **App boot to live state:** web/index.html loads web/src/main.tsx → main.tsx paints cached pref theme then mounts web/src/App.tsx → App.tsx connects web/src/store.ts socket once → store hydrates prefs via web/src/prefs.ts and prewarms transcripts → clocks in web/src/lib/beat.ts and web/src/lib/spin.ts start only while awake per web/src/lib/awake.ts
- **Asleep freeze to wake catch-up:** window sleeps and store sets live false → web/src/lib/held.ts holds inbound updates keeping only the latest of each kind → server holds chat streams at the marked position → on wake held updates apply in a single redraw → server sends each open chat exactly what it missed
- **Fixture screenshot pass:** open ?fixture to run web/src/fixture.ts installFixture → fixture drives web/src/store.ts with canned events and statuses → eyeball or screenshot with no server and no tokens
- **Release artifacts:** make build in a clean worktree of the tag (signs as ruri dev) → bunx electron-builder --mac dir --x64 and --linux dir --x64 --arm64 (cross-builds fine: no native modules ship) → ditto -c -k --norsrc --noextattr --noacl --keepParent per .app, tar.gz of each linux-*-unpacked plus build/icon.svg → checksums.txt → gh release create --draft

## Key files

- web/src/store.ts — global zustand store, socket send/watchers, drafts and transcripts
- web/src/lib/held.ts — asleep hold queue keeping latest per kind with single-redraw catch-up
- web/src/App.tsx — root component, page switch, connect-once and transcript prewarm
- web/src/main.tsx — boot entry, pref-first paint, copy installer, fixture switch
- web/src/styles.css — whole manga theme tokens, surfaces, motion-layer rules
- web/src/prefs.ts — localStorage-first pref cache in front of server prefs
- web/src/fixture.ts — canned ?fixture state for UI eyeballing without server
- web/src/tuner.tsx — dev-only peek-band and hero-frame art placer
- web/src/lib/beat.ts — slow shared tick clock for self-moving elements
- vite.config.ts — dev server plus tuner-save endpoint with dev-origin check
- web/src/components/TeamPage.tsx — team roster, Stop/Refresh controls, liaison card and unstaffed chips
- web/src/components/Exchange.tsx — chat exchange rendering with continuation and handoff note
- web/src/components/ChatPane.tsx — chat pane driving store team actions
- web/src/components/Sidebar.tsx — project rows staying lit while any of its chats is open
- web/src/components/HomeBoard.tsx — home board surfacing team state

## Rules and traps

- No CSS animations for ambient motion — drive steps from lib/beat.ts or lib/spin.ts so Chromium composites one layer instead of repainting at display rate.
- Never touch the DOM when a tick changes nothing, and never move anything while asleep, out of view, or under prefers-reduced-motion. Asleep means unseen (document.hidden), never merely unfocused — a visible window that slept on blur froze chats mid-reply; focus only sets the peek band's drag region (data-unfocused).
- A pref set this session wins over an arriving server snapshot — do not let hydrate overwrite touched keys.
- Surfaces differ by shade, never by line or shadow: keep --edge invisible and use --rim for genuine frames.
- Tuner page and tuner-save endpoint are dev-only and must never enter the app bundle or production build.
- Fixture mode is screenshots and timing only — it never talks to a server or spends tokens.
- Zip a .app with ditto -c -k --norsrc --noextattr --noacl --keepParent: plain ditto -c -k stores com.apple.provenance as ._ entries, and Finder's Archive Utility unpacks those as real ._ files inside Electron Framework.framework, breaking the signature (unsealed contents in an embedded framework).
- Never launch a second ruri build (a release copy, a test bundle) with only RURI_USER_DATA set: it claims port 7776 and SIGTERMs the running ruri's server (server/port.ts reclaim). Set RURI_PORT, RURI_CONFIG_DIR and RURI_USER_DATA, and open -n.
- electronLanguages keeps both en (macOS en.lproj) and en-US (Linux locales/en-US.pak): with en alone the Linux build ships an empty locales/. Smoke-test Linux tarballs with ruri-release-cache/v0.77.0/linux-smoke.sh, which must see ruri stay up, not just answer once.
- Every release also bumps Casks/ruri.rb in justin06lee/homebrew-tap (version and both sha256s; check with brew style, brew audit --cask --strict --online, brew fetch --cask) and ruri.codes' src/release.ts VERSION. Its links use releases/latest/download/<name>, so the asset names never change.

## What it talks to

- Protocol — store.ts types every client/server message from shared/protocol.ts
- Appearance — tuner.tsx writes src/peek.ts and styles.css carries theme tokens theme.ts paints into
- Chat runs and queue — store watchers deliver server transcripts, queue, progress and permissions
- Terminals, agents and integrations — prefs.ts cache fronts server/prefs.ts over the socket
- Project hooks — store.ts and styles.css carry the hooks UI state and styling; the hook logic itself lives in the integrations layer
- Test scripts: composer, windows and previews — ?fixture and ?awake flags exist to be driven by shot/chips scripts
