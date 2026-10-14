# ruri — Management: agents, skills and tracking

One layer of ruri's stack, owning `web/src/components/AgentsPage.tsx, web/src/components/Integrations.tsx, web/src/components/Skills.tsx, web/src/components/Ideas.tsx, web/src/components/Tracker.tsx, web/src/components/TalkPage.tsx, web/src/components/Statistics.tsx, web/src/components/Bridge.tsx, web/src/components/figures.ts, web/src/lib/models.ts, scripts/meters.ts, web/src/components/TeamPage.tsx`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer management-pages` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer management-pages add|set|drop <section> …`. Where it and the code disagree, the code is right.

Management layer holds the secondary boards and settings pages: agents/scripts, harness integrations, skills, ideas, tracker review, talk rules, and cost/machine statistics. Pages are thin views over server state via the store's `send`/`useRuri`, with formatting shared in figures.ts and model-name helpers in models.ts. Newcomer idea: ruri never owns harness config here — it displays and delegates to harness CLIs, bmo, ledger, and tracker/talk servers.

## Where to change what

- **Agents and background scripts:** web/src/components/AgentsPage.tsx
- **Harness integrations (MCP servers, plugins):** web/src/components/Integrations.tsx
- **Skills install/enable view:** web/src/components/Skills.tsx
- **Ideas board:** web/src/components/Ideas.tsx
- **Feature tracker review:** web/src/components/Tracker.tsx
- **Talk permissions and letters; the team page (a lead's members, its liaison, the layers no teammate holds yet):** web/src/components/TalkPage.tsx, web/src/components/TeamPage.tsx
- **Cost statistics and machine meters:** web/src/components/Statistics.tsx, web/src/components/figures.ts, scripts/meters.ts
- **Bridge preview strip:** web/src/components/Bridge.tsx
- **Number formatting:** web/src/components/figures.ts
- **Model/harness naming:** web/src/lib/models.ts

## How it works

- **Tracker review pass:** Tracker.tsx lists small-model items → click cycles open → liked → rejected, note field folds out on rejected → Finish review clears liked, pins rejected as repeats → small-model fix-it prompt drops into composer
- **Statistics read:** Statistics.tsx mounts and subscribes via watchMeters → money totals come off ledger → machine usage sampled from ps only while page is up → figures.ts formats money/counts/span identically to cards
- **Talk rule resolution:** TalkPage.tsx edits every project's rule → a project's own rule overrides it (anyone / only these projects / no one) → a team within its project always talks, whatever the rules → latest inter-agent letters listed underneath, a lead named by its project
- **Team page:** TeamPage.tsx opens → team_get → server/handlers/team.ts sends team (members, liaison, freeLayers, budget) → pushed again when a member's or the liaison's status moves or a letter is sent → Stop/Compact/Restart/Refresh/Retire go out as team_member

## Key files

- web/src/components/Statistics.tsx — money/machine cost page over ledger and ps sampling
- web/src/components/AgentsPage.tsx — per-chat agents and running scripts with live log
- web/src/components/Integrations.tsx — MCP servers/plugins view delegating to harness CLIs
- web/src/components/Tracker.tsx — hand-test checklist review with finish-to-composer
- web/src/components/Ideas.tsx — user-written wants board with draft persistence and attachments
- web/src/components/TeamPage.tsx — a project's team: each member's state, duty, layers, context and last words with stop/compact/restart/refresh/retire, the liaison's card (doing, answering, waiting on), layers with no teammate, how many are at work across ruri (RURI_TEAM_MAX's cap when set), outside chats brought in as teammates
- web/src/components/Skills.tsx — bmo/filesystem skills view with skills-off toggle
- web/src/components/Bridge.tsx — live hidden-window plate above composer with take-over
- web/src/components/TalkPage.tsx — which projects may reach which (every project's rule, a project's own over it) plus recent letters (figures.ts formats money/counts/spans for every page)
- web/src/lib/models.ts — harnessName and roughName label helpers

## Rules and traps

- Nothing here owns harness config: integrations go through harness CLIs, skills through bmo and skills-off/ folders — never write harness files directly.
- Ideas never move on their own: nothing lands or leaves without the user; only states are open and done.
- Tracker items never reorder mid-review; keep list stable until finish.
- Statistics money must come off the ledger so rewinds/compactions agree; machine sampling only while the page watches (view message starts/stops it).
- figures.ts formatting is shared with project cards — change in one place so both pages agree.
- Bridge picture opens read-only in the viewer; take-over/give-back is the only control.
- The team page acts only on teammates: the liaison is a lead (actOn refuses it), so its card has no buttons; Stop is disabled unless the member's turn is running (working, waiting on an answer, or at a card).

## What it talks to

- Protocol — all rows, rules, letters, totals typed in shared/protocol.ts
- App shell, state and tooling — pages read/write through store send/useRuri, composer drafts, viewer, Capped/Confirm pieces
- Projects, memory and history — ledger, tracker, ideas servers supply statistics/tracker/ideas data
- Terminals, agents and integrations — integrations/skills/talk pages delegate to harness CLIs, bmo, crew/talk servers
- Bridge — BridgeStrip renders hidden Chromium/app window state with take-over
- Chat runs and queue — server/handlers/team.ts builds the team message and acts on team_member; new fields there go through its owner
