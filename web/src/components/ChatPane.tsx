import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  EFFORT_LEVELS,
  HOME_ID,
  type ModelChoice,
  type PermissionMode,
  type PermissionRequest,
  type Project,
  type QueuedPrompt,
  type TranscriptEvent,
} from "../../../shared/protocol";
import {
  AttachmentStrip,
  cropRegion,
  fileKind,
  Viewer,
  TranscriptAttachments,
  ToolImage,
  type ComposerAttachment,
  type Region,
} from "./Attachments";
import { heroFrame } from "../peek";
import { Components } from "./Components";
import { Ideas } from "./Ideas";
import { Skills } from "./Skills";
import { DiffView } from "./Diff";
import type { RapidFire } from "./RapidFire";
import { RapidBar } from "./RapidFire";
import { BridgeStrip } from "./Bridge";
import { DragonGauges } from "./Dragon";
import { HomeBoard } from "./HomeBoard";
import {
  MarkerMirror,
  findMarkers,
  holdMarkers,
  markerText,
  releaseMarkers,
  removeMarker,
  stripMarkers,
  type Marker,
} from "./Markers";
import { SelectionFlags } from "./Selection";
import { Sketch, type SketchBackground } from "./Sketch";
import { Dropdown } from "./Dropdown";
import { NameCard } from "./NameCard";
import { QuestionCard } from "./Questions";
import { Thinking } from "./Thinking";
import { Tracker } from "./Tracker";
import { heroFor, heroUrl, launchHero } from "../hero";
import { fileToBase64 } from "../lib/files";
import { Markdown, StreamingMarkdown } from "../markdown";
import {
  clearComposerDraft,
  composeInto,
  composerDrafts,
  send,
  setComposerDraft,
  useRuri,
} from "../store";

/* The shell panel brings xterm with it — a quarter of the app's JavaScript,
   for a mode most sessions never turn on. It arrives when the `>_` button is
   pressed instead of on every launch. */
const TerminalPanel = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.TerminalPanel })),
);

/* ── small inline icons (stroke: currentColor, 14px) ─────────────── */

