import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { sideOf, type Project, type TranscriptEvent } from "../../../shared/protocol";
import { StreamingMarkdown } from "../markdown";
import { ensureTranscript, isBusy, send, sendPrompt, useRuri } from "../store";

/**
 * /btw: quick questions on the side. A panel down the right of the
 * project chat, talking to the project's side chat (SessionInfo.side) — a
 * chat of its own, on Sonnet, that reads and changes nothing — so asking
 * never interrupts the project chat's turn or fills its context. Opened
 * from the header's "btw" button or by sending "/btw <question>" in the
 * composer.
 */
const useBtw = create<{ open: string | null; pending: string | null }>(() => ({ open: null, pending: null }));

/** Open the panel on a project, asking `question` once its side chat is there. */
export function openBtw(projectId: string, question?: string): void {
  useBtw.setState({ open: projectId, pending: question?.trim() || null });
}

export function closeBtw(): void {
  useBtw.setState({ open: null, pending: null });
}

export function useBtwOpen(projectId: string): boolean {
  return useBtw((s) => s.open === projectId);
}

/** "/btw what does X do?" → "what does X do?"; anything else, null. */
export function btwQuestion(text: string): string | null {
  const m = /^\/btw(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? (m[1] ?? "").trim() : null;
}

interface Aside {
  id: string;
  question: string;
  answer: string;
}

/** The side chat's transcript as question and answer pairs: what was asked,
 *  and the last thing said back. */
function asides(events: TranscriptEvent[]): Aside[] {
  const out: Aside[] = [];
  for (const event of events) {
    if (event.kind === "user") out.push({ id: event.id, question: event.text, answer: "" });
    else if (event.kind === "assistant" && event.text.trim() && out.length)
      out[out.length - 1]!.answer = event.text;
  }
  return out;
}

const NO_EVENTS: TranscriptEvent[] = [];

export function BtwPanel({ project }: { project: Project }) {
  const open = useBtwOpen(project.id);
  const pending = useBtw((s) => s.pending);
  const side = sideOf(project);
  const sideId = side?.id;
  const events = useRuri((s) => (sideId ? (s.transcripts[sideId] ?? NO_EVENTS) : NO_EVENTS));
  const busy = useRuri((s) => (sideId ? isBusy(s, sideId) : false));
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // the side chat is made the first time it is wanted
  useEffect(() => {
    if (open && !sideId) send({ type: "side_chat", projectId: project.id });
  }, [open, sideId, project.id]);
  useEffect(() => {
    if (open && sideId) ensureTranscript(sideId);
  }, [open, sideId]);
  // a question asked before the side chat existed goes once it does
  useEffect(() => {
    if (!open || !sideId || !pending) return;
    useBtw.setState({ pending: null });
    sendPrompt({ type: "send", projectId: sideId, text: pending });
  }, [open, sideId, pending]);
  useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [events, busy]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeBtw();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const items = asides(events);
  const ask = () => {
    const question = text.trim();
    if (!question || !sideId) return;
    sendPrompt({ type: "send", projectId: sideId, text: question });
    setText("");
  };
  return (
    <aside className="btw-panel" aria-label="btw">
      <div className="btw-head">
        <span className="btw-title">btw</span>
        <span className="btw-sub">quick questions · the project chat carries on</span>
        <button className="btw-close" title="Close (Esc)" onClick={closeBtw}>
          ×
        </button>
      </div>
      <div className="btw-list" ref={listRef}>
        {items.length === 0 && !busy && (
          <div className="btw-empty">
            Ask anything about {project.name}. It reads the project and changes nothing.
          </div>
        )}
        {items.map((item, i) => (
          <div className="btw-item" key={item.id}>
            <div className="btw-q">{item.question}</div>
            {item.answer ? (
              <div className="btw-a">
                <StreamingMarkdown text={item.answer} />
              </div>
            ) : (
              busy && i === items.length - 1 && <div className="btw-a btw-thinking">thinking…</div>
            )}
          </div>
        ))}
      </div>
      <textarea
        ref={boxRef}
        className="btw-box"
        rows={2}
        placeholder={sideId ? "Ask on the side…" : "Opening the side chat…"}
        value={text}
        disabled={!sideId}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            ask();
          }
        }}
      />
    </aside>
  );
}
