# Component library

Every piece of this project's interface ruri has on file: the user's own
name for it, its handle, its files, and a picture. When the user names
something here, this is what they mean — go straight to its files rather
than searching for their words. Before building interface, look here
first and reuse what exists: `ruri show <slug>` reads one with its code,
`ruri add <slug>` copies it into place, `ruri help` says the rest.

ruri maintains this file. Don't edit it by hand; it is rewritten whenever
the library changes.

## terminal-tabs — terminal tabs
The numbered row across the top of the composer's terminal mode — one tab per shell, plus button and cmd-T for another, cmd-1..9 to switch. The row belongs to the server and is written to ~/.config/ruri/terminals.json, so it outlives the app; the shell processes don't.
Its files: web/src/components/Terminal.tsx
Reaches into: server/terminal.ts, web/src/styles.css:4290
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/4878dd21-bfac-4498-87fd-ac981c34487b-t2-three-tabs.png
Its code has changed since that picture — if you change it, `ruri edit terminal-tabs --shot <new picture>`

## name-everything-button — name everything button
The Update everything button at the top of the Components page: follows moved files, retires entries whose code is gone, has the small model rewrite outgrown notes and judge whose look changed, names what nobody has, then photographs everything without a current picture — by selector, and in a 'Library pictures' chat for the rest.
Also called: update everything button, update everything
Its files: web/src/components/Components.tsx
Reaches into: server/handlers/components.ts, server/libraryRefresh.ts, server/photographer.ts, server/sweep.ts, server/shots.ts, desktop/capture.ts
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/7125e9b3-5733-4e10-a789-36dec79e64c3-shot-38.png, /Users/huiyunlee/.config/ruri/uploads/bf1212ba-1854-42d1-9fd1-6b9fc144a6a3-31-paths.png

## new-component-stars — the new component stars
The spinning star on a component nobody has looked at yet: beside the name for what the last prompt named, hooked over the card's top-left corner (on the border) once a newer prompt has gone out, and on the Components button so a turn that named something says so without the page open. Hovering a card or leaving the page takes it off.
Its files: web/src/components/Components.tsx
Reaches into: web/src/components/ChatPane.tsx:1015, server/components.ts:144, web/src/styles.css:2740
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/f6537bdd-3420-43c5-b088-c6bc0ac7081e-12-corner-star.png

## home-page-all-projects-section — home page all projects section
The cards above the Home agent: one per open project with a status word, three live lines of what its lead is doing, and its spend today and all told; the strip on top adds every project up from the per-day ledger. Fold it with the chevron.
Its files: web/src/components/HomeBoard.tsx
Reaches into: server/ledger.ts, web/src/styles.css:1030
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/2c257373-2ee6-4b6a-bd82-63158cfd33b4-home-2-hero.png
Its code has changed since that picture — if you change it, `ruri edit home-page-all-projects-section --shot <new picture>`

## drawing-page — drawing page
The drawing page the pen next to the composer's shell toggle opens: pen, arrows, lines, boxes, ellipses, labels, five colours, three widths, undo. Attach drops it in the prompt as an image; opened from the viewer's "Draw on it", Put it back replaces the attachment under the same marker.
Its files: web/src/components/Sketch.tsx, web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css:4780
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/468b5009-fe1f-4747-9f93-7a8cd9ce2315-sketch-1.png
Its code has changed since that picture — if you change it, `ruri edit drawing-page --shot <new picture>`

