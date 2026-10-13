# ruri — Server runtime and transport

One layer of ruri's stack, owning `server/, scripts/auth.ts, scripts/lib/server.ts, scripts/port.ts, scripts/uploads-sweep.ts, shared/protocol.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer server-runtime-transport` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer server-runtime-transport add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer is the Node HTTP + WebSocket transport everything else rides on: one port serving the UI, uploads, and the socket every window talks over. It is built around a single shared ServerContext (server/context.ts) assembled once in server/server.ts and handed to routes, socket, and handlers. A newcomer must grasp: this layer moves bytes and enforces origin/token gates — domain logic lives in handlers and other layers, not here — and a window only sleeps when it cannot be seen at all (minimized, on another Space, or fully covered); a visible-but-unfocused window stays live and keeps receiving streams.

## Where to change what

- **Server assembly and startup:** server/server.ts, server/context.ts, server/index.ts
- **HTTP routing (health, uploads, static UI):** server/routes.ts, server/mime.ts, server/readable.ts
- **WebSocket server and client fan-out:** server/socket.ts, server/clients.ts, server/context.ts, shared/protocol.ts
- **Auth gate (origin + token):** server/auth.ts, server/socket.ts, server/routes.ts
- **Prompt attachment uploads:** server/uploads.ts, server/mime.ts, scripts/uploads-sweep.ts
- **Secrets vault and placeholders:** server/secrets.ts, server/atomic.ts
- **Usage and machine meters:** server/usage.ts, server/gauges.ts, server/resources.ts
- **Port claim and orphan retire:** server/port.ts, scripts/port.ts, scripts/lib/server.ts
- **Handler dispatch entry:** server/handlers/index.ts, server/handlers/types.ts, server/context.ts
- **Project memory, sheets and auto-compact:** server/archive.ts, shared/protocol.ts
- **Bridge proxy, hidden browser and terminal pty:** server/bridge.ts, server/terminal.ts, server/socket.ts
- **Harness updater:** server/updater.ts, server/updater.test.ts

## How it works

- **Window connects and stays live:** HTTP server from server/routes.ts and socket from server/socket.ts listen on one claimed port (server/port.ts) → Socket upgrade checked for page origin and token (server/auth.ts), rejected otherwise → New client registered with its on-screen view (server/clients.ts) → Snapshot of everything sent on connect, then per-chat transcript only to windows showing it → A window reports live:false only when unseen (minimized, another Space, fully covered) and then its chat streams are gated off and other updates held latest-only; a visible-but-unfocused window stays live; on wake it catches up in one redraw plus per-chat missed content → Each incoming message schema-checked and handed to server/handlers/index.ts
- **Attachment upload and serve-back:** Base64 upload received over HTTP or socket → Persisted under config uploads dir with sanitized unique path (server/uploads.ts) → Transcript carries small /uploads/<file> URL instead of base64 → Served back via serveUpload with MIME from server/mime.ts → Stale files reaped by scripts/uploads-sweep.ts
- **Mutating request gate:** Route or socket handler asks server/auth.ts for originAllowed and tokenMatches → GETs stay open; POSTs need token plus permitted origin → Token file written 0600 and removed on close (scripts/auth.ts, scripts/lib/server.ts) → Failed checks rejected before any store or handler runs

## Key files

- server/server.ts — assembles stores, managers, timers, routes and socket on one port
- server/context.ts — the shared ServerContext object every part takes first
- server/routes.ts — HTTP side: health, uploads, static UI, origin/token-gated mutations
- server/socket.ts — WebSocket upgrade gate, snapshot on connect, schema-checked dispatch
- server/clients.ts — per-window views and targeted transcript/status broadcast
- server/auth.ts — origin and token checks for HTTP and socket
- server/uploads.ts — attachment persist, model payload, serve and sweep
- server/archive.ts — turn archive with stable exchange numbers, memory fold and grounding
- server/bridge.ts — HTTP proxy to bridge state for hidden-browser and native-app calls
- server/terminal.ts — real pty backing terminal tabs

## Rules and traps

- Never put domain logic in routes/socket — dispatch to server/handlers/index.ts; what each message does lives per-domain.
- Never weaken the gate: mutating HTTP needs token + permitted origin, socket needs both at upgrade; GETs stay open.
- The port is identity (origin for stored prefs) — claim it via server/port.ts, never silently fall to an ephemeral port.
- Transcript fan-out is scoped: live per-chat events go only to windows showing that chat (server/clients.ts).
- Uploads must persist as URL-backed files, never inline megabytes of base64 in transcript events.
- Secrets must never enter model context, logs, or transcripts — only names/placeholders leave server/secrets.ts.

## What it talks to

- Protocol — every socket message is typed/validated in shared/protocol.ts and shared/clientSchema.ts
- Chat runs and queue — handlers under server/handlers/* implement prompt/turn/rewind semantics on top of ServerContext
- Agent harnesses — session managers and usage/resource sources (agents, sessions, providers) plug into server.ts assembly
- Bridge — HTTP routes proxy bridge pictures/calls via bridge state, not directly; native-app driving needs X11 plus AT-SPI and must refuse on Wayland
- Desktop shell — single-instance lock and served UI origin depend on the claimed port
