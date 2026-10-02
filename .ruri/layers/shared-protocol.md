# ruri — Shared protocol

One layer of ruri's stack, owning `shared/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer shared-protocol` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer shared-protocol add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer defines the types and constants shared by the server and web UI. It validates incoming client messages at runtime and provides question-answer validation used by both the UI and provider adapter. When changing a client message, keep its type and schema aligned.

## Where to change what

- **Client message contract:** shared/protocol.ts, shared/clientSchema.ts
- **Session, project, and model types:** shared/protocol.ts
- **Attachments and composer drafts:** shared/protocol.ts
- **Transcript retention:** shared/protocol.ts
- **Question-answer validation:** shared/questionInput.ts, shared/protocol.ts
- **Statistics resource fields:** shared/protocol.ts

## How it works

- **Incoming client message:** A client message has a type in shared/protocol.ts → shared/clientSchema.ts checks its shape at runtime → Unknown fields are dropped before the server handles it
- **Question answer:** An AskQuestion defines the input constraints → The UI or provider adapter passes answers to questionError → questionError returns an error message or undefined

## Key files

- shared/protocol.ts — shared server and UI types, constants, resource fields, and recent-event trimming
- shared/clientSchema.ts — runtime schema for ClientMessage
- shared/questionInput.ts — shared question-answer validation

## Rules and traps

- Every ClientMessage member needs a matching schema arm; the schema’s ClientMessage annotation checks assignability at typecheck.
- Incoming client messages must be checked at runtime because parsed JSON may have the wrong shape.
- keepRecent starts at a user or compaction event when one falls within the retained tail; a longer single turn is cut at the limit.
- The statistics memory field is named memory rather than rss because Linux reports PSS, not RSS.

## What it talks to

- Client state — uses the shared server and UI protocol
- Server transport — validates incoming client messages against the shared schema
- Chat and prompting — uses shared draft, attachment, transcript, and question definitions
- Sessions — uses shared session types and question validation
