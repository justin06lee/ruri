# ruri — Terminal window (ruri tui)

One layer of ruri's stack, owning `tui/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer terminal-window-ruri-tui` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer terminal-window-ruri-tui add|set|drop <section> …`. Where it and the code disagree, the code is right.

ruri tui: the desktop window drawn in a terminal, as a client of the running server like the web window and the phone. It opens the server's WebSocket with the config folder's token and speaks shared/protocol.ts; it runs no turn and holds nothing the server doesn't. Written with Ink (React for terminals), pinned at 7.1.1 because Ink 8 needs React 19.3. Everything on screen is a pure function returning lines; App.tsx sizes the parts, decides which has the keys and maps keys to store actions. Newcomers must grasp three things: state.ts reduce mirrors the web store's message rules and reuses web/src/lib helpers; the store redraws at once for a key and at most 30 times a second for server messages; and key handlers read the prompt box from store.get(), never from the render's copy.

## Where to change what

- **Entry, flags, token, socket dial:** tui/src/main.tsx, tui/src/client.ts
- **What it knows and every server message applied:** tui/src/state.ts
- **What the keys ask of the server (prompts, drafts, cards, picks, queue):** tui/src/store.ts
- **Layout, focus and every key:** tui/src/App.tsx
- **A chat as lines: events, tool steps, patches, results:** tui/src/rows.ts, tui/src/markdown.ts
- **Permission, question, message and naming cards:** tui/src/cards.ts
- **Sidebar, gauges, working line, queue, pickers, menus, switcher, help:** tui/src/view.ts
- **The prompt box: text, caret, wrapping:** tui/src/editor.ts
- **Colours and spinner:** tui/src/theme.ts
- **How ruri tui is found and bundled:** server/library.ts, scripts/build-main.ts, desktop/serverProcess.ts

## How it works

- **Start:** ruri tui (the ruri command's tui branch, server/library.ts tuiCommand) → app's Electron as plain Node runs dist-electron/tui.mjs, or bun runs tui/src/main.tsx → token from <config>/token → WebSocket with x-ruri-token and no Origin → snapshot → view + transcript_get for the chat on screen
- **A prompt:** App.tsx Enter → store.prompt sends send with a clientId and clears the draft everywhere → server answers sent, then event / queued → reduce → rows.ts lays out only the events that changed
- **A draft:** store.edit saves draft 400 ms after the last key, with no attachments field so the server keeps a desktop draft's files → composer_draft from another device lands in the box unless it was typed in within 2 s
- **A card:** permission_request → cardsOf picks the chat's oldest → it takes the keys from an empty prompt box → cards.ts cardKey returns a Verdict → store answers permission_response / question_response / component_named

## Key files

- tui/src/App.tsx — the one component: sizes, focus order (sidebar, chat, card, queue, prompt, pickers), overlays, key map, screen assembly, cursor
- tui/src/state.ts — State, reduce, sidebarRows, controlsOf (the desktop's SessionControls rules), markOf
- tui/src/store.ts — Ruri: subscribe/get for React, the line, actions, throttled redraw
- tui/src/test/fixtures.ts — a small snapshot and FakeWire, the socket stand-in every test uses
- tui/src/app.test.tsx — the whole app under ink-testing-library, keys written to stdin

## Rules and traps

- Tests never touch a real ruri: FakeWire in unit tests; by hand, a scratch server with its own RURI_PORT and RURI_CONFIG_DIR.
- Driving it by hand needs a real pty: tmux send-keys stopped delivering keys with no client attached (tmux 3.8). A Python pty plus pyte reads the screen reliably.
- Lines handed to Ink must already fit: use fit/pad (rows.ts), which are colour-safe and count CJK as two columns; an empty line is drawn as a space or the row collapses.
- No Date.now() in render (react-hooks/purity): useNow for what is drawn, timeNow() inside handlers.
- A card must not be answerable by a stray key: letters and space do nothing, and keys are ignored for 600 ms after it appears.
- The sidebar never sorts: order and folders are the server's layout (shared/sidebar.ts); folding sends folder_set.

## What it talks to

- Protocol — every message typed by shared/protocol.ts; a new client message also needs shared/clientSchema.ts
- Server runtime and transport — the local door in server/socket.ts and server/auth.ts lets in a socket with no Origin and the token in a header
- App shell and Navigation — pure helpers imported from web/src/lib (transcript, outgoing, accounts, models, fuzzy); they must stay free of DOM code
- Chat runs and queue — server/handlers/prompts.ts draft keeps held files when attachments is absent
- Library, skills and sweeps — server/library.ts writes the ruri command, whose tui branch starts this
