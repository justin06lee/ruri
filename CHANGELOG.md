# Changelog

Release notes, taken from the annotated `vX.Y.Z` tags (`git tag -n99`). Versions whose tag carries no notes list the subjects of what landed in them instead.

## Unreleased

- fix(sketch): on dark and ember the pad is the theme's paper and the pen starts in its ink, so the text box no longer writes black on near-black; the red, blue and green are lifted on the dark themes, drawings follow the theme they are opened in, and Home's chat/statistics strip no longer covers the pad's toolbar
- feat(talk): agents talk to agents, across projects. A chat's agent lists the others it may message (`list_agents`) and messages one (`message_agent`; `POST /talk/<chat>` for harnesses without ruri's tools): the message arrives in that chat as a prompt marked as whose it is, queued behind whatever it is doing, and its answer — the chat's last word at the end of that turn — comes back into the waiting call, later as a message, or not at all. In Bypass it just goes; in any other mode a card in the sending chat asks first. The new talk page in the chat header sets who may message whom — for every agent, per project, per chat: anyone, only these, or no one — and lists the latest messages and where each has got to. Two chats waiting on each other, and chains six agents deep, are refused
- feat: long lists scroll instead of stretching the page. Past a set number of items — six for most, eight for models, skills and the statistics tables, four chats on a project card — a list holds at that height and scrolls, with half of the next item showing so it reads as more below: Settings' MCP servers, plugins, marketplaces and plugin search, the models, the vault, the harnesses and the macOS grants table, the skills page, the statistics page's projects and running agents, and the projects page's cards
- feat(sidebar): the Projects row counts the projects at work — a turn running, a card waiting on you, agents or scripts still going — beside its dragon, instead of every open project; with nothing running it shows neither. The dragon there sits a hair higher, level with the digits
- fix(sidebar): the peek band's hovers work, and the band still drags the window. While ruri is the window in use the band is no drag region at all — every picture sees the pointer, hover effects and hover pictures included, even where pictures overlap or fill the band — and pressing anywhere on it (picture or gap) and dragging carries the window, moved by the shell only while the button is down; a double-click zooms. Behind another app it is the title bar again, so the first press drags the window natively as it comes forward. Nothing polls the cursor
- feat(settings): the hero face is yours to set. Settings → Hero face: hide it, or show one face always (★) or one drawn at random — each project keeping its own, a new one every launch, or every visit — and optionally draw another by clicking it. Add up to 24 faces of your own (PNG, JPEG, GIF, WebP, AVIF, animated PNG, SVG) to the twelve, leave any out of the mix, replace or remove them; frame the picked one by dragging and scrolling it at its real size, or type it, with Fit, Fill and Reset. Each face can have a hover picture, a GIF mode (always, on hover, still) and swap ink and paper in the dark themes; the frame can be a circle, rounded, square or nothing, 64–240px, with or without its rim, on white, paper or nothing, and takes one of the peek band's ten hovers. Home's greeting is a list that takes turns. The defaults are exactly what it was
- feat(settings): the peek band is yours to set. Settings → Peek band shows it at twice its size: add any pictures — PNG, JPEG, GIF, WebP, AVIF, animated PNG, SVG — up to sixteen, drag them into place, scroll to size, arrow keys to nudge, stack them forward and back. Each picture has its own hover (lift, sink, grow, pop, tilt, spin, wiggle, bounce, glow, fade) with a strength and a speed, an optional picture to swap in while hovered (a GIF there plays from the start each time), and, when it moves, whether it plays always, only on hover, or never — held still while ruri isn't the window in use. It can keep its own colours in the dark themes or swap ink and paper like the line art, and be mirrored. Restore the originals puts the five heads back. Hover in the title bar no longer costs the drag: a picture with a hover leaves the drag region and carries the window itself when pressed and dragged, a double-click zooming it as the title bar's would
- feat(projects): a live card on the projects page lists only its active sessions — working, waiting on you, errored, or with agents still at work in the background — instead of every chat in the project down to the ones that finished hours ago. Its head opens the first of them; an idle card still shows where each chat left off
- fix(home): Home opens a project once. Asked to open one already in the sidebar, it no longer adds a second: the same folder reached through a symlink (`~/Workspace` onto an external drive), in another letter case or by a path relative to the workspace root is the one already open, and so is another folder answering to an open project's name — a backup, a worktree, a second clone. Home is told "already open", any kickoff goes to the open one, and `new_project` makes no folder for a name that is already open
- fix(projects): ruri stays out of a blank project folder, so `bunx create-next-app@latest .` (and `bun create`, `git clone`) run in a new repo instead of refusing it for a `.ruri/` they don't recognise. While a folder holds nothing but what create-next-app builds around — `.git`, `.gitignore`, `LICENSE`, editor folders — ruri keeps its catch-up brief and component index to itself and clears a `.ruri/` it left there before as a prompt goes in; the turn that gives the project something real writes them
- feat(sidebar): the row dragons chomp while their chat works — two drawings on the thinking doodle's half-second clock, frozen when scrolled out of view or when ruri is not the window in use — and a hover bites twice with a shake and holds the jaws open until the pointer leaves. The Projects row wears one beside its count while anything is working
- fix(sidebar): a row dragon no longer stays after the work is done. Answering a card with no turn running (a background agent asking after the turn was over) set the chat back to "working" with nothing left to end it; a Codex or ACP chat answered that way stayed on "permission". A process gone mid-turn now leaves its chat idle, and a background card whose task has left the CLI's own live set is closed if its end never arrives
- fix(sessions): a turn Claude Code starts on its own — a background task ended, and it wakes to answer — is a turn. The chat shows as working, prompts queue behind it, and its process is no longer reaped mid-answer (the model used to never hear its task had finished). A prompt sent as it woke used to be signed "done" by the woken turn's result, half a second in, while its real answer ran on after with the chat marked idle; each prompt is now echoed back as the CLI takes it up (`--replay-user-messages`), and a result that comes before the echo is folded into the prompt's own turn
- feat(queue): a turn that fails for a dropped connection or a usage limit holds the queue instead of sending the next prompt into the same wall. The bar under it says why — "the connection dropped", "the connection is back", "usage limit reached until 9:20 PM" — and Send queued sends it when you say. A dropped turn's retry waits for the connection to come back instead of spending its tries against a dead line; "Can't reach the API server" and "Connection refused" now count as dropped connections
- fix(statistics): the running agents' table no longer butts against the tiles above it
- feat(settings): Integrations — the MCP servers, plugins and marketplaces Claude Code and Codex use, listed (everywhere, or for a project), added, removed, searched and installed from Settings through each CLI's own commands, with a server's secrets shown by name only; warm chats on the changed harness restart as each goes idle
- feat(settings): the harnesses keep themselves current. Every coding CLI on the machine is looked at on the hour — version, newest, how it was installed — and brought up to date the way it came (its own updater, bun, npm, brew), never under a chat that is mid-turn on it; warm sessions on an updated one retire as each goes idle. Settings → Harnesses shows them, with Check now, Update, and a switch to update any one by hand
- feat(composer): cut in instead of queueing — ⌘Enter, ⌘-click send, or hold Enter past a ring that closes round the send button stops the running turn and sends the prompt in its place, with anything already queued following it
- perf: the small model stops heating the machine. Every recall note, tracker split, title and brief update is a CLI process, and a `codex exec` started every MCP server in the user's `config.toml` for each one — measured at 463 MB across nine processes for twelve seconds, several times a turn, per chat. Codex now answers them without the user's config (167 MB, three processes), they run two at a time across the app instead of all at once, and a project's catch-up brief folds its turns in together at most every ten minutes instead of after every one
- feat(queue): folding one queued prompt into another keeps the line's order — the one nearer the front reads first, whichever was dragged — and the fold wears an undo for eight seconds that puts both back where they stood
- feat(sidebar): a session at work has a small dragon's head where its X goes (a folded folder has one for the sessions inside); hovering the row makes it chomp twice
- feat(home): the chat and statistics pages slide past each other, the strip's pill gliding across, instead of the pane redrawing
- feat(agents): scripts the model leaves running in the background show on the agents page as cards of their own — running, then how they exited — and open onto their command and output
- fix(agents): an agent the model sends on again (after a failure, or with more to do) picks its own card back up instead of staying "failed" — within a process and across a process that closed in between
- feat(projects): a project counts as working while agents or scripts it left running are, with its turn over — on the projects page and in the sidebar
- feat(rewind): a rewind puts back everything the discarded turns did, and nothing else. ruri checkpoints the tree as each turn ends as well as as its prompt goes out, and takes each discarded turn's own change back out of the tree as it stands — so a shell edit, a generated file or a commit goes back too (Claude's own checkpoints never saw those, and were used first), while an edit of your own between turns or another chat's work in the same repository stays; a file both changed has the turns' lines merged back out, or goes back whole and is named. Branches and tags the turns moved go back (a commit taken back, a branch or tag they made taken away, HEAD back on its branch) unless their commits are already pushed, and everything from before the rewind stays reachable under `refs/ruri/<session>/undo`. The context dragon now moves with it: it reads what the conversation held once the kept exchange was over, where it used to keep the tip's number on Claude and drop to zero elsewhere; a fork opens reading its branch point, not the source's tip. Rewinding the first prompt after a compaction keeps the compaction's brief instead of starting the model on nothing, and a tool that can change a file waits for its prompt's checkpoint to be written
- feat(ideas): the box an idea is written in is a real one — it grows with what is written (Shift+Enter for a new line), takes pictures pasted, dropped or picked, and keeps whatever is in it until it is added, through leaving the page and through a relaunch. An idea's pictures show under it, can be added or taken off while editing it, and ride into the composer with it
- feat: Tab flips between the Home agent and the projects page, whenever nothing else wants the key; coming back lands on Home's chat with the caret in its box
- fix(chat): a fresh session's header buttons — agents aside, the skills, components, ideas and tracker pages — open before the first prompt too. The hero was drawn ahead of the page the buttons pick, so pressing one lit it and changed nothing

