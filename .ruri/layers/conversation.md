# ruri — Conversation: composer and chat

One layer of ruri's stack, owning `web/src/components/Composer.tsx, web/src/components/Attachments.tsx, web/src/components/Markers.tsx, web/src/components/Sketch.tsx, web/src/components/CommandMenu.tsx, web/src/components/ChatPane.tsx, web/src/components/EventView.tsx, web/src/components/Exchange.tsx, web/src/components/Diff.tsx, web/src/components/Questions.tsx, web/src/components/PermissionBanner.tsx, web/src/components/Thinking.tsx, web/src/components/Selection.tsx, web/src/components/Terminal.tsx, web/src/markdown.tsx, web/src/lib/markers.ts, web/src/lib/files.ts, web/src/lib/commandLine.ts, web/src/lib/markdownHtml.ts, web/src/lib/highlighter.ts, web/src/lib/highlight.worker.ts, web/src/lib/transcript.ts, web/src/lib/scrollGate.ts, web/src/lib/rapid.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer conversation` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer conversation add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer is the conversation surface: composing prompts in Composer.tsx and reading replies in ChatPane.tsx as grouped transcript turns. Rendering is componentized per event kind (EventView, Exchange, Diff, Thinking, Questions) with markdown sanitized to HTML and code highlighting cached plus offloaded to a worker. A newcomer must grasp that the prompt is plain text with markers ([image #n], /commands) mirrored as chips, and the transcript is a flat event stream grouped into turns at render time.

## Where to change what

- **Prompt composing and sending:** web/src/components/Composer.tsx, web/src/lib/markers.ts, web/src/components/CommandMenu.tsx, web/src/lib/commandLine.ts
- **Attachment chips, viewer and region crops:** web/src/components/Attachments.tsx, web/src/lib/files.ts, web/src/components/Composer.tsx
- **Sketch pad drawing to image:** web/src/components/Sketch.tsx, web/src/components/Composer.tsx
- **Marker chips mirror over textarea:** web/src/components/Markers.tsx, web/src/lib/markers.ts
- **Transcript pane, turns and autoscroll:** web/src/components/ChatPane.tsx, web/src/components/Exchange.tsx, web/src/lib/scrollGate.ts, web/src/lib/transcript.ts
- **Transcript event rendering:** web/src/components/EventView.tsx, web/src/components/Exchange.tsx
- **Reply markdown and code blocks:** web/src/markdown.tsx, web/src/lib/markdownHtml.ts, web/src/lib/highlighter.ts, web/src/lib/highlight.worker.ts
- **Diff display:** web/src/components/Diff.tsx, web/src/components/EventView.tsx
- **Question / permission cards:** web/src/components/Questions.tsx, web/src/components/PermissionBanner.tsx
- **Working / thinking indicator:** web/src/components/Thinking.tsx, web/src/components/ChatPane.tsx
- **Composer terminal tabs:** web/src/components/Terminal.tsx, web/src/components/Composer.tsx
- **Transcript text selection flags:** web/src/components/Selection.tsx, web/src/components/ChatPane.tsx
- **Carry-on after an agent compacted itself:** web/src/components/EventView.tsx, web/src/components/Exchange.tsx, shared/protocol.ts

## How it works

- **Send a prompt:** Type plain text with markers in Composer.tsx textarea → Markers parsed and mirrored as chips via lib/markers.ts and Markers.tsx → Attachments and sketch images appended with region crops from Attachments.tsx → Slash command resolved via CommandMenu.tsx and scripts/commands.ts → Sent through store send; ChatPane.tsx groups reply events into turns via Exchange.tsx groupTurns
- **Render a reply:** ChatPane.tsx receives flat TranscriptEvent stream → Exchange.tsx groupTurns folds user prompt through following events; compaction stands solo → EventView.tsx renders each event kind with shortened paths and command chips → Markdown goes through lib/markdownHtml.ts with DOMPurify then markdown.tsx components → Code blocks highlight inline or via highlight.worker.ts with cache in highlighter.ts
- **Answer a question:** Ask/permission event renders QuestionCard in Questions.tsx or PermissionBanner.tsx → One question shown at a time with slide navigation and persisted picks → Answer sent back in harness-native shape via store send

## Rules and traps

- Never put highlighting or sanitizing inline in components: markdown goes via lib/markdownHtml.ts with DOMPurify since model output is untrusted innerHTML.
- Do not re-highlight from scratch: highlighter.ts caches by language plus text and only long blocks go to highlight.worker.ts; short blocks stay inline.
- Keep markers as text: find, move, space and strip them only with lib/markers.ts so mirror width and wrapping stay identical to the textarea.
- Compaction events are solo turns in groupTurns and never fold or host other events.
- Sketch keeps shapes and redraws at export size with per-channel autosave; it closes only on its own close button, never on Escape.
- A user event whose text opens with CARRY_ON (shared handoffNote) is ruri's carry-on after a self-compaction: render it as CarryOn, never as the user's bubble or as a letter from its `from` (with `carried` that only says whose job it still is); server continuePrompt must keep opening with CARRY_ON.
