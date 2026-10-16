# ruri — Appearance: theme, art and component library

One layer of ruri's stack, owning `web/src/components/Components.tsx, web/src/components/Architecture.tsx, web/src/components/Settings.tsx, web/src/components/SettingsRows.tsx, web/src/components/BandEditor.tsx, web/src/components/PeekBand.tsx, web/src/components/Dragon.tsx, web/src/components/Dropdown.tsx, web/src/components/Capped.tsx, web/src/components/Confirm.tsx, web/src/components/NameCard.tsx, web/src/band.ts, web/src/pictures.ts, web/src/dragonArt.ts, web/src/theme.ts, web/src/icons.ts, web/src/lib/effects.ts, web/src/lib/peekBand.ts, web/src/press.ts, scripts/draw-icon.ts, build/icon.png, web/src/lib/featureDoodles.ts, assets/feature-doodles.png`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer appearance-library` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer appearance-library add|set|drop <section> …`. Where it and the code disagree, the code is right.

Appearance owns ruri's look: light/dark/ember theming, the sidebar peek band, the empty-chat hero face, the dragon usage gauges, and the shared UI pieces (dropdown, confirm, settings rows). It is built as pure presentational state plus editors — shape/parse helpers in lib, live window copies in band.ts/hero.ts/pictures.ts, and manga-styled components. A newcomer must grasp that band/hero are stored shapes read back checked from disk, with live bytes and animation state kept separately, and that a visible window keeps animating whether or not it has focus.

## Where to change what

- **Theme and schedule:** web/src/theme.ts, web/src/components/Settings.tsx
- **Peek band display:** web/src/components/PeekBand.tsx, web/src/band.ts, web/src/lib/peekBand.ts
- **Peek band editor:** web/src/components/BandEditor.tsx, web/src/lib/peekBand.ts
- **Dragon gauges:** web/src/components/Dragon.tsx, web/src/dragonArt.ts
- **Settings page:** web/src/components/Settings.tsx, web/src/components/SettingsRows.tsx
- **Component library gallery:** web/src/components/Components.tsx
- **Architecture page:** web/src/components/Architecture.tsx
- **Shared primitives:** web/src/components/Dropdown.tsx, web/src/components/Confirm.tsx, web/src/components/Capped.tsx
- **Pictures and animation:** web/src/pictures.ts, web/src/lib/effects.ts
- **Icons, press art, tracing and the feature doodles (kept, not used yet):** web/src/icons.ts, web/src/press.ts, scripts/trace-dragon.py, web/src/lib/featureDoodles.ts

## How it works

- **Band / hero customize:** Stored shape parsed and checked in lib/peekBand.ts or lib/heroFace.ts → Live copy held in band.ts / hero.ts, pictures bytes in pictures.ts → Rendered by PeekBand.tsx / HeroFace.tsx → Edited by hand in BandEditor.tsx / HeroEditor.tsx → Written back, sidebar updates a beat later
- **Theme pick:** theme.ts reads per-machine pref via prefs → Settings hand-pick or schedule clock picks light/dark/ember → applyTheme paints the page → Hand pick turns schedule off

## Key files

- web/src/theme.ts — the three themes, schedule clock, and per-machine pref persistence
- web/src/band.ts — the window's live peek-band copy
- web/src/hero.ts — the window's live hero-face copy
- web/src/pictures.ts — user picture bytes, animated/still handling
- web/src/lib/peekBand.ts — band shape, defaults, checked parse
- web/src/lib/heroFace.ts — hero shape, face/greeting picking, checked parse
- web/src/components/PeekBand.tsx — sidebar band display and BandPic
- web/src/components/HeroFace.tsx — empty-chat face display
- web/src/components/Dragon.tsx — context/limit dragon gauges
- web/src/dragonArt.ts — traced calm/sweat dragon paths

## Rules and traps

- Band is the window title bar: while ruri is active it must not be a drag region or hover never arrives; press-and-drag moves via shell windowDrag. Focus only controls whether the picture strip along the top of the sidebar drags the window.
- Stored band/hero come off disk and must be parsed/checked, never trusted directly.
- Theme is per machine via prefs/localStorage, not per project.
- Dragon art is committed traced paths; only regenerate via scripts/trace-dragon.py and scripts/png-slim.ts if drawings change.
- Gauges belong to the channel model's harness, never default to Claude's numbers; missing limits show empty dragons.
- A visible window keeps streaming, clocks and animated pictures live even without focus; only hidden/minimized/covered goes quiet, so visible-but-unfocused ruri still uses CPU.
- The Components page never shows a stored screenshot at full size in a card or thumbnail — lib/thumbs.ts makes small copies; a shot whose file is gone counts as needing a picture, not as one

## What it talks to

- App shell, state and tooling — store, prefs, beat clock, styles and tuner drive all live copies
- Protocol — HarnessInfo, ModelRole, usage/limits and sheet types arrive typed from shared/protocol.ts
- Desktop shell — windowDrag carries band presses; theme/prefs persist via server copy
- Chat runs and queue — composer flanks read harness usage for dragon fills
- Management — Integrations and model catalog surface inside Settings