- perf: ruri stops costing the battery once you look away. A chat open in a window keeps its agent process warm so the next prompt is instant, but "open" now means open in front of someone: a warm `claude` is 200-odd MB and goes on asking for the CPU while it sits there, which is what had macOS naming ruri under *Using Significant Energy* with nothing running. A chat open only in windows nobody is looking at keeps its process for a minute (`RURI_ASLEEP_REAP_MS`) instead of ten, and the statistics meters — a `ps` over every process on the machine, twice a second — stop sampling altogether. Switching apps for a moment costs nothing; walking away gives the memory and the battery back

- build: eslint, prettier and editorconfig; `bun test` unit tests and `bun run test:scripts` for the token-free integration scripts; CI on GitHub Actions
- build: runtime packages listed under `dependencies`; the bundle is unchanged
- build: builds are signed with a local self-signed identity (`make identity`), so macOS privacy grants survive a rebuild; the grant reset runs only for an ad-hoc build, and only for the services ruri uses
- fix(desktop): quit waits (up to five seconds) for the bridge and the server to close; links open outside only for http, https and mailto; navigation off the app's origin is denied; the login-shell PATH sniff no longer blocks start-up
- fix(dev): the tuner's POST endpoints on :5173 take requests only from the dev page's own origin
- refactor(manager): the Home prompt no longer carries the Aoki Ruri persona
- docs: the README split into `docs/` (features, architecture with the security model, testing, permissions, harness integration, roadmap); LICENSE (MIT), CONTRIBUTING and this changelog

