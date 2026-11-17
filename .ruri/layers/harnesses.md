# ruri — Agent harnesses

One layer of ruri's stack, owning `server/providers.ts, server/models.ts, server/sessions.ts, server/manager.ts, server/agents.ts, server/smallmodel.ts, server/updater.ts, scripts/acp-start.ts, scripts/lost-session.ts, scripts/provider-check.ts, scripts/provider-events.ts, scripts/provider-session.ts, scripts/subagents-live.ts, scripts/subagents.ts, server/modelCatalog.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer harnesses` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer harnesses add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer drives installed coding CLIs (claude/codex/opencode/gemini/ACP) through yagami's AgentSession/ProviderSession, translating harness events into ruri transcript events. It is built around server/sessions.ts (SessionManager) with a provider registry, a model catalog, the Home manager agent, persistent team subagents, an auto-updater, a small-model client, and accounts: named Claude or Codex config dirs that a session launches under. Newcomers must grasp that ruri never talks to models directly: every prompt goes through a session object owned here, and transcript, usage and permission shapes are normalized here.

## Where to change what

- **Harness sessions and prompt turns:** server/sessions.ts, server/providers.ts, server/blocked.ts
- **Accounts: per-account config dirs and sign-in:** server/accounts.ts, server/accountStatus.ts
- **Model catalog, defaults and picker:** server/modelCatalog.ts, server/models.ts, server/providers.ts
- **Provider registry and startup probing:** server/providers.ts, server/models.ts
- **Default reasoning effort:** server/sessions.ts, server/providers.ts, server/modelCatalog.ts
- **Small-model summaries, titles and memory folds:** server/smallmodel.ts, server/memoryLines.ts
- **Home manager agent:** server/manager.ts, server/sessions.ts
- **Subagent cards, team roster and logs:** server/agents.ts, server/sessions.ts, scripts/subagents.ts
- **Harness CLI auto-update:** server/updater.ts
- **ACP/OpenCode startup retry (locked DB / dead warm process):** scripts/acp-start.ts
- **Lost/dead Claude session recovery:** scripts/lost-session.ts, server/sessions.ts
- **Cross-harness event and session parity checks:** scripts/provider-events.ts, scripts/provider-session.ts, scripts/provider-check.ts
- **Live subagent end-to-end check:** scripts/subagents-live.ts, server/agents.ts

## How it works

- **Prompt turn through a harness:** SessionManager builds/resumes provider session in server/sessions.ts → Session's account (project or Home pick) supplies the CLI config dir → ProviderRegistry resolves harness via server/providers.ts → yagami CLI session streams AgentEvents → sessions.ts normalizes to TranscriptEvents (text, tool chips, patches, questions) → Usage/limits recorded, reply finalized
- **Account sign-in:** Settings → Accounts Sign in opens a shell tab running the CLI's own login command → accountStatus.ts reads the CLI's sign-in state (claude auth status --json, parsed from stdout even on exit 1) → Shell closes once signed in; the account row shows identity and plan
- **Small-model background call:** sessions.ts or memory layer requests title/summary/split → server/smallmodel.ts picks the catalog's newest small model, RURI_SMALL_MODEL fallback, then the catalog default → yagami engine.stream over the signed-in CLI, aborted at a deadline (60s + 20ms/token), stalled model rests and the fallback answers → Result folded back (title, summary, tracker items); skipped when RURI_NO_MEMORY=1
- **Subagent spawn to card:** Harness emits spawn/task tool call → sessions.ts creates card with SubagentState → Budget gate admits the teammate (teams capped, one-at-a-time waits for a slot) → Agent work streams to per-agent log in server/agents.ts → Card updates in place; report ends it; idle teammates sleep and wake on message; dead process marked stopped
- **Script card progress:** AgentBook.watch (server/sessions.ts), called from attach() and update(), starts server/scriptWatch.ts on a running script card that has an output file → its newest printed line becomes the card's activity, with printedAt → the watch stops when the script ends

## Key files

- server/accounts.ts — account store in accounts.json with built-in work and personal accounts and their config dirs
- server/accountStatus.ts — per-CLI sign-in status reader and sign-in/sign-out commands
- server/sessions.ts — SessionManager: owns AgentSession lifecycle, event-to-transcript translation, permissions, usage
- server/providers.ts — ProviderRegistry: creates/loads yagami providers, parses model refs, capability mapping
- server/models.ts — Models: startup-probed Claude + harness model picker, live-session replacement
- server/modelCatalog.ts — model catalog whose defaults come from the newest versions, not fixed ids
- server/smallmodel.ts — cheap completions client for titles, summaries, splits, briefs, tracker extraction
- server/manager.ts — Home agent at workspace root with MCP/drop-file tools managing projects
- server/agents.ts — per-subagent JSON logs under config agents/<channel>/<key>.json with debounce and cap; team-aware roster, idle sleep/wake and budget gating
- server/updater.ts — hourly CLI self-update via native updater/bun/npm/brew, never under a running turn
- scripts/provider-events.ts — harness-free fake-provider transcript parity check
- scripts/provider-session.ts — real-harness tool-chip/patch/gauge/rewind parity check
- scripts/acp-start.ts — ACP restart on closed-pipe/locked-DB startup death

## Rules and traps

- Never bypass SessionManager to call a CLI directly; session resume, permissions and usage accounting live there.
- A live session's Claude model report only replaces probed ids/names — never clobber display names resolved from the startup catalog.
- Never hard-code model ids or default effort; defaults must come from the catalog's highest versions so the picker and defaults stay current. A star or a role on a model passes to the newer model of its line (shared/modelLine.ts); smallmodel.ts names lines and aliases only, resolved to the newest listed.
- Never replace a harness binary mid-turn; updater defers when a chat is active.
- Subagent transcript text must never leak into the parent chat — only the card carries SubagentState.
- Small-model calls are one per sent prompt and per finished reply, honor RURI_NO_MEMORY=1, and each runs through client.engine.stream with an AbortSignal and a deadline (smallmodel.ts ask) — never messages.create, which takes no signal, so a harness that never answers would keep its process and its place in line for good.
- ACP startup failures (locked SQLite, dead warm process) are retried, not surfaced as turn failures.
- The account's CLAUDE_CONFIG_DIR or CODEX_HOME is set last in the launch env so nothing else can override it.
- The built-in work account leaves its dir unset so it keeps Claude's default ~/.claude; personal and other accounts always keep their own dir.
- Claude's signed-out auth status still prints JSON with exit code 1, so the status parser reads stdout regardless of exit code.

## What it talks to

- Chat runs and queue — consumes SessionManager turns and TranscriptEvents over the socket
- Projects, memory and history — supplies checkpoints/rewind files and receives small-model summaries, titles, folds
- Projects and chats — a project's or chat's account is passed into session launch to set the CLI config dir
- Protocol — every transcript, question, model-choice and subagent message is typed in shared/protocol.ts
- Library, skills and sweeps — skills/sweeps feed harness session context and tools
- Terminals, agents and integrations — Home manager agent drives app actions via MCP or .ruri/open.jsonl drop file; Sign in opens a shell tab running the CLI's own login
