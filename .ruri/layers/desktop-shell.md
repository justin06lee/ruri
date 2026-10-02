# ruri — Desktop shell

One layer of ruri's stack, owning `desktop/main.ts, desktop/permissions.ts, desktop/serverProcess.ts, desktop/remote.ts, desktop/preload.ts, desktop/offline.ts, desktop/peers.ts, desktop/sshSetup.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer desktop-shell` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer desktop-shell add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer starts the Electron desktop app, creates its window, and connects it to this computer's server — or, onto another computer, to that one's, with no server here at all. It finds the user's other computers, sets them up over SSH and pairs, and reads and requests platform permissions. A newcomer should account for the limited PATH of GUI-launched apps, a Linux host with no display, and on macOS permissions tied to the app's code signature.

## Where to change what

- **App startup and window lifecycle:** desktop/main.ts
- **Platform permission status and requests:** desktop/permissions.ts
- **GUI launch PATH recovery:** desktop/main.ts
- **Server process start, restart and quit:** desktop/serverProcess.ts, desktop/main.ts
- **Using another computer: reaching it, pinning its certificate, the can't-reach page:** desktop/remote.ts, desktop/offline.ts, desktop/main.ts
- **Finding the user's computers and setting one up over SSH:** desktop/peers.ts, desktop/sshSetup.ts
- **What the page may ask the shell (window.ruriShell):** desktop/preload.ts, desktop/main.ts
- **ruri --serve, --invite, --quit and the headless restart:** desktop/main.ts

## How it works

- **Launch:** main.ts fixes PATH and waits for Electron → serverProcess.ts forks server.mjs and sends it the port, token and static dir → the server answers ready with its port → main.ts opens the window on it
- **Onto another computer:** remote.json names the host → no local server starts → remote.ts reach races its addresses under the pinned certificate → the window loads https://address:port/?token=key → a check every 15 s; two misses race the addresses again or show the can't-reach page
- **Set up over SSH:** Settings asks ruri:setup → sshSetup.ts runs ssh … sh -s with the host script → the far side finds or builds ruri, starts it as a service, asks its local port for a pairing → remote.ts adopt pins it → the window leaves the local page, the local server stops, the window opens on the host

## Key files

- desktop/main.ts — Electron entry point for the window, the desktop bridge, the shell's services and app lifecycle; it forks the server rather than running it
- desktop/permissions.ts — macOS permission checks, requests, and privacy database rows
- desktop/serverProcess.ts — forks the server as a utility process, answers its calls for shell services, forwards bridge state, restarts it if it dies
- desktop/remote.ts — paired computers (remote.json), certificate pinning, word pairing, reaching a host
- desktop/peers.ts — the user's computers from makima's socket, Tailscale's CLI and a LAN broadcast, each probed for ruri
- desktop/sshSetup.ts — the host script and the ssh run that sets a computer up and pairs, no code
- desktop/preload.ts — window.ruriShell, bundled to CommonJS on its own

## Rules and traps

- GUI-launched apps can lack CLI install directories in PATH; desktop/main.ts recovers the user's login-shell PATH so session commands can find their tools.
- macOS grants are tied to the app's code signature. A newly signed build can lose effective grants even while System Settings shows them enabled.
- Permission state is read from the system rather than inferred from whether a request was made.
- A device onto another computer runs no server or harness of its own; switching stops every chat here, and the window leaves the local page first — server.close() waits on the window's open connection.
- With no DISPLAY or WAYLAND_DISPLAY, main() re-execs itself with --ozone-platform=headless; Chromium picks its platform before appendSwitch could change it.

## What it talks to

- Server transport — desktop/serverProcess.ts forks server/desktopServer.ts and talks to it through server/hostLink.ts messages
- Bridge — desktop/main.ts imports the desktop Bridge and captureTargets
- Shared protocol — window drag and permission types come from the shared protocol