## v0.76.0 — 2026-09-15

- flat paper: no rules around panels, no drop shadows, surfaces told apart by shade; capped boxes in the chat take the wheel only once you are in them

## v0.75.0 — 2026-09-15

- perf: the agent ring turns in 30 steps at 15 a second instead of 8 at 4
- perf: asleep (behind another app, minimised, hidden) ruri draws nothing: no live stream, server messages held unapplied, running animations paused; waking catches up in one render and fades the new things in
- feat: the agents page, a page of its own behind a robot button that is always in the chat header
- feat: agents of your own, with a brief, a model, follow-ups, stop, and a hand-off of the report to the composer

## v0.74.1 — 2026-09-15

- Folded exchanges light up whole on hover again
- Open prompts fold instantly on click, with a dashed-edge hover preview
- Open replies fold by a full-height rail instead of a click anywhere

## v0.74.0 — 2026-09-14

- Compaction briefs list at most 40 exchanges; older ones fold into a small-model digest
- Compaction list shows the digest range and real exchange numbers
- Click an opened prompt or reply to fold it back

## v0.73.0 — 2026-09-13

- Only the open chat streams; other chats catch up when opened
- Agent processes close the moment their work is done unless the chat is open; background subagents hold them until they finish
- Nothing animates outside the open chat; movers tick at their real change rate on their own layers
- Empty prompt box no longer re-measures every 400ms

## v0.72.2 — 2026-09-13

- No infinite CSS animations: one 2-4 Hz clock drives everything that moves
- Everything holds still while ruri is behind another app
- Music waveform/notes at 15 Hz, audio engine off animation frames

## v0.72.1 — 2026-09-13

- No more 30-second agent progress summaries; an agent's card shows the last thing it did

## v0.72.0 — 2026-09-13

- Subagents (Claude Agent tool, Codex spawn_agent) as live cards in the chat
- The agents panel: each agent's own conversation, live, and the list of all
- Agent logs persisted apart from the chat; stale running agents settle to stopped

## v0.71.2 — 2026-09-13

- The dragon gauges share the thinking indicator's softer ink

## v0.71.1 — 2026-09-13

- The thinking indicator shares the dragon gauges' ink

## v0.71.0 — 2026-09-13

