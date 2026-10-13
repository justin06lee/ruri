# ruri — architecture

The shape of this project, for a model that has never seen it: the stack it is built as, top to bottom, how the parts connect, where things are, how to run it. This is the index. Each layer has a sheet of its own in `.ruri/layers/` — where to change what inside it, how it works, its key files, its traps — so read the one for the layer you are about to work in (`ruri layer <slug>` prints it), and leave the rest. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.
Don't edit this file: ruri writes it. `ruri architecture` prints it with every line numbered, and once you have read it that way you can put right what your work changed — `ruri architecture add|set|drop <section> …`. The user corrects it on the architecture page.

Read from the repo at 137e280; folded forward from finished turns since. Where it and the code disagree, the code is right.

A desktop app for macOS and Linux for managing projects — each one lead agent the user talks to, with a team of persistent agent sessions behind it — powered by installed agent CLIs.

## The stack, top to bottom

1. **Conversation: composer and chat** — Composing prompts and reading replies, with attachments, markdown, diffs and questions (`web/src/components/, web/src/, web/src/lib/ · 24 files`) → `.ruri/layers/conversation.md`
2. **Navigation: sidebar, projects and queue** — Moving between projects (each its lead), with sidebar, home board, switcher, queue and rapid fire (`web/src/components/, web/src/lib/ · 10 files`) → `.ruri/layers/navigation-projects.md`
3. **Management: agents, skills and tracking** — Managing agents, integrations, skills, ideas, talk and cost/tracker pages (`web/src/components/, web/src/lib/, scripts/ · 12 files`) → `.ruri/layers/management-pages.md`
4. **Appearance: theme, art and component library** — Theming, peek band and hero art, dragon gauges and shared UI pieces (`web/src/components/, web/src/, web/src/lib/ +3 · 23 files`) → `.ruri/layers/appearance-library.md`
5. **App shell, state and tooling** — App entry, store, prefs, global styles, clocks, fixture and art tuner tooling (`web/src/, web/, ./ +1 · 6 files`) → `.ruri/layers/app-shell.md`
6. **Chat runs and queue** — Live prompts, queue, turns, rewind and transcript delivery over the socket. (`server/, server/handlers/, scripts/ · 23 files`) → `.ruri/layers/chat-runs-queue.md`
7. **Projects, memory and history** — Project sessions, checkpoints, working memory, archive, tracker and briefs. (`server/, server/handlers/, scripts/ · 40 files`) → `.ruri/layers/projects-memory-history.md`
8. **Library, skills and sweeps** — Component library, skills, repo sweeps and their screenshots. (`server/, server/handlers/ · 9 files`) → `.ruri/layers/library-skills-sweeps.md`
9. **Terminals, agents and integrations** — Composer terminals, background scripts, crew agents, music and harness integrations. (`server/, server/handlers/, scripts/ · 14 files`) → `.ruri/layers/terminals-agents-integrations.md`
10. **Server runtime and transport** — Node HTTP+WebSocket server, routing, auth, uploads, secrets, gauges and shared stores. (`server/, scripts/, scripts/lib/ +2 · 8 files`) → `.ruri/layers/server-runtime-transport.md`
11. **Agent harnesses** — yagami AgentSession to installed claude/Codex/OpenCode/Gemini/ACP CLIs, models, small-model layer (`server/, scripts/ · 14 files`) → `.ruri/layers/harnesses.md`
12. **Bridge** — Hidden Chromium over CDP plus native apps over Accessibility, previews above composer (`server/, desktop/ · 12 files`) → `.ruri/layers/bridge.md`

## How it flows

