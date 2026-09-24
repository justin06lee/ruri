/** Types (and the one shared constant) between the ruri server and the web UI. */

/** The pseudo-project id of the Home view — the workspace-manager agent. */
export const HOME_ID = "home";

/** How many of a channel's latest events the connect snapshot carries, and
 *  how many the window keeps of a chat it is not showing. */
export const TRANSCRIPT_TAIL = 12;

/** The most events the Home chat keeps. It is ephemeral anyway, and an
 *  orchestrator's long history is exactly what nobody scrolls back through. */
export const HOME_TRANSCRIPT_MAX = 50;

/**
 * The newest `max` events, cut where a turn starts when one does — so the
 * list opens on a prompt rather than halfway through somebody's reply. A
 * single turn longer than `max` is simply cut at `max`.
 */
export function keepRecent<T extends { kind: string }>(events: T[], max: number): T[] {
  if (events.length <= max) return events;
  let cut = events.length - max;
  const start = events.findIndex((e, i) => i >= cut && (e.kind === "user" || e.kind === "compaction"));
  if (start !== -1) cut = start;
  return events.slice(cut);
}

/** The model a session runs on when none is picked and nothing has been
 *  crowned the default in Settings (a third star does that). The built-in
 *  fallback is the newest Fable; an unset model never means "whatever the
 *  CLI feels like". */
export const DEFAULT_MODEL = "claude-fable-5-1[1m]";

/** The two roles a starred model can hold: the small-tasks model (notes,
 *  titles, splitting, the tracker) and the default new chats start on. */
export type ModelRole = "small" | "default";

/**
 * One live coding session inside a project. Transcripts, statuses,
 * drafts, summaries, and tracker items are keyed by the session id (the
 * protocol's `projectId` fields carry session ids for project sessions).
 */
export interface SessionInfo {
  id: string;
  /** Role title, auto-named by the small model ("Frontend UI", …). */
  title?: string;
  /** This chat's own model, effort and permission mode. Unset means the
   *  project's — which is only ever what a NEW chat starts on: picking one
   *  in a chat sets it here, for this chat, and never reaches another. */
  model?: string;
  permissionMode?: PermissionMode;
  effort?: string;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Reasoning-effort levels, yagami's shared vocabulary: Claude takes them
 *  natively, Codex maps them to model_reasoning_effort; harnesses without
 *  the knob ignore them. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The effort a session runs at when none is picked — same philosophy as
 *  DEFAULT_MODEL: no ambiguous "default" entry; unset simply means xhigh. */
export const DEFAULT_EFFORT = "xhigh";

/** The permission mode a project's sessions run in when it hasn't picked
 *  one. Like DEFAULT_MODEL and DEFAULT_EFFORT, unset simply means this —
 *  and here that is Bypass: ruri is a workspace you drive, and being asked
 *  to approve every read is not what it's for. "Ask first" is one pick away
 *  in the composer for a project that wants it. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

export interface Project {
  id: string;
  name: string;
  path: string;
  folder?: string;
  /** What a new session in this project starts on — the last pick made
   *  in any of its chats. A session that has picked its own carries it on
   *  itself (SessionInfo); these are the fallback, never an override. */
  model?: string;
  /** Permission mode a new session starts in (DEFAULT_PERMISSION_MODE when unset). */
  permissionMode?: PermissionMode;
  /** Reasoning effort a new session starts at (EFFORT_LEVELS);
   *  DEFAULT_EFFORT (xhigh) when unset. */
  effort?: string;
  /** Bookmarked: shown in the Starred section above the project tree. */
  starred?: boolean;
  /** Tucked away: out of the sidebar, rapid fire, the switcher and the
   *  projects board, but still open — sessions and transcripts intact —
   *  and one click (or the Home agent) brings it back. */
  hidden?: boolean;
  /** The project's sessions (possibly none — an empty folder is fine). */
  sessions: SessionInfo[];
}

export type ProjectStatus = "idle" | "working" | "permission" | "error";

/** A model in the device-wide catalog. Claude models are bare ids; other
 *  harnesses use yagami's "provider:model" convention. */
export interface ModelChoice {
  value: string;
  /** The model's own name, no provider prefix ("Opus", "GPT-5.6-Sol"). */
  displayName: string;
  /** Provider id when the model belongs to a non-Claude harness. */
  provider?: string;
  /** Human name of that harness ("Codex CLI"), for tags and placeholders. */
  providerLabel?: string;
  /**
   * The harness runs this model as a real agentic session, so it has an
   * approval flow ruri can drive — which is what decides whether the
   * permission-mode dropdown means anything. Claude models leave it unset;
   * they always have one.
   */
  agentic?: boolean;
  /** Reasoning levels this exact model reports, not a global provider guess. */
  reasoningEfforts?: Array<{ value: string; description?: string }>;
  defaultEffort?: string;
  inputModalities?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  supportsPersonality?: boolean;
  multiAgent?: string;
  serviceTiers?: Array<{ value: string; label: string; description?: string }>;
  defaultServiceTier?: string;
  providerDefault?: boolean;
}

/** A file attached to a prompt — image, video, or any other file (pdf,
 *  text, source, …); "file" kinds are saved to disk and read via tools. */
export interface Attachment {
  id: string;
  kind: "image" | "video" | "file";
  mediaType: string;
  name: string;
  /** Marker number as shown in the prompt text ([image #2] → 2). */
  n: number;
  /** Streaming URL once the server stored it (/uploads/…). */
  url?: string;
  /** The boxes drawn on an image, kept with it so a prompt that comes back
   *  to the composer (a rewind) brings its regions back too. */
  regions?: DraftRegion[];
}

/** The picture types every harness's model takes as they are. Any other
 *  image (an SVG, a BMP, an AVIF, …) is shown to it as a PNG drawn by the
 *  composer — see `AttachmentUpload.picture`. */
export const MODEL_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Wire form when sending: base64 payload plus optional region annotations. */
export interface AttachmentUpload extends Omit<Attachment, "regions"> {
  data: string;
  /** A PNG of an image whose own type the model cannot take (base64): the
   *  model is shown this, and handed the original's path to open. */
  picture?: string;
  /** Region crops of an image, each numbered as the prompt's [region #n]
   *  names it (the crop carries that number drawn on it). `rect` is the box
   *  itself, in fractions of the image, so the archive can hand it back. */
  regions?: Array<{ n: number; data: string; mediaType: string; rect?: Omit<DraftRegion, "n"> }>;
}

/** A box the user drew on a composer image, in fractions of it, with the
 *  number the prompt refers to it by. */
export interface DraftRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  n: number;
}

/** An attachment parked in a composer, stored like any other upload — the
 *  marker number and the drawn regions ride along so the strip comes back
 *  exactly as it was left. */
export interface DraftAttachment extends Attachment {
  regions?: DraftRegion[];
}

/** Wire form when saving a draft: bytes only for what the server does not
 *  already hold, so a keystroke re-sends metadata and not a video. */
export interface DraftAttachmentUpload extends Attachment {
  data?: string;
  regions?: DraftRegion[];
}

/** A channel's unsent prompt: the text and whatever is clipped to it. */
export interface ComposerDraftState {
  text: string;
  attachments?: DraftAttachment[];
}

/** Tick state of a tracker item: open → liked (check) → rejected (x) → open. */
export type TrackerStatus = "open" | "liked" | "rejected";

/** One entry on the feature/prompt tracker checklist. */
export interface TrackerItem {
  id: string;
  text: string;
  note: string;
  status: TrackerStatus;
  /** "auto" = extracted from a turn by the small model; "manual" = user-added. */
  source: "auto" | "manual";
  /** Prompt (user-event id) this item was split from, when auto — the item
   *  follows its prompt: a rewind/edit that discards the prompt takes the
   *  item with it, and the edited prompt re-extracts fresh ones. */
  turnId?: string;
  /** Marked needs-work in a past review — shown pinned with a repeat mark. */
  repeat?: boolean;
  /** Files pasted into the note — referenced by path in the review prompt. */
  attachments?: Attachment[];
  ts: number;
}

/**
 * One line on a project's ideas board — a want, not a task. Nothing writes
 * these but the user: the board is where a thought goes so it stops taking
 * up room, and it stays there until it's done or it's dropped.
 *
 * Ideas are keyed by PROJECT id, not by session — an idea belongs to the
 * thing being built, not to whichever chat happened to be open.
 */
export interface Idea {
  id: string;
  /** In the user's words — as many lines as it takes, with an [image #n]
   *  marker wherever a picture was put in. */
  text: string;
  done: boolean;
  ts: number;
  /** Pictures (or any file) clipped to it, stored like a prompt's; the arrow
   *  hands them to the composer along with the words. */
  attachments?: Attachment[];
}

/** Where an unsent idea waits: the composer-draft store, under this key
 *  rather than a channel id — so it outlives leaving the page, and a
 *  relaunch, the way a half-written prompt does. */
export function ideaDraftKey(projectId: string): string {
  return `idea:${projectId}`;
}

