# ruri — Projects, memory and history

One layer of ruri's stack, owning `server/projects.ts, server/handlers/projects.ts, server/checkpoints.ts, server/compaction.ts, server/handoff.ts, server/memory.ts, server/memoryLines.ts, server/memoryCli.ts, server/recall.ts, server/notes.ts, server/brief.ts, server/briefing.ts, server/catchup.ts, server/catchupBrief.ts, server/archive.ts, server/orphans.ts, server/recent.ts, server/ledger.ts, server/tracker.ts, server/ideas.ts, server/handlers/boards.ts, server/gitState.ts, server/ruriDir.ts, server/configDir.ts, server/memoryLog.ts, server/memoryFold.ts, server/memoryQueue.ts, server/memoryCheck.ts, server/memoryQuality.ts, server/grounding.ts, server/similarity.ts, server/embeddings.ts, server/retrieval.ts, server/projectSearch.ts, server/digestFold.ts, server/sheetBudget.ts, server/turnRecords.ts, scripts/digest.ts, scripts/memory-eval.ts, scripts/self-compact.ts, server/selfCompaction.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer projects-memory-history` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer projects-memory-history add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer owns project sessions and everything remembered about them: sessions/chats in projects.json, live transcripts plus history with stable exchange numbers, per-prompt file checkpoints, the project memory, project-wide recall, and the .ruri briefs and sheets. The memory is an append-only event log per project (memory/<id>.jsonl) whose current lines are written to briefs.json; every finished turn is folded in by the memory model as ops, and each line is checked against the code it names. A newcomer must grasp the split: the live session file is rewritten per event, history JSONL is append-only by compaction, the memory changes only through its log, briefs are assembled at send time without calling a model, leads are pure delegators with a hidden liaison for cross-project work, and every agent now compacts itself at half its window with its own handoff note while ruri's 80% compaction stays as backstop.

## Where to change what

- **Projects (open/close/rename/star/hide), leads and the hidden liaison, and their teams' members (stop/refresh/restart/retire, closeMember, the one teardown forgetChat):** server/projects.ts, server/handlers/projects.ts, server/talk.ts, server/ruriDir.ts
- **Session archive and transcript:** server/archive.ts, server/notes.ts, server/handlers/boards.ts
- **Checkpoints and rewind:** server/checkpoints.ts, server/gitState.ts, scripts/checkpoint.ts, scripts/rewind-compaction.ts
- **Compaction, digests, auto-compact, self-compaction and carried delegations:** server/compaction.ts, server/handoff.ts, server/selfCompaction.ts, server/digestFold.ts
- **Memory log, folds and the check against the code:** server/memoryLog.ts, server/memoryFold.ts, server/memoryQueue.ts, server/memoryCheck.ts
- **Recall across the project:** server/projectSearch.ts, server/retrieval.ts, server/recall.ts, server/embeddings.ts
- **Project brief / architecture sheet and lead/liaison briefings:** server/brief.ts, server/catchupBrief.ts, server/briefing.ts, server/sheetBudget.ts
- **Catchup from existing repo:** server/catchup.ts, server/catchupBrief.ts, scripts/history.ts
- **Outside chats import:** server/recent.ts, server/orphans.ts, scripts/orphans.ts
- **Tracker, ledger and ideas:** server/tracker.ts, server/ledger.ts, server/ideas.ts, server/handlers/boards.ts

## How it works