- A folded prompt or reply opens on its own; full exchange opens both
- Opening lands at the top of what opened, not its end
- The whole missing-note backlog is written right after launch

## v0.70.0 — 2026-09-12

- Exchanges above a compaction always shown, folded to their notes as chat
- Small model falls back to the other harness's cheap model when spent
- Missing recall notes backfilled in the background

## v0.69.0 — 2026-09-12

- feat: transcripts split into a live part and a capped append-only history
- feat: /compact collapses the chat; an earlier view shows what came before, folded
- fix: idle reaper spares sessions with background work
- fix: no fallback-font flash at launch
- chore: bundle sweep that sees the running app, make tidy, launch-time cleanup

## v0.68.0 — 2026-09-12

- perf: bridge windows and launched apps close a few seconds after the turn ends, unless taken over
- perf: new-component stars turn on one shared 10 fps clock that stops when unseen
- chore: yagami ^0.8.2 from the registry; make no longer builds a sibling checkout

## v0.67.0 — 2026-09-12

- perf: idle chats' agent processes close after ten minutes and resume on the next prompt
- perf: replies stream a paragraph at a time; chat messages stop re-rendering together
- perf: the music engine only runs while playing and releases the audio device on pause
- perf: Home keeps its newest 50 events; the component star turns three times and stops
- fix: yagami v0.8.2 ends every CLI with its whole process tree

## v0.66.0 — 2026-09-12

- perf: main bundle deduped and minified (4.9 → 2.1 MB), English-only Electron locales (−47 MB), lossless PNG re-deflate
- perf: connect snapshot carries transcript tails; chats load on open (18 MB → 0.5 MB)
- perf: Chromium cache capped and cleared, stale bridge partitions pruned, orphaned uploads swept
- perf: cursor poll only while focused; compact atomic archive writes

## v0.65.1 — 2026-09-10

- Home's close_project replaces remove_project (same behaviour, clearer name)

## v0.65.0 — 2026-09-10

- hide projects without closing them: the hidden fold at the foot of the sidebar
- Home agent tools: new/find/open/hide/unhide/remove/list projects, by name
- find_project scoped to the workspace root, stops inside repos

## v0.64.0 — 2026-09-10

- feat(permissions): the grants as macOS holds them, asked for by hand; reset on update; pictures in replies open the viewer

## v0.63.1 — 2026-09-09

- fix: no pencils in the sidebar; a carried role tag no longer blinks the row; pictures a reply points at by path show up

## v0.63.0 — 2026-09-09

- feat(switcher): tap the right Option key for a search that goes anywhere

## v0.62.0 — 2026-09-09

- feat: rename sessions and projects in the sidebar; carry, fold and rewrite queued prompts; the composer bar folds when it cannot fit
- feat(port): reclaim the port from a ruri that outlived its app; GPT Luna as the small model; the star only favourites
- fix(composer): chips no longer vanish when a line ends flush with the edge

## v0.61.1 — 2026-09-06

- Reverts v0.61.0 (the detached server and the harness updater); the app is one process again

## v0.61.0 — 2026-09-05

- The app and the server are two processes: ⌘Q (or a crash) never takes a session
- A newer app makes the old server step aside once idle; make update interrupts nothing
- Every installed coding CLI is checked hourly and updated the way it was installed

## v0.60.0 — 2026-09-05

- The default model is a role: a third star crowns it; the newest Fable is the floor
- Crowning pins everything that exists to the old default; only new chats and projects move
- Small-tasks and default tags drag between catalog rows
- Dropped turns are always retried; the switch is gone

## v0.59.0 — 2026-09-05

- Result events record which models answered and the turn's prompt-cache reads
- model-switch-test proves switching under a running turn and switching back keeps the cache

## v0.58.0 — 2026-09-05

- Model, effort and permission mode are per chat; the project keeps only what a new chat starts on
- A pick made during a running turn waits for the turn to finish
- Forks keep their source chat's settings

## v0.57.1 — 2026-09-05

- Recall notes that comment on the message instead of compressing it are retried, then dropped for a plain cut

## v0.57.0 — 2026-09-05

- Home is two pages under a tab strip: the agent's chat and the projects board
- Projects page redesigned: spend tiles, live cards first, status pills, no clipping

## v0.56.3 — 2026-09-03

- fix(composer): the box refits itself on a resize, so the marker chips stay on their words instead of vanishing until the next keystroke
- fix(drafts): a draft save the socket dropped goes again on reconnect, bytes and all
- test: bun run chips-test drives the real app through a resize

## v0.56.2 — 2026-09-03

- feat(questions): Enter in the Other box moves to the next question; Shift+Enter is a new line; Enter on the last question sends when everything is answered

