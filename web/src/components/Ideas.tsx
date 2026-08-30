import { useState } from "react";
import type { Idea } from "../../../shared/protocol";
import { composeInto, send, useRuri } from "../store";

/**
 * The ideas board: a project's list of wants, in the user's own words.
 *
 * It is the tracker's opposite number. The tracker is written by the model
 * and reviewed by the user; this is written by the user and read by nobody
 * until they say so. Nothing lands here on its own, nothing leaves on its
 * own, and the only states are "still want this" and "done".
 *
 * The arrow on a row is the whole bridge to the rest of the app: it drops
 * the idea into the composer as a prompt, where it stops being an idea.
 */

function IdeaRow({
  projectId,
  channelId,
  idea,
}: {
  projectId: string;
  channelId: string;
  idea: Idea;
}) {
  const [draft, setDraft] = useState(idea.text);
  const [editing, setEditing] = useState(false);

  const save = () => {
    setEditing(false);
    const text = draft.trim();
    if (!text || text === idea.text) {
      setDraft(idea.text);
      return;
    }
    send({ type: "idea_update", projectId, ideaId: idea.id, text });
  };

  return (
    <div className={`idea-row ${idea.done ? "done" : ""}`}>
      <button
        className="idea-box"
        title={idea.done ? "Not done after all" : "Done"}
        onClick={() => send({ type: "idea_update", projectId, ideaId: idea.id, done: !idea.done })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          {idea.done && <path d="M8 12.5l3 3 5.5-6" />}
        </svg>
      </button>

      {editing ? (
        <input
          className="idea-edit"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setDraft(idea.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="idea-text" onClick={() => setEditing(true)} title="Click to edit">
          {idea.text}
        </span>
      )}

      <button
        className="idea-send"
        title="Put it in the composer as a prompt"
        onClick={() => composeInto(channelId, idea.text)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
      <button
        className="idea-drop"
        title="Off the board"
        onClick={() => send({ type: "idea_remove", projectId, ideaId: idea.id })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export function Ideas({ projectId, channelId }: { projectId: string; channelId: string }) {
  const ideas = useRuri((s) => s.ideas[projectId]) ?? [];
  const [text, setText] = useState("");

  const add = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    send({ type: "idea_add", projectId, text: trimmed });
    setText("");
  };

  const open = ideas.filter((i) => !i.done);
  const done = ideas.filter((i) => i.done);

  return (
    <section className="board-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Ideas</span>
          <span className="board-sub">{open.length} open</span>
        </div>

        <div className="idea-add">
          <input
            placeholder="Something you want…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button className="ghost" disabled={!text.trim()} onClick={add}>
            Add
          </button>
        </div>

        <div className="idea-list">
          {ideas.length === 0 && (
            <div className="board-empty">
              Nothing yet. Anything you want out of your head and somewhere safe goes here.
            </div>
          )}
          {[...open, ...done].map((idea) => (
            <IdeaRow key={idea.id} projectId={projectId} channelId={channelId} idea={idea} />
          ))}
        </div>
      </div>
    </section>
  );
}
