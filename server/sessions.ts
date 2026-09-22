import { questionError } from "../shared/questionInput.js";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  AgentSession,
  AuthRequiredError,
  isSessionProvider,
  ProviderNotInstalledError,
  type AgentEvent,
  type AgentOptions,
  type ContentBlockParam,
  type ModelRef,
  type PermissionDecision,
  type PermissionRequest as YagamiPermissionRequest,
  type Provider,
  type ProviderSession,
  type SDKMessage,
  type SessionPermissionDecision,
  type SessionPermissionRequest,
  type SessionInputRequest,
  type SessionInputResponse,
  type SessionInputValue,
  type SessionProvider,
  type Usage,
} from "@justin06lee/yagami";
import {
  getSessionMessages,
  type HookInput,
  type PreToolUseHookSpecificOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { buildDiff, parseUnifiedDiff, readBefore } from "./diff.js";
import { IMAGE_EXTS } from "./mime.js";
import { readCodexCounts } from "./usage.js";
import { blockedBy, limitResetsAt, NETWORK } from "./blocked.js";
import { errorMessage, warn } from "./log.js";
import {
  DEFAULT_EFFORT,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_MODEL,
  type AskAnswers,
  type AskQuestions,
  type Attachment,
  type BackgroundWork,
  type FileDiff,
  type ModelChoice,
  type PermissionMode,
  type PermissionRequest,
  type Project,
  type ProjectStatus,
  type SubagentState,
  type TranscriptEvent,
  unmarked,
} from "../shared/protocol.js";

type PermissionUpdate = NonNullable<YagamiPermissionRequest["suggestions"]>[number];

export interface SessionEvents {
  onEvent(projectId: string, event: TranscriptEvent): void;
  onDelta(projectId: string, messageId: string, delta: string): void;
  onStatus(projectId: string, status: ProjectStatus): void;
  onPermission(request: PermissionRequest): void;
  onPermissionResolved(requestId: string): void;
  /** A question card's tool call stopped waiting; the card is still up. */
  onQuestionLate(requestId: string): void;
  onModels(models: ModelChoice[]): void;
  /** The live Claude session id changed (used to resume across restarts). */
  onSessionId(projectId: string, sessionId: string): void;
  /** Context-window occupancy after the session's latest API call, with the
   *  model's own window when the harness reports one (Codex does). */
  onContext(projectId: string, tokens: number, window?: number): void;
  /** The running turn got further along: `chars` is model output streamed
   *  since the last call (text or thinking — an estimate, because the
   *  stream carries no counts), `tokens` the exact cumulative output-token
   *  count the moment an API call finishes and reports one. */
  onProgress(projectId: string, progress: { chars?: number; tokens?: number }): void;
  /** A turn's SDK chain uuid landed: the prompt's own uuid ("user", the
   *  file-rewind target) or the turn's latest entry ("last", the fork
   *  point for rewinding past it). Claude sessions only. */
  onChain(projectId: string, eventId: string, kind: "user" | "last", uuid: string): void;
  /** An event already sent, sent again changed — a subagent's card moving
   *  along. Replaces it where it is; never adds it. Omitted = onEvent. */
  onEventUpdate?(projectId: string, event: TranscriptEvent): void;
  /** Something a subagent did, for its own log (`key` is its card's
   *  SubagentState.key) — never for the chat. */
  onAgentEvent?(projectId: string, key: string, event: TranscriptEvent): void;
  /** The work running in the background of the session changed — a
   *  background task started or ended, a subagent finished. The manager
   *  looks again at whether an idle session can close. */
  onBackground?(projectId: string): void;
}

/** Extra per-project session config (the Home agent's MCP tools live here). */
export interface SessionExtras {
  /** Tool names auto-allowed without a permission prompt. */
  autoAllow?: string[];
  /** Extra Agent SDK options, merged last. */
  options?: AgentOptions;
  /** System prompt for non-Claude harness sessions. Codex takes it natively
   *  (developer instructions on the thread); ACP agents can't, so it rides
   *  the first prompt of each app run as a <system> block. */
  providerSystem?: string;
  /** Runs when a non-Claude turn finishes (Home's drop-file pickup). */
  onProviderTurnEnd?: () => void;
  /**
   * Swap ruri's vault handles ({{name}}) for the values they stand for, in
   * the last moment before a tool runs — after the model has finished
   * writing, so its context only ever held the handle. Returns undefined
   * when the input had none, which is almost always.
   */
  fillSecrets?: (input: Record<string, unknown>) => Record<string, unknown> | undefined;
  /**
   * What a tool that can change the project's files waits on before it
   * runs: the checkpoint of the prompt it is working for. The capture runs
   * alongside the prompt rather than holding it up, and this is what makes
   * sure it has finished before anything it is meant to have seen can be
   * changed (server/checkpoints.ts).
   */
  beforeTools?: () => Promise<void>;
  /**
   * The chat's transcript as it stands. An agent a turn started lives in
   * the harness's own records long after the process that ran it is gone,
   * and the model can send it on again from a new one — this is where that
   * process finds the card it is picking back up.
   */
  transcript?: () => TranscriptEvent[];
}

/** How the manager reaches non-Claude harnesses (see server/providers.ts). */
export interface ProviderHooks {
  /** Split a model id into provider + native model. */
  parse(model: string | undefined): ModelRef;
  /** Build a provider instance working in the given project directory,
   *  for the given chat — whose id rides into the harness's environment,
   *  so a process on this machine can be traced back to its conversation
   *  (server/resources.ts). */
  create(id: string, workDir: string, channelId: string): Provider;
  /** Whether an agentic session can fork at its provider-native turn ids. */
  canFork?(id: string): boolean;
}

/** What the manager needs from a live session, whichever harness runs it. */
interface ChannelSession {
  status: ProjectStatus;
  lastSessionId: string | undefined;
  dead: boolean;
  /** silent = no user transcript event (split sub-prompts ride under the
   *  original prompt the user already sees). */
  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent?: boolean,
    visibleEventId?: string,
  ): void;
  interrupt(): void;
  setModel(model: string): void;
  setPermissionMode(mode: PermissionMode): void;
  /** Apply a new reasoning effort. No harness changes it on a warm session,
   *  so implementations either take it for their next turn (run-per-turn)
   *  or retire themselves — the next send rebuilds with resume. */
  setEffort(effort: string): void;
  /** Restore tracked files to their state at a user message's chain uuid
   *  (Claude only — other harnesses answer canRewind: false). */
  rewindFiles(uuid: string): Promise<{ canRewind: boolean; error?: string }>;
  /** Work the harness is still doing in the background of an idle session
   *  (a shell left running, a subagent) — closing the process would kill it. */
  hasBackgroundWork?(): boolean;
  /** That work, counted — agents and scripts apart — for the sidebar and
   *  the projects page to say a chat is busy with no turn running. */
  backgroundWork?(): BackgroundWork;
  dispose(): void;
  respondPermission(requestId: string, allow: boolean, always?: boolean): boolean;
  /** Answer an AskUserQuestion card. Omitted answers = the user dismissed it,
   *  which the tool reports to the model as "no answer" rather than failing.
   *  "late" means the card was still up but the tool call had already moved
   *  on — the caller sends the answers as a prompt instead. */
  respondQuestion(requestId: string, answers?: AskAnswers): QuestionOutcome;
  pendingRequests(): string[];
}

/** Collapse absolute paths inside the project down to "name/relative" —
 *  paths outside the project keep their full string, which is the signal. */
function shortenPaths(text: string, project: Project): string {
  const root = project.path.replace(/\/+$/, "");
  if (!root) return text;
  return text.replaceAll(`${root}/`, `${project.name}/`).replaceAll(root, project.name);
}

/** File-path fields, in every spelling the harnesses use. */
const PATH_KEYS = ["file_path", "path", "filePath", "abs_path", "absolute_path", "filename"];

/** The absolute path a tool call names, whatever it calls that field. */
function toolPath(input: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && path.isAbsolute(value)) return value;
  }
  return undefined;
}

/** The first of these keys the input carries as a string. */
function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * The patch a Write or Edit is about to apply. Called as the tool_use block
 * arrives, which is before the CLI runs the tool — so the file on disk is
 * still the pre-image. An Edit's post-image is that pre-image with the
 * replacement applied, so both tools go through one diff path and get real
 * line numbers and context.
 */
function toolDiff(
  name: string,
  input: Record<string, unknown>,
  project: Project,
  /** The hook's capture, when it got there first; undefined = read it now. */
  captured?: string | null,
): FileDiff | undefined {
  const file = toolPath(input);
  if (file === undefined) return undefined;
  const display = shortenPaths(file, project);
  const preimage = () => (captured !== undefined ? captured : readBefore(file));

  if (name === "Write") {
    const content = pick(input, "content", "contents", "text", "new_text", "newText");
    if (content === undefined) return undefined;
    return buildDiff(display, preimage(), content) ?? undefined;
  }
  if (name !== "Edit") return undefined;

  const oldStr = pick(input, "old_string", "old_text", "oldText", "old");
  const newStr = pick(input, "new_string", "new_text", "newText", "new");
  if (oldStr === undefined || newStr === undefined) {
    // a whole-file rewrite that came in under an edit's name
    const content = pick(input, "content", "contents", "text");
    return content === undefined ? undefined : (buildDiff(display, preimage(), content) ?? undefined);
  }
  const before = preimage();
  if (before === null || !before.includes(oldStr)) {
    // no pre-image to anchor against (a brand-new file, or the edit already
    // landed) — the strings still describe the change on their own
    return buildDiff(display, oldStr, newStr) ?? undefined;
  }
  const after =
    input["replace_all"] === true ? before.replaceAll(oldStr, newStr) : before.replace(oldStr, newStr);
  return buildDiff(display, before, after) ?? undefined;
}

/**
 * The longest stretch of a prompt that survives into what the model was
 * sent: the words between the markers.
 *
 * A file's [file #1] becomes its path on the way to the model, and a
 * compaction brief rides in front of the whole thing, so the prompt as the
 * transcript shows it is not a substring of the prompt as the CLI recorded
 * it — but the sentences around the markers are, verbatim.
 */