## v0.56.1 — 2026-09-03

- fix(questions): the card shows one question at a time again; the strip that leaked past the card's edge is gone, and only the slide is kept

## v0.56.0 — 2026-09-03

- fix(composer): a chip's pill is never cut at the box edge; two chips side by side read as two
- feat(rewind): ruri's own per-prompt file checkpoints — the files go back on every harness, not just Claude
- feat(composer): the command menu — type / and see everything that would actually run

## v0.55.1 — 2026-09-02

- fix(composer): chips shaped by the textarea's own computed style, moved with its scroll, stepping aside on disagreement
- fix(composer): a slash command chips only once whitespace follows it; a space is kept between a chip and a word typed against it
- fix(transcript): selection flags hide once their line reaches the textbox
- fix(pages): Components, Ideas, Skills and Tracker scroll edge to edge
- fix(header): the Skills button is a puzzle piece
- fix(sketch): air between the pad's name and Attach

## v0.55.0 — 2026-09-01

- composer: chips aligned to their words; commands as chips; click opens, hover lights, Backspace removes whole markers; removing an attachment strips its markers; height and caret survive the shell
- sketch pad: text box with fonts and sizes placed by click; saved as drawn; Escape no longer closes it
- transcript: selection flags at each end of a selection, draggable, edge-scrolling
- the bridge: a session sees and drives what it built — hidden browser window over CDP, background desktop apps over CDP or Accessibility, an MCP server for Claude and an HTTP endpoint for every other harness, and a preview strip with take-over

## v0.54.0 — 2026-09-01

- questions: answers persist across navigation; multi-question cards slide, and a picked single-choice answer moves on by itself; a card whose tool call moved on sends answers as a prompt
- prompts: slash commands inside a prompt run first; quoted ones are inert
- composer: attachment markers are chips (hover, drag to move, click to place the caret); a sketch pad with pen, arrows, boxes, ellipses, labels; draw on attached pictures
- home: the board — every project as a live card with its spend, from a per-day ledger; the agent finds projects by name instead of guessing
- chat: fork a conversation at any exchange; import Claude and Codex chats started outside ruri
- catch-up: the brief is written whole from the repo for new projects (stack, how to run, layout, conventions), per project, with a rebuild on the Components page
- fixes: the player opens on the playing track; the ideas badge no longer escapes to the window corner; rewind brings attachments back; session naming no longer fails on task-shaped prompts

## v0.53.1 — 2026-09-01

- The model picker names the version: Opus 5, Fable 5.1, Haiku 4.5

## v0.53.0 — 2026-08-31

- Name everything already in the repo, with screenshots and new-component stars
- The context gauge measures against the window its own model has, not one a harness it no longer runs left behind
- Each limit window says how long until it rolls over
- The model picker marks a 1M model when its ordinary sibling is listed too

## v0.52.2 — 2026-08-30

- A region drawn against the picture's edge closes there instead of looking open-ended

## v0.52.1 — 2026-08-30

- Region drags survive leaving the picture
- The rapid-fire line's right edge sits on the textbox's

## v0.52.0 — 2026-08-30

- No stale frame when switching sessions
- The rapid-fire line carries its own surface and reads clearly

## v0.51.2 — 2026-08-30

- The theme dial is legible at a glance, and dragging it selects nothing

## v0.51.1 — 2026-08-30

- The settings pane scrolls from anywhere in it, not only over the column of settings

## v0.51.0 — 2026-08-29

- The theme schedule is a 24-hour dial, its ring painted in the three themes

## v0.50.1 — 2026-08-29

- Each project's shells open in that project's directory

## v0.50.0 — 2026-08-29

- Settings redone as a normal scrolling page: grouped rows, one scrollbar, uniform alignment

## v0.49.2 — 2026-08-29

- The settings header card actually gets its gap above the theme row

## v0.49.1 — 2026-08-29

- Clicking a component's screenshot opens it; a corner x removes it

## v0.49.0 — 2026-08-29

- The naming card shows the model's screenshot of what it built, kept with the entry

## v0.48.0 — 2026-08-29

- Terminal tabs: as many shells per project as you need, remembered across launches (⌘T, ⌘1–9)
- Window preferences persist: theme, theme clock, unfolded folders, player volume — kept on the machine, with the app's port pinned
- Edge presses on animated buttons land, via pointer capture
- 2.5x less main-thread blocking per session switch; startup bundle 906kB → 570kB
- Room between the settings header and the first row

## v0.47.3 — 2026-08-29

- Rapid fire's controls sit 14px above the textbox, right-aligned with it, instead of level with the dragons' heads
- make install no longer deletes the running app's bundle: the old one is moved aside, so installing an update never kills the session that asked for it

