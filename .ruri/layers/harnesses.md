# ruri — Agent harnesses

One layer of ruri's stack, owning `server/providers.ts, server/models.ts, server/sessions.ts, server/manager.ts, server/agents.ts, server/smallmodel.ts, server/updater.ts, scripts/acp-start.ts, scripts/lost-session.ts, scripts/provider-check.ts, scripts/provider-events.ts, scripts/provider-session.ts, scripts/subagents-live.ts, scripts/subagents.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer harnesses` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer harnesses add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer drives installed coding CLIs (claude/codex/opencode/gemini/ACP) through yagami's AgentSession/ProviderSession, translating harness events into ruri transcript events. It is built around server/sessions.ts (SessionManager, ~3474 lines) with a provider registry, model catalog, Home manager agent, subagent logs, auto-updater, and cheap small-model client. Newcomers must grasp: ruri never talks to models directly — every prompt goes through a session object owned here, and transcript/usage/permission shapes are normalized here.

## Where to change what

- **Harness sessions and prompt turns:** server/sessions.ts, server/providers.ts, server/blocked.ts
- **Model catalog and picker:** server/models.ts, server/providers.ts
- **Provider registry and startup probing:** server/providers.ts, server/models.ts
- **Small-model summaries, titles and memory folds:** server/smallmodel.ts, server/memoryLines.ts
- **Home manager agent:** server/manager.ts, server/sessions.ts
- **Subagent cards and logs:** server/agents.ts, server/sessions.ts, scripts/subagents.ts
- **Harness CLI auto-update:** server/updater.ts
- **ACP/OpenCode startup retry (locked DB / dead warm process):** scripts/acp-start.ts
- **Lost/dead Claude session recovery:** scripts/lost-session.ts, server/sessions.ts
- **Cross-harness event and session parity checks:** scripts/provider-events.ts, scripts/provider-session.ts, scripts/provider-check.ts
- **Live subagent end-to-end check:** scripts/subagents-live.ts, server/agents.ts

## How it works

- **Prompt turn through a harness:** SessionManager builds/resumes provider session in server/sessions.ts → ProviderRegistry resolves harness via server/providers.ts → yagami CLI session streams AgentEvents → sessions.ts normalizes to TranscriptEvents (text, tool chips, patches, questions) → Usage/limits recorded, reply finalized
- **Small-model background call:** sessions.ts or memory layer requests title/summary/split → server/smallmodel.ts picks double-starred model, RURI_SMALL_MODEL fallback, then codex default → yagami engine.stream over the signed-in CLI, aborted at a deadline (60s + 20ms/token), stalled model rests and the fallback answers → Result folded back (title, summary, tracker items); skipped when RURI_NO_MEMORY=1
- **Subagent spawn to card:** Harness emits spawn/task tool call → sessions.ts creates card with SubagentState → Agent work streams to per-agent log in server/agents.ts → Card updates in place; report ends it; dead process marked stopped

## Key files

- server/sessions.ts — SessionManager: owns AgentSession lifecycle, event-to-transcript translation, permissions, usage
- server/providers.ts — ProviderRegistry: creates/loads yagami providers, parses model refs, capability mapping
- server/models.ts — Models: startup-probed Claude + harness model picker, live-session replacement
- server/smallmodel.ts — cheap completions client for titles, summaries, splits, briefs, tracker extraction
- server/manager.ts — Home agent at workspace root with MCP/drop-file tools managing projects
- server/agents.ts — per-subagent JSON logs under config agents/<channel>/<key>.json with debounce and cap
- server/updater.ts — hourly CLI self-update via native updater/bun/npm/brew, never under a running turn
- scripts/provider-events.ts — harness-free fake-provider transcript parity check
- scripts/provider-session.ts — real-harness tool-chip/patch/gauge/rewind parity check
- scripts/acp-start.ts — ACP restart on closed-pipe/locked-DB startup death

## Rules and traps

- Never bypass SessionManager to call a CLI directly; session resume, permissions and usage accounting live there.
- A live session's Claude model report only replaces probed ids/names — never clobber display names resolved from the startup catalog.
- Never replace a harness binary mid-turn; updater defers when a chat is active.
- Subagent transcript text must never leak into the parent chat — only the card carries SubagentState.
- Small-model calls are one per sent prompt and per finished reply, honor RURI_NO_MEMORY=1, and each runs through client.engine.stream with an AbortSignal and a deadline (smallmodel.ts ask) — never messages.create, which takes no signal, so a harness that never answers would keep its process and its place in line for good.
- ACP startup failures (locked SQLite, dead warm process) are retried, not surfaced as turn failures.

## What it talks to

- Chat runs and queue — consumes SessionManager turns and TranscriptEvents over the socket
- Projects, memory and history — supplies checkpoints/rewind files and receives small-model summaries, titles, folds
- Protocol — every transcript, question, model-choice and subagent message is typed in shared/protocol.ts
- Library, skills and sweeps — skills/sweeps feed harness session context and tools
- Terminals, agents and integrations — Home manager agent drives app actions via MCP or .ruri/open.jsonl drop file
