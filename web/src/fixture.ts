/**
 * Canned state for `?fixture` mode: every kind of transcript event, a pending
 * permission, folder groups, and per-project statuses — so the whole UI can be
 * eyeballed and screenshotted without a live server or a single token.
 */
import { useRuri } from "./store";

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
      { value: "claude-fable-5[1m]", displayName: "Fable" },
      { value: "claude-opus-5", displayName: "Opus" },
      { value: "claude-sonnet-5", displayName: "Sonnet" },
      { value: "codex:gpt-5.3-codex", displayName: "gpt-5.3-codex", provider: "codex", providerLabel: "Codex CLI" },
      { value: "opencode", displayName: "OpenCode", provider: "opencode", providerLabel: "OpenCode" },
    ],
    // small implies starred, matching the real cycle
    starredModels: ["claude-fable-5[1m]", "codex:gpt-5.3-codex", "claude-sonnet-5"],
    smallModel: "claude-sonnet-5",
    tracker: {
      p1: [
        { id: "t1", text: "Check reconnect backs off after killing the server", note: "", status: "open", source: "auto", turnId: "e1", ts: now - 48_000 },
        { id: "t2", text: "Verify retry delay caps at 30s", note: "", status: "open", source: "auto", turnId: "e1", ts: now - 48_000 },
        { id: "t3", text: "Unread dot clears when opening the project", note: "still sticks after a fresh launch — check ordering", status: "rejected", source: "auto", turnId: "e0", ts: now - 180_000 },
        { id: "t4", text: "Try the new sidebar folder grouping", note: "", status: "liked", source: "manual", ts: now - 300_000 },
      ],
    },
    briefs: {
      p1: {
        description: "A desktop workspace for running parallel AI coding sessions, one folder per project.",
        features: [
          "Multi-model sessions per project (Claude, Codex, OpenCode, any ACP agent)",
          "Usage gauges: context, 5h, weekly, per-model",
          "Home agent that opens and closes projects for you",
          "Rapid fire: prompt every session that's waiting, in turn",
          "A shell per project, in the composer",
        ],
        shots: [],
        updated: now - 600_000,
      },
    },
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