- **Compact and resume:** past the harness's share of the window at turn end (0.8; Gemini 0.6), or by the user, or by the agent itself past half its window via mcp__ruri__compact with its own note → compactChannel (server/dispatch.ts) → server/archive.ts appends live events to history JSONL, keeps exchange numbers, retires the live session → brief built at send within 10k tokens, no model call (server/compaction.ts, server/handoff.ts); when Claude compacts itself, its PreCompact/SessionStart hooks (server/sessions.ts) get afterCompactBrief and the sheet-read guard resets → self-compact continuation queued at head of line then drained into the fresh session (server/selfCompaction.ts); thin notes, early requests, and immediate re-compacts refused → a continuation answering a delegated letter keeps the same letter id with carried: true, carried via carryLetter in the result branch before talk turn-end
- **Checkpoint and rewind:** server/checkpoints.ts captures whole working tree into git via private index under refs/ruri/ once per prompt send and once per turn end → ref named for prompt; user branch, staging area and git log untouched → rewind reads refs to undo what a chat's turns did, reported as RewindReport
- **Remember and recall:** turn end → enqueueFold (server/memoryQueue.ts) → memory model returns ADD/UPDATE/SUPERSEDE/RETIRE/NOOP ops (server/memoryFold.ts) → MemoryBook.apply (server/memoryLog.ts) appends events, writes current lines to briefs.json → server/memoryCheck.ts checks anchors (server/grounding.ts); a verifier confirms, supersedes or retires → ruri recall and the brief's pick fuse BM25, trigram and embeddings by RRF across the project (server/projectSearch.ts, server/retrieval.ts)

## Key files

- server/projects.ts — ProjectStore over projects.json plus per-chat session settings; a project's lead first and its members with duty and layers, plus the hidden liaison session (formTeams at launch, addMember, setMember)
- server/handlers/projects.ts — socket moves for projects, a member off its team (closeMember), an outside chat brought in as a teammate
- server/archive.ts — live sessions/<id>.json plus append-only history/<id>.jsonl and turn summaries
- server/checkpoints.ts — per-prompt hidden git commits and rewind
- server/compaction.ts — briefs within the token budget, state lines, anchored digest sections
- server/selfCompaction.ts — agent self-compact notes, threshold checks and continuation into the fresh session
- server/memoryLog.ts — the memory event log: actor rules, caps that archive, undo, reconcile with briefs.json; fed by server/memoryQueue.ts, checked by server/memoryCheck.ts
- server/projectSearch.ts — project-wide hybrid search over exchanges and memory lines (BM25 in server/recall.ts)
- server/brief.ts — .ruri/architecture.md shape and stack/layer sheets
- server/catchupBrief.ts — sheet broadcast and rebuild from app side

## Rules and traps

- Nothing except compaction appends to history/<id>.jsonl; live session file is the only rewritten transcript.
- Checkpoints must use a private index file and refs/ruri/ refs; never touch the user's staging area, branch, or pushed refs.
- The memory changes only through MemoryBook.apply (server/memoryLog.ts), never by writing briefs.json: a line a fold leaves out stays; the model edits only its own lines; agent lines go only with a reason and evidence; user and pinned lines are never touched by the model; cap overflow archives.
- Building and sending a brief calls no model and never waits on one (embeddings count only if already warmed; the digest folds in the background), and the system-prompt briefing stays byte-stable so the prompt cache holds — anything dynamic (<state>, <memory-update>) rides in the prompt.
- Only sessions ruri did not start are offered by recent import, and one brought in joins the team as a named member (addMember) — never re-import one of ruri's own chats. A project's chats change only through its team: no new, close or rename moves, and a lead goes only with its project.
- Exchange numbers are stable (seqs/nextSeq in server/archive.ts); refs and turn files use them, never a position.
- The compact tool only stores the note and tells the model to end its turn; it never stops the turn itself. Compaction runs at that turn's result: ok compacts with the continuation, stopped drops the note and settles the letter as today, failed keeps the note for the next ok turn.
- A self-compact continuation answering a letter keeps the same letter id with carried: true on its from; carryLetter is called in the result branch at selfCompactDue time, never inside the tool call, or a stopped turn leaves the letter hanging.

## What it talks to

- Chat runs and queue — supplies prompts, turns, events and rewind entry points this layer archives and checkpoints
- Protocol — TranscriptEvent, TurnSummary, MemoryLine, Project/Session and brief sheet types in shared/protocol.ts
- Server runtime and transport — routing, auth, uploads and stores hosting projects/handlers endpoints
- Agent harnesses — session ids resumed; the memory model's lane (completeMemory in server/smallmodel.ts); Claude's PreCompact/SessionStart hooks and the PostToolBatch hook that tells it its context mid-turn (SessionExtras.contextNotice, server/sessions.ts)
- Library, skills and sweeps — sweep/describe candidates feed catchup; library owns skill removal on teardown
