# ruri — Chat and prompting

One layer of ruri's stack, owning `web/src/components/Attachments.tsx, web/src/components/Capped.tsx, web/src/components/ChatPane.tsx, web/src/components/CommandMenu.tsx, web/src/components/Composer.tsx, web/src/components/Diff.tsx, web/src/components/Dragon.tsx, web/src/components/EmptyTop.tsx, web/src/components/EventView.tsx, web/src/components/Exchange.tsx, web/src/components/Markers.tsx, web/src/components/Marks.tsx, web/src/components/PermissionBanner.tsx, web/src/components/Questions.tsx, web/src/components/Queue.tsx, web/src/components/RapidFire.tsx, web/src/components/Selection.tsx, web/src/components/SessionControls.tsx, web/src/components/Sketch.tsx, web/src/components/Terminal.tsx, web/src/components/Thinking.tsx, web/src/components/chat/, web/src/copy.ts, web/src/dragonArt.ts, web/src/lib/commandLine.ts, web/src/lib/files.ts, web/src/lib/held.ts, web/src/lib/highlight.worker.ts, web/src/lib/highlighter.ts, web/src/lib/markdownHtml.ts, web/src/lib/markers.ts, web/src/lib/marks.ts, web/src/lib/models.ts, web/src/lib/rapid.ts, web/src/lib/scrollGate.ts, web/src/lib/transcript.ts, web/src/markdown.tsx`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer chat-prompting` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer chat-prompting add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer renders chat transcripts, session controls, and the prompt composer, including attachments, commands, questions, and terminal input. React components use client state and shared protocol types, while helpers handle markers, transcript presentation, and Markdown. A newcomer should understand that attachment and command chips are a visual mirror of text in the composer, not separate prompt objects.

## Where to change what

- **Chat pane and transcript layout:** web/src/components/ChatPane.tsx, web/src/components/Exchange.tsx
- **Prompt composer and sending:** web/src/components/Composer.tsx, web/src/components/SessionControls.tsx
- **Attachments and image regions:** web/src/components/Attachments.tsx, web/src/lib/files.ts
- **Sketch pad:** web/src/components/Sketch.tsx
- **Prompt markers and command chips:** web/src/components/Markers.tsx, web/src/lib/markers.ts, web/src/components/CommandMenu.tsx
- **Transcript events and diffs:** web/src/components/EventView.tsx, web/src/components/Diff.tsx
- **Markdown rendering and highlighting:** web/src/markdown.tsx, web/src/lib/markdownHtml.ts, web/src/lib/highlighter.ts, web/src/lib/highlight.worker.ts
- **Queued prompts:** web/src/components/Queue.tsx
- **Question cards:** web/src/components/Questions.tsx
- **Terminal input:** web/src/components/Terminal.tsx, web/src/components/Composer.tsx
- **Rapid fire session selection:** web/src/components/RapidFire.tsx, web/src/lib/rapid.ts
- **Turn progress:** web/src/components/Thinking.tsx, web/src/components/Dragon.tsx

## How it works

- **Compose a prompt:** Composer collects text and attachments → Attachments supplies previews and image regions → Markers mirrors attachment and command text as chips → Composer sends through client state
- **Show a transcript:** ChatPane obtains the session transcript from client state → Exchange groups turns → EventView renders events and attachments → Markdown rendering sanitizes model output before HTML display
- **Answer a question:** Questions displays one question at a time → Picks and typed answers remain keyed by request while the card is unmounted → The answer is sent in the originating tool's input shape

## Key files

- web/src/components/ChatPane.tsx — assembles the chat view and transcript
- web/src/components/Composer.tsx — composes and sends prompts
- web/src/components/EventView.tsx — renders transcript events
- web/src/components/Exchange.tsx — groups transcript turns
- web/src/components/Attachments.tsx — previews attachments and handles image regions
- web/src/components/Markers.tsx — draws interactive chips over composer text
- web/src/lib/markers.ts — finds and edits marker text
- web/src/components/Queue.tsx — displays and edits queued prompts
- web/src/components/Questions.tsx — collects answers to tool questions
- web/src/lib/markdownHtml.ts — renders and sanitizes Markdown HTML

## Rules and traps

- Composer markers remain text in the textarea; the mirror must wrap exactly like that text.
- Image region numbers are counted across all attachments in drawing order so each region reference identifies one crop.
- Model Markdown is untrusted; sanitize its rendered HTML before inserting it into the page.
- Question picks, typed answers, and position survive switching sessions until the answer is sent.
- Queued prompts stay app-side and remain editable or removable until dispatch.
- Sketch strokes are stored as shapes per channel and picture, then redrawn for undo and export.

## What it talks to

- Client state — supplies transcripts, drafts, queues, attachments, and send actions
- Shared protocol — defines session, transcript, attachment, question, and progress types
- Sessions — receives prompts and answers through client state and supplies session events
- Window and navigation — hosts the chat pane and its surrounding views
- Agent and bridge views — appear within the chat pane
