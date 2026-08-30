import { useState } from "react";
import type { ComponentProposal, PermissionRequest } from "../../../shared/protocol";
import { send } from "../store";

/**
 * The naming card. The model has just built a piece of interface and is
 * saying so; this asks what to call it.
 *
 * It exists because of a gap nobody can close from one side: the model knows
 * the filename and the user knows what the thing looks like, and neither
 * name is any use to the other. The one moment both are looking at the same
 * object is the moment it gets built — so that is when the name is agreed,
 * once, instead of being reconstructed from "no, the other one" forever
 * after.
 *
 * It rides the permission channel, like the question card, and is told apart
 * by `request.kind === "component"`. What comes back resolves the model's
 * tool call, so it learns the name the user chose and uses it from then on.
 */

/** Comma-or-newline separated, the way people actually type lists. */
function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function NameCard({ request }: { request: PermissionRequest }) {
  const proposal = request.input as ComponentProposal;
  const [name, setName] = useState(proposal.name ?? "");
  const [files, setFiles] = useState((proposal.files ?? []).join(", "));
  const [note, setNote] = useState(proposal.note ?? "");
  const [open, setOpen] = useState(false);

  const keep = () =>
    send({
      type: "component_named",
      requestId: request.requestId,
      name: name.trim(),
      files: parseList(files),
      note: note.trim(),
    });

  return (
    <div className="ask-card name-card">
      <div className="ask-title">
        <span className="ask-badge">New</span>
        <span className="name-lead">I made something. What do you call it?</span>
      </div>

      <input
        className="name-input"
        value={name}
        autoFocus
        placeholder="the words you'd actually use"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) keep();
        }}
      />

      {note.trim() && !open && <p className="name-note">{note}</p>}
      {(proposal.files ?? []).length > 0 && !open && (
        <p className="name-files">{(proposal.files ?? []).join(" · ")}</p>
      )}

      {open && (
        <div className="name-detail">
          <label className="comp-field">
            <span>in the code</span>
            <input value={files} onChange={(e) => setFiles(e.target.value)} />
          </label>
          <textarea
            className="comp-note"
            value={note}
            placeholder="one line on what it is…"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}

      <div className="ask-actions">
        <button className="ghost" onClick={() => setOpen(!open)}>
          {open ? "Less" : "Details"}
        </button>
        <span className="name-spacer" />
        <button
          className="ghost"
          title="Don't keep this one — nothing is written down"
          onClick={() => send({ type: "component_named", requestId: request.requestId, skip: true })}
        >
          Skip
        </button>
        <button className="primary" disabled={!name.trim()} onClick={keep}>
          Name it
        </button>
      </div>
    </div>
  );
}
