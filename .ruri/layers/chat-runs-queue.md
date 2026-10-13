# ruri — Chat runs and queue

One layer of ruri's stack, owning `server/chats.ts, server/channel.ts, server/dispatch.ts, server/events.ts, server/queue.ts, server/turns.ts, server/retry.ts, server/blocked.ts, server/paragraphs.ts, server/drafts.ts, server/commands.ts, server/homelog.ts, server/handlers/prompts.ts, server/handlers/rewind.ts, server/handlers/transcript.ts, server/handlers/talk.ts, server/talk.ts, scripts/rewind-git.ts, scripts/rewind.ts, scripts/smoke.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer chat-runs-queue` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer chat-runs-queue add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer runs live chat turns: prompt dispatch, app-side queue, per-channel turn progress, and transcript delivery over the socket. It is built around dispatch.ts handing prompts to harness sessions, queue.ts holding what waits, turns.ts tracking the turn in flight, and events.ts recording each transcript event. Newcomers must grasp that a prompt is written, checkpointed, titled, and queued or run, and a finished turn drains the queue or retries.

## Where to change what

- **sending a prompt:** server/dispatch.ts, server/handlers/prompts.ts, server/queue.ts
- **prompt queue (order, edit, rearrange, stop/hold):** server/queue.ts, server/handlers/prompts.ts, server/dispatch.ts
- **turn progress and context gauge:** server/turns.ts, server/channel.ts
- **transcript delivery and history:** server/handlers/transcript.ts, server/events.ts
- **rewind and fork:** server/handlers/rewind.ts, server/turns.ts, scripts/rewind.ts, scripts/rewind-git.ts
- **agent-to-agent talk:** server/talk.ts, server/handlers/talk.ts
- **slash commands in prompts:** server/commands.ts, server/dispatch.ts
- **retry and dropped turns:** server/retry.ts, server/dispatch.ts
- **chat session wiring:** server/chats.ts, server/channel.ts
- **streaming paragraphs:** server/paragraphs.ts
- **drafts:** server/drafts.ts
- **blocked and home log:** server/blocked.ts, server/homelog.ts

## How it works

- **prompt to running turn:** handlers/prompts.ts accepts send, split, stop, or queue rearrange → dispatch.ts writes prompt to transcript, checkpoints, titles, splits slash commands → queue.ts holds it if channel busy, visible or silent entry → chats.ts hands it to the chat session with briefing and tools → turns.ts tracks progress and context during the run → events.ts records, redacts, archives, and pushes each event → finished turn triggers drainQueue and maybeRetry in dispatch.ts
- **rewind:** handlers/rewind.ts receives rewind to just before a prompt ran → restoreContext resets context gauge to the kept exchange → files and repo restored via native fork or checkpoint plus brief → transcript truncated and prompt returned to composer
- **talk message:** handlers/talk.ts checks seats and TalkPolicy via talk.ts rules → message delivered into other chat as a prompt with from marking → it queues behind that chat's work like a user prompt → at turn end the last word is clipped and carried back to sender

## Key files

- server/dispatch.ts — prompt way out, queue drain, retry, stop, cut-in, /compact
- server/queue.ts — app-side waiting prompts, visible and silent entries, reslot and combine
- server/turns.ts — turn in flight per channel, progress clock, context window
- server/events.ts — transcript event intake, redact, archive, push, small-model follow-ups
- server/chats.ts — chat session manager wiring sessions to server
- server/channel.ts — channel busy, running, and project ownership
- server/handlers/prompts.ts — composer messages: send, split, queue, stop, drafts, cards
- server/talk.ts — agent-to-agent rules, handles, wording, in-flight book, tools
- server/handlers/rewind.ts — rewind and fork across harnesses
- server/handlers/transcript.ts — transcript tail, history, subscriptions, turn removal

## Rules and traps

- Split sub-prompts ride silent under the original prompt; split only when reaching the front so earlier commands run first.
- An entry being rewritten keeps queue place but nothing sends it until the rewrite returns.
- Quoted slash commands ('/compact', "/compact", `/compact`) stay plain text and go to the model untouched.
- Only existing commands count: ruri's own, harness prompt commands, installed skills; /tmp alone on a line is a path.
- Turn progress lives in turns.ts not the window so the clock survives reload; broadcast deltas throttled to one message a second.
- Rewind must restore files, branch, transcript, composer prompt, and context gauge to the kept exchange, not the tip.

## What it talks to

- Protocol — every socket message and transcript event is typed in shared/protocol.ts
- Agent harnesses — dispatch and chats hand prompts to sessions and get turns, checkpoints, and forks back
- Projects, memory and history — checkpoints, compaction, handoff briefs, notes, and archive feed prompts, rewind, and events
- Server runtime and transport — socket routing, clients push, uploads, and stores carry transcript and queue messages
- Conversation — composer sends and queue/transcript handlers drive what the chat pane shows
