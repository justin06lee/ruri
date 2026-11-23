/**
 * What the terminal window knows: the same picture the desktop window keeps
 * (web/src/store.ts), cut down to what a terminal shows. `reduce` is every
 * server message applied to it, and nothing else: no socket, no screen, so
 * it is tested as a plain function.
 */
import {
  DEFAULT_EFFORT,
  DEFAULT_PERMISSION_MODE,
  EFFORT_LEVELS,
  HOME_ID,
  HOME_TRANSCRIPT_MAX,
  TRANSCRIPT_TAIL,
  keepRecent,
  leadOf,
  type AccountInfo,
  type BackgroundWork,
  type ContextUsage,
  type HomeSettings,
  type ModelChoice,
  type PermissionMode,
  type PermissionRequest,
  type Project,
  type ProjectStatus,
  type QueuedPrompt,
  type QueueHold,
  type ServerMessage,
  type TranscriptEvent,
  type TurnProgress,
  type UsageLimits,
} from "../../shared/protocol";
import type { SidebarLayout } from "../../shared/sidebar";
import { channelAccount } from "../../web/src/lib/accounts";
import { roughName } from "../../web/src/lib/models";
import { insertAt } from "../../web/src/lib/outgoing";
import { overlay, reuse } from "../../web/src/lib/transcript";

/** A reply as it is being written: the paragraphs so far of one message. */
export interface Reply {
  messageId: string;
  text: string;
}

export interface State {
  /** The socket is open. */
  connected: boolean;
  /** A snapshot has arrived: there is something to draw. */
  ready: boolean;
  projects: Project[];
  sidebar: SidebarLayout;
  transcripts: Record<string, TranscriptEvent[]>;
  /** Chats held whole, not as their last few events. */
  loaded: Record<string, true>;
  replies: Record<string, Reply | undefined>;
  statuses: Record<string, ProjectStatus>;
  work: Record<string, BackgroundWork>;
  permissions: PermissionRequest[];
  models: ModelChoice[];
  starredModels: string[];
  defaultModel: string;
  defaultEffort: string;
  queued: Record<string, QueuedPrompt[]>;
  queueHeld: Record<string, QueueHold | undefined>;
  accounts: AccountInfo[];
  usage: Record<string, UsageLimits>;
  contexts: Record<string, ContextUsage>;
  turns: Record<string, TurnProgress>;
  home: HomeSettings;
  workspaceDir: string;
  /** Unsent prompts as the server holds them, by chat. */
  drafts: Record<string, string>;
  /** Chats whose turn ended while another was on screen. */
  unread: Record<string, true>;
  /** The chat on screen: a project's lead, or Home. */
  activeId: string;
  /** The last thing that went wrong, said once at the foot. */
  notice?: string;
}

export function initial(): State {
  return {
    connected: false,
    ready: false,
    projects: [],
    sidebar: { order: [], folders: [] },
    transcripts: {},
    loaded: {},
    replies: {},
    statuses: {},
    work: {},
    permissions: [],
    models: [],
    starredModels: [],
    defaultModel: "",
    defaultEffort: DEFAULT_EFFORT,
    queued: {},
    queueHeld: {},
    accounts: [],
    usage: {},
    contexts: {},
    turns: {},
    home: {},
    workspaceDir: "",
    drafts: {},
    unread: {},
    activeId: HOME_ID,
  };
}

/** Whether a chat is still one a window can show: Home, or some project's
 *  lead. A project closed elsewhere sends the terminal back Home. */
function shown(projects: Project[], id: string): string {
  if (id === HOME_ID) return id;
  return projects.some((p) => p.sessions.some((x) => x.id === id)) ? id : HOME_ID;
}

/** The chat a turn's end is marked unread on: a project's lead only. */
function isLead(projects: Project[], id: string): boolean {
  return id === HOME_ID || projects.some((p) => leadOf(p)?.id === id);
}

