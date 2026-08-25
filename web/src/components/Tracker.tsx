import { useState } from "react";
import type { TrackerItem, TrackerStatus } from "../../../shared/protocol";
import { send, useRuri } from "../store";

/**
 * The feature/prompt tracker drawer: a checklist of things worth testing by
 * hand, extracted from each turn by the small model plus anything added
 * manually ("background prompts"). Clicking the box cycles
 * open → liked (check) → rejected (x) → open; notes hold fix-it thoughts,
 * and any item can be sent back into the composer as a prompt.
 */

const NEXT_STATUS: Record<TrackerStatus, TrackerStatus> = {
  open: "liked",
  liked: "rejected",
  rejected: "open",
};

function StatusBox({ status }: { status: TrackerStatus }) {
  return (
    <svg
      className={`tracker-box ${status}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      {status === "liked" && <path d="M8 12.5l3 3 5.5-6" />}
      {status === "rejected" && <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" />}
    </svg>
  );
}

function ItemRow({ projectId, item }: { projectId: string; item: TrackerItem }) {
  const seedComposer = useRuri((s) => s.seedComposer);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(item.note);

  const cycle = () =>
    send({ type: "tracker_update", projectId, itemId: item.id, status: NEXT_STATUS[item.status] });

  const saveNote = () => {
    setEditingNote(false);
    if (noteDraft !== item.note) {
      send({ type: "tracker_update", projectId, itemId: item.id, note: noteDraft });
    }
  };

  return (
    <div className={`tracker-item ${item.status}`}>
      <div className="tracker-item-main">
        <button
          className="tracker-check"
          title="Click to cycle: open / liked / needs work"
          onClick={cycle}
        >
          <StatusBox status={item.status} />
        </button>
        <span className="tracker-text">{item.text}</span>
        <span className="tracker-item-actions">
          <button
            className="icon-button"
            title="Send to the composer as a prompt"
            onClick={() => seedComposer(item.note ? `${item.text} — ${item.note}` : item.text)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
          <button
            className="icon-button"
            title="Delete item"
            onClick={() => send({ type: "tracker_remove", projectId, itemId: item.id })}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      {editingNote ? (
        <textarea
          className="tracker-note-edit"
          rows={2}
          value={noteDraft}
          placeholder="What to fix or change…"
          autoFocus
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              saveNote();
            }
            if (e.key === "Escape") {
              setNoteDraft(item.note);
              setEditingNote(false);
            }
          }}
        />
      ) : (
        <button
          className={`tracker-note ${item.note ? "" : "empty"}`}
          onClick={() => {
            setNoteDraft(item.note);
            setEditingNote(true);
          }}
        >
          {item.note || "Add note"}
        </button>
      )}
    </div>
  );
}

export function Tracker({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const items = useRuri((s) => s.tracker[projectId]) ?? [];
  const [draft, setDraft] = useState("");

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    send({ type: "tracker_add", projectId, text });
    setDraft("");
  };

  const open = items.filter((i) => i.status === "open");
  const done = items.filter((i) => i.status !== "open");

  return (
    <aside className="tracker-drawer">
      <div className="tracker-head">
        <span className="tracker-title">Tracker</span>
        <span className="tracker-sub">
          {open.length} to check
        </span>
        <button className="icon-button" title="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="tracker-add">
        <input
          placeholder="Add an item or background prompt…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
      </div>

      <div className="tracker-list">
        {items.length === 0 && (
          <div className="tracker-empty">
            Nothing tracked yet. New features from each turn land here automatically — or add
            your own above.
          </div>
        )}
        {open.map((item) => (
          <ItemRow key={item.id} projectId={projectId} item={item} />
        ))}
        {done.length > 0 && open.length > 0 && <div className="tracker-divider" />}
        {done.map((item) => (
          <ItemRow key={item.id} projectId={projectId} item={item} />
        ))}
      </div>
    </aside>
  );
}
