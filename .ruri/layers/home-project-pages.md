# ruri — Home and project pages

One layer of ruri's stack, owning `web/src/components/Architecture.tsx, web/src/components/Components.tsx, web/src/components/HomeBoard.tsx, web/src/components/Ideas.tsx, web/src/components/NameCard.tsx, web/src/components/Statistics.tsx, web/src/components/Tracker.tsx, web/src/components/figures.ts, web/src/lib/runNote.ts`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer home-project-pages` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer home-project-pages add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer renders the home and project pages: live project activity, statistics, ideas, architecture sheets, a component gallery, and a feature tracker. React components read client state and send user actions through the store; shared protocol types define their data. The architecture stack is an index into layer sheets that sessions read before working in a layer.

## Where to change what

- **Project activity and home tabs:** web/src/components/HomeBoard.tsx
- **Usage and machine statistics:** web/src/components/Statistics.tsx, web/src/components/figures.ts
- **Architecture stack and layer sheets:** web/src/components/Architecture.tsx, web/src/lib/runNote.ts
- **Component gallery and code:** web/src/components/Components.tsx, web/src/lib/runNote.ts
- **Name a newly built component:** web/src/components/NameCard.tsx
- **Ideas and their drafts:** web/src/components/Ideas.tsx
- **Feature review:** web/src/components/Tracker.tsx
- **Shared number formatting:** web/src/components/figures.ts

## How it works

- **Architecture sheet:** Show the project stack → Open a layer to reveal its sheet → Show the change map, flows, key files, and traps that a session reads for that layer
- **Idea:** Write an idea and attach files in a persistent draft → Add it to the project's ideas board → Mark it done or send it for work by user action
- **Feature review:** Show items extracted from turns → Cycle each item through open, works, and needs fixing → Add a note or files to an item needing fixing → Finish review to clear accepted items, keep rejected items as repeats, and place a fix prompt in the composer

## Key files

- web/src/components/HomeBoard.tsx — home tabs and project activity cards
- web/src/components/Architecture.tsx — project stack and expandable layer sheets
- web/src/components/Components.tsx — project component gallery, details, and code
- web/src/components/Ideas.tsx — ideas board and persistent idea drafts
- web/src/components/Statistics.tsx — spending and machine usage page
- web/src/components/Tracker.tsx — feature checklist and review actions
- web/src/components/NameCard.tsx — naming request for a newly built component
- web/src/components/figures.ts — shared totals and number formatting
- web/src/lib/runNote.ts — expiry and relative time for background run notes

## Rules and traps

- Project cards advance by completed steps; streaming reply text and motion belong in the open chat. Cards group live → finished → idle: finished while a chat has an unseen finished turn (store unread, the sidebar's diamond), until that chat is opened.
- Ideas are user written and change only when the user acts; drafts survive leaving the page and relaunching.
- Tracker items stay in place during review; their status cycles open → liked → rejected → open.
- A component naming response resolves the model's permission request, so the chosen name reaches its tool call.
- Finished background run notes expire 25 seconds after their latest report; a newer report or active run is fresh.
- Statistics receives CPU usage measured per core; divide by the machine's core count for displayed percentages, so 100% means all cores are busy.

## What it talks to

- Client state — supplies page data, subscriptions, drafts, and actions
- Shared protocol — defines page data, statuses, and requests
- Project knowledge — supplies architecture sheets and component records
- Server services — supplies spending and process usage data
- Chat and prompting — receives tracker fix prompts and idea content in the composer
