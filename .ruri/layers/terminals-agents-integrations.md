# ruri — Terminals, agents and integrations

One layer of ruri's stack, owning `server/terminal.ts, server/handlers/terminal.ts, server/relay.ts, server/scrollback.ts, server/scripts.ts, server/handlers/crew.ts, server/music.ts, server/integrations.ts, server/handlers/integrations.ts, server/handlers/host.ts, server/handlers/settings.ts, server/prefs.ts, scripts/crew-live.ts, scripts/talk.ts, server/projectHooks.ts, server/handlers/hooks.ts, server/projectHooks.test.ts, server/projectHooks.midna.test.ts, scripts/project-hooks.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer terminals-agents-integrations` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer terminals-agents-integrations add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer runs everything beside the chat turn: composer pty terminals, background script output, user-started crew agents, folder-backed music serving, harness integrations plus host/settings plumbing, and the project hooks that tell midna (or any command/webhook) when a team is idle or blocked. It is built as small stateful server modules (Terminals, TerminalRelay, Scrollback, PrefStore, HookCenter) fronted by thin socket handlers, with CLI-mediated side effects. Newcomers must grasp that terminals are paced append-streams with backpressure, integration changes apply only at next harness launch, and hooks never block a project.

## Where to change what

- **Composer terminal tabs:** server/terminal.ts, server/handlers/terminal.ts, server/scrollback.ts, server/relay.ts
- **Terminal backpressure / relay:** server/relay.ts, server/terminal.ts, server/scrollback.ts
- **Background script output page:** server/scripts.ts, server/handlers/crew.ts
- **Crew agents (start/send/stop/follow):** server/handlers/crew.ts, scripts/crew-live.ts
- **MCP servers / plugins / marketplaces:** server/integrations.ts, server/handlers/integrations.ts
- **Music library and track serving:** server/music.ts, server/handlers/settings.ts
- **Window preferences:** server/prefs.ts, server/handlers/settings.ts
- **Settings changes (model, permissions, folders, art):** server/handlers/settings.ts, server/prefs.ts
- **Desktop host bridge (picker, permissions, windows):** server/handlers/host.ts
- **Agent-to-agent talk:** scripts/talk.ts
- **Project hooks (idle/blocked/test events to midna, commands, webhooks):** server/projectHooks.ts, server/handlers/hooks.ts, scripts/project-hooks.ts

## How it works

- **Terminal output to windows:** Terminals spawns login shell on pty via expect (pipes fallback) → Chunks appended to Scrollback in O(arrival) pieces → TerminalRelay holds per-window queue; ready window gets chunk at once → Behind windows coalesce waiting chunks into one message on drain → All windows behind pauses pty reads so writer blocks; nothing buffers unbounded
- **Integration change:** Window reads via readIntegrations (file listings, never starts servers) → Change runs through harness CLI command (e.g. claude mcp add-json) → Warm sessions on changed harness retired as each goes idle → Next prompt starts fresh process with new servers/plugins
- **Crew agent run:** Chat agents page starts agent on its own SessionManager → Card moves along; log holds brief and run output → agent_send follows up on same conversation; agent_stop ends long run → Chat transcript and status hear none of it
- **Project event to hooks:** projectWatch calls projectBusy at a busy period's start (ledger baseline) → then fireProjectEvent → payload built a tick later (chats that worked + lead, lastSummary ≤600 chars or the card's ask, costUsd = ledger growth, kept under 60 KB) → each global/per-project target delivered on its own: /bin/sh -c with JSON on stdin (midna's CLI by path by default), or POST (midna's envelope for /v1/inbound) → refusals given up, the rest retried 5s/30s/2m/10m with the same id → hook-deliveries.json, broadcast as hooks

## Key files

- server/terminal.ts — real pty shells per channel/tab behind composer terminal mode
- server/relay.ts — paces shell output to windows with per-window queues and pty backpressure
- server/scrollback.ts — chunk-list scrollback, joined only on read
- server/handlers/terminal.ts — socket handlers for terminal list/new/open/input/resize/close
- server/handlers/crew.ts — user-started crew agents on their own session manager
- server/scripts.ts — background script output page read from harness output file tail
- server/integrations.ts — MCP/plugin/marketplace read and CLI-mediated changes
- server/handlers/integrations.ts — Integrations settings handlers; retires warm sessions on change
- server/music.ts — folder-as-playlist music library scan and same-origin track serving
- server/prefs.ts — machine-scoped untyped window preference bag
- server/projectHooks.ts — HookCenter (hooks.json config with on/off, midna default, deliveries, retries, midna receipts) and the payload builder; projectBusy/fireProjectEvent/sendTestEvent for the rest of the server
- server/handlers/hooks.ts — hooks_get / hooks_set / hooks_test socket handlers

## Rules and traps

- Never write a harness config format by hand; every integration change goes through that CLI's own command.
- Never health-check Claude servers with `claude mcp list`; it starts every server — read ~/.claude.json / .mcp.json / plugin lists instead.
- Keep integration secrets as names only here; values stay in the harness layer.
- Terminal output is append-only so coalescing is safe; do not reorder or drop chunks.
- New window preferences need no change in server/prefs.ts — it is a deliberately untyped bag (max 200 keys).
- The project-event payload is a contract with midna (midna docs/inbound-events.md): never add or rename a field without telling midna's team; keep it under midna's 64 KB.
- A hook's bearer token never leaves the server: hooks.json is 0600 and windows see hasToken only — not prefs, the project record or the vault, all of which reach windows or every agent.
- Event data reaches a hook command through RURI_EVENT_*/RURI_PROJECT_* env vars, never spliced into the command line. Tests: RURI_MIDNA="" or a stub, MIDNA_URL/MIDNA_TOKEN at a stand-in for the real CLI, RURI_HOOK_RETRY_MS to shorten the backoff.

## What it talks to

- Agent harnesses — integration changes take effect only when a harness next starts; warm sessions retired idle
- Bridge — host handlers reach desktop shell for picker, permissions, bridge windows; no-ops headless
- Protocol — tabs, permissions, playlists, crew cards, integration rows typed in shared/protocol.ts
- Server runtime and transport — music served over /music/* same-origin; prefs/config live machine-side
- Chat runs and queue — server/projectWatch.ts decides idle/blocked and calls projectBusy/fireProjectEvent; delivery and the payload are this layer's
