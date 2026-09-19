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
| `rewind-compaction-test` | none | rewinding either side of a compaction, against the real server, no turn run |
| `retry-test` | none (needs `claude`) | a dropped turn goes again: the real CLI against a mock gateway that answers 529 to everything |
| `bridge-test` | none, needs a display | drives the bridge end to end: a hidden browser window over CDP, then TextEdit over Accessibility |
| `chips-test` | none, needs a display | the composer's marker chips survive a window resize (needs `bun run build:web && bun run build:main` first) |
| `sweep-test` | tokens | runs the component sweep against a project and prints what the small model would name |
| `smoke` | tokens | three real turns: a plain reply, a Bash turn, a WebFetch turn with a permission round-trip |
| `idle-reap-test` | tokens | an open chat keeps its process; leaving it closes it; the next prompt resumes |
| `bridge-close-test` | tokens | bridge windows close a few seconds after the turn that opened them ends |
| `md-image-test` | tokens | a picture a reply points at by path shows up |
| `rewind-test`, `fork-test` | tokens | rewind and fork end to end, one real turn each |
| `queue-test`, `queue-arrange-test` | tokens | the app-side prompt queue: stop keeps it; reorder, merge, edit while it waits |
| `question-test` | tokens | skipping an AskUserQuestion card is the end of it |
| `naming-test` | tokens | in bypass, components name themselves |
| `recall-test` | tokens | the recall note a finished reply leaves keeps the work it put forward |
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
