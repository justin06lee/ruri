# ruri — Window and navigation

One layer of ruri's stack, owning `web/index.html, web/src/`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer window-navigation` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer window-navigation add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer starts the React window, chooses the active view, and supplies navigation and shared controls. App.tsx composes the main views, while Sidebar.tsx and Switcher.tsx navigate using client state. The Projects page shows recently finished chats using completion state from the store. Global styles and visibility-aware clocks define how the window looks and moves.

## Where to change what

- **Window startup:** web/src/main.tsx, web/index.html
- **Active view and layout:** web/src/App.tsx, web/src/styles.css
- **Projects page and recently finished chats:** web/src/components/HomeBoard.tsx, web/src/store.ts, web/src/styles.css
- **Project and session sidebar:** web/src/components/Sidebar.tsx, web/src/styles.css
- **Quick navigation:** web/src/components/Switcher.tsx, web/src/lib/fuzzy.ts, web/src/lib/keys.ts
- **Confirmation cards:** web/src/components/Confirm.tsx, web/src/styles.css
- **Dropdown controls:** web/src/components/Dropdown.tsx, web/src/styles.css
- **Visibility-aware motion:** web/src/lib/awake.ts, web/src/lib/beat.ts, web/src/lib/spin.ts, web/src/styles.css
- **Button press behavior:** web/src/press.ts
- **Shared artwork and icons:** web/src/lib/doodle.ts, web/src/icons.ts

## How it works

- **Window startup:** web/index.html hosts the page → web/src/main.tsx initializes theme and global interaction handlers → web/src/main.tsx mounts web/src/App.tsx → web/src/App.tsx connects client state and renders the active view
- **Navigation:** web/src/components/Sidebar.tsx or web/src/components/Switcher.tsx presents a destination → web/src/components/Switcher.tsx ranks typed matches with web/src/lib/fuzzy.ts → The chosen destination updates client state → web/src/App.tsx renders the active view
- **Automatic motion:** web/src/lib/awake.ts tracks window and element visibility → web/src/lib/beat.ts or web/src/lib/spin.ts runs a clock for visible movers → The clock updates a mover only when its step changes → Motion pauses while hidden or asleep and is disabled for reduced motion

## Key files

- web/src/App.tsx — composes the window's active view and connects client state
- web/src/main.tsx — initializes global window behavior and mounts React
- web/src/components/HomeBoard.tsx — Projects page cards and recently finished chat indicators
- web/src/store.ts — client state, including unseen finished chats
- web/src/components/Sidebar.tsx — project, session, and Home navigation
- web/src/components/Switcher.tsx — searchable keyboard navigation
- web/src/styles.css — global theme surfaces, layout, controls, and motion styling
- web/src/lib/awake.ts — window wake state and element visibility
- web/src/lib/beat.ts — shared, visibility-aware clocks for stepped motion
- web/src/press.ts — pointer capture for shrinking clickable controls

## Rules and traps

- Keep the theme's paper and ink semantics consistent; styles.css uses shade and pattern to distinguish surfaces and state.
- Automatic movers use the shared clocks, which pause when hidden or asleep and respect reduced motion.
- The switcher opens on the right Option key only when it was tapped alone; platform command shortcuts use lib/keys.ts.
- Press handling captures the pointer so a button's shrink animation does not lose its click, while a release far outside still cancels it.
- The global drop handler prevents untargeted file drops from navigating away from the app.
- A chat covered by Projects or Settings counts as unseen when its turn finishes; opening that chat clears its finished marker.

## What it talks to

- Client state — App.tsx, Sidebar.tsx, Switcher.tsx, and HomeBoard.tsx read state and change the active destination
- Shared protocol — Sidebar.tsx and Switcher.tsx use shared IDs and data types
- Chat and prompting — App.tsx renders the chat view and prewarms transcript markdown
- Home and project pages — App.tsx renders the Projects page through HomeBoard.tsx
- Settings and personalization — App.tsx renders Settings, and main.tsx initializes the theme
