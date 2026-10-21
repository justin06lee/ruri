# Component library

Every piece of this project's interface ruri has on file: the user's own
name for it, its handle, and its files. When the user names something
here, this is what they mean — go straight to its files rather than
searching for their words. Before building interface, look here first
and reuse what exists: `ruri search <words>` finds one, `ruri show <slug>`
reads it with its code and its pictures, `ruri add <slug>` copies it into
place, `ruri help` says the rest.

ruri maintains this file. Don't edit it by hand; it is rewritten whenever
the library changes.

## terminal-tabs — terminal tabs
The numbered row across the top of the composer's terminal mode — one tab per shell, plus button and cmd-T for another, cmd-1..9 to switch. The row belongs to the server and is written to ~/.config/ruri/terminals.json, so it outlives the app; the shell processes don't.
Its files: web/src/components/Terminal.tsx
Reaches into: server/terminal.ts, web/src/styles.css (at `.terminal {`)

## name-everything-button — name everything button
The Update everything button at the top of the Components page: follows moved files, retires entries whose code is gone, has the small model rewrite outgrown notes and judge whose look changed, names what nobody has, then photographs everything without a current picture — by selector, and in a 'Library pictures' chat for the rest.
Also called: update everything button, update everything
Its files: web/src/components/Components.tsx
Reaches into: server/handlers/components.ts, server/libraryRefresh.ts, server/photographer.ts, server/sweep.ts, server/shots.ts, desktop/capture.ts

## new-component-stars — the new component stars
The spinning star on a component nobody has looked at yet: beside the name for what the last prompt named, hooked over the card's top-left corner (on the border) once a newer prompt has gone out, and on the Components button so a turn that named something says so without the page open. Hovering a card or leaving the page takes it off.
Its files: web/src/components/Components.tsx
Reaches into: web/src/components/ChatPane.tsx (at `<div className="working-line">`), server/components.ts (at `) as LibraryFile;`), web/src/styles.css (at `.seg {`)

## home-page-all-projects-section — home page all projects section
The cards above the Home agent: one per open project with a status word, three live lines of what its lead is doing, and its spend today and all told; the strip on top adds every project up from the per-day ledger. Fold it with the chevron.
Its files: web/src/components/HomeBoard.tsx
Reaches into: server/ledger.ts, web/src/styles.css (at `.home-tabs-space {`)

## drawing-page — drawing page
The drawing page the pen next to the composer's shell toggle opens: pen, arrows, lines, boxes, ellipses, labels, five colours, three widths, undo. Attach drops it in the prompt as an image; opened from the viewer's "Draw on it", Put it back replaces the attachment under the same marker.
Its files: web/src/components/Sketch.tsx, web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css (at `.comp-toggle {`)

