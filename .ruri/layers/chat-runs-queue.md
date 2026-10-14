# ruri — Chat runs and queue

One layer of ruri's stack, owning `server/chats.ts, server/channel.ts, server/dispatch.ts, server/events.ts, server/queue.ts, server/turns.ts, server/retry.ts, server/blocked.ts, server/paragraphs.ts, server/drafts.ts, server/commands.ts, server/homelog.ts, server/handlers/prompts.ts, server/handlers/rewind.ts, server/handlers/transcript.ts, server/handlers/talk.ts, server/talk.ts, scripts/rewind-git.ts, scripts/rewind.ts, scripts/smoke.ts, server/team.ts, server/handlers/team.ts, scripts/team.ts, scripts/agent-compact.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer chat-runs-queue` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer chat-runs-queue add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer runs live chat turns: prompt dispatch, app-side queue, per-channel turn progress, and transcript delivery over the socket. It is built around dispatch.ts handing prompts to harness sessions, queue.ts holding what waits, turns.ts tracking the turn in flight, and events.ts recording each transcript event. Newcomers must grasp that a prompt is written, checkpointed, titled, and queued or run, that every agent sees its context usage and compacts itself past half its window via a handoff-note continuation queued at the head, and that a finished turn drains the queue or retries.

## Where to change what

- **sending a prompt:** server/dispatch.ts, server/handlers/prompts.ts, server/queue.ts
- **prompt queue (order, edit, rearrange, stop/hold):** server/queue.ts, server/handlers/prompts.ts, server/dispatch.ts
- **turn progress and context gauge:** server/turns.ts, server/channel.ts
- **transcript delivery and history:** server/handlers/transcript.ts, server/events.ts
- **self-compaction (context line, compact/context tools, handoff-note continuation):** server/chats.ts, server/dispatch.ts, server/queue.ts, server/handlers/talk.ts
- **rewind:** server/handlers/rewind.ts, server/turns.ts, scripts/rewind.ts, scripts/rewind-git.ts
- **agent-to-agent talk and project teams (lead, liaison, members, the leads' team tools, the optional RURI_TEAM_MAX cap):** server/talk.ts, server/handlers/talk.ts, server/team.ts, server/handlers/team.ts
- **slash commands in prompts:** server/commands.ts, server/dispatch.ts
- **retry and dropped turns:** server/retry.ts, server/dispatch.ts

## How it works

- **prompt to running turn:** handlers/prompts.ts accepts send, split, stop, or queue rearrange → dispatch.ts writes prompt to transcript, checkpoints, titles, splits slash commands → queue.ts holds it if channel busy, visible or silent entry → chats.ts hands it to the chat session with briefing and tools → turns.ts tracks progress and context during the run → events.ts records, redacts, archives, and pushes each event → finished turn triggers drainQueue and maybeRetry in dispatch.ts
- **self-compact mid-job:** each prompt carries a usage line (used / window / self-compact point); any agent can check with the context tool → past its point the agent writes a handoff note and calls the compact tool, which only stores the note and tells it to end its turn → at that turn's result in chats.ts, an ok result queues the continuation at the head and runs the compaction, whose drain sends it into the fresh session → a stopped turn drops the note and settles letters as today; a failed turn keeps the note for the next ok turn → if the compacting turn was answering a letter, its letter is carried to the continuation so its last words still answer whoever waits
- **rewind:** handlers/rewind.ts receives rewind to just before a prompt ran → restoreContext resets context gauge to the kept exchange → files and repo restored via native fork or checkpoint plus brief → transcript truncated and prompt returned to composer
- **talk message:** handlers/talk.ts finds the seat — the sender's own team, or another project's door: its liaison, made on first outside contact — and checks TalkPolicy (mayMessage) → delivered as a prompt marked whose (only RURI_TEAM_MAX makes a sleeping member waitForSlot) → queues behind that chat's work, or cuts in → at turn end its last word goes back to the sender, unless the turn handed the job on (Pending.for): then the turn the last answer starts (LetterFrom.owes) answers; ask_project goes to another project's liaison

## Key files

- server/dispatch.ts — prompt way out, queue drain, retry, stop, cut-in, /compact
- server/queue.ts — app-side waiting prompts, visible and silent entries, reslot and combine
- server/turns.ts — turn in flight per channel, progress clock, context window
- server/events.ts — transcript event intake, redact, archive, push, small-model follow-ups
- server/chats.ts — chat session manager wiring sessions to server
- server/team.ts — the team: the optional RURI_TEAM_MAX cap, the lead's, liaison's and members' words, disallowedFor, the leads' tools; server/handlers/team.ts has headOf, the roster, the team page and actOn (stop, compact, refresh, restart, retire)
- server/handlers/prompts.ts — composer messages: send, split, queue, stop, drafts, cards
- server/talk.ts — agent-to-agent rules, handles, wording, in-flight book, tools
- server/handlers/rewind.ts — rewind across harnesses (a native fork back to the kept exchange, a brief, or a fresh start)

## Rules and traps

- Split sub-prompts ride silent under the original prompt; split only when reaching the front so earlier commands run first.
- An entry being rewritten keeps queue place but nothing sends it until the rewrite returns.
- Only existing commands count — ruri's own, harness prompt commands, installed skills; quoted ones ('/compact', "/compact", `/compact`) and /tmp alone on a line stay plain text to the model.
- Every member may work at once; RURI_TEAM_MAX, when set, caps them — a member holding on an answer (talk.awaiting) does not count, or members waiting on each other's teammates hold every slot for good. Only waking a sleeping member is gated — never a lead or the liaison, never a member mid-turn.
- Turn progress lives in turns.ts not the window so the clock survives reload; broadcast deltas throttled to one message a second.
- Rewind must restore files, branch, transcript, composer prompt, and context gauge to the kept exchange, not the tip.
- A letter is answered by the last words of the turn that finishes the job: owedLetter() is what a turn owes (its own letter, a carried one, or via an answer's owes); talkTurnEnded settles it only when nothing sent for it is out (TalkBook.outstanding). An answer that leaves the book any other way — a wait in another job, taken out of the queue — goes through answerOnward. Self-compaction marks the carry (carryLetter) at the turn's result, before talkTurnEnded.
- The liaison (session.liaison) is never marked lead and leadOf skips it; it is not a member either: what takes 'every non-lead session' as the team must skip it (membersOf, store.isMember, protocol isMember); unattended() covers members and the liaison, whose held lines nobody sends on by hand.
- A lead's stop or restart on a teammate ends its work: dropResume takes ruri's 'back to work' entry out of its line (other letters still go), and its next message starts with stoppedLine, naming the cut-off call.

## What it talks to

- Protocol — every socket message and transcript event is typed in shared/protocol.ts
- Agent harnesses — dispatch and chats hand prompts to sessions and get turns, checkpoints, and forks back
- Projects, memory and history — checkpoints, compaction, handoff briefs, notes, and archive feed prompts, rewind, and events
- Server runtime and transport — socket routing, clients push, uploads, and stores carry transcript and queue messages
- Conversation — composer sends and queue/transcript handlers drive what the chat pane shows
