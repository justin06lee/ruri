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
  type SessionProvider,
  type Usage,
} from "@justin06lee/yagami";
import {
  getSessionMessages,
  type HookInput,
  type PreToolUseHookSpecificOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { buildDiff, parseUnifiedDiff, readBefore } from "./diff.js";
import { readCodexCounts } from "./usage.js";
import {
  DEFAULT_EFFORT,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_MODEL,
  type AskAnswers,
  type AskQuestions,
  type Attachment,
  type FileDiff,
  type ModelChoice,
  type PermissionMode,
  type PermissionRequest,
  type Project,
  type ProjectStatus,
  type TranscriptEvent,
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
}

/** How the manager reaches non-Claude harnesses (see server/providers.ts). */
export interface ProviderHooks {
  /** Split a model id into provider + native model. */
  parse(model: string | undefined): ModelRef;
  /** Build a provider instance working in the given project directory. */
  create(id: string, workDir: string): Provider;
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
): Promise<{ user: string; before?: string } | undefined> {
  const needle = literalRun(text);
  if (!needle) return undefined;
  try {
    const messages = await getSessionMessages(sessionId, { dir: project.path });
    const matches = messages.filter(
      (m) => m.type === "user" && promptTextOf(m.message).includes(needle),
    );
    const match = matches[ordinal] ?? matches[matches.length - 1];
    if (!match) return undefined;
    // the entry just before the prompt is where a resume forks: everything
    // up to it is kept, the prompt and its turn are not
    const before = messages[messages.findIndex((m) => m.uuid === match.uuid) - 1]?.uuid;
    return { user: match.uuid, ...(before ? { before } : {}) };
  } catch {
    // no transcript on disk (a provider session, a pruned file) — the
    // caller falls back to rewinding the conversation alone
    return undefined;
  }
}

/** Extensions the transcript will show inline — what Read itself can take. */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif"]);

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

/** What answering a question card did. */
export type QuestionOutcome = "answered" | "late" | "none";

/** How long a question card may sit unanswered before the CLI gives up on
 *  the hook. A question is a conversation, not a prompt — an hour is the
 *  point past which the session has been abandoned anyway. */
const QUESTION_TIMEOUT_S = 3600;

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
  /** File bytes captured by captureBefore, keyed by tool_use_id. */
  private readonly preimages = new Map<string, string | null>();
  /** The vault's substitution, when there is a vault (see secrets.ts). */
  private readonly secretFill: SessionExtras["fillSecrets"];

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
  ): void {
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
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
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
            ...(always && pending.suggestions?.length
              ? { updatedPermissions: pending.suggestions }
              : {}),
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
      this.pushEvent({
        kind: "info",
        id: randomUUID(),
        text: `session error: ${err instanceof Error ? err.message : String(err)}`,
        ts: Date.now(),
      });
      this.setStatus("error");
    } finally {
      this.dead = true;
      this.rejectAllPending();
    }
  }

  private handle(msg: SDKMessage): void {
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
    } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
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
        (msg.message as unknown as { content?: Array<Record<string, unknown> & { type: string }> })
          .content ?? [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
        .join("");
      if (text) {
        this.pushEvent({ kind: "assistant", id: this.draftId ?? randomUUID(), text, ts: Date.now() });
      }
      this.draftId = null;
      for (const block of blocks) {
        if (block.type === "tool_use") {
          const name = typeof block["name"] === "string" ? (block["name"] as string) : "tool";
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          const image = readImage(name, input);
          const useId = typeof block["id"] === "string" ? (block["id"] as string) : "";
          const captured = this.preimages.get(useId);
          this.preimages.delete(useId);
          const diff = toolDiff(name, input, this.project, captured);
          this.pushEvent({
            kind: "tool",
            id: randomUUID(),
            name,
            summary: toolSummary(name, input, this.project),
            ...(image ? { image } : {}),
            ...(diff ? { diff } : {}),
            ts: Date.now(),
          });
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
      // the CLI already said it in full, as a message in the transcript —
      // the line under it only has to name it, so it takes the first sentence
      const failure = apiError
        ? (firstSentence(finished.result) ?? `API error${status ? ` ${status}` : ""}`)
        : "errors" in msg && msg.errors.length > 0
          ? msg.errors.join("; ")
          : msg.subtype;
      this.pushEvent({
        kind: "result",
        id: randomUUID(),
        ok: ok || stopped,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        ...(tokens > 0 ? { tokens } : {}),
        ...(stopped ? { stopped: true } : {}),
        ...(ok || stopped ? {} : { error: failure }),
        ...(!ok && !stopped && transientFailure(failure, status) ? { transient: true } : {}),
        ts: Date.now(),
      });
      this.setStatus("idle");
    }
  }

  private async reportModels(): Promise<void> {
    try {
      this.events.onModels(await this.session.supportedModels());
    } catch {
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

  private async run(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
  ): Promise<void> {
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
          reportProviderContext(this.events, this.project.id, this.providerId, this.lastSessionId, event.usage);
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
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.abort = null;
    }
    if (acc) this.pushEvent({ kind: "assistant", id: draftId, text: acc, ts: Date.now() });
    // pick up anything the turn dropped for the app (Home's open requests)
    // before the result lands, so the sidebar is current when "done" shows
    try {
      this.extras?.onProviderTurnEnd?.();
    } catch {
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
 * first" and "accept edits" both land on workspace-write — writes inside the
 * project go through, anything outside still raises an approval card.
 *
 * ACP agents take one of their own mode ids. Claude's ACP agent uses exactly
 * these names; other agents name theirs differently and yagami drops a mode
 * it does not recognise, which leaves the harness on its own default — the
 * behaviour ruri had before, so an unknown agent is never worse off.
 */
function nativePermissions(providerId: string, mode: PermissionMode): Record<string, unknown> {
  if (providerId === "codex") {
    const sandbox =
      mode === "plan"
        ? "read-only"
        : mode === "bypassPermissions"
          ? "danger-full-access"
          : "workspace-write";
    return { sandbox };
  }
  return { mode };
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
  }> = [];
  private readonly pending = new Map<string, { resolve(d: SessionPermissionDecision): void }>();
  /** ACP can't take a system prompt natively — the first turn of each app
   *  run carries it as a <system> block (codex gets developerInstructions). */
  private sentSystem = false;
  /** The mode this session was opened with; changing it rebuilds. */
  private permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE;

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    readonly providerId: string,
    provider: SessionProvider,
    nativeModel: string | undefined,
    resume: string | undefined,
    private readonly extras?: SessionExtras,
  ) {
    this.nativeModel = nativeModel;
    if (resume?.startsWith(`${providerId}:`)) this.lastSessionId = resume;
    const nativeResume = this.lastSessionId?.slice(providerId.length + 1);
    this.permissionMode = project.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.session = provider.openSession({
      cwd: project.path,
      appName: "ruri",
      ...(nativeModel ? { model: nativeModel } : {}),
      effort: project.effort || DEFAULT_EFFORT,
      ...(nativeResume ? { resume: nativeResume } : {}),
      ...(extras?.providerSystem ? { systemPrompt: extras.providerSystem } : {}),
      native: nativePermissions(providerId, this.permissionMode),
      permissions: { decide: (req) => this.decide(req) },
    });
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
        ...(attachments?.length ? { attachments: attachments } : {}),
        ts: Date.now(),
      });
    }
    this.setStatus("working");
    if (this.running) {
      this.backlog.push({ text, ...(images ? { images } : {}) });
      return;
    }
    void this.run(text, images);
  }

  private async run(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
  ): Promise<void> {
    this.running = true;
    const started = Date.now();
    let draftId = randomUUID();
    let acc = "";
    let costUsd: number | undefined;
    let tokens: number | undefined;
    let error: string | undefined;
    let interrupted = false;
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
        if (event.type === "session") {
          this.lastSessionId = `${this.providerId}:${event.sessionId}`;
          this.events.onSessionId(this.project.id, this.lastSessionId);
        } else if (event.type === "text") {
          const piece = spaced(acc, event.text);
          acc += piece;
          this.events.onDelta(this.project.id, draftId, piece);
          this.events.onProgress(this.project.id, { chars: piece.length });
        } else if (event.type === "thinking") {
          // the harness stopped to think, so whatever it was saying is said:
          // the next message starts its own block rather than running on
          bankText();
        } else if (event.type === "tool_call") {
          if (event.status !== "started" || toolsSeen.has(event.id)) continue;
          toolsSeen.add(event.id);
          bankText();
          for (const chip of providerToolEvents(event, this.project)) {
            this.pushEvent({ kind: "tool", id: randomUUID(), ...chip, ts: Date.now() });
          }
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
      if (err instanceof AuthRequiredError) {
        error = err.message;
      } else if (err instanceof ProviderNotInstalledError) {
        error = err.message;
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    this.rejectPending();
    bankText();
    // pick up anything the turn dropped for the app (Home's open requests)
    try {
      this.extras?.onProviderTurnEnd?.();
    } catch {
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

  /** What this turn left in the window, for the context dragon. */
  private reportContext(usage: Usage | undefined): void {
    reportProviderContext(this.events, this.project.id, this.providerId, this.lastSessionId, usage);
  }

  /** The harness asked to do something — show ruri's permission card. */
  private decide(req: SessionPermissionRequest): Promise<SessionPermissionDecision> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve });
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

  /** Other harnesses have no AskUserQuestion — nothing ever parks a card. */
  respondQuestion(): QuestionOutcome {
    return "none";
  }

  respondPermission(requestId: string, allow: boolean, always = false): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(allow ? (always ? "allow_always" : "allow") : "deny");
    this.events.onPermissionResolved(requestId);
    if (this.running && this.pending.size === 0) this.setStatus("working");
    return true;
  }

  pendingRequests(): string[] {
    return [...this.pending.keys()];
  }

  private rejectPending(): void {
    for (const [requestId, pending] of this.pending) {
      pending.resolve("deny");
      this.events.onPermissionResolved(requestId);
    }
    this.pending.clear();
  }

  interrupt(): void {
    this.backlog.length = 0;
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

  dispose(): void {
    this.dead = true;
    this.backlog.length = 0;
    this.rejectPending();
    void this.session.close();
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
  /\b5\d\d\b|overloaded|service unavailable|bad gateway|gateway time-?out|internal server error|econnreset|econnrefused|etimedout|epipe|socket hang up|fetch failed|network error|stream (?:error|closed|disconnected)/i;
/** Limits and refusals wear transient-looking words but are not transient. */
const NOT_TRANSIENT = /usage limit|rate limit|quota|credit|insufficient|out of (?:credits|tokens)|invalid api key|unauthorized|forbidden|authentication/i;

/** Whether a failed turn's error reads like something worth simply redoing.
 *  `status` is the HTTP status when the harness names one (Claude does). */
export function transientFailure(text: string | undefined, status?: number | null): boolean {
  if (typeof status === "number") return status >= 500 && status < 600;
  if (!text || NOT_TRANSIENT.test(text)) return false;
  return TRANSIENT.test(text);
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

export class SessionManager {
  private readonly sessions = new Map<string, ChannelSession>();

  constructor(
    private readonly events: SessionEvents,
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
  ) {}

  /** The non-Claude provider id a model routes to, if any. An unset model
   *  means the app default (Fable) — never the CLI's own notion of default. */
  private routeOf(model: string | undefined): { providerId?: string; model?: string } {
    const effective = model || DEFAULT_MODEL;
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
  ): void {
    this.acquire(project).send(text, images, attachments, silent);
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
        const provider = this.providers.create(route.providerId, project.path);
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
              this.extrasFor(project),
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
    this.sessions.get(projectId)?.setPermissionMode(mode);
  }

  /** Apply an effort change to the live session, if one is running. Only the
   *  run-per-turn path takes it live; warm sessions retire and rebuild
   *  (resuming their context) on the next send. */
  setEffort(projectId: string, effort: string): void {
    const session = this.sessions.get(projectId);
    if (!session || session.dead) return;
    session.setEffort(effort);
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
