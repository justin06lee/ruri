# ruri — Server runtime and transport

One layer of ruri's stack, owning `server/, scripts/auth.ts, scripts/lib/server.ts, scripts/port.ts, scripts/uploads-sweep.ts, shared/protocol.ts, shared/clientSchema.ts, bunfig.toml, scripts/test-config.ts, shared/modelLine.ts, shared/sidebar.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer server-runtime-transport` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer server-runtime-transport add|set|drop <section> …`. Where it and the code disagree, the code is right.

The Node HTTP + WebSocket transport everything rides on: one port serving the UI, uploads and the socket every window talks over, assembled around a shared ServerContext (server/context.ts) in server/server.ts. It moves bytes and enforces origin/token gates; domain logic lives in handlers. It also carries each agent's context line and self-compaction (the agent decides; ruri compacts only at the top of the window), chat-to-chat messaging (talk), the sidebar layout the phone mirrors, the model catalog, drafts shared across devices, the accounts each project runs its harnesses on and their usage limits, and the secret store with ghostly's items in memory. A window sleeps only when it cannot be seen at all.

## Where to change what

- **Server assembly and startup:** server/server.ts, server/context.ts, server/index.ts
- **HTTP routing (health, uploads, static UI):** server/routes.ts, server/mime.ts, server/readable.ts
- **WebSocket server and client fan-out:** server/socket.ts, server/clients.ts, server/context.ts, shared/protocol.ts
- **Auth gate (origin + token):** server/auth.ts, server/socket.ts, server/routes.ts
- **Prompt attachment uploads:** server/uploads.ts, server/mime.ts, scripts/uploads-sweep.ts
- **Chats messaging chats over HTTP (POST /talk/<chat>; the rest is the chat-runs-queue layer's):** server/routes.ts, server/handlers/talk.ts
- **Unsent prompt draft sync across devices:** server/sharing.ts, server/phoneChat.ts, server/clients.ts, shared/protocol.ts
- **Secrets vault and placeholders:** server/secrets.ts, server/vault.ts, server/atomic.ts
- **Ghostly vault: the password source, and finding or setting one up on the tailnet (Passwords page):** server/ghostly.ts, server/vault.ts, server/vaultFinder.ts, server/vaultSetup.ts, server/tailnet.ts, server/ssh.ts
- **Accounts and usage per account (Settings → Accounts, the chip, the phone's Limits card and account menu):** server/accounts.ts, server/accountStatus.ts, server/handlers/accounts.ts, server/usage.ts, server/status.ts

## How it works

- **Window connects and stays live:** one claimed port (server/port.ts) serves HTTP (server/routes.ts) and the socket (server/socket.ts) → upgrade checked for origin and token (server/auth.ts) → client registered with its view (server/clients.ts) → snapshot on connect, then per-chat transcript only to windows showing it → a window unseen (live:false; a visible unfocused one stays live) has chat streams gated and catches up on wake → each message schema-checked, handed to server/handlers/index.ts
- **Attachment upload and serve-back:** Base64 upload received over HTTP or socket → Persisted under config uploads dir with sanitized unique path (server/uploads.ts) → Transcript carries small /uploads/<file> URL instead of base64 → Served back via serveUpload with MIME from server/mime.ts → Stale files reaped by scripts/uploads-sweep.ts
- **Passwords and ghostly:** Vault (server/vault.ts) asks the ghostly command (server/ghostly.ts) at launch, on Refresh, on page open (once a minute at most) and every 15 min → items go to SecretStore (server/secrets.ts), in memory beside its own secrets.json → the page gets names and where each is kept, never a value → save, Forget and Move go back through Vault, the secret on stdin
- **Mutating request gate:** Route or socket handler asks server/auth.ts for originAllowed and tokenMatches → GETs stay open; POSTs need token plus permitted origin → Token file written 0600 and removed on close (scripts/auth.ts, scripts/lib/server.ts) → Failed checks rejected before any store or handler runs
- **Agent self-compaction:** every prompt carries a usage line (contextLine, server/selfCompaction.ts), repeated mid-turn, with a notice near 500k and at 4/5 of the window; the agent decides → it calls mcp__ruri__compact or {"do":"compact"} on /talk/<id>: the note is stored, the turn not stopped → at that turn's result selfCompactDue returns the note; carryLetter runs before talkTurnEnded → the continuation is queued at the head, compactChannel runs, its drain sends it into the fresh session → it opens with CARRY_ON, recognised by that text plus handoffNote(); a carried one keeps its letter id

## Key files

- server/server.ts — assembles stores, managers, timers, routes and socket on one port
- server/context.ts — the shared ServerContext object every part takes first
- server/modelCatalog.ts — model list, highest-version picks and the default reasoning effort
- server/routes.ts — HTTP side: health, uploads, static UI, origin/token-gated mutations
- server/socket.ts — WebSocket upgrade gate, snapshot on connect, schema-checked dispatch
- server/clients.ts — per-window views and targeted transcript/status broadcast
- server/auth.ts — origin and token checks for HTTP and socket
- server/sharing.ts — unsent-prompt drafts shared between devices and windows
- server/phoneChat.ts — phone-side chat state, including the synced draft
- server/accounts.ts — every account (the three built in + accounts.json), a project's pick per harness, the env each spawn gets, transcripts and rollouts carried between homes; accountStatus.ts says who each is signed in as

## Rules and traps

- Never put domain logic in routes/socket — dispatch to server/handlers/index.ts; what each message does lives per-domain.
- Never weaken the gate: mutating HTTP needs token + permitted origin, socket needs both at upgrade; GETs stay open.
- The port is identity (origin for stored prefs) — claim it via server/port.ts, never silently fall to an ephemeral port.
- Transcript fan-out is scoped: live per-chat events go only to windows showing that chat (server/clients.ts); the snapshot and the projects page carry only Home's and the leads' tails (ProjectStore.leadIds) — a team's members are never sent whole, though a window (or a test script) may still view one by id
- Persist carefully: uploads as URL-backed files, never inline base64 in transcript events; every store fixes its config folder when it is made, so a put-off write lands where the store was read — and bun test preloads a folder, account homes and no claude/codex CLI of its own (scripts/test-config.ts), so a test never touches ~/.config/ruri or the user's sign-ins.
- Synced drafts carry only text; attachments stay on the device they were added on. A project's account is read only through accountOf/accountFor (server/accounts.ts): picks are accounts.{claude,codex}, the old account field is Claude's.
- Secrets never enter model context, logs or transcripts (only names leave secrets.ts and vault.ts); ghostly's are held in memory, never on disk. Setup-script tests need a sandbox PATH and a refusing tailscale stand-in.

## What it talks to

- Protocol — every socket message is typed/validated in shared/protocol.ts and shared/clientSchema.ts
- Chat runs and queue — handlers under server/handlers/* implement prompt/turn/rewind semantics on top of ServerContext
- Agent harnesses — session managers and usage/resource sources (agents, sessions, providers) plug into server.ts assembly
- Bridge — HTTP routes proxy bridge pictures/calls via bridge state, not directly; native-app driving needs X11 plus AT-SPI and must refuse on Wayland
- Desktop shell — single-instance lock and served UI origin depend on the claimed port
- Phone app — drafts and usage limits travel to the iOS app over the socket, typed in shared/protocol.ts
- Terminals, agents and integrations — project hooks wire types live in shared/protocol.ts and are validated in shared/clientSchema.ts; the hook logic itself lives in server/projectHooks.ts and server/handlers/hooks.ts