export function reduce(s: State, msg: ServerMessage): State {
  switch (msg.type) {
    case "snapshot": {
      // tails: every chat is unloaded again, and the one on screen asks for
      // itself; one held whole keeps its events with the tail laid over
      const transcripts = Object.fromEntries(
        Object.entries(msg.transcripts).map(([id, tail]) => {
          const held = s.loaded[id] ? s.transcripts[id] : undefined;
          return [id, held ? overlay(held, tail) : tail];
        }),
      );
      return {
        ...s,
        ready: true,
        projects: msg.projects,
        sidebar: msg.sidebar ?? { order: [], folders: [] },
        transcripts,
        loaded: {},
        replies: {},
        statuses: msg.statuses,
        work: msg.work ?? {},
        permissions: msg.permissions,
        models: msg.models,
        starredModels: msg.starredModels,
        defaultModel: msg.defaultModel,
        defaultEffort: msg.defaultEffort ?? DEFAULT_EFFORT,
        queued: msg.queued,
        queueHeld: msg.queuesHeld,
        accounts: msg.accounts ?? [],
        usage: msg.usage,
        contexts: msg.contexts,
        turns: msg.turns,
        home: msg.home,
        workspaceDir: msg.workspaceDir,
        drafts: Object.fromEntries(Object.entries(msg.composerDrafts).map(([id, d]) => [id, d.text])),
        activeId: shown(msg.projects, s.activeId),
      };
    }
    case "projects":
      return { ...s, projects: msg.projects, activeId: shown(msg.projects, s.activeId) };
    case "sidebar":
      return { ...s, sidebar: msg.sidebar };
    case "accounts":
      return { ...s, accounts: msg.accounts };
    case "composer_draft":
      return { ...s, drafts: { ...s.drafts, [msg.projectId]: msg.text } };
    case "queued":
      return {
        ...s,
        queued: { ...s.queued, [msg.projectId]: msg.items },
        queueHeld: { ...s.queueHeld, [msg.projectId]: msg.held },
      };
    case "transcript":
      return {
        ...s,
        transcripts: { ...s.transcripts, [msg.projectId]: reuse(s.transcripts[msg.projectId], msg.events) },
        loaded: { ...s.loaded, [msg.projectId]: true },
      };
    case "events_removed": {
      const gone = new Set(msg.eventIds);
      const held = s.transcripts[msg.projectId];
      if (!held) return s;
      return {
        ...s,
        transcripts: { ...s.transcripts, [msg.projectId]: held.filter((e) => !gone.has(e.id)) },
      };
    }
    case "event": {
      let transcript = [...(s.transcripts[msg.projectId] ?? [])];
      const at = transcript.findIndex((e) => e.id === msg.event.id);
      if (at === -1) transcript.splice(insertAt(transcript, msg.event), 0, msg.event);
      else transcript[at] = msg.event;
      if (!s.loaded[msg.projectId] && transcript.length > TRANSCRIPT_TAIL) {
        transcript = transcript.slice(-TRANSCRIPT_TAIL);
      }
      if (msg.projectId === HOME_ID) transcript = keepRecent(transcript, HOME_TRANSCRIPT_MAX);
      const replies =
        msg.event.kind === "assistant" && s.replies[msg.projectId]?.messageId === msg.event.id
          ? { ...s.replies, [msg.projectId]: undefined }
          : s.replies;
      const unread =
        msg.event.kind === "result" && msg.projectId !== s.activeId && isLead(s.projects, msg.projectId)
          ? { ...s.unread, [msg.projectId]: true as const }
          : s.unread;
      return { ...s, transcripts: { ...s.transcripts, [msg.projectId]: transcript }, replies, unread };
    }
    case "delta": {
      const prev = s.replies[msg.projectId];
      const text = prev && prev.messageId === msg.messageId ? prev.text + msg.delta : msg.delta;
      return { ...s, replies: { ...s.replies, [msg.projectId]: { messageId: msg.messageId, text } } };
    }
    case "reply":
      return { ...s, replies: { ...s.replies, [msg.projectId]: msg.draft ?? undefined } };
    case "tails": {
      const transcripts = { ...s.transcripts };
      for (const [id, tail] of Object.entries(msg.transcripts)) {
        const held = transcripts[id];
        transcripts[id] = s.loaded[id] && held ? overlay(held, tail) : tail;
      }
      return { ...s, transcripts };
    }
    case "status":
      return { ...s, statuses: { ...s.statuses, [msg.projectId]: msg.status } };
    case "work": {
      const work = { ...s.work };
      if (msg.work) work[msg.projectId] = msg.work;
      else delete work[msg.projectId];
      return { ...s, work };
    }
    case "permission_request":
      return {
        ...s,
        permissions: [...s.permissions.filter((p) => p.requestId !== msg.request.requestId), msg.request],
      };
    case "permission_resolved":
      return { ...s, permissions: s.permissions.filter((p) => p.requestId !== msg.requestId) };
    case "models":
      return { ...s, models: msg.models };
    case "starred_models":
      return { ...s, starredModels: msg.models };
    case "default_model":
      return { ...s, defaultModel: msg.model };
    case "default_effort":
      return { ...s, defaultEffort: msg.effort };
    case "home_settings":
      return { ...s, home: msg.home };
    case "usage":
      return { ...s, usage: msg.limits };
    case "context":
      return { ...s, contexts: { ...s.contexts, [msg.projectId]: msg.context } };
    case "turn": {
      const turns = { ...s.turns };
      if (msg.turn) turns[msg.projectId] = msg.turn;
      else delete turns[msg.projectId];
      return { ...s, turns };
    }
    case "error":
      return { ...s, notice: msg.message };
    default:
      return s;
  }
}