## attachment-tags — attachment tags
The [image #1] markers in the composer drawn as chips over the textarea by a mirror of the prompt: hover inverts, drag moves the marker (snapping to a word boundary), click puts the caret after it. The mirror must keep the textarea's exact font, padding, and wrapping or the chips drift off their words.
Its files: web/src/components/Markers.tsx, web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css:4700
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/63733cc5-6acb-4a26-949c-9762026498a8-crop-1.png
Its code has changed since that picture — if you change it, `ruri edit attachment-tags --shot <new picture>`

## recent-chats-dropdown — recent chats dropdown
"chats from outside ruri" at the foot of the team page: unfolds to the Claude and Codex sessions on disk for that directory that ruri did not make, tagged cc/cx; clicking one brings it in as a teammate whose duty is to carry on that chat, and the lead's next message resumes the real thing.
Its files: web/src/components/TeamPage.tsx
Reaches into: server/recent.ts, server/server.ts
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/c9342862-89e4-43bf-a1d2-8fbe5a4aa1a8-team-page.png, /Users/huiyunlee/.config/ruri/uploads/2c55429b-e165-41b6-becf-b47a13829f93-crop-recent.png

## question-box — question box
The AskUserQuestion card with several questions side by side on a strip that slides between them: picking a single-choice answer moves on by itself, the card is as tall as its tallest question, and every pick and typed "Other" survives leaving the session. When the tool call behind it has moved on, the card says so and "Send as a prompt" sends the answers as a new prompt.
Its files: web/src/components/Questions.tsx
Reaches into: web/src/styles.css:3760
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/2fcd3a19-a7b0-4dc3-b14b-a6181d3dd600-ask-strip.png
Its code has changed since that picture — if you change it, `ruri edit question-box --shot <new picture>`

## selection-flags — the selection flags
A flag at each end of a transcript selection (double-click a word, or drag one out); drag a flag to change what is selected, scroll first if you like, and near the transcript's edge the drag scrolls it. Drawn fixed in a portal over the page; the flags take no pointer while one is dragged so the caret lookup finds the text underneath.
Its files: web/src/components/Selection.tsx
Reaches into: web/src/components/ChatPane.tsx:1560, web/src/styles.css:5960
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/2af32c88-952a-4a47-81cd-f8e8b594280b-flags-crop.png

## drawing-page-text-box — the drawing page text box
The box the sketch pad's text tool (T) opens: write several lines, Font… for a face and a size, Place… hangs the words on the pointer to be stamped where the next click lands; Esc during placement brings the box back with the words. Reuses the confirm card's classes.
Reaches into: web/src/components/Sketch.tsx:560, web/src/styles.css:4900
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/8207163a-e2a4-45f6-ac5b-383e782e304d-textbox-crop.png

## bridge-strip — the bridge strip
The plate above the composer showing what a session is driving in its hidden window or background app: a live thumbnail (click for full size), title and address, Take over / Give back, and a close. Floats like the rapid-fire plate, off the textbox's measured height and right edge, and stacks above it when both are on. Fed by the server's `bridge` messages; the previews come from ~/.config/ruri/bridge/<channelId>/preview.png.
Its files: web/src/components/Bridge.tsx, desktop/bridge.ts
Reaches into: web/src/components/ChatPane.tsx:1596, web/src/styles.css:5930, server/bridge.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/0ed7f099-1679-40e8-a70c-0b27b6226c5c-strip-crop.png

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
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/34ede12b-c1cd-4af9-b83d-700545dc5d98-the-player.png

## rapid-fire-bar — the rapid fire bar
The plate above the composer in rapid fire: how many projects in the line are ready and working (each its lead), an all | starred switch for which projects the line goes round, skip (when another is ready) and leave. Right edge measured onto the textbox's. Counts come from the hook's subscribed projects/statuses — never getState(), which the React Compiler caches.
Its files: web/src/components/RapidFire.tsx
On screen: .rapid-plate
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/9e04135f-519a-45d0-a8e6-7b231c0c73ee-shot-25.png

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
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/60099d04-2645-4647-85cd-a60d213e670b-shot-10.png, /Users/huiyunlee/.config/ruri/uploads/cc2e2473-c6cf-4737-8567-fe65f0088f87-shot-60.png, /Users/huiyunlee/.config/ruri/uploads/9ab963df-079b-49aa-949c-7813a0d6babe-75304eaf-5245-4307-8af6-f3edfbf43865-shot-17.png, /Users/huiyunlee/.config/ruri/uploads/75304eaf-5245-4307-8af6-f3edfbf43865-shot-17.png, /Users/huiyunlee/.config/ruri/uploads/44039884-09a2-4eaf-932f-d4e6a539a2fc-Screenshot-2026-09-02-at-8.59.53-PM.png
Its code has changed since that picture — if you change it, `ruri edit peek-band --shot <new picture>`

## working-line — the working line
The caption beside the thinking doodle while a turn runs: a rotating word, then elapsed time, output tokens streamed back, the reasoning effort, and — when nothing has come back for 90s — how long it has been quiet. Fed by a throttled `turn` message the server keeps per channel, so it survives a reload.
Reaches into: web/src/components/Thinking.tsx:60, web/src/components/ChatPane.tsx:1789, web/src/styles.css:2497, server/server.ts:473
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/249aec6a-06c0-4aed-a89d-5f5c91460926-shot-5.png

## native-question-box — native question box
Provider questions and typed forms with masked secret answers, defaults and validation.
Reaches into: web/src/components/Questions.tsx:67, shared/questionInput.ts:4, server/sessions.ts:1342
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/5a964944-453d-4835-a88a-48bbb1fb9bea-shot-5.png

## live-plan — live plan
One current provider checklist or proposed plan in the transcript.
Reaches into: web/src/components/ChatPane.tsx:402, server/sessions.ts:1610
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/b4174c26-17b7-4548-84d1-15fda010a489-shot-6.png

## model-effort-picker — model effort picker
Reasoning choices come from the selected model’s own capability catalog.
Reaches into: web/src/components/ChatPane.tsx:486, server/providers.ts:23
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/8497974a-4b90-4b4f-a5ed-c94da474a457-shot-11.png

## home-tabs — the home tabs
The chat | statistics strip at the top of Home, now over a track (HomeDeck): its inked pill is one element that glides to the tab picked, and the two pages slide past each other under it. Only the page showing stays mounted; the other goes up for the slide and comes down after.
Its files: web/src/components/HomeBoard.tsx
Reaches into: web/src/components/ChatPane.tsx:1340, web/src/styles.css:1059, web/src/styles.css:1186, web/src/components/ChatPane.tsx
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/93efbf75-d76f-439d-8248-f3d944a7bc20-home-tabs.png, /Users/huiyunlee/.config/ruri/uploads/dcde1c25-7649-45b5-b37e-755a64e7747e-shot-10.png
Its code has changed since that picture — if you change it, `ruri edit home-tabs --shot <new picture>`

## projects-page — the projects page
The Projects row's page: a head with the project count and how many are working, waiting on you or finished, then a card per project (live ones first under a rule) with a status pill — the whole team's state — and its lead's last lines. Status classes are st-working etc. because a bare working class collides with the transcript's progress line.
Its files: web/src/components/HomeBoard.tsx
Reaches into: server/ledger.ts, web/src/styles.css:1180
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/04741ce3-9c9b-474a-83d0-02e50d093d37-projects-page.png, /Users/huiyunlee/.config/ruri/uploads/6fffa3ee-eeca-456d-9c22-b49d43d38eb7-shot-6.png

## model-role-tags — the model role tags
The "small tasks" (filled) and "default" (outlined) tags on catalog rows in Settings; the star cycles none → starred → small → default → none, and either tag drags onto another row to hand the role over. Crowning a default pins every existing project and Home to the old one first.
Its files: web/src/components/Settings.tsx
Reaches into: server/projects.ts, web/src/styles.css:2086
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/0756ce28-845f-4c8e-b7de-0844398e8586-shot-15.png
Its code has changed since that picture — if you change it, `ruri edit model-role-tags --shot <new picture>`

## harness-updates — the harness updates
Settings → Harnesses: the ruri server's version (and a waiting update), every installed coding CLI with its version, how it is managed (own updater / npm / bun / brew / left alone) and what the last hourly round did, plus Check now. Rounds never run under a mid-turn session.
Its files: web/src/components/Settings.tsx
Reaches into: server/updater.ts, server/host.ts, desktop/server-entry.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/0568de35-44dc-461a-8806-f1b2e6e741e4-shot-18.png
Its code has changed since that picture — if you change it, `ruri edit harness-updates --shot <new picture>`

## queue-line — the queue line
The queued prompt cards and how they are carried: drop one on another's edge to reorder, on its body to fold the two into one; the pencil takes a card out of the line into the composer and it steps back in where it was when sent. Server rules live next to queue_move / queue_merge / queue_edit / queue_update in server.ts.
Reaches into: web/src/components/ChatPane.tsx:1355, web/src/components/ChatPane.tsx:1448, web/src/styles.css:6653, server/server.ts:1932
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/843c195a-98b4-4826-93d1-1552b36e9706-q-1-lift.png

## folded-composer-bar — the folded composer bar
What the bottom of the composer becomes when the box is too narrow for three pickers and four buttons: one model menu with "Effort level" and "Permissions" rows opening flyouts beside it, and a ⋯ holding shell, draw and split. Folds on a real measurement of the bar's needs (Composer's `compact`), not a fixed breakpoint.
Reaches into: web/src/components/ChatPane.tsx:500, web/src/components/ChatPane.tsx:630, web/src/components/Dropdown.tsx:130, web/src/styles.css:6749, web/src/styles.css:6848
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/3564673c-2690-454d-aa85-3cef0ddc18b3-q-6-flyout.png

