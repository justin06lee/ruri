# ruri — Navigation: sidebar, projects and queue

One layer of ruri's stack, owning `web/src/components/Sidebar.tsx, web/src/components/HomeBoard.tsx, web/src/components/Switcher.tsx, web/src/components/Queue.tsx, web/src/components/RapidFire.tsx, web/src/components/SessionControls.tsx, web/src/components/Player.tsx, web/src/lib/fuzzy.ts, web/src/lib/runNote.ts, web/src/lib/audio.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer navigation-projects` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer navigation-projects add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer moves the user between projects: a sidebar row per project (its lead behind it, the count of teammates at work beside it), HomeBoard projects overview, ⌘K/right-Option Switcher, per-chat Queue list, Rapid Fire line, SessionControls pickers, and Player music bar. It is built as presentational React components over the app store (useRuri/send) plus three small libs (fuzzy scoring, run-note staleness, Web Audio engine). Newcomers must grasp that a project is one chat for the user — its lead; its team's members never show here — and these components navigate and display state but never own turn execution.

## Where to change what

- **Sidebar project rows (one a project, its lead):** web/src/components/Sidebar.tsx, web/src/components/Player.tsx
- **Home projects board:** web/src/components/HomeBoard.tsx
- **Quick switcher (⌘K / right Option):** web/src/components/Switcher.tsx, web/src/lib/fuzzy.ts
- **Queued prompts list:** web/src/components/Queue.tsx
- **Rapid Fire line:** web/src/components/RapidFire.tsx
- **Per-chat session controls (model/effort/permission):** web/src/components/SessionControls.tsx
- **Music player bar:** web/src/components/Player.tsx, web/src/lib/audio.ts
- **Fuzzy search scoring:** web/src/lib/fuzzy.ts
- **Background-run notes and timestamps:** web/src/lib/runNote.ts

## How it works

- **Switch project:** Sidebar row, Switcher Enter, HomeBoard card, or RapidBar hand-off calls setActive/go on the project's lead → setActive turns a member's id into its lead's (store.ts shownChat) while app active session is preserved where required (RapidFire) → Chat pane renders the lead's transcript → Unread pips and recent-note lines update from store (teammates' turns wear none)
- **Hold and dispatch a queued prompt:** Queue.tsx holds prompt app-side while a turn runs (nothing reaches harness) → User edits, merges (drop on body), reorders (drop on edge), or removes card up to dispatch → Fold can be undone within UNDO_MS (8000ms) → composeInto/send releases the prompt when its turn comes
- **Rapid Fire pass through ready sessions:** Line membership resolved via lib/rapid: all open vs starred-only, hidden excluded → RapidFire hands the ordinary chat pane a different channel to show (builds no pane) → Prompt lands and sits readable, card eases out → Next project name announces big before its chat rises → Leaving the line restores the prior active session

## Key files

- web/src/components/Sidebar.tsx — a row per project (ProjectRow: the lead behind it, teammates at work counted, star/hide/remove), Home and Projects rows, account bar
- web/src/components/HomeBoard.tsx — HomeTab/HomeDeck/ProjectsPage grid of per-project status cards
- web/src/components/Switcher.tsx — ⌘K/right-Option fuzzy search over places and projects, each opening its lead
- web/src/components/Queue.tsx — QueuedList/QueueStandby editable held-prompt cards with drag reorder/merge
- web/src/components/RapidFire.tsx — RapidFire/useRapidFire/RapidBar same-chat session line
- web/src/components/SessionControls.tsx — composer's per-chat model/effort/permission pickers
- web/src/components/Player.tsx — music bar, waveform, seek/volume over AudioEngine
- web/src/lib/audio.ts — two-deck Web Audio engine with crossfade, shuffle, repeat; streams /music/track
- web/src/lib/fuzzy.ts — score() ranked matcher for the switcher
- web/src/lib/runNote.ts — useNoteStale/FINAL_NOTE_MS/since() for background-run last words

## Rules and traps

- HomeBoard never animates: streaming reply words and anything moving belong only to the open chat.
- A project's team never shows here: the sidebar, switcher, rapid fire line and projects board give each project once, as its lead (leadOf), and setActive sends a member's id to its lead. RapidFire must not move the app's active session; leaving the line returns to where the user was.
- SessionControls picks are per chat (session id / Home channelId), never per project.
- Queued prompts stay app-side until their turn; editable/removable up to dispatch only.
- Switcher opens on right-Option tap alone; Option held for shortcuts (e.g. ⌥→) must not open it.
- Finished run notes expire after FINAL_NOTE_MS (25s) so stale results don't linger across opens.

## What it talks to

- App shell, state and tooling — reads/writes store via useRuri/send/setActive/composeInto and prefs via getPref/setPref
- Protocol — all entities typed in shared/protocol.ts (Project, SessionInfo, QueuedPrompt, Playlist/Track, HOME_ID)
- Conversation — RapidFire and Queue hand channels/prompts to the ordinary chat pane and composer
- Chat runs and queue — QueuedList mirrors server turn queue/held state; dispatches through send
- Management — HomeBoard embeds StatisticsPage for the cost question split off the board
