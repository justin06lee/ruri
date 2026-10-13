# ruri — Library, skills and sweeps

One layer of ruri's stack, owning `server/components.ts, server/library.ts, server/libraryRefresh.ts, server/shots.ts, server/photographer.ts, server/sweep.ts, server/skills.ts, server/handlers/components.ts, server/handlers/skills.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer library-skills-sweeps` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer library-skills-sweeps add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer keeps each project's component library — user names, handles, code refs, and screenshots — plus repo-wide naming sweeps and harness skills. The store is server/components.ts with the agent CLI in server/library.ts; handlers, refresh, screenshots, sweeps, and skills orbit it. Newcomer idea: the filesystem and git are truth — this layer indexes, names, and photographs what exists, never renders it.

## Where to change what

- **Component store and naming tools:** server/components.ts, server/library.ts, server/handlers/components.ts
- **Agent library CLI (search/show/add/register):** server/library.ts, server/components.ts
- **Library page and app-side host:** server/handlers/components.ts, server/components.ts, server/library.ts
- **Library refresh against git:** server/libraryRefresh.ts, server/components.ts, server/handlers/components.ts
- **Repo sweep naming unnamed UI:** server/sweep.ts, server/library.ts, server/components.ts
- **Mechanical screenshots of components:** server/shots.ts, server/handlers/components.ts, server/sweep.ts
- **Agent-taken photographs:** server/photographer.ts, server/handlers/components.ts, server/components.ts
- **Skills list/toggle/install:** server/skills.ts, server/handlers/skills.ts

## How it works

- **Register and reuse a component:** Agent builds UI and registers it via server/library.ts (ruri register) into server/components.ts store → server/handlers/components.ts hosts naming card and stores shot via storeShot → Later agent searches with ruri search/show and copies with planCopy/installCommand → server/libraryRefresh.ts marks entry changed/stale as files move
- **Sweep and photograph a repo:** server/sweep.ts skims source tops, exports, CSS classes for candidates → Names proposed and written via server/components.ts index → server/shots.ts boots dev server and captures selector rectangles → Unreachable entries go to agent photo chat via server/photographer.ts prompt
- **Skills management:** server/skills.ts scans global and project skill dirs → server/handlers/skills.ts pushes list and serves bodies → toggle moves folder to skills-off/, install/remove/update shell out to bmo

## Key files

- server/components.ts — per-project component index, store, mention detection, model tools
- server/library.ts — agent ruri CLI: search/show/add/register, copy planning, arg parsing
- server/handlers/components.ts — app-side host, naming tools, refresh orchestration, library endpoint
- server/sweep.ts — repo skim naming pass for unnamed UI files
- server/libraryRefresh.ts — git-based staleness: renames, deletions, changes since last seen
- server/shots.ts — dev-server boot and selector screenshot capture via CaptureHost
- server/skills.ts — filesystem-backed skill listing, toggle via skills-off, bmo shell-outs
- server/photographer.ts — prompt for agent-driven photos of unpictured/changed entries
- server/handlers/skills.ts — skills page messages, command menu data, pushSkills

## Rules and traps

- Never invent components or screenshots: files, selectors, and pictures must be observed from source or a running app.
- Entries drift — always consult libraryRefresh changes/tidyFiles and ComponentStore.touch semantics before trusting notes or shots.
- Do not delete on skill disable: park to skills-off/ so bmo metadata and updates survive.
- Shots cannot cover login-gated, state-dependent, or non-web UI — route those to photographer agent flow, not shots.ts.

## What it talks to

- Protocol — NamedComponent, ComponentProposal, Attachment, SkillInfo types in shared/protocol.ts
- Server runtime and transport — uploads storedFilePath, config/ruri dirs, dispatch, channel project resolution
- Bridge / Desktop shell — CaptureHost loads URLs in hidden window and captures element rectangles
- Agent harnesses — smallmodel naming pass feeds sweep; harnesses consume skills and library via ruri CLI
