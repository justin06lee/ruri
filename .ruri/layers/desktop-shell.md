# ruri — Desktop shell

One layer of ruri's stack, owning `desktop/main.ts, desktop/permissions.ts, desktop/serverProcess.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer desktop-shell` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer desktop-shell add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer starts the Electron desktop app, creates its window, and connects it to the server and desktop bridge. It also reads and requests platform permissions. A newcomer should account for the limited PATH of GUI-launched apps and, on macOS, permissions tied to the app’s code signature.

## Where to change what

- **App startup and window lifecycle:** desktop/main.ts
- **Platform permission status and requests:** desktop/permissions.ts
- **GUI launch PATH recovery:** desktop/main.ts
- **Server process start, restart and quit:** desktop/serverProcess.ts, desktop/main.ts

## How it works

- **Launch:** main.ts fixes PATH and waits for Electron → serverProcess.ts forks server.mjs and sends it the port, token and static dir → the server answers ready with its port → main.ts opens the window on it

## Key files

- desktop/main.ts — Electron entry point for the window, the desktop bridge, the shell's services and app lifecycle; it forks the server rather than running it
- desktop/permissions.ts — macOS permission checks, requests, and privacy database rows
- desktop/serverProcess.ts — forks the server as a utility process, answers its calls for shell services, forwards bridge state, restarts it if it dies

## Rules and traps

- GUI-launched apps can lack CLI install directories in PATH; desktop/main.ts recovers the user's login-shell PATH so session commands can find their tools.
- macOS grants are tied to the app's code signature. A newly signed build can lose effective grants even while System Settings shows them enabled.
- Permission state is read from the system rather than inferred from whether a request was made.

## What it talks to

- Server transport — desktop/serverProcess.ts forks server/desktopServer.ts and talks to it through server/hostLink.ts messages
- Bridge — desktop/main.ts imports the desktop Bridge and captureTargets
- Shared protocol — window drag and permission types come from the shared protocol
