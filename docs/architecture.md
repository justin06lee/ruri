# Architecture

```
ruri.app (Electron)
  ├─ main process: startServer() in-process        ─┐
  │    └─ yagami AgentSession → Agent SDK           ├─ one WebSocket + static UI
  │       → your installed claude CLI               │  on one localhost port
  └─ renderer: React + Vite + zustand (dist-web)   ─┘  (shared/protocol.ts)
```

One HTTP server carries everything: `GET /healthz`, `GET /music/playlists`, `GET /music/track?p=…` (Range-capable), `GET /uploads/<file>`, the built UI on every other GET, and the WebSocket on the same port. `shared/protocol.ts` is the single wire contract — every client command and server message is a variant of `ClientMessage`/`ServerMessage`.

**Server**

- `server/server.ts` — importable `startServer()`: WebSocket hub + static file serving for the built UI; snapshot on connect, then statuses, permissions and finished turns to every window — but a chat's conversation as it happens (a reply's paragraphs, tool calls, agents at work, the turn's counter) only to the windows that have that chat on screen (the `view` message); a chat opened again is sent whatever it missed, and nothing at all if nothing changed. Handles client commands, owns the model-probe cache and the app-side prompt queue (visible queued prompts and silent split sub-prompts alike).
- `server/sessions.ts` — per-session lifecycle. Claude sessions ride yagami's `AgentSession` (warm process, terminal parity, `appName: "ruri"`): SDK message → transcript event translation, permission plumbing (with the CLI's suggested "always allow" rules), model/permission-mode switching, resume-on-restart. A chat's agent process closes, silently, the moment it has nothing left to do: its turn over, nothing of its own running in the background, and the chat not open in the window — after a 3-second grace (`RURI_REAP_GRACE_MS`) that lets a queued prompt or an auto-retry claim it first. So a chat that finishes while you are looking elsewhere closes on its own, and an open chat's closes when you leave it (or after sitting idle ten minutes with it open, `RURI_IDLE_REAP_MS`). Work in the background (a subagent, a shell the model left running) holds the process for as long as it runs, and its end is what lets it go — not a timer. The next prompt resumes the same conversation from its session id, exactly as after a relaunch. Subagents are read off the stream as it comes: Claude sessions run with `forwardSubagentText` (and deliberately without `agentProgressSummaries`, which would fork every agent every 30 seconds to describe it), so every message with a `parent_tool_use_id` goes to that agent's log and the `task_*` messages move its card (`AgentBook`); Codex agents are matched to their card by the thread their `spawn_agent` call names. Non-Claude models route to `ProviderAgentSession`: yagami's agentic session layer (`openSession` — Codex app-server, ACP), the harness verbatim with tool chips and approval cards; `ProviderTurnSession` (one sandboxed `provider.run()` per turn) remains as the fallback for providers without it. Both use provider-prefixed resume ids streamed into the same events.
- `server/agents.ts` — `AgentLogs`: each subagent's own log, apart from the chat that started it — written on a debounce, held in memory only while writes are pending, capped at its newest 1500 events, and gone with its chat. `Crew`: the agents the user starts from a chat's agents page — each card and the harness session a follow-up resumes, one `@crew.json` per chat beside the logs; they run on a `SessionManager` of their own in server.ts, keyed by their card's key, so nothing that watches the chats (status, sidebar, queue, retries, recall notes) ever sees them.
- `server/paragraphs.ts` — `ParagraphGate`: holds a streamed reply back until a paragraph is finished (a blank line, or a code block closing) before it goes to the window, so a reply arrives a paragraph at a time rather than a token at a time.
- `server/finder.ts` — finding a project folder by the name a person uses for it: walks the workspace root, scores folder names against what was said, prefers folders that look like projects. Behind Home's `find_project` tool.
- `server/ledger.ts` — `LedgerStore`: what each project has spent, by the day — tokens, dollars at API prices, turns, wall time — added to as results land and never pruned. Behind the board's figures.
- `server/recent.ts` — the chats that happened outside ruri: lists a project's Claude and Codex session files by working directory, and reads one into transcript events for import.
- `server/manager.ts` — the Home agent: an in-process MCP server (`find_project`, `open_project`, `new_project`, `hide_project`, `unhide_project`, `close_project`, `list_projects`) plus a workspace-manager system prompt, layered onto a normal session at the workspace root. Non-Claude harnesses get the same duties via a system-prompt-described drop file (`.ruri/open.jsonl`) drained at end of turn.
- `server/homelog.ts` — Home's write-ahead log: appends each Home event as a greppable one-liner under numbered, dated SESSION headers; the model reads it (via search), never writes it.
- `server/providers.ts` — `ProviderRegistry` over yagami's provider layer: detects the installed harnesses once at startup (honouring `~/.config/yagami/config.json`), lists their models for the picker as `provider:model` ids, and builds per-project provider instances working in the project directory.
- `server/projects.ts` — `ProjectStore`: projects, their sessions, and the device-wide settings (workspace root, music dir, Home's model/mode, starred models, the small-tasks model), persisted to `projects.json`.
- `server/archive.ts` — `SessionArchive`: transcript events, per-turn recall notes, the resumable session id, and a pending compaction brief per session, debounce-written to disk (compact JSON, written beside and renamed over). The source of truth behind the connect snapshot — which carries only the last few events of each chat; a chat asks for the rest when it opens (`transcript_get`), and the window keeps a handful whole at a time — and `/compact`. Each transcript is two files: the live part from the newest compaction mark (`sessions/`), and the history before it (`history/`, JSON Lines, appended to by a compaction and read only for a rewind or fork reaching back past the mark, a brief, or an earlier exchange opened in full — the chat itself gets an outline of it, a line per exchange, cached until the file changes). An archive from before the split is split once, the first time it is loaded; the history is capped at 16 MB (`RURI_HISTORY_MAX_BYTES`), oldest exchanges first.
- `server/commands.ts` — slash commands inside a prompt: which names count (ruri's own, the harness's, every installed skill and custom command), the lift that runs them ahead of the prompt they were written in, and the described list the composer's menu offers.
- `server/checkpoints.ts` — ruri's own file checkpoints: the working tree as a hidden git commit before every prompt, on every harness, and the restore a rewind uses.
- `server/compaction.ts` — ruri's own `/compact`: writes each exchange's full record and attachment paths to `turns/<session>/NNN.md` and builds the model-facing brief out of the precomputed recall notes as prompt/reply pairs, one file hook per exchange. No model call — it's instant. The brief lists at most 40 exchanges (`RURI_BRIEF_LISTED`); older ones are folded into the **digest**, one condensed memory the small model keeps (`DigestFolder`, run in the background after each reply's note and when a chat opens — each fold takes the list back to 30). The brief opens on it and names the record files it covers, so nothing folded away is out of reach.
- `server/smallmodel.ts` — the small-tasks layer over yagami's completions client: prompt and reply recall notes, session role titles, prompt splitting, tracker extraction, plus `TurnTracker`, which assembles prompt→result turns out of the event stream.
- `server/tracker.ts` — `TrackerStore`: the per-session feature checklist, auto-extracted or hand-added.
- `server/uploads.ts` — attachment intake (images, videos, arbitrary files): base64 in, files under `uploads/` and small URLs in the transcript, region crops expanded into extra model-visible images, non-image files referenced by path in the prompt. Also the sweep that removes uploads nothing mentions any more (after a day's grace), at launch and twice a day.
- `server/orphans.ts` — the launch sweep for what closed sessions and projects left behind (an archive, a history, turn records, bridge screenshots, a checkpoint index), read against projects.json itself; nothing goes unless that file reads cleanly, and nothing touched in the last ten minutes.
- `server/usage.ts` — the account limit windows behind the dragon gauges: Claude's from the OAuth usage endpoint (token from the keychain, or the credentials file), Codex's from the `token_count` entries in its session rollouts, each with the percentage used and when the window resets. Polled every five minutes and after every turn, cached to `usage.json` so a relaunch opens on the last good reading; all best-effort — an unreadable source just leaves that harness's gauges empty.
- `server/music.ts` — the music library scan (folder = playlist, loose files = "Unsorted") and the path allowlist for the track route.
- `server/index.ts` — standalone entry for dev/smoke (same server, no Electron).

**Desktop & UI**

- `desktop/main.ts` — Electron main: login-shell PATH recovery (async, alongside Electron's own start-up), window/menu/lifecycle — a quit waits up to five seconds for the bridge and the server to close so debounced transcript writes land; new windows and navigations off the app's origin are denied and sent to the default browser (http, https and mailto only) — the native folder picker, and the cursor poll that drives the titlebar peek hover; esbuild bundles it together with the server, yagami, and the Agent SDK into a single file (`scripts/build-main.ts`).
- `desktop/permissions.ts` — the nine macOS grants ruri uses, each read as macOS holds it, asked for by hand from Settings, and — for an ad-hoc-signed build only — asked for again on the first launch of a new build (`docs/permissions.md`).
- `web/src/store.ts` — zustand store fed by the socket; drafts (a reply in progress, arriving a paragraph at a time) are kept separately from finalized transcript events. It tells the server which chats are on screen (`watchChannel`, `watchBoard`; nothing while the window is hidden), and a chat sent whole again keeps every unchanged event as the same object, so catching up re-renders only what moved.
- `web/src/components/ChatPane.tsx` — the chat pane itself: resolves the channel and project, watches it, and mounts a `ChatView` keyed by the channel so every per-chat piece of state resets by construction when you switch. The parts it used to hold in one file are their own now: `Exchange.tsx` (turn grouping, folding and compaction marks), `EventView.tsx` (one event: prompt, reply, tool chip, result line), `Composer.tsx` (the prompt box, attachments, model and effort picks), `Queue.tsx` (the drag-reorderable prompt queue), `PermissionBanner.tsx` (permission and question cards), `SessionControls.tsx` (the header's buttons), `AgentsPage.tsx` (the agents list and an agent's own conversation), `Confirm.tsx` (the in-app confirm card that replaced `confirm()` and `alert()`), and `components/chat/` for the icons, agent card and empty states they share. A long session is kept cheap to switch into: the tail paints first and the rest fills in on idle frames, every re-bottoming folds into one layout read per frame, and every turn above the last four gets `content-visibility` so the browser lays out what you're looking at rather than the whole history.
- `web/src/components/RapidFire.tsx` — rapid fire: the client-side line of prompt-ready sessions, the hand-off timing, and the header bar. It renders no pane of its own — the chat pane takes the session it picks.
- `server/brief.ts` — the catch-up brief: the store (per project), and the `.ruri/catchup.md` it writes into each project — description, features, stack, how to run, layout, conventions.
- `server/catchup.ts` — the brief written whole: reads a repo the way a person joining it would and has the small model write every section at once. Runs for a project that arrives without a brief, and on request.
- `server/briefing.ts` — what every project session is told about ruri before it starts: the catch-up file, the component index, the vault. Pointers, never contents — none of it costs a token until the model opens it.
- `web/src/components/Ideas.tsx` / `server/ideas.ts` — the ideas board.
- `web/src/components/Components.tsx` / `web/src/components/NameCard.tsx` / `server/components.ts` — the component index, the naming card and its screenshot, the tool and drop file the model registers through, the `.ruri/components.md` it writes, and the entries it hands to a prompt that names one.
- `server/sweep.ts` / `server/shots.ts` / `desktop/capture.ts` — the repo sweep: which files are worth reading and what the small model is given of each (the top of it, what it exports, every class it sets), then the project's dev server started and stopped around a hidden window that finds each selector and captures its rectangle.
- `server/bridge.ts` / `desktop/bridge.ts` / `server/cdp.ts` / `desktop/apps.ts` / `web/src/components/Bridge.tsx` — the bridge: the tool definitions and their two faces (in-process MCP server `bridge` for Claude, `POST /bridge/<channelId>` for every other harness) and the session briefings, in `server/bridge.ts`; the harness-neutral DevTools-protocol driver (find/click/type/press/scroll/screenshot/logs/wait, over either Electron's `webContents.debugger` or a raw `ws` socket) in `server/cdp.ts`; the per-channel hidden windows, previews and take-over in `desktop/bridge.ts`; the macOS app launching, Accessibility UI scripting and window-server captures in `desktop/apps.ts`; and the preview strip above the composer in `web/src/components/Bridge.tsx`.
- `web/src/components/NameCard.tsx` — the card that asks what to call the thing the model just built.
- `server/secrets.ts` — the vault: storage, the environment it exports, the `{{handle}}` substitution, and the redaction that puts handles back.
- `web/src/components/Skills.tsx` / `server/skills.ts` — the skills page and the bmo/filesystem layer under it.
- `web/src/components/Terminal.tsx` / `server/terminal.ts` — the composer's shells: xterm.js over a pty, a row of tabs per channel, with the row persisted to `~/.config/ruri/terminals.json`.
- `web/src/tuner.tsx` / `web/src/peek.ts` — the art tuner and the placements it writes; the sidebar and the hero read the latter.
- `web/src/components/Dragon.tsx` / `web/src/dragonArt.ts` — the four gauges flanking the composer: the traced dragon art, the waterline that clips it, the reset countdowns, and the harness whose windows each session reads.
- `web/src/components/HomeBoard.tsx` — Home's tab strip (chat / projects) and the projects page: a card per project with live activity lines and its spend, and the head that adds every project up.
- `web/src/components/Sketch.tsx` — the sketch pad: a shapes-based canvas with pen, arrows, boxes, ellipses, placed text; saved as it is drawn; attaches to the prompt, or draws on an attached picture and puts it back.
- `web/src/components/CommandMenu.tsx` — the composer's `/` menu: every command that would run, found by typing.
- `web/src/components/Markers.tsx` — the composer's markers and commands as chips: a mirror of the prompt over the textarea, drag to move, click to open or take out.
- `web/src/components/Selection.tsx` — the selection flags: a draggable flag at each end of a transcript selection, with edge scrolling.
- `web/src/components/Sidebar.tsx` — Home and rapid-fire rows, project folders and their sessions, the peek skyline, the account bar.
- `web/src/components/Settings.tsx` — a page (it outgrew being a dialog), in groups: appearance, folders, the vault, and the searchable model catalog. The page is the only thing that scrolls — nothing inside it has its own scrollbar — and every value starts at the same left edge.
- `web/src/press.ts` — pointer capture on every pressable thing, so a press that starts on a button ends on that button however far the press animation moves it; a release well away from it still cancels.
- `web/src/lib/beat.ts` — the clocks for everything that moves by itself: the thinking doodle, the streaming cursor, an agent's ring — all of them in the open chat, and nothing anywhere else (the sidebar's and the Home board's status dots hold still). There are no infinite CSS animations anywhere in the app: each one had Chromium redraw the window at the display's rate, up to 120 frames a second, for as long as it was on screen. There is one clock per pace, and each ticks only as often as its movers actually change: the doodle and the cursor share a half-second clock, and the agent ring has its own at 15 steps a second (thirty to a turn, a turn every two seconds). A tick writes only the elements whose step changed, and each mover is its own compositor layer, so a step repaints nothing on the page. The clocks run only while ruri is awake (`lib/awake.ts`), and only for movers actually in view: an element scrolled out of the viewport or on a page that is not showing takes no steps, and snaps to the clock's current step when it comes back. Asleep, everything holds where it stands and every counting clock (`useNow`) waits. The music waveform and notes use the same gate at 15 Hz, the new-component star (`lib/spin.ts`) at 10, turning on its own layer.
- `web/src/lib/awake.ts` — whether anyone can see ruri: the window on screen and the one in use. Asleep — behind another app, minimised, hidden — nothing on it moves: the clocks stop where they stand and every running Web Animation pauses, to pick up on waking. That is all sleep is. State keeps flowing exactly as when awake: the server keeps sending live, every message applies the moment it arrives, transcripts and the board stay current, and the agents behind them are never touched — so the window is already right when you come back to it, and nothing has to catch up. `?awake` in the URL (`RURI_AWAKE=1` for the desktop app) keeps a window awake for scripts that drive it from behind.
- `web/src/components/Player.tsx` + `web/src/lib/audio.ts` — the sidebar player and its two-deck Web Audio engine.
- `web/src/components/Attachments.tsx` — composer thumbnails, the full-size viewer, and drag-to-annotate region crops.
- `web/src/markdown.tsx` — marked + DOMPurify + highlight.js markdown renderer shared by messages, streaming drafts, and plan cards. Finished text is cached by its own string, so a session you've read re-renders from HTML; a reply still being written skips the cache, since every prefix of it is thrown away, and only changes when a whole paragraph arrives, so the window re-renders a few times per reply instead of once per token.
- `web/src/fixture.ts` — the canned `?fixture` state used for token-free UI work.

## Where things live

All app state sits under `~/.config/ruri` (move it wholesale with `RURI_CONFIG_DIR`):

| Path | What |
|---|---|
| `projects.json` | Projects and their sessions, workspace root, music dir, Home's model/mode, starred models, small-tasks model, default model |
| `sessions/<sessionId>.json` | Transcript events since the newest compaction, per-turn recall notes, resumable session id, pending compaction brief |
| `history/<sessionId>.jsonl` | Every event before the newest compaction, one per line — capped at 16 MB, oldest exchanges dropped first |
| `turns/<sessionId>/NNN.md` | Full per-exchange records and preserved attachment paths `/compact` leaves for the fresh session to Read |
| `agents/<sessionId>/<key>.json` | What each subagent did — its brief, words and tools — for its card on the agents page; `@crew.json` beside them holds the agents you started yourself: their cards, and the session a follow-up resumes |
| `tracker/<sessionId>.json` | Feature-tracker checklist |
| `ideas/<projectId>.json` | The ideas board |
| `components/<projectId>.json` | The component index |
| `briefs.json` | Catch-up briefs, before they're written into their projects |
| `ledger.json` | What each project has spent, by the day — the board's figures |
| `secrets.json` | The vault, mode 0600. Values, and nothing that reads them but ruri |
| `prefs.json` | The window's own preferences: theme, the theme clock, unfolded folders, the player's volume |
| `terminals.json` | Which shell tabs each project had open |
| `home-log.md` | Home's write-ahead activity log, one block per Home session |
| `uploads/` | Attached images and videos |
| `bridge/<channelId>/` | The bridge's screenshots for a session (`shot-<n>.png`) and its live preview (`preview.png`) |

Inside each project ruri keeps a `.ruri/` folder, which ignores itself (one `.gitignore` saying `*`, so none of it shows up in your `git status`): `catchup.md` and `components.md` for whatever harness is working there, and `open.jsonl` at the workspace root for Home.

Everything else is yours and untouched: `~/.claude` (settings, CLAUDE.md, skills, hooks, the CLI's own session files) — except that turning a skill off in the Skills page moves its folder to `~/.claude/skills-off/` and back — `~/.codex/config.toml`, `~/.config/yagami/config.json`.

Environment variables:

| Variable | Effect |
|---|---|
| `RURI_CONFIG_DIR` | Where all app state lives (default `~/.config/ruri`) |
| `RURI_PORT` | Server port — the desktop app uses 7776 unless it's taken, the dev server 7777 |
| `RURI_MUSIC_DIR` | Music library root before Settings overrides it (default `~/Music/ruri`) |
| `RURI_REAP_GRACE_MS` | How long a finished chat nobody has open keeps its agent process before it closes (default 3000) |
| `RURI_IDLE_REAP_MS` | How long an open chat's agent process may sit idle before it closes anyway (default 600000, ten minutes) |
| `RURI_BRIEF_LISTED` | How many exchanges a compaction brief lists one by one before the oldest are folded into its digest (default 40) |
| `RURI_HISTORY_MAX_BYTES` | How big a session's history may grow before its oldest exchanges go (default 16 MB) |
| `RURI_SMALL_MODEL` | Small-tasks model when nothing is double-starred (default `haiku`) |
| `RURI_NO_MEMORY=1` | Turn the small-model layer off entirely |
| `RURI_FIXTURE=1` | Canned UI state instead of a live server |
| `RURI_SCREENSHOT=/path.png` | Capture the window to a PNG shortly after load |
| `RURI_USER_DATA` | Isolated Electron userData, so a dev run doesn't fight the installed app for the single-instance lock |
| `RURI_SMOKE_SPAWN` | What `bun run smoke` boots instead of the standalone dev server |

The workspace root defaults to `~/Workspace` when it exists, otherwise your home directory. Out of the box, Fable and Codex's default model come pre-starred.

## Security model

The app is a local server and one window on it; these are the lines it holds.

- **Loopback only.** The server binds `127.0.0.1` (port 7776 for the desktop app, 7777 for `bun run dev`); nothing listens on an interface another machine can reach.
- **A token per launch.** The server mints a random token when it starts and hands it to its own window. Every WebSocket connection carries it in `?token=`; a connection without the right token is refused (compared in constant time). The server also writes it to `<config dir>/token` (mode 0600, removed on close): under `bun run dev` the page fetches it from the Vite server's `/__token`, which reads that file and answers only same-origin requests, and the test scripts set `RURI_TOKEN` for the server they spawn. State-changing HTTP routes (uploads, the bridge, anything with a side effect) carry it in an `x-ruri-token` header; `GET` routes that serve the UI and its static files do not need it.
- **Origin pinned.** A connection's `Origin` header must be absent (a non-browser client, such as the test scripts) or the app's own origin (`http://127.0.0.1:<port>` or `localhost`, plus the Vite page's `localhost:5173` under `bun run dev`); a page on any other origin open in the same browser cannot open a socket to ruri.
- **The bridge is capability-keyed.** `POST /bridge/<id>` — the harness-neutral face of the bridge, for CLIs that cannot carry ruri's in-process MCP server — takes the session id as its capability: only a process ruri itself started with that id in its environment knows it.
- **Vault secrets never reach a terminal.** The vault's values are exported only into the environment of harness processes ruri spawns (`$RURI_SECRET_*`, and `{{handle}}` substitution at the tool boundary), redacted back out of the transcript by handle. The composer's shells (`server/terminal.ts`) are started without them.
- **The wire protocol is validated at the boundary.** Every `ClientMessage` off the socket is parsed with the zod schema in `shared/clientSchema.ts` before it is acted on — the schema is typed against `ClientMessage`, so a schema that drifts from `shared/protocol.ts` fails `tsc`; a message that does not match is dropped with an error to the sender, never partially applied.
- **Signed, not notarized.** The bundle is signed with a local self-signed identity (`ruri dev`, see `docs/permissions.md`) so macOS privacy grants survive rebuilds. There is no Apple developer account behind it, so it is not notarized; it is installed by `make`, never downloaded, and Gatekeeper is not involved.
- **A Content-Security-Policy on the built page.** `vite.config.ts` stamps a policy into the built `index.html`: scripts only from the app's own origin (the built page has no inline script), images and media from there or from `blob:`/`data:` URLs the page made itself, no plugins, no `<base>`, no form posts. A model's markdown cannot pull a script, a frame or a tracking pixel from anywhere else. The dev page goes without it, since Vite injects an inline preamble.
- **Dev-only endpoints check their caller.** The Vite dev server's tuner endpoints, which write `web/src/peek.ts` and PNGs under `web/public`, accept a POST only from the dev page's own origin.
