/** Types (and the one shared constant) between the ruri server and the web UI. */

/** The pseudo-project id of the Home view — the workspace-manager agent. */
export const HOME_ID = "home";

/** The model a session runs on when none is picked — no ambiguous
 *  "default" entries anywhere; unset simply means Fable. */
export const DEFAULT_MODEL = "claude-fable-5[1m]";

/**
 * One live coding session inside a project. Transcripts, statuses,
 * drafts, summaries, and tracker items are keyed by the session id (the
 * protocol's `projectId` fields carry session ids for project sessions).
 */
export interface SessionInfo {
  id: string;
  /** Role title, auto-named by the small model ("Frontend UI", …). */
  title?: string;
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
  /** Model override for this project's sessions; the CLI default when unset. */
  model?: string;
  /** Permission mode for this project's sessions (default "default"). */
  permissionMode?: PermissionMode;
  /** Reasoning effort for this project's sessions (EFFORT_LEVELS);
   *  DEFAULT_EFFORT (xhigh) when unset. */
  effort?: string;
  /** Bookmarked: shown in the Starred section above the project tree. */
  starred?: boolean;
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
}

/** Wire form when sending: base64 payload plus optional region annotations. */
export interface AttachmentUpload extends Attachment {
  data: string;
  /** Region crops of an image, each numbered as the prompt's [region #n]
   *  names it (the crop carries that number drawn on it). */
  regions?: Array<{ n: number; data: string; mediaType: string }>;
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
  text: string;
  done: boolean;
  ts: number;
}

/**
 * A named piece of a project's interface: the words the user actually uses
 * for it, where it lives in the code, and what it looks like.
 *
 * The point is the gap between "the dragon gauges" and
 * `web/src/components/Dragon.tsx` — the user names things by what they see.
 * ruri keeps the index, writes it into the project as `.ruri/components.md`
 * for any harness to read, and hands the matching entries to the model
 * alongside a prompt that names one. Keyed by PROJECT id.
 */
export interface NamedComponent {
  id: string;
  /** What the user calls it. */
  name: string;
  /** Other names that mean the same thing. */
  aliases: string[];
  /** Where it lives — "web/src/components/Dragon.tsx:40" or a bare path. */
  files: string[];
  /** Anything else the model should know before touching it. */
  note: string;
  /** What it looks like. */
  shots: Attachment[];
  ts: number;
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
export interface ComponentProposal {
  /** What the model suggests calling it, in the user's kind of words. */
  name: string;
  /** Where it lives — "web/src/components/Dragon.tsx:40". */
  files: string[];
  /** One line on what it is. */
  note: string;
  /** An image of it the model already has, as an absolute path. */
  shot?: string;
}

/** An installed Claude Code skill, global or local to one project. */
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

/** A prompt held app-side until the running turn finishes (editable). */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: Attachment[];
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
  /** When this reading was taken (epoch ms). A relaunch shows the last one
   *  off disk until a fresh read lands, and the gauges say so on hover. */
  at?: number;
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
}

export type TranscriptEvent =
  | { kind: "user"; id: string; text: string; attachments?: Attachment[]; ts: number }
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
      ts: number;
    }
  | {
      kind: "result";
      id: string;
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      error?: string;
      /** The turn ended because the user pressed stop — not an error. */
      stopped?: boolean;
      ts: number;
    }
  | { kind: "info"; id: string; text: string; ts: number }
  /** A /compact point: the session restarted fresh here; `text` is the
   *  model-facing brief (summaries + full-turn file hooks) and `entries` its
   *  structured prompt/reply pairs, hidden behind the zigzag separator
   *  unless the user unfolds it. */
  | { kind: "compaction"; id: string; text: string; entries?: CompactionEntry[]; ts: number };

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
   */
  kind?: "permission" | "question" | "component";
  ts: number;
}

/** One choice in an {@link AskQuestion}. */
export interface AskOption {
  label: string;
  description: string;
  /** Mockup/snippet shown while this option is the focused one. */
  preview?: string;
}

/** A single question from AskUserQuestion. */
export interface AskQuestion {
  question: string;
  /** Short chip label (≤12 chars) — "Surfaces", "Approach". */
  header: string;
  options: AskOption[];
  multiSelect: boolean;
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
}

/** What a native folder pick is for — routed back with the result. */
export type PickTarget = "workspace" | "music";

/** Home-agent settings (the Home composer's model/effort/permission dropdowns). */
export interface HomeSettings {
  model?: string;
  permissionMode?: PermissionMode;
  effort?: string;
}

