<div align="center">

<img src="assets/ruri.svg" alt="ruri" width="340" />

# ruri

**One desktop workspace for all your projects — each a folder of live coding sessions.**<br>
*A folder-organized sidebar on the left, a real agent session on the right.*

</div>

---

ruri is a desktop app (Electron, for macOS and Linux) that hosts coding-agent sessions: Claude Code through [`@justin06lee/yagami`](https://github.com/justin06lee/yagami)'s `AgentSession` (your installed, signed-in `claude` CLI — settings, CLAUDE.md, skills, hooks and login identical to your terminal), and through yagami's provider layer any other harness you have installed — Codex, OpenCode, Gemini, any ACP agent — picked per chat from the same model dropdown. Sessions stay warm while you switch projects; on macOS closing the window keeps them alive and ⌘Q quits and tears them down, on Linux closing the window is the quit.

## Run it

Requires macOS or Linux, [bun](https://bun.sh), and a signed-in coding CLI (Claude Code, Codex, or an installed ACP agent).

```sh
make              # build → install → tidy → launch
make update       # stop the running app, rebuild, reinstall, tidy, relaunch
make build        # only the app, into dist-app/
```

**macOS.** `make` installs `ruri.app` to `/Applications`. The first `make` creates a local code-signing identity (`ruri dev`) in your login keychain, so macOS privacy grants survive rebuilds — see [docs/permissions.md](docs/permissions.md). The app is not notarized (no Apple developer account); it is installed by `make`, never downloaded.

**Linux** (built and used on Ubuntu 24.04 with GNOME, arm64; x64 builds the same way; Node.js 20+ is needed alongside bun for Electron's installer). `make` installs the app for your user alone — the build in `~/.local/opt/ruri`, `ruri.desktop` in `~/.local/share/applications` and the icon in `~/.local/share/icons` — so it is in the app grid and the dock like anything else, and `git pull && make` updates it (a ruri that is running keeps going; the next launch is the new one). It asks for `sudo` only when something is missing: once, on Ubuntu 24.04 and later, to install the AppArmor profile Chromium's sandbox needs there (`/etc/apparmor.d/ruri`), and to `apt-get install` what terminals and the bridge use when they aren't there (`expect`, `curl`, `xdotool`, `wmctrl`, `xprop`, ImageMagick, `python3-gi`). Closing the window quits ruri, sessions and all — there is no dock icon to bring a windowless app back from. The bridge drives native apps on an X11 session (Ubuntu on Xorg) over the accessibility bus; on Wayland it keeps web pages and Electron apps. Settings → Permissions has nothing to ask for: Linux keeps no per-app grants.

For development:

```sh
bun install
bun run dev       # browser mode: server on :7777, UI at http://localhost:5173
bun run desktop   # the desktop app unpackaged (built UI + Electron)
```

On a Linux that restricts unprivileged user namespaces (Ubuntu 24.04 and later), an unpackaged Electron has no AppArmor profile, so its sandbox cannot start: run it as `bun run desktop -- --no-sandbox` (the installed app has its profile).

## What it does

- **Home, the workspace agent** — tell it what to work on and it finds the projects by name, opens them in the sidebar and kicks their sessions off, on whatever model you point it at.
- **Projects are folders of parallel sessions** — auto-named after their first turn, warm in the background, resumed after a relaunch; idle ones give their process back and resume on the next prompt.
- **Any harness, verbatim** — Claude, Codex, OpenCode, Gemini, ACP agents; model, reasoning effort and permission mode are per chat — and every one of them kept up to date on the hour, the way it was installed.
- **Streaming markdown replies** with tool chips, inline diffs, previews of what was read, and permission cards that mean the same thing on every harness.
- **An app-side prompt queue** you can reorder, merge (with an undo) and edit while a turn runs — or cut in past it with ⌘Enter or a held Enter, stopping the answer and sending yours in its place. A dropped connection or a usage limit holds it, with a Send queued button, instead of spending it against the same wall; a prompt splitter; slash commands inside a prompt.
- **Attachments** — images, videos, PDFs, files — with markers as chips, region crops, a full-size viewer and a sketch pad.
- **Edit & rewind** with ruri's own checkpoints on every harness — the discarded turns' files, commits and context go back, and nothing else does; fork a chat at any exchange; import chats started outside ruri.
- **MCP servers, plugins and marketplaces** for Claude Code and Codex, listed, added and removed from Settings through each CLI's own commands.
- **Subagents and background scripts as live cards**, an agents page, and agents of your own started from a brief; an agent the model sends on again picks its own card back up.
- **Agents talk to agents** — a chat's agent can message a chat in any open project and hear back, waiting on the answer or having it come later; the talk page in every chat's header says who may message whom, and outside Bypass each message waits on your OK.
- **The bridge** — a session looks at and drives what it built: a hidden browser window over CDP, native apps over Accessibility (AT-SPI on Linux), previews above the composer.
- **ruri's own `/compact`** — instant and token-free, built from per-turn recall notes; transcripts split into a live part and a capped history.
- **A component library per project** — every piece of its interface with a picture, a name and its code, in a searchable gallery; agents find, read and install components with the `ruri` command (`ruri search`, `ruri show`, `ruri add peek-band`) and put back what they build.
- **A project's memory and architecture** — every chat is pointed at `.ruri/catchup.md` (git's own account of where things stand, then decisions and why, what worked, what failed and why, the traps, what's open — each line with the day it was learned, the exchange it came from and who wrote it) and `.ruri/architecture.md` — the index: the stack as layers, the flows across them, where things are. Every session is shown the stack before it starts, and each layer has a sheet of its own in `.ruri/layers/` (where to change what inside it, how it works, its key files, its traps, what sessions learned there) that a session reads before working in that layer — so a project grows by gaining layers, not by its sheets growing. The sessions keep it true: one that has read a sheet puts right what its work changed there (`ruri layer <handle> add|set|drop …`, `ruri architecture …` for the index) — only what it has read, as it stands — and the small model folds in what they leave, a turn only into the layers whose files it changed. Agents add what they learn with `ruri note` (filed with the layer it is about, so catchup.md keeps only what holds across the project), read a layer with `ruri layer <handle>`, search every past exchange with `ruri recall`, and read git and their own changes with `ruri state`; after a `/compact` the brief carries every one of your prompts word for word and names the layers the chat worked in. The Architecture page draws the stack, each bar opening its layer's sheet with who last changed it, and there you rewrite or strike any line.
- **Turn memory, a feature tracker, an ideas board, the vault** (secrets the model can use but never read) **and a skills page.**
- **Shells in the composer** on a real pty, a tab row per project; **rapid fire** for assembly-line prompting across sessions.
- **Questions never go to a hole** — every harness's question and form elicitation shares one card.
- **A manga look** on warm paper, three themes on a clock, the dragon gauges for context and account limits, the peek band in the title bar (a mountain path by day on light, under the stars on dark and at sunset on ember — or any pictures and GIFs you give it, each with its own hover and themes), the marks of whoever made the chat's model doodled over every empty chat (Anthropic × Claude, OpenAI × ChatGPT, Google × Gemini and the rest), and a music player in the sidebar.
- **Settings → Permissions** shows every macOS grant as macOS actually holds it.
- **Shortcuts by platform** — ⌘ on a Mac is Ctrl on Linux (Ctrl+K for the switcher, Ctrl+Enter to cut in); the terminals' tabs are Ctrl+Shift+T and Alt+1–9 there, as in GNOME Terminal.

The long form, one bullet per capability: [docs/features.md](docs/features.md).

## Architecture

```
ruri.app (Electron)
  ├─ main process: startServer() in-process        ─┐
  │    └─ yagami AgentSession → Agent SDK           ├─ one WebSocket + static UI
  │       → your installed claude CLI               │  on one localhost port
  └─ renderer: React + Vite + zustand (dist-web)   ─┘  (shared/protocol.ts)
```

One HTTP server on `127.0.0.1` carries everything: the built UI, uploads, music, the bridge's HTTP face, and the WebSocket. `shared/protocol.ts` is the single wire contract; `server/` is the backend (sessions, archive, compaction, the small-model layer, the Home agent, the bridge tools), `web/src/` the React UI, `desktop/` the Electron shell (window, permissions, hidden bridge windows, native apps — `linuxApps.ts` on Linux — screenshots). `scripts/build-main.ts` bundles main process, server, yagami and the Agent SDK into one file, so the packaged app ships no node_modules; the Claude engine is your installed `claude` binary, found on your login shell's PATH.

All state lives under `~/.config/ruri` (`RURI_CONFIG_DIR` moves it); on Linux Chromium's own storage — the window's, and the bridge's per-project logins — sits in `~/.config/ruri/chromium`, where macOS keeps it in `~/Library/Application Support/ruri`. Each project gets a self-ignoring `.ruri/` folder for its catch-up, its architecture (the index and a sheet per layer) and its component library — once there is something in it: a folder that is still blank is left blank, so `create-next-app`, `bun create` and `git clone` run in it as they would anywhere.

- [docs/architecture.md](docs/architecture.md) — the per-file walk, where things live on disk, environment variables, and the security model
- [docs/features.md](docs/features.md) — everything it does, in full
- [docs/testing.md](docs/testing.md) — every script, and which spend tokens
- [docs/permissions.md](docs/permissions.md) — the macOS grants and the signing identity, and what Linux asks for instead
- [docs/harness-integration.md](docs/harness-integration.md) — non-Claude harnesses through yagami
- [docs/roadmap.md](docs/roadmap.md) — not yet
- [CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md)

## Testing

```sh
bun run typecheck && bun run lint
bun test                 # unit tests, **/*.test.ts
bun run test:scripts     # the token-free integration scripts, one after another
bun run build            # the packaged app must still build
```

CI runs the same on every push to `master` and every pull request. The scripts that spend tokens (`bun run smoke`, the live agent tests, …) or need a display (`bridge-test`, `chips-test`) are run by hand; [docs/testing.md](docs/testing.md) lists each with its cost.

## License

MIT — see [LICENSE](LICENSE).