function literalRun(text: string): string {
  const runs = text
    .split(/\[(?:image|video|file|region) #\d+[^\]]*\]/g)
    .map((run) => run.trim())
    .filter((run) => run.length > 0);
  const longest = runs.sort((a, b) => b.length - a.length)[0] ?? "";
  return longest.length >= 8 ? longest : text.trim();
}

/** The text a CLI transcript entry's user message actually carries (tool
 *  results and other block types are not prompts). */
function promptTextOf(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("");
}

/** How full the context window was after one API call, from its usage:
 *  everything sent (fresh and cached) and everything back. */
function occupancy(message: unknown): number | undefined {
  const usage = (
    message as
      | {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        }
      | undefined
  )?.usage;
  if (!usage) return undefined;
  const tokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  return tokens > 0 ? tokens : undefined;
}

/**
 * The CLI's uuid for a prompt — what a file rewind is keyed by.
 *
 * The SDK stopped echoing prompts back as `user` messages, so the chain map
 * built from that echo can have no entry (and, worse, could pin the wrong
 * uuid on a turn). The session's own transcript is the ground truth the
 * checkpoints share, so read it back and find the prompt by its text.
 * `ordinal` picks between repeats: the count of identical earlier prompts.
 */
export async function promptChain(
  project: Project,
  sessionId: string,
  text: string,
  ordinal: number,
): Promise<{ user: string; before?: string; contextBefore?: number } | undefined> {
  const needle = literalRun(text);
  if (!needle) return undefined;
  try {
    const messages = await getSessionMessages(sessionId, { dir: project.path });
    const matches = messages.filter((m) => m.type === "user" && promptTextOf(m.message).includes(needle));
    const match = matches[ordinal] ?? matches[matches.length - 1];
    if (!match) return undefined;
    // the entry just before the prompt is where a resume forks: everything
    // up to it is kept, the prompt and its turn are not
    const at = messages.findIndex((m) => m.uuid === match.uuid);
    const before = messages[at - 1]?.uuid;
    // and how full the context was there: the last main-loop reply before
    // the prompt says, the same way a live one does (see onContext)
    const contextBefore = messages
      .slice(0, at)
      .reverse()
      .map((m) =>
        m.type === "assistant" && m.parent_tool_use_id === null ? occupancy(m.message) : undefined,
      )
      .find((n) => n !== undefined);
    return {
      user: match.uuid,
      ...(before ? { before } : {}),
      ...(contextBefore !== undefined ? { contextBefore } : {}),
    };
  } catch (err) {
    warn("sessions", err, "promptChain");
    // no transcript on disk (a provider session, a pruned file) — the
    // caller falls back to rewinding the conversation alone
    return undefined;
  }
}

/** Extensions the transcript will show inline — what Read itself can take. */
/**
 * A Read of an image earns a thumbnail in the transcript: reading a
 * screenshot and only seeing its path back is the one case where the tool
 * chip hides the thing you actually wanted to look at. Served through
 * /readfile, which only answers for paths a tool event recorded.
 */
export function readImage(
  name: string,
  input: Record<string, unknown>,
): { url: string; name: string } | undefined {
  if (name !== "Read" && name !== "NotebookRead") return undefined;
  const file = toolPath(input);
  if (file === undefined) return undefined;
  if (!IMAGE_EXTS.has(path.extname(file).toLowerCase())) return undefined;
  return { url: `/readfile?p=${encodeURIComponent(file)}`, name: path.basename(file) };
}

export function toolSummary(name: string, input: Record<string, unknown>, project: Project): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  let summary: string | undefined;
  switch (name) {
    case "AskUserQuestion":
      // the chip is the transcript's record of what was asked — the raw
      // options JSON says nothing a reader wants
      summary = readQuestions(input)
        ?.questions.map((q) => q.question)
        .join(" · ");
      break;
    case "Bash":
      summary = str("command");
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      summary = str("file_path");
      break;
    case "Glob":
    case "Grep":
      summary = [str("pattern"), str("path")].filter(Boolean).join(" in ");
      break;
    case "WebFetch":
      summary = str("url");
      break;
    case "WebSearch":
      summary = str("query");
      break;
    case "Agent":
    case "Task":
      summary = str("description") ?? str("prompt");
      break;
    case "Skill":
      summary = str("skill") ?? str("command");
      break;
  }
  summary ??= JSON.stringify(input);
  summary = shortenPaths(summary, project);
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

interface PendingPermission {
  resolve(decision: PermissionDecision): void;
  toolName: string;
  suggestions?: PermissionUpdate[];
}

/** An AskUserQuestion card waiting on the user; resolving it unblocks the
 *  PreToolUse hook, which hands the answers to the tool as its input. */
interface PendingQuestion {
  resolve(answers: AskAnswers | undefined): void;
  /** The tool call stopped waiting — the CLI gave up on the hook, or the
   *  turn ended — so an answer now has nowhere to go but a new prompt. */
  late?: boolean;
}

interface PendingProviderInput {
  resolve(response: SessionInputResponse): void;
  request: SessionInputRequest;
  questions: AskQuestions;
}

/** What answering a question card did. */
type ToolEvent = Extract<TranscriptEvent, { kind: "tool" }>;

/** A string field of a tool input, when it is a non-empty one. */
function field(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The first line of a brief, short enough to title a card. */
function headline(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

/** The text of a tool_result block's content (a string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
    .trim();
}

/** A subagent's card, as the tool call that started it describes it. */
function agentCard(
  key: string,
  input: Record<string, unknown>,
  project: Project,
  fallback?: string,
): ToolEvent {
  const prompt = field(input, "prompt") ?? fallback;
  const description = field(input, "description") ?? (prompt ? headline(prompt) : "subagent");
  const type = field(input, "subagent_type") ?? field(input, "agent_type");
  const model = field(input, "model");
  const ts = Date.now();
  return {
    kind: "tool",
    id: randomUUID(),
    name: "Agent",
    summary: clip(shortenPaths(description, project)),
    agent: {
      key,
      description,
      ...(type ? { type } : {}),
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      status: "running",
      ...(input["run_in_background"] === true ? { background: true } : {}),
      startedAt: ts,
    },
    ts,
  };
}

/**
 * The subagents one session has started, by the spawning call's id: each
 * one's card — the chip in the chat, or in its parent agent's log when an
 * agent started it — and where that card lives. Every change to an agent
 * goes out as the same card again, so the chip is always the agent as it
 * stands; what the agent does goes to its own log.
 */
class AgentBook {
  private readonly cards = new Map<string, { event: ToolEvent; parent?: string; said?: string }>();
  /** Keys the chat has no card for (an agent's own agent, from an earlier
   *  process): looked for once, not on every word they say. */
  private readonly strangers = new Set<string>();

  constructor(
    private readonly projectId: string,
    private readonly events: SessionEvents,
    /** The cards the chat already holds, from its earlier processes — an
     *  agent one of those started can be picked back up in this one. */
    private readonly earlier: () => ToolEvent[] = () => [],
  ) {}

  has(key: string): boolean {
    return this.cards.has(key);
  }

  /** A card this process didn't start, taken on from the chat — true when
   *  there was one to take. Only a top-level card can be: an agent's own
   *  agents live in its log, not the chat. */
  adopt(key: string): boolean {
    if (this.cards.has(key)) return true;
    if (this.strangers.has(key)) return false;
    const event = this.earlier().find((e) => e.agent?.key === key);
    if (!event?.agent) {
      this.strangers.add(key);
      return false;
    }
    // one left "running" belonged to a process that is gone
    const agent: SubagentState =
      event.agent.status === "running" ? { ...event.agent, status: "stopped" } : event.agent;
    this.cards.set(key, { event: { ...event, agent } });
    return true;
  }

  /** The card of the agent the harness knows by `agentId` — this process's
   *  or, adopted, an earlier one's. */
  keyOf(agentId: string): string | undefined {
    for (const [key, card] of this.cards) if (card.event.agent?.agentId === agentId) return key;
    const key = this.earlier().find((e) => e.agent?.agentId === agentId)?.agent?.key;
    return key && this.adopt(key) ? key : undefined;
  }

  /** Whether the agent under `key` has ended — failed, stopped or done. */
  ended(key: string): boolean {
    const status = this.cards.get(key)?.event.agent?.status;
    return status !== undefined && status !== "running";
  }

  isScript(key: string): boolean {
    return this.cards.get(key)?.event.agent?.script === true;
  }

  /**
   * An agent that had ended, sent on again — Claude resumes one when the
   * model messages it, a failed one as much as a finished one. It works
   * again, in the background, with what it was told opening its next
   * stretch of log; the numbers start over for the run.
   */
  resume(key: string, prompt: string | undefined, id: string): void {
    const card = this.cards.get(key);
    const current = card?.event.agent;
    if (!card || !current || current.status === "running") return;
    const { endedAt: _ended, result: _result, tokens: _tokens, tools: _tools, ...rest } = current;
    const next: SubagentState = {
      ...rest,
      status: "running",
      background: true,
      startedAt: Date.now(),
      resumed: (current.resumed ?? 0) + 1,
      ...(prompt ? { activity: headline(prompt) } : {}),
    };
    card.event = { ...card.event, agent: next };
    delete card.said;
    if (prompt) this.log(key, { kind: "user", id: `${id}:brief`, text: prompt, ts: Date.now() });
    this.emit(card);
    this.events.onBackground?.(this.projectId);
  }

  /** A tool call already on screen (a shell left running) becomes a card
   *  where it stands: the same event, sent again with its state. */
  attach(event: ToolEvent, parent?: string): void {
    const key = event.agent?.key;
    if (!key || this.cards.has(key)) return;
    const card = { event, ...(parent ? { parent } : {}) };
    this.cards.set(key, card);
    this.emit(card);
    this.events.onBackground?.(this.projectId);
  }

  /** What is still running here, agents and scripts apart. */
  running(): BackgroundWork {
    const work = { agents: 0, scripts: 0 };
    for (const card of this.cards.values()) {
      const agent = card.event.agent;
      if (agent?.status !== "running") continue;
      if (agent.script) work.scripts += 1;
      else work.agents += 1;
    }
    return work;
  }

  private emit(card: { event: ToolEvent; parent?: string }): void {
    if (card.parent) this.events.onAgentEvent?.(this.projectId, card.parent, card.event);
    else (this.events.onEventUpdate ?? this.events.onEvent)(this.projectId, card.event);
  }

  isBackground(key: string): boolean {
    return this.cards.get(key)?.event.agent?.background === true;
  }

  /** Whether any agent is still working — after a turn, only ones left in
   *  the background (and whatever they started) can be. */
  anyRunning(): boolean {
    for (const card of this.cards.values()) if (card.event.agent?.status === "running") return true;
    return false;
  }

  /** A new agent: its card goes out where it was started from, and its log
   *  opens with the brief it was handed. */
  start(event: ToolEvent, parent?: string): void {
    const agent = event.agent;
    if (!agent || this.cards.has(agent.key)) return;
    this.cards.set(agent.key, { event, ...(parent ? { parent } : {}) });
    if (parent) this.events.onAgentEvent?.(this.projectId, parent, event);
    else this.events.onEvent(this.projectId, event);
    if (agent.prompt) {
      this.log(agent.key, { kind: "user", id: `${agent.key}:brief`, text: agent.prompt, ts: event.ts });
    }
  }

  /** Move an agent's card along. A finished agent stays finished — a late
   *  progress report, or a "shut down" after it had already reported, is
   *  not a reason to say anything else about how it ended. */
  update(key: string, patch: Partial<Omit<SubagentState, "key">>): void {
    const card = this.cards.get(key);
    const current = card?.event.agent;
    if (!card || !current) return;
    const next: SubagentState = { ...current, ...patch };
    if (current.status !== "running") next.status = current.status;
    if (next.status !== "running") {
      next.endedAt ??= Date.now();
      // the last thing it said is its report, when nothing else is
      if (!next.result && card.said) next.result = card.said;
    }
    const changed = (Object.keys(next) as Array<keyof SubagentState>).some((k) => next[k] !== current[k]);
    if (!changed) return;
    card.event = { ...card.event, agent: next };
    this.emit(card);
    // one fewer agent at work (or one more gone to the background): the
    // session may be free to close, and the chat's work has changed
    if (
      (current.status === "running" && next.status !== "running") ||
      (next.background && !current.background)
    )
      this.events.onBackground?.(this.projectId);
  }

  /** Something the agent did, for its log. */
  log(key: string, event: TranscriptEvent): void {
    const card = this.cards.get(key);
    if (card && event.kind === "assistant") card.said = event.text;
    this.events.onAgentEvent?.(this.projectId, key, event);
  }

  /** Every agent still running (that `which` picks) has ended — stopped,
   *  as a rule: the process that ran them is gone, or the turn that waited
   *  on them was cut short. `nested`: an agent started it, not the chat. */
  settle(
    status: "stopped" | "done" = "stopped",
    which: (agent: SubagentState, nested: boolean) => boolean = () => true,
  ): void {
    for (const [key, card] of this.cards) {
      const agent = card.event.agent;
      if (agent?.status === "running" && which(agent, card.parent !== undefined))
        this.update(key, { status });
    }
  }
}

/** A Claude task message, the fields ruri reads (task_started,
 *  task_progress, task_updated, task_notification). */
interface TaskMessage {
  subtype: "task_started" | "task_progress" | "task_updated" | "task_notification";
  task_id: string;
  tool_use_id?: string;
  /** "local_agent", "local_bash", … — an older CLI may not say. */
  task_type?: string;
  description?: string;
  /** What a starting agent was told — for one picked back up, the message
   *  that picked it up. */
  prompt?: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
  usage?: { total_tokens: number; tool_uses: number };
  status?: "completed" | "failed" | "stopped";
  /** How it ended, in the CLI's words ("… completed (exit code 0)"). */
  summary?: string;
  output_file?: string;
  patch?: { status?: string; is_backgrounded?: boolean; error?: string };
}

/** The only files a script's page will read: the CLI's own task output. */
export const SCRIPT_OUTPUT = /^\/.*\/tasks\/[A-Za-z0-9_-]+\.output$/;

/** Where a background shell's output goes, as its tool result names it. */
function outputPath(text: string): string | undefined {
  const found = /written to: (\S+?\.output)\b/.exec(text)?.[1];
  return found && SCRIPT_OUTPUT.test(found) ? found : undefined;
}

/** How many shell calls are remembered in case one goes to the background. */
const SHELLS_KEPT = 64;

/** How many announced resumes wait to be named by the agent's first words. */
const PENDING_KEPT = 16;

/** An agent's report as the tool hands it back, without the bookkeeping
 *  the CLI appends for the model (its id for resuming, its usage). */
function agentReport(content: unknown): string {
  return resultText(content)
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .replace(/^agentId:.*$/gm, "")
    .trim();
}

/** Harness tool names that start an agent: Codex's spawn_agent, an ACP
 *  agent's Task / Agent. Codex's other collab calls (wait, close_agent, …)
 *  stay ordinary chips. */
function spawnsAgent(name: string): boolean {
  const n = name.toLowerCase();
  return n === "spawn_agent" || n === "task" || n === "agent";
}

/** The threads a Codex collab call names as its agents. */
function receiverThreads(input: unknown): string[] {
  const ids = (input as { receiverThreadIds?: unknown } | undefined)?.receiverThreadIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** What a Codex collab call last knew of each agent it touched
 *  (agentsStates, keyed by thread), as card changes. */
function collabStates(output: unknown): Array<[string, Partial<Omit<SubagentState, "key">>]> {
  if (!output || typeof output !== "object" || Array.isArray(output)) return [];
  const out: Array<[string, Partial<Omit<SubagentState, "key">>]> = [];
  for (const [thread, value] of Object.entries(output as Record<string, unknown>)) {
    const state = value as { status?: unknown; message?: unknown } | null;
    if (!state || typeof state !== "object" || typeof state.status !== "string") continue;
    const status: SubagentState["status"] | undefined =
      state.status === "completed"
        ? "done"
        : state.status === "errored"
          ? "failed"
          : state.status === "interrupted" || state.status === "shutdown"
            ? "stopped"
            : undefined;
    const message =
      typeof state.message === "string" && state.message.trim() ? state.message.trim() : undefined;
    out.push([
      thread,
      {
        ...(status ? { status } : {}),
        ...(message ? (status ? { result: message } : { activity: message }) : {}),
      },
    ]);
  }
  return out;
}

/** A finished tool call's output as text, when it has any. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output.trim();
  return resultText(output);
}

export type QuestionOutcome = "answered" | "late" | "none";

/** How long a question card may sit unanswered before the CLI gives up on
 *  the hook. A question is a conversation, not a prompt — an hour is the
 *  point past which the session has been abandoned anyway. */
const QUESTION_TIMEOUT_S = 3600;

/** The longest a file-changing tool waits for its prompt's checkpoint. */
const CHECKPOINT_WAIT_MS = 10_000;

/** Read an AskUserQuestion tool input, keeping only what the card renders.
 *  Anything malformed answers `null` and the tool runs untouched. */
function readQuestions(input: unknown): AskQuestions | null {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions = raw.flatMap((q) => {
    const { question, header, options, multiSelect } = (q ?? {}) as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options)) return [];
    const picks = options.flatMap((o) => {
      const { label, description, preview } = (o ?? {}) as Record<string, unknown>;
      if (typeof label !== "string") return [];
      return [
        {
          label,
          description: typeof description === "string" ? description : "",
          ...(typeof preview === "string" ? { preview } : {}),
        },
      ];
    });
    if (picks.length === 0) return [];
    return [
      {
        question,
        header: typeof header === "string" ? header : "",
        options: picks,
        multiSelect: multiSelect === true,
      },
    ];
  });
  return questions.length > 0 ? { questions } : null;
}

class ProjectSession implements ChannelSession {
  status: ProjectStatus = "idle";
  lastSessionId: string | undefined;
  dead = false;

  private readonly session: AgentSession;
  private draftId: string | null = null;
  /** The user pressed stop — the next result reads "stopped", not as an
   *  error (the CLI reports an abort as a diagnostic-soup failure). */
  private interrupted = false;
  /** Sent prompts awaiting their SDK echo, to map event id → chain uuid. */
  private readonly pendingUserEvents: string[] = [];
  /** The user event whose turn the incoming chain uuids belong to. */
  private turnEventId: string | undefined;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** Output tokens this turn has produced so far, across its API calls —
   *  the number under the doodle. Zeroed when a turn starts and ends. */
  private turnOutput = 0;
  /** This turn's call was refused for the account's usage — the CLI says
   *  so on the message (`error`) and in a rate-limit event. Cleared when
   *  the turn's result lands. */
  private limited = false;
  /** When the limit lifts, as the last rate-limit event said. Kept across
   *  turns: the CLI only speaks when the status changes, so a second turn
   *  into the same limit hears nothing new. */
  private limitResetsAt: number | undefined;
  /** File bytes captured by captureBefore, keyed by tool_use_id. */
  private readonly preimages = new Map<string, string | null>();
  /** Each model's running token total as of the last result — the CLI
   *  reports totals, and a turn's models are the ones whose total moved. */
  private readonly modelTotals = new Map<string, number>();
  /** The vault's substitution, when there is a vault (see secrets.ts). */
  private readonly secretFill: SessionExtras["fillSecrets"];
  /** The file checkpoint a changing tool waits for (SessionExtras.beforeTools). */
  private readonly toolBarrier: SessionExtras["beforeTools"];
  /** Background tasks the CLI reports live (a shell run in the background,
   *  a subagent), by kind. They live in the CLI's process, so it stays
   *  while any do. */
  private backgroundTasks: string[] = [];
  /** The subagents this session's turns have started. */
  private readonly agents: AgentBook;
  /** The CLI's task ids for them, to their spawning tool_use ids — task
   *  messages name the tool_use only some of the time. */
  private readonly taskKeys = new Map<string, string>();
  /** Tool calls that speak for a card they did not start — a SendMessage
   *  that picked an agent back up — to that card's key. */
  private readonly aliases = new Map<string, string>();
  /** Agents the CLI says it has picked back up before anything has named
   *  which card they are (a card from before this process, from before
   *  cards kept the CLI's id): the agent's first words name it. */
  private readonly pendingResumes = new Map<string, { useId?: string; prompt?: string }>();
  /** The latest shell calls, by tool_use id, in case the CLI says one has
   *  gone to the background — then its chip becomes a card. */
  private readonly shells = new Map<
    string,
    { event: ToolEvent; command: string; parent?: string; output?: string }
  >();

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    resume?: string,
    resumeAt?: string,
    extras?: SessionExtras,
    /** Fork the resumed session at its tip: the same history, a new file. */
    fork = false,
  ) {
    this.lastSessionId = resume;
    this.secretFill = extras?.fillSecrets;
    this.toolBarrier = extras?.beforeTools;
    this.agents = new AgentBook(project.id, events, () =>
      (extras?.transcript?.() ?? []).filter((e): e is ToolEvent => e.kind === "tool" && !!e.agent),
    );
    this.session = new AgentSession({
      cwd: project.path,
      appName: "ruri",
      parity: "terminal",
      ...(project.model ? { model: project.model } : {}),
      onPermission: this.onPermission,
      ...(extras?.autoAllow ? { permission: { autoAllow: extras.autoAllow } } : {}),
      options: {
        // snapshot files before edits, so a rewind can restore them
        enableFileCheckpointing: true,
        // A subagent's whole conversation, not just its tool calls — what
        // its card opens onto. Its line is the last thing it did; no model
        // is paid to summarise it on a timer (agentProgressSummaries).
        forwardSubagentText: true,
        // AskUserQuestion is a question, not a permission — it has to reach
        // the user in every mode, and bypassPermissions skips canUseTool
        // entirely. A PreToolUse hook fires regardless of mode, and its
        // updatedInput is exactly how the tool receives an answer.
        hooks: {
          PreToolUse: [
            {
              matcher: "AskUserQuestion",
              timeout: QUESTION_TIMEOUT_S,
              hooks: [this.askUserQuestion],
            },
            // Not a decision — a barrier. The diff under a Write or Edit
            // needs the file as it was, and a PreToolUse hook is the one
            // point the CLI is required to wait at before touching it.
            { matcher: "Write|Edit", hooks: [this.captureBefore] },
            // The checkpoint first: nothing that can change a file runs
            // before the tree it would change has been written down.
            { matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", hooks: [this.awaitCheckpoint] },
            // The vault's last moment: the model wrote {{handle}}, the tool
            // is about to run, and this is where the two are reconciled.
            {
              matcher: "Bash|BashOutput|Write|Edit|MultiEdit|NotebookEdit",
              hooks: [this.fillVaultHandles],
            },
          ],
        },
        permissionMode: project.permissionMode ?? DEFAULT_PERMISSION_MODE,
        effort: (project.effort || DEFAULT_EFFORT) as AgentOptions["effort"],
        ...(resume ? { resume } : {}),
        // a rewind resumes truncated at the kept turn's last chain entry,
        // forked so the original chain stays intact on disk
        ...(resume && resumeAt ? { resumeSessionAt: resumeAt, forkSession: true } : {}),
        // a chat forked at its latest exchange: the whole file, then its own way
        ...(resume && !resumeAt && fork ? { forkSession: true } : {}),
        ...extras?.options,
      },
    });
    void this.run();
  }

  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent = false,
    visibleEventId?: string,
  ): void {
    if (silent && visibleEventId) this.pendingUserEvents.push(visibleEventId);
    if (!silent) {
      const id = randomUUID();
      // the SDK echoes the prompt back with its chain uuid; this queue
      // pairs that echo with the transcript event it belongs to
      this.pendingUserEvents.push(id);
      this.pushEvent({
        kind: "user",
        id,
        text,
        ...(attachments?.length ? { attachments } : {}),
        ts: Date.now(),
      });
    }
    this.turnOutput = 0;
    this.setStatus("working");
    this.interrupted = false;
    this.session.send(text, images?.length ? { images } : {});
  }

  interrupt(): void {
    this.interrupted = true;
    void this.session.interrupt().catch(() => {});
  }

  async rewindFiles(uuid: string): Promise<{ canRewind: boolean; error?: string }> {
    try {
      const result = await this.session.rewindFiles(uuid);
      return { canRewind: result.canRewind, ...(result.error ? { error: result.error } : {}) };
    } catch (err) {
      return { canRewind: false, error: errorMessage(err) };
    }
  }

  setModel(model: string): void {
    void this.session.setModel(model).catch(() => {});
  }

  setPermissionMode(mode: PermissionMode): void {
    void this.session.setPermissionMode(mode).catch(() => {});
  }

  /** Effort is a construction-time SDK option — retire; resume carries on. */
  setEffort(): void {
    this.dispose();
  }

  dispose(): void {
    this.dead = true;
    this.session.close();
    this.rejectAllPending();
  }

  respondPermission(requestId: string, allow: boolean, always = false): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    if (allow && always && !pending.suggestions?.length) {
      // No CLI-suggested rule to persist — at least stop asking this session.
      this.session.permissions.allowTool(pending.toolName);
    }
    pending.resolve(
      allow
        ? {
            behavior: "allow",
            ...(always && pending.suggestions?.length ? { updatedPermissions: pending.suggestions } : {}),
          }
        : { behavior: "deny", message: "The user denied this tool use in ruri." },
    );
    this.events.onPermissionResolved(requestId);
    if (this.pending.size === 0 && this.pendingQuestions.size === 0 && this.status === "permission") {
      this.setStatus("working");
    }
    return true;
  }

  /**
   * The model asked the user something. Park the tool call, show the card,
   * and hand the picks back as the tool's own input — `answers` is a field
   * of AskUserQuestion's schema, so the tool reads them and reports them to
   * the model itself. A dismissed card allows the call untouched, which the
   * tool renders as "the user did not answer".
   */
  private askUserQuestion = async (
    input: HookInput,
    _toolUseId: string | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<{ hookSpecificOutput: PreToolUseHookSpecificOutput }> => {
    const allow = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "ruri asked the user",
      } as PreToolUseHookSpecificOutput,
    };
    if (input.hook_event_name !== "PreToolUse") return allow;
    const asked = readQuestions(input.tool_input);
    if (!asked) return allow;

    const requestId = randomUUID();
    const answers = await new Promise<AskAnswers | undefined>((resolve) => {
      const pending: PendingQuestion = { resolve };
      this.pendingQuestions.set(requestId, pending);
      // The CLI drops a hook it has waited too long on and runs the tool
      // without it; the card is still up, so an answer given after this
      // goes out as a prompt rather than into a call nobody is waiting on.
      options?.signal?.addEventListener("abort", () => this.questionWentLate(requestId), { once: true });
      this.setStatus("permission");
      this.events.onPermission({
        requestId,
        projectId: this.project.id,
        toolName: "AskUserQuestion",
        kind: "question",
        input: asked,
        ts: Date.now(),
      });
    });
    if (!answers) return allow;
    return {
      hookSpecificOutput: {
        ...allow.hookSpecificOutput,
        updatedInput: {
          ...(input.tool_input as Record<string, unknown>),
          answers: answers.answers,
          ...(answers.annotations ? { annotations: answers.annotations } : {}),
          ...(answers.response ? { response: answers.response } : {}),
        },
      },
    };
  };

  /** Hold a file-changing tool until the prompt's checkpoint is down — a
   *  few milliseconds at most, nearly always nothing; never longer than
   *  CHECKPOINT_WAIT_MS, since a repository too slow to capture is not a
   *  reason for the turn to stop. */
  private awaitCheckpoint = async (): Promise<{ continue: true }> => {
    const barrier = this.toolBarrier;
    if (barrier) {
      await Promise.race([barrier().catch(() => {}), new Promise((r) => setTimeout(r, CHECKPOINT_WAIT_MS))]);
    }
    return { continue: true };
  };

  /**
   * Put real values behind the vault handles the model wrote, and nothing
   * else: no permission decision, so a filled command is still approved (or
   * not) exactly as an unfilled one would be.
   */
  private fillVaultHandles = async (
    input: HookInput,
  ): Promise<{ continue: true; hookSpecificOutput?: PreToolUseHookSpecificOutput }> => {
    if (input.hook_event_name !== "PreToolUse" || !this.secretFill) return { continue: true };
    const filled = this.secretFill(input.tool_input as Record<string, unknown>);
    if (!filled) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: filled,
      } as PreToolUseHookSpecificOutput,
    };
  };

  /**
   * Stash a file's bytes before the tool rewrites them. Whichever of this
   * hook and the tool_use block arrives first, the pre-image is right: if
   * the hook won, the diff reads it from here; if the block won, its own
   * disk read still beat the write, because the CLI is waiting on us.
   */
  private captureBefore = async (input: HookInput): Promise<{ continue: true }> => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const file = (input.tool_input as { file_path?: unknown } | undefined)?.file_path;
    if (typeof file === "string" && path.isAbsolute(file)) {
      // one turn's worth of edits at most; the turn end clears it
      if (this.preimages.size > 200) this.preimages.clear();
      this.preimages.set(input.tool_use_id, readBefore(file));
    }
    return { continue: true };
  };

  respondQuestion(requestId: string, answers?: AskAnswers): QuestionOutcome {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return "none";
    this.pendingQuestions.delete(requestId);
    pending.resolve(answers);
    this.events.onPermissionResolved(requestId);
    if (this.pending.size === 0 && this.pendingQuestions.size === 0 && this.status === "permission") {
      this.setStatus("working");
    }
    return pending.late ? "late" : "answered";
  }

  /** The tool call behind a card stopped waiting: the card stays, marked,
   *  and an answer to it becomes a prompt. */
  private questionWentLate(requestId: string): void {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || pending.late) return;
    pending.late = true;
    this.events.onQuestionLate(requestId);
  }

  pendingRequests(): string[] {
    return [...this.pending.keys(), ...this.pendingQuestions.keys()];
  }

  private onPermission = (req: YagamiPermissionRequest): Promise<PermissionDecision> => {
    // AskUserQuestion is asked through its card, by the PreToolUse hook
    // above — by the time the call reaches here the user has already
    // answered it or waved it past. Asking a second time, as allow/deny
    // over the raw questions JSON, is a card nobody can act on: there is no
    // decision left to make and the only thing it can do is confuse. So the
    // call goes straight through.
    if (req.toolName === "AskUserQuestion") return Promise.resolve({ behavior: "allow" });
    return new Promise<PermissionDecision>((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, {
        resolve,
        toolName: req.toolName,
        ...(req.suggestions ? { suggestions: req.suggestions } : {}),
      });
      this.setStatus("permission");
      this.events.onPermission({
        requestId,
        projectId: this.project.id,
        toolName: req.toolName,
        input: req.input,
        ...(req.suggestions ? { suggestions: req.suggestions } : {}),
        ts: Date.now(),
      });
      req.signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(requestId)) return;
          this.pending.delete(requestId);
          resolve({ behavior: "deny", message: "aborted" });
          this.events.onPermissionResolved(requestId);
        },
        { once: true },
      );
    });
  };

  private async run(): Promise<void> {
    try {
      for await (const msg of this.session) this.handle(msg);
    } catch (err) {
      // closed on purpose (idle, compaction, a settings change): nothing
      // went wrong, and nothing is said
      if (this.dead) return;
      this.pushEvent({
        kind: "info",
        id: randomUUID(),
        text: `session error: ${errorMessage(err)}`,
        ts: Date.now(),
      });
      this.setStatus("error");
    } finally {
      this.dead = true;
      this.rejectAllPending();
      // the process is gone, and every agent it was running with it
      this.backgroundTasks = [];
      this.agents.settle();
      this.events.onBackground?.(this.project.id);
    }
  }

  hasBackgroundWork(): boolean {
    // the CLI's own count, and the agents' cards besides: a background
    // agent is the one thing it would be worst to cut off
    return this.backgroundTasks.length > 0 || this.agents.anyRunning();
  }

  backgroundWork(): BackgroundWork {
    if (this.dead) return { agents: 0, scripts: 0 };
    // the cards say what they are; the CLI's own set is the floor, for
    // work no card was made for (a workflow, a monitor)
    const cards = this.agents.running();
    const scripts = this.backgroundTasks.filter((type) => type === "local_bash").length;
    return {
      agents: Math.max(cards.agents, this.backgroundTasks.length - scripts),
      scripts: Math.max(cards.scripts, scripts),
    };
  }

  /** A shell call, remembered in case it goes on in the background. */
  private noteShell(block: Record<string, unknown>, event: ToolEvent, parent?: string): void {
    const id = block["id"];
    const input = (block["input"] ?? {}) as Record<string, unknown>;
    const command = field(input, "command");
    if (block["name"] !== "Bash" || typeof id !== "string" || !command) return;
    this.shells.set(id, { event, command, ...(parent ? { parent } : {}) });
    if (this.shells.size > SHELLS_KEPT) this.shells.delete(this.shells.keys().next().value!);
  }

  /** A shell call's result: for one left running, where its output goes. */
  private shellResults(blocks: unknown): void {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks as Array<Record<string, unknown>>) {
      const id = block["type"] === "tool_result" ? block["tool_use_id"] : undefined;
      const shell = typeof id === "string" ? this.shells.get(id) : undefined;
      if (!shell || typeof id !== "string") continue;
      const output = outputPath(resultText(block["content"]));
      if (!output) continue;
      shell.output = output;
      if (this.agents.has(id)) this.agents.update(id, { output });
    }
  }

  /** A shell call the CLI says is running in the background: its chip in
   *  the chat (or in the log of the agent that ran it) becomes a card. */
  private scriptStarted(useId: string, taskId: string, description?: string): void {
    const shell = this.shells.get(useId);
    if (!shell || this.agents.has(useId)) return;
    this.agents.attach(
      {
        ...shell.event,
        agent: {
          key: useId,
          script: true,
          description: description?.trim() || headline(shell.command),
          prompt: shell.command,
          status: "running",
          background: true,
          startedAt: Date.now(),
          agentId: taskId,
          ...(shell.output ? { output: shell.output } : {}),
        },
      },
      shell.parent,
    );
  }

  /** An agent that had ended, picked back up: its card works again. */
  private resumeAgent(key: string, taskId: string, useId: string | undefined, prompt?: string): void {
    this.pendingResumes.delete(taskId);
    this.taskKeys.set(taskId, key);
    if (useId) this.aliases.set(useId, key);
    this.agents.resume(key, prompt, useId ?? taskId);
  }

  /** The card a task message is about, however it names it. */
  private taskKey(msg: TaskMessage): string | undefined {
    const use = msg.tool_use_id;
    if (use && this.agents.has(use)) return use;
    return (use ? this.aliases.get(use) : undefined) ?? this.taskKeys.get(msg.task_id);
  }

  /** A tool_use block as the transcript shows it: its chip, with the patch
   *  or picture it carries — or, for the Agent tool, the agent's card. */
  private toolEvent(block: Record<string, unknown>): ToolEvent {
    const name = typeof block["name"] === "string" ? (block["name"] as string) : "tool";
    const input = (block["input"] ?? {}) as Record<string, unknown>;
    const useId = typeof block["id"] === "string" ? (block["id"] as string) : "";
    if ((name === "Agent" || name === "Task") && useId) return agentCard(useId, input, this.project);
    const image = readImage(name, input);
    const captured = this.preimages.get(useId);
    this.preimages.delete(useId);
    const diff = toolDiff(name, input, this.project, captured);
    return {
      kind: "tool",
      id: randomUUID(),
      name,
      summary: toolSummary(name, input, this.project),
      ...(image ? { image } : {}),
      ...(diff ? { diff } : {}),
      ts: Date.now(),
    };
  }

  /** A subagent's message: what it said and each tool it ran, for its log,
   *  the card's line following its latest tool. It is the turn working
   *  too — a long agent is not a stalled turn. */
  private subagentSaid(parent: string, msg: { message: unknown; subagent_type?: string }): void {
    const blocks =
      (msg.message as { content?: Array<Record<string, unknown> & { type: string }> } | undefined)?.content ??
      [];
    // an agent from an earlier process, or one that had ended, speaking:
    // it has been picked back up, and a resume the CLI announced without
    // naming the card is this one
    this.agents.adopt(parent);
    for (const [taskId, pending] of this.pendingResumes) {
      // not a resume after all: a start the CLI announced before its call
      if (pending.useId !== parent) continue;
      this.pendingResumes.delete(taskId);
      this.taskKeys.set(taskId, parent);
      this.agents.update(parent, { agentId: taskId });
    }
    const pending = this.pendingResumes.entries().next().value;
    if (pending && this.agents.ended(parent)) {
      this.resumeAgent(parent, pending[0], pending[1].useId, pending[1].prompt);
    }
    if (msg.subagent_type) this.agents.update(parent, { type: msg.subagent_type });
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
      .join("");
    if (text.trim()) {
      this.agents.log(parent, { kind: "assistant", id: randomUUID(), text, ts: Date.now() });
      this.agents.update(parent, { activity: headline(unmarked(text)) });
      this.events.onProgress(this.project.id, { chars: text.length });
    }
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const event = this.toolEvent(block);
      if (event.agent) {
        this.agents.start(event, parent);
        continue;
      }
      this.agents.log(parent, event);
      this.noteShell(block, event, parent);
      this.agents.update(parent, { activity: `${event.name} ${event.summary}`.trim() });
      this.events.onProgress(this.project.id, { chars: 1 });
    }
  }

  /** The CLI's own account of a subagent: started (and whether in the
   *  background), how far along, a change of state, its end. Shells and
   *  the rest ride the same messages; only agents with a card are read. */
  private onTask(msg: TaskMessage): void {
    if (msg.subtype === "task_started") {
      // a shell: a card once it is in the background — from the start, or
      // when a long foreground one is sent there (task_updated, below)
      if (msg.task_type === "local_bash") {
        if (!msg.tool_use_id) return;
        this.taskKeys.set(msg.task_id, msg.tool_use_id);
        if (msg.is_backgrounded) this.scriptStarted(msg.tool_use_id, msg.task_id, msg.description);
        return;
      }
      if (msg.tool_use_id && this.agents.has(msg.tool_use_id)) {
        this.taskKeys.set(msg.task_id, msg.tool_use_id);
        this.agents.update(msg.tool_use_id, {
          agentId: msg.task_id,
          ...(msg.subagent_type ? { type: msg.subagent_type } : {}),
          ...(msg.is_backgrounded ? { background: true } : {}),
        });
        return;
      }
      // Not a spawn: an agent that had ended, picked back up (the model
      // messaged it — to carry on after a failure, or with more to do).
      // The CLI keeps its task id and names the call that woke it.
      if (msg.task_type !== undefined && msg.task_type !== "local_agent") return;
      const key = this.taskKeys.get(msg.task_id) ?? this.agents.keyOf(msg.task_id);
      if (key) this.resumeAgent(key, msg.task_id, msg.tool_use_id, msg.prompt);
      else if (msg.task_type === "local_agent") {
        this.pendingResumes.set(msg.task_id, {
          ...(msg.tool_use_id ? { useId: msg.tool_use_id } : {}),
          ...(msg.prompt ? { prompt: msg.prompt } : {}),
        });
        // ones nothing ever named are let go, oldest first
        if (this.pendingResumes.size > PENDING_KEPT)
          this.pendingResumes.delete(this.pendingResumes.keys().next().value!);
      }
      return;
    }
    const key = this.taskKey(msg);
    if (!key) return;
    if (msg.subtype === "task_updated" && msg.patch?.is_backgrounded && this.shells.has(key)) {
      this.scriptStarted(key, msg.task_id);
    }
    const counts = msg.usage ? { tokens: msg.usage.total_tokens, tools: msg.usage.tool_uses } : {};
    if (msg.subtype === "task_progress") {
      this.agents.update(key, counts);
    } else if (msg.subtype === "task_updated") {
      const next = msg.patch?.status;
      const status =
        next === "completed"
          ? "done"
          : next === "failed"
            ? "failed"
            : next === "killed"
              ? "stopped"
              : undefined;
      this.agents.update(key, {
        ...(status ? { status } : {}),
        ...(msg.patch?.is_backgrounded ? { background: true } : {}),
        ...(status === "failed" && msg.patch?.error ? { result: msg.patch.error } : {}),
      });
    } else {
      const status = msg.status === "completed" ? "done" : msg.status === "failed" ? "failed" : "stopped";
      // a script's end is its report: how it exited, and where it all went
      const script = this.agents.isScript(key)
        ? {
            ...(msg.summary ? { result: msg.summary } : {}),
            ...(msg.output_file && SCRIPT_OUTPUT.test(msg.output_file) ? { output: msg.output_file } : {}),
          }
        : {};
      this.agents.update(key, { ...counts, ...script, status });
    }
  }

  private handle(msg: SDKMessage): void {
    if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      if (info.status === "rejected") {
        this.limited = true;
        this.limitResetsAt = info.resetsAt ? info.resetsAt * 1000 : undefined;
      } else this.limitResetsAt = undefined;
      return;
    }
    if (msg.type === "system" && msg.subtype === "background_tasks_changed") {
      // a level, not an edge: the whole live set each time
      this.backgroundTasks = msg.tasks.map((task) => task.task_type);
      this.events.onBackground?.(this.project.id);
      return;
    }
    if (
      msg.type === "system" &&
      (msg.subtype === "task_started" ||
        msg.subtype === "task_progress" ||
        msg.subtype === "task_updated" ||
        msg.subtype === "task_notification")
    ) {
      this.onTask(msg as unknown as TaskMessage);
      return;
    }
    if (msg.type === "system" && msg.subtype === "init") {
      this.lastSessionId = msg.session_id;
      this.events.onSessionId(this.project.id, msg.session_id);
      void this.reportModels();
    } else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
      const event = msg.event as {
        type: string;
        delta?: { type?: string; text?: string; thinking?: string };
      };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        this.draftId ??= randomUUID();
        this.events.onDelta(this.project.id, this.draftId, event.delta.text);
        this.events.onProgress(this.project.id, { chars: event.delta.text.length });
      } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        // thinking is not shown, but it is the model working — a long think
        // with the counter frozen reads like a hang, which is the one thing
        // the working line exists to tell apart from a real one
        this.events.onProgress(this.project.id, { chars: (event.delta.thinking ?? "").length });
      }
    } else if (msg.type === "user" && msg.parent_tool_use_id === null) {
      // The prompt's echo carries its chain uuid — pair it with the queued
      // transcript event; tool results and synthetic messages only extend
      // the running turn's "last" entry.
      const uuid = (msg as { uuid?: string }).uuid;
      if (uuid) {
        const content = (msg.message as { content?: unknown }).content;
        const toolResult =
          Array.isArray(content) &&
          content.some((block) => (block as { type?: string }).type === "tool_result");
        const synthetic = (msg as { isSynthetic?: boolean }).isSynthetic === true;
        if (!toolResult && !synthetic && this.pendingUserEvents.length > 0) {
          this.turnEventId = this.pendingUserEvents.shift()!;
          this.events.onChain(this.project.id, this.turnEventId, "user", uuid);
        }
        if (this.turnEventId) this.events.onChain(this.project.id, this.turnEventId, "last", uuid);
      }
      // An agent's tool_result is its report — and, for one the turn waited
      // on, its end. One left in the background answered "started" here;
      // its end comes as a task notification.
      const blocks = (msg.message as { content?: unknown }).content;
      this.shellResults(blocks);
      if (Array.isArray(blocks)) {
        for (const block of blocks as Array<Record<string, unknown>>) {
          const key = block["type"] === "tool_result" ? block["tool_use_id"] : undefined;
          if (typeof key !== "string" || !this.agents.has(key) || this.agents.isBackground(key)) continue;
          const report = agentReport(block["content"]);
          this.agents.update(key, {
            status: block["is_error"] === true ? "failed" : "done",
            ...(report ? { result: report } : {}),
          });
        }
      }
    } else if (msg.type === "user" && msg.parent_tool_use_id !== null) {
      // an agent's own tool results: where a shell it left running writes
      this.shellResults((msg.message as { content?: unknown }).content);
    } else if (msg.type === "assistant" && msg.parent_tool_use_id !== null) {
      this.subagentSaid(
        msg.parent_tool_use_id,
        msg as unknown as { message: unknown; subagent_type?: string },
      );
    } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      if (msg.error === "rate_limit" || msg.error === "billing_error") this.limited = true;
      const chainUuid = (msg as { uuid?: string }).uuid;
      if (chainUuid && this.turnEventId) {
        this.events.onChain(this.project.id, this.turnEventId, "last", chainUuid);
      }
      // Each main-loop API call's usage tells us how full the context window
      // is right now: everything sent (fresh + cached) plus what came back.
      const usage = (
        msg.message as unknown as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        }
      ).usage;
      if (usage) {
        const tokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.output_tokens ?? 0);
        if (tokens > 0) this.events.onContext(this.project.id, tokens);
        // the call is over, so its output is counted rather than guessed:
        // this replaces whatever the stream estimated for it
        if (usage.output_tokens) {
          this.turnOutput += usage.output_tokens;
          this.events.onProgress(this.project.id, { tokens: this.turnOutput });
        }
      }
      const blocks =
        (msg.message as unknown as { content?: Array<Record<string, unknown> & { type: string }> }).content ??
        [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
        .join("");
      if (text) {
        this.pushEvent({ kind: "assistant", id: this.draftId ?? randomUUID(), text, ts: Date.now() });
      }
      this.draftId = null;
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const event = this.toolEvent(block);
        if (event.agent) this.agents.start(event);
        else {
          this.pushEvent(event);
          this.noteShell(block, event);
        }
      }
    } else if (msg.type === "result") {
      this.lastSessionId = msg.session_id;
      this.events.onSessionId(this.project.id, msg.session_id);
      // the turn is over: a question still up was not waited for — its
      // card stays, and an answer to it goes out as the next prompt
      for (const requestId of [...this.pendingQuestions.keys()]) this.questionWentLate(requestId);
      this.draftId = null;
      this.turnOutput = 0;
      const stopped = this.interrupted;
      this.interrupted = false;
      // The agents this turn waited on are over with it: their reports came
      // back before the result could — or, stopped, they were cut off.
      // Ones in the background (and whatever they started) carry on.
      this.agents.settle(stopped ? "stopped" : "done", (agent, nested) => !agent.background && !nested);
      // A turn the API dropped still comes back as subtype "success" — the
      // CLI finished cleanly, it is the call inside it that did not. The
      // flag that says so is is_error, and reading only the subtype is how
      // an overloaded turn used to sign itself "done".
      const finished = msg.subtype === "success" ? msg : undefined;
      const apiError = finished !== undefined && finished.is_error === true;
      const ok = finished !== undefined && !apiError;
      const status = apiError ? (finished.api_error_status ?? null) : null;
      // the turn's own usage (per turn, main loop) — what the ledger adds up
      const spent = msg.usage as Partial<Usage> | undefined;
      const tokens = usageTokens(spent) ?? 0;
      const cacheRead = spent?.cache_read_input_tokens ?? 0;
      // which models answered this turn: the CLI's per-model usage is a
      // running total for the whole session, so a model counts only when
      // its total moved since the last result
      const usageByModel = ("modelUsage" in msg ? msg.modelUsage : undefined) as
        | Record<
            string,
            {
              inputTokens?: number;
              outputTokens?: number;
              cacheReadInputTokens?: number;
              cacheCreationInputTokens?: number;
            }
          >
        | undefined;
      const models: string[] = [];
      if (usageByModel) {
        for (const [id, u] of Object.entries(usageByModel)) {
          const total =
            (u.inputTokens ?? 0) +
            (u.outputTokens ?? 0) +
            (u.cacheReadInputTokens ?? 0) +
            (u.cacheCreationInputTokens ?? 0);
          if (total > (this.modelTotals.get(id) ?? 0)) models.push(id);
          this.modelTotals.set(id, total);
        }
      }
      // the CLI already said it in full, as a message in the transcript —
      // the line under it only has to name it, so it takes the first sentence
      const failure = apiError
        ? (firstSentence(finished.result) ?? `API error${status ? ` ${status}` : ""}`)
        : "errors" in msg && msg.errors.length > 0
          ? msg.errors.join("; ")
          : msg.subtype;
      const limited = this.limited;
      this.limited = false;
      const blocked = ok || stopped ? undefined : limited ? "limit" : blockedBy(failure, status);
      const known = this.limitResetsAt && this.limitResetsAt > Date.now() ? this.limitResetsAt : undefined;
      const resetsAt = blocked === "limit" ? (known ?? limitResetsAt(failure)) : undefined;
      this.pushEvent({
        kind: "result",
        id: randomUUID(),
        ok: ok || stopped,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        ...(tokens > 0 ? { tokens } : {}),
        ...(cacheRead > 0 ? { cacheRead } : {}),
        ...(models.length > 0 ? { models } : {}),
        ...(stopped ? { stopped: true } : {}),
        ...(ok || stopped ? {} : { error: failure }),
        ...(!ok && !stopped && transientFailure(failure, status) ? { transient: true } : {}),
        ...(blocked ? { blocked } : {}),
        ...(resetsAt ? { resetsAt } : {}),
        ts: Date.now(),
      });
      this.setStatus("idle");
    }
  }

  private async reportModels(): Promise<void> {
    try {
      const models = await this.session.supportedModels();
      this.events.onModels(
        models.map((model) => ({
          value: model.value,
          displayName: model.displayName,
          ...(model.supportedEffortLevels?.length
            ? { reasoningEfforts: model.supportedEffortLevels.map((value) => ({ value })) }
            : {}),
          ...(model.supportsAdaptiveThinking ? { supportsAdaptiveThinking: true } : {}),
          ...(model.supportsFastMode ? { supportsFastMode: true } : {}),
          ...(model.supportsAutoMode ? { supportsAutoMode: true } : {}),
        })),
      );
    } catch (err) {
      warn("sessions", err, "reportModels");
      // model list is a nicety; the picker just stays empty
    }
  }

  private pushEvent(event: TranscriptEvent): void {
    this.events.onEvent(this.project.id, event);
  }

  private setStatus(status: ProjectStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(this.project.id, status);
  }

  private rejectAllPending(): void {
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ behavior: "deny", message: "session ended" });
      this.events.onPermissionResolved(requestId);
    }
    this.pending.clear();
    // An unanswered question just goes unanswered — the tool call is already
    // gone with the session, so there is nothing to deny.
    for (const [requestId, pending] of this.pendingQuestions) {
      pending.resolve(undefined);
      this.events.onPermissionResolved(requestId);
    }
    this.pendingQuestions.clear();
  }
}

