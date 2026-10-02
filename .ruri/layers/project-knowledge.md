# ruri — Project knowledge

One layer of ruri's stack, owning `server/memory.ts, server/memoryCli.ts, server/memoryLines.ts, server/catchup.ts, server/catchupBrief.ts, server/briefing.ts, server/sheetEdits.ts, server/notes.ts, server/recall.ts, server/compaction.ts, server/components.ts, server/library.ts, server/libraryRefresh.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer project-knowledge` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer project-knowledge add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer keeps project knowledge available to sessions: working memory, architecture sheets, recall notes, compaction briefs, and a per-project component library. It builds knowledge from chats and repository reads, while session commands let agents record firsthand corrections. A newcomer should distinguish stored notes and sheets from the source material they summarize.

## Where to change what

- **Working memory:** server/memoryLines.ts, server/memory.ts, server/memoryCli.ts
- **Architecture sheets:** server/catchup.ts, server/catchupBrief.ts, server/sheetEdits.ts
- **Recall notes and search:** server/notes.ts, server/recall.ts, server/memoryCli.ts
- **Compaction briefs:** server/compaction.ts, server/recall.ts
- **Session knowledge briefing:** server/briefing.ts
- **Component records:** server/components.ts, server/libraryRefresh.ts
- **Component library commands:** server/library.ts, server/components.ts

## How it works

- **Build project knowledge:** server/catchup.ts reads the repository to build architecture sheets → server/memory.ts assembles existing chat knowledge into working memory → server/catchupBrief.ts writes and publishes the sheets
- **Recall and compact:** server/notes.ts stores prompt and reply notes → server/recall.ts ranks relevant exchanges → server/compaction.ts builds a brief with paths to complete exchanges
- **Use the component library:** server/components.ts stores named project components → server/library.ts handles agent search, show, add, and register commands → server/libraryRefresh.ts checks recorded files against Git changes

## Key files

- server/memoryLines.ts — stores sourced memory lines and applies folds
- server/catchupBrief.ts — writes, publishes, and refreshes project sheets
- server/catchup.ts — builds architecture sheets from repository reads
- server/memory.ts — rebuilds working memory from existing chats
- server/memoryCli.ts — handles session memory and architecture commands
- server/sheetEdits.ts — applies session corrections to architecture sheets
- server/notes.ts — stores and backfills recall notes
- server/recall.ts — finds and ranks relevant exchanges
- server/compaction.ts — builds briefs for fresh sessions
- server/components.ts — stores the per-project component library

## Rules and traps

- A memory fold keeps retained lines by ID; it may reword its own lines, but must not rephrase agent or user lines.
- Pinned memory lines survive model folds.
- Compaction uses existing recall notes and calls no model; its exchange paths lead to full records when the brief lacks detail.
- Component records can drift as code moves; refresh follows Git renames and detects missing or changed files.
- Session architecture edits supply firsthand corrections to sheets that were inferred from replies.

## What it talks to

- Shared protocol — defines memory, sheet, component, attachment, and message types
- Sessions — supplies chats, turns, archives, and broadcasts used to gather and deliver knowledge
- Server services — supplies small-model work, Git state, uploads, and project storage
- Agent runtimes — receive the session briefing and use the ruri commands