/**
 * One piece of a project's interface in its component library: the words
 * the user actually uses for it, the handle the library knows it by, its
 * code, and what it looks like.
 *
 * The point is the gap between "the dragon gauges" and
 * `web/src/components/Dragon.tsx` — the user names things by what they see
 * — and, past that, a library the agents build up and draw from: each
 * entry can be looked up (`ruri search`), read (`ruri show`), and copied
 * into place (`ruri add`), shadcn-style. ruri writes the library into the
 * project as `.ruri/components.md` for any harness to read, as a skill for
 * Claude, and hands the matching entries to the model alongside a prompt
 * that names one. Interface only: screens, panels, controls — never the
 * backend. Keyed by PROJECT id; every project has its own library.
 */
export interface NamedComponent {
  id: string;
  /** What the user calls it. */
  name: string;
  /** The library's handle for it — `ruri add peek-band` — kebab-case and
   *  unique in its project. Made from the name when it arrives. */
  slug: string;
  /** Other names that mean the same thing. */
  aliases: string[];
  /** Its own code: the files `ruri add` copies and the page shows, as
   *  repo-relative paths ("web/src/components/Dragon.tsx"). */
  files: string[];
  /** Other places it reaches into — shared styles, the screen it sits on,
   *  the server side of it — optionally with a line ("styles.css:2864").
   *  Shown and read, never copied. */
  uses?: string[];
  /** Words to find it by beyond its name ("dialog", "nav", "animation"). */
  tags?: string[];
  /** Packages its code needs, which `ruri add` names for installing. */
  deps?: string[];
  /** Where `ruri add` has put copies of it, repo-relative. */
  installs?: string[];
  /** Anything else the model should know before touching it. */
  note: string;
  /** What it looks like — newest first: the first is the picture. */
  shots: Attachment[];
  /** When its picture was last known to show it as it is: set when one is
   *  added, and when a review of a change finds its look untouched. */
  shotAt?: number;
  /** When its note was last known to hold: written, or reviewed. */
  noteAt?: number;
  /** The last change seen to its own files — a turn that edited them, or
   *  git's last commit to them. Later than `shotAt`, the picture is out of
   *  date; later than `noteAt`, the note may be (componentStale). */
  changedAt?: number;
  /**
   * A CSS selector that finds it in the running app. Written down by
   * whoever read the source — a class name in the JSX is one — and it is
   * what lets ruri take its picture without anyone opening the app: load
   * the project, find this, capture that rectangle. See server/shots.ts.
   */
  selector?: string;
  /** The path to load before looking for the selector ("/settings"). */
  route?: string;
  /** Selectors to click first, when it takes a click to bring it on screen. */
  clicks?: string[];
  /**
   * How new it is, and therefore whether it wears a star: "just" = named
   * during the prompt that has only now run, "still" = new since you last
   * looked, but from an earlier prompt. Absent once you've seen it.
   */
  star?: "just" | "still";
  /** The repo sweep found this one, rather than a session naming it as it
   *  built it — so the name is a guess until the user corrects it. */
  found?: boolean;
  ts: number;
  /** When the entry last changed. */
  updated?: number;
}

/** Whether a component's picture and note have fallen behind its code. A
 *  picture-less entry is not stale — it is missing one, which is its own
 *  thing on the page. */
export function componentStale(item: NamedComponent): { picture: boolean; note: boolean } {
  const changed = item.changedAt ?? 0;
  return {
    picture: item.shots.length > 0 && changed > (item.shotAt ?? 0),
    note: changed > (item.noteAt ?? item.ts),
  };
}

/** One layer of a project's stack, top (what a person touches) to bottom.
 *  The stack is the index every session is shown; each layer with code of
 *  its own has a sheet behind it (LayerSheet), read when the work is in it. */
export interface StackLayer {
  name: string;
  /** The technologies, and what the layer does. */
  what: string;
  /** Its folder or files, when it has them. */
  where?: string;
  /** Its handle — the name of its sheet (`.ruri/layers/<slug>.md`) and what
   *  `ruri layer <slug>` takes. Made from the name when it arrives. */
  slug?: string;
  /** The repo-relative folders and files it owns ("server/bridge.ts",
   *  "web/src/") — how a changed file finds the layer whose sheet it moves. */
  paths?: string[];
}

/**
 * One layer's own architecture sheet: what a session about to work in that
 * part of the project needs, and nothing about the rest. Short on purpose —
 * a project grows by gaining layers, not by its sheets growing — and
 * written into the project as `.ruri/layers/<slug>.md`.
 */
export interface LayerSheet {
  /** What the layer is and does, and how it's built: a short paragraph. */
  summary: string;
  /** Where to change what, inside this layer. */
  map: ConceptPlace[];
  /** How work moves through it: its own paths, part to part. */
  flows: SystemFlow[];
  /** Its key files, "path — what it is for". */
  files: string[];
  /** The traps and rules of working in it. */
  rules: string[];
  /** The other layers it talks to, and how: "wire contract — every message is typed in shared/protocol.ts". */
  edges: string[];
  /** When it was last written or folded. */
  updated?: number;
}

/**
 * What a layer owns, short enough for a line of the stack: its folders,
 * and the folders its own files sit in, then how many files — "web/src/,
 * web/src/lib/ · 24 files". The whole list is the layer's own sheet's.
 */
export function ownsSummary(paths: string[]): string {
  const folders: string[] = [];
  let files = 0;
  for (const p of paths) {
    const folder = p.endsWith("/") ? p : p.includes("/") ? `${p.slice(0, p.lastIndexOf("/") + 1)}` : "./";
    if (!p.endsWith("/")) files += 1;
    if (!folders.includes(folder)) folders.push(folder);
  }
  if (files === 0) return folders.join(", ");
  if (paths.length === 1) return paths[0]!;
  const shown = folders.slice(0, 3).join(", ") + (folders.length > 3 ? ` +${folders.length - 3}` : "");
  return `${shown} · ${files} file${files === 1 ? "" : "s"}`;
}

/** A layer sheet's lists the user may correct line by line. */
export type LayerSection = "map" | "files" | "rules" | "edges";

/** One path through a project — how a request, an action or data moves —
 *  as the parts it passes through, in order. */
export interface SystemFlow {
  name: string;
  steps: string[];
}

/** The exchange a line of the memory was learned from: a chat, and the
 *  prompt that opened the exchange (its event id, so a rewind that takes
 *  the exchange away takes the reference with it). */
export interface MemorySource {
  chat: string;
  turn: string;
}

/**
 * One line of a project's working memory. Who wrote it decides who may
 * change it: the small model rewrites and merges its own lines freely; an
 * agent's (`ruri note`, written by the session that did the work) and the
 * user's (typed on the architecture page) are never reworded by the model.
 */
export interface MemoryLine {
  /** Stable, so the page and `ruri forget` can name the line. */
  id: string;
  text: string;
  /** A decision's reason, a failure's cause. */
  why?: string;
  /** The day it was learned, YYYY-MM-DD, in the user's own time. */
  date?: string;
  by: "model" | "agent" | "user";
  source?: MemorySource;
  /** Kept exactly as it is, whatever later work says — the user's call. */
  pinned?: boolean;
}

/**
 * What a project's agents have learned about working on it — the part of a
 * project nobody can read off its code — kept across every chat in it and
 * written into the project as `.ruri/catchup.md`. Each part is a list of
 * short lines, each with when and where it was learned.
 */
export interface ProjectMemory {
  /** Where the work stands: in progress, just done, next. */
  now: MemoryLine[];
  /** What was decided, each with why. */
  decisions: MemoryLine[];
  /** Approaches that proved out here. */
  worked: MemoryLine[];
  /** What was tried and failed, and why. */
  failed: MemoryLine[];
  /** Traps, constraints and standing rules. */
  gotchas: MemoryLine[];
  /** Asked for and not done, put off, or known broken. */
  open: MemoryLine[];
}

export type MemoryPart = keyof ProjectMemory;

/** The shape's lists the user may correct line by line. */
export type SheetSection = "features" | "map" | "layout" | "run" | "conventions";

/** A concept a session may be asked to change, and the files it lives in —
 *  the part of the sheet that says where to go, not just what exists. */
export interface ConceptPlace {
  name: string;
  files: string[];
}

/** A memory line's source, as the page shows it: which chat, which
 *  exchange, and the ref `ruri recall show` takes. */
export interface SourceLabel {
  ref: string;
  chat: string;
  n: number;
}

/** The repo as git has it, beside the sheet — facts, not recollection. */
export interface SheetGit {
  branch: string;
  head: string;
  /** Uncommitted files. */
  dirty: number;
  /** Local branches not merged into the mainline. */
  unmerged: string[];
  /** Commits since the repo was last read for the sheet. */
  sinceRead?: number;
}

/**
 * Everything ruri knows about a project as a whole, for a model that has
 * never seen it: its shape (`.ruri/architecture.md` — what it is, the stack,
 * how the parts connect, where things are, how to run it) and its working
 * memory (`.ruri/catchup.md`). Written by the small model from reads of the
 * repo, from the chats' histories, and from turns as they finish; shown on
 * the architecture page.
 */
