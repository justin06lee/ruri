# ruri — Build and checks

One layer of ruri's stack, owning `scripts/, package.json, bun.lock, Makefile, eslint.config.js, tsconfig.server.json`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer build-and-checks` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer build-and-checks add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer defines the Bun and Make commands for building, installing, formatting, and checking the app. Its main build produces separate Electron main-process and server-process bundles. The server bundle is kept ASCII-only to avoid doubling its string storage in V8. Focused scripts check server behavior, shared protocol messages, desktop bridge actions, and agent runtimes; before running one, check whether it uses a fake provider, a local mock, or a real CLI.

## Where to change what

- **Build, install, and check commands:** package.json, Makefile
- **Main and server process builds:** scripts/build-main.ts, package.json
- **Test runner:** scripts/run-tests.ts, package.json
- **Performance meter checks:** scripts/meters.ts
- **Lint and server TypeScript configuration:** eslint.config.js, tsconfig.server.json
- **Session continuity checks:** scripts/session-stress.ts, scripts/lost-session.ts
- **Agent messaging checks:** scripts/talk-replies.ts, scripts/talk.ts
- **Bridge end-to-end check:** scripts/bridge.ts
- **Bridge close check:** scripts/bridge-close.ts
- **Provider event check:** scripts/provider-events.ts
- **Shared test server setup:** scripts/lib/server.ts

## How it works

- **Server integration check:** A focused script creates scratch configuration and project data. → It starts or connects to the server. → It drives actions over WebSocket or HTTP. → It checks the resulting messages, transcript, or state.

## Key files

- package.json — Bun commands and package configuration
- Makefile — Make targets for build and maintenance work
- scripts/run-tests.ts — test runner
- scripts/build-main.ts — builds separate Electron main-process and server-process bundles and keeps them ASCII-only
- scripts/lib/server.ts — shared server setup used by integration scripts
- eslint.config.js — lint configuration
- tsconfig.server.json — server TypeScript configuration
- scripts/session-stress.ts — real-CLI session continuity stress check
- scripts/provider-events.ts — fake-provider event and transcript check
- scripts/meters.ts — performance meter check

## Rules and traps

- Several focused scripts are manual checks that invoke real CLIs and may consume model turns; scripts/provider-events.ts uses a fake provider and costs no model turns.
- Server integration checks use scratch configuration or projects so they do not depend on normal user state.
- The desktop bridge check isolates its app data and port; its app-control pass depends on platform permissions or Linux desktop tooling and may be skipped when those are absent.
- scripts/bridge-close.ts must pass the app its access token.
- scripts/session-stress.ts treats lost model context, missing transcript turns, failed prompts, and failed return to an earlier model as session loss.
- Keep the server bundle ASCII-only: non-ASCII characters in regular expressions made V8 store the entire bundle at two bytes per character.

## What it talks to

- Server transport — integration scripts drive the real server over WebSocket or HTTP
- Shared protocol — scripts type and inspect client messages, server messages, and transcript events
- Sessions — checks exercise provider events, queues, settings, retries, and session continuity
- Bridge and desktop shell — the bridge check boots the desktop app and drives its HTTP bridge
- Agent runtimes — real-CLI checks exercise installed harnesses
