import { useState } from "react";
import type { NamedComponent } from "../../../shared/protocol";
import { fileToBase64 } from "../lib/files";
import { HTTP_BASE, send, useRuri } from "../store";

/**
 * The component index: the user's names for the parts of a project — read
 * here, but never typed here.
 *
 * Half of every "no, the OTHER one" is a naming problem — the user says "the
 * dragon gauges" and the model reads a repository that has never used those
 * words. Naming one here fixes the words to an address: files, a note, and a
 * picture. From then on the name is enough.
 *
 * Entries arrive from the chat: a session that has just built something
 * calls ruri's naming tool, a card comes up with its suggested name, and
 * what the user confirms is the entry. That is the only moment both sides
 * are looking at the same thing, so it is the only moment worth asking.
 *
 * What the model does with it lives in server/components.ts: the index is
 * written into the project as `.ruri/components.md` for any harness to read,
 * and a prompt that names an entry carries that entry down with it.
 */

/** Comma-or-newline separated, the way people actually type lists. */
function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function Card({ projectId, item }: { projectId: string; item: NamedComponent }) {
  const [name, setName] = useState(item.name);
  const [aliases, setAliases] = useState(item.aliases.join(", "));
  const [files, setFiles] = useState(item.files.join(", "));
  const [note, setNote] = useState(item.note);

  const patch = (extra: Partial<{ name: string; aliases: string[]; files: string[]; note: string }>) =>
    send({ type: "component_update", projectId, componentId: item.id, ...extra });

  const addShots = async (list: File[]) => {
    for (const file of list) {
      if (!file.type.startsWith("image/")) continue;
      send({
        type: "component_shot",
        projectId,
        componentId: item.id,
        upload: {
          id: crypto.randomUUID(),
          kind: "image",
          mediaType: file.type,
          name: file.name,
          n: 1,
          data: await fileToBase64(file),
        },
      });
    }
  };

  return (
    <div
      className="comp-card"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const dropped = [...e.dataTransfer.files];
        if (dropped.length === 0) return;
        e.preventDefault();
        void addShots(dropped);
      }}
    >
      <div className="comp-top">
        <input
          className="comp-name"
          value={name}
          placeholder="what you call it"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== item.name && patch({ name: name.trim() })}
        />
        <button
          className="icon-button"
          title="Forget this one"
          onClick={() => send({ type: "component_remove", projectId, componentId: item.id })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <label className="comp-field">
        <span>also called</span>
        <input
          value={aliases}
          placeholder="the gauges, the bars"
          onChange={(e) => setAliases(e.target.value)}
          onBlur={() => patch({ aliases: parseList(aliases) })}
        />
      </label>

      <label className="comp-field">
        <span>in the code</span>
        <input
          value={files}
          placeholder="web/src/components/Dragon.tsx, styles.css:2864"
          onChange={(e) => setFiles(e.target.value)}
          onBlur={() => patch({ files: parseList(files) })}
        />
      </label>

      <textarea
        className="comp-note"
        value={note}
        placeholder="Anything the model should know before touching it…"
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== item.note && patch({ note })}
        onPaste={(e) => {
          const pasted = [...e.clipboardData.files];
          if (pasted.length === 0) return;
          e.preventDefault();
          void addShots(pasted);
        }}
      />

      <div className="comp-shots">
        {item.shots.map((shot) => (
          <button
            key={shot.id}
            className="comp-shot"
            title="Remove this screenshot"
            onClick={() =>
              send({ type: "component_unshot", projectId, componentId: item.id, shotId: shot.id })
            }
          >
            <img src={`${HTTP_BASE}${shot.url ?? ""}`} alt="" />
          </button>
        ))}
        <label className="comp-shot-add" title="Drop, paste, or pick a screenshot">
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              void addShots([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </label>
      </div>
    </div>
  );
}

export function Components({ projectId }: { projectId: string }) {
  const items = useRuri((s) => s.components[projectId]) ?? [];

  return (
    <section className="board-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Components</span>
          <span className="board-sub">{items.length} named</span>
        </div>

        <div className="comp-list">
          {items.length === 0 && (
            <div className="board-empty">
              Nothing named yet — and nothing is typed in here. When a session builds a piece of
              this project's interface it says so, and a card comes up in the chat with a suggested
              name; whatever you change it to is what it's called from then on. This page is where
              they collect, to read and to correct.
            </div>
          )}
          {items.map((item) => (
            <Card key={item.id} projectId={projectId} item={item} />
          ))}
        </div>

        {items.length > 0 && (
          <div className="board-foot">
            Written to <code>.ruri/components.md</code> in the project, and handed to the model
            whenever a prompt names one.
          </div>
        )}
      </div>
    </section>
  );
}