## sidebar-rename-box — the sidebar rename box
Double-click a project's row in the sidebar and its name becomes a box with the old name selected. Enter keeps, Escape drops, clicking away keeps. Renaming a project never touches its folder on disk. (Sessions are no longer in the sidebar: a project is its lead.)
Reaches into: web/src/components/Sidebar.tsx:74, web/src/styles.css:780, server/server.ts:2846
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/c114c31d-7062-4ccb-bcaf-93753cfda9c9-project-rows.png, /Users/huiyunlee/.config/ruri/uploads/e4b3c141-f630-4266-8b27-a105c40ef94f-r-1-editing.png

## switcher — the switcher
Tap the right Option key (or ⌘K) and a Spotlight-shaped search stands over the app: projects (each opening its lead), Home, Rapid fire, Settings. The best match completes greyed into the box; Enter goes there, Tab takes the completion, Escape closes. Option held with another key opens nothing.
Its files: web/src/components/Switcher.tsx
Reaches into: web/src/styles.css:6870, web/src/App.tsx
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/e0ffdc9c-f2eb-45aa-908a-06592208dbb3-s-2-typed.png
Its code has changed since that picture — if you change it, `ruri edit switcher --shot <new picture>`

## permissions-panel — the permissions panel
Settings → Permissions: each macOS grant ruri uses as macOS actually holds it, with Ask per row and Ask for everything, plus the privacy database's rows for ruri, the CLIs and the shell. Looking never prompts; asking does. make update resets the grants and the next launch asks again.
Its files: web/src/components/Settings.tsx, desktop/permissions.ts
Reaches into: server/server.ts, Makefile
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/07f8c739-cd4f-4118-bf65-9630635c8589-g-2-grants.png
Its code has changed since that picture — if you change it, `ruri edit permissions-panel --shot <new picture>`

