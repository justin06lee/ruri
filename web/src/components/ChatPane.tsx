import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL,
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

function EventView({ event }: { event: TranscriptEvent }) {
  switch (event.kind) {
    case "user":
      return (
        <div className="msg user">
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
    case "tool":
      return (
        <div className="tool-chip" title={event.summary}>
          <Icon d={toolIcon(event.name)} />
          <span className="tool-name">{event.name}</span>
          <span className="tool-summary">{event.summary}</span>
        </div>
      );
    case "result":
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
    case "info":
      return <div className="info-line">{event.text}</div>;
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

function PermissionBanner({ request }: { request: PermissionRequest }) {
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

/** Real video containers only — browsers call .ts (TypeScript) "video/mp2t". */
const VIDEO_EXT = new Set(["mp4", "mov", "webm", "m4v", "avi", "mkv", "mpg", "mpeg", "ogv"]);

function fileKind(file: File): "image" | "video" | "file" {
  if (file.type.startsWith("image/")) return "image";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (file.type.startsWith("video/") && VIDEO_EXT.has(ext)) return "video";
  return "file";
}

function Composer({
  channelId,
  project,
  busy,
}: {
  /** The session (or Home) this composer sends to. */
  channelId: string;
  project: Project;
  busy: boolean;
}) {
  const projectId = channelId;
  const saved = composerDrafts.get(channelId);
  const [text, setText] = useState(saved?.text ?? "");
  const [atts, setAtts] = useState<ComposerAttachment[]>(saved?.atts ?? []);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const counter = useRef(saved?.counter ?? { image: 0, video: 0, file: 0 });
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composerSeed = useRuri((s) => s.composerSeed);
  const clearComposerSeed = useRuri((s) => s.clearComposerSeed);

  // Every keystroke and attachment change lands in the per-channel draft.
  useEffect(() => {
    composerDrafts.set(channelId, { text, atts, counter: counter.current });
  }, [channelId, text, atts]);

  const addFiles = (files: FileList | File[]) => {
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
      // trailing space so typing right after a drop never sticks to the "]"
      const markers = added.map((a) => `[${a.kind} #${a.n}]`).join(" ");
      return prev.trim() ? `${prev.replace(/\s+$/, "")} ${markers} ` : `${markers} `;
    });
    requestAnimationFrame(autosize);
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

  // Tracker "send as prompt": append the seeded text and focus.
  useEffect(() => {
    if (!composerSeed) return;
    setText((prev) => (prev.trim() ? `${prev}\n${composerSeed}` : composerSeed));
    clearComposerSeed();
    requestAnimationFrame(() => {
      autosize();
      areaRef.current?.focus();
    });
  }, [composerSeed, clearComposerSeed]);

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
                att.regions.map(async (region) => ({
                  note: region.note,
                  data: await cropRegion(att.objectUrl, region),
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
    requestAnimationFrame(autosize);
  };

  // Fit the restored draft's height on mount (remounts on session switch).
  useEffect(autosize, [projectId]);

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
          addFiles(e.dataTransfer.files);
        }}
      >
        <AttachmentStrip attachments={atts} onRemove={removeAtt} onView={(a) => setViewing(a.id)} />
        <textarea
          ref={areaRef}
          rows={1}
          placeholder="Message ruri…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
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
              addFiles(files);
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
}

/** Group the flat event stream into prompt→result turns. */
function groupTurns(events: TranscriptEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    const last = turns[turns.length - 1];
    if (event.kind === "user" || !last) {
      turns.push({ turnId: event.kind === "user" ? event.id : "pre", events: [event] });
    } else {
      last.events.push(event);
    }
  }
  return turns;
}

/**
 * A summarized turn, folded to its precomputed recall note. Clicking it pulls
 * the full prompt/response back — the archive keeps everything.
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

  // Compact history is always on: older turns fold to their recall notes
  // once summaries exist, and clicking a folded turn pulls it back.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => setExpanded(new Set()), [activeId]);

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

  if (!project || !activeId) {
    return <main className="chat empty" />;
  }

  const busy = status === "working" || status === "permission";

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

  return (
    <main className="chat">
      {/* Home keeps no header bar — the transcript starts at the top; the
          tracker drawer still auto-opens there and closes from inside */}
      {!isHome && (
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
              title="Feature tracker — things to test by hand"
              onClick={() => setTrackerOpen(!trackerOpen)}
            >
              <Icon d="M9 11l3 3 8-8M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
              {openCount > 0 && <span className="tracker-badge">{openCount}</span>}
            </button>
          </div>
        </header>
      )}

      {lastError && (
        <div className="error-bar" onClick={dismissError}>
          {lastError} <span className="dismiss">dismiss</span>
        </div>
      )}

      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript-inner">
          {(() => {
            const turns = groupTurns(transcript);
            return turns.map((turn, i) => {
              const summary = summaries[turn.turnId];
              const fold =
                summary !== undefined && i < turns.length - 1 && !expanded.has(turn.turnId);
              if (fold) {
                return (
                  <CompactTurn
                    key={turn.turnId}
                    summary={summary}
                    count={turn.events.length}
                    onExpand={() => setExpanded(new Set(expanded).add(turn.turnId))}
                  />
                );
              }
              return turn.events.map((event) => <EventView key={event.id} event={event} />);
            });
          })()}
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

      {trackerOpen && <Tracker projectId={activeId} onClose={() => setTrackerOpen(false)} />}

      <Composer key={activeId} channelId={activeId} project={project} busy={busy} />
    </main>
  );
}
