# ruri — Projects, memory and history

One layer of ruri's stack, owning `server/projects.ts, server/handlers/projects.ts, server/checkpoints.ts, server/compaction.ts, server/handoff.ts, server/memory.ts, server/memoryLines.ts, server/memoryCli.ts, server/recall.ts, server/notes.ts, server/brief.ts, server/briefing.ts, server/catchup.ts, server/catchupBrief.ts, server/archive.ts, server/orphans.ts, server/recent.ts, server/ledger.ts, server/tracker.ts, server/ideas.ts, server/handlers/boards.ts, server/gitState.ts, server/ruriDir.ts, server/configDir.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer projects-memory-history` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer projects-memory-history add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer owns project sessions and everything remembered about them: sessions/chats in projects.json, live transcripts plus history, per-prompt file checkpoints, working memory lines, BM25 recall, and the .ruri/architecture.md briefs. It is built as small stores over ~/.config/ruri (sessions, history) and the project .ruri dir, with scripts/* as CLI/test entry points. A newcomer must grasp the split: live session file is rewritten per event, history JSONL is append-only by compaction, and briefs/memory are precomputed so resume and compaction stay instant.

## Where to change what

- **Project sessions (open/close/rename/star/hide):** server/projects.ts, server/handlers/projects.ts, server/ruriDir.ts, server/configDir.ts
- **Session archive and transcript:** server/archive.ts, server/notes.ts, server/handlers/boards.ts
- **Checkpoints and rewind:** server/checkpoints.ts, server/gitState.ts, scripts/checkpoint.ts, scripts/rewind-compaction.ts
- **Compaction and digests:** server/compaction.ts, server/handoff.ts, scripts/digest.ts
- **Working memory lines:** server/memoryLines.ts, server/memory.ts, server/memoryCli.ts
- **Recall across chats:** server/recall.ts, server/memoryCli.ts, scripts/recall.ts
- **Project brief / architecture sheet:** server/brief.ts, server/catchupBrief.ts, server/briefing.ts
- **Catchup from existing repo:** server/catchup.ts, server/catchupBrief.ts, scripts/history.ts
- **Outside chats import:** server/recent.ts, server/orphans.ts, scripts/orphans.ts
- **Tracker, ledger and ideas:** server/tracker.ts, server/ledger.ts, server/ideas.ts, server/handlers/boards.ts
- **Notes CLI:** scripts/notes.ts, server/notes.ts, server/memoryCli.ts
- **Fork / home-cap / hidden helpers:** scripts/fork.ts, scripts/home-cap.ts, scripts/hidden.ts

## How it works

- **Compact and resume:** server/compaction.ts builds brief from per-exchange recall notes without calling a model → server/archive.ts appends pre-compaction live events to history JSONL and retires live session → brief rides invisibly on next prompt; archived turn files refreshed/removed via refreshArchivedTurnFiles/removeTurnFiles → fresh session reads .ruri brief plus full exchange files on demand
- **Checkpoint and rewind:** server/checkpoints.ts captures whole working tree into git via private index under refs/ruri/ once per prompt send and once per turn end → ref named for prompt; user branch, staging area and git log untouched → rewind reads refs to undo what a chat's turns did, reported as RewindReport
- **Remember and recall:** agent writes first-hand line via ruri note (server/memoryCli.ts) or small model folds chats into id-addressed lines (server/memoryLines.ts) → lines kept per-part with caps; agent/user lines kept or retired, never rephrased → ruri recall / prompt-time pick scores exchanges with BM25 over notes, words, reply open/close and changed files (server/recall.ts)

## Key files

- server/projects.ts — ProjectStore over projects.json plus per-chat session settings
- server/handlers/projects.ts — socket moves for projects and sessions
- server/archive.ts — live sessions/<id>.json plus append-only history/<id>.jsonl and turn summaries
- server/checkpoints.ts — per-prompt hidden git commits and rewind
- server/compaction.ts — model-free compaction briefs and digests
- server/memoryLines.ts — id-addressed working-memory lines with per-part caps
- server/recall.ts — BM25 exchange search across chats
- server/brief.ts — .ruri/architecture.md shape and stack/layer sheets
- server/catchupBrief.ts — sheet broadcast and rebuild from app side
- server/recent.ts — outside-ruri harness sessions listed and imported

## Rules and traps

- Nothing except compaction appends to history/<id>.jsonl; live session file is the only rewritten transcript.
- Checkpoints must use a private index file and refs/ruri/ refs; never touch the user's staging area, branch, or pushed refs.
- Memory fold addresses kept lines by id and returns them verbatim; only the small model's own lines may be reworded, pinned lines always stay.
- Compaction calls no model; it only assembles already-written per-exchange recall notes.
- Only sessions ruri did not start are offered by recent import; never re-import a sidebar chat.

## What it talks to

- Chat runs and queue — supplies prompts, turns, events and rewind entry points this layer archives and checkpoints
- Protocol — TranscriptEvent, TurnSummary, MemoryLine, Project/Session and brief sheet types in shared/protocol.ts
- Server runtime and transport — routing, auth, uploads and stores hosting projects/handlers endpoints
- Agent harnesses — harness session ids resumed and settled via agents/sessions
- Library, skills and sweeps — sweep/describe candidates feed catchup; library owns skill removal on teardown