/* ── what the screen asks of it ─────────────────────────────────────── */

/** One line of the sidebar, top to bottom. */
export type Row =
  | { kind: "home"; id: string }
  | { kind: "folder"; id: string; name: string; collapsed: boolean; count: number }
  | { kind: "project"; id: string; chatId: string; name: string; starred: boolean; inFolder: boolean };

/** The sidebar as the desktop draws it: Home, then the user's own order,
 *  folders with their projects under them (none when folded shut), hidden
 *  projects left out. A project is its lead. */
export function sidebarRows(s: Pick<State, "projects" | "sidebar">): Row[] {
  const byId = new Map(s.projects.map((p) => [p.id, p]));
  const folders = new Map(s.sidebar.folders.map((f) => [f.id, f]));
  const rows: Row[] = [{ kind: "home", id: HOME_ID }];
  const placed = new Set<string>();
  const project = (id: string, inFolder: boolean) => {
    const p = byId.get(id);
    const lead = p && leadOf(p);
    placed.add(id);
    if (!p || !lead || p.hidden) return;
    rows.push({ kind: "project", id, chatId: lead.id, name: p.name, starred: p.starred === true, inFolder });
  };
  for (const id of s.sidebar.order) {
    const folder = folders.get(id);
    if (!folder) {
      project(id, false);
      continue;
    }
    const inside = folder.projects.filter((pid) => byId.get(pid) && !byId.get(pid)!.hidden);
    rows.push({
      kind: "folder",
      id: folder.id,
      name: folder.name,
      collapsed: folder.collapsed === true,
      count: inside.length,
    });
    for (const pid of folder.projects) {
      if (folder.collapsed) placed.add(pid);
      else project(pid, true);
    }
  }
  // one the layout has not heard of yet joins the end, as on the server
  for (const p of s.projects) if (!placed.has(p.id)) project(p.id, false);
  return rows;
}

/** The project a chat belongs to. */
export function projectOf(s: Pick<State, "projects">, chatId: string): Project | undefined {
  return s.projects.find((p) => p.sessions.some((x) => x.id === chatId));
}