## attachment-tags — attachment tags
The [image #1] markers in the composer drawn as chips over the textarea by a mirror of the prompt: hover inverts, drag moves the marker (snapping to a word boundary), click puts the caret after it. The mirror must keep the textarea's exact font, padding, and wrapping or the chips drift off their words.
Its files: web/src/components/Markers.tsx, web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css (at `.comp-toggle {`)

## recent-chats-dropdown — recent chats dropdown
"chats from outside ruri" at the foot of the team page: unfolds to the Claude and Codex sessions on disk for that directory that ruri did not make, tagged cc/cx; clicking one brings it in as a teammate whose duty is to carry on that chat, and the lead's next message resumes the real thing.
Its files: web/src/components/TeamPage.tsx
Reaches into: server/recent.ts, server/server.ts

## question-box — question box
The AskUserQuestion card with several questions side by side on a strip that slides between them: picking a single-choice answer moves on by itself, the card is as tall as its tallest question, and every pick and typed "Other" survives leaving the session. When the tool call behind it has moved on, the card says so and "Send as a prompt" sends the answers as a new prompt.
Its files: web/src/components/Questions.tsx
Reaches into: web/src/styles.css (at `.ask-card {`)

## selection-flags — the selection flags
A flag at each end of a transcript selection (double-click a word, or drag one out); drag a flag to change what is selected, scroll first if you like, and near the transcript's edge the drag scrolls it. Drawn fixed in a portal over the page; the flags take no pointer while one is dragged so the caret lookup finds the text underneath.
Its files: web/src/components/Selection.tsx
Reaches into: web/src/components/ChatPane.tsx (at `<SelectionFlags scrollerRef={scrollRef} />`), web/src/styles.css (at `.sel-bar {`)

## drawing-page-text-box — the drawing page text box
The box the sketch pad's text tool (T) opens: write several lines, Font… for a face and a size, Place… hangs the words on the pointer to be stamped where the next click lands; Esc during placement brings the box back with the words. Reuses the confirm card's classes.
Reaches into: web/src/components/Sketch.tsx (at `break;`), web/src/styles.css (at `align-items: center;`)

## bridge-strip — the bridge strip
The plate above the composer showing what a session is driving in its hidden window or background app: a live thumbnail (click for full size), title and address, Take over / Give back, and a close. Floats like the rapid-fire plate, off the textbox's measured height and right edge, and stacks above it when both are on. Fed by the server's `bridge` messages; the previews come from ~/.config/ruri/bridge/<channelId>/preview.png.
Its files: web/src/components/Bridge.tsx, desktop/bridge.ts
Reaches into: web/src/components/ChatPane.tsx (at `<BridgeStrip channelId={activeId} stacked={rapid?.on} />`), web/src/styles.css (at `.bridge-plate {`), server/bridge.ts

## patch — the patch
Shows changes from a Write or Edit as a git-style diff with line numbers; collapsible by file.
Its files: web/src/components/Diff.tsx
On screen: .diff

## ideas-board — the ideas board
User's project wants list; send to composer via arrow, mark done with checkbox.
Its files: web/src/components/Ideas.tsx
On screen: .board-page

## naming-card — the naming card
Asks user to name a component the model just built; shows screenshot and file paths.
Its files: web/src/components/NameCard.tsx
On screen: .name-card

## player — the player
Plays audio with waveform visualization, repeat modes, and track navigation.
Its files: web/src/components/Player.tsx
On screen: .player

## rapid-fire-bar — the rapid fire bar
The plate above the composer in rapid fire: how many projects in the line are ready and working (each its lead), an all | starred switch for which projects the line goes round, skip (when another is ready) and leave. Right edge measured onto the textbox's. Counts come from the hook's subscribed projects/statuses — never getState(), which the React Compiler caches.
Its files: web/src/components/RapidFire.tsx
On screen: .rapid-plate

## settings-page — the settings page
Configure models, theme schedule, and install skills.
Its files: web/src/components/Settings.tsx
On screen: .settings-page

## skills-page — the skills page
Manage device and project instruction sets; toggling off parks them in skills-off/ rather than deleting.
Its files: web/src/components/Skills.tsx

## feature-tracker — the feature tracker
Test checklist extracted per turn; mark items working or broken, collect fixes for the composer.
Its files: web/src/components/Tracker.tsx

## thinking-indicator — the thinking indicator
Hand-drawn Ruri animation flips every half second while the model processes.
Its files: web/src/components/Thinking.tsx
On screen: .thinking

## code-blocks — code blocks
Syntax-highlighted code with language label and copy-to-clipboard button
Its files: web/src/markdown.tsx
On screen: .codeblock

## attachment-viewer — attachment viewer
Full-size modal for viewing images, PDFs, and text files; users draw region boxes on images
Its files: web/src/components/Attachments.tsx
On screen: .viewer-overlay

## peek-band — peek band
The pictures across the sidebar's top (the title bar), drawn from the band editor; out of the box the mountain path, one picture per theme (day on light, night on dark, sunset on ember), each hidden off its themes by .not-<theme>. While ruri is in use the band is no drag region (html:not([data-asleep])), so every picture gets hover, and a press anywhere carries the window via window_drag → desktop/main.ts windowDrag; behind other apps it is a native drag region again.
Its files: web/src/components/PeekBand.tsx
Reaches into: web/src/styles.css, desktop/main.ts, web/src/lib/awake.ts, web/src/tuner.tsx, web/src/components/Sidebar.tsx
On screen: .band-stage

## working-line — the working line
The caption beside the thinking doodle while a turn runs: a rotating word, then elapsed time, output tokens streamed back, the reasoning effort, and — when nothing has come back for 90s — how long it has been quiet. Fed by a throttled `turn` message the server keeps per channel, so it survives a reload.
Reaches into: web/src/components/Thinking.tsx:60, web/src/components/ChatPane.tsx:1789, web/src/styles.css:2497, server/server.ts:473

## native-question-box — native question box
Provider questions and typed forms with masked secret answers, defaults and validation.
Reaches into: web/src/components/Questions.tsx (at `strokeLinejoin="round"`), shared/questionInput.ts (at `export function questionError(question: AskQuestion, values: string[]): string | undefined {`), server/sessions.ts:1342

## live-plan — live plan
One current provider checklist or proposed plan in the transcript.
Reaches into: web/src/components/ChatPane.tsx (at `? requestIdleCallback(grow, { timeout: 3000 })`), server/sessions.ts (at `this.agents.attach(`)

## model-effort-picker — model effort picker
Reasoning choices come from the selected model’s own capability catalog.
Reaches into: web/src/components/ChatPane.tsx:486, server/providers.ts:23

## home-tabs — the home tabs
The chat | statistics strip at the top of Home, now over a track (HomeDeck): its inked pill is one element that glides to the tab picked, and the two pages slide past each other under it. Only the page showing stays mounted; the other goes up for the slide and comes down after.
Its files: web/src/components/HomeBoard.tsx
Reaches into: web/src/components/ChatPane.tsx (at `if (homeDeck) return <HomeDeck tab={homeTab} onTab={setHomeTab} chat={view} />;`), web/src/styles.css (at `.home-tabs-space {`), web/src/components/ChatPane.tsx

## projects-page — the projects page
The Projects row's page: a head with the project count and how many are working, waiting on you or finished, then a card per project (live ones first under a rule) with a status pill — the whole team's state — and its lead's last lines. Status classes are st-working etc. because a bare working class collides with the transcript's progress line.
Its files: web/src/components/HomeBoard.tsx
Reaches into: server/ledger.ts, web/src/styles.css (at `.home-tabs-space {`)

## model-role-tags — the model role tags
The "small tasks" (filled) and "default" (outlined) tags on catalog rows in Settings; the star cycles none → starred → small → default → none, and either tag drags onto another row to hand the role over. Crowning a default pins every existing project and Home to the old one first.
Its files: web/src/components/Settings.tsx
Reaches into: server/projects.ts, web/src/styles.css (at `selection instead — the hour labels highlighting, the legend beside them`)

## harness-updates — the harness updates
Settings → Harnesses: the ruri server's version (and a waiting update), every installed coding CLI with its version, how it is managed (own updater / npm / bun / brew / left alone) and what the last hourly round did, plus Check now. Rounds never run under a mid-turn session.
Its files: web/src/components/Settings.tsx
Reaches into: server/updater.ts, server/host.ts, desktop/server-entry.ts

## queue-line — the queue line
The queued prompt cards and how they are carried: drop one on another's edge to reorder, on its body to fold the two into one; the pencil takes a card out of the line into the composer and it steps back in where it was when sent. Server rules live next to queue_move / queue_merge / queue_edit / queue_update in server.ts.
Reaches into: web/src/components/ChatPane.tsx:1355, web/src/components/ChatPane.tsx:1448, web/src/styles.css (at `.agent-live-line,`), server/server.ts:1932

## folded-composer-bar — the folded composer bar
What the bottom of the composer becomes when the box is too narrow for three pickers and four buttons: one model menu with "Effort level" and "Permissions" rows opening flyouts beside it, and a ⋯ holding shell, draw and split. Folds on a real measurement of the bar's needs (Composer's `compact`), not a fixed breakpoint.
Reaches into: web/src/components/ChatPane.tsx (at `useLayoutEffect(() => {`), web/src/components/ChatPane.tsx (at `// reading back, not following: nothing may re-bottom the view now`), web/src/components/Dropdown.tsx (at `* The composer's three pickers as one, for a box too narrow to hold them`), web/src/styles.css (at `/* ── the patch under a Write or Edit ──────────────────────────────── */`), web/src/styles.css:6848

