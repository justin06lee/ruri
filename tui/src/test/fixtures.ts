/** What the terminal's tests stand on: a snapshot small enough to read, and
 *  a wire that is not a socket. */
import type { ClientMessage, Project, ServerMessage, TranscriptEvent } from "../../../shared/protocol";
import type { Wire } from "../client";

export const ALPHA = "chat-alpha";
export const BETA = "chat-beta";
export const GAMMA = "chat-gamma";

export const projects: Project[] = [
  { id: "p-alpha", name: "alpha", path: "/tmp/alpha", sessions: [{ id: ALPHA, lead: true }] },
  {
    id: "p-beta",
    name: "beta 한국어",
    path: "/tmp/beta",
    starred: true,
    sessions: [{ id: BETA, lead: true }],
  },
  { id: "p-gamma", name: "gamma", path: "/tmp/gamma", sessions: [{ id: GAMMA, lead: true }] },
  {
    id: "p-hidden",
    name: "tucked",
    path: "/tmp/tucked",
    hidden: true,
    sessions: [{ id: "chat-hidden", lead: true }],
  },
];

export const user = (id: string, text: string, ts = 1): TranscriptEvent => ({ kind: "user", id, text, ts });
export const said = (id: string, text: string, ts = 2): TranscriptEvent => ({
  kind: "assistant",
  id,
  text,
  ts,
});

export function snapshot(over: Record<string, unknown> = {}): ServerMessage {
  return {
    type: "snapshot",
    projects,
    sidebar: {
      order: ["p-beta", "f-1", "p-gamma"],
      folders: [{ id: "f-1", name: "work", projects: ["p-alpha", "p-hidden"] }],
    },
    transcripts: { [ALPHA]: [user("u1", "hello alpha"), said("a1", "hi **there**")] },
    statuses: { [ALPHA]: "idle", [BETA]: "working" },
    work: {},
    permissions: [],
    models: [
      { value: "fable", displayName: "Fable 5.2", reasoningEfforts: [{ value: "high" }, { value: "xhigh" }] },
      { value: "haiku", displayName: "Haiku 5.5" },
      {
        value: "ollama/bonsai",
        displayName: "bonsai-2",
        provider: "ollama",
        providerLabel: "Ollama",
        local: "Ollama",
      },
    ],
    starredModels: [],
    defaultModel: "fable",
    defaultEffort: "xhigh",
    queued: {},
    queuesHeld: {},
    accounts: [
      { id: "work", name: "Work", provider: "claude", dir: "/w", usage: "claude", builtIn: true },
      {
        id: "personal",
        name: "Personal",
        provider: "claude",
        dir: "/p",
        usage: "claude-personal",
        builtIn: true,
      },
    ],
    usage: {
      claude: { fiveHour: 12, weekly: 48 },
      "claude-personal": { weekly: 95, scoped: { label: "Fable", percent: 97 } },
    },
    contexts: { [ALPHA]: { tokens: 50_000, window: 200_000 } },
    turns: {},
    home: {},
    workspaceDir: "/tmp",
    composerDrafts: {},
    ...over,
  } as unknown as ServerMessage;
}

/** A wire the test holds both ends of. */
export class FakeWire implements Wire {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readonly sent: ClientMessage[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  /** The server's side: the line comes up, and says something. */
  open(): void {
    this.onopen?.();
  }
  say(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** What was sent of one kind. */
  of<T extends ClientMessage["type"]>(type: T): Array<Extract<ClientMessage, { type: T }>> {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: T }> => m.type === type);
  }
}