/** What a chat is called at the top of its pane. */
export function chatName(s: Pick<State, "projects">, chatId: string): string {
  return chatId === HOME_ID ? "Home" : (projectOf(s, chatId)?.name ?? "…");
}

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Ask first" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass" },
];

const effortLabel = (value: string) =>
  value === "xhigh" ? "XHigh" : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;

export interface Option {
  value: string;
  label: string;
  /** A word beside it: who serves a model, how full an account is. */
  hint?: string;
}

/** A chat's pickers, as the desktop composer works them out
 *  (SessionControls.tsx): its own model, effort and mode over its
 *  project's, the starred models to pick from, the efforts its model
 *  reports, and the account its harness spends from. */
export interface Controls {
  model: string;
  modelLabel: string;
  models: Option[];
  effort: string;
  efforts: Option[];
  mode: PermissionMode;
  /** The harness has an approval flow to set. */
  canSetMode: boolean;
  provider: string;
  account?: AccountInfo;
  accounts: AccountInfo[];
  /** The model runs on this machine: no account, no limits. */
  local?: string;
}

export function controlsOf(s: State, chatId: string): Controls {
  const project = projectOf(s, chatId);
  const session = project?.sessions.find((x) => x.id === chatId);
  const own = chatId === HOME_ID ? s.home : { ...project, ...session };
  const model = (chatId === HOME_ID ? s.home.model : session?.model || project?.model) || s.defaultModel;
  const selected = s.models.find((m) => m.value === model);
  const starred = s.models.filter((m) => s.starredModels.includes(m.value));
  const listed = [...(starred.length > 0 ? starred : s.models)];
  if (selected && !listed.includes(selected)) listed.push(selected);
  if (!selected && model) listed.push({ value: model, displayName: roughName(model) });
  const reported = selected?.reasoningEfforts;
  const efforts = reported?.length
    ? reported.map((e) => ({ value: e.value, label: effortLabel(e.value) }))
    : selected
      ? []
      : EFFORT_LEVELS.map((value) => ({ value, label: effortLabel(value) }));
  const picked = (chatId === HOME_ID ? s.home.effort : session?.effort || project?.effort) || s.defaultEffort;
  const effort = efforts.some((e) => e.value === picked)
    ? picked
    : (selected?.defaultEffort ?? efforts[0]?.value ?? picked);
  const provider = selected?.provider ?? "claude";
  return {
    model,
    modelLabel: selected?.displayName ?? (model ? roughName(model) : "…"),
    models: listed.map((m) => ({
      value: m.value,
      label: m.displayName,
      ...(m.local ? { hint: m.local } : m.providerLabel ? { hint: m.providerLabel } : {}),
    })),
    effort,
    efforts,
    mode:
      (chatId === HOME_ID ? s.home.permissionMode : session?.permissionMode || own.permissionMode) ??
      DEFAULT_PERMISSION_MODE,
    canSetMode: !selected?.provider || selected.agentic === true,
    provider,
    ...(selected?.local
      ? { local: selected.local, accounts: [] }
      : {
          account: channelAccount(s, chatId, provider),
          accounts: s.accounts.filter((a) => a.provider === provider),
        }),
  };
}

/** The cards waiting on the user in one chat, oldest first. */
export function cardsOf(s: Pick<State, "permissions">, chatId: string): PermissionRequest[] {
  return s.permissions.filter((p) => p.projectId === chatId).sort((a, b) => a.ts - b.ts);
}

/** How a chat stands in the sidebar. */
export type Mark = "working" | "needs-you" | "error" | "unread" | "idle";

export function markOf(s: Pick<State, "statuses" | "permissions" | "unread">, chatId: string): Mark {
  if (s.permissions.some((p) => p.projectId === chatId && !p.asked)) return "needs-you";
  const status = s.statuses[chatId];
  if (status === "permission") return "needs-you";
  if (status === "working") return "working";
  if (status === "error") return "error";
  return s.unread[chatId] ? "unread" : "idle";
}