## sidebar-rename-box — the sidebar rename box
Double-click a project's row in the sidebar and its name becomes a box with the old name selected. Enter keeps, Escape drops, clicking away keeps. Renaming a project never touches its folder on disk. (Sessions are no longer in the sidebar: a project is its lead.)
Reaches into: web/src/components/Sidebar.tsx (at `s.projects.reduce((n, project) => (!project.hidden && teamAtWork(s, project) > 0 ? n + 1 : n), 0),`), web/src/styles.css (at `/* A name being rewritten in place (NameEditor in Sidebar.tsx): the row's`), server/server.ts:2846

## switcher — the switcher
Tap the right Option key (or ⌘K) and a Spotlight-shaped search stands over the app: projects (each opening its lead), Home, Rapid fire, Settings. The best match completes greyed into the box; Enter goes there, Tab takes the completion, Escape closes. Option held with another key opens nothing.
Its files: web/src/components/Switcher.tsx
Reaches into: web/src/styles.css (at `.switcher-veil {`), web/src/App.tsx

## permissions-panel — the permissions panel
Settings → Permissions: each macOS grant ruri uses as macOS actually holds it, with Ask per row and Ask for everything, plus the privacy database's rows for ruri, the CLIs and the shell. Looking never prompts; asking does. make update resets the grants and the next launch asks again.
Its files: web/src/components/Settings.tsx, desktop/permissions.ts
Reaches into: server/server.ts, Makefile

