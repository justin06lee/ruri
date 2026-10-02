# ruri — Interface tooling: development and tests

One layer of ruri's stack, owning `vite.config.ts, web/src/fixture.ts, web/src/test/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer interface-tooling` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer interface-tooling add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer makes the interface usable in development and test environments. Vite exposes the server token to its own development page, fixture mode fills the client store with canned UI state, and a jsdom setup supplies browser globals for tests. The key distinction is that fixture mode can show the interface without a live server.

## Where to change what

- **Development page token access:** vite.config.ts
- **Fixture mode and screenshot state:** web/src/fixture.ts
- **Browser globals for interface tests:** web/src/test/dom.ts

## How it works

- **Development token:** The Vite development page requests /__token. → The middleware rejects a request whose Origin differs from its own host. → It reads the token from the configured directory.
- **Fixture mode:** Fixture mode calls installFixture. → The fixture populates the client store with canned transcript, permission, folder, and project status state. → The interface renders that state without a live server.
- **DOM test setup:** Import the DOM setup first. → It creates a jsdom window and adds missing browser globals. → Dynamically import modules that bind to window when they load.

## Key files

- web/src/fixture.ts — canned, store-backed state for viewing and driving the interface in fixture mode
- vite.config.ts — Vite configuration and same-origin development token middleware
- web/src/test/dom.ts — jsdom window and browser globals for web tests

## Rules and traps

- Keep the development token endpoint restricted to the Vite page’s origin; it must not expose CORS headers.
- Import the DOM setup before modules that need browser globals, and dynamically import modules that bind to window during loading.
- Use jsdom for sanitizer tests; the file documents that happy-dom changes the tested HTML in misleading ways.
- Fixture mode must remain usable without a live server.

## What it talks to

- Client state — the fixture populates and exposes state through the client store.
- Server transport — the development token middleware reads the token written for server socket access.
- Window and navigation — fixture state lets the interface be viewed and screenshotted.