/**
 * A session on a non-Claude harness (Codex, OpenCode, …): each turn is one
 * sandboxed provider.run() with resume, streamed into the same event shapes
 * ProjectSession emits. No tool events or permission prompts — those stay
 * inside the harness; the sandbox is the safety boundary instead.
 */
class ProviderTurnSession implements ChannelSession {
  status: ProjectStatus = "idle";
  /** Prefixed "<provider>:<session>", so a Claude resume can never eat it. */
  lastSessionId: string | undefined;
  dead = false;

  private model: string | undefined;
  private effort: string;
  private abort: AbortController | null = null;
  private running = false;
  private readonly backlog: Array<{
    text: string;
    images?: Array<{ data: string; mediaType?: string }>;
  }> = [];

  /** Whether the system block already rode a prompt this app run. Sent on
   *  the first turn even when resuming, so updated instructions reach
   *  sessions that predate them. */
  private sentSystem = false;

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    readonly providerId: string,
    private readonly provider: Provider,
    nativeModel: string | undefined,
    resume: string | undefined,
    private readonly extras?: SessionExtras,
  ) {
    this.model = nativeModel;
    this.effort = project.effort || DEFAULT_EFFORT;
    if (resume?.startsWith(`${providerId}:`)) this.lastSessionId = resume;
  }

  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent = false,
  ): void {
    if (!silent) {
      this.pushEvent({
        kind: "user",
        id: randomUUID(),
        text,
        ...(attachments?.length ? { attachments } : {}),
        ts: Date.now(),
      });
    }
    this.setStatus("working");
    if (this.running) {
      // the harness runs one turn at a time — later sends wait their turn
      this.backlog.push({ text, ...(images ? { images } : {}) });
      return;
    }
    void this.run(text, images);
  }

  private async run(text: string, images?: Array<{ data: string; mediaType?: string }>): Promise<void> {
    this.running = true;
    const started = Date.now();
    const draftId = randomUUID();
    this.abort = new AbortController();
    let acc = "";
    let costUsd: number | undefined;
    let tokens: number | undefined;
    let error: string | undefined;
    let stopped = false;
    try {
      const media: ContentBlockParam[] = (images ?? []).map((img) => ({
        type: "image",
        source: { type: "base64", data: img.data, media_type: img.mediaType ?? "image/png" },
      })) as ContentBlockParam[];
      const resume = this.lastSessionId?.slice(this.providerId.length + 1);
      // system emulation, mirroring yagami's engine: the block prefixes the
      // prompt once, then lives on in the harness's own resumed context
      let prompt = text;
      if (this.extras?.providerSystem && !this.sentSystem) {
        prompt = `<system>\n${this.extras.providerSystem}\n</system>\n\n${text}`;
        this.sentSystem = true;
      }
      for await (const event of this.provider.run({
        prompt,
        ...(media.length ? { media } : {}),
        ...(this.model ? { model: this.model } : {}),
        effort: this.effort,
        ...(resume ? { resume } : {}),
        signal: this.abort.signal,
      })) {
        if (event.type === "session") {
          this.lastSessionId = `${this.providerId}:${event.sessionId}`;
          this.events.onSessionId(this.project.id, this.lastSessionId);
        } else if (event.type === "text") {
          const piece = spaced(acc, event.text);
          acc += piece;
          this.events.onDelta(this.project.id, draftId, piece);
          this.events.onProgress(this.project.id, { chars: piece.length });
        } else if (event.type === "done") {
          costUsd = event.costUsd;
          tokens = usageTokens(event.usage);
          if (event.usage?.output_tokens) {
            this.events.onProgress(this.project.id, { tokens: event.usage.output_tokens });
          }
          reportProviderContext(
            this.events,
            this.project.id,
            this.providerId,
            this.lastSessionId,
            event.usage,
          );
        }
      }
    } catch (err) {
      if (this.abort?.signal.aborted) {
        stopped = true;
      } else if (err instanceof AuthRequiredError) {
        error = `${this.provider.label} needs a sign-in — run: ${this.provider.loginCommand}`;
      } else if (err instanceof ProviderNotInstalledError) {
        error = err.message;
      } else {
        error = errorMessage(err);
      }
    } finally {
      this.abort = null;
    }
    if (acc) this.pushEvent({ kind: "assistant", id: draftId, text: acc, ts: Date.now() });
    // pick up anything the turn dropped for the app (Home's open requests)
    // before the result lands, so the sidebar is current when "done" shows
    try {
      this.extras?.onProviderTurnEnd?.();
    } catch (err) {
      warn("sessions", err, "onProviderTurnEnd");
      // a bad drop file must not kill the turn pipeline
    }
    this.pushEvent({
      kind: "result",
      id: randomUUID(),
      ok: error === undefined,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(tokens ? { tokens } : {}),
      durationMs: Date.now() - started,
      ...(stopped ? { stopped: true } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(error !== undefined && !stopped && transientFailure(error) ? { transient: true } : {}),
      ...(error !== undefined && !stopped ? blockedResult(error) : {}),
      ts: Date.now(),
    });
    this.running = false;
    const next = this.backlog.shift();
    if (next && !this.dead) {
      void this.run(next.text, next.images);
    } else {
      this.setStatus(error === undefined ? "idle" : "error");
    }
  }

  interrupt(): void {
    this.backlog.length = 0;
    this.abort?.abort();
  }

  rewindFiles(): Promise<{ canRewind: boolean; error?: string }> {
    return Promise.resolve({
      canRewind: false,
      error: "this harness keeps no file checkpoints",
    });
  }

  /** The native model for the next turn ("" = the harness's default). */
  setModel(model: string): void {
    this.model = model || undefined;
  }

  setPermissionMode(): void {
    // permission modes are a Claude concept; the harness sandbox stands in
  }

  /** Each turn is its own run — the new effort simply rides the next one. */
  setEffort(effort: string): void {
    this.effort = effort || DEFAULT_EFFORT;
  }

  dispose(): void {
    this.dead = true;
    this.backlog.length = 0;
    this.abort?.abort();
  }

  respondPermission(): boolean {
    return false;
  }

  /** Other harnesses have no AskUserQuestion — nothing ever parks a card. */
  respondQuestion(): QuestionOutcome {
    return "none";
  }

  pendingRequests(): string[] {
    return [];
  }

  private pushEvent(event: TranscriptEvent): void {
    this.events.onEvent(this.project.id, event);
  }

  private setStatus(status: ProjectStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(this.project.id, status);
  }
}