## v0.47.2 — 2026-08-29

- Settings sits 64px below the window's top edge instead of flush against it, and that band drags the window

## v0.47.1 — 2026-08-29

- Opening a session lands at the newest message: only a gesture (or a move upward) can unpin the view, and the switch holds the bottom while the tail settles

## v0.47.0 — 2026-08-29

- Components are named from the chat: the model registers what it built and a card asks what to call it; the manual add box is gone
- mcp__ruri__name_component / mcp__ruri__list_components, with .ruri/components.jsonl for harnesses without ruri's tools
- Click a skill to read its SKILL.md, rendered
- Rapid fire's controls move above the composer, out of the header
- Settings becomes a page instead of a card that could not fit

## v0.46.0 — 2026-08-29

- Ideas: a per-project board nothing writes but you
- Components: your names for parts of the interface, indexed into .ruri/components.md and handed to prompts that name one
- The vault: credentials the model can use without reading — {{handles}} filled at the tool boundary, $RURI_SECRET_* on every harness, values redacted back out of the transcript
- Skills: both scopes listed, installed and removed through bmo, with an off switch ruri invented
- Catch up is no longer a page: it writes itself into .ruri/catchup.md and the session is told it is there
- Rapid fire announces each hand-off with the project's name
- The tracker page loses its misleading X; the header buttons close up

## v0.45.0 — 2026-08-29

- three hero faces are now the titlebar's own hand-cut heads (v3, v6, v8)
- hero circles fit the picture whole and are framed from there, so non-square art can be placed rather than blind-cropped
- art tuner: per-face x/y/zoom fields, arrow nudging, fit/fill, faces first and the raw pages folded away

## v0.44.0 — 2026-08-29

- the art tuner (place, frame, and cut the heads); rewind survives a compaction

## v0.43.0 — 2026-08-29

- windowed transcripts, cached markdown, idle prewarm: 144ms switches become 28ms

## v0.42.0 — 2026-08-29

- catch-up briefs, a shell in the composer, ember mode on a clock, bypass by default, edge-press fix

## v0.41.0 — 2026-08-29

- rapid fire is the chat itself, and the hand-off takes a beat

## v0.40.1 — 2026-08-29

- the usage gauges open on numbers; a failed read retries in seconds

## v0.40.0 — 2026-08-28

- rapid fire walks the chat pages; a patch names its own file, no chip above it

## v0.39.2 — 2026-08-28

- rapid fire opens at the bottom of the exchange, and its questions get the picker

## v0.39.1 — 2026-08-28

- one question at a time, no chip above it

## v0.39.0 — 2026-08-28

- the model reads a file's path where the marker was; you keep the marker

## v0.38.0 — 2026-08-28

- regions numbered across the prompt, marked at the caret

## v0.37.4 — 2026-08-28

- an image preview's click target is the image

## v0.37.3 — 2026-08-28

- a queued prompt edits in the composer, attachments and all

## v0.37.2 — 2026-08-28

- sentences from a harness keep the space between them

## v0.37.1 — 2026-08-28

- harness turns read in order, patches end where they end

## v0.37.0 — 2026-08-28

- gauges, patches, tool names, and rewind on every harness, not just Claude

## v0.36.0 — 2026-08-28

- attachments survive a quit with the draft that holds them

## v0.35.0 — 2026-08-28

- the image viewer covers the window, patches wrap, drafts survive a quit, and rewind finds its prompt

## v0.34.1 — 2026-08-28

- the jump pill sits just above the textbox, whatever the dock's height

## v0.34.0 — 2026-08-28

- the composer floats over the transcript on no background of its own

## v0.33.0 — 2026-08-28

- tracker names outcomes, not clauses

## v0.32.0 — 2026-08-28

- permission modes for agentic harnesses

## v0.31.0 — 2026-08-27

- bigger dragons, labels on the hint line, self-healing context

## v0.30.0 — 2026-08-27

- SVG dragons

## v0.29.0 — 2026-08-27

- inline diffs, no tracker auto-open

## v0.28.0 — 2026-08-27

- read images preview inline

## v0.27.0 — 2026-08-27

- dragon gauges for context, 5h, weekly, and the model-scoped window

## v0.26.0 — 2026-08-27

- hairline compaction tear, AskUserQuestion picker

## v0.25.0 — 2026-08-27

- auto tracker items are bound to the prompt they were split from: edit & rewind removes the discarded prompts' items and the edited prompt re-extracts fresh ones on send

## v0.24.0 — 2026-08-27

- tracker is a strict prompt splitter, fired at send time (fixes requests lost to interrupted turns / continue follow-ups)
- Finish review assembles the fix-it prompt mechanically — no model
- repeat mode is session-only, never persisted