- **A prompt turn:** Composer (web/src/components/Composer.tsx) → WebSocket (shared/protocol.ts) → server/dispatch.ts + server/queue.ts → providers/harness CLI (server/providers.ts) → StreamingMarkdown/EventView (web/src/markdown.tsx)
- **An agent messages another agent:** message_agent / start_chat (server/talk.ts, server/handlers/talk.ts) → target interrupted or queued; a sleeping team member woken when the memory budget has a slot (server/handlers/team.ts), another project reached through its lead → approval card / reply back
- **A session drives what it built:** server/bridge.ts + server/cdp.ts → hidden browser / native app (desktop/bridge.ts) → BridgeStrip preview (web/src/components/Bridge.tsx) → takeover / give back
- **Memory and architecture fold-in:** ruri note/recall/state CLI (server/memoryCli.ts) → .ruri/catchup.md + .ruri/architecture.md + .ruri/layers/ → Architecture page (web/src/components/Architecture.tsx)

## Where things are

- server/ — Node backend: sessions, chats, queue, checkpoints, memory, bridge, routes
- server/handlers/ — WebSocket/HTTP handlers per surface: projects, prompts, rewind, talk, skills
- web/src/ — React UI: ChatPane, Composer, Queue, Sidebar, Settings, theming
- web/src/components/ — chat, attachments, bridge, agents, architecture, ideas, tracker views
- web/src/lib/ — markdown, markers, models, transcript, effects, peek band helpers
- shared/ — single wire contract: protocol.ts, client schema, question input
- desktop/ — Electron shell: main, permissions, hidden bridge windows, native apps (linuxApps.ts on Linux)
- scripts/ — per-capability smoke/dev scripts run via bun run *-test
- docs/ — features, permissions, long-form capability docs
- assets/ — ruri.svg, dragon art

## How to run it

- make # macOS: build, sign, install ruri.app to /Applications, tidy, launch · Linux: build, install to ~/.local/opt/ruri + .desktop + icon, AppArmor profile and apt deps once (sudo), launch
- make update # stop running app, rebuild, reinstall, relaunch
- make build # bundle only, into dist-app/
- bun install # install dependencies
- bun run dev # browser mode: server :7777 + UI :5173
- bun run desktop # unpackaged desktop app (built UI + Electron); on Ubuntu 24.04+ add -- --no-sandbox
- bun test # unit tests
- bun run typecheck # server + web typecheck

## Conventions

- Package manager is bun (bun install, bun run, bun test)
- Prettier + ESLint: bun run format, format:check, lint; typecheck before shipping
- macOS and Linux; installed by make, never downloaded; not notarized; Linux install is per-user under ~/.local
- Stable self-signed `ruri dev` identity keeps privacy grants across rebuilds

## What it does

- Project workspaces: one lead chat per project with a team of persistent members behind it (duties, sleep between jobs, a memory-budgeted number at work, team page), visibility controls, single-open guard
- Home workspace agent: finds projects by name, opens them, kicks off sessions
- Any harness verbatim: Claude, Codex, OpenCode, Gemini, ACP, per-chat model/effort/permissions
- Streaming markdown replies: tool chips, inline diffs, read previews, unified permission cards
- App-side prompt queue: reorder, merge with undo, edit, interrupt via Cmd+Enter/held Enter
- Queued messages hold on connection or usage-limit errors, with manual send
- Attachments: images, videos, PDFs, files, region crops, viewer, sketch pad
- Edit and rewind: per-harness checkpoints, fork exchanges, import outside chats, lost-session auto fresh-start with resend, startup-failure auto-retry
- Subagents and background scripts as live cards, agents page, brief-started agents
- Agent messaging with interrupt-or-queue delivery, busy status, new-chat start, approvals
- Bridge preview and takeover for web pages via hidden CDP browser and native apps via Accessibility (macOS) or X11 + AT-SPI over D-Bus (Linux)
- MCP servers, plugins, marketplaces for Claude Code and Codex via Settings
- Project memory as an audited log, folded from every finished turn and checked against the code, with project-wide recall by words and meaning, git state block, layered architecture sheets with per-layer session notes and slim project-wide catchup
- Sessions edit layer sheets only after reading, by line number with stale-read guard
- Frontend component library with freshness stamps, auto-refresh and picture capture
- Linux: per-user make install, GNOME app grid entry, Ctrl for ⌘ shortcuts, no grants to ask for
