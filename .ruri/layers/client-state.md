# ruri — Client state

One layer of ruri's stack, owning `web/src/store.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer client-state` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer client-state add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Zustand store connects the interface to server messages and holds client session state. It uses the shared protocol for message types, state types, and transcript limits. Start here when a change affects state shared across screens or how the client sends and receives messages.

## Where to change what

- **Session state and server messages:** web/src/store.ts
- **Sending client actions:** web/src/store.ts
- **Transcript loading and history:** web/src/store.ts
- **Composer drafts and attachments:** web/src/store.ts
- **Channel, board, and meter watching:** web/src/store.ts
- **Agent navigation and logs:** web/src/store.ts
- **Terminal messages:** web/src/store.ts

## How it works

- **Client and server state:** Interface code calls send with a client message → The store handles server messages → Interface code reads state through useRuri

## Key files

- web/src/store.ts — Zustand store, message connection, session state, and exported client actions

## Rules and traps

- Use the shared protocol's message types and transcript constants when changing the corresponding store behavior.
- Transcript handling uses the imported overlay and reuse helpers.
- unread[chat] is the sidebar's and projects page's diamond: set by a result event the user didn't see. The open chat counts as unseen while the projects page or settings has the pane; closing either clears the open chat's mark (seen()).

## What it talks to

- Shared protocol — supplies message and state types, defaults, and transcript constants
- Server transport — exchanges client and server messages
- Chat and prompting — uses drafts, attachments, transcripts, terminal messages, and session state
- Home and project pages — reads board, project, and related state
- Agent and bridge views — uses agent navigation, logs, and bridge state