function Icon({ d, viewBox = "0 0 24 24" }: { d: string; viewBox?: string }) {
  return (
    <svg
      className="icon"
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const TOOL_ICONS: Record<string, string> = {
  terminal: "M4 17l6-5-6-5M12 19h8",
  file: "M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18",
  agent: "M12 8V4M8 4h8M5 12a7 7 0 0 1 14 0v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6zM9 14h.01M15 14h.01",
  tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.4-.6-.6-2.4 2.4-2.4z",
};

function toolIcon(name: string): string {
  if (name === "Bash") return TOOL_ICONS["terminal"]!;
  if (["Read", "Edit", "Write", "NotebookEdit"].includes(name)) return TOOL_ICONS["file"]!;
  if (["Glob", "Grep"].includes(name)) return TOOL_ICONS["search"]!;
  if (["WebFetch", "WebSearch"].includes(name)) return TOOL_ICONS["globe"]!;
  if (["Agent", "Task"].includes(name)) return TOOL_ICONS["agent"]!;
  return TOOL_ICONS["tool"]!;
}

/* ── transcript events ───────────────────────────────────────────── */

/** Collapse absolute in-project paths to "name/relative" at render time —
 *  the server shortens new events, but archived ones predate that, and this
 *  keeps every chip short regardless of when it was written. */
function shortenDisplay(text: string, project?: Project): string {
  const root = project?.path.replace(/\/+$/, "");
  if (!root || !project) return text;
  return text.split(`${root}/`).join(`${project.name}/`).split(root).join(project.name);
}

/** A sent slash command ("/compact", "/clear", …) — one short line, nothing
 *  but the command and its arguments. */
function isCommand(text: string): boolean {
  const t = text.trim();
  return t.length <= 80 && !t.includes("\n") && /^\/[a-z0-9_:-]+(\s|$)/i.test(t);
}

/**
 * A uniform zigzag rule — the compaction separator's tear line. Weighted to
 * read as the same hairline as the result lines' rule: 1px there is crisp,
 * but a diagonal of the same width gets spread across ~1.4 device pixels by
 * antialiasing, so the stroke is nudged up to land at the same density.
 */
function ZigzagRule() {
  const id = useId();
  return (
    <svg className="jag" aria-hidden>
      <defs>
        <pattern id={id} width="12" height="9" patternUnits="userSpaceOnUse">
          <path
            d="M0 7 L6 2 L12 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.15"
            strokeLinejoin="round"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * The compaction point: everything above went into a fresh session as a
 * brief only the model reads. The user just sees the zigzag line — the
 * label unfolds the prompt/reply notes the model was handed.
 */
function CompactionMark({ event }: { event: Extract<TranscriptEvent, { kind: "compaction" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="compaction">
      <div className="compaction-line">
        <ZigzagRule />
        <button
          className="compaction-label"
          title={open ? "Hide what the model was handed" : "Show what the model was handed"}
          onClick={() => setOpen(!open)}
        >
          <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" />
          </svg>
          compacted
        </button>
        <ZigzagRule />
      </div>
      {open &&
        (event.entries?.length ? (
          <div className="compaction-brief">
            {event.entries.map((entry, i) => (
              <div className="compaction-turn" key={i}>
                <span className="compaction-n">{i + 1}</span>
                <div className="compaction-pair">
                  <div className="compaction-you">{entry.user}</div>
                  <div className="compaction-reply">{entry.reply}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          // compactions from before the structured entries: the raw brief
          <pre className="compaction-brief raw">{event.text}</pre>
        ))}
    </div>
  );
}

/**
 * One transcript event. Memoised: an event never changes once it's written,
 * so a re-render of the pane — a delta arriving, older turns filling in
 * behind you, a status flipping — re-renders none of the ones already on
 * screen.
 */
export const EventView = memo(function EventView({
  event,
  project,
  channelId,
  onRewind,
  onFork,
}: {
  event: TranscriptEvent;
  project?: Project;
  channelId?: string;
  /** Present when this prompt can be rewound to — renders the pencil. */
  onRewind?: (event: Extract<TranscriptEvent, { kind: "user" }>) => void;
  /** Present when the conversation can be forked here — renders the branch. */
  onFork?: (event: Extract<TranscriptEvent, { kind: "user" }>) => void;
}) {
  switch (event.kind) {
    case "user":
      if (isCommand(event.text) && !event.attachments?.length) {
        return (
          <button
            className="msg command-chip"
            title="A command you ran — click to clear it from the transcript"
            onClick={() => {
              if (channelId) send({ type: "remove_event", projectId: channelId, eventId: event.id });
            }}
          >
            {event.text.trim()}
          </button>
        );
      }
      return (
        <div className="msg user">
          {onRewind && (
            <button
              className="icon-button rewind-pencil"
              title="Rewind here — the conversation returns to just before this prompt, and the prompt comes back to the composer"
              onClick={() => onRewind(event)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
          )}
          {onFork && (
            <button
              className="icon-button fork-branch"
              title="Fork here — a new chat in this project that starts from this exchange and goes its own way; this one is left exactly as it is"
              onClick={() => onFork(event)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="6" cy="4" r="2.5" />
                <circle cx="6" cy="20" r="2.5" />
                <circle cx="18" cy="8" r="2.5" />
                <path d="M6 6.5v11M18 10.5c0 4-3 5-6 5.5-2.5.4-5 1-6 2" />
              </svg>
            </button>
          )}
          <Markdown text={event.text} />
          {event.attachments && event.attachments.length > 0 && (
            <TranscriptAttachments attachments={event.attachments} />
          )}
        </div>
      );
    case "assistant":
      return (
        <div className="msg assistant">
          <Markdown text={event.text} />
        </div>
      );
    case "tool": {
      // The question itself is the card that asked it — a chip repeating the
      // questions above it says nothing the user has not just answered. The
      // event stays in the archive, so a compaction still carries the ask.
      if (event.name === "AskUserQuestion") return null;
      const summary = shortenDisplay(event.summary, project);
      const chip = (
        <div className="tool-chip" title={summary}>
          <Icon d={toolIcon(event.name)} />
          <span className="tool-name">{event.name}</span>
          <span className="tool-summary">{summary}</span>
        </div>
      );
      if (!event.image && !event.diff) return chip;
      // A patch already carries its file's name and path, in its own head and
      // along its own bottom — a chip above it would say both a second time,
      // so the diff stands on its own.
      if (event.diff && !event.image) return <DiffView diff={event.diff} />;
      // what the tool read rides under its own chip, so the path and the
      // thing it names read as one event
      return (
        <div className="tool-block">
          {chip}
          {event.image && <ToolImage image={event.image} />}
          {event.diff && <DiffView diff={event.diff} />}
        </div>
      );
    }
    case "result": {
      // the CLI reports a user abort as diagnostic soup — archived events
      // predating the server-side flag still deserve the plain reading
      const stopped = event.stopped || (event.error?.includes("[ede_diagnostic]") ?? false);
      if (stopped) {
        return (
          <div className="result-line stopped">
            <span className="result-rule" />
            <span className="result-text">
              you stopped this response
              {event.costUsd !== undefined && ` · $${event.costUsd.toFixed(4)}`}
              {event.durationMs !== undefined && ` · ${(event.durationMs / 1000).toFixed(1)}s`}
            </span>
            <span className="result-rule" />
          </div>
        );
      }
      return event.ok ? (
        <div className="result-line ok">
          <span className="result-rule" />
          <span className="result-text">
            <Icon d="M20 6L9 17l-5-5" />
            done
            {event.costUsd !== undefined && ` · $${event.costUsd.toFixed(4)}`}
            {event.durationMs !== undefined && ` · ${(event.durationMs / 1000).toFixed(1)}s`}
          </span>
          <span className="result-rule" />
        </div>
      ) : (
        <div className="result-line err">
          <span className="result-rule" />
          <span className="result-text">
            <Icon d="M18 6L6 18M6 6l12 12" />
            {event.error ?? "error"}
          </span>
          <span className="result-rule" />
        </div>
      );
    }
    case "info":
      return <div className="info-line">{event.text}</div>;
    case "compaction":
      return <CompactionMark event={event} />;
  }
});

/* ── permissions ─────────────────────────────────────────────────── */

function permissionSummary(
  request: PermissionRequest,
  /** Whoever is asking — the harness this channel runs on. */
  asker: string,
): { title: string; body: React.ReactNode } {
  const input = (request.input ?? {}) as Record<string, unknown>;
  if (request.toolName === "ExitPlanMode" && typeof input["plan"] === "string") {
    return {
      title: `${asker} finished planning and wants to start building`,
      body: (
        <div className="permission-plan">
          <Markdown text={input["plan"] as string} />
        </div>
      ),
    };
  }
  const detail =
    typeof input["command"] === "string"
      ? (input["command"] as string)
      : typeof input["file_path"] === "string"
        ? (input["file_path"] as string)
        : undefined;
  return {
    title: `${asker} wants to use ${request.toolName}`,
    body: <pre className="permission-input">{detail ?? JSON.stringify(request.input, null, 2)}</pre>,
  };
}

/** The name to put on a card asking for permission: the harness the channel
 *  runs on, since it is the one asking — not Claude by default. */
function harnessName(models: ModelChoice[], model: string | undefined): string {
  const choice = models.find((m) => m.value === (model || DEFAULT_MODEL));
  return choice?.providerLabel ?? "Claude";
}

export function PermissionBanner({ request }: { request: PermissionRequest }) {
  const models = useRuri((s) => s.models);
  const model = useRuri(
    (s) =>
      s.projects.find((p) => p.sessions.some((x) => x.id === request.projectId))?.model ??
      (request.projectId === HOME_ID ? s.home.model : undefined),
  );
  const { title, body } = permissionSummary(request, harnessName(models, model));
  const respond = (allow: boolean, always = false) =>
    send({ type: "permission_response", requestId: request.requestId, allow, always });
  return (
    <div className="permission-card">
      <div className="permission-head">
        <span className="permission-badge">
          <Icon d={toolIcon(request.toolName)} />
          {request.toolName}
        </span>
        {title}
      </div>
      {body}
      <div className="permission-actions">
        <button className="primary" onClick={() => respond(true)}>
          Allow
        </button>
        <button onClick={() => respond(true, true)}>Always allow</button>
        <button className="ghost" onClick={() => respond(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/* ── header controls ─────────────────────────────────────────────── */

const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "Ask first" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "bypassPermissions", label: "Bypass" },
];

// no "default" entry — an unset effort simply IS xhigh (DEFAULT_EFFORT)
const EFFORT_OPTIONS = EFFORT_LEVELS.map((level) => ({
  value: level,
  label: level === "xhigh" ? "XHigh" : level[0]!.toUpperCase() + level.slice(1),
}));

function SessionControls({ project }: { project: Project }) {
  const allModels = useRuri((s) => s.models);
  const starredIds = useRuri((s) => s.starredModels);
  // An unset model IS Fable — there is no ambiguous "default" entry.
  const current = project.model || DEFAULT_MODEL;
  // The picker shows starred models only (Settings holds the full catalog);
  // with nothing starred yet it falls back to everything. The current pick
  // stays listed even if it was unstarred since.
  const starred = allModels.filter((m) => starredIds.includes(m.value));
  const models = [...(starred.length > 0 ? starred : allModels)];
  const selected = allModels.find((m) => m.value === current);
  if (selected && !models.includes(selected)) models.push(selected);
  // before the catalog arrives, the trigger still needs a label
  if (!selected) models.push({ value: DEFAULT_MODEL, displayName: "Fable 5" });
  // The dropdown shows wherever the mode can actually be honoured: Claude,
  // and any harness running a real agentic session (its sandbox or session
  // mode is set from this). A run-per-turn provider has no approval flow to
  // drive, so it still hides rather than offer a control that does nothing.
  const canSetPermissions = !selected?.provider || selected.agentic === true;
  return (
    <div className="composer-controls">
      <Dropdown
        up
        title="Model for this project's sessions — star models in Settings to curate this list"
        value={current}
        options={models.map((m) => ({
          // the model's own name only — which harness serves it is the
          // Settings catalog's business, not the picker's
          value: m.value,
          label: m.displayName,
        }))}
        onSelect={(model) => send({ type: "set_model", projectId: project.id, model })}
      />
      <Dropdown
        up
        title="Reasoning effort — reaches warm sessions on their next prompt (context resumes)"
        value={project.effort || DEFAULT_EFFORT}
        options={EFFORT_OPTIONS}
        onSelect={(effort) => send({ type: "set_effort", projectId: project.id, effort })}
      />
      {canSetPermissions && (
        <Dropdown
          up
          title="Permission mode"
          value={project.permissionMode ?? DEFAULT_PERMISSION_MODE}
          options={PERMISSION_MODES}
          onSelect={(mode) =>
            send({ type: "set_permission_mode", projectId: project.id, mode: mode as PermissionMode })
          }
        />
      )}
    </div>
  );
}

/* ── composer ────────────────────────────────────────────────────── */

export function Composer({
  channelId,
  project,
  busy,
  onSent,
  onSketch,
}: {
  /** The session (or Home) this composer sends to. */
  channelId: string;
  project: Project;
  busy: boolean;
  /** Fires right after a prompt goes out (rapid fire advances on it). */
  onSent?: () => void;
  /** Open the sketch pad — blank, or on one of the attached pictures. */
  onSketch?: (background?: SketchBackground) => void;
}) {
  const projectId = channelId;
  const saved = composerDrafts.get(channelId);
  const [text, setText] = useState(holdMarkers(saved?.text ?? ""));
  const [atts, setAtts] = useState<ComposerAttachment[]>(saved?.atts ?? []);
  const [viewing, setViewing] = useState<string | null>(null);
  /** The attachment whose chip the pointer is over — lit in the strip, so
   *  a chip and its thumbnail read as one thing. */
  const [hot, setHot] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** The box has two modes: writing a prompt, and a shell in the project's
   *  directory. The shell keeps running either way — this only decides
   *  which one the box is showing. */
  const [shell, setShell] = useState(false);
  const counter = useRef(saved?.counter ?? { image: 0, video: 0, file: 0, region: 0 });
  /** Where the caret was last seen in the prompt — a marker drawn in the
   *  viewer lands there, since the textarea lost focus to the overlay. */
  const caretRef = useRef(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const draftBump = useRuri((s) => s.draftBumps[channelId] ?? 0);
  const bumpSeen = useRef(draftBump);

  // Every keystroke and attachment change lands in the per-channel draft —
  // and on disk, so a half-written prompt is still there after a ⌘Q.
  useEffect(() => {
    setComposerDraft(channelId, { text, atts, counter: counter.current });
  }, [channelId, text, atts]);

  /** Attach files; `at` places the [markers] at that text index (a drop's
   *  caret position or the paste caret) instead of the end. */
  const addFiles = (files: FileList | File[], at?: number) => {
    const added: ComposerAttachment[] = [];
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        alert(`${file.name} is over 25MB — too big to attach.`);
        continue;
      }
      const kind = fileKind(file);
      const n = ++counter.current[kind];
      added.push({
        id: crypto.randomUUID(),
        file,
        kind,
        mediaType: file.type || "application/octet-stream",
        name: file.name,
        n,
        objectUrl: URL.createObjectURL(file),
        regions: [],
      });
    }
    if (added.length === 0) return;
    setAtts((prev) => [...prev, ...added]);
    insertMarkers(added.map((a) => markerText(a.kind, a.n)).join(" "), at);
  };

  /** Drop marker text into the prompt at `at` (the end when unset), leaving
   *  the prompt's own text — trailing newlines included — untouched: only
   *  the spaces around the marker, so typing never sticks to a "]" or "[". */
  const insertMarkers = (markers: string, at?: number) => {
    setText((prev) => {
      const idx = at === undefined ? prev.length : Math.min(at, prev.length);
      const before = prev.slice(0, idx);
      const after = prev.slice(idx);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const tail = /^\s/.test(after) ? "" : " ";
      // the caret follows the marker, so the next one lands after it
      caretRef.current = before.length + lead.length + markers.length + tail.length;
      return `${before}${lead}${markers}${tail}${after}`;
    });
  };

  /** A box drawn in the viewer: it takes the next region number in this
   *  prompt and its marker lands where the caret was, so what you have to
   *  say about it is written in the prompt like anything else. */
  const addRegion = (attId: string, rect: { x: number; y: number; w: number; h: number }) => {
    const n = ++counter.current.region;
    setAtts((prev) =>
      prev.map((a) => (a.id === attId ? { ...a, regions: [...a.regions, { ...rect, n }] } : a)),
    );
    insertMarkers(markerText("region", n), caretRef.current);
  };

  // The drop point as a text index — computed ONCE, at drop time. (Never
  // call this from dragover: hit-testing on every drag frame can wedge
  // Chromium's drag session so the drop never fires at all.)
  const caretFromPoint = (x: number, y: number): number | null => {
    try {
      const area = areaRef.current;
      const doc = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      if (!area || !doc.caretPositionFromPoint) return null;
      const pos = doc.caretPositionFromPoint(x, y);
      if (!pos) return null;
      // Chromium reports a caret inside a text control as (the control, offset)
      if (pos.offsetNode === area || area.contains(pos.offsetNode)) {
        return Math.min(pos.offset, area.value.length);
      }
      return null;
    } catch {
      // best-effort — a failed lookup just appends at the end
      return null;
    }
  };

  /** An attachment goes, and every marker that stood for it goes with it —
   *  its own, and those of the regions drawn on it. Words that pointed at
   *  a picture that is no longer there would only mislead. */
  const removeAtt = (id: string) => {
    const target = atts.find((a) => a.id === id);
    if (!target) return;
    URL.revokeObjectURL(target.objectUrl);
    const regions = new Set(target.regions.map((r) => r.n));
    setAtts((prev) => prev.filter((a) => a.id !== id));
    setText((prev) =>
      stripMarkers(
        prev,
        (m) => (m.kind === target.kind && m.n === target.n) || (m.kind === "region" && regions.has(m.n)),
      ),
    );
    if (hot === id) setHot(null);
  };

  /** The viewer took a region off a picture: its marker leaves the prompt. */
  const setRegions = (id: string, regions: Region[]) => {
    const kept = new Set(regions.map((r) => r.n));
    const gone = new Set(
      (atts.find((a) => a.id === id)?.regions ?? []).map((r) => r.n).filter((n) => !kept.has(n)),
    );
    setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, regions } : a)));
    if (gone.size) setText((prev) => stripMarkers(prev, (m) => m.kind === "region" && gone.has(m.n)));
  };

  /** The attachment a marker stands for: its own, or the one a region was
   *  drawn on. */
  const attachmentFor = (marker: Marker): ComposerAttachment | undefined =>
    marker.kind === "region"
      ? atts.find((a) => a.regions.some((r) => r.n === marker.n))
      : atts.find((a) => a.kind === marker.kind && a.n === marker.n);

  /** A chip was clicked: a command leaves the prompt, an attachment's chip
   *  opens the attachment — the same viewer its thumbnail opens. */
  const openMarker = (marker: Marker) => {
    if (marker.kind === "command") {
      const next = removeMarker(text, marker);
      setText(next.text);
      placeCaret(next.caret);
      return;
    }
    const att = attachmentFor(marker);
    if (!att) return;
    caretRef.current = marker.end;
    setViewing(att.id);
  };

  /** Backspace right after a chip (or inside one), Delete right before:
   *  the whole marker goes, never half of it. */
  const deleteMarkerAt = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const area = e.currentTarget;
    if (area.selectionStart !== area.selectionEnd) return false;
    const at = area.selectionStart;
    const hit = findMarkers(text)
      .filter(markerPresent)
      .find((m) => (e.key === "Backspace" ? at > m.start && at <= m.end : at >= m.start && at < m.end));
    if (!hit) return false;
    const next = removeMarker(text, hit);
    setText(next.text);
    placeCaret(next.caret);
    return true;
  };

  // The markers in the prompt draw as chips over the textarea (see
  // Markers.tsx) — only while they stand for something in the strip: a
  // marker whose file was removed is words again.
  const markerPresent = useCallback(
    (marker: Marker) =>
      marker.kind === "command"
        ? true
        : marker.kind === "region"
          ? atts.some((a) => a.regions.some((r) => r.n === marker.n))
          : atts.some((a) => a.kind === marker.kind && a.n === marker.n),
    [atts],
  );
  const placeCaret = (index: number) => {
    caretRef.current = index;
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(index, index);
    });
  };

  const autosize = () => {
    const area = areaRef.current;
    if (!area) return;
    // Reading scrollHeight forces the browser to lay the whole page out, and
    // this runs on every mount — including the one a session switch causes,
    // where the box is usually empty and the answer is always one row. So an
    // empty box skips the measurement entirely and the switch skips a reflow.
    if (!area.value) {
      area.style.height = "";
      return;
    }
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  };

  // The draft changed from outside (a review's fix-it prompt, a rewound
  // prompt, a saved draft's files arriving after a launch): the map is the
  // source of truth — re-read it, attachments and marker numbering included.
  useEffect(() => {
    if (draftBump === bumpSeen.current) return;
    bumpSeen.current = draftBump;
    const fresh = composerDrafts.get(channelId);
    if (!fresh) return;
    const held = holdMarkers(fresh.text);
    if (held !== text) setText(held);
    setAtts((prev) => (prev === fresh.atts ? prev : fresh.atts));
    counter.current = fresh.counter;
    requestAnimationFrame(() => areaRef.current?.focus());
  }, [draftBump, channelId, text]);

  const submit = async (mode: "send" | "send_split" = "send") => {
    const trimmed = releaseMarkers(text).trim();
    if (!trimmed && atts.length === 0) return;
    const uploads = await Promise.all(
      atts.map(async (att) => ({
        id: att.id,
        kind: att.kind,
        mediaType: att.mediaType,
        name: att.name,
        n: att.n,
        data: await fileToBase64(att.file),
        ...(att.regions.length
          ? {
              regions: await Promise.all(
                att.regions.map(async (region) => ({
                  n: region.n,
                  data: await cropRegion(att.objectUrl, region),
                  mediaType: "image/png",
                  rect: { x: region.x, y: region.y, w: region.w, h: region.h },
                })),
              ),
            }
          : {}),
      })),
    );
    send({
      type: mode,
      projectId,
      text: trimmed,
      ...(uploads.length ? { attachments: uploads } : {}),
    });
    for (const att of atts) URL.revokeObjectURL(att.objectUrl);
    clearComposerDraft(channelId);
    setAtts([]);
    setText("");
    onSent?.();
  };

  // Fit the height after every committed text change — mount (restored
  // drafts), typing, marker drops, seeds, and the post-send clear. A layout
  // effect, so it measures the DOM *after* React writes the new value (a
  // rAF here could fire first and measure the stale text, leaving a sent
  // long prompt's height behind).
  useLayoutEffect(autosize, [text]);

  /** The box as it was when the shell took its place: the caret, the
   *  scroll. The textarea is unmounted while the shell shows, and a fresh
   *  one comes up one row tall with the caret at the start — so on the
   *  way back it is measured again and put back exactly where it was. */
  const held = useRef<{ start: number; end: number; top: number } | null>(null);
  const toggleShell = () => {
    const area = areaRef.current;
    if (!shell && area) held.current = { start: area.selectionStart, end: area.selectionEnd, top: area.scrollTop };
    setShell(!shell);
  };
  useLayoutEffect(() => {
    if (shell) return;
    autosize();
    const was = held.current;
    const area = areaRef.current;
    if (!was || !area) return;
    held.current = null;
    area.focus();
    area.setSelectionRange(was.start, was.end);
    area.scrollTop = was.top;
    caretRef.current = was.start;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell]);

  const viewingAtt = atts.find((a) => a.id === viewing);

  return (
    <div className="composer">
      <div className="composer-row">
        <DragonGauges channelId={channelId} model={project.model} side="left" />
        <div
          className={`composer-box ${dragOver ? "drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files, caretFromPoint(e.clientX, e.clientY) ?? undefined);
          }}
        >
          {shell && (
            <Suspense fallback={<div className="terminal" />}>
              <TerminalPanel channelId={channelId} />
            </Suspense>
          )}
          {!shell && (
            <AttachmentStrip
              attachments={atts}
              highlight={hot}
              onRemove={removeAtt}
              onView={(a) => {
                // the caret as the prompt last had it — the viewer is about
                // to take focus, and a region drawn in there lands right here
                caretRef.current = areaRef.current?.selectionStart ?? text.length;
                setViewing(a.id);
              }}
            />
          )}
          {!shell && (
          <div className="composer-field">
          <textarea
            ref={areaRef}
            rows={1}
            placeholder="Message ruri…"
            value={text}
            onChange={(e) => {
              caretRef.current = e.target.selectionStart;
              setText(holdMarkers(e.target.value));
            }}
            // wherever the caret was when the viewer took focus is where a
            // region's marker goes
            onSelect={(e) => {
              caretRef.current = e.currentTarget.selectionStart;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
                return;
              }
              if ((e.key === "Backspace" || e.key === "Delete") && deleteMarkerAt(e)) e.preventDefault();
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length > 0) {
                e.preventDefault();
                addFiles(files, areaRef.current?.selectionStart ?? undefined);
              }
            }}
          />
          <MarkerMirror
            areaRef={areaRef}
            text={text}
            present={markerPresent}
            onMove={(next) => {
              setText(next.text);
              placeCaret(next.caret);
            }}
            onOpen={openMarker}
            onHover={(marker) => setHot(marker ? (attachmentFor(marker)?.id ?? null) : null)}
          />
          </div>
          )}
          <div className="composer-bar">
            {shell ? <span className="shell-where">{project.name} · shell</span> : <SessionControls project={project} />}
            <div className="composer-actions">
              <button
                className={`shell-toggle ${shell ? "active" : ""}`}
                title={shell ? "Back to writing a prompt" : "A shell in this project's directory"}
                onClick={toggleShell}
              >
                <Icon d={shell ? "M4 6h16M4 12h10M4 18h16" : "M4 17l6-6-6-6M12 19h8"} />
              </button>
              {!shell && onSketch && (
                <button
                  className="sketch-toggle"
                  title="Draw — a sketch to show the model, or open a picture to draw on"
                  onClick={() => onSketch()}
                >
                  <Icon d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </button>
              )}
              {busy && !shell && (
                <button
                  className="stop"
                  title="Interrupt the running turn"
                  onClick={() => send({ type: "interrupt", projectId })}
                >
                  <svg className="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              )}
              {!shell && (
                <button
                  className="split-send"
                  title="Split into separate prompts and send them one by one"
                  onClick={() => void submit("send_split")}
                  disabled={!text.trim()}
                >
                  <Icon d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.6 15.4M14.7 14.7L20 20M8.6 8.6L12 12" />
                </button>
              )}
              {!shell && (
                <button
                  className="send"
                  title="Send (Enter)"
                  onClick={() => void submit()}
                  disabled={!text.trim() && atts.length === 0}
                >
                  <Icon d="M12 19V5M5 12l7-7 7 7" />
                </button>
              )}
            </div>
          </div>
        </div>
        <DragonGauges channelId={channelId} model={project.model} side="right" />
      </div>
      <div className="composer-hint">
        {shell
          ? "Shells in this project — ⌘T for another, ⌘1–9 to switch · they keep running while you're away"
          : "Enter to send · Shift+Enter for a new line · drop images, videos, or files to attach · scissors to split a long prompt"}
      </div>
      {viewingAtt && (
        <Viewer
          target={{
            kind: viewingAtt.kind,
            src: viewingAtt.objectUrl,
            label: `${viewingAtt.kind} #${viewingAtt.n} — ${viewingAtt.name}`,
            name: viewingAtt.name,
            mediaType: viewingAtt.mediaType,
            attachment: viewingAtt,
          }}
          onClose={() => setViewing(null)}
          onRegions={setRegions}
          onRegionAdd={addRegion}
          {...(onSketch && viewingAtt.kind === "image"
            ? {
                onDraw: () => {
                  setViewing(null);
                  onSketch({ id: viewingAtt.id, url: viewingAtt.objectUrl, name: viewingAtt.name });
                },
              }
            : {})}
        />
      )}
    </div>
  );
}

/* ── queued prompts ──────────────────────────────────────────────── */

/**
 * A prompt held app-side while a turn runs — nothing reaches the harness
 * until its turn comes. Editable and removable right up to dispatch.
 */
function QueuedCard({ projectId, item }: { projectId: string; item: QueuedPrompt }) {
  // Editing takes the prompt out of the queue and puts it back in the
  // composer — the box you wrote it in, with its attachments, not a second
  // one embedded in the card. Sending it queues it again.
  const edit = () => {
    send({ type: "queue_remove", projectId, itemId: item.id });
    composeInto(projectId, item.text, item.attachments);
  };

  return (
    <div className="queued-card">
      <div className="queued-head">
        <span className="queued-label">queued</span>
        <span className="queued-actions">
          <button
            className="icon-button"
            title="Edit — takes it out of the queue and back into the composer"
            onClick={edit}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </button>
          <button
            className="icon-button"
            title="Remove from the queue"
            onClick={() => send({ type: "queue_remove", projectId, itemId: item.id })}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      <div className="queued-text">{item.text}</div>
      {item.attachments && item.attachments.length > 0 && (
        <TranscriptAttachments attachments={item.attachments} />
      )}
    </div>
  );
}

/* ── turns & instant compaction ──────────────────────────────────── */

interface Turn {
  /** The opening user-event id, or "pre" for events before any prompt. */
  turnId: string;
  events: TranscriptEvent[];
  /** A compaction mark stands alone — it never folds or hosts other events. */
  solo?: boolean;
}

/** Group the flat event stream into prompt→result turns. */
/** Turns rendered before the first paint — more than fills a screen; the
 *  rest arrive behind it. */
const FIRST_TURNS = 6;
/** How many more each pass adds. */
const TURN_STEP = 30;
/** How long the pane gets to itself before the filling in starts. */
const SETTLE_MS = 120;
/** How long after a gesture a scroll still counts as the user's doing. */
const GESTURE_MS = 700;
/** Frames a freshly opened session is held at its bottom while it settles. */
const SETTLE_FRAMES = 8;
/** Turns at the tail that are always laid out for real: a session opens at
 *  its bottom, and the bottom cannot be an estimate. */
const LIVE_TURNS = 4;
/** Where the quiet filling stops. Past this, turns arrive because you
 *  scrolled back for them — a pane that has quietly materialised its whole
 *  history is a pane that costs that much to take down again on the way
 *  out, and leaving a session is as common as entering one. */
const IDLE_CAP = 14;

function groupTurns(events: TranscriptEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    const last = turns[turns.length - 1];
    if (event.kind === "compaction") {
      turns.push({ turnId: `compaction-${event.id}`, events: [event], solo: true });
    } else if (event.kind === "user" || !last || last.solo) {
      turns.push({ turnId: event.kind === "user" ? event.id : `pre-${event.id}`, events: [event] });
    } else {
      last.events.push(event);
    }
  }
  return turns;
}

