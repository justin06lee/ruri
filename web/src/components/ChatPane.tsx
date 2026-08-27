import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  HOME_ID,
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
  fileToBase64,
  Viewer,
  TranscriptAttachments,
  type ComposerAttachment,
  type Region,
} from "./Attachments";
import { Dropdown } from "./Dropdown";
import { Thinking } from "./Thinking";
import { Tracker } from "./Tracker";
import { heroFor, heroUrl, launchHero } from "../hero";
import { Markdown } from "../markdown";
import { composerDrafts, send, useRuri } from "../store";

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

export function EventView({
  event,
  project,
  channelId,
  onRewind,
}: {
  event: TranscriptEvent;
  project?: Project;
  channelId?: string;
  /** Present when this prompt can be rewound to — renders the pencil. */
  onRewind?: (event: Extract<TranscriptEvent, { kind: "user" }>) => void;
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
              title="Edit & rewind — conversation and code return to just before this prompt, then your edit sends"
              onClick={() => onRewind(event)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
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
      const summary = shortenDisplay(event.summary, project);
      return (
        <div className="tool-chip" title={summary}>
          <Icon d={toolIcon(event.name)} />
          <span className="tool-name">{event.name}</span>
          <span className="tool-summary">{summary}</span>
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
}

/* ── permissions ─────────────────────────────────────────────────── */

function permissionSummary(request: PermissionRequest): { title: string; body: React.ReactNode } {
  const input = (request.input ?? {}) as Record<string, unknown>;
  if (request.toolName === "ExitPlanMode" && typeof input["plan"] === "string") {
    return {
      title: "Claude finished planning and wants to start building",
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
    title: `Claude wants to use ${request.toolName}`,
    body: <pre className="permission-input">{detail ?? JSON.stringify(request.input, null, 2)}</pre>,
  };
}

export function PermissionBanner({ request }: { request: PermissionRequest }) {
  const { title, body } = permissionSummary(request);
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
  if (!selected) models.push({ value: DEFAULT_MODEL, displayName: "Fable" });
  // Permission modes are a Claude concept — other harnesses bring their own
  // sandbox, so the dropdown hides when the model routes elsewhere.
  const claudeRoute = !selected?.provider;
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
      {claudeRoute && (
        <Dropdown
          up
          title="Permission mode"
          value={project.permissionMode ?? "default"}
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
}: {
  /** The session (or Home) this composer sends to. */
  channelId: string;
  project: Project;
  busy: boolean;
  /** Fires right after a prompt goes out (rapid fire advances on it). */
  onSent?: () => void;
}) {
  const projectId = channelId;
  const saved = composerDrafts.get(channelId);
  const [text, setText] = useState(saved?.text ?? "");
  const [atts, setAtts] = useState<ComposerAttachment[]>(saved?.atts ?? []);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const counter = useRef(saved?.counter ?? { image: 0, video: 0, file: 0 });
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const draftBump = useRuri((s) => s.draftBumps[channelId] ?? 0);
  const bumpSeen = useRef(draftBump);

  // Every keystroke and attachment change lands in the per-channel draft.
  useEffect(() => {
    composerDrafts.set(channelId, { text, atts, counter: counter.current });
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
    setText((prev) => {
      // pure insertion: the prompt's own text — trailing newlines included —
      // is never trimmed or reflowed; only spaces around the markers, so
      // typing (or the neighboring words) never sticks to a "]" or "["
      const markers = added.map((a) => `[${a.kind} #${a.n}]`).join(" ");
      const idx = at === undefined ? prev.length : Math.min(at, prev.length);
      const before = prev.slice(0, idx);
      const after = prev.slice(idx);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const tail = /^\s/.test(after) ? "" : " ";
      return `${before}${lead}${markers}${tail}${after}`;
    });
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

  const removeAtt = (id: string) => {
    setAtts((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.objectUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  const setRegions = (id: string, regions: Region[]) => {
    setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, regions } : a)));
  };

  const autosize = () => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 220)}px`;
  };

  // Text arrived in this channel's draft from outside (a review's fix-it
  // prompt, a rewound prompt): the map is the source of truth — re-read it.
  useEffect(() => {
    if (draftBump === bumpSeen.current) return;
    bumpSeen.current = draftBump;
    const fresh = composerDrafts.get(channelId);
    if (fresh && fresh.text !== text) setText(fresh.text);
    requestAnimationFrame(() => areaRef.current?.focus());
  }, [draftBump, channelId, text]);

  const submit = async (mode: "send" | "send_split" = "send") => {
    const trimmed = text.trim();
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
                att.regions.map(async (region, i) => ({
                  note: region.note,
                  data: await cropRegion(att.objectUrl, region, i + 1),
                  mediaType: "image/png",
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
    composerDrafts.delete(channelId);
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

  const viewingAtt = atts.find((a) => a.id === viewing);

  return (
    <div className="composer">
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
        <AttachmentStrip attachments={atts} onRemove={removeAtt} onView={(a) => setViewing(a.id)} />
        <textarea
          ref={areaRef}
          rows={1}
          placeholder="Message ruri…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length > 0) {
              e.preventDefault();
              addFiles(files, areaRef.current?.selectionStart ?? undefined);
            }
          }}
        />
        <div className="composer-bar">
          <SessionControls project={project} />
          <div className="composer-actions">
            {busy && (
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
            <button
              className="split-send"
              title="Split into separate prompts and send them one by one"
              onClick={() => void submit("send_split")}
              disabled={!text.trim()}
            >
              <Icon d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.6 15.4M14.7 14.7L20 20M8.6 8.6L12 12" />
            </button>
            <button
              className="send"
              title="Send (Enter)"
              onClick={() => void submit()}
              disabled={!text.trim() && atts.length === 0}
            >
              <Icon d="M12 19V5M5 12l7-7 7 7" />
            </button>
          </div>
        </div>
      </div>
      <div className="composer-hint">
        Enter to send · Shift+Enter for a new line · drop images, videos, or files to attach ·
        scissors to split a long prompt
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  const save = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.text) {
      send({ type: "queue_edit", projectId, itemId: item.id, text: draft });
    } else {
      setDraft(item.text);
    }
  };

  return (
    <div className="queued-card">
      <div className="queued-head">
        <span className="queued-label">queued</span>
        <span className="queued-actions">
          <button
            className="icon-button"
            title="Edit before it sends"
            onClick={() => {
              setDraft(item.text);
              setEditing(true);
            }}
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
      {editing ? (
        <textarea
          className="queued-edit"
          rows={3}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              save();
            }
            if (e.key === "Escape") {
              setDraft(item.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <div className="queued-text">{item.text}</div>
      )}
      {!editing && item.attachments && item.attachments.length > 0 && (
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

/* ── chat pane ───────────────────────────────────────────────────── */

// Stable fallback so selectors never mint a fresh reference per read —
// an unstable snapshot makes useSyncExternalStore loop (React error #185).
const NO_EVENTS: TranscriptEvent[] = [];
const NO_SUMMARIES: Record<string, string> = {};
const NO_QUEUED: QueuedPrompt[] = [];

export function ChatPane() {
  const activeId = useRuri((s) => s.activeId);
  const storeProject = useRuri((s) =>
    s.activeId ? s.projects.find((p) => p.sessions.some((x) => x.id === s.activeId)) : undefined,
  );
  const workspaceDir = useRuri((s) => s.workspaceDir);
  const home = useRuri((s) => s.home);
  const isHome = activeId === HOME_ID;
  const session = storeProject?.sessions.find((x) => x.id === activeId);
  const project: Project | undefined = isHome
    ? { id: HOME_ID, name: "ruri", path: workspaceDir, sessions: [], ...home }
    : storeProject;
  const transcript = useRuri((s) =>
    s.activeId ? (s.transcripts[s.activeId] ?? NO_EVENTS) : NO_EVENTS,
  );
  const draft = useRuri((s) => (s.activeId ? s.drafts[s.activeId] : undefined));
  const status = useRuri((s) => (s.activeId ? (s.statuses[s.activeId] ?? "idle") : "idle"));
  const summaries = useRuri((s) =>
    s.activeId ? (s.summaries[s.activeId] ?? NO_SUMMARIES) : NO_SUMMARIES,
  );
  const queuedItems = useRuri((s) => (s.activeId ? (s.queued[s.activeId] ?? NO_QUEUED) : NO_QUEUED));
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

  const trackerItems = useRuri((s) => (s.activeId ? s.tracker[s.activeId] : undefined));
  const [trackerOpen, setTrackerOpen] = useState(false);
  const openCount = (trackerItems ?? []).filter((i) => i.status === "open").length;

  // New auto-extracted items for the active project pop the drawer open.
  const prevAutoRef = useRef(0);
  const autoCount = (trackerItems ?? []).filter((i) => i.source === "auto").length;
  useEffect(() => {
    if (autoCount > prevAutoRef.current) setTrackerOpen(true);
    prevAutoRef.current = autoCount;
  }, [autoCount]);
  useEffect(() => {
    prevAutoRef.current = (useRuri.getState().activeId &&
      useRuri.getState().tracker[useRuri.getState().activeId!]?.filter((i) => i.source === "auto")
        .length) || 0;
    setTrackerOpen(false);
  }, [activeId]);

  // Turns show in full — the summaries are the model's memory aid, not the
  // user's view. A hover chevron folds a turn to its note when wanted.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  useEffect(() => setFolded(new Set()), [activeId]);

  // Rewind: pencil on a past prompt → the prompt opens in an editable card →
  // confirming rewinds conversation and code to just before it ran, then
  // sends the edit as the next turn. Claude sessions only (file
  // checkpoints), and only while nothing is running.
  const models = useRuri((s) => s.models);
  const [rewindTarget, setRewindTarget] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => setRewindTarget(null), [activeId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = pinned;
    setShowJump(!pinned);
  };

  // Follow the conversation only while the user is at the bottom.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [transcript.length, draft?.text, permissions.length, status, queuedItems.length]);
  useLayoutEffect(() => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
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
      const el = scrollRef.current;
      if (el && pinnedRef.current) el.scrollTo({ top: el.scrollHeight });
    });
    observer.observe(node);
    innerObserver.current = observer;
  }, []);

  if (!project || !activeId) {
    return <main className="chat empty" />;
  }

  const busy = status === "working" || status === "permission";

  // Rewind rides the CLI's checkpoints — only when the model routes to Claude.
  const claudeRoute = !models.find((m) => m.value === (project.model || DEFAULT_MODEL))?.provider;
  const canRewind = !isHome && !busy && claudeRoute;
  const askRewind = canRewind
    ? (event: Extract<TranscriptEvent, { kind: "user" }>) =>
        setRewindTarget({ id: event.id, text: event.text })
    : undefined;

  // No conversation yet (Home or a fresh project): the hero — face, a big
  // title, and the composer front and center.
  if (transcript.length === 0 && !draft && permissions.length === 0) {
    return (
      <main className="chat home-hero">
        {lastError && (
          <div className="error-bar" onClick={dismissError}>
            {lastError} <span className="dismiss">dismiss</span>
          </div>
        )}
        <div className="hero">
          <img
            className="hero-face"
            src={heroUrl(isHome ? launchHero : heroFor(storeProject?.id ?? activeId))}
            alt=""
          />
          <div className="hero-title">{isHome ? "sup." : (session?.title ?? project.name)}</div>
          <div className="hero-composer">
            <Composer key={activeId} channelId={activeId} project={project} busy={busy} />
          </div>

        </div>
      </main>
    );
  }

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
          className={`icon-button tracker-toggle ${trackerOpen ? "active" : ""}`}
          title={trackerOpen ? "Back to the chat" : "Feature tracker — things to test by hand"}
          onClick={() => setTrackerOpen(!trackerOpen)}
        >
          <Icon d="M9 11l3 3 8-8M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
          {openCount > 0 && <span className="tracker-badge">{openCount}</span>}
        </button>
      </div>
    </header>
  );

  // The tracker button swaps the whole pane for the todo page — no
  // navigation, just this branch; the same button (or its X) swaps back.
  if (trackerOpen) {
    return (
      <main className="chat">
        {header}
        <Tracker projectId={activeId} onClose={() => setTrackerOpen(false)} />
      </main>
    );
  }

  return (
    <main className="chat">
      {header}

      {lastError && (
        <div className="error-bar" onClick={dismissError}>
          {lastError} <span className="dismiss">dismiss</span>
        </div>
      )}

      {/* the holder ends where the composer begins, so the jump pill always
          floats just above the composer no matter how tall it grows */}
      <div className="transcript-holder">
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript-inner" ref={observeInner}>
          {groupTurns(transcript).map((turn) => {
            const summary = summaries[turn.turnId];
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
              <div className="turn" key={turn.turnId}>
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
                  />
                ))}
              </div>
            );
          })}
          {draft && (
            <div className="msg assistant streaming">
              <Markdown text={draft.text} />
              <span className="cursor" />
            </div>
          )}
          {status === "working" && !draft && <Thinking />}
          {permissions.map((request) => (
            <PermissionBanner key={request.requestId} request={request} />
          ))}
          {queuedItems.map((item) => (
            <QueuedCard key={item.id} projectId={activeId} item={item} />
          ))}
        </div>
      </div>

      {showJump && (
        <button className="jump-latest" onClick={() => scrollToBottom("smooth")}>
          <Icon d="M12 5v14M5 12l7 7 7-7" /> Latest
        </button>
      )}
      </div>

      {rewindTarget && (
        <div className="confirm-overlay" onClick={() => setRewindTarget(null)}>
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">Edit & rewind</div>
            <textarea
              className="confirm-edit"
              rows={5}
              value={rewindTarget.text}
              autoFocus
              onChange={(e) => setRewindTarget({ ...rewindTarget, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") setRewindTarget(null);
                if (e.key === "Enter" && !e.shiftKey && rewindTarget.text.trim()) {
                  e.preventDefault();
                  send({
                    type: "rewind",
                    projectId: activeId,
                    eventId: rewindTarget.id,
                    text: rewindTarget.text,
                  });
                  setRewindTarget(null);
                }
              }}
            />
            <div className="confirm-body">
              Sending rewinds the conversation and the project's files to the moment before
              this prompt ran — everything after it is discarded — then sends your edit as
              the next prompt.
            </div>
            <div className="confirm-actions">
              <button className="ghost" onClick={() => setRewindTarget(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!rewindTarget.text.trim()}
                onClick={() => {
                  send({
                    type: "rewind",
                    projectId: activeId,
                    eventId: rewindTarget.id,
                    text: rewindTarget.text,
                  });
                  setRewindTarget(null);
                }}
              >
                Rewind & send
              </button>
            </div>
          </div>
        </div>
      )}

      <Composer key={activeId} channelId={activeId} project={project} busy={busy} />
    </main>
  );
}