/**
 * The space between two of a harness's messages.
 *
 * A turn's text arrives as bare chunks with no marker where one message
 * ends and the next begins, and the chunks carry their own leading spaces —
 * so a chunk that opens a sentence immediately after a full stop is the
 * start of a new message, and needs the space the stream never sent. That
 * is what ran "…end to end." and "I found the app's own instructions" into
 * one word.
 */
function spaced(acc: string, chunk: string): string {
  if (acc === "" || chunk === "") return chunk;
  const ended = /[.!?…]["'\u201d\u2019)\]]?$/.test(acc);
  // an uppercase opener only: "3" after "3." is a decimal, not a sentence
  return ended && /^[A-Z]/.test(chunk) ? ` ${chunk}` : chunk;
}

/**
 * A non-Claude turn's context occupancy.
 *
 * Every harness reports what its last call spent, and for these the prompt
 * count already includes what was cached — so the occupancy is simply what
 * went in plus what came back, not Claude's sum-of-four. Codex additionally
 * writes the authoritative numbers (and the model's real window) into its
 * session rollout, which is where the accurate reading comes from when one
 * is there.
 */
function reportProviderContext(
  events: SessionEvents,
  projectId: string,
  providerId: string,
  sessionId: string | undefined,
  usage: Usage | undefined,
): void {
  if (providerId === "codex" && sessionId?.startsWith("codex:")) {
    const counts = readCodexCounts(sessionId.slice("codex:".length));
    if (counts?.tokens) {
      events.onContext(projectId, counts.tokens, counts.window);
      return;
    }
  }
  if (!usage) return;
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (tokens > 0) events.onContext(projectId, tokens);
}

/**
 * Harness tool names in ruri's own vocabulary, so a chip reads the same
 * whoever ran it: Codex's "shell" is a Bash chip and an ACP agent's
 * "read_file" is a Read, exactly as Claude's would be. An unrecognised name
 * keeps its own, capitalised.
 */
const TOOL_ALIASES: Record<string, string> = {
  shell: "Bash",
  bash: "Bash",
  exec: "Bash",
  execute: "Bash",
  execute_command: "Bash",
  run_command: "Bash",
  terminal: "Bash",
  read: "Read",
  read_file: "Read",
  read_text_file: "Read",
  view: "Read",
  open: "Read",
  write: "Write",
  write_file: "Write",
  write_text_file: "Write",
  create_file: "Write",
  edit: "Edit",
  edit_file: "Edit",
  apply_patch: "Edit",
  patch: "Edit",
  str_replace: "Edit",
  str_replace_editor: "Edit",
  update_file: "Edit",
  multiedit: "Edit",
  search: "Grep",
  grep: "Grep",
  ripgrep: "Grep",
  search_file_content: "Grep",
  codebase_search: "Grep",
  glob: "Glob",
  find: "Glob",
  ls: "Glob",
  list_directory: "Glob",
  web_search: "WebSearch",
  websearch: "WebSearch",
  search_web: "WebSearch",
  fetch: "WebFetch",
  web_fetch: "WebFetch",
  browse: "WebFetch",
  update_plan: "Plan",
  plan: "Plan",
  todo: "Plan",
  todowrite: "Plan",
  spawn_agent: "Agent",
  send_input: "Agent",
  resume_agent: "Agent",
  close_agent: "Agent",
  send_message: "Agent",
  followup_task: "Agent",
  interrupt_agent: "Agent",
  list_agents: "Agent",
};

function ruriToolName(name: string): string {
  const alias = TOOL_ALIASES[name.toLowerCase()];
  if (alias) return alias;
  return name.length > 0 ? `${name[0]!.toUpperCase()}${name.slice(1)}` : "Tool";
}

/** One file inside a harness's patch call (Codex sends these as `changes`). */
interface PatchChange {
  path?: unknown;
  kind?: { type?: unknown } | unknown;
  diff?: unknown;
  content?: unknown;
}

/** A transcript chip a provider tool call earns — the same shape a Claude
 *  tool_use block produces, patch and image preview included. */
interface ProviderChip {
  name: string;
  summary: string;
  diff?: FileDiff;
  image?: { url: string; name: string };
}

function clip(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/**
 * A provider tool_call, shaped for ruri transcript chips — one per file when
 * the call patches several.
 *
 * The patch comes from the call itself wherever the harness hands one over
 * (Codex's apply_patch carries a unified diff per file, so there is nothing
 * to compute and no race with the write); otherwise it is built the way a
 * Claude tool_use block's is, off the file's current bytes.
 */
function providerToolEvents(
  ev: Extract<AgentEvent, { type: "tool_call" }>,
  project: Project,
): ProviderChip[] {
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const changes = input["changes"];
  if (Array.isArray(changes) && changes.length > 0) {
    const chips = (changes as PatchChange[]).flatMap((change) => {
      const file = typeof change.path === "string" ? change.path : undefined;
      if (!file) return [];
      const type = (change.kind as { type?: unknown } | undefined)?.type;
      const created = type === "add";
      const name = created ? "Write" : type === "delete" ? "Delete" : "Edit";
      const display = shortenPaths(file, project);
      const patch = typeof change.diff === "string" ? change.diff : undefined;
      const whole = typeof change.content === "string" ? change.content : undefined;
      const diff = patch
        ? parseUnifiedDiff(display, patch, { created })
        : whole !== undefined
          ? buildDiff(display, created ? null : readBefore(file), whole)
          : null;
      return [{ name, summary: clip(display), ...(diff ? { diff } : {}) }];
    });
    if (chips.length > 0) return chips;
  }

  const name = ruriToolName(ev.name);
  const summary = clip(
    shortenPaths(ev.title ?? (ev.input !== undefined ? JSON.stringify(ev.input) : ""), project),
  );
  const diff = toolDiff(name, input, project);
  const image = readImage(name, input);
  return [{ name, summary, ...(diff ? { diff } : {}), ...(image ? { image } : {}) }];
}

/**
 * ruri's permission mode in the terms the harness itself speaks.
 *
 * It is not a Claude-only idea — yagami exposes each harness's own knob and
 * ruri simply never set it, so every non-Claude session ran at whatever its
 * config defaulted to with no way to say otherwise.
 *
 * Codex takes a sandbox level. It has three where ruri has four, so "ask
 * first" and "accept edits" both land on workspace-write; ruri's permission
 * handler supplies the fourth distinction by auto-accepting edit requests.
 *
 * ACP agents take one of their own mode ids. Claude's ACP agent uses exactly
 * these names; other agents name theirs differently and yagami drops a mode
 * it does not recognise, which leaves the harness on its own default — the
 * behaviour ruri had before, so an unknown agent is never worse off.
 */
function nativePermissions(providerId: string, mode: PermissionMode): Record<string, unknown> {
  if (providerId === "codex") {
    const sandbox =
      mode === "plan" ? "read-only" : mode === "bypassPermissions" ? "danger-full-access" : "workspace-write";
    return {
      sandbox,
      // Bypass means the same thing in every composer: do not leave the
      // harness's own approval policy behind to ask a second time.
      ...(mode === "bypassPermissions" ? { approvalPolicy: "never" } : {}),
    };
  }
  return { mode };
}

function autoProviderDecision(
  mode: PermissionMode,
  req: SessionPermissionRequest,
): SessionPermissionDecision | undefined {
  if (mode === "bypassPermissions") return "allow_always";
  const mutating =
    req.kind === "edit" || /^(?:apply_patch|edit|write|multiedit|notebookedit)$/i.test(req.tool);
  if (mode === "acceptEdits" && mutating) return "allow";
  if (mode === "plan" && (mutating || req.kind === "delete" || req.kind === "move")) return "deny";
  return undefined;
}

function inputHeader(label: string, fallback: string): string {
  const short = label.trim();
  return short.length > 0 && short.length <= 12 ? short : fallback.slice(0, 12);
}

/** Turn yagami's typed input contract into the durable question-box shape. */
function providerInputQuestions(request: SessionInputRequest): AskQuestions {
  if (request.kind === "url") {
    return {
      questions: [
        {
          id: "__url",
          question: request.message,
          header: inputHeader(request.source ?? "Continue", "Continue"),
          options: [
            {
              label: "I've finished",
              value: "done",
              description: "Continue after completing the linked step",
            },
          ],
          multiSelect: false,
          required: true,
          allowOther: false,
          ...(request.url ? { url: request.url } : {}),
        },
      ],
    };
  }
  const fields = request.fields ?? [];
  return {
    questions: fields.map((field) => {
      const options =
        field.options ??
        (field.type === "boolean"
          ? [
              { label: "Yes", value: "true" },
              { label: "No", value: "false" },
            ]
          : []);
      return {
        id: field.id,
        question: field.label,
        header: inputHeader(field.label, request.kind === "form" ? "Details" : "Question"),
        options: options.map((option) => ({
          label: option.label,
          value: option.value,
          description: option.description ?? "",
        })),
        multiSelect: field.type === "multiselect",
        inputType: field.type,
        required: field.required,
        secret: field.secret,
        minimum: field.minimum,
        maximum: field.maximum,
        minLength: field.minLength,
        maxLength: field.maxLength,
        default: field.default,
        allowOther:
          field.allowOther ??
          (field.type === "string" || field.type === "number" || field.type === "integer"),
        ...(field.description ? { hint: field.description } : {}),
      };
    }),
  };
}

/** Restore typed provider values from what the question box submitted. */
function providerInputResponse(
  request: SessionInputRequest,
  questions: AskQuestions,
  answers: AskAnswers | undefined,
): SessionInputResponse {
  if (!answers) return { action: "decline" };
  if (request.kind === "url") return { action: "accept" };
  const values: Record<string, SessionInputValue> = {};
  for (const field of request.fields ?? []) {
    const question = questions.questions.find((candidate) => candidate.id === field.id);
    const exact = answers.values?.[field.id];
    const flattened = question ? answers.answers[question.question] : undefined;
    const raw = exact ?? (flattened ? [flattened] : []);
    if (question && questionError(question, raw)) return { action: "decline" };
    if (raw.length === 0) continue;
    if (field.type === "multiselect") {
      values[field.id] = raw;
    } else if (field.type === "boolean") {
      values[field.id] = raw[0] === "true";
    } else if (field.type === "number" || field.type === "integer") {
      const number = Number(raw[0]);
      if (Number.isFinite(number)) values[field.id] = number;
    } else {
      values[field.id] = raw[0] ?? "";
    }
  }
  return { action: "accept", values };
}

/**
 * A session on a non-Claude harness that supports yagami's agentic session
 * layer (Codex via app-server, every ACP agent): the harness runs VERBATIM —
 * its own config, sandbox, and approval flow — warm across turns, with tool
 * calls streamed as transcript chips and approval requests surfaced as ruri
 * permission cards ("Always allow" maps to the harness's own
 * approve-for-session answer).
 */
class ProviderAgentSession implements ChannelSession {
  status: ProjectStatus = "idle";
  /** Prefixed "<provider>:<session>", so a Claude resume can never eat it. */
  lastSessionId: string | undefined;
  dead = false;

  private readonly session: ProviderSession;
  private nativeModel: string | undefined;
  private running = false;
  private readonly backlog: Array<{
    text: string;
    images?: Array<{ data: string; mediaType?: string }>;
    eventId?: string;
  }> = [];
  /** Visible prompt whose provider turns belong to. Silent split turns keep
   * extending its `last` chain point without inventing transcript prompts. */
  private lastTurnEventId: string | undefined;
  private readonly pending = new Map<string, { resolve(d: SessionPermissionDecision): void }>();
  private readonly pendingInputs = new Map<string, PendingProviderInput>();
  /** ACP can't take a system prompt natively — the first turn of each app
   *  run carries it as a <system> block (codex gets developerInstructions). */
  private sentSystem = false;
  /** The mode this session was opened with; changing it rebuilds. */
  private permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE;
  /** The subagents this session's turns have started (Codex's spawn_agent,
   *  an ACP agent's Task). */
  private readonly agents: AgentBook;
  /** A spawned agent's thread, to its card's key. */
  private readonly threadKeys = new Map<string, string>();
  /** A thread's work that came before the call that spawned it said which
   *  thread it was — held until it does. */
  private readonly strays = new Map<string, AgentEvent[]>();

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    readonly providerId: string,
    provider: SessionProvider,
    nativeModel: string | undefined,
    resume: string | undefined,
    resumeAt: string | undefined,
    private readonly extras?: SessionExtras,
    fork = false,
  ) {
    this.nativeModel = nativeModel;
    this.agents = new AgentBook(project.id, events);
    if (resume?.startsWith(`${providerId}:`)) this.lastSessionId = resume;
    const nativeResume = this.lastSessionId?.slice(providerId.length + 1);
    this.permissionMode = project.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.session = provider.openSession({
      cwd: project.path,
      appName: "ruri",
      ...(nativeModel ? { model: nativeModel } : {}),
      effort: project.effort || DEFAULT_EFFORT,
      ...(nativeResume ? { resume: nativeResume } : {}),
      ...(nativeResume && provider.sessionCapabilities.fork && resumeAt ? { forkAt: resumeAt } : {}),
      ...(nativeResume && provider.sessionCapabilities.fork && !resumeAt && fork ? { fork: true } : {}),
      ...(extras?.providerSystem ? { systemPrompt: extras.providerSystem } : {}),
      native: nativePermissions(providerId, this.permissionMode),
      permissions: { decide: (req, signal) => this.decide(req, signal) },
      input: { respond: (req, signal) => this.requestInput(req, signal) },
    });
  }

  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent = false,
    visibleEventId?: string,
  ): void {
    let eventId = visibleEventId;
    if (!silent) {
      eventId = randomUUID();
      this.pushEvent({
        kind: "user",
        id: eventId,
        text,
        ...(attachments?.length ? { attachments: attachments } : {}),
        ts: Date.now(),
      });
    }
    this.setStatus("working");
    if (this.running) {
      this.backlog.push({ text, ...(images ? { images } : {}), ...(eventId ? { eventId } : {}) });
      return;
    }
    void this.run(text, images, eventId);
  }

  private async run(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    eventId?: string,
  ): Promise<void> {
    if (eventId) this.lastTurnEventId = eventId;
    const turnEventId = eventId ?? this.lastTurnEventId;
    this.running = true;
    const started = Date.now();
    let draftId = randomUUID();
    let acc = "";
    let costUsd: number | undefined;
    let tokens: number | undefined;
    let error: string | undefined;
    let interrupted = false;
    let planEventId: string | undefined;
    const toolsSeen = new Set<string>();
    // What the harness said before its next tool call is what it said ABOUT
    // that call, so it lands in the transcript first. Text is banked into an
    // assistant event at every tool boundary rather than pooled into one
    // block at the end of the turn — which is what put a turn's whole
    // narration under a stack of chips it came before.
    const bankText = () => {
      if (acc === "") return;
      this.pushEvent({ kind: "assistant", id: draftId, text: acc, ts: Date.now() });
      acc = "";
      draftId = randomUUID();
    };
    try {
      let prompt = text;
      if (this.extras?.providerSystem && this.providerId !== "codex" && !this.sentSystem) {
        prompt = `<system>\n${this.extras.providerSystem}\n</system>\n\n${text}`;
        this.sentSystem = true;
      }
      const input: string | ContentBlockParam[] = images?.length
        ? ([
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", data: img.data, media_type: img.mediaType ?? "image/png" },
            })),
            { type: "text", text: prompt },
          ] as ContentBlockParam[])
        : prompt;
      for await (const event of this.session.send(input)) {
        // a subagent's own work, tagged with its thread (Codex)
        const thread = (event as { thread?: unknown }).thread;
        if (typeof thread === "string") {
          this.subagentEvent(thread, event);
          continue;
        }
        if (event.type === "session") {
          this.lastSessionId = `${this.providerId}:${event.sessionId}`;
          this.events.onSessionId(this.project.id, this.lastSessionId);
        } else if (event.type === "turn") {
          if (turnEventId) {
            if (eventId) this.events.onChain(this.project.id, turnEventId, "user", event.id);
            this.events.onChain(this.project.id, turnEventId, "last", event.id);
          }
        } else if (event.type === "text") {
          const piece = spaced(acc, event.text);
          acc += piece;
          this.events.onDelta(this.project.id, draftId, piece);
          this.events.onProgress(this.project.id, { chars: piece.length });
        } else if (event.type === "thinking") {
          this.events.onProgress(this.project.id, { chars: event.text.length });
          // the harness stopped to think, so whatever it was saying is said:
          // the next message starts its own block rather than running on
          bankText();
        } else if (event.type === "tool_call") {
          // what a collab call knows of the agents it touched (Codex's wait
          // and close_agent answer with their states and last messages)
          for (const [agentThread, patch] of collabStates(event.output)) {
            const key = this.threadKeys.get(agentThread);
            if (key) this.agents.update(key, patch);
          }
          if (spawnsAgent(event.name)) {
            if (!this.agents.has(event.id)) {
              bankText();
              const title = event.title && event.title !== event.name ? event.title : undefined;
              this.agents.start(
                agentCard(event.id, (event.input ?? {}) as Record<string, unknown>, this.project, title),
              );
            }
            const receivers = receiverThreads(event.input);
            for (const receiver of receivers) this.adoptThread(receiver, event.id);
            if (event.status === "failed") {
              this.agents.update(event.id, { status: "failed" });
            } else if (event.status === "completed" && receivers.length === 0) {
              // an agent that runs inside its call (an ACP agent's Task)
              // ends with it; a Codex spawn only started one
              const report = outputText(event.output);
              this.agents.update(event.id, { status: "done", ...(report ? { result: report } : {}) });
            }
            continue;
          }
          if (event.status !== "started" || toolsSeen.has(event.id)) continue;
          toolsSeen.add(event.id);
          bankText();
          for (const chip of providerToolEvents(event, this.project)) {
            this.pushEvent({ kind: "tool", id: randomUUID(), ...chip, ts: Date.now() });
          }
        } else if (event.type === "plan") {
          bankText();
          planEventId ??= randomUUID();
          this.pushEvent({ ...event.plan, kind: "plan", id: planEventId, ts: Date.now() });
        } else if (event.type === "done") {
          costUsd = event.costUsd;
          tokens = usageTokens(event.usage);
          if (event.usage?.output_tokens) {
            this.events.onProgress(this.project.id, { tokens: event.usage.output_tokens });
          }
          interrupted = event.stopReason === "interrupted";
          this.reportContext(event.usage);
        }
      }
    } catch (err) {
      // A failed transport cannot be reused for recovery. The manager
      // rebuilds it on the next send with the last persisted conversation ID.
      this.dead = true;
      void this.session.close();
      if (err instanceof AuthRequiredError) {
        error = err.message;
      } else if (err instanceof ProviderNotInstalledError) {
        error = err.message;
      } else {
        error = errorMessage(err);
      }
    }
    this.rejectPending();
    bankText();
    // pick up anything the turn dropped for the app (Home's open requests)
    try {
      this.extras?.onProviderTurnEnd?.();
    } catch (err) {
      warn("sessions", err, "onProviderTurnEnd");
      // a bad drop file must not kill the turn pipeline
    }
    this.pushEvent({
      kind: "result",
      id: randomUUID(),
      ok: error === undefined,
      ...(costUsd !== undefined ? { costUsd } : {}),
      ...(tokens ? { tokens } : {}),
      durationMs: Date.now() - started,
      ...(error !== undefined ? { error } : interrupted ? { stopped: true } : {}),
      ...(error !== undefined && transientFailure(error) ? { transient: true } : {}),
      ...(error !== undefined ? blockedResult(error) : {}),
      ts: Date.now(),
    });
    this.running = false;
    const next = this.backlog.shift();
    if (next && !this.dead) {
      void this.run(next.text, next.images, next.eventId);
    } else {
      this.setStatus(error === undefined ? "idle" : "error");
    }
  }

  /** What this turn left in the window, for the context dragon. */
  private reportContext(usage: Usage | undefined): void {
    reportProviderContext(this.events, this.project.id, this.providerId, this.lastSessionId, usage);
  }

  /** The harness asked to do something — show ruri's permission card. */
  private decide(req: SessionPermissionRequest, signal?: AbortSignal): Promise<SessionPermissionDecision> {
    if (signal?.aborted) return Promise.resolve("deny");
    const automatic = autoProviderDecision(this.permissionMode, req);
    if (automatic) return Promise.resolve(automatic);
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const cancel = () => this.respondPermission(requestId, false);
      signal?.addEventListener("abort", cancel, { once: true });
      this.pending.set(requestId, {
        resolve: (decision) => {
          signal?.removeEventListener("abort", cancel);
          resolve(decision);
        },
      });
      this.events.onPermission({
        requestId,
        projectId: this.project.id,
        toolName: req.tool,
        input: req.input ?? (req.title ? { request: req.title } : {}),
        ts: Date.now(),
      });
      this.setStatus("permission");
    });
  }

  /** A native harness question or MCP/ACP elicitation uses the same durable
   * question channel as Claude's AskUserQuestion, but answers its typed field
   * ids rather than rewriting the user's picks into a prompt. */
  private requestInput(req: SessionInputRequest, signal?: AbortSignal): Promise<SessionInputResponse> {
    if (signal?.aborted) return Promise.resolve({ action: "cancel" });
    const questions = providerInputQuestions(req);
    // Unknown MCP schema constructs cannot be answered faithfully. Declining
    // is safer than presenting an empty card that can never be submitted.
    if (questions.questions.length === 0) return Promise.resolve({ action: "decline" });
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const cancel = () => {
        const pending = this.pendingInputs.get(requestId);
        if (!pending) return;
        this.pendingInputs.delete(requestId);
        pending.resolve({ action: "cancel" });
        this.events.onPermissionResolved(requestId);
        if (this.running && this.pending.size === 0 && this.pendingInputs.size === 0)
          this.setStatus("working");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.pendingInputs.set(requestId, {
        resolve: (response) => {
          signal?.removeEventListener("abort", cancel);
          resolve(response);
        },
        request: req,
        questions,
      });
      this.events.onPermission({
        requestId,
        projectId: this.project.id,
        toolName: req.kind === "questions" ? "AskUserQuestion" : (req.source ?? "Input request"),
        kind: "question",
        input: questions,
        ts: Date.now(),
      });
      this.setStatus("permission");
    });
  }

  respondQuestion(requestId: string, answers?: AskAnswers): QuestionOutcome {
    const pending = this.pendingInputs.get(requestId);
    if (!pending) return "none";
    this.pendingInputs.delete(requestId);
    pending.resolve(providerInputResponse(pending.request, pending.questions, answers));
    this.events.onPermissionResolved(requestId);
    if (this.running && this.pending.size === 0 && this.pendingInputs.size === 0) {
      this.setStatus("working");
    }
    return "answered";
  }

  respondPermission(requestId: string, allow: boolean, always = false): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(allow ? (always ? "allow_always" : "allow") : "deny");
    this.events.onPermissionResolved(requestId);
    if (this.running && this.pending.size === 0 && this.pendingInputs.size === 0) this.setStatus("working");
    return true;
  }

  pendingRequests(): string[] {
    return [...this.pending.keys(), ...this.pendingInputs.keys()];
  }

  private rejectPending(): void {
    for (const [requestId, pending] of this.pending) {
      pending.resolve("deny");
      this.events.onPermissionResolved(requestId);
    }
    this.pending.clear();
    for (const [requestId, pending] of this.pendingInputs) {
      pending.resolve({ action: "cancel" });
      this.events.onPermissionResolved(requestId);
    }
    this.pendingInputs.clear();
  }

  interrupt(): void {
    this.backlog.length = 0;
    this.rejectPending();
    void this.session.interrupt();
  }

  rewindFiles(): Promise<{ canRewind: boolean; error?: string }> {
    return Promise.resolve({
      canRewind: false,
      error: "this harness keeps no file checkpoints",
    });
  }

  /** A model change re-opens the session on the same thread via resume. */
  setModel(model: string): void {
    if ((model || undefined) === this.nativeModel) return;
    this.nativeModel = model || undefined;
    this.dead = true;
    void this.session.close();
  }

  /**
   * Both harnesses take their mode when the session opens — Codex's sandbox
   * is a session override and ACP's setSessionMode runs right after
   * newSession — so a change retires this session and the next send rebuilds
   * it with resume, exactly as an effort change does.
   */
  setPermissionMode(mode: PermissionMode): void {
    if (mode === this.permissionMode) return;
    this.permissionMode = mode;
    this.dead = true;
    void this.session.close();
  }

  /** Effort is fixed at session open — retire; the rebuild resumes the thread. */
  setEffort(): void {
    this.dead = true;
    void this.session.close();
  }

  hasBackgroundWork(): boolean {
    return this.agents.anyRunning();
  }

  backgroundWork(): BackgroundWork {
    return this.dead ? { agents: 0, scripts: 0 } : this.agents.running();
  }

  dispose(): void {
    this.dead = true;
    this.backlog.length = 0;
    this.rejectPending();
    void this.session.close();
    this.agents.settle();
  }

  /** A spawned agent's thread is known: its card's, and anything it did
   *  before that was known goes to its log now. */
  private adoptThread(thread: string, key: string): void {
    this.threadKeys.set(thread, key);
    const held = this.strays.get(thread);
    this.strays.delete(thread);
    for (const event of held ?? []) this.subagentEvent(thread, event);
  }

  /** A subagent's own work — its thread's messages and tool calls — for its
   *  log, the card's line following its latest tool. */
  private subagentEvent(thread: string, event: AgentEvent): void {
    const key = this.threadKeys.get(thread);
    if (!key) {
      const held = this.strays.get(thread) ?? [];
      if (held.length < 200) held.push(event);
      this.strays.set(thread, held);
      return;
    }
    if (event.type === "text") {
      if (!event.text.trim()) return;
      this.agents.log(key, { kind: "assistant", id: randomUUID(), text: event.text, ts: Date.now() });
      this.agents.update(key, { activity: headline(unmarked(event.text)) });
      this.events.onProgress(this.project.id, { chars: event.text.length });
    } else if (event.type === "tool_call" && event.status === "started") {
      for (const chip of providerToolEvents(event, this.project)) {
        this.agents.log(key, { kind: "tool", id: randomUUID(), ...chip, ts: Date.now() });
        this.agents.update(key, { activity: `${chip.name} ${chip.summary}`.trim() });
      }
      this.events.onProgress(this.project.id, { chars: 1 });
    }
  }

  private pushEvent(event: TranscriptEvent): void {
    this.events.onEvent(this.project.id, event);
  }

  private setStatus(status: ProjectStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(this.project.id, status);
  }
}

