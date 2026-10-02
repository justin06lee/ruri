# ruri — Server services

One layer of ruri's stack, owning `server/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer server-services` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer server-services add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer supplies the server’s persistence and supporting services, including archives, project settings, checkpoints, integrations, usage, terminals, and project briefs. The server runs in a separate Electron helper process and requests Electron-only operations through a message link to the main process. A newcomer should identify which service owns a record, whether it is shared through `.ruri/`, and which side of the process link owns an operation.

## Where to change what

- **Server process startup and context:** server/desktopServer.ts, server/server.ts, server/context.ts, server/handlers/index.ts
- **Electron host requests and bridge:** server/hostLink.ts, server/bridge.ts, server/routes.ts, server/handlers/host.ts
- **Port ownership and process meters:** server/port.ts, server/resources.ts, server/resources.test.ts, server/usage.ts
- **Session transcripts, checkpoints, and rewind:** server/archive.ts, server/checkpoints.ts
- **Project and chat settings:** server/projects.ts, server/prefs.ts, server/handlers/projects.ts, server/handlers/projects.test.ts
- **Project architecture and briefs:** server/brief.ts, server/ruriDir.ts, server/handoff.ts, server/layers.test.ts
- **Project notes and catchup:** server/notes.ts, server/catchup.ts, server/catchupBrief.ts, server/notesBackfill.test.ts
- **Small-model summaries and layer sheets:** server/smallmodel.ts, server/smallmodel.test.ts, server/lazySheets.test.ts
- **MCP servers and plugins:** server/integrations.ts
- **Sharing and device invites:** server/sharing.ts, server/invite.ts, server/handlers/sharing.ts, server/invite.test.ts
- **Window message delivery:** server/clients.ts, server/events.ts
- **Terminal tabs and attachments:** server/terminal.ts, server/scrollback.ts, server/uploads.ts, server/handlers/pictures.test.ts

## How it works

- **Desktop server and host operations:** Electron starts the server in a helper process → The server handles requests and sends Electron-only operations over the host message link → Electron performs those operations and returns their results → If the server exits unexpectedly, Electron starts a replacement and the window reconnects on the same port
- **Project checkpoint:** Capture the working tree when a prompt goes out → Capture it again when the turn ends → Build commits through a private Git index and retain them under refs/ruri/ → Use those checkpoints for rewind
- **Project architecture:** Read a project's overview for its first prompt → Import an existing `.ruri/architecture.json` when the project has one → Write or update a layer sheet when a turn touches that layer or someone opens it on the Architecture page → Add files and folders to a new project's architecture as work reaches them

## Key files

- server/desktopServer.ts — starts the server inside the Electron helper process
- server/hostLink.ts — carries requests and results between the server and Electron main process
- server/server.ts — assembles and runs the server
- server/bridge.ts — connects server bridge operations to the Electron host
- server/archive.ts — persists live transcripts, earlier history, turn summaries, and resumable session IDs
- server/checkpoints.ts — captures working trees and supports turn rewind through private Git refs
- server/brief.ts — builds and writes project architecture and briefing files
- server/ruriDir.ts — manages project files under `.ruri/`
- server/sharing.ts — provides server-side sharing support
- server/resources.ts — samples current process CPU and memory for the Statistics page

## Rules and traps

- The live archive starts at the newest compaction mark; older events belong in append-only history.
- Checkpoint capture must leave the user’s branch, staging area, and Git status unchanged.
- Electron-only bridge, screenshot, permission, and window operations must run in the main process through the host link.
- Port ownership must report the app’s PID; stopping only the helper server would let the old app restart it.
- Change harness integrations through their CLIs; do not write their configuration formats by hand. Reading Claude MCP servers must not invoke `claude mcp list`, which starts servers for health checks.
- On Linux, process CPU from `ps` is a lifetime average and summed RSS counts shared Chromium pages repeatedly; use interval CPU and shared-page-aware memory for the Statistics meter.

## What it talks to

- Shared protocol — supplies session, project, integration, usage, transcript, and architecture types
- Sessions — archive, checkpoints, briefs, terminals, and resource meters support active chats
- Project knowledge — briefs, handoff context, notes, and small-model output feed project memory
- Desktop main process — hosts Electron-only operations requested over the message link and restarts the helper server after a crash
- Agent runtimes — integrations, updates, usage, and recent-session import read or invoke installed harnesses
