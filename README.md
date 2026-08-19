# ruri 瑠璃

One workspace for all your projects — each with its own live Claude Code session.

A folder-organized sidebar of projects on the left; a chat pane driving a real Claude Code session on the right. Sessions run through [yagami](../yagami)'s `claudeCodeSession` (the Claude Agent SDK pointed at your installed, signed-in `claude` CLI with the `claude_code` system prompt preset), so behavior, settings, CLAUDE.md, and login are identical to your terminal — just with one UI over all of them. Sessions stay warm per project: switch projects instantly while agents keep working in the background, with activity dots in the sidebar.

## Run it

```sh
pnpm install
pnpm dev        # server on :7777, UI at http://localhost:5173
```

Requires the sibling `../yagami` repo (linked as a file dependency, pre-built `dist/`) and a signed-in Claude Code CLI.

## What v1 does

- **Projects sidebar** with optional folder grouping, add/remove, status dots (blue pulse = working, amber = waiting on a permission, red = error, ring = unread activity in a background project).
- **One persistent Claude Code session per project** (streaming input, so you can send follow-ups mid-run to steer). Sessions start lazily on first message, run in the project's directory, and auto-restart with `resume` if they die — context carries over.
- **Streaming responses** (token deltas), tool-use chips (`Bash — npm test`), and per-turn result lines with duration and what the turn would have cost at API prices.
- **Permission prompts**: when Claude Code would ask in the terminal, ruri shows an Allow/Deny banner instead (your `~/.claude/settings.json` allow-rules apply exactly as in the CLI).
- **Interrupt** button to stop a running turn.

## Architecture

```
web/      React + Vite + zustand UI            ─┐
                                                ├─ one WebSocket (shared/protocol.ts)
server/   Node: SessionManager + ws server     ─┘
            └─ yagami claudeCodeSession → Claude Agent SDK → your installed claude CLI
```

- `server/sessions.ts` — per-project session lifecycle: async input queue, SDK message → transcript event translation, permission callback plumbing, resume-on-restart.
- `server/index.ts` — WebSocket hub: snapshot on connect, broadcasts events/deltas/statuses/permissions, handles client commands.
- `web/src/store.ts` — zustand store fed by the socket; drafts (streaming text) are kept separately from finalized transcript events.
- Projects persist in `~/.config/ruri/projects.json`. Chat transcripts are in-memory for v1 (Claude Code's own session files in `~/.claude` persist, and sessions resume across server restarts).

## Testing

```sh
pnpm typecheck && pnpm build:web   # no tokens
pnpm smoke                         # live E2E: 3 real turns incl. Bash + permission round-trip
```

## Not in v1 (iterate next)

Markdown rendering, tool results/diffs in the transcript, plan-mode & model/effort controls, transcript persistence, session history browser, drag-and-drop folder management, git status in the sidebar, worktree support for parallel agents in one repo, desktop shell (Tauri/Electron wrapper around this exact server + UI), notifications.