/** The first sentence of a message, for a line that has room for one.
 *  ("API Error: 529 Overloaded. This is a server-side issue, …" → the half
 *  of it that says what happened.) */
function firstSentence(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const stop = trimmed.search(/[.!?](?:\s|$)/);
  return stop > 0 ? trimmed.slice(0, stop) : trimmed.slice(0, 200);
}

/**
 * Failures that are the wire's fault rather than the conversation's: the
 * API was overloaded, a gateway fell over, a socket was cut. Sending the
 * same turn again a moment later is a real answer to every one of them.
 *
 * Deliberately narrow. A usage limit is also a "429", and waiting fifteen
 * seconds is not an answer to it — the window resets in hours, and a retry
 * loop against it just burns the account's remaining requests. Same for a
 * bad key, a refusal, a tool that threw: nothing about those changes on a
 * second attempt, so they are left to the user.
 */
const TRANSIENT =
  /\b5\d\d\b|overloaded|service unavailable|bad gateway|gateway time-?out|internal server error|stream (?:error|closed)/i;
/** Limits and refusals wear transient-looking words but are not transient. */
const NOT_TRANSIENT =
  /usage limit|rate limit|quota|credit|insufficient|out of (?:credits|tokens)|invalid api key|unauthorized|forbidden|authentication/i;

