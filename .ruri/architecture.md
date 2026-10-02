# ruri — architecture

The shape of this project, for a model that has never seen it: the stack it is built as, top to bottom, how the parts connect, where things are, how to run it. This is the index. Each layer has a sheet of its own in `.ruri/layers/` — where to change what inside it, how it works, its key files, its traps — so read the one for the layer you are about to work in (`ruri layer <slug>` prints it), and leave the rest. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.
Don't edit this file: ruri writes it. `ruri architecture` prints it with every line numbered, and once you have read it that way you can put right what your work changed — `ruri architecture add|set|drop <section> …`. The user corrects it on the architecture page.

Read from the repo at 73767d2; folded forward from finished turns since. Where it and the code disagree, the code is right.

ruri is a macOS and Linux desktop workspace for people working with coding agents across multiple projects. It keeps each project’s sessions together, warm, and resumable while letting each chat use an installed agent harness.

## The stack, top to bottom

1. **Window and navigation** — Starts the React window and provides its layout, navigation, shared controls, and visual behavior. (`web/, web/src/ · 1 file`) → `.ruri/layers/window-navigation.md`
2. **Chat and prompting** — Displays transcripts and session controls, and lets users compose prompts with attachments, commands, and terminal input. (`web/src/components/, web/src/components/chat/, web/src/ +1 · 36 files`) → `.ruri/layers/chat-prompting.md`
3. **Home and project pages** — Shows the home board, ideas, project architecture, component gallery, usage statistics, and feature tracker. (`web/src/components/, web/src/lib/ · 9 files`) → `.ruri/layers/home-project-pages.md`
4. **Agent and bridge views** — Shows agent runs, agent messaging, and the pages or apps a session is driving through the bridge. (`web/src/components/, web/src/components/chat/ · 4 files`) → `.ruri/layers/agent-bridge-views.md`
5. **Settings and personalization** — Edits integrations, skills, themes, greetings, pictures, and media preferences, and renders the personalized band and player. (`web/src/, web/src/components/, web/src/lib/ · 19 files`) → `.ruri/layers/settings-personalization.md`
6. **Interface tooling: development and tests** — Configures the Vite development page and supplies fixture state and DOM setup for interface tests. (`./, web/src/, web/src/test/ · 2 files`) → `.ruri/layers/interface-tooling.md`
7. **Client state** — The client store connects the interface to server messages and holds session state. (`web/src/store.ts`) → `.ruri/layers/client-state.md`
8. **Shared protocol** — Shared TypeScript protocol and schemas define data exchanged across the app. (`shared/`) → `.ruri/layers/shared-protocol.md`
9. **Server transport** — The server starts HTTP and socket services, routes requests, and dispatches actions. (`server/, server/handlers/ · 11 files`) → `.ruri/layers/server-transport.md`
10. **Sessions** — Session management connects chats, prompts, queues, providers, and agent events. (`server/ · 10 files`) → `.ruri/layers/sessions.md`
11. **Project knowledge** — Project memory, architecture sheets, recall, and component records support sessions. (`server/ · 13 files`) → `.ruri/layers/project-knowledge.md`
12. **Server services** — Remaining server modules handle persistence, settings, uploads, integrations, usage, and support work. (`server/`) → `.ruri/layers/server-services.md`
13. **Bridge** — Server CDP and desktop bridge modules let sessions inspect and drive pages or apps. (`server/, desktop/ · 8 files`) → `.ruri/layers/bridge.md`
14. **Desktop shell** — Electron runs the desktop window and handles platform permissions and app lifecycle. (`desktop/ · 8 files`) → `.ruri/layers/desktop-shell.md`
15. **Build and checks** — Bun scripts, Make targets, and configuration build, install, format, and check the app. (`scripts/, ./ · 5 files`) → `.ruri/layers/build-and-checks.md`
16. **Agent runtimes** — Installed Claude, Codex, OpenCode, Gemini, or ACP harnesses run the coding sessions.

## How it flows

- **A prompt:** composer (web/src/components/Composer.tsx) → client store (web/src/store.ts) → socket (server/socket.ts) → dispatcher (server/dispatch.ts) → sessions (server/sessions.ts) → providers (server/providers.ts) → installed agent harness
- **A streamed reply:** installed agent harness → sessions (server/sessions.ts) → events (server/events.ts) → socket (server/socket.ts) → client store (web/src/store.ts) → chat pane (web/src/components/ChatPane.tsx)
- **A bridge preview:** session (server/sessions.ts) → bridge (server/bridge.ts) → CDP (server/cdp.ts) or desktop bridge (desktop/bridge.ts) → client store (web/src/store.ts) → bridge strip (web/src/components/Bridge.tsx)
- **A project architecture edit:** architecture page (web/src/components/Architecture.tsx) → client store (web/src/store.ts) → project handler (server/handlers/projects.ts) → sheet edits (server/sheetEdits.ts) → .ruri/architecture.md or .ruri/layers/

## Where things are

- web/src/ — React interface, client state, rendering, and browser helpers.
- web/src/components/ — chat, project, settings, bridge, and architecture views.
- shared/ — client and server protocol types and schemas.
- server/ — sessions, transport, project records, integrations, and bridge services.
- server/sharing.ts — host sharing, device pairing, and access control.
- server/handlers/ — handlers for prompts, projects, settings, transcripts, and other actions.
- desktop/ — Electron entry point, platform permissions, capture, and native app bridge.
- scripts/ — build helpers, checks, and scenario test scripts.
- .ruri/architecture.json — shareable project architecture index for import.
- assets/ — app artwork.
- docs/ — project documentation, including desktop permissions.
- package.json — Bun scripts and package metadata.
- Makefile — platform build, installation, update, and launch targets.

## How to run it

- make — build, install, tidy, and launch.
- make update — stop, rebuild, reinstall, tidy, and relaunch.
- make build — build the app into dist-app/.
- bun install — install dependencies for development.
- bun run dev — run the server on port 7777 and UI on port 5173.
- bun run desktop — run the unpackaged desktop app.
- bun run typecheck — check server, web, and web test TypeScript.
- bun test — run the Bun tests.
- ruri --serve — run with no window (headless when there is no display), sharing on, printing six words; ruri --invite prints more, ruri --quit stops it.
- bun run sharing-test — the sharing door: pairing, keys, origins, unpairing.

## Conventions

- Use Bun for dependencies and package scripts.
- Use make as the build, install, and launch path on macOS and Linux.
- Run sessions through an installed, signed-in coding CLI.
- On Linux with restricted user namespaces, pass --no-sandbox when running the unpackaged desktop app.
- Project memory and architecture live under each project’s .ruri/ directory.

## What it does

- Find projects and start sessions from the Home workspace agent.
- Keep parallel project sessions warm and resume them after relaunch.
- Choose installed agent harnesses, models, effort, and permissions per chat.
- Discover computers, set up remote hosts over SSH, and pair with six words.
- Stream replies with tool results, diffs, previews, and permission cards.
- Queue, edit, reorder, merge, or interrupt prompts during a turn.
- Attach files and media, crop image regions, and sketch.
- Checkpoint, rewind, fork, and import agent conversations.
- Manage MCP servers, plugins, and marketplaces through harness CLIs.
- Follow subagents and background scripts through live cards.
- See recently finished, unopened chats in navigation and Projects.
- Let agents message sessions in other open projects.
- Let sessions inspect and drive browser pages or native apps.
- Maintain project memory and shareable architecture sheets incrementally.
- Maintain a component library.
