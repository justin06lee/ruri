# ruri — Bridge

One layer of ruri's stack, owning `server/bridge.ts, server/bridgeState.ts, server/cdp.ts, desktop/bridge.ts, desktop/capture.ts, desktop/apps.ts, desktop/linuxApps.ts, desktop/desktopEntries.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer bridge` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer bridge add|set|drop <section> …`. Where it and the code disagree, the code is right.

The bridge lets sessions inspect and drive web pages and desktop apps while showing a live preview. The server now runs in a separate process and sends bridge requests to Electron's main process, where windows, debugger access, and native app controls remain. CDP actions are shared, while window and native app operations depend on the desktop platform.

## Where to change what

- **Bridge tools and calls:** server/bridge.ts, desktop/bridge.ts
- **Web page driving:** desktop/bridge.ts, server/cdp.ts
- **Bridge lifetime and takeover:** server/bridgeState.ts, desktop/bridge.ts
- **Electron app driving:** desktop/apps.ts, server/cdp.ts
- **Native app control:** desktop/apps.ts, desktop/linuxApps.ts
- **Linux app discovery:** desktop/desktopEntries.ts, desktop/linuxApps.ts
- **Component screenshots:** desktop/capture.ts

## How it works

- **Drive a web page:** A session calls a bridge tool defined in server/bridge.ts. → The server sends the request to Electron's main process over the host message channel. → desktop/bridge.ts opens or reuses a hidden window for the channel. → server/cdp.ts drives the page through its debugger. → The bridge returns a scaled preview and updates bridge state.
- **Drive a desktop app:** The server sends the bridge request to Electron's main process. → desktop/apps.ts launches or finds the app. → Electron apps connect to the shared CDP driver; native apps use platform accessibility controls. → The app is captured for the bridge preview.
- **End a turn:** server/bridgeState.ts starts a short grace period. → A following turn can reuse what the channel holds. → Otherwise the bridge closes it unless the user has taken it over.

## Key files

- server/bridge.ts — defines bridge tools, calls, results, and harness briefings
- desktop/bridge.ts — handles bridge calls in Electron's main process using hidden windows and app control
- server/cdp.ts — drives pages through a small CDP connection interface
- server/bridgeState.ts — tracks channel takeover and delayed closure
- desktop/apps.ts — launches and controls Electron and native desktop apps
- desktop/linuxApps.ts — controls Linux native apps through desktop windows and accessibility
- desktop/desktopEntries.ts — resolves Linux apps from desktop entries
- desktop/capture.ts — captures project components in a hidden browser window

## Rules and traps

- Keep the CDP driver independent of Electron, sessions, and the config directory; each connection supplies the CdpLink interface.
- Electron bridge operations must run in the main process; the separate server requests them over the host message channel.
- Bridge windows and launched apps belong to a channel and close after its turn's grace period unless the user has taken over.
- Bridge actions return a scaled preview rather than the full capture.
- Component capture rejects blank targets and follows links to find selectors; it does not click unknown buttons.

## What it talks to

- Shared protocol — supplies bridge state and server message types.
- Sessions — invoke bridge tools and determine when a channel's turn ends.
- Agent runtimes — receive bridge tools through MCP or HTTP briefings.
- Desktop shell — handles server bridge requests over the host message channel and supplies Electron windows, debugger access, and capture.
- Project knowledge — uses desktop component capture during screenshot sweeps.
