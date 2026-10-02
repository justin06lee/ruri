# ruri — Agent and bridge views

One layer of ruri's stack, owning `web/src/components/AgentsPage.tsx, web/src/components/Bridge.tsx, web/src/components/TalkPage.tsx, web/src/components/chat/AgentCard.tsx`. The whole stack, and how the layers connect, is in `.ruri/architecture.md`.
Don't edit this file: ruri writes it. `ruri layer agent-bridge-views` prints it with every line numbered, what git says changed in this layer lately and what sessions learned working here; once you have read it that way, put right what your work changed — `ruri layer agent-bridge-views add|set|drop <section> …`. Where it and the code disagree, the code is right.

This layer presents agent runs and scripts, controls who agents may message, and shows pages or apps a session is driving through the bridge. Its four React components read client state, use shared protocol types, and send actions through the client store. Keep the distinction between an agent card in chat and one on the agents page when changing how agents open.

## Where to change what

- **Agent runs, logs, and controls:** web/src/components/AgentsPage.tsx
- **Agent cards and status labels:** web/src/components/chat/AgentCard.tsx
- **Agent messaging rules and recent messages:** web/src/components/TalkPage.tsx
- **Bridge preview and takeover:** web/src/components/Bridge.tsx

## How it works

- **Agent run:** An agent card opens its agent in the appropriate chat or page context. → The agents page shows the run and its output. → A running script's page refreshes its output every two seconds. → The page offers actions to message, stop, or close the agent.
- **Agent messaging:** The talk page selects everyone, a project, or a chat. → It shows or changes who that scope may message. → It shows recent messages and their status.
- **Bridge display:** A session opens a page or app. → The strip above the composer shows its live picture, title, and address. → The user can open the picture in a read-only viewer or take over the real window. → Giving control back hides the window while the session continues; closing the bridge removes the strip.

## Key files

- web/src/components/AgentsPage.tsx — agent and script page, output, and run controls
- web/src/components/TalkPage.tsx — agent messaging rules and recent messages
- web/src/components/Bridge.tsx — bridge preview and takeover strip
- web/src/components/chat/AgentCard.tsx — agent card, status text, and opening context

## Rules and traps

- Messaging rules inherit from everyone to project to chat; a more specific rule overrides the one above it.
- A project's messaging rule covers its chats, including new ones.
- Agent cards open differently in chat and on the agents page; preserve their AgentHost context.
- The bridge picture opens read-only; takeover uses the real window.
- Giving bridge control back hides the window without ending the session's control.
- The bridge strip sits above the composer and stacks above the rapid-fire plate when both appear.

## What it talks to

- Client state — components read session state and send agent, talk, and bridge actions through the store
- Shared protocol — supplies agent, project, transcript, and talk types
- Chat and prompting — hosts agent cards and the bridge strip above the composer
- Sessions — supplies agent runs and agent-to-agent messaging
- Bridge — supplies the driven page or app shown by the strip