## hidden-fold — the hidden fold
The eye button on a project's row tucks a project away without closing it; "show N hidden" at the foot of the project list reveals the hidden ones (dimmed) so they can be brought back. Hidden projects also leave rapid fire, the switcher and the projects board.
Its files: web/src/components/Sidebar.tsx
Reaches into: web/src/styles.css, server/server.ts, shared/protocol.ts

## folded-exchanges — the folded exchanges
Exchanges above the newest compaction (and any hand-folded turn) laid out like chat, showing recall notes: prompt note in a dashed bubble, reply note beneath, click to open in full. Fed by the history outline (archive.earlier).
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css, server/archive.ts, shared/protocol.ts

## agent-cards — the agent cards
A subagent in the chat (Claude's Agent tool, Codex's spawn_agent): type, brief, a turning ring while it works, its live activity or report, and tools · tokens · time. Click to open its log. The card is the spawning tool event re-sent in place as the agent moves (SubagentState).
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css, server/sessions.ts, shared/protocol.ts

## agents-panel — the agents panel
Slides over the right of the chat, stopping above the composer: one agent's own conversation live (brief, what it said, every tool), or the list of every agent in the chat from the header's robot button (badge = still working). Esc closes; back steps out. Logs live in ~/.config/ruri/agents/.
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/store.ts, web/src/styles.css, server/agents.ts

## agents-page — the agents page
Replaces the chat when the header's robot button is pressed (always there; badge counts working agents). It lists every agent in the chat, the model's and your own, above a box that starts an agent of your own. Clicking one opens its conversation full-page, with a follow-up/stop line for yours and "Put in the composer". Esc steps back out. Your agents run on their own SessionManager (server.ts) and their cards live in agents/<chat>/@crew.json.
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/store.ts, web/src/styles.css, server/agents.ts, server/server.ts