## v0.23.0 — 2026-08-27

- effort dropdown loses the Default entry; unset = xhigh everywhere
- rewind pencil opens the prompt in an editable card; Rewind & send rewinds then dispatches the edit as the next turn

## v0.22.0 — 2026-08-27

- player repeat button: off / loop playlist / loop track
- reasoning-effort switcher in the composer (per project + Home)
- tracker extracts from the user's prompts only
- attachment markers insert without touching typed text
- closing the last session keeps the project folder
- stopped-response line drops the stop-square icon
- yagami 0.6.1: file rewind works (edit-pencil after stop)
- set_model/set_permission_mode now reach live sessions

## v0.21.1 — 2026-08-26

- chore: @justin06lee/yagami ^0.6.0 from npm (file: stopgap removed)

## v0.21.0 — 2026-08-26

- feat: Codex/OpenCode/ACP sessions run their real interactive engines verbatim (yagami 0.6.0 openSession) — own config/sandbox/approvals, tool chips, Allow/Always/Deny cards
- dep: yagami via file:../yagami pending the 0.6.0 npm publish

## v0.20.0 — 2026-08-26

- feat(home): ephemeral chat — wiped at every launch and on navigating away/back (running turns finish first)
- feat(titlebar): the skyline is a full drag region again; hover lifts now ride a main-process cursor poll

## v0.19.0 — 2026-08-26

- feat(models): star a catalog model twice to crown it the small-tasks model (summaries, titles, splitting, tracker); any harness; persisted; RURI_SMALL_MODEL/haiku as fallback
- feat(home): chat header removed on Home — transcript flush under the skyline

## v0.18.0 — 2026-08-26

- feat(home): manager works on ANY harness — non-Claude Home opens sidebar projects via a .ruri/open.jsonl drop file drained at end of turn (kickoff prompts included)
- feat(home): sharper manager prompt (naming projects = open them; never Finder) + RuriDragon personality (Home only)
- composer placeholder is always 'Message ruri…'

## v0.17.0 — 2026-08-26

- feat(models): picker shows bare model names — no harness suffixes, ACP group prefixes stripped
- feat(models): catalog re-probes every installed harness when Settings opens (30s throttle)
- feat(music): note icon constant; analyser waveform sits between title and chevron; floating notes more visible

## v0.16.0 — 2026-08-26

- Account bar under the music player: local user stub + settings gear + connection dot
- Title bar is purely the peek skyline (gear no longer hides behind head five)

## v0.15.3 — 2026-08-26

- Titlebar peeks laid out by hand in the peek tuner (bigger, overlapping, corner to corner)
- Hover actually works in the app (heads exempt from the window-drag region)
- Retouched B/W ruri3, inverting with the theme

## v0.15.2 — 2026-08-26

- Titlebar peeks are the user's own hand-cut PNGs
- Hover = a slight upward lift revealing the face, nothing more

## v0.15.1 — 2026-08-25

- Skyline heads are transparent PNG cutouts peeking over the halftone (no white panels)
- Pops bounded to real art; dark mode inverts ink cutouts, colored art exempt

## v0.15.0 — 2026-08-25

- Peek skyline: five head panels collaged across the title bar, hover pops the face down
- Live music visuals: analyser-fed five-bar waveform + floating notes
- Hero pool rebaked with the second round of editor tuning

## v0.14.0 — 2026-08-25

- Unset model = Fable; the ambiguous 'default' entry is gone everywhere
- Peek piano: hoverable manga-chip filmstrip across the title bar
- Hero pool grows to 13 with the new downloads (editor up for tuning)

## v0.13.1 — 2026-08-25

- Titlebar: peek parade (four heads lined up over the header edge)
- Fable + Codex GPT-5.6-Sol starred out of the box
- Home composer offers any starred model (manager tools stay a Claude perk)
- Dark mode: opaque gray hero ring instead of white bleed-through

## v0.13.0 — 2026-08-25

- Settings: searchable device-wide model catalog; starred models are what the composer picker offers
- Clean model names (no 'default' alias, no parentheticals; provider labels separated)
- Titlebar: centred horns, wordmark removed

## v0.12.2 — 2026-08-25

- Hero pool baked from the user's editor framing; flexing panel dropped (10 variants)
- Model picker fully populated at app launch (Claude + all harnesses), no session required

## v0.12.1 — 2026-08-25

- Titlebar mark: Ruri peeking over the header edge (transparent horns+head crop, dark-mode invert)
- Music play button matches the other ghost controls
- Hero crops loosened (ruri5 promo text fully excluded, ruri2 recomposed)

