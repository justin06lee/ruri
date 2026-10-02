# ruri — Server transport

One layer of ruri's stack, owning `server/index.ts, server/server.ts, server/socket.ts, server/routes.ts, server/dispatch.ts, server/handlers/, server/desktopServer.ts, server/hostLink.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer server-transport` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer server-transport add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer starts the HTTP and WebSocket services on one port and routes client requests to domain handlers. A shared server context holds the live state and services those handlers use. Follow a message from the socket or HTTP route into its handler; prompt execution then continues through dispatch.

## Where to change what

- **Server startup and its process under the app:** server/server.ts, server/desktopServer.ts, server/hostLink.ts, server/index.ts
- **HTTP endpoints:** server/routes.ts
- **WebSocket connections and messages:** server/socket.ts, server/handlers/index.ts, server/handlers/types.ts
- **Prompts, queues, and turn control:** server/handlers/prompts.ts, server/dispatch.ts
- **Projects and chats:** server/handlers/projects.ts
- **Agent messaging:** server/handlers/talk.ts
- **Rewind and fork:** server/handlers/rewind.ts
- **Component library:** server/handlers/components.ts
- **Settings and integrations:** server/handlers/settings.ts, server/handlers/integrations.ts
- **Transcript loading:** server/handlers/transcript.ts
- **User started agents:** server/handlers/crew.ts
- **Tracker and ideas boards:** server/handlers/boards.ts

## How it works

- **Server startup:** the desktop shell forks server/desktopServer.ts (or server/index.ts runs standalone) → server/server.ts assembles live state, managers, hosts, and timers → server/routes.ts and server/socket.ts serve HTTP and WebSocket traffic on one port
- **WebSocket message:** server/socket.ts checks origin and token at upgrade → It sends a state snapshot on connection → It validates each incoming message against the client schema → server/handlers/index.ts hands the message to its domain handler
- **Prompt and turn:** server/handlers/prompts.ts receives a prompt or queue action → server/dispatch.ts records and prepares the prompt, then hands it to the chat session → When a turn ends, server/dispatch.ts can advance the queue or retry a dropped turn

## Key files

- server/server.ts — assembles the server context and services; under the app, server/desktopServer.ts runs it in a process of its own and server/hostLink.ts stands in for the shell's services
- server/socket.ts — authenticates WebSocket connections, sends snapshots, and validates messages
- server/routes.ts — serves HTTP endpoints and the built UI
- server/handlers/index.ts — routes validated socket messages to domain handlers
- server/dispatch.ts — prepares prompts and handles queue progress after turns
- server/handlers/prompts.ts — handles composer, queue, stop, draft, and answer messages
- server/handlers/projects.ts — handles project and session changes
- server/handlers/talk.ts — handles messages between agents
- server/handlers/components.ts — connects component library actions to the app
- server/handlers/rewind.ts — handles rewind and fork requests

## Rules and traps

- HTTP requests that change state must pass origin and token checks.
- WebSocket upgrades require the page origin and token; incoming messages must pass schema validation before dispatch.
- The initial socket snapshot carries only a transcript tail; transcript_get supplies the rest.
- User started crew agents have their own session manager, separate from chat sessions.
- Integration changes take effect when a harness next starts; affected warm sessions retire as they become idle.
- The server never imports Electron: under the app it runs in a utility process and reaches the shell's services only through server/hostLink.ts.

## What it talks to

- Client state — receives socket snapshots and updates, and sends client messages
- Shared protocol — supplies message types and the client message schema
- Sessions — dispatch hands prompts to chat sessions and advances work after turns
- Project knowledge — project and component handlers update sheets, memory, and library records
- Server services — routes and handlers use authentication, uploads, integrations, settings, and persistence