/** Whether a failed turn's error reads like something worth simply redoing.
 *  `status` is the HTTP status when the harness names one (Claude does). */
function transientFailure(text: string | undefined, status?: number | null): boolean {
  if (typeof status === "number") return status >= 500 && status < 600;
  if (!text || NOT_TRANSIENT.test(text)) return false;
  // a connection that dropped is the plainest blip of all (server/blocked.ts)
  return TRANSIENT.test(text) || NETWORK.test(text);
}

/** A provider turn's failure, read for what it was up against — the words
 *  are all a provider harness gives. */
function blockedResult(error: string): { blocked?: "network" | "limit"; resetsAt?: number } {
  const blocked = blockedBy(error);
  const resetsAt = blocked === "limit" ? limitResetsAt(error) : undefined;
  return { ...(blocked ? { blocked } : {}), ...(resetsAt ? { resetsAt } : {}) };
}

/** A harness's usage report as one number: everything sent, everything back. */
function usageTokens(usage: Partial<Usage> | undefined): number | undefined {
  if (!usage) return undefined;
  const total =
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  return total > 0 ? total : undefined;
}

/** The non-Claude provider id a live session runs on, if any. */
function providerSessionId(session: ChannelSession): string | undefined {
  if (session instanceof ProviderTurnSession || session instanceof ProviderAgentSession) {
    return session.providerId;
  }
  return undefined;
}