## flat-paper-look — the flat paper look
All three themes drawn the same way now: no rules around panels and no shadow cast to the lower right — one surface is told from the next by the shade it is printed in, with --rim (ink mixed into the paper) only where a frame is really needed, like a tile or a picture's white ground. The tokens are at the top of styles.css; --edge is now a transparent border that only holds its space.
Reaches into: web/src/styles.css (at `/* ── ruri — manga theme: warm paper, black ink, screentone shading ──`), web/src/theme.ts

## fold-reply-pill — the fold reply pill
Replaces the rail down an open reply's left edge: a "fold reply" pill heading the reply, held at the top of the view the whole way down a long one, dimming the reply under the pointer. Folded from halfway down, the view goes back up to the note it folded to.
Reaches into: web/src/components/Exchange.tsx (at `<div className={`exchange-half${folds ? " folds" : ""}`} data-half="reply">`), web/src/styles.css:2993, web/src/components/ChatPane.tsx (at `// changes when the events do — not on every keystroke into the composer,`)

## statistics-page — the statistics page
Home's second tab, where the projects board used to be: what it has cost (the ledger's three spans, then a row per project), what is running (each chat's live harness process with its memory, cpu and pid, off one `ps` — sampled only while this page is open), and what is left of each provider's usage windows.
Its files: web/src/components/Statistics.tsx
Reaches into: web/src/components/figures.ts, server/resources.ts, server/resources.test.ts, scripts/meters.ts

## idea-box — the idea box
Where a new idea is written on the ideas page: grows with the text (Enter adds, Shift+Enter breaks a line), takes pictures pasted, dropped or picked, and keeps what's in it as the project's idea draft (drafts.json, key idea:<projectId>) through leaving the page and relaunches.
Its files: web/src/components/Ideas.tsx
Reaches into: web/src/styles.css (at `.idea-compose-bar {`), server/handlers/boards.ts, shared/protocol.ts

## row-dragons — the row dragons
Small dragon heads on busy sidebar rows: a project's row while anyone on its team is at work — any session but the lead, the liaison included, whoever started its turn; the lead's own turn lights none (where the X goes) — and the Projects row beside its count of projects with their team at work. They chomp on the doodle's 500ms clock (beat "chomp", two frames), frozen when out of view or the window isn't in use; hovering a row bites twice with a shake and holds the jaws open.
Its files: web/src/components/Sidebar.tsx, web/src/components/Thinking.tsx
Reaches into: web/src/styles.css, web/src/store.ts, web/src/lib/beat.ts

## script-cards — the script cards
A shell the model left running in the background, shown as an agent card with a terminal icon: running, then how it exited. Opens onto its command and the tail of the CLI's output file, re-read every 2s while it runs. Made from the Bash chip when the CLI reports a local_bash task in the background.
Its files: web/src/components/chat/AgentCard.tsx
Reaches into: server/sessions.ts, server/scripts.ts, web/src/components/AgentsPage.tsx

## integrations-panel — the integrations panel
Settings → Integrations: Claude Code's and Codex's MCP servers, plugins and marketplaces, listed and changed through each CLI's own commands; secrets shown by name only.
Its files: web/src/components/Integrations.tsx
Reaches into: server/integrations.ts, server/handlers/integrations.ts, web/src/components/Settings.tsx

## held-queue-bar — the held-queue bar
The line under a queue that is standing by: why (a stop, a dropped connection, a usage limit and when it lifts) and a Send queued button. The queue never goes on its own.
Its files: web/src/components/Queue.tsx
Reaches into: server/blocked.ts, server/queue.ts, web/src/components/ChatPane.tsx

## band-editor — the band editor
Settings → Peek band: the band drawn at 2× over a faint view of what it clips, with drag-to-place, scroll-to-size, the picture strip, and each picture's hover effect, hover picture, GIF mode, themes (light/dark/ember, never none), dark-theme invert, mirror and place fields; Restore the default brings back the mountain path. Saved as the ruri-band pref.
Its files: web/src/components/BandEditor.tsx, web/src/band.ts, web/src/lib/peekBand.ts
Reaches into: web/src/styles.css

## talk-page — the talk page
The chat header's two-speech-bubbles page: which projects your agents may reach (every project's rule, a project's own over it — anyone / only these projects / no one; a team always talks among itself) and the latest messages between agents; the server enforces it in sendLetter.
Its files: web/src/components/TalkPage.tsx
Reaches into: server/talk.ts, server/handlers/talk.ts, web/src/styles.css, web/src/components/ChatPane.tsx

## component-library — the component library
The Components page: a per-project gallery under the board strip (Components, count, Update everything). Search is shared/librarySearch.ts, the same as ruri search (stems, prefixes, synonyms, typos), and marks what it matched; chips narrow it to New / Names to check / Needs a picture / Outdated / Files gone, counted within the search; Recent | A–Z order. Cards show the whole picture as a small copy (lib/thumbs.ts), a line of the note and the handle; a name nobody has kept has a dotted underline. A card opens its page: ← → through the gallery, 'is this what you call it?' with That's right, files-gone notice, outdated notice with Still right, ruri add with Copy, pictures (newest first, × asks first), fields that show what is kept, and its code in tabs.
Its files: web/src/components/Components.tsx
Reaches into: web/src/styles.css (at `/* ── the component library ────────────────────────────────────────── */`), web/src/lib/thumbs.ts, server/library.ts, server/components.ts
Tags: gallery, search, filters, library

## architecture-page — the architecture page
Layers-icon page in the chat header: the project's stack as bars (the index every session is shown), each bar opening its layer's own sheet underneath — where to change what, how it works, key files, rules, what it talks to, what sessions learned there, and who last changed it; then flows, where things are, how to run it, what it does. Every line rewritable or strikable on hover; Read the repo writes it all afresh.
Its files: web/src/components/Architecture.tsx
Reaches into: web/src/styles.css, server/brief.ts, server/catchupBrief.ts

## slash-command-menu — slash command menu
Slash-command picker over the composer listing ruri, harness, skill and custom commands.
Its files: web/src/components/CommandMenu.tsx
On screen: .command-menu

## dragon-gauges — the dragon gauges
Usage gauges flanking the composer that fill from the feet up and sweat past 80%.
Its files: web/src/components/Dragon.tsx
On screen: .dragon-gauge

## confirmation-dialog — the confirmation dialog
In-app yes/no card replacing the browser confirm, plus single-button notices.
Its files: web/src/components/Confirm.tsx
On screen: .confirm-card

## permission-request-card — the permission request card
Ask-first prompt showing which tool wants to run and its input.
Its files: web/src/components/PermissionBanner.tsx
On screen: .permission-card

## composer-pickers — the composer pickers
Model, effort and permission pickers for the current chat; each model shows its maker's doodle (Marks.tsx ModelIcon) in the menu and on the trigger.
Its files: web/src/components/SessionControls.tsx
On screen: .composer-controls

## provider-marks — the provider marks
Over an empty chat: the hand-drawn "lab × product" logo pair for whoever made the chat's model (Anthropic × Claude, OpenAI × ChatGPT, Google × Gemini, …), then the chat's title or Home's greeting. markFor() picks the lab from an OpenCode provider segment, the model's name, then the harness; unknown labs get the harness mark × the model's name lettered. Ink is currentColor so it follows light/dark/ember.
Its files: web/src/components/Marks.tsx, web/src/lib/marks.ts
Reaches into: web/src/components/ChatPane.tsx, web/src/styles.css, web/src/lib/doodle.ts, web/src/components/EmptyTop.tsx
Tags: empty state, logos, doodle, svg

## greeting-editor — the greeting editor
Settings → Greeting: what Home says over its empty chat, one line per greeting taking turns a launch at a time. Kept as the ruri-greetings pref; until first edited it reads the old ruri-hero pref's greetings so a list set there carries over.
Its files: web/src/components/GreetingEditor.tsx, web/src/greetings.ts, web/src/lib/greetings.ts
Reaches into: web/src/components/Settings.tsx
Tags: settings, home

## rapid-fire-waiting — the rapid fire waiting screen
What rapid fire shows when the line has nobody to hand you — nothing starred, nothing open, or every lead mid-turn — with the rapid fire bar under it; the first project to come free is picked up on its own (RapidWaiting, swapped in by App.tsx).
Its files: web/src/components/RapidFire.tsx
Reaches into: web/src/styles.css, web/src/App.tsx
Tags: rapid fire, empty state, pane

## feature-doodles — the feature doodles
Six icons for ruri's features, drawn for ruri.codes in the marks' pen: folder, harnesses, queue, rewind, bridge and notebook. The line is the theme's ink and the lapis is laid slightly off it. Each is an SVG string, and nothing uses them yet. Needs the .pen .ink/.dot rules from the file's header.
Its files: web/src/lib/featureDoodles.ts
Tags: icon, doodle, art, features

## team-page — the team page
The figures button in a project chat's header: the lead's team — each member's state (asleep, just finished, working, waiting on an answer, waiting on you; waiting for a slot only with RURI_TEAM_MAX set), duty, layers, context, exchanges, last words, and Stop/Compact/Restart/Refresh/Retire; the liaison's own dashed card above them (its state, what it is doing, what it is answering and waiting on). Every card opens that session's chat in the pane (its name, or a click anywhere but its buttons), and says 'this chat' when the page was opened from it. Also: the stack's layers no teammate holds yet as faint chips; how many teammates are at work across ruri (and RURI_TEAM_MAX's cap, when set); outside chats brought in as teammates. Server-fed by team_get/team (server/handlers/team.ts).
Its files: web/src/components/TeamPage.tsx
Reaches into: web/src/styles.css, web/src/components/ChatPane.tsx, web/src/store.ts
Tags: page, team, agents, board

## project-rows — the project rows
The sidebar's one row per project (ProjectRow): click opens the project's lead; the number beside the name is teammates at work (the liaison counts, the lead doesn't); star kept while on, hide on hover, the X (a dragon while anyone on the team works) asks before closing, warning when the lead is at work too. Double-click renames. Replaced the folders of sessions.
Its files: web/src/components/Sidebar.tsx
Reaches into: web/src/styles.css
Tags: nav, sidebar, row

## carry-on-note — the carry-on note
ruri's prompt carrying an agent on after it compacted itself (CarryOn, picked by shared handoffNote): under the compaction mark, "↻ carried on from its handoff note" (· for <agent> when the job is another agent's message) over the agent's own note, folded to four lines with "the whole note". Never drawn as a user bubble or a letter. Folded above a newer compaction it is a dotted slip (Exchange.tsx).
Its files: web/src/components/EventView.tsx
Reaches into: web/src/styles.css, web/src/components/Exchange.tsx, shared/protocol.ts
Tags: chat, compaction, transcript, note

## teammate-chat-header — the teammate header
The chat header when the open session is a teammate or the liaison, opened from the team page: '‹ <project>' back to the lead in one click, then its name ('Liaison' for the liaison) and one faint line — 'teammate of <project> · <duty>' or 'liaison of <project> · other projects' agents reach it'. The lead's header is unchanged. Styles .chat-id.seat, .chat-back, .chat-role in web/src/styles.css.
Its files: web/src/components/ChatPane.tsx

## hooks-settings — the hooks settings
Settings → Integrations, Hooks: under the page's For picker — everywhere edits the global hook (an On/Off switch that keeps everything as it is; command, webhook URL, write-only bearer token shown as '••••••• set' with Replace/Clear; 'midna found at …' and midna's default command, with a way back to it), a project its own (global hooks used here / kept off, its own On/Off once it has its own, plus its own command, URL and token). Send test event, what a hook is given (env, stdin JSON, retries), and recent deliveries (delivered / sending / retrying with tries and next try / failed, with the result). Fed by hooks_get / hooks (server/projectHooks.ts).
Its files: web/src/components/Hooks.tsx
