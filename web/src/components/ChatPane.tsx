import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  PermissionMode,
  PermissionRequest,
  Project,
  TranscriptEvent,
} from "../../../shared/protocol";
import { Dropdown } from "./Dropdown";
import { Tracker } from "./Tracker";
import { Markdown } from "../markdown";
import { send, useRuri } from "../store";

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

function HeaderControls({ project }: { project: Project }) {
  const models = useRuri((s) => s.models);
  return (
    <div className="header-controls">
      <Dropdown
        title="Model for this project's sessions"
        value={project.model ?? ""}
        options={[
          { value: "", label: "Default model" },
          ...models.map((m) => ({ value: m.value, label: m.displayName })),
        ]}
        onSelect={(model) => send({ type: "set_model", projectId: project.id, model })}
      />
      <Dropdown
        title="Permission mode"
        value={project.permissionMode ?? "default"}
        options={PERMISSION_MODES}
        onSelect={(mode) =>
          send({ type: "set_permission_mode", projectId: project.id, mode: mode as PermissionMode })
        }
      />
    </div>
  );
}

/* ── composer ────────────────────────────────────────────────────── */

function Composer({ projectId, busy }: { projectId: string; busy: boolean }) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const composerSeed = useRuri((s) => s.composerSeed);
  const clearComposerSeed = useRuri((s) => s.clearComposerSeed);

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

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send({ type: "send", projectId, text: trimmed });
    setText("");
    requestAnimationFrame(autosize);
  };

  // Reset height when switching projects clears the draft.
  useEffect(autosize, [projectId]);

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={areaRef}
          rows={1}
          placeholder="Message Claude Code…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
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
          <button className="send" title="Send (Enter)" onClick={submit} disabled={!text.trim()}>
            <Icon d="M12 19V5M5 12l7-7 7 7" />
          </button>
        </div>
      </div>
      <div className="composer-hint">Enter to send · Shift+Enter for a new line</div>
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

export function ChatPane() {
  const activeId = useRuri((s) => s.activeId);
  const project = useRuri((s) => s.projects.find((p) => p.id === s.activeId));
  const transcript = useRuri((s) =>
    s.activeId ? (s.transcripts[s.activeId] ?? NO_EVENTS) : NO_EVENTS,
  );
  const draft = useRuri((s) => (s.activeId ? s.drafts[s.activeId] : undefined));
  const status = useRuri((s) => (s.activeId ? (s.statuses[s.activeId] ?? "idle") : "idle"));
  const summaries = useRuri((s) =>
    s.activeId ? (s.summaries[s.activeId] ?? NO_SUMMARIES) : NO_SUMMARIES,
  );
  const allPermissions = useRuri((s) => s.permissions);
  const permissions = allPermissions.filter((p) => p.projectId === activeId);
  const lastError = useRuri((s) => s.lastError);
  const dismissError = useRuri((s) => s.dismissError);

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

  const [compact, setCompact] = useState(() => {
    try {
      return localStorage.getItem("ruri-compact") !== "0";
    } catch {
      return true;
    }
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => setExpanded(new Set()), [activeId]);
  const toggleCompact = () => {
    setCompact(!compact);
    try {
      localStorage.setItem("ruri-compact", compact ? "0" : "1");
    } catch {
      // fine
    }
  };

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
  }, [transcript.length, draft?.text, permissions.length, status]);
  useLayoutEffect(() => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToBottom();
  }, [activeId]);

  if (!project || !activeId) {
    return (
      <main className="chat empty">
        <div className="empty-state">
          <img className="empty-face" src="/ruri-face.png" alt="" />
          <div className="empty-title">No project selected</div>
          <div className="empty-hint">Add a project on the left, then talk to Claude Code here.</div>
        </div>
      </main>
    );
  }

  const busy = status === "working" || status === "permission";

  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-id">
          <div className="chat-title">{project.name}</div>
          <div className="chat-path">{project.path}</div>
        </div>
        <div className="header-controls">
          <button
            className={`icon-button ${compact ? "active" : ""}`}
            title={compact ? "Compact history: on — older turns fold to their summaries" : "Compact history: off"}
            onClick={toggleCompact}
          >
            <Icon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
          </button>
          <button
            className={`icon-button tracker-toggle ${trackerOpen ? "active" : ""}`}
            title="Feature tracker — things to test by hand"
            onClick={() => setTrackerOpen(!trackerOpen)}
          >
            <Icon d="M9 11l3 3 8-8M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
            {openCount > 0 && <span className="tracker-badge">{openCount}</span>}
          </button>
        </div>
        <HeaderControls project={project} />
      </header>

      {lastError && (
        <div className="error-bar" onClick={dismissError}>
          {lastError} <span className="dismiss">dismiss</span>
        </div>
      )}

      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <div className="transcript-inner">
          {transcript.length === 0 && !draft && (
            <div className="empty-state">
              <img className="empty-face" src="/ruri-face.png" alt="" />
              <div className="empty-title">Fresh session</div>
              <div className="empty-hint">
                Starts in <code>{project.path}</code> with your first message.
              </div>
            </div>
          )}
          {(() => {
            const turns = groupTurns(transcript);
            return turns.map((turn, i) => {
              const summary = summaries[turn.turnId];
              const fold =
                compact && summary !== undefined && i < turns.length - 1 && !expanded.has(turn.turnId);
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
          {status === "working" && !draft && (
            <div className="thinking">
              <span />
              <span />
              <span />
            </div>
          )}
          {permissions.map((request) => (
            <PermissionBanner key={request.requestId} request={request} />
          ))}
        </div>
      </div>

      {showJump && (
        <button className="jump-latest" onClick={() => scrollToBottom("smooth")}>
          <Icon d="M12 5v14M5 12l7 7 7-7" /> Latest
        </button>
      )}

      {trackerOpen && <Tracker projectId={activeId} onClose={() => setTrackerOpen(false)} />}

      <Composer projectId={activeId} busy={busy} />
    </main>
  );
}
