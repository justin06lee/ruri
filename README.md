<div align="center">

<img src="assets/ruri.png" alt="ruri" width="340" />

# ruri

**One desktop workspace for all your projects — each with its own live Claude Code session.**<br>
*A folder-organized sidebar on the left, a real Claude Code session on the right.*

</div>

---

ruri is a macOS desktop app (Electron). Sessions run through [`@justin06lee/yagami`](https://github.com/justin06lee/yagami)'s `AgentSession` (the Claude Agent SDK pointed at your installed, signed-in `claude` CLI, `claude_code` system prompt preset, terminal parity) — so behavior, settings, CLAUDE.md, skills, hooks, and login are identical to your terminal, just with one UI over all of them. Sessions stay warm per project: switch projects instantly while agents keep working in the background, with activity dots in the sidebar. Closing the window keeps sessions alive (the Dock icon reopens it); ⌘Q quits and tears them down.

## Run it

```sh
make            # build → install ruri.app to /Applications → launch
make update     # stop the running app, rebuild, reinstall, relaunch
```

Requires a signed-in Claude Code CLI (yagami comes from npm as `@justin06lee/yagami`). The packaged app bundles the whole backend into one file and ships no node_modules; the Claude engine is your installed `claude` binary, resolved at runtime (with your login shell's PATH, so tools inside sessions behave like your terminal).

For development:

```sh
bun install
bun run dev       # browser mode: server on :7777, UI at http://localhost:5173
bun run desktop   # run the desktop app unpackaged (built UI + Electron)
```

## What it does

- **Native desktop app** — `ruri.app` with Dock icon, single-instance, inset title bar; the window serves the UI and WebSocket from one local port picked at launch.
- **Home — the workspace agent.** The default view (and the pinned Home row) is a Claude Code session that manages the app itself: tell it "today let's work on X, Y, Z" and it finds the matching directories under your workspace root, opens them in the sidebar via its `open_project` MCP tool, and can kick each session off with a delegated first prompt. The workspace root is configurable from the Home view; deep work happens in each project's own session, Home just orchestrates.
- **Manga look** — Space Grotesk type, pure black-and-white UI on warm paper (deliberately low blue channel, e-ink vibes): ink borders, screentone shading, hard offset shadows, grayscale syntax highlighting that leans on weight and slant instead of hue. Statuses are shapes, not colors: filled pulse = working, thick ring = waiting on permission, diamond = error/unread.
- **Projects sidebar** with optional group labels and status dots (filled pulse = working, thick ring = waiting on a permission, diamond = error/unread). Projects are opened by asking Home (any path works, not just the workspace); remove with the x on hover.
- **One persistent Claude Code session per project** (streaming input, so you can send follow-ups mid-run to steer). Sessions start lazily on first message, run in the project's directory, and auto-restart with `resume` if they die — context carries over.
- **Streaming responses** rendered as markdown (GFM, syntax-highlighted code blocks with copy buttons), tool-use chips (`Bash — npm test`), and per-turn result lines with duration and what the turn would have cost at API prices.
- **Permission prompts**: when Claude Code would ask in the terminal, ruri shows an Allow / Always allow / Deny card instead (your `~/.claude/settings.json` allow-rules apply exactly as in the CLI; "Always allow" persists the CLI's own suggested rule). Plan-mode approvals render the plan as markdown.
- **Per-project model and permission mode** in the chat header — pick any model the CLI reports, and switch between ask-first / accept-edits / plan / bypass, live mid-session; both persist per project.
- **Interrupt** button to stop a running turn, and a transcript that follows output only while you're at the bottom (jump-to-latest pill otherwise).
- **Music player** in the sidebar (ported from [home](../home)): drop folders of tracks into `~/Music/ruri` (override with `RURI_MUSIC_DIR`) — each folder is a playlist, loose files are "Unsorted". Two-deck Web Audio engine with 6s equal-power crossfade, shuffle, seek, volume; tracks stream from ruri's own server with Range support.
- **Dark mode** — proper dark: black and dark-gray surfaces, white ink, gray borders; sun/moon toggle in the sidebar, persisted per machine.
- **Feature tracker** — the same small model watches each turn and extracts new user-visible features/changes into a per-project checklist (drawer via the header button; it pops open when new items land), so nothing from a long prompt gets forgotten. Click a box to cycle open → liked (check) → needs-work (x); add notes about what to fix, add your own items or background prompts, and send any item straight into the composer as a prompt. Persists in `~/.config/ruri/tracker/`.
- **Turn memory & instant compaction** — after every finished turn, a small model (Haiku through yagami's completions client, `RURI_SMALL_MODEL` to override, `RURI_NO_MEMORY=1` to disable) writes a terse recall note for that prompt/response pair. With compact history on (toggle in the chat header), older turns fold to their notes; clicking one pulls the full turn back. Because notes are precomputed per turn, "compaction" costs nothing at read time. Transcripts, notes, and the resumable session id persist in `~/.config/ruri/sessions/`, so history and context survive app restarts.

## Architecture

```
ruri.app (Electron)
  ├─ main process: startServer() in-process        ─┐
  │    └─ yagami AgentSession → Agent SDK           ├─ one WebSocket + static UI
  │       → your installed claude CLI               │  on one localhost port
  └─ renderer: React + Vite + zustand (dist-web)   ─┘  (shared/protocol.ts)
```

- `server/server.ts` — importable `startServer()`: WebSocket hub + static file serving for the built UI; snapshot on connect, broadcasts events/deltas/statuses/permissions, handles client commands.
- `server/manager.ts` — the Home agent: an in-process MCP server (`open_project`, `list_projects`) plus a workspace-manager system prompt, layered onto a normal session at the workspace root.
- `server/sessions.ts` — per-project session lifecycle on yagami's `AgentSession` (warm process, terminal parity, `appName: "ruri"`): SDK message → transcript event translation, permission plumbing (with the CLI's suggested "always allow" rules), model/permission-mode switching, resume-on-restart.
- `server/index.ts` — standalone entry for dev/smoke (same server, no Electron).
- `desktop/main.ts` — Electron main: login-shell PATH recovery, window/menu/lifecycle; esbuild bundles it together with the server, yagami, and the Agent SDK into a single file (`scripts/build-main.ts`).
- `web/src/store.ts` — zustand store fed by the socket; drafts (streaming text) are kept separately from finalized transcript events.
- `web/src/markdown.tsx` — marked + DOMPurify + highlight.js markdown renderer shared by messages, streaming drafts, and plan cards.
- Projects persist in `~/.config/ruri/projects.json`. Chat transcripts are in-memory for now (Claude Code's own session files in `~/.claude` persist, and sessions resume across restarts).

## Testing

```sh
bun run typecheck && bun run build   # no tokens; build produces dist-app/mac-arm64/ruri.app
bun run smoke                        # live E2E: 3 real turns incl. Bash + permission round-trip

# same E2E against the packaged app (Finder-style stripped PATH recommended):
RURI_SMOKE_SPAWN="dist-app/mac-arm64/ruri.app/Contents/MacOS/ruri" bun run smoke
```

For UI work there's a token-free fixture mode — canned transcript, pending permission, folder groups: open `http://localhost:5173/?fixture` in dev, or `RURI_FIXTURE=1` (with `RURI_SCREENSHOT=/path.png`) for the desktop app. If the installed ruri.app is running, add `RURI_USER_DATA=/tmp/ruri-dev` so the dev instance doesn't lose the single-instance lock to it.

## Not yet (iterate next)

A custom in-app file finder (replacing the native picker entirely), tool results/diffs in the transcript, effort controls, session history browser, drag-and-drop folder management, git status in the sidebar, worktree support for parallel agents in one repo, notifications, Windows/Linux packaging.
