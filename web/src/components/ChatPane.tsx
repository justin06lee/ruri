import { useEffect, useRef, useState } from "react";
import type { PermissionRequest, TranscriptEvent } from "../../../shared/protocol";
import { send, useRuri } from "../store";

function EventView({ event }: { event: TranscriptEvent }) {
  switch (event.kind) {
    case "user":
      return <div className="msg user">{event.text}</div>;
    case "assistant":
      return <div className="msg assistant">{event.text}</div>;
    case "tool":
      return (
        <div className="tool-chip">
          <span className="tool-name">{event.name}</span>
          <span className="tool-summary">{event.summary}</span>
        </div>
      );
    case "result":
      return (
        <div className={`result-line ${event.ok ? "ok" : "err"}`}>
          {event.ok
            ? `✓ done${event.costUsd !== undefined ? ` · $${event.costUsd.toFixed(4)}` : ""}${
                event.durationMs !== undefined ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ""
              }`
            : `✗ ${event.error ?? "error"}`}
        </div>
      );
    case "info":
      return <div className="info-line">{event.text}</div>;
  }
}

function PermissionBanner({ request }: { request: PermissionRequest }) {
  return (
    <div className="permission">
      <div className="permission-head">
        Claude wants to use <b>{request.toolName}</b>
      </div>
      <pre className="permission-input">{JSON.stringify(request.input, null, 2)}</pre>
      <div className="permission-actions">
        <button
          className="primary"
          onClick={() => send({ type: "permission_response", requestId: request.requestId, allow: true })}
        >
          Allow
        </button>
        <button
          onClick={() => send({ type: "permission_response", requestId: request.requestId, allow: false })}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function Composer({ projectId, busy }: { projectId: string; busy: boolean }) {
  const [text, setText] = useState("");

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send({ type: "send", projectId, text: trimmed });
    setText("");
  };

  return (
    <div className="composer">
      <textarea
        rows={3}
        placeholder="Message Claude Code… (Enter to send, Shift+Enter for newline)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-actions">
        {busy && (
          <button className="stop" onClick={() => send({ type: "interrupt", projectId })}>
            ■ Stop
          </button>
        )}
        <button className="primary" onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}

export function ChatPane() {
  const activeId = useRuri((s) => s.activeId);
  const project = useRuri((s) => s.projects.find((p) => p.id === s.activeId));
  const transcript = useRuri((s) => (s.activeId ? (s.transcripts[s.activeId] ?? []) : []));
  const draft = useRuri((s) => (s.activeId ? s.drafts[s.activeId] : undefined));
  const status = useRuri((s) => (s.activeId ? (s.statuses[s.activeId] ?? "idle") : "idle"));
  const permissions = useRuri((s) => s.permissions.filter((p) => p.projectId === s.activeId));
  const lastError = useRuri((s) => s.lastError);
  const dismissError = useRuri((s) => s.dismissError);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activeId, transcript.length, draft?.text, permissions.length]);

  if (!project || !activeId) {
    return (
      <main className="chat empty">
        <div className="hint">Add a project on the left, then talk to Claude Code here.</div>
      </main>
    );
  }

  const busy = status === "working" || status === "permission";

  return (
    <main className="chat">
      <header className="chat-header">
        <div>
          <div className="chat-title">{project.name}</div>
          <div className="chat-path">{project.path}</div>
        </div>
        <div className={`status-pill ${status}`}>{status}</div>
      </header>

      {lastError && (
        <div className="error-bar" onClick={dismissError}>
          {lastError} <span className="dismiss">(dismiss)</span>
        </div>
      )}

      <div className="transcript" ref={scrollRef}>
        {transcript.length === 0 && !draft && (
          <div className="hint">
            Fresh session — it starts in <code>{project.path}</code> when you send the first message.
          </div>
        )}
        {transcript.map((event) => (
          <EventView key={event.id} event={event} />
        ))}
        {draft && (
          <div className="msg assistant streaming">
            {draft.text}
            <span className="cursor">▋</span>
          </div>
        )}
        {status === "working" && !draft && <div className="info-line pulse">working…</div>}
        {permissions.map((request) => (
          <PermissionBanner key={request.requestId} request={request} />
        ))}
      </div>

      <Composer projectId={activeId} busy={busy} />
    </main>
  );
}