## hidden-fold — the hidden fold
The eye button on a project's row tucks a project away without closing it; "show N hidden" at the foot of the project list reveals the hidden ones (dimmed) so they can be brought back. Hidden projects also leave rapid fire, the switcher and the projects board.
Its files: web/src/components/Sidebar.tsx
Reaches into: web/src/styles.css, server/server.ts, shared/protocol.ts
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/b7f157c1-0cf7-4b10-b875-71aed669d691-project-rows.png, /Users/huiyunlee/.config/ruri/uploads/440e40d0-82de-4a35-b18e-0facf5b00e18-shot-4.png

## folded-exchanges — the folded exchanges
Exchanges above the newest compaction (and any hand-folded turn) laid out like chat, showing recall notes: prompt note in a dashed bubble, reply note beneath, click to open in full. Fed by the history outline (archive.earlier).
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css, server/archive.ts, shared/protocol.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/01c29e00-8822-40ae-963d-72625bda1d68-shot-7.png
Its code has changed since that picture — if you change it, `ruri edit folded-exchanges --shot <new picture>`

## agent-cards — the agent cards
A subagent in the chat (Claude's Agent tool, Codex's spawn_agent): type, brief, a turning ring while it works, its live activity or report, and tools · tokens · time. Click to open its log. The card is the spawning tool event re-sent in place as the agent moves (SubagentState).
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/styles.css, server/sessions.ts, shared/protocol.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/c0ec217c-b144-4b81-8625-aa8998f6856d-shot-10.png
Its code has changed since that picture — if you change it, `ruri edit agent-cards --shot <new picture>`

## agents-panel — the agents panel
Slides over the right of the chat, stopping above the composer: one agent's own conversation live (brief, what it said, every tool), or the list of every agent in the chat from the header's robot button (badge = still working). Esc closes; back steps out. Logs live in ~/.config/ruri/agents/.
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/store.ts, web/src/styles.css, server/agents.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/5acab168-c6a1-482e-a63e-afbc8bdd430d-shot-13.png
Its code has changed since that picture — if you change it, `ruri edit agents-panel --shot <new picture>`

