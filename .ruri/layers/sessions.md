# ruri — Sessions

One layer of ruri's stack, owning `server/sessions.ts, server/manager.ts, server/providers.ts, server/chats.ts, server/queue.ts, server/events.ts, server/channel.ts, server/turns.ts, server/agents.ts, server/talk.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer sessions` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer sessions add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer runs Home and project chats, connecting provider sessions to prompts, queues, transcript events, and agent activity. Its central idea is the channel: Home or one session has its own state and settings while a project session inherits its parent project's defaults.

## Where to change what

- **Session lifecycle and prompts:** server/sessions.ts, server/chats.ts
- **Provider and model choices:** server/providers.ts, server/sessions.ts
- **Prompt queue:** server/queue.ts, server/chats.ts
- **Transcript events and turn follow-up:** server/events.ts, server/chats.ts
- **Home agent:** server/manager.ts, server/chats.ts
- **Channel settings and ownership:** server/channel.ts
- **Turn progress and context:** server/turns.ts
- **Subagent logs:** server/agents.ts
- **Messages between chats:** server/talk.ts, server/queue.ts

## How it works

- **Chat turn:** server/chats.ts wires a Home or project chat to its session → server/sessions.ts runs the provider session and emits events → server/events.ts records and pushes transcript events → server/chats.ts handles finished-turn work, including queue and retry
- **Message between chats:** server/talk.ts checks whether the sender may message the destination → The message enters the destination chat as a marked prompt → server/queue.ts holds it behind any running turn → server/talk.ts returns the turn's last word by wait or later delivery, unless no answer was requested

## Key files

- server/sessions.ts — runs provider-backed sessions and prompts
- server/chats.ts — wires chat sessions to server events, queues, briefings, and tools
- server/events.ts — redacts, archives, and pushes transcript events and starts finished-turn follow-up
- server/queue.ts — holds visible and silent prompts until a running turn finishes
- server/providers.ts — loads providers and presents model choices
- server/channel.ts — resolves a channel's effective settings and owning project
- server/manager.ts — defines the Home agent and its app-management requests
- server/talk.ts — routes messages and answers between chats
- server/turns.ts — tracks and broadcasts turn progress and context usage
- server/agents.ts — stores capped, per-agent subagent logs

## Rules and traps

- A channel ID is Home or a session ID; project sessions inherit their parent's defaults but can override model, effort, and permission mode.
- Visible queued prompts are editable in the UI; silent entries are sub-prompts under an already visible prompt.
- A queued split prompt is split only when it reaches the front, after prompts ahead of it have run.
- A chat-to-chat message queues like a user prompt; a waiting sender may need to resume a wait after its current wait slice ends.
- Subagent logs are separate from the parent chat's agent card, capped at 1,500 events, and written on a debounce.

## What it talks to

- Shared protocol — supplies session, event, queue, and turn types
- Server transport — dispatches actions and drains or retries queued work
- Project knowledge — supplies briefings and receives event-driven memory and sheet updates
- Agent runtimes — provide the sessions and subagent activity managed here
- Client state — receives pushed events, queue state, and turn progress
