<div align="center">

<img src="assets/ruri.png" alt="ruri" width="340" />

# ruri

**One desktop workspace for all your projects — each a folder of live coding sessions.**<br>
*A folder-organized sidebar on the left, a real agent session on the right.*

</div>

---

ruri is a macOS desktop app (Electron). Claude sessions run through [`@justin06lee/yagami`](https://github.com/justin06lee/yagami)'s `AgentSession` (the Claude Agent SDK pointed at your installed, signed-in `claude` CLI, `claude_code` system prompt preset, terminal parity) — so behavior, settings, CLAUDE.md, skills, hooks, and login are identical to your terminal, just with one UI over all of them. And through yagami's provider layer, a session can just as well run on any other coding harness you have installed — Codex, OpenCode, Gemini, any ACP agent — picked per project from the same model dropdown. Sessions stay warm: switch projects instantly while agents keep working in the background, with activity dots in the sidebar. Closing the window keeps sessions alive (the Dock icon reopens it); ⌘Q quits and tears them down.

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
- **Home — the workspace agent.** The default view (and the pinned Home row) is a session that manages the app itself: tell it "today let's work on X, Y, Z" and it finds the matching directories under your workspace root, opens them in the sidebar, and can kick each session off with a delegated first prompt. On Claude that happens through in-process MCP tools (`open_project`, `close_project`, `list_projects` — closing takes the sidebar entry and transcripts, never files); on any other harness Home drops open/close requests into `.ruri/open.jsonl` at the workspace root and ruri applies them as the turn ends — so Home orchestrates on whatever model you point it at. It also carries a touch of its namesake's personality (RuriDragon's Aoki Ruri: deadpan, unbothered, gets it done anyway). The workspace root is configurable from Settings; deep work happens in each project's own session, Home just orchestrates. Its chat is deliberately ephemeral — every app launch starts it blank, and navigating away and back wipes it too (a running turn finishes first): it's a dispatcher, not a place to accumulate context. What persists instead is its **write-ahead log** (`~/.config/ruri/home-log.md`): every prompt, tool call, and reply is appended programmatically as the events stream — the model spends no tokens writing it — in per-session blocks headed `SESSION <n> — YYYY-MM-DD (Day) HH:MM`. Home is told that file is its memory and to *grep* it for dates and keywords when you refer to earlier work, never to read it whole. It also skips the header bar — nothing between the titlebar skyline and the conversation.
- **Manga look** — Space Grotesk type, pure black-and-white UI on warm paper (deliberately low blue channel, e-ink vibes): ink borders, screentone shading, hard offset shadows, grayscale syntax highlighting that leans on weight and slant instead of hue. Statuses are shapes, not colors — rows stay clean, and a small diamond pip appears on a row only when a background turn *finishes*. Scrollbars are hairline-thin (3px) everywhere, and while a turn thinks, a two-frame hand-drawn Ruri doodle flips poses in the transcript, wiggling between little tilts in the same hard half-second steps.
- **Projects sidebar as folders of sessions**: each project is a collapsible folder holding any number of parallel sessions, and each session is auto-named by the small model the moment its first prompt goes out (in parallel with the turn, not after it) — by the ROLE it serves ("Frontend UI", "Backend API"), not the literal prompt. Star a project to pin it to the top of the list (the filled star is the only marker — no separate section); + on a folder adds a session. Folders are folded by default — new projects arrive closed, and only the ones you open stay open across restarts. Removing a session deletes its transcript and nothing else — even the last one just leaves an empty folder (only the folder's own X closes the project); files on disk are never touched. Projects are opened by asking Home.
- **Persistent sessions**. Sessions start lazily on first message, run in their project's directory, and auto-restart with `resume` if they die — context carries over.
- **App-side prompt queue** — send another prompt while a turn is running and it doesn't touch the harness at all: it waits in the app, shown as a dashed "queued" bubble you can still edit or remove, and goes out the moment the running turn (and anything queued before it) finishes. Stop clears the queue.
- **Prompt splitting** — the scissors button sends your prompt like any other: it appears in the transcript immediately, exactly as written. Behind the scenes the small model splits it into separate near-verbatim requests (strictly no invented intentions) and feeds them to the session one turn at a time, attachments following their `[image #N]` markers into the right sub-prompt — none of which shows in the UI. If the split fails or no small model is set, the whole prompt just goes out as one turn; nothing is ever lost.
- **Attachments** — drop or paste anything into the composer (25MB each): images, videos, PDFs, text/source files, whatever. A `[image #N]`/`[video #N]`/`[file #N]` marker lands in the text right where you dropped it (or at the caret on paste; spaced so nothing sticks to the brackets, and strictly inserted — what you've already typed, blank lines included, is never touched) with thumbnails above it — non-media files show a doc tile with their extension; click any thumbnail for the full-size view (PDFs render inline, text files show their contents). Drag on a full-size image to mark regions and attach a note to each — every region goes to the model as its own image, cropped with generous breathing room and the region drawn on it as a numbered white box, so the model sees both exactly what you marked and where it sits (a tight crop of empty space would mean nothing without the surroundings). Images go to the model directly; videos and other files are saved to disk and referenced by path for tool-based inspection. Uploads persist under `~/.config/ruri/uploads/`. Unsent drafts — text and attachments both — are kept per session, so switching sessions mid-composition and coming back restores exactly what you were writing.
- **Streaming responses** rendered as markdown (GFM, syntax-highlighted code blocks with copy buttons), tool-use chips (`Bash — npm test`; absolute paths inside the project collapse to `projectname/relative/path` — a full path in a chip means the tool reached outside the project), and per-turn result lines with duration and what the turn would have cost at API prices. Interrupting a turn ends it with a plain "you stopped this response" line — never the CLI's diagnostic soup dressed up as an error. A prompt that's just a slash command (`/compact`, …) shows as an inverted command tag instead of a speech bubble; click the tag to clear it (and its result) from the transcript.
- **Permission prompts**: when Claude Code would ask in the terminal, ruri shows an Allow / Always allow / Deny card instead (your `~/.claude/settings.json` allow-rules apply exactly as in the CLI; "Always allow" persists the CLI's own suggested rule). Plan-mode approvals render the plan as markdown.
- **Per-project model, reasoning effort, and permission mode** in the composer — permission modes switch between ask-first / accept-edits / plan / bypass live mid-session; effort (Low/Medium/High/XHigh/Max, XHigh when unset — no ambiguous "default" row, same philosophy as the model picker; Claude natively, Codex via `model_reasoning_effort`, others ignore it) reaches a warm session on its next prompt by quietly rebuilding it with resume; all persist per project. The Home composer has the same controls. Settings holds the device-wide **model catalog**: a searchable list of every model every installed harness can serve — probed live from each harness (Codex's `app-server`, an ACP agent's own model list), never hardcoded, and re-probed whenever Settings opens. Models go by their own names alone (the serving harness appears only as a tag in the catalog); star the ones you actually use and every picker offers exactly those (with nothing starred it falls back to everything); star one a second time to make it the small-tasks model. An unset model means Fable — there is no ambiguous "default" row anywhere.
- **Any harness, same workspace — verbatim** — the model picker also lists every other coding CLI yagami detects on your machine (Codex, OpenCode, Gemini, Copilot, any ACP agent), as `provider:model` ids. Pick one and that project's sessions run the harness's real interactive engine (Codex rides `codex app-server` — the same engine its TUI runs on; ACP agents keep a warm protocol connection), exactly as its own CLI would: its config (`~/.codex/config.toml` trust levels and approval policy included), its sandbox, its system prompt — ruri overrides nothing. Tool calls stream into the transcript as chips, and when the harness would ask for approval in its own UI, ruri shows the same Allow / Always allow / Deny card it shows for Claude ("Always allow" answers with the harness's own approve-for-session). Sessions stay warm across turns with resume across restarts. Permission *modes* are still a Claude concept, so that dropdown hides on other harnesses; `~/.config/yagami/config.json` custom providers/paths are honoured.
- **Interrupt** button to stop a running turn, and a transcript that opens at the latest message (relaunches included) and follows output only while you're at the bottom (a jump-to-latest pill floats just above the composer otherwise).
- **Edit & rewind** — hover any past prompt in an idle Claude session and a pencil appears on its shoulder; click it and the prompt opens in an editable card that states the real stakes: rewinding returns the conversation *and the project's files* to the moment before that prompt ran. Edit it right there and hit **Rewind & send** (or Enter): the CLI restores its file checkpoints (sessions run with checkpointing on), the session resumes truncated — forked at the kept turn's last message, so the original chain survives on disk — the discarded turns leave the transcript, and your edited prompt goes straight out as the next turn. Needs yagami ≥ 0.6.1 (which exposes the CLI's `/rewind`); attachments don't ride back, and rewinds don't cross a compaction.
- **Fast switching** — a session opens on its last screenful and fills in the rest behind you: the tail paints immediately, the older turns arrive on idle frames, and scrolling back pulls in more as you go. Rendered markdown is cached by its own text, so a session you've already read re-opens from strings that are already HTML, and the sessions you *haven't* opened are rendered ahead of time on idle frames — clicking one is a paint, not a parse. Measured on a 700-event transcript: 144ms to switch before, 28ms after; a first open of an unvisited 400-event session went from ~100ms to ~10ms.
- **Catch up** — a per-project brief written for a model that has never seen the project: one sentence saying what it is, then one line per capability, plus screenshots of the main pages you pin yourself. The small model keeps it current as turns finish, merging what belongs together rather than growing a changelog — a fix or a polish pass adds nothing, a new capability edits the line it belongs to or earns one of its own. The header's book button opens it; every line is editable by hand. "Catch a model up" drops the whole brief into the composer with the screenshots attached, so a fresh session (or a harness you just switched to) starts knowing the shape of the project for the price of a paragraph.
- **A shell in the composer** — the `>_` button turns the prompt box into a terminal in that project's directory: your login shell, your rc files, your prompt, your colors, on a real pty. It keeps running while you're elsewhere, so switching back finds it where you left it, and it dies with the project.
- **Three themes, on a clock** — light (paper), dark (the same page at night), and ember: warm through and through, no blue channel to speak of, for late sessions. Settings can hand the choice to the clock — a time each theme takes over, set on the app's own little time fields — and picking one by hand turns the clock back off.
- **Rapid fire** — the bolt row under Home turns the main pane into assembly-line prompting for parallel work. It shows one session at a time, whichever is ready for a prompt, as the ordinary chat page — the full transcript, the real composer, everything where you expect it — with the line's controls in the header. The sidebar doesn't move: the app's own session stays selected, and leaving the line puts you back on it. Send, and the prompt lands and sits there a beat before the card fades out and the next ready session rises into its place. Skip passes to the next one; a session that's working is passed over until it finishes, and when everyone's working the card stays where it is so you can watch that turn end.
- **Music player** in the sidebar (ported from `home`): point Settings → Music at any folder (default `~/Music/ruri`, or `RURI_MUSIC_DIR`) — each subfolder is a playlist, loose files are "Unsorted". Two-deck Web Audio engine with 6s equal-power crossfade, shuffle, seek, volume, and a repeat button that cycles off → loop the playlist → loop the current track (a little "1" marks track mode; deliberately session-only — every launch starts with repeat off); tracks stream from ruri's own server with Range support. While a track plays, a five-bar waveform fed by a real analyser tap on the master output rides the gap between the track title and the chevron (the note icon stays put), and little notes wobble upward from the player bar.
- **Dark mode** — proper dark: black and dark-gray surfaces, white ink, gray borders; Light/Dark switch in Settings (gear on the account bar at the bottom of the sidebar), persisted per machine. Settings also holds the workspace root, the music folder, and the model catalog.
- **A different Ruri every time** — the hero face above the composer is drawn from a pool of 12 cropped Ruri panels: Home rolls a fresh one each app launch, and every project keeps the face it was born with. Up in the title bar sits the **peek skyline**: five hand-cut head PNGs (background removed and missing parts redrawn by hand) resting low in the bar, just horns and hair showing — hover one and she lifts slightly, just enough to see her face. The whole bar stays a window-drag region — the desktop app's main process polls the cursor to drive the hover, since drag regions never deliver mouse events to the page.
- **Feature tracker** — the small model splits each prompt you send into its distinct requests — one checklist item per request, in your own words, nothing invented or embellished (it never sees the replies) — the moment the prompt goes out, so a stopped turn or a "continue" follow-up can't lose requests and nothing from a long prompt gets forgotten. Items stay tied to the prompt they were split from: edit & rewind a prompt and its auto items (plus those of every discarded later prompt) vanish, then the edited prompt re-extracts fresh ones on send — the checklist always mirrors the prompts that actually stand. Manual items are yours and never touched. The header's tracker button swaps the whole chat pane for the **todo page** (no navigation — the same button, or the page's X, swaps back), and the page opens itself when new items land. Reviewing is one pass: click anywhere on an item — once for works (check), twice for needs-work (x), which smoothly folds out a note field (foldable again to stay focused) — and items never move while you review. Notes save on blur *and* on the way out, so closing the page mid-thought loses nothing. Paste or drop files straight into a note; they show as little numbered bumps on the textbox's top edge (click one to remove it). **Finish review** then clears the checked items, reopens the crossed ones pinned at the top with a repeat badge on their checkbox (new extractions land below them), and assembles one fix-it prompt mechanically — each crossed item's title with your note verbatim under it, note attachments as stored file paths for tool inspection; no model call, so it's instant and exactly what you wrote — dropped straight into the composer (persisted as that session's draft, so it survives switching around). Persists in `~/.config/ruri/tracker/`.
- **Turn memory** — a small model writes two terse recall notes per exchange, telegraphic to the point of caveman ("header flickers on scroll; shrink logo"): the prompt's, the moment you send it, and the reply's, the moment the turn finishes. Which model: star one twice in the Settings catalog to crown it the **small-tasks model** (an inverted "small tasks" tag marks it; any harness works — yagami routes qualified ids), used everywhere the small model runs (recall notes, session role titles, prompt splitting, the tracker); with nothing double-starred it's `RURI_SMALL_MODEL` or Haiku, and `RURI_NO_MEMORY=1` disables the layer. The notes stay out of the way — turns always show in full; a hover chevron on a turn's top-left folds it down to its note, and clicking the folded card pulls it back. Transcripts, notes, and the resumable session id persist in `~/.config/ruri/sessions/`, so history and context survive app restarts.
- **ruri's own `/compact`** — type `/compact` and ruri compacts the session itself instead of letting the harness do it, instantly and at zero model cost: the live session is retired (resume id cleared — the next prompt opens a brand-new session with no context beyond the brief), every prior exchange's full record — prompt, response, tool activity — is written to `~/.config/ruri/turns/<session>/NNN.md`, and a brief is built from the precomputed recall notes as strict prompt/reply pairs — `user:` then `you:` per exchange, oldest first — each ending with its exchange's file path so the fresh model can Read the full record whenever a note isn't detail enough. The brief rides invisibly on your next prompt. The transcript keeps your full history and just shows a uniform zigzag line — "compacted", in the result lines' own voice — at the break; click the label and the pairs unfold as a clean numbered list (your note in ink, the reply's under it in soft) instead of raw model text. Works on any harness, since it's all app-side.

## Architecture

```
ruri.app (Electron)
  ├─ main process: startServer() in-process        ─┐
  │    └─ yagami AgentSession → Agent SDK           ├─ one WebSocket + static UI
  │       → your installed claude CLI               │  on one localhost port
  └─ renderer: React + Vite + zustand (dist-web)   ─┘  (shared/protocol.ts)
```

One HTTP server carries everything: `GET /healthz`, `GET /music/playlists`, `GET /music/track?p=…` (Range-capable), `GET /uploads/<file>`, the built UI on every other GET, and the WebSocket on the same port. `shared/protocol.ts` is the single wire contract — every client command and server message is a variant of `ClientMessage`/`ServerMessage`.

**Server**

- `server/server.ts` — importable `startServer()`: WebSocket hub + static file serving for the built UI; snapshot on connect, broadcasts events/deltas/statuses/permissions, handles client commands, owns the model-probe cache and the app-side prompt queue (visible queued prompts and silent split sub-prompts alike).
- `server/sessions.ts` — per-session lifecycle. Claude sessions ride yagami's `AgentSession` (warm process, terminal parity, `appName: "ruri"`): SDK message → transcript event translation, permission plumbing (with the CLI's suggested "always allow" rules), model/permission-mode switching, resume-on-restart. Non-Claude models route to `ProviderAgentSession`: yagami's agentic session layer (`openSession` — Codex app-server, ACP), the harness verbatim with tool chips and approval cards; `ProviderTurnSession` (one sandboxed `provider.run()` per turn) remains as the fallback for providers without it. Both use provider-prefixed resume ids streamed into the same events.
- `server/manager.ts` — the Home agent: an in-process MCP server (`open_project`, `list_projects`) plus a workspace-manager system prompt (with the Ruri personality), layered onto a normal session at the workspace root. Non-Claude harnesses get the same duties via a system-prompt-described drop file (`.ruri/open.jsonl`) drained at end of turn.
- `server/homelog.ts` — Home's write-ahead log: appends each Home event as a greppable one-liner under numbered, dated SESSION headers; the model reads it (via search), never writes it.
- `server/providers.ts` — `ProviderRegistry` over yagami's provider layer: detects the installed harnesses once at startup (honouring `~/.config/yagami/config.json`), lists their models for the picker as `provider:model` ids, and builds per-project provider instances working in the project directory.
- `server/projects.ts` — `ProjectStore`: projects, their sessions, and the device-wide settings (workspace root, music dir, Home's model/mode, starred models, the small-tasks model), persisted to `projects.json`.
- `server/archive.ts` — `SessionArchive`: transcript events, per-turn recall notes, the resumable session id, and a pending compaction brief per session, debounce-written to disk. The source of truth behind the connect snapshot and `/compact`.
- `server/compaction.ts` — ruri's own `/compact`: writes each exchange's full record to `turns/<session>/NNN.md` and builds the model-facing brief out of the precomputed recall notes as prompt/reply pairs, one file hook per exchange. No model call — it's instant.
- `server/smallmodel.ts` — the small-tasks layer over yagami's completions client: prompt and reply recall notes, session role titles, prompt splitting, tracker extraction, plus `TurnTracker`, which assembles prompt→result turns out of the event stream.
- `server/tracker.ts` — `TrackerStore`: the per-project feature checklist, auto-extracted or hand-added.
- `server/uploads.ts` — attachment intake (images, videos, arbitrary files): base64 in, files under `uploads/` and small URLs in the transcript, region crops expanded into extra model-visible images, non-image files referenced by path in the prompt.
- `server/usage.ts` — account limit windows (5-hour / weekly) via the Claude Code OAuth token (keychain / credentials file), all best-effort. Still polled and broadcast; currently unsurfaced — the gauges UI was retired pending a better design.
- `server/music.ts` — the music library scan (folder = playlist, loose files = "Unsorted") and the path allowlist for the track route.
- `server/index.ts` — standalone entry for dev/smoke (same server, no Electron).

**Desktop & UI**

- `desktop/main.ts` — Electron main: login-shell PATH recovery, window/menu/lifecycle, the native folder picker, and the cursor poll that drives the titlebar peek hover; esbuild bundles it together with the server, yagami, and the Agent SDK into a single file (`scripts/build-main.ts`).
- `web/src/store.ts` — zustand store fed by the socket; drafts (streaming text) are kept separately from finalized transcript events.
- `web/src/components/ChatPane.tsx` — transcript, turn grouping and compaction, permission cards, composer, tracker drawer.
- `web/src/components/RapidFire.tsx` — rapid fire: the client-side line of prompt-ready sessions, the hand-off timing, and the header bar. It renders no pane of its own — the chat pane takes the session it picks.
- `web/src/components/Brief.tsx` / `server/brief.ts` — the catch-up brief: the page, the store, and the prompt it composes.
- `web/src/components/Terminal.tsx` / `server/terminal.ts` — the composer's shell: xterm.js over a pty, one per channel.
- `web/src/components/Sidebar.tsx` — Home and rapid-fire rows, project folders and their sessions, the peek skyline, the account bar.
- `web/src/components/Settings.tsx` — theme, workspace root, music folder, and the searchable model catalog.
- `web/src/components/Player.tsx` + `web/src/lib/audio.ts` — the sidebar player and its two-deck Web Audio engine.
- `web/src/components/Attachments.tsx` — composer thumbnails, the full-size viewer, and drag-to-annotate region crops.
- `web/src/markdown.tsx` — marked + DOMPurify + highlight.js markdown renderer shared by messages, streaming drafts, and plan cards.
- `web/src/fixture.ts` — the canned `?fixture` state used for token-free UI work.

## Where things live

All app state sits under `~/.config/ruri` (move it wholesale with `RURI_CONFIG_DIR`):

| Path | What |
|---|---|
| `projects.json` | Projects and their sessions, workspace root, music dir, Home's model/mode, starred models, small-tasks model |
| `sessions/<sessionId>.json` | Transcript events, per-turn recall notes, resumable session id, pending compaction brief |
| `turns/<sessionId>/NNN.md` | Full per-exchange records `/compact` leaves for the fresh session to Read |
| `tracker/<sessionId>.json` | Feature-tracker checklist |
| `home-log.md` | Home's write-ahead activity log, one block per Home session |
| `uploads/` | Attached images and videos |

Everything else is yours and untouched: `~/.claude` (settings, CLAUDE.md, skills, hooks, the CLI's own session files), `~/.codex/config.toml`, `~/.config/yagami/config.json`.

Environment variables:

| Variable | Effect |
|---|---|
| `RURI_CONFIG_DIR` | Where all app state lives (default `~/.config/ruri`) |
| `RURI_PORT` | Server port — the desktop app picks a free one when unset; the dev server defaults to 7777 |
| `RURI_MUSIC_DIR` | Music library root before Settings overrides it (default `~/Music/ruri`) |
| `RURI_SMALL_MODEL` | Small-tasks model when nothing is double-starred (default `haiku`) |
| `RURI_NO_MEMORY=1` | Turn the small-model layer off entirely |
| `RURI_FIXTURE=1` | Canned UI state instead of a live server |
| `RURI_SCREENSHOT=/path.png` | Capture the window to a PNG shortly after load |
| `RURI_USER_DATA` | Isolated Electron userData, so a dev run doesn't fight the installed app for the single-instance lock |
| `RURI_SMOKE_SPAWN` | What `bun run smoke` boots instead of the standalone dev server |

The workspace root defaults to `~/Workspace` when it exists, otherwise your home directory. Out of the box, Fable and Codex's default model come pre-starred.

## Testing

```sh
bun run typecheck                    # server + web, no emit
bun run build                        # no tokens; produces dist-app/mac-arm64/ruri.app
bun run smoke                        # live E2E: 3 real turns incl. Bash + permission round-trip

# same E2E against the packaged app (Finder-style stripped PATH recommended):
RURI_SMOKE_SPAWN="dist-app/mac-arm64/ruri.app/Contents/MacOS/ruri" bun run smoke
```

The smoke test boots the server, connects over the WebSocket exactly like the UI does, and drives three real turns in a scratch project — a plain reply, a Bash turn, and a WebFetch turn that must round-trip a permission card. It runs against a throwaway `RURI_CONFIG_DIR`, so your real projects are never involved.

For UI work there's a token-free fixture mode — canned transcript, pending permission, folder groups: open `http://localhost:5173/?fixture` in dev, or `RURI_FIXTURE=1` (with `RURI_SCREENSHOT=/path.png`) for the desktop app. If the installed ruri.app is running, add `RURI_USER_DATA=/tmp/ruri-dev` so the dev instance doesn't lose the single-instance lock to it.

## Not yet (iterate next)

A custom in-app file finder (replacing the native picker entirely), tool results/diffs in the transcript, effort controls, session history browser, drag-and-drop folder management, git status in the sidebar, worktree support for parallel agents in one repo, notifications, Windows/Linux packaging.
