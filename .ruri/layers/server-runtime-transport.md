# ruri — Server runtime and transport

One layer of ruri's stack, owning `server/, scripts/auth.ts, scripts/lib/server.ts, scripts/port.ts, scripts/uploads-sweep.ts, shared/protocol.ts, shared/clientSchema.ts, bunfig.toml, scripts/test-config.ts, shared/modelLine.ts, shared/sidebar.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer server-runtime-transport` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer server-runtime-transport add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer is the Node HTTP + WebSocket transport everything else rides on: one port serving the UI, uploads, and the socket every window talks over, assembled once around a shared ServerContext (server/context.ts) in server/server.ts. It moves bytes and enforces origin/token gates, while domain logic lives in handlers and other layers. It also carries each agent's context-usage line and self-compaction with CARRY_ON continuations (the agent decides; ruri compacts by itself only at the top of the window), the team status page, the sidebar layout, the model catalog, and the secret store, which holds ghostly's items in memory beside its own file. A window only sleeps when it cannot be seen at all; a visible-but-unfocused window stays live and keeps receiving streams.

## Where to change what

- **Server assembly and startup:** server/server.ts, server/context.ts, server/index.ts
- **HTTP routing (health, uploads, static UI):** server/routes.ts, server/mime.ts, server/readable.ts
- **WebSocket server and client fan-out:** server/socket.ts, server/clients.ts, server/context.ts, shared/protocol.ts
- **Auth gate (origin + token):** server/auth.ts, server/socket.ts, server/routes.ts
- **Prompt attachment uploads:** server/uploads.ts, server/mime.ts, scripts/uploads-sweep.ts
- **Secrets vault and placeholders:** server/secrets.ts, server/vault.ts, server/atomic.ts
- **Ghostly password source (Passwords page):** server/ghostly.ts, server/vault.ts, server/secrets.ts, server/vault.test.ts, server/vault.ghostly.test.ts
- **Usage and machine meters:** server/usage.ts, server/gauges.ts, server/resources.ts
- **Self-compaction and context tools:** server/selfCompaction.ts, server/chats.ts, server/routes.ts, shared/protocol.ts
- **Sidebar order and folders, one value:** shared/sidebar.ts, server/projects.ts, server/handlers/projects.ts

## How it works

- **Window connects and stays live:** HTTP server from server/routes.ts and socket from server/socket.ts listen on one claimed port (server/port.ts) → Socket upgrade checked for page origin and token (server/auth.ts), rejected otherwise → New client registered with its on-screen view (server/clients.ts) → Snapshot of everything sent on connect, including the sidebar layout, then per-chat transcript only to windows showing it → A window reports live:false only when unseen (minimized, another Space, fully covered) and then its chat streams are gated off and other updates held latest-only; a visible-but-unfocused window stays live; on wake it catches up in one redraw plus per-chat missed content → Each incoming message schema-checked and handed to server/handlers/index.ts
- **Attachment upload and serve-back:** Base64 upload received over HTTP or socket → Persisted under config uploads dir with sanitized unique path (server/uploads.ts) → Transcript carries small /uploads/<file> URL instead of base64 → Served back via serveUpload with MIME from server/mime.ts → Stale files reaped by scripts/uploads-sweep.ts
- **Passwords and ghostly:** Vault (server/vault.ts) asks the ghostly command (server/ghostly.ts) at launch, on Refresh, on page open (once a minute at most) and every 15 min → items go to SecretStore (server/secrets.ts), in memory beside its own secrets.json → the page gets names and where each is kept, never a value → save, Forget and Move go back through Vault, the secret on stdin
- **Mutating request gate:** Route or socket handler asks server/auth.ts for originAllowed and tokenMatches → GETs stay open; POSTs need token plus permitted origin → Token file written 0600 and removed on close (scripts/auth.ts, scripts/lib/server.ts) → Failed checks rejected before any store or handler runs
- **Agent self-compaction:** every prompt carries a usage line (contextLine in server/selfCompaction.ts, via catchUp in server/handoff.ts), repeated mid-turn on PostToolBatch, with a notice near 500k and at 4/5 of the window; the agent decides → it calls mcp__ruri__compact or {"do":"compact"} on /talk/<id> (server/routes.ts, server/handlers/talk.ts): the note is stored, the turn not stopped → at that turn's result (server/chats.ts) selfCompactDue returns the note; carryLetter runs before talkTurnEnded → the continuation is queued at the head (server/queue.ts), compactChannel runs, its drain sends it into the fresh session → it opens with CARRY_ON (continuePrompt), recognised by that text plus handoffNote() in shared/protocol.ts; a carried continuation keeps its letter id with carried:true

## Key files

- server/server.ts — assembles stores, managers, timers, routes and socket on one port
- server/context.ts — the shared ServerContext object every part takes first
- server/modelCatalog.ts — model list, highest-version picks and the default reasoning effort
- server/routes.ts — HTTP side: health, uploads, static UI, origin/token-gated mutations
- server/socket.ts — WebSocket upgrade gate, snapshot on connect, schema-checked dispatch
- server/clients.ts — per-window views and targeted transcript/status broadcast
- server/auth.ts — origin and token checks for HTTP and socket
- server/secrets.ts — secret store; hands out only names and placeholders
- server/vault.ts — Vault: when ghostly is asked, its state for the page, and save / remove / move through it
- server/ghostly.ts — runs the ghostly command (RURI_GHOSTLY, PATH or ~/.local/bin): one at a time, timed out, secrets on stdin

## Rules and traps

- Never put domain logic in routes/socket — dispatch to server/handlers/index.ts; what each message does lives per-domain.
- Never weaken the gate: mutating HTTP needs token + permitted origin, socket needs both at upgrade; GETs stay open.
- The port is identity (origin for stored prefs) — claim it via server/port.ts, never silently fall to an ephemeral port.
- Transcript fan-out is scoped: live per-chat events go only to windows showing that chat (server/clients.ts); the snapshot and the projects page carry only Home's and the leads' tails (ProjectStore.leadIds) — a team's members are never sent whole, though a window (or a test script) may still view one by id
- Persist carefully: uploads as URL-backed files, never inline base64 in transcript events; every store fixes its config folder when it is made, so a put-off write lands where the store was read — and bun test preloads a folder of its own (bunfig.toml, scripts/test-config.ts), so a test run never touches ~/.config/ruri.
- Secrets must never enter model context, logs, or transcripts — only names/placeholders leave server/secrets.ts and server/vault.ts.
- Ghostly items are held in memory only; never write them to the secrets file, logs or transcripts. Tests and scripts keep RURI_GHOSTLY="" (scripts/test-config.ts, scripts/lib/server.ts) or they reach the user's real vault.

## What it talks to

- Protocol — every socket message is typed/validated in shared/protocol.ts and shared/clientSchema.ts
- Chat runs and queue — handlers under server/handlers/* implement prompt/turn/rewind semantics on top of ServerContext
- Agent harnesses — session managers and usage/resource sources (agents, sessions, providers) plug into server.ts assembly
- Bridge — HTTP routes proxy bridge pictures/calls via bridge state, not directly; native-app driving needs X11 plus AT-SPI and must refuse on Wayland
- Desktop shell — single-instance lock and served UI origin depend on the claimed port
- Terminals, agents and integrations — project hooks wire types live in shared/protocol.ts and are validated in shared/clientSchema.ts; the hook logic itself lives in server/projectHooks.ts and server/handlers/hooks.ts
- Settings — the default model and reasoning effort chosen in Settings reach every new chat through server/handlers/settings.ts
