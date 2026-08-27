import { useEffect, useRef, useState } from "react";
import type { TrackerItem, TrackerStatus } from "../../../shared/protocol";
import { fileKind, fileToBase64 } from "./Attachments";
import { send, useRuri } from "../store";

/**
 * The feature tracker drawer: a checklist of things worth testing by hand,
 * extracted from each turn by the small model. Reviewing is one pass over
 * the list — click an item once for "works", twice for "needs fixing"
 * (which folds a note field out; paste files straight into it); items never
 * move while you review. "Finish review" clears the checked ones, pins the
 * crossed ones as repeats, and drops a small-model-written fix-it prompt
 * straight into the composer. Clicking anywhere outside closes the drawer.
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

const ATT_ICONS: Record<string, React.ReactNode> = {
  image: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="9" cy="9" r="1.6" />
      <path d="M21 15l-5-5-9 9" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden>
      <path d="M8 5.5v13l11-6.5-11-6.5z" />
    </svg>
  ),
  file: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
    </svg>
  ),
};

function ItemRow({ projectId, item }: { projectId: string; item: TrackerItem }) {
  const [noteDraft, setNoteDraft] = useState(item.note);
  // crossing an item folds its note out; anything else starts folded
  const [notesOpen, setNotesOpen] = useState(item.status === "rejected" && item.note !== "");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const prevStatus = useRef(item.status);

  // The moment an item turns rejected, the note field unfolds and focuses.
  useEffect(() => {
    if (item.status === "rejected" && prevStatus.current !== "rejected") {
      setNotesOpen(true);
      requestAnimationFrame(() => noteRef.current?.focus());
    }
    prevStatus.current = item.status;
  }, [item.status]);

  const cycle = () =>
    send({ type: "tracker_update", projectId, itemId: item.id, status: NEXT_STATUS[item.status] });

  const saveNote = () => {
    if (noteDraft !== item.note) {
      send({ type: "tracker_update", projectId, itemId: item.id, note: noteDraft });
    }
  };

  const attachFiles = async (files: File[]) => {
    for (const [i, file] of files.entries()) {
      if (file.size > 25 * 1024 * 1024) {
        alert(`${file.name} is over 25MB — too big to attach.`);
        continue;
      }
      send({
        type: "tracker_attach",
        projectId,
        itemId: item.id,
        upload: {
          id: crypto.randomUUID(),
          kind: fileKind(file),
          mediaType: file.type || "application/octet-stream",
          name: file.name || "pasted",
          n: (item.attachments?.length ?? 0) + i + 1,
          data: await fileToBase64(file),
        },
      });
    }
  };

  const atts = item.attachments ?? [];
  const hasNote = item.status === "rejected" || item.note.trim() !== "" || atts.length > 0;
  const open = hasNote && notesOpen;

  return (
    <div className={`tracker-item ${item.status}`}>
      <div
        className="tracker-item-main"
        title="Once: works · twice: needs fixing · again: clear"
        onClick={cycle}
      >
        <span className="tracker-check">
          <StatusBox status={item.status} />
          {item.repeat && (
            <span className="tracker-repeat" title="Repeat — marked needs-work in an earlier review">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M1 4v6h6M23 20v-6h-6" />
                <path d="M20.5 9A9 9 0 0 0 5.6 5.6L1 10M23 14l-4.6 4.4A9 9 0 0 1 3.5 15" />
              </svg>
            </span>
          )}
        </span>
        <span className="tracker-text">{item.text}</span>
        <span className="tracker-item-actions">
          {hasNote && (
            <button
              className={`icon-button tracker-fold ${open ? "open" : ""}`}
              title={open ? "Fold the note away" : "Show the note"}
              onClick={(e) => {
                e.stopPropagation();
                setNotesOpen(!open);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          )}
          <button
            className="icon-button"
            title="Delete item"
            onClick={(e) => {
              e.stopPropagation();
              send({ type: "tracker_remove", projectId, itemId: item.id });
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      <div className={`tracker-note-wrap ${open ? "open" : ""}`}>
        <div className="tracker-note-inner">
          {atts.length > 0 && (
            <div className="note-atts">
              {atts.map((a, i) => (
                <button
                  key={a.id}
                  className="note-att"
                  title={`${a.name} — click to remove`}
                  onClick={() =>
                    send({ type: "tracker_detach", projectId, itemId: item.id, attachmentId: a.id })
                  }
                >
                  #{i + 1}
                  {ATT_ICONS[a.kind] ?? ATT_ICONS["file"]}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={noteRef}
            className="tracker-note-edit"
            rows={2}
            value={noteDraft}
            placeholder="What to fix or change… (paste files here too)"
            tabIndex={open ? 0 : -1}
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={saveNote}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length > 0) {
                e.preventDefault();
                void attachFiles(files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                noteRef.current?.blur();
              }
              if (e.key === "Escape") {
                setNoteDraft(item.note);
                setNotesOpen(false);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function Tracker({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const items = useRuri((s) => s.tracker[projectId]) ?? [];
  const drawerRef = useRef<HTMLElement>(null);

  // Clicking anywhere outside the drawer closes it. The header toggle is
  // excluded — it flips the drawer itself and would instantly reopen it.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target || drawerRef.current?.contains(target)) return;
      if (target.closest(".tracker-toggle")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  // Repeats pin to the top; everything else keeps its order. Checking or
  // crossing an item never moves it — order only changes between reviews.
  const ordered = [...items.filter((i) => i.repeat), ...items.filter((i) => !i.repeat)];
  const openCount = items.filter((i) => i.status === "open").length;
  const reviewed = items.length - openCount;

  return (
    <aside className="tracker-drawer" ref={drawerRef}>
      <div className="tracker-head">
        <span className="tracker-title">Tracker</span>
        <span className="tracker-sub">
          {openCount} to check
        </span>
        <button className="icon-button" title="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="tracker-list">
        {items.length === 0 && (
          <div className="tracker-empty">
            Nothing tracked yet. New features from each turn land here automatically.
          </div>
        )}
        {ordered.map((item) => (
          <ItemRow key={item.id} projectId={projectId} item={item} />
        ))}
      </div>

      {items.length > 0 && (
        <button
          className="tracker-finish"
          disabled={reviewed === 0}
          title="Checked items clear, crossed ones pin as repeats, and a fix-it prompt lands in the composer"
          onClick={() => {
            send({ type: "tracker_review", projectId });
            onClose();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Finish review
        </button>
      )}
    </aside>
  );
}