/**
 * When a chat's agent process closes.
 *
 * Every chat that has been prompted can hold a warm CLI process — 150 to
 * 400 MB of `claude`, `codex app-server` or an ACP agent, plus whatever MCP
 * servers that process started. A process is only worth keeping for what it
 * is about to do, so it closes the moment there is nothing left for it: the
 * turn over, nothing of its own still running in the background, and nobody
 * with the chat open to type the next prompt. REAP_GRACE_MS is the moment —
 * long enough for a queued prompt, an auto-retry, or the CLI's own
 * follow-up turn (a background agent reporting back) to claim it first.
 *
 * Work in the background (a subagent, a shell the model left running) lives
 * in the process, so it holds the process for as long as it runs; the
 * session says when that changes, and the moment the last of it ends the
 * same rule applies. A chat that is open keeps its process until it is left
 * — or until it has sat idle IDLE_REAP_MS, a window left open on a chat
 * overnight. The next prompt resumes the same conversation from its session
 * id, exactly as after a relaunch, for a second or two of startup.
 *
 * "Open" means open in a window someone is looking at. A warm CLI is not
 * free to keep: idle, having done nothing for minutes, `claude` still holds
 * its 200-odd MB and still asks for the CPU often enough that macOS names
 * ruri as using significant energy. Nobody is about to type the next prompt
 * into a window that is behind another app, so a chat open only in sleeping
 * windows gets ASLEEP_REAP_MS — long enough that switching away for a
 * moment costs nothing, short enough that walking away from the machine
 * stops costing the battery.
 */
