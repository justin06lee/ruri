# ruri — Settings and personalization

One layer of ruri's stack, owning `web/src/band.ts, web/src/components/BandEditor.tsx, web/src/components/GreetingEditor.tsx, web/src/components/Integrations.tsx, web/src/components/PeekBand.tsx, web/src/components/Player.tsx, web/src/components/Settings.tsx, web/src/components/SettingsRows.tsx, web/src/components/Skills.tsx, web/src/greetings.ts, web/src/lib/audio.ts, web/src/lib/effects.ts, web/src/lib/greetings.ts, web/src/lib/peekBand.ts, web/src/pictures.ts, web/src/prefs.ts, web/src/theme.ts, web/src/components/Devices.tsx, web/src/lib/shell.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer settings-personalization` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer settings-personalization add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer provides settings for models, integrations, skills, themes, greetings, pictures, and music. React editors use the client store for server-backed actions, while preference modules keep local copies for immediate rendering. The key distinction is that band and greeting definitions are validated separately from their live, editable state.

## Where to change what

- **Settings page and model choices:** web/src/components/Settings.tsx
- **Integrations:** web/src/components/Integrations.tsx
- **Skills:** web/src/components/Skills.tsx
- **Theme and schedule:** web/src/theme.ts, web/src/components/Settings.tsx, web/src/prefs.ts
- **Peek band editing:** web/src/components/BandEditor.tsx, web/src/band.ts, web/src/lib/peekBand.ts
- **Peek band display and picture motion:** web/src/components/PeekBand.tsx, web/src/pictures.ts, web/src/lib/effects.ts
- **Greetings:** web/src/components/GreetingEditor.tsx, web/src/greetings.ts, web/src/lib/greetings.ts
- **Music player:** web/src/components/Player.tsx, web/src/lib/audio.ts, web/src/prefs.ts
- **Devices: sharing this computer, its six-word invites and paired devices, and this device's other computers:** web/src/components/Devices.tsx, web/src/lib/shell.ts

## How it works

- **Preference change:** An editor changes a setting → The relevant live module updates the window's copy → prefs.ts caches and sends the preference → A late server snapshot fills missing values without replacing changes made this session
- **Peek band picture:** BandEditor.tsx places and configures a picture → band.ts holds the live band → lib/peekBand.ts defines and validates its stored shape → pictures.ts loads uploaded bytes and chooses moving or still display → PeekBand.tsx renders the result
- **Music playback:** Player.tsx receives playlists and tracks from client state → Player.tsx passes tracks to AudioEngine → lib/audio.ts streams tracks and handles crossfade, shuffle, and repeat → Player.tsx renders playback state

## Key files

- web/src/components/Settings.tsx — settings page, including model choices and theme scheduling
- web/src/components/BandEditor.tsx — interactive peek band editor
- web/src/band.ts — live band state and preference persistence
- web/src/lib/peekBand.ts — band shape, defaults, limits, and stored-data parsing
- web/src/components/Integrations.tsx — MCP servers, plugins, and marketplaces UI
- web/src/components/Skills.tsx — installed skills view and enable controls
- web/src/components/Player.tsx — music player controls and display
- web/src/lib/audio.ts — two-deck Web Audio playback engine
- web/src/pictures.ts — uploaded picture loading and animation state
- web/src/prefs.ts — local preference cache, server synchronization, and watchers

## Rules and traps

- Preference reads are local-first so the theme can be applied before the first paint; hydration must not overwrite a preference changed in the current session.
- Band and greeting state is read on first use to avoid import cycles with the client store.
- Stored bands and greetings are parsed and constrained before use; the band allows at most 16 pictures, and greetings allow at most 20 lines of 80 characters.
- Band picture uploads remain referenced by the band preference; changing that reference affects how long uploads are retained.
- Integration changes are performed by the harness CLI, whose configuration holds command values; the UI shows those values by name only.
- Turning a skill off parks it in a sibling skills-off folder and turning it on restores it.

## What it talks to

- Client state — settings, integrations, skills, playlists, uploads, and preference updates use store state or messages
- Shared protocol — model, permission, integration, skill, playlist, and track data use shared types
- Server services — preferences, uploads, integrations, and music come from server-backed services
- Desktop shell — the peek band asks the shell to drag the window while pressed
- Home and project pages — Home uses the configured greetings