export interface ProjectSheet {
  /** What the project is, who it's for, the problem it solves. */
  description: string;
  /** What it can do, one capability a line. */
  features: string[];
  layers?: StackLayer[];
  flows?: SystemFlow[];
  /** An older sheet's stack, one line each — layers replace it. */
  stack?: string[];
  /** How to run, build, test and ship it. */
  run?: string[];
  /** Where things are: folders and key files and what each is for. */
  layout?: string[];
  /** Rules a session must follow, from the repo's own instructions. */
  conventions?: string[];
  /** Where to change what: concepts and the files they live in. A sheet
   *  with layer sheets keeps this in them instead, one map per layer. */
  map?: ConceptPlace[];
  /** Each layer's own sheet, by its slug. */
  layerSheets?: Record<string, LayerSheet>;
  memory?: ProjectMemory;
  /** Pinned screenshots of the main pages. */
  shots: Attachment[];
  /** When the shape last changed. */
  updated?: number;
  /** When the repo was last read whole for it. */
  built?: number;
  /** The commit the repo stood at when it was read. */
  builtAt?: string;
  /** When the memory last changed. */
  remembered?: number;
  /** When the memory was last written from the chats' histories whole. */
  recalled?: number;
}

/**
 * One of a component's files, as the library page reads it: the whole
 * file, or — when it is long, or the entry points at a line in it — the
 * stretch of it that matters, starting at `from`.
 */
export interface ComponentFile {
  /** As the entry lists it, without the line. */
  path: string;
  /** Whether it is the component's own code (`files`) or a place it
   *  reaches into (`uses`). */
  own: boolean;
  /** The line the entry points at. */
  line?: number;
  text?: string;
  /** The first line of `text` (1 when it is the whole file). */
  from?: number;
  /** How many lines the file has in all. */
  lines?: number;
  /** Not there, or not readable. */
  missing?: boolean;
}

/**
 * A credential ruri holds so the model can use it without ever reading it.
 * The value lives on disk under the config dir and never crosses this wire —
 * only its name, so the UI can list what exists. See server/secrets.ts for
 * the two ways it reaches a command.
 */
export interface SecretMeta {
  id: string;
  /** The handle everything refers to it by: {{name}}, $RURI_SECRET_NAME. */
  name: string;
  /** The account the secret belongs to, when there is one. */
  username?: string;
  /** What it's for — shown to the user, and to the model as a hint. */
  note?: string;
  /** Whether a value is actually stored (it never leaves the server). */
  hasValue: boolean;
  updated: number;
}

/**
 * A component the model has just built, on its way to being named.
 *
 * The model proposes; the user names. Nobody remembers what a file is
 * called, and everybody remembers what a thing looks like — so the moment a
 * new piece of interface exists is the moment to write down what it will be
 * called from then on, while both parties are looking straight at it.
 */
/* ── agents talking to agents (server/talk.ts) ──────────────────────── */

/** What an agent asked for back when it messaged another: to wait for the
 *  answer, to have it come to its chat when it is ready, or nothing. */
export type TalkReply = "wait" | "later" | "none";

/** Where a prompt came from when another agent sent it: on the user event
 *  it arrived as, so the chat can say whose it is. */
export interface LetterFrom {
  /** The chat that sent it. */
  agent: string;
  /** That chat's project's name, and its own title ("" when it has none). */
  project: string;
  title: string;
  /** The message this is — or, with `answer`, the one it answers. */
  letter: string;
  /** What the sender asked for back. */
  reply: TalkReply;
  /** The answer to a message this chat sent, coming back to it. */
  answer?: boolean;
  /** How many agents deep this has gone since the user last spoke. */
  depth: number;
}

/** Who one agent may message: anyone, only the chats and projects listed
 *  (a project meaning every chat in it, new ones too), or no one. */
export interface TalkRule {
  to: "anyone" | "listed" | "nobody";
  projects: string[];
  chats: string[];
}

/** Who may message whom: one rule for every agent, which a project's rule
 *  overrides for the chats in it, which a chat's own overrides for it. */
export interface TalkPolicy {
  everyone: TalkRule;
  projects: Record<string, TalkRule>;
  chats: Record<string, TalkRule>;
}

/** Where a message between agents has got to. */
export type TalkStatus =
  | "asking" // waiting on the user's allow or deny
  | "denied" // the user said no
  | "refused" // the limits (or ruri's own guards) said no
  | "queued" // in the other chat's queue
  | "working" // the other chat's turn on it is running
  | "answered" // that turn is done
  | "failed" // that turn failed
  | "dropped"; // taken out of the queue before it went

/** One message between agents, as the talk page lists them. */
export interface TalkLetter {
  id: string;
  /** Chat ids. */
  from: string;
  to: string;
  /** The message, cut short. */
  text: string;
  reply: TalkReply;
  status: TalkStatus;
  /** Why it was refused, or how it failed. */
  note?: string;
  ts: number;
}

/** What an agent asks to send, on the card that asks the user. */
export interface TalkAsk {
  /** The chat it is for. */
  to: string;
  project: string;
  title: string;
  text: string;
  reply: TalkReply;
}

export interface ComponentProposal {
  /** What the model suggests calling it, in the user's kind of words. */
  name: string;
  /** Where it lives — "web/src/components/Dragon.tsx:40". */
  files: string[];
  /** One line on what it is. */
  note: string;
  /** The handle it should go into the library under (`peek-band`). */
  slug?: string;
  /** Places it reaches into beyond its own files ("styles.css:2864"). */
  uses?: string[];
  /** Words to find it by. */
  tags?: string[];
  /** Packages its code needs. */
  deps?: string[];
  /** An image of it the model already has, as a path on disk. Server-side
   *  only: the card is sent `image`, which is ruri's own copy of it. */
  shot?: string;
  /** That screenshot, copied into ruri's uploads the moment the proposal
   *  arrives — so the card can show the user what is being named, and so a
   *  file the model wrote to /tmp is still there when they answer. */
  image?: Attachment;
}

/** An installed Claude Code skill, global or local to one project. */
/** One slash command the composer can offer, as the server knows it. */
export interface CommandInfo {
  /** Without the slash. */
  name: string;
  /** Who answers it: ruri itself, the harness, an installed skill, or a
   *  custom command file in .claude/commands. */
  kind: "ruri" | "harness" | "skill" | "custom";
  /** One line on what it does, where there is one to give. */
  description?: string;
}

export interface SkillInfo {
  /** Folder name under skills/ — what `bmo remove` takes. */
  name: string;
  /** The frontmatter's description: when the model should reach for it. */
  description: string;
  scope: "global" | "project";
  /** Absolute path of the skill folder as it sits now. */
  path: string;
  /** Live, or parked in the sibling skills-off/ folder. */
  enabled: boolean;
  /** Where bmo installed it from, when bmo installed it. */
  source?: string;
  /** Last change to the source, per bmo. */
  updated?: number;
}

/** A session on disk that ruri did not make — a `claude` or `codex` run
 *  from a terminal in this project's directory — as offered for import. */
export interface RecentSession {
  /** Bare CLI session id for Claude, "codex:<thread id>" for Codex. */
  id: string;
  provider: "claude" | "codex";
  /** The first thing said, short. */
  title: string;
  /** Last written (epoch ms). */
  at: number;
  branch?: string;
}

/**
 * Why a queue is standing by rather than moving on as each turn ends. The
 * user stopped the turn (a change of mind about that answer, not about the
 * prompts behind it); or the turn fell to a dropped connection — `back`
 * once the API can be reached again — or to a usage limit, which lifts at
 * `resetsAt` (ms since the epoch) when the harness says.
 */
export type QueueHold =
  { by: "stop" } | { by: "network"; back?: boolean } | { by: "limit"; resetsAt?: number };

/** A prompt held app-side until the running turn finishes (editable). */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: Attachment[];
  /** Out of the line for the moment, being rewritten in the composer: the
   *  prompts behind it move up and go out without it, and it steps back in
   *  where it was (relative to what is still there) when the rewrite is
   *  sent — see queue_edit / queue_update. */
  editing?: true;
  /** Sent by another agent: whose, as "project · chat". */
  from?: string;
}

/** A harness's account limit windows (percent USED, 0-100). A missing field
 *  means that window couldn't be read — or that this harness has no such
 *  window. Keyed by provider id wherever a set of them travels. */
export interface UsageLimits {
  /** The 5-hour session window. */
  fiveHour?: number;
  /** The 7-day window, across every model. */
  weekly?: number;
  /**
   * The weekly window scoped to one model — the account's premium tier, which
   * the endpoint names itself ("Fable", "Opus"). Absent on plans without one.
   */
  scoped?: { label: string; percent: number };
  /** When each window next rolls over (epoch ms), for the harnesses that
   *  say — a percentage answers "how much is left", not "how long until I
   *  get it back", and the second question is the one you act on. */
  resets?: { fiveHour?: number; weekly?: number; scoped?: number };
  /** When this reading was taken (epoch ms). A relaunch shows the last one
   *  off disk until a fresh read lands, and the gauges say so on hover. */
  at?: number;
}

/** What a run of turns spent, added up. */
export interface Totals {
  tokens: number;
  /** At API prices — what the turns would have cost, not what was billed. */
  costUsd: number;
  turns: number;
  /** Wall time the turns took, in ms. */
  ms: number;
}