/**
 * A turn folded down to its recall note — only ever by the user's hand (the
 * hover chevron); clicking it pulls the full prompt/response back.
 */
function CompactTurn({ summary, count, onExpand }: { summary: string; count: number; onExpand(): void }) {
  return (
    <button className="turn-compact" title="Show the full turn" onClick={onExpand}>
      <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 6l6 6-6 6" />
      </svg>
      <span className="turn-compact-summary">{summary}</span>
      <span className="turn-compact-count">{count}</span>
    </button>
  );
}

/** A hero face in its circle, framed the way the tuner left it. */
function HeroFace({ n }: { n: number }) {
  const frame = heroFrame(n);
  return (
    <div className="hero-frame">
      <img
        className="hero-face"
        src={heroUrl(n)}
        alt=""
        style={{
          left: `calc(50% + ${frame.x}%)`,
          top: `calc(50% + ${frame.y}%)`,
          transform: `translate(-50%, -50%) scale(${frame.zoom})`,
        }}
      />
    </div>
  );
}

/* ── chat pane ───────────────────────────────────────────────────── */

// Stable fallback so selectors never mint a fresh reference per read —
// an unstable snapshot makes useSyncExternalStore loop (React error #185).
const NO_EVENTS: TranscriptEvent[] = [];
const NO_SUMMARIES: Record<string, string> = {};
const NO_QUEUED: QueuedPrompt[] = [];