const REAP_GRACE_MS = Number(process.env["RURI_REAP_GRACE_MS"]) || 3000;
const ASLEEP_REAP_MS = Number(process.env["RURI_ASLEEP_REAP_MS"]) || 60_000;
const IDLE_REAP_MS = Number(process.env["RURI_IDLE_REAP_MS"]) || 10 * 60_000;

export class SessionManager {
  private readonly sessions = new Map<string, ChannelSession>();
  /** Per channel: the timer that closes its process once it has idled. */
  private readonly reapTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Changes a chat made while its turn was running. A model, effort or mode
   * pick is never applied to a turn in flight — a warm session would be
   * retired under it, and even a live model swap would change the model
   * halfway through a reply — so it waits here, keyed by channel, and lands
   * the moment the session reports idle. The store already holds the pick,
   * so a session that dies instead of idling rebuilds on it anyway.
   */
  private readonly deferred = new Map<string, Array<() => void>>();
  private readonly events: SessionEvents;
  /** What an unset model means — the crowned default, else the built-in. */
  private defaultModelFor: () => string = () => DEFAULT_MODEL;
  /** Whether something still wants a channel's process between turns — the
   *  chat open in a window, a prompt queued behind the turn, a retry
   *  waiting to go (the server's to say). */
  private keepWarm: (projectId: string) => boolean = () => false;
  /** Whether a channel is open only in windows that have gone to sleep:
   *  held, but on the short lease rather than the long one. */
  private dozing: (projectId: string) => boolean = () => false;

  constructor(
    events: SessionEvents,
    /** Where to find the resumable session id for a project (the archive). */
    private readonly resumeFor: (projectId: string) => string | undefined = () => undefined,
    /** Per-project session extras (the Home agent's MCP tools and prompt). */
    private readonly extrasFor: (project: Project) => SessionExtras | undefined = () => undefined,
    /** Non-Claude harness support; omitted = Claude-only. */
    private readonly providers?: ProviderHooks,
    /** A pending rewind's fork point, claimed when a Claude session builds
     *  (the archive's take-once resumeAt). */
    private readonly resumeAtFor: (projectId: string) => string | undefined = () => undefined,
    /** A pending tip fork, claimed when a Claude session builds. */
    private readonly forkFor: (projectId: string) => boolean = () => false,
  ) {
    this.events = {
      ...events,
      onStatus: (projectId, status) => {
        events.onStatus(projectId, status);
        if (status === "idle") {
          this.applyDeferred(projectId);
          this.settle(projectId);
        } else {
          this.cancelReap(projectId);
        }
      },
      onBackground: (projectId) => {
        events.onBackground?.(projectId);
        this.settle(projectId);
      },
    };
  }

  /** Whether a chat on a harness ("claude" for Claude) is mid-turn — the
   *  updater will not replace a binary under one. */
  busyOn(harnessId: string): boolean {
    for (const [channelId, session] of this.sessions) {
      if (session.dead) continue;
      if ((providerSessionId(session) ?? "claude") === harnessId && this.inTurn(channelId)) return true;
    }
    return false;
  }

  /** Retire every live session on a harness as each goes idle: the next
   *  prompt rebuilds it on the freshly updated binary, resuming the thread. */
  retireHarness(harnessId: string): void {
    for (const [channelId, session] of this.sessions) {
      if (session.dead || (providerSessionId(session) ?? "claude") !== harnessId) continue;
      this.whenIdle(channelId, () => {
        const live = this.sessions.get(channelId);
        if (!live || live !== session) return;
        live.dispose();
        this.sessions.delete(channelId);
      });
    }
  }

  /** What a channel has working in the background, turn or no turn. */
  backgroundWork(projectId: string): BackgroundWork {
    const session = this.sessions.get(projectId);
    return (!session?.dead && session?.backgroundWork?.()) || { agents: 0, scripts: 0 };
  }

  /** Where the default model is read from (the project store's crown). */
  useDefaultModel(read: () => string): void {
    this.defaultModelFor = read;
  }

  /** Where "something still wants this process" is read from. */
  useKeepWarm(read: (projectId: string) => boolean): void {
    this.keepWarm = read;
  }

  /** Where "this is open, but nobody is looking at it" is read from. */
  useDozing(read: (projectId: string) => boolean): void {
    this.dozing = read;
  }

  /** Whether a channel's live session is mid-turn (or waiting on the user
   *  inside one) — the state a settings change must not touch. */
  private inTurn(projectId: string): boolean {
    const session = this.sessions.get(projectId);
    return !!session && !session.dead && session.status !== "idle";
  }

  /** Run a settings change now, or once the running turn is over. */
  private whenIdle(projectId: string, apply: () => void): void {
    if (!this.inTurn(projectId)) {
      apply();
      return;
    }
    const queue = this.deferred.get(projectId) ?? [];
    queue.push(apply);
    this.deferred.set(projectId, queue);
  }

  /**
   * An idle channel's process: when it closes, looked at again whenever
   * anything that decides it changes — the turn ending, background work
   * ending, the chat being opened or left. Not idle: nothing to do (a turn
   * cancels the timer when it starts).
   */
  settle(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (!session || session.dead || session.status !== "idle") return;
    // background work is waited out by its end, not by a clock: the long
    // timer is only a look-again in case that end went unheard
    const held = session.hasBackgroundWork?.() || this.keepWarm(projectId);
    const ms = held ? IDLE_REAP_MS : this.dozing(projectId) ? ASLEEP_REAP_MS : REAP_GRACE_MS;
    this.scheduleReap(projectId, ms);
  }

  /** Close this channel's process in `ms`, if it is still idle and free. */
  private scheduleReap(projectId: string, ms: number): void {
    this.cancelReap(projectId);
    const timer = setTimeout(() => {
      this.reapTimers.delete(projectId);
      const session = this.sessions.get(projectId);
      // anything but a quiet, settled session is left alone: a turn, a card
      // waiting on the user, a settings change waiting for the turn to end
      if (!session || session.dead || session.status !== "idle" || this.deferred.has(projectId)) return;
      if (session.hasBackgroundWork?.()) {
        this.scheduleReap(projectId, IDLE_REAP_MS);
        return;
      }
      // what was holding it (an open chat, a queued prompt) still is, but
      // it has waited a whole IDLE_REAP_MS: that is the cap
      session.dispose();
      this.sessions.delete(projectId);
    }, ms);
    timer.unref?.();
    this.reapTimers.set(projectId, timer);
  }

  private cancelReap(projectId: string): void {
    const timer = this.reapTimers.get(projectId);
    if (!timer) return;
    clearTimeout(timer);
    this.reapTimers.delete(projectId);
  }

  private applyDeferred(projectId: string): void {
    const queue = this.deferred.get(projectId);
    if (!queue) return;
    this.deferred.delete(projectId);
    for (const apply of queue) apply();
  }

  /** The non-Claude provider id a model routes to, if any. An unset model
   *  means the app default (Fable) — never the CLI's own notion of default. */
  private routeOf(model: string | undefined): { providerId?: string; model?: string } {
    const effective = model || this.defaultModelFor();
    const ref = this.providers ? this.providers.parse(effective) : { model: effective };
    if (ref.providerId && ref.providerId !== "claude") return ref;
    return { ...(ref.model !== undefined ? { model: ref.model } : {}) };
  }

  /** Send a message, starting (or restarting, resuming context) the session
   *  as needed. silent = no user transcript event (split sub-prompts). */
  send(
    project: Project,
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent?: boolean,
    visibleEventId?: string,
  ): void {
    this.acquire(project).send(text, images, attachments, silent, visibleEventId);
  }

  /** Restore the project's files to a user message's checkpoint, starting
   *  (or resuming) the session if needed — Claude sessions only. */
  rewindFiles(project: Project, uuid: string): Promise<{ canRewind: boolean; error?: string }> {
    return this.acquire(project).rewindFiles(uuid);
  }

  /** The live session for a channel, built (with resume) when missing. */
  private acquire(project: Project): ChannelSession {
    const route = this.routeOf(project.model);
    let session = this.sessions.get(project.id);
    // The model moved to a different harness: retire the live session. The
    // transcript and archive are per-channel and survive; only warm state goes.
    if (session && !session.dead) {
      const providerOf = providerSessionId(session);
      const mismatch = route.providerId ? providerOf !== route.providerId : providerOf !== undefined;
      if (mismatch) {
        session.dispose();
        session = undefined;
        this.sessions.delete(project.id);
      }
    }
    if (!session || session.dead) {
      const resume = session?.lastSessionId ?? this.resumeFor(project.id);
      if (route.providerId && this.providers) {
        const provider = this.providers.create(route.providerId, project.path, project.id);
        // the agentic path (Codex app-server, ACP) is the harness verbatim;
        // run()-per-turn stays as the fallback for anything without it
        session = isSessionProvider(provider)
          ? new ProviderAgentSession(
              project,
              this.events,
              route.providerId,
              provider,
              route.model,
              resume,
              resume && this.providers.canFork?.(route.providerId) ? this.resumeAtFor(project.id) : undefined,
              this.extrasFor(project),
              resume && this.providers.canFork?.(route.providerId) ? this.forkFor(project.id) : false,
            )
          : new ProviderTurnSession(
              project,
              this.events,
              route.providerId,
              provider,
              route.model,
              resume,
              this.extrasFor(project),
            );
      } else {
        // provider-prefixed resume ids never feed a Claude session
        const claudeResume = resume && !resume.includes(":") ? resume : undefined;
        session = new ProjectSession(
          { ...project, ...(route.model !== undefined ? { model: route.model } : {}) },
          this.events,
          claudeResume,
          claudeResume ? this.resumeAtFor(project.id) : undefined,
          this.extrasFor(project),
          claudeResume ? this.forkFor(project.id) : false,
        );
      }
      this.sessions.set(project.id, session);
      // timed from the start: a session built for a rewind and never sent
      // to would otherwise never report idle, and never be closed
      this.settle(project.id);
    }
    return session;
  }

  interrupt(projectId: string): void {
    this.sessions.get(projectId)?.interrupt();
  }

  /** Apply a model change to the live session, if one is running. An empty
   *  model means "CLI default", which only takes effect on the next session.
   *  A change that moves to a different harness retires the live session —
   *  the next send rebuilds it on the right provider. */
  setModel(projectId: string, model: string): void {
    this.whenIdle(projectId, () => this.applyModel(projectId, model));
  }

  private applyModel(projectId: string, model: string): void {
    const session = this.sessions.get(projectId);
    if (!session || session.dead) return;
    const route = this.routeOf(model);
    const providerOf = providerSessionId(session);
    if (route.providerId) {
      if (providerOf === route.providerId) {
        session.setModel(route.model ?? "");
      } else {
        session.dispose();
        this.sessions.delete(projectId);
      }
    } else if (providerOf !== undefined) {
      session.dispose();
      this.sessions.delete(projectId);
    } else if (model) {
      session.setModel(route.model ?? model);
    }
  }

  /** Apply a permission-mode change to the live session, if one is running. */
  setPermissionMode(projectId: string, mode: PermissionMode): void {
    this.whenIdle(projectId, () => this.sessions.get(projectId)?.setPermissionMode(mode));
  }

  /** Apply an effort change to the live session, if one is running. Only the
   *  run-per-turn path takes it live; warm sessions retire and rebuild
   *  (resuming their context) on the next send. */
  setEffort(projectId: string, effort: string): void {
    this.whenIdle(projectId, () => {
      const session = this.sessions.get(projectId);
      if (!session || session.dead) return;
      session.setEffort(effort);
    });
  }

  respondPermission(requestId: string, allow: boolean, always = false): void {
    for (const session of this.sessions.values()) {
      if (session.respondPermission(requestId, allow, always)) return;
    }
  }

  respondQuestion(requestId: string, answers?: AskAnswers): QuestionOutcome {
    for (const session of this.sessions.values()) {
      const outcome = session.respondQuestion(requestId, answers);
      if (outcome !== "none") return outcome;
    }
    return "none";
  }

  dispose(projectId: string): void {
    this.cancelReap(projectId);
    this.sessions.get(projectId)?.dispose();
    this.sessions.delete(projectId);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  statuses(): Record<string, ProjectStatus> {
    return Object.fromEntries([...this.sessions].map(([id, s]) => [id, s.status]));
  }
}
