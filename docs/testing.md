# Testing

Two runners cost nothing and run in CI; everything else spends model tokens or needs a display and is run by hand.

```sh
bun run typecheck        # server + web, no emit
bun run lint             # eslint
bun test                 # unit tests: **/*.test.ts (server/paragraphs.test.ts, server/diff.test.ts, …)
bun run test:scripts     # every token-free integration script below, one after another, with a pass/fail table
bun run build            # no tokens; produces dist-app/mac-arm64/ruri.app, signed with the local identity
```

`bun test` is bun's own runner: any `*.test.ts` beside the module it tests, `bun:test` for `describe`/`test`/`expect`. It skips dot-directories, so worktrees under `.claude/` are never scanned.

`bun run test:scripts` (`scripts/run-tests.ts`) runs each script below exactly as its own `bun run <name>-test` line does — `bunx tsx scripts/<name>.ts` from the repo root — and reads only its exit code. A script whose header names a binary it needs (`retry` needs `claude`) is skipped, not failed, when the binary is missing. Any failure prints that script's whole output and the run exits non-zero.

## The scripts

| Script | Cost | What it checks |
|---|---|---|
| `paragraphs-test` | none | a streamed reply comes out a whole paragraph at a time, code blocks whole |
| `commands-test` | none | slash commands inside a prompt: which are lifted out and run first, which stay words |
| `settings-test` | none | a chat's model, effort and mode are its own; the project keeps only what a new chat starts on |
| `history-test` | none | the two-part transcript — fold, split, rewind, fork, cap, heal after a crash |
| `home-cap-test` | none | Home keeps its newest 50 events, cut where a turn starts |
| `digest-test` | none | a brief lists 40 exchanges at most; the oldest fold into its digest (a scripted fold stands in for the model) |
| `notes-test` | none | recall notes survive a spent small model; the outline a chat folds its history into |
| `compaction-attachments-test` | none | compaction leaves the fresh model a path to every attached image |
| `orphans-test` | none | the launch sweep for what closed sessions and projects left behind |
| `uploads-sweep-test` | none | uploads nothing mentions are swept after a day |
| `checkpoint-test` | none | ruri's own file checkpoints and rewinds, against a throwaway git repo |
| `port-test` | none | the port is taken back from a ruri that outlived its app, and never from a stranger |
| `provider-events` | none | a fake harness streams a turn; the transcript it makes is what ruri promises for every model |
| `subagents-test` | none | a fake harness's agents become cards in the chat and logs of their own |
| `hidden-test` | none | hidden projects, Home's drop file, the finder, and a toggle over the real server |
| `asleep-test` | none | a window that goes to sleep stops the meters sampling, and wakes them again — the `awake` flag end to end, from the schema to the handler |
| `naming-test` | none | `ruri register` over `POST /library`: in bypass a component goes straight into the library under its handle; otherwise a card comes up, the command doesn't wait on it, and the answer's name is the one kept; backend files are turned away |
| `terminal-test` | none | a shell printing forty thousand lines: every one arrives, in order and in fewer messages than lines, and a window attaching later is given a capped scrollback ending where the shell did |
| `rewind-compaction-test` | none | rewinding either side of a compaction, against the real server, no turn run |
| `rewind-git-test` | none | a rewind through the real server on a scratch repo: only the discarded turns' changes out, the commit taken back, the context gauge back to the kept exchange |
| `retry-test` | none (needs `claude`) | a dropped turn goes again: the real CLI against a mock gateway that answers 529 to everything |
| `bridge-test` | none, needs a display | drives the bridge end to end: a hidden browser window over CDP, then TextEdit over Accessibility |
| `chips-test` | none, needs a display | the composer's marker chips survive a window resize (needs `bun run build:web && bun run build:main` first) |
| `sweep-test` | tokens | runs the component sweep against a project and prints what the small model would name |
| `meters-test` | tokens (one short Haiku turn) | the statistics page's resource meters against a real harness: nothing sampled until a window asks, the chat's own process found and named as that chat, and the sampling stopped when the window looks away |
| `smoke` | tokens | three real turns: a plain reply, a Bash turn, a WebFetch turn with a permission round-trip |
| `idle-reap-test` | tokens | an open chat keeps its process; leaving it closes it; the next prompt resumes |
| `bridge-close-test` | tokens | bridge windows close a few seconds after the turn that opened them ends |
| `md-image-test` | tokens | a picture a reply points at by path shows up |
| `model-window-test` | tokens (one tiny Opus turn) | a catalog without the `[1m]` ids moves the default and stars on them to the plain models it lists; a chat on plain `opus` is measured against the 1,000,000 window the CLI reports, not a 200,000 guess |
| `acp-start-test` | OpenCode's free model (needs `opencode`) | an ACP harness that dies as it starts is started again: a warm OpenCode killed between turns, and a first start against a write-locked database, each answered instead of failing "ACP connection closed" (OpenCode's data in a scratch folder) |
| `lost-session-test` | tokens (three short Haiku turns) | a chat whose Claude session is gone answers anyway: a resume that fails as it starts goes again to a fresh session briefed on the conversation, and a dead process can't bring the lost id back |
| `session-stress-test` | tokens (a few dozen short turns on Haiku, Codex's Luna and OpenCode's free model; a harness not installed is skipped) | a chat's session can't be lost: it plants codewords, then switches the model back and forth across Claude, Codex and OpenCode, switches under a running turn (and thrashes), opens another chat mid-turn, drops the socket mid-turn, lets each harness's process be reaped, restarts the server between turns and mid-turn, crashes it, compacts, rewinds on each harness, deletes each harness's session out from under the chat, and quits or crashes before a fresh session's first reply — after every step asking for every codeword and checking no turn failed, the transcript kept every prompt, the archive kept every session id, and a harness switched back to resumed its own session. `STRESS_STEPS=a,b` runs only those steps, `STRESS_CODEX=` / `STRESS_OPENCODE=` skip a harness, `STRESS_KEEP=1` keeps the scratch folders |
| `svg-attachment-test` | tokens (one short Haiku turn) | an SVG attached to a prompt reaches the model as the composer's PNG of it, with the original's path; a picture nothing could draw goes as a file; the upload is served as a picture |
| `rewind-test` | tokens | two Haiku turns on a scratch repo — a Write, then a shell edit and a commit — and a rewind of the second: file, commit, staging, transcript, composer, context gauge |
| `fork-test` | tokens | fork end to end, one real turn |
| `queue-test`, `queue-arrange-test` | tokens | the app-side prompt queue: stop keeps it; reorder, merge, edit while it waits |
| `question-test` | tokens | skipping an AskUserQuestion card is the end of it |
| `talk-test` | tokens | a chat asks a chat in another project and gets its answer back; outside bypass the card, and a no; `POST /talk` (free alone: `TALK_HTTP_ONLY=1`) |
| `talk-replies-test` | tokens (a dozen short Haiku and GPT Luna turns) | an answer always comes back unless none was asked for, against a chat kept busy on a held card: Claude waiting in its call; Claude stopped mid-wait, the answer arriving as a message; Codex waiting over HTTP across several of its twenty-second slices; Codex asking for it later; "none" doing the work and sending nothing back; a relaunch while the letter waits in line; a message cutting in on a chat ninety seconds into a command, answered in seconds, the chat taking its command up again after; Claude starting a new chat in another project (`start_chat`) and hearing back; a message sent with `delivery: "queue"` to a busy chat waiting out its turn instead of stopping it; Codex starting a chat over HTTP (`{"do": "new"}`) (`TALK_REPLIES_OPENCODE=1` adds OpenCode's free model waiting past a slice; `TALK_REPLIES_SKIP_CODEX=1` leaves Codex out; `TALK_REPLIES_CASES=2,8` runs only those cases) |
| `recall-test` | tokens | the recall note a finished reply leaves keeps the work it put forward |
| `wake-turn-test` | tokens | a background task that ends between turns wakes the CLI: the chat goes busy by itself and the model answers, even with the chat open nowhere; a prompt sent the moment it wakes gets its own result, not the woken turn's |
| `model-switch-test` | tokens | switching model never touches a running turn; switching back keeps the prompt cache |
| `subagents-live-test`, `crew-live-test` | tokens | a real Claude subagent, and an agent of your own, card and log end to end |
| `provider-test`, `provider-check` | tokens | feature parity on a non-Claude harness; every effort level on Codex |

Every script runs against a throwaway `RURI_CONFIG_DIR` in a temp directory, so your real projects are never involved; `make tidy` sweeps those directories once they are an hour old.

## The manual ones, in more detail

```sh
bun run smoke                        # live E2E: 3 real turns incl. Bash + permission round-trip
# the same E2E against the packaged app (Finder-style stripped PATH recommended):
RURI_SMOKE_SPAWN="dist-app/mac-arm64/ruri.app/Contents/MacOS/ruri" bun run smoke
```

The smoke test boots the server, connects over the WebSocket exactly like the UI does, and drives three real turns in a scratch project — a plain reply, a Bash turn, and a WebFetch turn that must round-trip a permission card.

`bun run bridge-test` costs no tokens: it serves a tiny local page, boots the real desktop app with an isolated config/userData/port (never touching the installed `ruri.app`), and exercises the bridge end to end over its HTTP face — `web_open` → `web_click` → `web_wait_for` → `web_type` → `web_screenshot` → `web_logs` → `web_close`, then a tier-2 pass that launches TextEdit in the background, walks its Accessibility tree, types into the document via `app_ui`, photographs the window, and quits it (skipped with a note, not failed, if macOS hasn't granted Accessibility or Screen Recording), and finally an Electron app driven over CDP.

`bun run chips-test` costs no tokens either (it needs `bun run build:web && bun run build:main` first): it boots the app in fixture mode with an isolated config, pastes a picture into the composer, writes a prompt long enough to wrap, and narrows and widens the viewport — asserting each time that the marker chips are still drawn and that the mirror and the textarea still agree on how many lines the prompt is. The widening pass is the one that matters: a box fitted only when the prompt changes stays as tall as the narrower window left it, and that used to take every chip off the prompt until the next keystroke.

For UI work there's a token-free fixture mode — canned transcript, pending permission, folder groups: open `http://localhost:5173/?fixture` in dev, or `RURI_FIXTURE=1` (with `RURI_SCREENSHOT=/path.png`) for the desktop app. If the installed ruri.app is running, add `RURI_USER_DATA=/tmp/ruri-dev` so the dev instance doesn't lose the single-instance lock to it.