## agents-page — the agents page
Replaces the chat when the header's robot button is pressed (always there; badge counts working agents). It lists every agent in the chat, the model's and your own, above a box that starts an agent of your own. Clicking one opens its conversation full-page, with a follow-up/stop line for yours and "Put in the composer". Esc steps back out. Your agents run on their own SessionManager (server.ts) and their cards live in agents/<chat>/@crew.json.
Its files: web/src/components/ChatPane.tsx
Reaches into: web/src/store.ts, web/src/styles.css, server/agents.ts, server/server.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/3f070929-3e50-45d5-ae24-a7582c7f4928-shot-13.png
Its code has changed since that picture — if you change it, `ruri edit agents-page --shot <new picture>`

## flat-paper-look — the flat paper look
All three themes drawn the same way now: no rules around panels and no shadow cast to the lower right — one surface is told from the next by the shade it is printed in, with --rim (ink mixed into the paper) only where a frame is really needed, like a tile or a picture's white ground. The tokens are at the top of styles.css; --edge is now a transparent border that only holds its space.
Reaches into: web/src/styles.css:1, web/src/theme.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/18f73edd-1ba4-43bb-a5d8-a964ad00947d-shot-15.png

## fold-reply-pill — the fold reply pill
Replaces the rail down an open reply's left edge: a "fold reply" pill heading the reply, held at the top of the view the whole way down a long one, dimming the reply under the pointer. Folded from halfway down, the view goes back up to the note it folded to.
Reaches into: web/src/components/Exchange.tsx:126, web/src/styles.css:2993, web/src/components/ChatPane.tsx:592
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/60c3fded-533a-45e3-9136-061087ea258f-pill-crop.png