## v0.12.0 — 2026-08-25

- Sessions on any yagami-driven harness: Codex, OpenCode, Gemini, any ACP agent (provider:model ids in the picker, sandboxed turns with resume)
- Randomized Ruri hero faces (11 cropped variants; per-launch on Home, stable per project)
- Configurable music library path in Settings
- Model/permission dropdowns on the Home composer
- Chrome art unselectable/undraggable; Home row uses a house icon

## v0.11.0 — 2026-08-25

- projects are folders of parallel sessions; each session auto-named by its role after the first turn
- prompt attachments: images/videos with markers, previews, full-size viewer, drag-to-annotate regions sent as crops
- prompt splitter: long messages split into near-verbatim sub-prompts fed one by one (strictly no invented content)

## v0.10.1 — 2026-08-25

- connection dot appears only while reconnecting
- home hero tagline removed
- workspace path is plain text, not a chip

## v0.10.0 — 2026-08-25

- settings modal via the sidebar gear: theme switch + workspace root
- folder groups are one level only (no recursive nesting)
- sidebar can never scroll horizontally

## v0.9.0 — 2026-08-25

- sidebar folder tree (nested, collapsible, persisted)
- starrable projects with a Starred section
- row cards blend into the sidebar

## v0.8.4 — 2026-08-25

- sidebar: Home, then one Projects heading, flat list, roomier rows
- hero: icon/title/composer tightened vertically

## v0.8.3 — 2026-08-25

- unselected sidebar rows get subtle card backgrounds with gaps
- no description under hero titles; no path under the header title
- logo back in the traffic-light-cleared position

## v0.8.2 — 2026-08-25

- centered hero on every fresh session, composer included
- Space Grotesk UI font (bundled)
- ghost dropdown triggers; borderless dark mode; logo hard top-left

## v0.8.1 — 2026-08-25

- model/permission dropdowns live inside a taller composer (menus open upward); header decluttered
- dark mode: borderless — background elevation separates components, hairline edges only, indicators stay white
- face image padded so horn tips clear circular frames

## v0.8.0 — 2026-08-25

- Home workspace-manager agent: the default view is a Claude Code session at the workspace root with MCP tools to open projects and kick their sessions off from one prompt; hero view (face, sup., centered composer, workspace line); Add-project button retired
- dark mode: black/dark-gray surfaces, white ink, gray borders

## v0.7.0 — 2026-08-25

- music player in the sidebar (ported from home): folder-per-playlist library in ~/Music/ruri, two-deck crossfading Web Audio engine, Range-streaming from ruri's own server
- dark mode (inverted manga), persisted toggle
- turn memory: haiku summarizes every prompt/response pair as it finishes; older turns fold to their notes instantly and expand on click; transcripts + summaries + session ids persist across restarts
- feature tracker: auto-extracted per-project checklist of things to test by hand, with notes, manual/background items, and send-to-composer

## v0.6.0 — 2026-08-25

- add-project opens the native macOS folder picker (typed-path fallback in browser dev mode)
- custom manga dropdown components replace native selects
- code-block copy is an icon button; result-line check/cross are SVG
- header status pill removed (redundant with sidebar dots)
- face crop: white headroom above the horn tips

## v0.5.0 — 2026-08-25

- manga theme: monochrome ink-on-paper UI (warm low-blue paper, screentone shading, shape-coded statuses, grayscale highlighting)
- Ruri face mark in sidebar/empty states replacing the kanji
- app icon: horns + top of head in a white manga panel squircle
- RURI_USER_DATA isolation for dev/screenshot runs

## v0.4.0 — 2026-08-25

- sessions migrate to @justin06lee/yagami 0.5.0 AgentSession: terminal parity (CLAUDE.md/skills/hooks/allow-rules now actually load), always-allow with the CLI's suggested rules, per-project model and permission mode, live model switching
- front-end overhaul: markdown transcript with highlighted code + copy buttons, model picker, permission-mode switcher, plan cards, smart autoscroll, lapis design system, token-free fixture mode

## v0.3.1 — 2026-08-19

- README banner: vectorized Ruri Dragon panel (user's screenshot), henri-style frame
- App icon: original dragon-girl mark (lapis bob, ivory horns, gold spark)
- make launch opens /Applications/ruri.app explicitly

## v0.3.0 — 2026-08-18

- feat(desktop): Electron shell — ruri.app, single-port UI+WS, login-shell PATH recovery, warm sessions survive window close
- build: app icon (lapis gem), electron-builder dir target, Makefile (make = build → install → launch)
- refactor(server): importable startServer() with static file serving
- fix(web): stable zustand selectors — production UI crashed on mount (latent since v1)