export type ClientMessage =
  | { type: "add_project"; name: string; path: string; folder?: string }
  | { type: "pick_folder"; target?: PickTarget }
  | { type: "remove_project"; projectId: string }
  | { type: "send"; projectId: string; text: string; attachments?: AttachmentUpload[] }
  | { type: "send_split"; projectId: string; text: string; attachments?: AttachmentUpload[] }
  /** Drop a prompt still waiting in the app-side queue. Editing one is this
   *  plus a compose: it leaves the queue and lands back in the composer. */
  | { type: "queue_remove"; projectId: string; itemId: string }
  /** Remove a transcript event (a clicked command chip). A user event takes
   *  the rest of its turn with it. */
  | { type: "remove_event"; projectId: string; eventId: string }
  /** Rewind to just before this user event ran. On Claude that is the
   *  conversation AND the code (it rides the CLI's file checkpoints); on
   *  every other harness it is the conversation, re-seeded from a brief,
   *  with the files left as they are. Either way the prompt itself returns
   *  to the composer, to edit and send like any other. */
  | { type: "rewind"; projectId: string; eventId: string }
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
  | { type: "set_model"; projectId: string; model: string }
  | { type: "set_permission_mode"; projectId: string; mode: PermissionMode }
  /** Set a project's reasoning effort (one of EFFORT_LEVELS). */
  | { type: "set_effort"; projectId: string; effort: string }
  /* ── the ideas board (per PROJECT id, not per session) ──────────── */
  | { type: "idea_add"; projectId: string; text: string }
  | { type: "idea_update"; projectId: string; ideaId: string; text?: string; done?: boolean }
  | { type: "idea_remove"; projectId: string; ideaId: string }
  /* ── the component index (per PROJECT id) ───────────────────────── */
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
      aliases?: string[];
      files?: string[];
      note?: string;
    }
  | { type: "component_remove"; projectId: string; componentId: string }
  | { type: "component_shot"; projectId: string; componentId: string; upload: AttachmentUpload }
  | { type: "component_unshot"; projectId: string; componentId: string; shotId: string }
  /* ── the vault ──────────────────────────────────────────────────── */
  /** Save (or overwrite) one credential. An absent `secret` keeps the
   *  stored value and edits only the fields around it. */
  | { type: "secret_save"; id?: string; name: string; username?: string; note?: string; secret?: string }
  | { type: "secret_remove"; id: string }
  /* ── skills ─────────────────────────────────────────────────────── */
  /** Re-scan global skills and this project's local ones. */
  | { type: "skills_refresh"; projectId?: string }
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
  | { type: "new_session"; projectId: string }
  | { type: "remove_session"; sessionId: string }
  | { type: "set_workspace"; path: string }
  | { type: "set_music_dir"; path: string }
  /** Cycle a model's star: none → starred → small-tasks model → none. */
  | { type: "toggle_model_star"; model: string }
  /** Wipe the Home chat (transcript + session) — it's ephemeral. */
  | { type: "reset_home" }
  /** Re-probe every installed harness's live model catalog. */
  | { type: "refresh_models" }
  /** Keep one window preference on this machine. An empty value forgets it. */
  | { type: "set_pref"; key: string; value: string };

export type ServerMessage =
  | {
      type: "snapshot";
      projects: Project[];
      transcripts: Record<string, TranscriptEvent[]>;
      statuses: Record<string, ProjectStatus>;
      permissions: PermissionRequest[];
      models: ModelChoice[];
      /** Turn summaries per project, keyed by the turn's user-event id. */
      summaries: Record<string, Record<string, string>>;
      /** Feature-tracker checklists per project. */
      tracker: Record<string, TrackerItem[]>;
      /** Ideas boards, keyed by PROJECT id. */
      ideas: Record<string, Idea[]>;
      /** Component indexes, keyed by PROJECT id. */
      components: Record<string, NamedComponent[]>;
      /** The vault's names (never its values). */
      secrets: SecretMeta[];
      /** App-side prompt queues per channel (visible entries only). */
      queued: Record<string, QueuedPrompt[]>;
      /** Limit windows per provider id (empty until the first read). */
      usage: Record<string, UsageLimits>;
      /** Context occupancy per channel (Claude sessions that have run). */
      contexts: Record<string, ContextUsage>;
      /** Whether the host can show a native folder-picker dialog. */
      canPickFolder: boolean;
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
      /** The local account name shown on the sidebar's account bar. */
      user: string;
      /** This machine's window preferences (theme, the theme clock, which
       *  folders are unfolded, the player's volume) — the window's own
       *  storage is a cache of these, not the other way round. */
      prefs: Record<string, string>;
      /** Unsent composer prompts per channel, waiting where they were left. */
      composerDrafts: Record<string, ComposerDraftState>;
    }
  | { type: "projects"; projects: Project[] }
  | { type: "folder_picked"; path: string | null; target?: PickTarget }
  | { type: "turn_summary"; projectId: string; turnId: string; summary: string }
  /** A project's ideas board. */
  | { type: "ideas"; projectId: string; items: Idea[] }
  /** A project's component index. */
  | { type: "components"; projectId: string; items: NamedComponent[] }
  /** The vault, names only — values never leave the server. */
  | { type: "secrets"; items: SecretMeta[] }
  /** Installed skills: every global one, plus the named project's own.
   *  `note` carries what bmo said when a command just ran. */
  | { type: "skills"; projectId?: string; skills: SkillInfo[]; note?: string; busy?: boolean }
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
  | { type: "home_reset" }
  /** The app-side prompt queue for a channel (visible, editable entries). */
  | { type: "queued"; projectId: string; items: QueuedPrompt[] }
  /** Transcript events were removed (a command chip was clicked away). */
  | { type: "events_removed"; projectId: string; eventIds: string[] }
  /** A finished tracker review's generated prompt, for the composer. */
  | { type: "review_prompt"; projectId: string; text: string }
  /** Text for a channel's composer (a rewound prompt, back for editing). */
  | { type: "compose"; projectId: string; text: string; attachments?: Attachment[] }
  /** Fresh limit windows per provider id (the usage gauges). */
  | { type: "usage"; limits: Record<string, UsageLimits> }
  /** A channel's context occupancy changed (after an API call). */
  | { type: "context"; projectId: string; context: ContextUsage }
  | { type: "event"; projectId: string; event: TranscriptEvent }
  | { type: "delta"; projectId: string; messageId: string; delta: string }
  | { type: "status"; projectId: string; status: ProjectStatus }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "models"; models: ModelChoice[] }
  /** This channel's shell tabs, in the order they are shown. */
  | { type: "terminal_tabs"; projectId: string; tabs: string[] }
  /** Shell output. `replay` marks the scrollback a fresh attach gets. */
  | { type: "terminal_data"; projectId: string; termId: string; data: string; replay?: boolean }
  | { type: "terminal_exit"; projectId: string; termId: string; note: string }
  | { type: "error"; message: string };
