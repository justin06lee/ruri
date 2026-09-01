/**
 * Canned state for `?fixture` mode: every kind of transcript event, a pending
 * permission, folder groups, and per-project statuses — so the whole UI can be
 * eyeballed and screenshotted without a live server or a single token.
 */
import { composeInto, useRuri } from "./store";

const now = Date.now();

const ASSISTANT_MD = `Found it — the reconnect loop was resetting the backoff on every attempt.

## What I changed

1. Moved the backoff state out of \`connect()\` so retries actually grow.
2. Capped the delay at 30s and added jitter.

\`\`\`ts
function backoff(attempt: number): number {
  const base = Math.min(30_000, 1_500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}
\`\`\`

| attempt | delay |
| --- | --- |
| 0 | ~1.5s |
| 4 | ~24s |
| 6+ | ~30s |

The [ws docs](https://github.com/websockets/ws) recommend the same shape. Tests pass — want me to also surface the retry count in the sidebar?`;

export function installFixture(): void {
  // The fixture is here to be driven — screenshots, timing checks, a status
  // flipped by hand to watch what the UI does about it. The store is the only
  // handle that needs, and this mode is the only place it is exposed.
  (window as unknown as Record<string, unknown>)["__ruri"] = useRuri;
  // and a way to put a prompt with attachments into a composer, which is
  // otherwise only ever done by a person dropping files on it
  (window as unknown as Record<string, unknown>)["__ruriCompose"] = composeInto;
  useRuri.setState({
    connected: true,
    projects: [
      {
        id: "prj1",
        name: "ruri",
        path: "/Users/you/Workspace/ruri",
        starred: true,
        sessions: [
          { id: "p1", title: "Frontend UI" },
          { id: "p1b", title: "Backend API" },
        ],
      },
      {
        id: "prj2",
        name: "yagami",
        path: "/Users/you/Workspace/yagami",
        model: "claude-sonnet-5",
        sessions: [{ id: "p2", title: "Session Layer" }],
      },
      { id: "prj3", name: "dotfiles", path: "/Users/you/dotfiles", model: "codex:gpt-5.3-codex", sessions: [{ id: "p3" }] },
    ],
    activeId: "home",
    workspaceDir: "/Users/you/Workspace",
    musicDir: "/Users/you/Music/ruri",
    user: "you",
    statuses: { p1: "permission", p2: "working", p3: "idle" },
    unread: { p2: true },
    models: [
      { value: "claude-fable-5[1m]", displayName: "Fable 5" },
      { value: "claude-opus-5", displayName: "Opus 5" },
      { value: "claude-sonnet-5", displayName: "Sonnet 5" },
      { value: "codex:gpt-5.3-codex", displayName: "gpt-5.3-codex", provider: "codex", providerLabel: "Codex CLI" },
      { value: "opencode", displayName: "OpenCode", provider: "opencode", providerLabel: "OpenCode" },
    ],
    // small implies starred, matching the real cycle
    starredModels: ["claude-fable-5[1m]", "codex:gpt-5.3-codex", "claude-sonnet-5"],
    smallModel: "claude-sonnet-5",
    // enough for all four dragons: a context reading that would have read as
    // full against the wrong window, and windows that all roll over later
    contexts: {
      p1: { tokens: 393_315, window: 1_000_000 },
      p2: { tokens: 84_120, window: 200_000 },
    },
    usage: {
      claude: {
        fiveHour: 83,
        weekly: 18,
        scoped: { label: "Fable", percent: 9 },
        resets: {
          fiveHour: now + 2 * 3_600_000 + 41 * 60_000,
          weekly: now + 6 * 86_400_000 + 22 * 3_600_000,
          scoped: now + 6 * 86_400_000 + 22 * 3_600_000,
        },
        at: now,
      },
    },
    stats: {
      prj1: {
        today: { tokens: 1_284_000, costUsd: 4.31, turns: 12, ms: 41 * 60_000 },
        week: { tokens: 6_930_000, costUsd: 22.9, turns: 71, ms: 4 * 3_600_000 },
        total: { tokens: 48_200_000, costUsd: 161.4, turns: 512, ms: 30 * 3_600_000 },
      },
      prj2: {
        today: { tokens: 312_000, costUsd: 0.92, turns: 3, ms: 9 * 60_000 },
        week: { tokens: 1_100_000, costUsd: 3.4, turns: 14, ms: 50 * 60_000 },
        total: { tokens: 9_400_000, costUsd: 30.1, turns: 120, ms: 7 * 3_600_000 },
      },
    },
    drafts: {
      p2: {
        messageId: "d2",
        text: "Reading the provider layer now. The session id is minted on the first result, which means a resume before any turn has finished has nothing to resume — so the fix is to mint it",
      },
    },
    tracker: {
      p1: [
        { id: "t1", text: "Check reconnect backs off after killing the server", note: "", status: "open", source: "auto", turnId: "e1", ts: now - 48_000 },
        { id: "t2", text: "Verify retry delay caps at 30s", note: "", status: "open", source: "auto", turnId: "e1", ts: now - 48_000 },
        { id: "t3", text: "Unread dot clears when opening the project", note: "still sticks after a fresh launch — check ordering", status: "rejected", source: "auto", turnId: "e0", ts: now - 180_000 },
        { id: "t4", text: "Try the new sidebar folder grouping", note: "", status: "liked", source: "manual", ts: now - 300_000 },
      ],
    },
    ideas: {
      prj1: [
        { id: "i1", text: "A keyboard-only pass over the whole app", done: false, ts: now - 60_000 },
        { id: "i2", text: "Let a session run a check before every commit", done: false, ts: now - 90_000 },
        { id: "i3", text: "Sidebar folders", done: true, ts: now - 900_000 },
      ],
    },
    components: {
      prj1: [
        {
          id: "c1",
          name: "the dragon gauges",
          aliases: ["the bars", "the gauges"],
          files: ["web/src/components/Dragon.tsx", "web/src/styles.css:2864"],
          note: "Four of them flank the composer: context, 5h, weekly, per-model.",
          shots: [],
          ts: now - 400_000,
        },
      ],
    },
    skills: [
      {
        name: "omniscience",
        description:
          "Use whenever building, writing, or modifying code or files in a project — implementing features, fixing bugs, refactoring, scaffolding, editing configs or docs.",
        scope: "global",
        path: "/Users/you/.claude/skills/omniscience",
        enabled: true,
        source: "justin06lee/omniscience.md",
      },
      {
        name: "dataviz",
        description: "Use before writing any chart, graph, plot, dashboard, or data visualization.",
        scope: "global",
        path: "/Users/you/.claude/skills-off/dataviz",
        enabled: false,
      },
      {
        name: "release",
        description: "How this repo cuts a release: version bump, build, tag, push, install.",
        scope: "project",
        path: "/Users/you/Workspace/ruri/.claude/skills/release",
        enabled: true,
      },
    ],
    secrets: [
      { id: "s1", name: "deploy-box", username: "root", hasValue: true, updated: now - 86_400_000 },
    ],
    summaries: {
      p1: {
        e0: "Investigated flaky sidebar unread dot: race between snapshot and event broadcast in server.ts; fixed by ordering broadcasts after archive append. Tests green.",
        e1: "Fixed ws reconnect backoff in web/src/store.ts: moved state out of connect(), capped 30s, added jitter; typecheck+tests pass.",
      },
    },
    transcripts: {
      home: [
        { kind: "user", id: "h1", text: "yo open up alpha and beta", ts: now - 400_000 },
        {
          kind: "assistant",
          id: "h2",
          text: "hm. queued alpha and beta — they'll open when this turn ends.",
          ts: now - 395_000,
        },
        { kind: "result", id: "h3", ok: true, durationMs: 21_000, ts: now - 394_000 },
      ],
      p1: [
        { kind: "user", id: "e0", text: "The unread dot sometimes sticks — look into it?", ts: now - 200_000 },
        { kind: "tool", id: "e0a", name: "Grep", summary: "unread in server", ts: now - 195_000 },
        { kind: "assistant", id: "e0b", text: "Found a race — fixed by reordering broadcasts.", ts: now - 190_000 },
        { kind: "result", id: "e0c", ok: true, costUsd: 0.21, durationMs: 30_000, ts: now - 189_000 },
        { kind: "user", id: "e1", text: "The websocket reconnect logic seems broken — can you look at `store.ts` and fix it?", ts: now - 90_000 },
        { kind: "tool", id: "e2", name: "Read", summary: "/Users/you/Workspace/ruri/web/src/store.ts", ts: now - 80_000 },
        { kind: "tool", id: "e3", name: "Grep", summary: "setTimeout(connect in web/src", ts: now - 75_000 },
        {
          kind: "tool",
          id: "e4",
          name: "Edit",
          summary: "/Users/you/Workspace/ruri/web/src/store.ts",
          diff: {
            path: "ruri/web/src/store.ts",
            added: 3,
            removed: 1,
            hunks: [
              {
                oldStart: 61,
                newStart: 61,
                lines: [
                  { kind: "ctx", text: "let ws: WebSocket | null = null;" },
                  { kind: "ctx", text: "" },
                  { kind: "del", text: "let attempt = 0;" },
                  { kind: "add", text: "/** Retries grow from here — reset only on a clean open. */" },
                  { kind: "add", text: "let attempt = 0;" },
                  { kind: "add", text: "" },
                  { kind: "ctx", text: "export function connect(): void {" },
                ],
              },
            ],
          },
          ts: now - 70_000,
        },
        { kind: "tool", id: "e5", name: "Bash", summary: "bun run typecheck && bun test", ts: now - 60_000 },
        { kind: "assistant", id: "e6", text: ASSISTANT_MD, ts: now - 50_000 },
        { kind: "result", id: "e7", ok: true, costUsd: 0.3148, durationMs: 42_000, ts: now - 49_000 },
        { kind: "user", id: "e8", text: "Yes — and push it when you're done.", ts: now - 20_000 },
      ],
    },
    permissions: [
      {
        requestId: "name1",
        projectId: "p1",
        toolName: "name_component",
        kind: "component",
        input: {
          name: "the dragon gauges",
          files: ["web/src/components/Dragon.tsx", "web/src/styles.css:2864"],
          note: "Four bottom-up bars flanking the composer: context, 5h, weekly, per-model.",
        },
        ts: now - 3_000,
      },
      {
        requestId: "perm1",
        projectId: "p1",
        toolName: "Bash",
        input: { command: "git push origin master" },
        ts: now - 5_000,
      },
      {
        requestId: "ask1",
        projectId: "p1",
        toolName: "AskUserQuestion",
        kind: "question",
        input: {
          questions: [
            {
              question: "How should the relay be shaped?",
              header: "Relay",
              multiSelect: false,
              options: [
                { label: "Standalone binary", description: "A new binary speaking a minimal framed protocol, advertised through the netmap." },
                { label: "DERP-compatible", description: "Ride the public relay fleet — free coverage, much larger surface." },
                { label: "Relay mode only", description: "One less thing to deploy; the control plane and the data path share a blast radius." },
              ],
            },
            {
              question: "How aggressive should DNS be about the system resolver?",
              header: "DNS",
              multiSelect: false,
              options: [
                { label: "Split-DNS, mesh domain only", description: "Register the mesh suffix with the OS resolver; every other lookup is untouched." },
                { label: "Hosts-file sync", description: "Trivially simple, but leaves stale entries if the daemon dies uncleanly." },
              ],
            },
            {
              question: "Which parts of port mapping should exist?",
              header: "Mapping",
              multiSelect: true,
              options: [
                { label: "NAT-PMP", description: "Compact binary UDP to the gateway — covers Apple gear." },
                { label: "PCP", description: "The modern successor; most current routers speak it." },
                { label: "UPnP IGD", description: "SSDP discovery and SOAP over HTTP for a shrinking share of devices." },
              ],
            },
          ],
        },
        ts: now - 4_000,
      },
    ],
  });
}
