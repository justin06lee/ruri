# Component library

Every piece of this project's interface ruri has on file: the user's own
name for it, its handle, its files, and a picture. When the user names
something here, this is what they mean — go straight to its files rather
than searching for their words. Before building interface, look here
first and reuse what exists: `ruri show <slug>` reads one with its code,
`ruri add <slug>` copies it into place, `ruri help` says the rest.

ruri maintains this file. Don't edit it by hand; it is rewritten whenever
the library changes.

## devices-settings — the devices settings
Settings → Devices: share this computer (on/off, where it's reached, an invite's six words, paired devices with unpair) and, in the desktop app, your other computers found on makima/Tailscale/the LAN — Set up over SSH (password only if asked, install if missing) or pair by six words — and which computer this window is onto. Server half: server/sharing.ts; window half: window.ruriShell (desktop/preload.ts, desktop/peers.ts, desktop/sshSetup.ts).
Its files: web/src/components/Devices.tsx, web/src/lib/shell.ts
Reaches into: web/src/components/Settings.tsx, web/src/styles.css
Tags: settings, devices, sharing, remote
Screenshots, newest first (read them if you need to see it): /home/justin06lee/.config/ruri/uploads/15a631ca-b1eb-4930-98b7-095b54cacfde-shot-48.png, /home/justin06lee/.config/ruri/uploads/1578a3e8-c7e0-433c-ab40-467c17b5b498-shot-8.png

## cant-reach-page — the can't-reach page
What the window shows when the computer it is onto can't be reached or has unpaired it: which computer, its addresses, Try now / Use this computer instead. A data: URL page from the shell — no server behind it.
Its files: desktop/offline.ts
Tags: offline, remote, devices, page
Screenshots, newest first (read them if you need to see it): /home/justin06lee/.config/ruri/uploads/d426a70f-e6f7-4d0e-94e0-edcea15fcebb-mcp-bridge-blob-1790900483943-er5dvl.png, /home/justin06lee/.config/ruri/uploads/fd65fbdc-040b-4dd7-b994-0d75ed975a22-mcp-bridge-blob-1790899846674-zbf4yo.png
