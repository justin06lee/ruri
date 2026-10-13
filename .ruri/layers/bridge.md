# ruri — Bridge

One layer of ruri's stack, owning `server/bridge.ts, server/cdp.ts, server/bridgeState.ts, desktop/bridge.ts, desktop/capture.ts, desktop/apps.ts, desktop/linuxApps.ts, desktop/desktopEntries.ts, desktop/desktopEntries.test.ts, desktop/main.ts, desktop/remote.ts, desktop/sshSetup.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer bridge` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer bridge add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer lets an agent session see and drive what it built in a hidden window: web pages via the DevTools protocol (CDP) and native apps via CDP (Electron) or the Accessibility tree. It is built as a shared CDP driver in server/cdp.ts plus a tool definition in server/bridge.ts, with Electron-only hands in desktop/bridge.ts, desktop/apps.ts, and desktop/capture.ts. The key idea: the model never touches the user's screen — it gets scaled previews beside the composer while the real window stays hidden and auto-closes after the turn.

## Where to change what

- **Hidden web page driving (web_open, click, type, screenshot):** server/cdp.ts, desktop/bridge.ts, server/bridge.ts
- **Bridge tool definitions and MCP/HTTP briefing:** server/bridge.ts
- **Native/Electron app launch and driving:** desktop/apps.ts, desktop/bridge.ts, server/cdp.ts
- **Scaled previews above composer:** desktop/bridge.ts, server/bridgeState.ts
- **Window lifetime and auto-close after turn:** server/bridgeState.ts, desktop/bridge.ts
- **Component screenshot sweep (selector rectangles):** desktop/capture.ts, server/cdp.ts
- **Linux native apps (.desktop lookup, X11 windows and captures, AT-SPI tree and app_ui Python helpers):** desktop/linuxApps.ts, desktop/desktopEntries.ts

## How it works

- **Drive a hidden web page:** Agent calls bridge tool defined in server/bridge.ts → desktop/bridge.ts creates hidden window on first web_open → PageDriver in server/cdp.ts sends CDP verbs over CdpLink (debugger link) → Action result returns scaled preview, not full capture → BridgeState in server/bridgeState.ts schedules close BRIDGE_GRACE_MS after turn ends unless taken over
- **Drive a desktop app:** desktop/apps.ts launches Electron with remote-debugging-port or native app with open -g → Electron apps driven over CdpSocket with same PageDriver; native apps driven via Accessibility tree (System Events) → Photographed off window server / compositor without stealing focus → desktop/bridge.ts returns preview and handles quit on session end
- **Capture component targets:** desktop/capture.ts loads project page in hidden window → Finds each selector and captures rectangle around it → Refuses blank/collapsed captures → Walks app links (never buttons) to find missing selectors

## Key files

- server/cdp.ts — shared CDP driver (CdpLink, CdpSocket, PageDriver) knowing nothing about Electron or sessions
- server/bridge.ts — bridge tool definitions, runBridge, MCP/HTTP briefings
- desktop/bridge.ts — Electron half: hidden per-channel windows, previews, takeover handling
- desktop/apps.ts — background app launch (Electron over CDP, others over Accessibility) and native capture
- server/bridgeState.ts — per-channel takeover state and grace-period auto-close after turns
- desktop/capture.ts — hidden-window selector screenshot sweep for the component library
- desktop/linuxApps.ts — Linux native side: launch without focus (_TIME0 startup id), xdotool windows, X11 captures, AT-SPI over D-Bus from an embedded Python prelude
- desktop/desktopEntries.ts — .desktop entry parsing, Exec field codes, app lookup by id/name/command (pure, tested)

## Rules and traps

- Nothing in server/cdp.ts may know about Electron, sessions, or the config dir — it stays exercisable without a window.
- Never show or activate the driven window: native apps launch with open -g on macOS and a _TIME0 startup id on Linux; a launched Electron app is watched 10s (keepBehind) and handed back whenever its process group is in front, since its window shows on ready-to-show long after attach. Capture works from behind ruri.
- Return scaled previews to the model, not full captures.
- Hidden windows/apps auto-close a few seconds after the turn ends unless the user took them over; never leave renderers running.
- In capture sweeps, follow links only — never click unknown buttons.
- Never pin a blank/collapsed screenshot to a component entry.

## What it talks to

- Desktop shell — owns the visible window, permissions/TCC, and hidden bridge windows that desktop/bridge.ts drives
- Protocol — BridgeState type and server messages for previews/takeover live in shared/protocol.ts
- Library, skills and sweeps — server/shots.ts starts dev servers and wraps desktop/capture.ts
- Agent harnesses — expose server/bridge.ts tools in-process (Claude bridge MCP server) so every harness gets the same verbs
- Management: agents, skills and tracking — Bridge preview UI beside the composer and takeover button