export function ChatPane({
  channelId,
  rapid,
}: {
  /** The channel to show, when it isn't the app's active one — rapid fire
   *  hands it the session it has picked, leaving the sidebar where it is. */
  channelId?: string;
  rapid?: RapidFire;
} = {}) {
  const storeActive = useRuri((s) => s.activeId);
  const activeId = channelId ?? storeActive;
  const storeProject = useRuri((s) =>
    activeId ? s.projects.find((p) => p.sessions.some((x) => x.id === activeId)) : undefined,
  );
  const workspaceDir = useRuri((s) => s.workspaceDir);
  const home = useRuri((s) => s.home);
  const isHome = activeId === HOME_ID;
  const session = storeProject?.sessions.find((x) => x.id === activeId);
  const project: Project | undefined = isHome
    ? { id: HOME_ID, name: "ruri", path: workspaceDir, sessions: [], ...home }
    : storeProject;
  const transcript = useRuri((s) => (activeId ? (s.transcripts[activeId] ?? NO_EVENTS) : NO_EVENTS));
  const draft = useRuri((s) => (activeId ? s.drafts[activeId] : undefined));
  const status = useRuri((s) => (activeId ? (s.statuses[activeId] ?? "idle") : "idle"));
  const summaries = useRuri((s) =>
    activeId ? (s.summaries[activeId] ?? NO_SUMMARIES) : NO_SUMMARIES,
  );
  const queuedItems = useRuri((s) => (activeId ? (s.queued[activeId] ?? NO_QUEUED) : NO_QUEUED));
  const allPermissions = useRuri((s) => s.permissions);
  const permissions = allPermissions.filter((p) => p.projectId === activeId);
  const lastError = useRuri((s) => s.lastError);
  const dismissError = useRuri((s) => s.dismissError);

  // Native-picker results land here (always mounted) and route by target.
  const picked = useRuri((s) => s.picked);
  const clearPicked = useRuri((s) => s.clearPicked);
  useEffect(() => {
    if (!picked) return;
    send(
      picked.target === "music"
        ? { type: "set_music_dir", path: picked.path }
        : { type: "set_workspace", path: picked.path },
    );
    clearPicked();
  }, [picked, clearPicked]);

  // Rapid fire's card fades in as it takes over and out as it hands on —
  // the pane is the same one either way, so the classes ride on it.
  const pane = (base: string) =>
    rapid?.on ? `${base} rapid-page${rapid.leaving ? " rapid-leaving" : ""}` : base;

  const trackerItems = useRuri((s) => (activeId ? s.tracker[activeId] : undefined));
  /**
   * The pane shows one thing at a time: the chat, or one of the project's
   * pages. No navigation and no overlay — the header's buttons swap this,
   * and pressing the lit one swaps it back.
   */
  const [page, setPage] = useState<"chat" | "tracker" | "ideas" | "components" | "skills">("chat");
  const openCount = (trackerItems ?? []).filter((i) => i.status === "open").length;
  const boardId = storeProject?.id;
  // a number, not the list: a selector that mints a fresh array every read
  // spins useSyncExternalStore forever (React error #185)
  const ideaCount = useRuri((s) =>
    boardId ? (s.ideas[boardId] ?? []).filter((i) => !i.done).length : 0,
  );
  // Components named since the user last looked. The button wears a star
  // for them, which is how you find out a turn named something without
  // being taken anywhere: the cards themselves are one click away.
  const freshComponents = useRuri((s) =>
    boardId ? (s.components[boardId] ?? []).filter((i) => i.star).length : 0,
  );

  // Sending a prompt extracts tracker items, but it does not yank you onto
  // the tracker page to look at them — the toggle's badge is the whole
  // notification. Switching channels still lands you back on the chat.
  useEffect(() => {
    setPage("chat");
  }, [activeId]);

  // Turns show in full — the summaries are the model's memory aid, not the
  // user's view. A hover chevron folds a turn to its note when wanted.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => setFolded(new Set()), [activeId]);

  // Rewind: pencil on a past prompt → a plain confirmation → the
  // conversation and the project's files go back to just before it ran and
  // the prompt lands in the composer, exactly as it was written. Editing it
  // is then just typing; nothing sends until you press send. Claude sessions
  // only (file checkpoints), and only while nothing is running.
  const models = useRuri((s) => s.models);
  const [rewindTarget, setRewindTarget] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => setRewindTarget(null), [activeId]);

  // The sketch pad takes the pane, like a page — blank, or on a picture
  // from the composer's strip. Leaving the channel leaves the pad.
  const [sketch, setSketch] = useState<{ background?: SketchBackground } | null>(null);
  useEffect(() => setSketch(null), [activeId]);
  const openSketch = useCallback((background?: SketchBackground) => setSketch(background ? { background } : {}), []);

  /**
   * How much of the transcript is on screen. A long session is hundreds of
   * messages of markdown, code and patches, and rendering all of it before
   * the first paint is what made switching sessions feel slow. The tail
   * paints immediately — that's what you're looking at — and the rest fills
   * in on idle frames behind it, so scrolling up finds it already there.
   */
  const [renderedTurns, setRenderedTurns] = useState(FIRST_TURNS);
  useEffect(() => setRenderedTurns(FIRST_TURNS), [activeId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // The rest of the transcript, a chunk at a time, on frames the app has
  // nothing better to do with. It lands above what you're reading, which the
  // browser's scroll anchoring holds in place. The wait before each pass is
  // what keeps it out of the way: the switch paints first, and a switch that
  // happens mid-fill cancels the fill rather than competing with it.
  useEffect(() => {
    if (renderedTurns >= transcript.length || renderedTurns >= IDLE_CAP) return;
    let idle = 0;
    const grow = () => setRenderedTurns((shown) => shown + TURN_STEP);
    const settle = setTimeout(() => {
      idle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(grow, { timeout: 3000 })
          : window.setTimeout(grow, 0);
    }, SETTLE_MS);
    return () => {
      clearTimeout(settle);
      if (!idle) return;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [renderedTurns, transcript.length, activeId]);

  /**
   * Put the view back on the newest message.
   *
   * Always now, never on the next frame, and never skipped because something
   * else already did it this frame. Both of those are tempting — reading
   * scrollHeight forces a layout of the whole transcript, and four things
   * ask for this — and both cost a frame painted at the wrong offset, which
   * is the flash on every session switch. The callers that matter run after
   * layout and before paint precisely so the correction lands invisibly; the
   * cheap part is the early return below, when the view is already there.
   */
  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 1) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  /** The observers below are made once and outlive every render, so they
   *  reach the current scroller through here rather than closing over it. */
  const bottomRef = useRef<(() => void) | null>(null);
  bottomRef.current = () => scrollToBottom();

  /**
   * When the view was last moved by a human.
   *
   * Half the scroll events in a session are nobody's doing: turns land above
   * what's rendered, markdown reflows, images decode, the composer changes
   * height. Reading "am I at the bottom?" off those and believing it is what
   * left a freshly opened session parked in the middle of itself — one racy
   * measurement during the switch set pinned to false, and from then on
   * nothing would re-bottom it.
   *
   * So only a gesture may unpin the view. Everything else may re-pin it, and
   * may never do the opposite.
   */
  const gestureRef = useRef(0);
  const noteGesture = () => {
    gestureRef.current = Date.now();
  };
  /** Where the view was last time, so a move upward can be recognised. */
  const lastTopRef = useRef(0);
  /** Whether this visit to the top has already asked for more turns. */
  const grewAtTop = useRef(false);

  // Scroll events arrive faster than the answer can change, and each one
  // reads three layout properties — measuring once a frame is enough.
  const scrollRead = useRef(false);
  const onScroll = () => {
    if (scrollRead.current) return;
    scrollRead.current = true;
    requestAnimationFrame(() => {
      scrollRead.current = false;
      const el = scrollRef.current;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      // A view that moved *up* was moved by someone: content landing above
      // pushes scrollTop down the page, never up, and content going away
      // only ever clamps it to the bottom (where nearBottom catches it).
      // This is what makes page-up work without the transcript having focus.
      const wentUp = el.scrollTop < lastTopRef.current - 2;
      lastTopRef.current = el.scrollTop;
      if (nearBottom) pinnedRef.current = true;
      else if (wentUp || Date.now() - gestureRef.current < GESTURE_MS) pinnedRef.current = false;
      setShowJump(!nearBottom && !pinnedRef.current);
      // Reading back through the session pulls the older turns in as you go
      // — one batch per approach to the top, not one per frame spent near
      // it. Resting at the top used to add thirty turns every frame, which
      // on a long session is the whole history rendered in a second.
      if (el.scrollTop >= 600) grewAtTop.current = false;
      else if (!grewAtTop.current) {
        grewAtTop.current = true;
        setRenderedTurns((shown) => shown + TURN_STEP);
      }
    });
  };

  // Follow the conversation only while the user is at the bottom.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [transcript.length, draft?.text, permissions.length, status, queuedItems.length]);

  // Opening a session means opening it at the last thing said. The one
  // scroll at render time is not enough on its own: the tail is still
  // settling behind it — the window fills back in, markdown lays out, the
  // composer measures itself — so the bottom keeps moving for a few frames.
  // This holds it there until it stops moving, and stands down the moment
  // the user scrolls.
  useLayoutEffect(() => {
    pinnedRef.current = true;
    gestureRef.current = 0;
    lastTopRef.current = 0;
    setShowJump(false);
    scrollToBottom();
    let frames = 0;
    let steady = 0;
    let was = -1;
    let raf = requestAnimationFrame(function settle() {
      if (!pinnedRef.current || frames++ > SETTLE_FRAMES) return;
      const el = scrollRef.current;
      // Two frames where the bottom hasn't moved means it has stopped
      // moving. Each of these frames costs a layout of the transcript, so
      // running the full count when the tail settled immediately is work
      // for nothing.
      if (el) {
        const height = el.scrollHeight;
        steady = height === was ? steady + 1 : 0;
        was = height;
        if (steady >= 2) return;
      }
      scrollToBottom();
      raf = requestAnimationFrame(settle);
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId]);

  // Content keeps growing after the render-time scroll (images decode,
  // markdown settles) — while pinned, any growth re-bottoms the view, so a
  // relaunch opens at the latest message instead of partway up.
  const innerObserver = useRef<ResizeObserver | null>(null);
  const observeInner = useCallback((node: HTMLDivElement | null) => {
    innerObserver.current?.disconnect();
    innerObserver.current = null;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) bottomRef.current?.();
    });
    observer.observe(node);
    innerObserver.current = observer;
  }, []);

  // The composer floats over the transcript on no background of its own, so
  // the conversation runs behind it instead of stopping at a dead band. Two
  // measurements come off it: --composer-h, the whole dock (the tail's
  // padding and the fade), and --composer-box-h, the textbox alone (the jump
  // pill). The dragons stand taller than the box, so the pill rides the box
  // — it belongs a hair above what you type in, not above the dragons.
  const chatRef = useRef<HTMLElement>(null);
  const dockObserver = useRef<ResizeObserver | null>(null);
  const observeDock = useCallback((node: HTMLDivElement | null) => {
    dockObserver.current?.disconnect();
    dockObserver.current = null;
    if (!node) return;
    const box = node.querySelector<HTMLElement>(".composer-box");
    // What was last written. A custom property set on the pane root
    // invalidates style for every node under it — the whole transcript — so
    // rewriting the same value on every observation is not free, and the
    // observer fires for every frame of a growing composer.
    let wrote = { dock: -1, boxTop: -1 };
    const measure = () => {
      const chat = chatRef.current;
      if (!chat) return;
      const dock = node.offsetHeight;
      // the dock's bottom is the pane's bottom, so this is exactly how far
      // up from the pane's floor the textbox starts
      const boxTop = Math.round(
        box ? node.getBoundingClientRect().bottom - box.getBoundingClientRect().top : dock,
      );
      if (dock === wrote.dock && boxTop === wrote.boxTop) return;
      wrote = { dock, boxTop };
      chat.style.setProperty("--composer-h", `${dock}px`);
      chat.style.setProperty("--composer-box-h", `${boxTop}px`);
    };
    const observer = new ResizeObserver(() => {
      measure();
      // a taller composer eats into the view — re-bottom so the newest
      // message stays put rather than sliding under it
      if (pinnedRef.current) bottomRef.current?.();
    });
    observer.observe(node);
    // the box grows on its own (a long prompt, an attachment strip) without
    // the dock following, whenever the dragons are still the taller pair
    if (box) observer.observe(box);
    dockObserver.current = observer;
    measure();
  }, []);

  // Grouping walks the whole event stream, and the stream is long. It only
  // changes when the events do — not on every keystroke into the composer,
  // every token of a streaming reply, or every scroll that re-measures.
  const allTurns = useMemo(() => groupTurns(transcript), [transcript]);
  const shownTurns = useMemo(
    () =>
      renderedTurns >= allTurns.length
        ? allTurns
        : allTurns.slice(allTurns.length - renderedTurns),
    [allTurns, renderedTurns],
  );

  // Above the early return: a hook that only some renders reach is a hook
  // React counts differently on the render after the pane finds a project.
  const startRewind = useCallback(
    (event: Extract<TranscriptEvent, { kind: "user" }>) =>
      setRewindTarget({ id: event.id, text: event.text }),
    [],
  );
  const startFork = useCallback(
    (event: Extract<TranscriptEvent, { kind: "user" }>) => {
      if (activeId) send({ type: "fork", projectId: activeId, eventId: event.id });
    },
    [activeId],
  );

  if (!project || !activeId) {
    return <main className={pane("chat empty")} />;
  }

  const busy = status === "working" || status === "permission";

  // Rewind works on every harness; what it can undo differs. Claude rides
  // the CLI's file checkpoints and forks the conversation at the prompt;
  // every other harness keeps no checkpoints and cannot fork, so it rewinds
  // the transcript and comes back on a brief of what's kept, files untouched.
  const claudeRoute = !models.find((m) => m.value === (project.model || DEFAULT_MODEL))?.provider;
  const canRewind = !isHome && !busy;
  const askRewind = canRewind ? startRewind : undefined;
  // Fork: the branch under the pencil — a new session from this exchange
  // on, no confirmation, since nothing is lost by it. Same footing as
  // rewind: a project's session, while nothing is running.
  const askFork = canRewind ? startFork : undefined;

  // Home keeps no header bar — the transcript starts at the top; the
  // tracker page still auto-opens there and closes from its own X.
  const header = !isHome && (
    <header className="chat-header">
      <div className="chat-id">
        <div className="chat-title">
          {project.name}
          {session?.title && <span className="chat-session-title"> · {session.title}</span>}
        </div>
      </div>
      <div className="header-controls">
        <button
          className={`icon-button ${page === "skills" ? "active" : ""}`}
          title="Skills — what this project and this machine load before working"
          onClick={() => setPage(page === "skills" ? "chat" : "skills")}
        >
          <Icon d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v18H6.5A2.5 2.5 0 0 1 4 18.5v-13zM12 3h5.5A2.5 2.5 0 0 1 20 5.5v13a2.5 2.5 0 0 1-2.5 2.5H12" />
        </button>
        <button
          className={`icon-button comp-toggle ${page === "components" ? "active" : ""}`}
          title="Components — your names for the parts of this project"
          onClick={() => setPage(page === "components" ? "chat" : "components")}
        >
          <Icon d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
          {freshComponents > 0 && (
            <span className="comp-star just header" aria-label="new components">
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M12 2.5l2.7 6.1 6.6.7-4.9 4.5 1.4 6.5L12 17l-5.8 3.3 1.4-6.5L2.7 9.3l6.6-.7z" />
              </svg>
            </span>
          )}
        </button>
        <button
          className={`icon-button ${page === "ideas" ? "active" : ""}`}
          title="Ideas — the board of things you want out of this project"
          onClick={() => setPage(page === "ideas" ? "chat" : "ideas")}
        >
          <Icon d="M9 18h6M10 21h4M12 3a6 6 0 0 1 4 10.5c-.6.6-1 1.4-1 2.2v.3H9v-.3c0-.8-.4-1.6-1-2.2A6 6 0 0 1 12 3z" />
          {ideaCount > 0 && <span className="tracker-badge">{ideaCount}</span>}
        </button>
        <button
          className={`icon-button tracker-toggle ${page === "tracker" ? "active" : ""}`}
          title={page === "tracker" ? "Back to the chat" : "Feature tracker — things to test by hand"}
          onClick={() => setPage(page === "tracker" ? "chat" : "tracker")}
        >
          <Icon d="M9 11l3 3 8-8M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
          {openCount > 0 && <span className="tracker-badge">{openCount}</span>}
        </button>
      </div>
    </header>
  );

  // The pad, wherever it was opened from — over a fresh session's hero as
  // much as over a conversation.
  if (sketch) {
    return (
      <main className={pane("chat")}>
        {header}
        <Sketch
          channelId={activeId}
          {...(sketch.background ? { background: sketch.background } : {})}
          onClose={() => setSketch(null)}
        />
      </main>
    );
  }

  // No conversation yet (Home or a fresh project): the hero — face, a big
  // title, and the composer front and center.
  if (transcript.length === 0 && !draft && permissions.length === 0) {
    return (
      <main className={pane("chat home-hero")}>
        {lastError && (
          <div className="error-bar" onClick={dismissError}>
            {lastError} <span className="dismiss">dismiss</span>
          </div>
        )}
        {rapid?.on && header}
        {/* Home is the one place to see every project at once — the board
            sits above the agent, which centres in whatever room is left */}
        {isHome && !rapid?.on && <HomeBoard />}
        <div className="hero">
          <HeroFace n={isHome ? launchHero : heroFor(storeProject?.id ?? activeId)} />
          <div className="hero-title">{isHome ? "sup." : (session?.title ?? project.name)}</div>
          <div className="hero-composer">
            {rapid?.on && <RapidBar rapid={rapid} />}
            <Composer
              key={activeId}
              channelId={activeId}
              project={project}
              busy={busy}
              onSketch={openSketch}
              {...(rapid?.on ? { onSent: () => rapid.advance("sent") } : {})}
            />
          </div>

        </div>
      </main>
    );
  }

  // A header button swaps the whole pane for that page — no navigation,
  // just this branch; the lit button swaps it back.
  if (page !== "chat") {
    return (
      <main className={pane("chat")}>
        {header}
        {page === "tracker" && (
          <Tracker projectId={activeId} onClose={() => setPage("chat")} />
        )}
        {page === "ideas" && boardId && <Ideas projectId={boardId} channelId={activeId} />}
        {page === "components" && boardId && <Components projectId={boardId} />}
        {page === "skills" && <Skills {...(boardId ? { projectId: boardId } : {})} />}
      </main>
    );
  }

  return (
    <main className={pane("chat")} ref={chatRef}>
      {header}

      {lastError && (
        <div className="error-bar" onClick={dismissError}>
          {lastError} <span className="dismiss">dismiss</span>
        </div>
      )}

      {isHome && !rapid?.on && <HomeBoard />}

      {/* the holder ends where the composer begins, so the jump pill always
          floats just above the composer no matter how tall it grows */}
      <div className="transcript-holder">
      <div
        className="transcript"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={noteGesture}
        onTouchMove={noteGesture}
        onPointerDown={noteGesture}
        onKeyDown={noteGesture}
      >
        <div className="transcript-inner" ref={observeInner}>
          {shownTurns.map((turn, index) => {
            const summary = summaries[turn.turnId];
            // far enough up that the browser may skip laying it out until
            // it comes near the viewport — see .turn.far
            const far = index < shownTurns.length - LIVE_TURNS;
            if (summary !== undefined && folded.has(turn.turnId)) {
              return (
                <CompactTurn
                  key={turn.turnId}
                  summary={summary}
                  count={turn.events.length}
                  onExpand={() => {
                    const next = new Set(folded);
                    next.delete(turn.turnId);
                    setFolded(next);
                  }}
                />
              );
            }
            return (
              <div className={far ? "turn far" : "turn"} key={turn.turnId}>
                {summary !== undefined && !turn.solo && (
                  <button
                    className="icon-button turn-fold"
                    title="Fold this exchange to its summary"
                    onClick={() => setFolded(new Set(folded).add(turn.turnId))}
                  >
                    <Icon d="M6 15l6-6 6 6" />
                  </button>
                )}
                {turn.events.map((event) => (
                  <EventView
                    key={event.id}
                    event={event}
                    project={project}
                    channelId={activeId}
                    onRewind={askRewind}
                    onFork={askFork}
                  />
                ))}
              </div>
            );
          })}
          {draft && (
            <div className="msg assistant streaming">
              <StreamingMarkdown text={draft.text} />
              <span className="cursor" />
            </div>
          )}
          {status === "working" && !draft && <Thinking />}
          {permissions.map((request) =>
            // neither a question nor a naming is an allow/deny — each gets
            // its own card, and only a real tool call gets allow/deny
            request.kind === "question" ? (
              <QuestionCard key={request.requestId} request={request} />
            ) : request.kind === "component" ? (
              <NameCard key={request.requestId} request={request} />
            ) : (
              <PermissionBanner key={request.requestId} request={request} />
            ),
          )}
          {queuedItems.map((item) => (
            <QueuedCard key={item.id} projectId={activeId} item={item} />
          ))}
        </div>
      </div>

      <SelectionFlags scrollerRef={scrollRef} />

      {showJump && (
        <button className="jump-latest" onClick={() => scrollToBottom("smooth")}>
          <Icon d="M12 5v14M5 12l7 7 7-7" /> Latest
        </button>
      )}
      {rapid?.on && <RapidBar rapid={rapid} floating />}
      {activeId && <BridgeStrip channelId={activeId} stacked={rapid?.on} />}
      </div>

      {rewindTarget && (
        <div className="confirm-overlay" onClick={() => setRewindTarget(null)}>
          <div
            className="confirm-card"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRewindTarget(null);
            }}
          >
            <div className="confirm-title">Rewind to this prompt</div>
            <div className="confirm-quote">
              {rewindTarget.text.length > 240
                ? `${rewindTarget.text.slice(0, 240).trimEnd()}…`
                : rewindTarget.text}
            </div>
            <div className="confirm-body">
              {claudeRoute
                ? "The conversation and the project's files go back to the moment before this prompt ran — everything after it is discarded. The prompt itself lands in the composer, so you can edit it there and send when you're ready."
                : "The conversation goes back to the moment before this prompt ran — everything after it is discarded, and the harness starts again from a brief of what's kept. This harness keeps no file checkpoints, so the files stay as they are. The prompt itself lands in the composer, so you can edit it there and send when you're ready."}
            </div>
            <div className="confirm-actions">
              <button className="ghost" onClick={() => setRewindTarget(null)}>
                Cancel
              </button>
              <button
                className="primary"
                autoFocus
                onClick={() => {
                  send({ type: "rewind", projectId: activeId, eventId: rewindTarget.id });
                  setRewindTarget(null);
                }}
              >
                Rewind
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="composer-dock" key={activeId} ref={observeDock}>
        <Composer
          channelId={activeId}
          project={project}
          busy={busy}
          onSketch={openSketch}
          {...(rapid?.on ? { onSent: () => rapid.advance("sent") } : {})}
        />
      </div>
    </main>
  );
}