/**
 * One agent process and everything it started, as the machine sees it.
 *
 * A harness and its MCP servers are one agent, not six rows: `rss` and
 * `cpu` are the whole family's, and `helpers` says how many processes that
 * was besides the harness itself (server/resources.ts).
 */
export interface AgentProcess {
  pid: number;
  /** The chat it is running for, where its command line said so. */
  channelId?: string;
  /** The program: "claude", "codex", "cursor-agent". */
  name: string;
  /** Resident memory, in bytes. */
  rss: number;
  /** Percent of one core. Over 100 on a process using more than one. */
  cpu: number;
  uptimeMs: number;
  /** Processes under it, counted in the figures above. */
  helpers: number;
}

/** What ruri's agents are costing this machine right now. */
export interface Resources {
  at: number;
  agents: AgentProcess[];
  /** ruri itself: this process and its window. */
  app: { rss: number; cpu: number; processes: number };
  host: { totalBytes: number; freeBytes: number; cores: number };
}

/** A project's spending, from the ledger (see server/ledger.ts): all of
 *  it, today's, and the last seven days'. Keyed by PROJECT id. */
export interface ProjectStats {
  total: Totals;
  today: Totals;
  week: Totals;
}

/**
 * What the running turn has done so far — the numbers under the doodle
 * while it works. A turn is otherwise a black box between the prompt and
 * the result: this is how long it has been in there, how much has come
 * back, and when anything last did.
 */
export interface TurnProgress {
  /** When the prompt went out (epoch ms). */
  startedAt: number;
  /** Output tokens the harness has sent back this turn — exact as of each
   *  finished API call, estimated from the stream in between. */
  tokens: number;
  /** When something last came back (epoch ms). A long gap here is a stall,
   *  and the working line says so rather than counting quietly upward. */
  at: number;
}

/** Context-window occupancy of a channel's live session, from the last call. */
export interface ContextUsage {
  /** Tokens in the window right now (input + cache + output of last call). */
  tokens: number;
  /** The window size for the session's model (1M with [1m], else 200k). */
  window: number;
}

/** A playable track in the music library (served by GET /music/track). */
export interface Track {
  id: string;
  title: string;
  filename: string;
  /** Same-origin streaming URL (/music/track?p=…). */
  url: string;
}

/** A folder of tracks (served by GET /music/playlists). */
export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
}

/** One exchange inside a compaction brief: the prompt and the reply, each
 *  compressed to a terse recall note by the small model. */
export interface CompactionEntry {
  user: string;
  reply: string;
  /** The exchange's number in the whole conversation — the name of its
   *  record's file. Absent on marks from before the digest, which listed
   *  every exchange and so counted from 1. */
  n?: number;
}

/** The oldest exchanges of a long conversation condensed together by the
 *  small model, rather than listed one by one (server/compaction.ts). */
export interface CompactionDigest {
  text: string;
  /** How many of the conversation's exchanges, from its start, it covers —
   *  0 when all it covers is history since dropped by the history's cap. */
  through: number;
}

/** A turn's recall notes on the wire: the prompt's and the reply's, each
 *  there once the small model has written it. */
export interface TurnNote {
  user?: string;
  reply?: string;
}

/**
 * One line of a chat's outline of its history (everything before its newest
 * compaction): an exchange — with a cut of its prompt and of its last reply
 * to stand in until its notes are written, and how many events it holds —
 * or a compaction mark. The bodies stay on the server until one is opened.
 */
export type EarlierItem =
  | { kind: "turn"; turnId: string; prompt: string; reply: string; count: number; ts: number }
  | { kind: "compaction"; id: string; ts: number };

/** A reply with its markdown marks taken off, so a cut of it reads as the
 *  plain line it stands in for rather than as `**stars**` and backticks. */
export function unmarked(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(#{1,6}|[-*+]|\d+[.)])[ \t]+/gm, "");
}

/** Text flattened to one line and cut to `max` characters — what stands in
 *  for a recall note the small model hasn't written. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export type TranscriptEvent =
  | {
      kind: "user";
      id: string;
      text: string;
      attachments?: Attachment[];
      /** Sent by another agent, not typed by the user (server/talk.ts). */
      from?: LetterFrom;
      ts: number;
    }
  | { kind: "assistant"; id: string; text: string; ts: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      summary: string;
      /** Set when the tool read an image — the transcript shows it inline. */
      image?: { url: string; name: string };
      /** Set when the tool changed a file — the transcript shows the patch. */
      diff?: FileDiff;
      /** Set when the tool started a subagent — the chip is the agent's card,
       *  sent again with this updated as it works, and opens its own log. */
      agent?: SubagentState;
      ts: number;
    }
  | {
      kind: "result";
      id: string;
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      /** Tokens the turn spent — everything sent and everything back,
       *  cached reads included, as the harness counts them. */
      tokens?: number;
      error?: string;
      /** The turn ended because the user pressed stop — not an error. */
      stopped?: boolean;
      /** The turn was dropped by the API rather than by anything the model
       *  or the user did: overloaded, a 5xx, a connection cut. The one
       *  class of failure that trying again is an answer to. */
      transient?: boolean;
      /** The turn fell to the world rather than the conversation: nothing
       *  reached the API (`network`), or the account is out of usage
       *  (`limit`). Whatever is queued behind it would meet the same, so
       *  the queue holds instead of moving on. */
      blocked?: "network" | "limit";
      /** When the limit that stopped it lifts (ms since the epoch), when
       *  the harness says. */
      resetsAt?: number;
      /** The models that answered this turn, by their resolved ids, when the
       *  harness says (Claude's modelUsage). A chat that switched model
       *  mid-conversation shows the switch here. */
      models?: string[];
      /** Input tokens the turn read back from the prompt cache — the proof a
       *  model switch (or a switch back) kept the conversation's prefix. */
      cacheRead?: number;
      ts: number;
    }
  | { kind: "info"; id: string; text: string; ts: number }
  | {
      kind: "plan";
      id: string;
      explanation?: string;
      entries?: Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
        priority?: "high" | "medium" | "low";
      }>;
      markdown?: string;
      uri?: string;
      removed?: boolean;
      ts: number;
    }
  /** A /compact point: the session restarted fresh here; `text` is the
   *  model-facing brief (summaries + full-turn file hooks) and `entries` its
   *  structured prompt/reply pairs, hidden behind the zigzag separator
   *  unless the user unfolds it. */
  | {
      kind: "compaction";
      id: string;
      text: string;
      entries?: CompactionEntry[];
      digest?: CompactionDigest;
      ts: number;
    };

/**
 * A subagent a harness started — Claude's Agent tool, Codex's spawn_agent —
 * as its card in the chat shows it. What the agent itself did (its brief,
 * what it said, every tool it ran) is kept apart from the chat, as its own
 * log under `key`: the chat stays the conversation, and the card opens
 * the agent's side of it.
 */
export interface SubagentState {
  /** The spawning call's id (Claude's tool_use id, Codex's item id) — the
   *  key its log is kept under. */
  key: string;
  /** The agent's kind, when the harness names one ("Explore"). */
  type?: string;
  /** What it was sent to do, in a line. */
  description: string;
  /** The whole brief it was handed. */
  prompt?: string;
  model?: string;
  status: "running" | "done" | "failed" | "stopped";
  /** Left working while the conversation carried on without it. */
  background?: boolean;
  /** What it is doing right now: the harness's own progress summary, or
   *  else the latest tool it ran. */
  activity?: string;
  tokens?: number;
  /** How many tools it has run. */
  tools?: number;
  startedAt: number;
  endedAt?: number;
  /** Its final report, once it has given one. */
  result?: string;
  /** Started by the user from the chat's agents page rather than by the
   *  model: it works on its own, takes follow-ups there, and can be
   *  stopped there. */
  mine?: boolean;
  /** Not an agent at all: a shell command the model left running in the
   *  background (Claude's Bash with run_in_background). `prompt` is the
   *  command, `description` what it is for, `result` how it ended. */
  script?: true;
  /** Where the harness writes what a script prints, as it prints it —
   *  what the script's page shows. */
  output?: string;
  /** The harness's own name for the agent (Claude's task id, the one its
   *  SendMessage addresses): how a later "carry on" finds this card. */
  agentId?: string;
  /** How many times it has been picked back up after it had stopped — a
   *  failed agent the model sent on again, a finished one given more. */
  resumed?: number;
}

/** What a chat still has working with no turn running: agents left in the
 *  background (or picked back up), and scripts the model left running. */
export interface BackgroundWork {
  agents: number;
  scripts: number;
}

/** What an agent the user starts is called on its card: its brief's first
 *  line, cut to fit. */
export function briefLine(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** One line of a patch, in git's three flavours. */
export interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}