## statistics-page — the statistics page
Home's second tab, where the projects board used to be: what it has cost (the ledger's three spans, then a row per project), what is running (each chat's live harness process with its memory, cpu and pid, off one `ps` — sampled only while this page is open), and what is left of each provider's usage windows.
Its files: web/src/components/Statistics.tsx
Reaches into: web/src/components/figures.ts, server/resources.ts, server/resources.test.ts, scripts/meters.ts
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/61168388-7879-4c7a-a5b7-de2c151bd2f8-mcp-bridge-blob-1790751986090-e4baxa.png, /Users/huiyunlee/.config/ruri/uploads/da43b7cd-192e-41e2-bc1e-bdf5be53bbb6-shot-2.png

## idea-box — the idea box
Where a new idea is written on the ideas page: grows with the text (Enter adds, Shift+Enter breaks a line), takes pictures pasted, dropped or picked, and keeps what's in it as the project's idea draft (drafts.json, key idea:<projectId>) through leaving the page and relaunches.
Its files: web/src/components/Ideas.tsx
Reaches into: web/src/styles.css:3326, server/handlers/boards.ts, shared/protocol.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/925cb910-0dd4-4785-bf49-88bd8551445b-idea-box.png

## row-dragons — the row dragons
Small dragon heads on busy sidebar rows: a project's row while its lead or anyone on its team is at work (where the X goes), and the Projects row beside its count. They chomp on the doodle's 500ms clock (beat "chomp", two frames), frozen when out of view or the window isn't in use; hovering a row bites twice with a shake and holds the jaws open.
Its files: web/src/components/Sidebar.tsx, web/src/components/Thinking.tsx
Reaches into: web/src/styles.css, web/src/store.ts, web/src/lib/beat.ts
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/280faaf0-a761-4b04-89be-78e82dfd7837-project-rows.png, /Users/huiyunlee/.config/ruri/uploads/5b809714-2feb-4186-967f-1bfaf9b727ae-shot-19.png, /Users/huiyunlee/.config/ruri/uploads/3fd796a5-edbb-4778-ac27-7fa68d35949e-row-dragon.png

## script-cards — the script cards
A shell the model left running in the background, shown as an agent card with a terminal icon: running, then how it exited. Opens onto its command and the tail of the CLI's output file, re-read every 2s while it runs. Made from the Bash chip when the CLI reports a local_bash task in the background.
Its files: web/src/components/chat/AgentCard.tsx
Reaches into: server/sessions.ts, server/scripts.ts, web/src/components/AgentsPage.tsx
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/b8957ce9-8488-4a6a-b060-d558c8804821-script-card.png

## integrations-panel — the integrations panel
Settings → Integrations: Claude Code's and Codex's MCP servers, plugins and marketplaces, listed and changed through each CLI's own commands; secrets shown by name only.
Its files: web/src/components/Integrations.tsx
Reaches into: server/integrations.ts, server/handlers/integrations.ts, web/src/components/Settings.tsx
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/99ad2eff-3dfc-4179-bc51-69c4077b5eb6-shot-10.png

## held-queue-bar — the held-queue bar
The line under a queue that is standing by: why (a stop, a dropped connection, a usage limit and when it lifts) and a Send queued button. The queue never goes on its own.
Its files: web/src/components/Queue.tsx
Reaches into: server/blocked.ts, server/queue.ts, web/src/components/ChatPane.tsx
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/e532c309-37f0-4c1a-8279-d9ced2829f20-shot-1.png
Its code has changed since that picture — if you change it, `ruri edit held-queue-bar --shot <new picture>`

## band-editor — the band editor
Settings → Peek band: the band drawn at 2× over a faint view of what it clips, with drag-to-place, scroll-to-size, the picture strip, and each picture's hover effect, hover picture, GIF mode, themes (light/dark/ember, never none), dark-theme invert, mirror and place fields; Restore the default brings back the mountain path. Saved as the ruri-band pref.
Its files: web/src/components/BandEditor.tsx, web/src/band.ts, web/src/lib/peekBand.ts
Reaches into: web/src/styles.css
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/7d916efa-d606-4194-9311-c888eec65a4d-band-editor.png, /Users/huiyunlee/.config/ruri/uploads/fc5e8096-83ae-42d5-b8e3-6ae9d8e2f8c4-shot-5.png, /Users/huiyunlee/.config/ruri/uploads/1e5f2260-54fb-42ff-8d18-1629a77c5064-shot-16.png
Its code has changed since that picture — if you change it, `ruri edit band-editor --shot <new picture>`

## talk-page — the talk page
The chat header's two-speech-bubbles page: which projects your agents may reach (every project's rule, a project's own over it — anyone / only these projects / no one; a team always talks among itself) and the latest messages between agents; the server enforces it in sendLetter.
Its files: web/src/components/TalkPage.tsx
Reaches into: server/talk.ts, server/handlers/talk.ts, web/src/styles.css, web/src/components/ChatPane.tsx
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/61fd1314-2faa-4c1a-ae86-2ded29a79366-talk-page.png, /Users/huiyunlee/.config/ruri/uploads/b073d0a8-c42e-4dcd-9dca-587cadf4fca7-shot-39.png

## component-library — the component library
The Components page as a per-project gallery: search over picture cards (newest picture shown; 'outdated' when its code changed after it); a card opens its page with pictures, `ruri add <slug>`, fields, and its code in tabs. Agents reach the same library with the `ruri` command.
Its files: web/src/components/Components.tsx
Reaches into: web/src/styles.css:4217, server/library.ts, server/components.ts
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/0bf85425-0f7f-4cc5-b1f7-848b7bcfbd1b-shot-39.png

## architecture-page — the architecture page
Layers-icon page in the chat header: the project's stack as bars (the index every session is shown), each bar opening its layer's own sheet underneath — where to change what, how it works, key files, rules, what it talks to, what sessions learned there, and who last changed it; then flows, where things are, how to run it, what it does. Every line rewritable or strikable on hover; Read the repo writes it all afresh.
Its files: web/src/components/Architecture.tsx
Reaches into: web/src/styles.css, server/brief.ts, server/catchupBrief.ts
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/c4351169-a3b5-46dc-a3f6-ce757c134023-shot-5.png, /Users/huiyunlee/.config/ruri/uploads/8153aa47-32b7-4d27-8f16-3024b0bce40d-shot-9.png, /Users/huiyunlee/.config/ruri/uploads/d23e4894-cdcf-49c5-9f1d-ac7f942a0b35-shot-8.png, /Users/huiyunlee/.config/ruri/uploads/f9ec4470-ed4e-44ff-9ef1-8a8ba50d7d97-shot-41.png, /Users/huiyunlee/.config/ruri/uploads/72f24d33-bd5b-40f8-8e05-18046c8a2881-shot-32.png, /Users/huiyunlee/.config/ruri/uploads/e0a946df-eaca-4885-823e-712bea301686-shot-23.png
Its code has changed since that picture — if you change it, `ruri edit architecture-page --shot <new picture>`

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
Screenshots, newest first (read them if you need to see it): /Users/huiyunlee/.config/ruri/uploads/946e5f68-845e-494d-be68-65d2835b52eb-shot-4.png, /Users/huiyunlee/.config/ruri/uploads/3d62cd4c-1b9a-47d5-9d4a-0a5fc9e195c5-the-composer-pickers.png
Its code has changed since that picture — if you change it, `ruri edit composer-pickers --shot <new picture>`

## provider-marks — the provider marks
Over an empty chat: the hand-drawn "lab × product" logo pair for whoever made the chat's model (Anthropic × Claude, OpenAI × ChatGPT, Google × Gemini, …), then the chat's title or Home's greeting. markFor() picks the lab from an OpenCode provider segment, the model's name, then the harness; unknown labs get the harness mark × the model's name lettered. Ink is currentColor so it follows light/dark/ember.
Its files: web/src/components/EmptyTop.tsx, web/src/components/Marks.tsx, web/src/lib/doodle.ts, web/src/lib/marks.ts
Reaches into: web/src/components/ChatPane.tsx, web/src/styles.css
Tags: empty state, logos, doodle, svg
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/01a635ad-49a4-4431-a3c3-96a6a286b427-shot-59.png

## greeting-editor — the greeting editor
Settings → Greeting: what Home says over its empty chat, one line per greeting taking turns a launch at a time. Kept as the ruri-greetings pref; until first edited it reads the old ruri-hero pref's greetings so a list set there carries over.
Its files: web/src/components/GreetingEditor.tsx, web/src/greetings.ts, web/src/lib/greetings.ts
Reaches into: web/src/components/Settings.tsx
Tags: settings, home
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/966ca3f8-560e-42dd-a38c-c69b729d2db5-greeting.png

## rapid-fire-waiting — the rapid fire waiting screen
What rapid fire shows when the line has nobody to hand you — nothing starred, nothing open, or every lead mid-turn — with the rapid fire bar under it; the first project to come free is picked up on its own (RapidWaiting, swapped in by App.tsx).
Its files: web/src/components/RapidFire.tsx
Reaches into: web/src/styles.css, web/src/App.tsx
Tags: rapid fire, empty state, pane
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/f12e4998-8435-4bee-88f7-bbdc2b19f996-shot-26.png

## feature-doodles — the feature doodles
Six icons for ruri's features, drawn for ruri.codes in the marks' pen: folder, harnesses, queue, rewind, bridge and notebook. The line is the theme's ink and the lapis is laid slightly off it. Each is an SVG string, and nothing uses them yet. Needs the .pen .ink/.dot rules from the file's header.
Its files: web/src/lib/featureDoodles.ts
Tags: icon, doodle, art, features
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/981feb09-a71a-4e31-a75a-85be9983f1de-feature-doodles.png

## team-page — the team page
The figures button in a project lead's header: the lead's team — each member's state (asleep, working, waiting on an answer, waiting for a slot, waiting on you), duty, layers, context, exchanges, last words — the machine's room for members at work, Compact/Restart/Clear/Retire per member, and outside chats brought in as teammates. Server-fed by team_get/team (server/handlers/team.ts).
Its files: web/src/components/TeamPage.tsx
Reaches into: web/src/styles.css, web/src/components/ChatPane.tsx, web/src/store.ts
Tags: page, team, agents, board
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/148cfd2f-e6c0-4d6b-b027-3434ae373935-team-page.png

## project-rows — the project rows
The sidebar's one row per project (ProjectRow): click opens the project's lead; the number beside the name is teammates at work; star kept while on, hide on hover, the X (a dragon while anything on the team works) asks before closing. Double-click renames. Replaced the folders of sessions.
Its files: web/src/components/Sidebar.tsx
Reaches into: web/src/styles.css
Tags: nav, sidebar, row
Screenshot (read it if you need to see it): /Users/huiyunlee/.config/ruri/uploads/c643fae4-0cc5-4379-91b7-821ac9314dfc-project-rows.png
