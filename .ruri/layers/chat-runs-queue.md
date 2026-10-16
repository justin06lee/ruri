# ruri — Chat runs and queue

One layer of ruri's stack, owning `server/chats.ts, server/channel.ts, server/dispatch.ts, server/events.ts, server/queue.ts, server/turns.ts, server/retry.ts, server/blocked.ts, server/paragraphs.ts, server/drafts.ts, server/commands.ts, server/homelog.ts, server/handlers/prompts.ts, server/handlers/rewind.ts, server/handlers/transcript.ts, server/handlers/talk.ts, server/talk.ts, scripts/rewind-git.ts, scripts/rewind.ts, scripts/smoke.ts, server/team.ts, server/handlers/team.ts, scripts/team.ts, scripts/agent-compact.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer chat-runs-queue` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer chat-runs-queue add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer runs live chat turns: prompt dispatch, the app-side queue, turn progress and transcript delivery over the socket, and the team and talk built on them. A prompt is written, checkpointed, titled, and queued or run; every agent sees its context use and compacts itself past half its window through a handoff-note continuation queued at the head; a finished turn drains the queue or retries.

## Where to change what

- **sending a prompt (send-now waits behind another agent's job):** server/dispatch.ts, server/handlers/prompts.ts, server/queue.ts
- **prompt queue (order, edit, rearrange, stop/hold):** server/queue.ts, server/handlers/prompts.ts, server/dispatch.ts
- **turn progress and context gauge:** server/turns.ts, server/channel.ts
- **transcript delivery and history:** server/handlers/transcript.ts, server/events.ts
- **self-compaction (context line, compact/context tools, handoff-note continuation):** server/chats.ts, server/dispatch.ts, server/queue.ts, server/handlers/talk.ts
- **rewind:** server/handlers/rewind.ts, server/turns.ts, scripts/rewind.ts, scripts/rewind-git.ts
- **agent-to-agent talk and project teams (lead, liaison, members, the leads' team tools and what a lead is refused, team message liaison and freeLayers):** server/talk.ts, server/handlers/talk.ts, server/team.ts, server/handlers/team.ts
- **slash commands in prompts:** server/commands.ts, server/dispatch.ts
- **retry and dropped turns:** server/retry.ts, server/dispatch.ts

## How it works

- **prompt to running turn:** handlers/prompts.ts accepts send, split, stop, or queue rearrange → dispatch.ts writes prompt to transcript, checkpoints, titles, splits slash commands → queue.ts holds it if channel busy, visible or silent entry → chats.ts hands it to the chat session with briefing and tools → turns.ts tracks progress and context during the run → events.ts records, redacts, archives, and pushes each event → finished turn triggers drainQueue and maybeRetry in dispatch.ts
- **self-compact mid-job:** each prompt carries a usage line (used / window / self-compact point); any agent can check with the context tool → past its point the agent writes a handoff note and calls the compact tool, which only stores the note and tells it to end its turn → at that turn's result in chats.ts, an ok result queues the continuation at the head and runs the compaction, whose drain sends it into the fresh session → a stopped turn drops the note and settles letters as today; a failed turn keeps the note for the next ok turn → if the compacting turn was answering a letter, its letter is carried to the continuation so its last words still answer whoever waits
- **rewind:** handlers/rewind.ts receives rewind to just before a prompt ran → restoreContext resets context gauge to the kept exchange → files and repo restored via native fork or checkpoint plus brief → transcript truncated and prompt returned to composer
- **talk message:** handlers/talk.ts finds the seat — the sender's own team, or another project's door: its liaison, made on first outside contact — and checks TalkPolicy (mayMessage) → delivered as a prompt marked whose (only RURI_TEAM_MAX makes a sleeping member waitForSlot) → queues behind that chat's work, or cuts in → at turn end its last word goes back to the sender, unless the turn handed the job on (Pending.for): then the turn the last answer starts (LetterFrom.owes) answers; ask_project goes to another project's liaison → sending a letter refreshes an open team page for both ends so liaison letters show live

## Key files

- server/dispatch.ts — prompt way out, queue drain, retry, stop, cut-in, /compact
- server/queue.ts — app-side waiting prompts, visible and silent entries, reslot and combine
- server/turns.ts — turn in flight per channel, progress clock, context window
- server/events.ts — transcript event intake, redact, archive, push, small-model follow-ups
- server/chats.ts — chat session manager wiring sessions to server
- server/team.ts — the team: the optional RURI_TEAM_MAX cap, the lead's, liaison's and members' words, what a lead is refused (HEAD_REFUSED, refusal) and told mid-turn (headWatch), the leads' tools
- server/handlers/team.ts — team message with roster, liaison and freeLayers, headOf, team page actOn (stop, compact, refresh, restart, retire)
- server/handlers/prompts.ts — composer messages: send, split, queue, stop, drafts, cards
- server/talk.ts — agent-to-agent rules, handles, wording, in-flight book, tools
- server/handlers/rewind.ts — rewind across harnesses (a native fork back to the kept exchange, a brief, or a fresh start)

## Rules and traps

- Split sub-prompts ride silent under the original prompt; split only when reaching the front so earlier commands run first.
- An entry being rewritten keeps queue place but nothing sends it until the rewrite returns.
- Only existing commands count — ruri's own, harness prompt commands, installed skills; quoted ones ('/compact', "/compact", `/compact`) and /tmp alone on a line stay plain text to the model.
- RURI_TEAM_MAX, when set, caps members at work; one holding on an answer (talk.awaiting) doesn't count, or mutual waits hold every slot for good. Only waking a sleeping member is gated.
- Turn progress lives in turns.ts not the window so the clock survives reload; broadcast deltas throttled to one message a second.
- Rewind restores files, branch, transcript, composer prompt and context gauge to the kept exchange, not the tip.
- A letter is answered by the last words of the turn that finishes the job: owedLetter() is what a turn owes (its own letter, a carried one, or via an answer's owes); talkTurnEnded settles it only when nothing sent for it is out (TalkBook.outstanding). An answer that leaves the book any other way — a wait in another job, taken out of the queue — goes through answerOnward. Self-compaction marks the carry (carryLetter) at the turn's result, before talkTurnEnded.
- The liaison (session.liaison) is never lead (leadOf skips it) nor a member: code taking 'every non-lead session' as the team must skip it (membersOf, isMember). unattended() covers members and the liaison: held lines let go for letters; the user's 'send now' waits behind a turn on another agent's job (onAJob).

## What it talks to

- Protocol — every socket message and transcript event is typed in shared/protocol.ts
- Agent harnesses — dispatch and chats hand prompts to sessions and get turns, checkpoints, and forks back
- Projects, memory and history — checkpoints, compaction, handoff briefs, notes, and archive feed prompts, rewind, and events
- Server runtime and transport — socket routing, clients push, uploads, and stores carry transcript and queue messages
- Conversation — composer sends and queue/transcript handlers drive what the chat pane shows