/** A run of changed lines with its surrounding context. */
export interface DiffHunk {
  /** 1-based first line of the hunk on each side (git's @@ header). */
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

/** What a Write or Edit did to one file, as the transcript renders it. */
export interface FileDiff {
  /** Project-relative where possible — the same shortening tool chips use. */
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** The file did not exist beforehand. */
  created?: boolean;
  /** Hunks were dropped to keep the transcript small. */
  truncated?: boolean;
}

export interface PermissionRequest {
  requestId: string;
  projectId: string;
  toolName: string;
  input: unknown;
  /**
   * Permission-rule updates the CLI suggests for "don't ask again" (opaque
   * Agent SDK `PermissionUpdate` objects, echoed back verbatim on always-allow).
   */
  suggestions?: unknown[];
  /**
   * "question" means this isn't an allow/deny at all — the model called
   * AskUserQuestion and `input` is an {@link AskQuestions}. It rides the
   * permission channel because that channel already survives reconnects,
   * but it answers with `question_response`, never `permission_response`.
   *
   * "component" is the same trick again: the model made something and is
   * asking what to call it. `input` is a {@link ComponentProposal}, and it
   * answers with `component_named`.
   *
   * "message" is an agent asking to message another agent (server/talk.ts)
   * outside bypass mode: `input` is a {@link TalkAsk}, and it answers with
   * `permission_response` like any allow/deny.
   */
  kind?: "permission" | "question" | "component" | "message";
  /** A question whose tool call has stopped waiting (the turn ended, or the
   *  CLI gave up on the hook): the card stays, and answering it sends the
   *  answers as a new prompt instead. */
  late?: boolean;
  /** Asked by an agent the user started (its SubagentState.key) rather
   *  than by the chat's own model — `projectId` is still the chat's. The
   *  card shows on that agent's page as well, and says whose it is. */
  agent?: string;
  ts: number;
}

/** One choice in an {@link AskQuestion}. */
export interface AskOption {
  label: string;
  description: string;
  /** Provider wire value when it differs from the human label. */
  value?: string;
  /** Mockup/snippet shown while this option is the focused one. */
  preview?: string;
}

/** A single question from AskUserQuestion. */
export interface AskQuestion {
  /** Provider field id; Claude questions use their question text instead. */
  id?: string;
  question: string;
  /** Short chip label (≤12 chars) — "Surfaces", "Approach". */
  header: string;
  options: AskOption[];
  multiSelect: boolean;
  /** Primitive form-field type for native harness/MCP input. */
  inputType?: "string" | "number" | "integer" | "boolean" | "select" | "multiselect";
  required?: boolean;
  secret?: boolean;
  allowOther?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: string | number | boolean | string[];
  hint?: string;
  /** URL elicitation target; the card opens it, then accepts confirmation. */
  url?: string;
}

/** The AskUserQuestion tool input, as the card needs it. */
export interface AskQuestions {
  questions: AskQuestion[];
}

/** What the user picked, keyed by question text — the shape the tool's
 *  own output expects, so it goes back verbatim as `updatedInput`. */
export interface AskAnswers {
  /** question text → chosen label(s); multi-select joined with ", ". */
  answers: Record<string, string>;
  /** Per-question extras: the focused option's preview, and free notes. */
  annotations?: Record<string, { preview?: string; notes?: string }>;
  /** Freeform text typed instead of picking anything. */
  response?: string;
  /** Exact picks keyed by provider field id, before labels are flattened. */
  values?: Record<string, string[]>;
}

/** What a native folder pick is for — routed back with the result. */
export type PickTarget = "workspace" | "music";

/** The macOS grants ruri uses (desktop/permissions.ts). */
export type PermissionId =
  | "accessibility"
  | "screen"
  | "automation"
  | "fullDisk"
  | "desktop"
  | "documents"
  | "downloads"
  | "removable"
  | "network";

export interface PermissionState {
  id: PermissionId;
  name: string;
  /** What ruri does with it. */
  why: string;
  /** As macOS actually holds it — "unasked" is a dialog that has never been
   *  put up, "unknown" is a state that cannot be read from here. */
  status: "granted" | "denied" | "unasked" | "unknown";
  detail?: string;
}

/** One row of the privacy database, for ruri or a CLI its sessions run. */
export interface TccRow {
  service: string;
  /** A bundle id, or the path of a bare executable. */
  client: string;
  allowed: boolean;
  /** When macOS last decided (epoch ms). */
  at: number;
}

/**
 * One coding CLI on this machine, as the updater sees it: how it was
 * installed (which is how it gets updated), what version it is and what
 * the newest is, and what the last round did about it. server/updater.ts.
 */
export interface HarnessInfo {
  id: string;
  label: string;
  path: string;
  /** "self" = its own updater (claude update, opencode upgrade); "npm" /
   *  "bun" = a global package; "brew" = a formula; "other" = not ours to
   *  update. */
  channel: "self" | "npm" | "bun" | "brew" | "other";
  /** The package (or formula) it is published as. */
  pkg?: string;
  version?: string;
  /** The newest published, when that could be read. */
  latest?: string;
  checkedAt?: number;
  /** Left to update itself (the default), or updated by hand. */
  auto?: boolean;
  /** An update is running right now. */
  updating?: boolean;
  /** When ruri last updated it, and from what. */
  updatedAt?: number;
  from?: string;
  /** Why it was not updated, when it is behind and was not. */
  note?: string;
}

/** The harnesses whose MCP servers and plugins ruri manages. */
export type IntegrationHarness = "claude" | "codex";

/** An MCP server a harness starts — one row of Settings → Integrations.
 *  What it is given (environment, headers) travels by name only. */
export interface McpServerRow {
  harness: IntegrationHarness;
  name: string;
  /** Where it is configured: Claude's user, local (this project, just you)
   *  or project (.mcp.json, shared) scope; Codex's config; or a plugin. */
  scope: "user" | "local" | "project" | "codex" | "plugin";
  /** The plugin that brings it, for scope "plugin". */
  plugin?: string;
  transport: "stdio" | "http" | "sse" | "ws";
  /** The command line it is started with, or the URL it is reached at. */
  target: string;
  env?: string[];
  headers?: string[];
  enabled: boolean;
}

/** A plugin — installed, or on offer from a marketplace. */
export interface PluginRow {
  harness: IntegrationHarness;
  /** name@marketplace, the way the CLIs name it. */
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  enabled?: boolean;
  version?: string;
  scope?: string;
  description?: string;
  installCount?: number;
}

export interface MarketplaceRow {
  harness: IntegrationHarness;
  name: string;
  /** Where it comes from: a GitHub repo, a URL, a path. */
  source: string;
}

/** Everything the harnesses have plugged in (server/integrations.ts). */
export interface Integrations {
  servers: McpServerRow[];
  plugins: PluginRow[];
  marketplaces: MarketplaceRow[];
  /** What could not be read, in words. */
  errors?: string[];
}

/** A server to add. Claude takes a scope; Codex keeps one config. */
export interface McpAdd {
  harness: IntegrationHarness;
  name: string;
  scope: "user" | "local" | "project";
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Home-agent settings (the Home composer's model/effort/permission dropdowns). */
export interface HomeSettings {
  model?: string;
  permissionMode?: PermissionMode;
  effort?: string;
}

/**
 * What the bridge is showing for one channel — the thing the session is
 * driving on the user's behalf, seen from the user's side (see
 * server/bridge.ts). One per channel: a web page in ruri's own hidden
 * window, or an app the session launched, whichever it last touched.
 */
export interface BridgeState {
  kind: "web" | "electron" | "native";
  /** The page's title, or the app's name. */
  title: string;
  /** The page's URL, or the app's path / command. */
  address: string;
  /** A scaled picture of it, served by ruri (`/bridge/preview/<id>?t=`),
   *  changing with `at` so the strip never shows a stale one. */
  previewUrl?: string;
  /** When this last changed (epoch ms). */
  at: number;
  /** The user has taken the window / app over: it is on screen, in front. */
  takenOver: boolean;
}

/** A press carrying the window: it begins, the cursor moves, it ends — or a
 *  double-click, which does what a title bar's does. */
export type WindowDragPhase = "start" | "move" | "end" | "zoom";

export type ClientMessage =
  | { type: "add_project"; name: string; path: string; folder?: string }
  | { type: "pick_folder"; target?: PickTarget }
  /** The macOS grants as they stand — no dialogs. */
  | { type: "permissions_check" }
  /** Ask macOS for one grant, or (no id) every one in turn. */
  | { type: "permissions_request"; id?: PermissionId }
  | { type: "remove_project"; projectId: string }
  /** A prompt. `now`: cut in — the running turn is stopped and this goes
   *  out in its place the moment it has, ahead of anything queued (which
   *  follows it); with nothing running it is simply sent. */
  | { type: "send"; projectId: string; text: string; attachments?: AttachmentUpload[]; now?: true }
  | { type: "send_split"; projectId: string; text: string; attachments?: AttachmentUpload[]; now?: true }
  /** Drop a prompt still waiting in the app-side queue. Editing one is this
   *  plus a compose: it leaves the queue and lands back in the composer. */
  | { type: "queue_remove"; projectId: string; itemId: string }
  /** Put a queued prompt somewhere else in the line: before `beforeId`, or
   *  at the end when that is not given. */
  | { type: "queue_move"; projectId: string; itemId: string; beforeId?: string }
  /** Fold one queued prompt into another, as one prompt standing where
   *  `intoId` stood — the two texts in the order they stood in the line,
   *  whichever was carried. Both sets of attachments come along, renumbered
   *  so the merged text still points at the right ones. */
  | { type: "queue_merge"; projectId: string; itemId: string; intoId: string }
  /** Take a fold back: the two prompts it was made of, where they stood.
   *  Nothing happens once the fold has gone out or been rewritten. */
  | { type: "queue_unmerge"; projectId: string; itemId: string }
  /** Start rewriting a queued prompt in the composer. It leaves the line
   *  for now (what is behind it moves up and goes out in its turn), and
   *  comes back with queue_update or queue_edit_cancel. */
  | { type: "queue_edit"; projectId: string; itemId: string }
  /** The rewrite is done: this is the prompt now, back in line where it
   *  was — after whichever prompts that were ahead of it are still waiting,
   *  at the front otherwise — and sent at once if nothing is running.
   *  `split` sends it the scissors way when its turn comes. */
  | {
      type: "queue_update";
      projectId: string;
      itemId: string;
      text: string;
      attachments?: AttachmentUpload[];
      split?: boolean;
    }
  /** Never mind the rewrite: the prompt steps back in line as it was. */
  | { type: "queue_edit_cancel"; projectId: string; itemId: string }
  /** Send a queue that has been standing by since a stopped turn, now —
   *  the alternative to waiting for the next prompt to pull it along. */
  | { type: "queue_send"; projectId: string }
  /** Remove a transcript event (a clicked command chip). A user event takes
   *  the rest of its turn with it. */
  | { type: "remove_event"; projectId: string; eventId: string }
  /** A subagent's own log (everything it did), for its opened card —
   *  answered with `agent_log`, then kept current by `agent_event`. */
  | { type: "agent_log"; projectId: string; key: string }
  /** Start an agent of the user's own from a chat's agents page. It works
   *  in the chat's project by itself with `text` as its brief — on `model`
   *  (the chat's when unset) at the chat's effort and permissions — and
   *  reports back on the page. `key` (`crew-…`) is the window's name for
   *  it, so the page can open onto it straight away. */
  | { type: "agent_start"; projectId: string; key: string; text: string; model?: string }
  /** Tell one of the user's own agents something more, once it is done:
   *  it picks its conversation up where it left off. */
  | { type: "agent_send"; projectId: string; key: string; text: string }
  /** Stop one of the user's own agents where it is. */
  | { type: "agent_stop"; projectId: string; key: string }
  /** Rewind to just before this user event ran. On Claude that is the
   *  conversation AND the code (it rides the CLI's file checkpoints); on
   *  every other harness it is the conversation, re-seeded from a brief,
   *  with the files left as they are. Either way the prompt itself returns
   *  to the composer, to edit and send like any other. */
  | { type: "rewind"; projectId: string; eventId: string }
  /** Fork the conversation at this prompt's exchange: a new session in
   *  the same project holding everything through this turn, carrying on
   *  from there while this one stays exactly as it is. On Claude the CLI
   *  session is forked at that point; elsewhere the new session opens on a
   *  brief of what it holds. */
  | { type: "fork"; projectId: string; eventId: string }
  /** The sessions on disk for this project that ruri did not make —
   *  answered with `recent`. */
  | { type: "recent_list"; projectId: string }
  /** A channel's whole transcript — the snapshot carries only the last
   *  TRANSCRIPT_TAIL events of each, and a chat asks for the rest when it
   *  opens. Answered with `transcript`, to the asker alone. */
  | { type: "transcript_get"; projectId: string }
  /** What this window has on screen — sent whenever it changes. Only the
   *  chats in `channels` get their conversation live (a reply's paragraphs,
   *  tool calls, agents at work, the turn's counter); every other chat gets
   *  its status and its finished turns, and catches up when it is opened.
   *  `live` false (a window nobody can see: behind another app, minimised,
   *  hidden) pauses even those. `board`: Home's
   *  projects page is up, which shows every chat's last few lines. The chats
   *  in `channels` also keep their agent process warm between turns; a chat
   *  nobody has open closes its process the moment its work is done.
   *
   *  `awake` is whether anyone is actually looking (lib/awake.ts): the
   *  window on screen and the one in use. A warm CLI is 150-400 MB and goes
   *  on costing the battery for as long as it lives, and a window nobody is
   *  looking at is nobody about to type the next prompt — so a chat open in
   *  a sleeping window holds its process for a minute rather than the ten a
   *  watched one gets, and the meters stop sampling altogether. Omitted
   *  means awake, for a client that does not say. */
  | { type: "view"; channels: string[]; live: boolean; board?: boolean; meters?: boolean; awake?: boolean }
  /** The exchanges before a chat's newest compaction — its history, which
   *  the live transcript no longer carries. Answered with `history`, to
   *  the asker alone. */
  | { type: "history_get"; projectId: string }
  /** Bring one of them in: a new session holding its conversation, which
   *  the next prompt resumes for real when the project runs on the same
   *  harness (and continues from a brief of it when it doesn't). */
  | { type: "recent_import"; projectId: string; id: string }
  /** The composer's unsent prompt for a channel (empty text and no
   *  attachments = nothing left to keep). Held server-side, so a quit does
   *  not cost a half-written prompt or the files clipped to it. */
  | {
      type: "draft";
      projectId: string;
      text: string;
      attachments?: DraftAttachmentUpload[];
    }
  | { type: "interrupt"; projectId: string }
  /* ── the composer's terminal mode: tabs of shells per channel ───── */
  /** What tabs this channel has — answered with `terminal_tabs`. */
  | { type: "terminal_list"; projectId: string }
  /** Open one more tab on this channel; the answer is the new tab list. */
  | { type: "terminal_new"; projectId: string }
  /** Start this tab's shell (or attach to the running one). */
  | { type: "terminal_open"; projectId: string; termId: string; cols: number; rows: number }
  | { type: "terminal_input"; projectId: string; termId: string; data: string }
  | { type: "terminal_resize"; projectId: string; termId: string; cols: number; rows: number }
  /** Kill it — the shell is gone and the tab with it, not just hidden. */
  | { type: "terminal_close"; projectId: string; termId: string }
  | { type: "permission_response"; requestId: string; allow: boolean; always?: boolean }
  /** The answer to an AskUserQuestion card. `answers` absent = dismissed,
   *  which lets the turn continue with the model told nothing was chosen. */
  | { type: "question_response"; requestId: string; answers?: AskAnswers }
  /** Pick a model. `projectId` is a channel — a session id or HOME_ID — and
   *  the pick is that chat's alone (it also becomes what the project's new
   *  chats start on). A bare project id is the old wholesale form: every
   *  session in the project, at once. */
  | { type: "set_model"; projectId: string; model: string }
  | { type: "set_permission_mode"; projectId: string; mode: PermissionMode }
  /** Set a chat's reasoning effort (one of EFFORT_LEVELS); same addressing. */
  | { type: "set_effort"; projectId: string; effort: string }
  /* ── the ideas board (per PROJECT id, not per session) ──────────── */
  | { type: "idea_add"; projectId: string; text: string; attachments?: AttachmentUpload[] }
  /** `attachments`, when present, is the idea's whole list: one already
   *  stored is named by its id alone, a new one comes with its bytes. */
  | {
      type: "idea_update";
      projectId: string;
      ideaId: string;
      text?: string;
      done?: boolean;
      attachments?: DraftAttachmentUpload[];
    }
  | { type: "idea_remove"; projectId: string; ideaId: string }
  /* ── the component library (per PROJECT id) ─────────────────────── */
  /** Answer a naming card: the name the user settled on, or skip. */
  | {
      type: "component_named";
      requestId: string;
      name?: string;
      files?: string[];
      note?: string;
      skip?: boolean;
    }
  | {
      type: "component_update";
      projectId: string;
      componentId: string;
      name?: string;
      slug?: string;
      aliases?: string[];
      files?: string[];
      uses?: string[];
      tags?: string[];
      deps?: string[];
      note?: string;
      /** How to find it in the running app, so it can be photographed:
       *  the selector, and optionally the route and the clicks that bring
       *  it on screen (the page types all three as one path). */
      selector?: string;
      route?: string;
      clicks?: string[];
    }
  | { type: "component_remove"; projectId: string; componentId: string }
  | { type: "component_shot"; projectId: string; componentId: string; upload: AttachmentUpload }
  | { type: "component_unshot"; projectId: string; componentId: string; shotId: string }
  /**
   * Update everything: bring the library up to date with the code, name
   * what isn't named yet, and take a picture of every entry without a
   * current one — by selector, then in a "Library pictures" chat for the
   * rest (server/handlers/components.ts). `shots: false` does everything
   * but the pictures.
   */
  | { type: "components_sweep"; projectId: string; shots?: boolean }
  /** Read the repo whole and write the project's shape again (see
   *  server/catchup.ts) — answered with `catchup` as it goes. */
  | { type: "catchup_rebuild"; projectId: string }
  /** Read the project's chats and write its working memory again (see
   *  server/memory.ts) — answered with `recall` as it goes. */
  | { type: "memory_rebuild"; projectId: string }
  /** The architecture page wants a project's sheet — answered with `sheet`. */
  | { type: "sheet_get"; projectId: string }
  /** The user correcting the memory on the page: pin a line so nothing
   *  rewrites it, unpin it, or strike it. */
  | {
      type: "memory_line";
      projectId: string;
      part: MemoryPart;
      lineId: string;
      action: "pin" | "unpin" | "remove";
    }
  /** The user's own line: a correction of `lineId`, or a new one. The
   *  user's lines are pinned. */
  | {
      type: "memory_write";
      projectId: string;
      part: MemoryPart;
      lineId?: string;
      text: string;
      why?: string;
    }
  /** The user correcting a line of the shape: `text` replaces the line at
   *  `index`, or, left out, strikes it. A map line reads "name — a, b". */
  | {
      type: "sheet_line";
      projectId: string;
      section: SheetSection;
      index: number;
      text?: string;
    }
  /** The same, for a line of one layer's sheet — or its summary, whole. */
  | {
      type: "layer_line";
      projectId: string;
      slug: string;
      section: LayerSection | "summary";
      index: number;
      text?: string;
    }
  /** The user has looked: take the star off one component, or off all of
   *  them (which is what leaving the page means). */
  | { type: "component_seen"; projectId: string; componentId?: string }
  /** Read a component's code for the library page — answered with
   *  `component_code`, to this window only. */
  | { type: "component_code"; projectId: string; componentId: string }
  /** The folder `ruri add` copies components into ("" forgets it). */
  | { type: "library_dir"; projectId: string; dir: string }
  /* ── the vault ──────────────────────────────────────────────────── */
  /** Save (or overwrite) one credential. An absent `secret` keeps the
   *  stored value and edits only the fields around it. */
  | { type: "secret_save"; id?: string; name: string; username?: string; note?: string; secret?: string }
  | { type: "secret_remove"; id: string }
  /* ── skills ─────────────────────────────────────────────────────── */
  /** Re-scan global skills and this project's local ones. */
  | { type: "skills_refresh"; projectId?: string }
  /** Every slash command that means something here, for the composer's
   *  menu — ruri's own, the harness's, skills, custom command files. */
  | { type: "commands_refresh"; projectId?: string }
  /** Park a skill in skills-off/ or bring it back. */
  | { type: "skill_toggle"; projectId?: string; scope: "global" | "project"; name: string; on: boolean }
  /** `bmo add <source>` — into ~/.claude/skills, or the project's own. */
  | { type: "skill_install"; projectId?: string; scope: "global" | "project"; source: string }
  | { type: "skill_remove"; projectId?: string; scope: "global" | "project"; name: string }
  /** `bmo update` — pull whatever the sources changed. */
  | { type: "skill_update"; projectId?: string }
  /** Read one skill's SKILL.md, for the page to render. */
  | { type: "skill_read"; projectId?: string; scope: "global" | "project"; name: string }
  | { type: "tracker_add"; projectId: string; text: string; note?: string }
  | {
      type: "tracker_update";
      projectId: string;
      itemId: string;
      status?: TrackerStatus;
      note?: string;
      text?: string;
    }
  | { type: "tracker_remove"; projectId: string; itemId: string }
  /** Attach a pasted file to a tracker item's note / remove one again. */
  | { type: "tracker_attach"; projectId: string; itemId: string; upload: AttachmentUpload }
  | { type: "tracker_detach"; projectId: string; itemId: string; attachmentId: string }
  /** Finish a tracker review: liked items clear, needs-work become repeats,
   *  and the small model writes a fix-it prompt for the composer. */
  | { type: "tracker_review"; projectId: string }
  | { type: "toggle_star"; projectId: string }
  /** Hide a project (or bring it back): it leaves the sidebar's list for
   *  the fold at the bottom, nothing about it closes. */
  | { type: "toggle_hidden"; projectId: string }
  /** Call a project what you like in the sidebar. The folder on disk is
   *  untouched; this is the name ruri shows and the Home agent answers to. */
  | { type: "rename_project"; projectId: string; name: string }
  | { type: "new_session"; projectId: string }
  | { type: "remove_session"; sessionId: string }
  /** Give a session a title by hand. The small model names a session once,
   *  from its first prompt, and never over a title that is already there —
   *  so a name given here stands. */
  | { type: "rename_session"; sessionId: string; title: string }
  | { type: "set_workspace"; path: string }
  | { type: "set_music_dir"; path: string }
  /** Cycle a model's star: none → starred → small-tasks → default → none. */
  | { type: "toggle_model_star"; model: string }
  /** Hand a role to a model outright (the tag dragged onto its row); the
   *  model is starred if it wasn't, and whoever held the role loses it. */
  | { type: "set_model_role"; model: string; role: ModelRole }
  /** Wipe the Home chat (transcript + session) — it's ephemeral. */
  | { type: "reset_home" }
  /** Re-probe every installed harness's live model catalog. */
  | { type: "refresh_models" }
  /** Look at every harness now rather than on the hour (updating the ones
   *  left to themselves) — or, with `id`, update that one now. */
  | { type: "check_harnesses"; id?: string }
  /** Leave a harness to update itself, or to the user. */
  | { type: "set_harness_auto"; id: string; auto: boolean }
  /* ── integrations: MCP servers, plugins, marketplaces ─────────────── */
  /** What the harnesses have plugged in — with a project's own servers
   *  when `projectId` names one. Answered with `integrations`. */
  | { type: "integrations_get"; projectId?: string }
  /** Plugins on offer that match `query`. Answered with `plugins_found`. */
  | { type: "plugins_search"; harness: IntegrationHarness; query: string }
  | { type: "mcp_add"; add: McpAdd; projectId?: string }
  | {
      type: "mcp_remove";
      harness: IntegrationHarness;
      name: string;
      scope: McpServerRow["scope"];
      projectId?: string;
    }
  | {
      type: "plugin_install";
      harness: IntegrationHarness;
      id: string;
      scope?: "user" | "project" | "local";
      projectId?: string;
    }
  | { type: "plugin_uninstall"; harness: IntegrationHarness; id: string }
  | { type: "plugin_enable"; id: string; enabled: boolean }
  | { type: "marketplace_add"; harness: IntegrationHarness; source: string }
  | { type: "marketplace_remove"; harness: IntegrationHarness; name: string }
  /* ── the bridge (per channel) ───────────────────────────────────── */
  /** Bring what the session is driving on screen, in front, for the user
   *  to work in. `projectId` is the channel id, as everywhere else. */
  | { type: "bridge_takeover"; projectId: string }
  /** Hide it again — the session keeps driving it. */
  | { type: "bridge_release"; projectId: string }
  /** Close it: the window is destroyed, launched apps are quit. */
  | { type: "bridge_close"; projectId: string }
  /** Keep one window preference on this machine. An empty value forgets it. */
  | { type: "set_pref"; key: string; value: string }
  /** Keep a picture for the peek band or the hero face; answered with
   *  picture_stored. */
  | { type: "store_picture"; upload: AttachmentUpload }
  /** Carry the window with the cursor, from a press on the peek band —
   *  which, while ruri is in use, sees the pointer instead of being part
   *  of the title bar's drag region. */
  | { type: "window_drag"; phase: WindowDragPhase }
  /** The talk page opened: send who may message whom, and what has been
   *  said lately. Answered with `talk`. */
  | { type: "talk_get" }
  /** The talk page's limits, whole. */
  | { type: "talk_set"; policy: TalkPolicy };

export type ServerMessage =
  | {
      type: "snapshot";
      projects: Project[];
      /** The tail of each channel's transcript (its last TRANSCRIPT_TAIL
       *  events): enough for the Home board's lines. A chat that opens
       *  asks for the whole thing (`transcript_get`). */
      transcripts: Record<string, TranscriptEvent[]>;
      statuses: Record<string, ProjectStatus>;
      /** Every chat with agents or scripts running in the background. */
      work: Record<string, BackgroundWork>;
      permissions: PermissionRequest[];
      models: ModelChoice[];
      /** Recall notes per project, keyed by the turn's user-event id. */
      summaries: Record<string, Record<string, TurnNote>>;
      /** Feature-tracker checklists per project. */
      tracker: Record<string, TrackerItem[]>;
      /** Ideas boards, keyed by PROJECT id. */
      ideas: Record<string, Idea[]>;
      /** Component libraries, keyed by PROJECT id. */
      components: Record<string, NamedComponent[]>;
      /** Where each project's library installs to, when that is set. */
      componentDirs: Record<string, string>;
      /** The vault's names (never its values). */
      secrets: SecretMeta[];
      /** App-side prompt queues per channel (visible entries only). */
      queued: Record<string, QueuedPrompt[]>;
      /** Channels whose queue is standing by, and why. */
      queuesHeld: Record<string, QueueHold>;
      /** Limit windows per provider id (empty until the first read). */
      usage: Record<string, UsageLimits>;
      /** Context occupancy per channel (Claude sessions that have run). */
      contexts: Record<string, ContextUsage>;
      /** How the turn in flight is getting on, per channel. Only channels
       *  actually running a turn are in here. */
      turns: Record<string, TurnProgress>;
      /** What each project has spent, keyed by PROJECT id (Home under its own). */
      stats: Record<string, ProjectStats>;
      /** When each project's catch-up brief was last built from the repo. */
      catchups: Record<string, { built?: number }>;
      /** Whether the host can show a native folder-picker dialog. */
      canPickFolder: boolean;
      /** Whether the host can read and ask for macOS grants (the desktop app). */
      canPermissions: boolean;
      /** The workspace root the Home agent manages (where projects live). */
      workspaceDir: string;
      /** Where the music player's playlists live. */
      musicDir: string;
      /** The Home agent's model/permission settings. */
      home: HomeSettings;
      /** Starred model ids — the composer picker shows only these. */
      starredModels: string[];
      /** The double-starred small-tasks model ("" = the built-in default). */
      smallModel: string;
      /** The model new chats and projects start on: the triple-starred one,
       *  else DEFAULT_MODEL. Always a real id, never "". */
      defaultModel: string;
      /** The local account name shown on the sidebar's account bar. */
      user: string;
      /** Every harness on this machine, as the updater last saw it. */
      harnesses: HarnessInfo[];
      /** A round of the updater is going. */
      harnessesChecking?: boolean;
      /** This machine's window preferences (theme, the theme clock, which
       *  folders are unfolded, the player's volume) — the window's own
       *  storage is a cache of these, not the other way round. */
      prefs: Record<string, string>;
      /** Unsent composer prompts per channel, waiting where they were left. */
      composerDrafts: Record<string, ComposerDraftState>;
      /** What the bridge is showing per channel (see BridgeState). */
      bridges: Record<string, BridgeState>;
      /** The agents the user started from each chat's agents page. */
      crew: Record<string, SubagentState[]>;
    }
  | { type: "projects"; projects: Project[] }
  | { type: "folder_picked"; path: string | null; target?: PickTarget }
  /** Where a store_picture is served from now — null if it could not be kept. */
  | { type: "picture_stored"; id: string; url: string | null }
  /** The grants, and the privacy database's rows behind them. */
  | { type: "permissions"; items: PermissionState[]; rows: TccRow[] }
  /** A turn's recall notes, after one half of them was written. */
  | { type: "turn_summary"; projectId: string; turnId: string; note: TurnNote }
  /** A project's ideas board. */
  | { type: "ideas"; projectId: string; items: Idea[] }
  /** A project's component library, and the folder it installs to. */
  | { type: "components"; projectId: string; items: NamedComponent[]; dir?: string }
  /** A component's code, as the library page asked for it. */
  | { type: "component_code"; projectId: string; componentId: string; files: ComponentFile[] }
  /** How the repo sweep is getting on. `busy` drives the button; `note` is
   *  the one line under it, and is what the sweep is doing right now. */
  | { type: "sweep"; projectId: string; busy: boolean; note?: string }
  /** The project's shape being rebuilt from the repo, and when the repo
   *  was last read whole for it. */
  | { type: "catchup"; projectId: string; busy: boolean; built?: number; note?: string }
  /** The project's memory being rebuilt from its chats. */
  | { type: "recall"; projectId: string; busy: boolean; note?: string }
  /** A project's sheet: to the window that asked, and to every window as
   *  it changes — with where each memory line came from, and the repo as
   *  git has it now. */
  | {
      type: "sheet";
      projectId: string;
      sheet: ProjectSheet;
      sources?: Record<string, SourceLabel>;
      git?: SheetGit;
    }
  /** The vault, names only — values never leave the server. */
  | { type: "secrets"; items: SecretMeta[] }
  /** Installed skills: every global one, plus the named project's own.
   *  `note` carries what bmo said when a command just ran. */
  | { type: "skills"; projectId?: string; skills: SkillInfo[]; note?: string; busy?: boolean }
  /** The slash commands the composer offers, for the named project. */
  | { type: "commands"; projectId?: string; commands: CommandInfo[] }
  /** One skill's SKILL.md, frontmatter stripped — markdown, to be rendered. */
  | { type: "skill_body"; name: string; scope: "global" | "project"; body: string }
  | { type: "tracker"; projectId: string; items: TrackerItem[] }
  | { type: "workspace"; path: string }
  | { type: "music_dir"; path: string }
  | { type: "home_settings"; home: HomeSettings }
  /** This machine's window preferences, after one of them changed. */
  | { type: "prefs"; prefs: Record<string, string> }
  | { type: "starred_models"; models: string[] }
  | { type: "small_model"; model: string }
  | { type: "default_model"; model: string }
  | { type: "integrations"; projectId?: string; integrations: Integrations }
  /** Who may message whom, and the latest messages between agents. */
  | { type: "talk"; policy: TalkPolicy; letters: TalkLetter[] }
  | { type: "plugins_found"; harness: IntegrationHarness; query: string; plugins: PluginRow[]; total: number }
  /** How a change to the integrations went, in words. */
  | { type: "integration_done"; ok: boolean; message: string }
  /** Every harness on this machine, as the updater last saw it —
   *  `checking` while a round is still going. */
  | { type: "harnesses"; harnesses: HarnessInfo[]; checking?: boolean }
  | { type: "home_reset" }
  /** The app-side prompt queue for a channel (visible, editable entries).
   *  `held` = standing by, and why: nothing goes out until the next prompt
   *  pulls it along, or it is sent on by hand. */
  | { type: "queued"; projectId: string; items: QueuedPrompt[]; held?: QueueHold }
  /** Transcript events were removed (a command chip was clicked away). */
  | { type: "events_removed"; projectId: string; eventIds: string[] }
  /** A whole transcript at once — a session that came into being with
   *  history already in it (a fork, an imported chat). */
  | {
      type: "transcript";
      projectId: string;
      events: TranscriptEvent[];
      summaries: Record<string, TurnNote>;
      /** The outline of what came before `events` — the exchanges the
       *  chat shows folded above its newest compaction. Absent: none. */
      earlier?: EarlierItem[];
    }
  /** A chat's history: every event before its newest compaction mark —
   *  asked for when one of its exchanges is opened in full. */
  | { type: "history"; projectId: string; events: TranscriptEvent[] }
  /** A session you asked for exists (a fork, an import) — go there. Sent
   *  to the asker alone. */
  | { type: "open_session"; projectId: string }
  /** What a project has on disk from outside ruri (see recent_list). */
  | { type: "recent"; projectId: string; items: RecentSession[] }
  /** A finished tracker review's generated prompt, for the composer. */
  | { type: "review_prompt"; projectId: string; text: string }
  /** Text for a channel's composer (a rewound prompt, back for editing). */
  | { type: "compose"; projectId: string; text: string; attachments?: Attachment[] }
  /** Fresh limit windows per provider id (the usage gauges). */
  | { type: "usage"; limits: Record<string, UsageLimits> }
  /** A channel's context occupancy changed (after an API call). */
  | { type: "context"; projectId: string; context: ContextUsage }
  /** The running turn got further along — or, with null, ended. Sent on a
   *  throttle while the turn runs, so the working line keeps its count. */
  | { type: "turn"; projectId: string; turn: TurnProgress | null }
  /** A project's spending changed (a turn finished). Keyed by PROJECT id. */
  | { type: "stats"; projectId: string; stats: ProjectStats }
  | { type: "resources"; resources: Resources }
  | { type: "event"; projectId: string; event: TranscriptEvent }
  /** A subagent's log so far (`key` is its SubagentState.key). */
  | { type: "agent_log"; projectId: string; key: string; events: TranscriptEvent[] }
  /** Something a subagent just did — for its log, never the chat. */
  | { type: "agent_event"; projectId: string; key: string; event: TranscriptEvent }
  /** The agents the user started in a chat (its crew), as they now stand. */
  | { type: "crew"; projectId: string; agents: SubagentState[] }
  | { type: "delta"; projectId: string; messageId: string; delta: string }
  /** The reply in progress as it stands, replacing whatever the window
   *  holds (null = none streaming) — for a chat that has just been opened,
   *  whose deltas went nowhere while it was not on screen. */
  | { type: "reply"; projectId: string; draft: { messageId: string; text: string } | null }
  /** Every chat's last few events, for Home's projects page as it opens:
   *  the chats not on screen stopped hearing about their work. */
  | { type: "tails"; transcripts: Record<string, TranscriptEvent[]> }
  | { type: "status"; projectId: string; status: ProjectStatus }
  /** A chat's background work changed — the agents and scripts it has
   *  running whether or not a turn is. Absent from the map = none. */
  | { type: "work"; projectId: string; work?: BackgroundWork }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "models"; models: ModelChoice[] }
  /** The bridge did something for a channel, or closed: what it is showing
   *  now, or null when there is nothing left to show. */
  | { type: "bridge"; projectId: string; state: BridgeState | null }
  /** This channel's shell tabs, in the order they are shown. */
  | { type: "terminal_tabs"; projectId: string; tabs: string[] }
  /** Shell output. `replay` marks the scrollback a fresh attach gets. */
  | { type: "terminal_data"; projectId: string; termId: string; data: string; replay?: boolean }
  | { type: "terminal_exit"; projectId: string; termId: string; note: string }
  | { type: "error"; message: string };
