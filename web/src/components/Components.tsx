import { useEffect, useRef, useState } from "react";
import type { NamedComponent } from "../../../shared/protocol";
import { ToolImage } from "./Attachments";
import { fileToBase64 } from "../lib/files";
import { send, useRuri } from "../store";

/**
 * The component index: the user's names for the parts of a project — read
 * here, but never typed here.
 *
 * Half of every "no, the OTHER one" is a naming problem — the user says "the
 * dragon gauges" and the model reads a repository that has never used those
 * words. Naming one here fixes the words to an address: files, a note, and a
 * picture. From then on the name is enough.
 *
 * Entries arrive two ways. One is the chat: a session that has just built
 * something calls ruri's naming tool, a card comes up with its suggested
 * name, and what the user confirms is the entry — the only moment both
 * sides are looking at the same thing, so the only moment worth asking.
 *
 * The other is the button at the top of this page, because the first way
 * has a hole in it: it only ever catches what gets built from now on. A
 * project that existed before any of this is entirely unnamed and would
 * stay that way, since nothing is going to announce work that was finished
 * last year. The button reads the whole repo, names what nobody has named,
 * and — if the project is something that can be opened — starts it up and
 * photographs each one (see server/sweep.ts and server/shots.ts). What
 * comes back is a first draft; correcting it is what this page is for.
 *
 * New entries wear a spinning star until they've been seen: beside the name
 * for what the last prompt named, and hooked over the card's top-left
 * corner for what's been waiting longer. Looking at them is what takes it
 * off — hover one, or simply leave the page.
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

/**
 * How to find a component in the running app, written as one path:
 *
 *   /settings >> .tab-advanced >> .danger-zone
 *
 * A leading segment starting with "/" is the page to open; the last is the
 * thing itself; anything between is clicked on the way. One field, because
 * three fields for "where is it" would be three fields nobody fills in —
 * and this is what the screenshot pass follows, so it has to be typeable
 * when the sweep's guess was wrong.
 */
function parsePath(value: string): { selector: string; route: string; clicks: string[] } {
  const parts = value
    .split(">>")
    .map((part) => part.trim())
    .filter(Boolean);
  const route = parts[0]?.startsWith("/") ? parts.shift()! : "";
  const selector = parts.pop() ?? "";
  return { selector, route, clicks: parts };
}

/** The same path, written back out for the field to hold. */
function showPath(item: NamedComponent): string {
  if (!item.selector) return "";
  return [item.route ?? "", ...(item.clicks ?? []), item.selector].filter(Boolean).join(" >> ");
}

/**
 * The star a new component wears. It turns, because a page of identical
 * cards is exactly the place a still mark goes unnoticed — and it turns
 * slowly, because this is a page you read.
 */
function Star({ where }: { where: "just" | "still" }) {
  return (
    <span
      className={`comp-star ${where}`}
      title={where === "just" ? "Named just now" : "New since you last looked"}
      aria-label="new"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2.5l2.7 6.1 6.6.7-4.9 4.5 1.4 6.5L12 17l-5.8 3.3 1.4-6.5L2.7 9.3l6.6-.7z" />
      </svg>
    </span>
  );
}

/** How long a finished sweep's summary line stays up. */
const FINAL_NOTE_MS = 25_000;

function Card({ projectId, item }: { projectId: string; item: NamedComponent }) {
  const [name, setName] = useState(item.name);
  const [aliases, setAliases] = useState(item.aliases.join(", "));
  const [files, setFiles] = useState(item.files.join(", "));
  const [note, setNote] = useState(item.note);
  const [where, setWhere] = useState(showPath(item));

  const patch = (
    extra: Partial<{
      name: string;
      aliases: string[];
      files: string[];
      note: string;
      selector: string;
      route: string;
      clicks: string[];
    }>,
  ) => send({ type: "component_update", projectId, componentId: item.id, ...extra });

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
      className={`comp-card${item.star ? " fresh" : ""}`}
      // Hovering a card is having looked at it: the star has done its job
      // the moment the eye is on the thing it was pointing at.
      onMouseEnter={() => {
        if (item.star) send({ type: "component_seen", projectId, componentId: item.id });
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const dropped = [...e.dataTransfer.files];
        if (dropped.length === 0) return;
        e.preventDefault();
        void addShots(dropped);
      }}
    >
      {item.star === "still" && <Star where="still" />}
      <div className="comp-top">
        <input
          className="comp-name"
          value={name}
          placeholder="what you call it"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== item.name && patch({ name: name.trim() })}
        />
        {item.star === "just" && <Star where="just" />}
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

      {/* What finds it in the running app — this is what gets photographed,
          so a wrong one here is a picture of the wrong thing. Fix it and
          sweep again; anything still without a picture gets another go. */}
      <label className="comp-field">
        <span>on screen</span>
        <input
          value={where}
          placeholder=".dragon-gauges  ·  /settings >> .tab >> .panel"
          spellCheck={false}
          onChange={(e) => setWhere(e.target.value)}
          onBlur={() => where !== showPath(item) && patch(parsePath(where))}
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
        {/* The picture opens; only the × takes it away. It used to be one
            button that removed on click, so looking at what a screenshot
            actually was deleted it — with nothing asked and no way back. */}
        {item.shots.map((shot) => (
          <div key={shot.id} className="comp-shot">
            <ToolImage image={{ url: shot.url ?? "", name: shot.name }} />
            <button
              className="att-remove"
              title="Remove this screenshot"
              onClick={() =>
                send({ type: "component_unshot", projectId, componentId: item.id, shotId: shot.id })
              }
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
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

/** "just now", "2h ago", "3d ago" — when the repo was last read. */
function since(at: number | undefined): string {
  if (!at) return "never";
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The catch-up brief's control: the other file in .ruri/ that tells a
 * model what this project is. It writes itself a turn at a time; this is
 * the read of the whole repo that writes it all at once — what happens by
 * itself when a project first arrives, and again on request.
 */
function CatchupLine({ projectId }: { projectId: string }) {
  const state = useRuri((s) => s.catchups[projectId]);
  const busy = state?.busy === true;
  const [noteStale, setNoteStale] = useState(false);
  useEffect(() => {
    if (!state || busy) {
      setNoteStale(false);
      return;
    }
    const timer = setTimeout(() => setNoteStale(true), FINAL_NOTE_MS);
    return () => clearTimeout(timer);
  }, [state?.at, busy]);
  const note = state?.note && !noteStale ? state.note : undefined;
  return (
    <div className="board-foot catchup-line">
      The catch-up brief in <code>.ruri/catchup.md</code> — what this project is, the stack, how to
      run it, where things are — {note ? <span className="catchup-note">{note}</span> : <>last read from the repo <b>{since(state?.built)}</b></>}.
      <button
        className="catchup-rebuild"
        disabled={busy}
        title="Read the whole repo again and write the brief afresh — its description and features are kept where they still hold"
        onClick={() => send({ type: "catchup_rebuild", projectId })}
      >
        {busy ? "Reading…" : "Rebuild"}
      </button>
    </div>
  );
}

export function Components({ projectId }: { projectId: string }) {
  const items = useRuri((s) => s.components[projectId]) ?? [];
  const sweep = useRuri((s) => s.sweeps[projectId]);
  const busy = sweep?.busy === true;

  // The sweep's last word stays up for a moment after it finishes — long
  // enough to read what it did, not long enough to still be there next time
  // the page is opened and mean nothing.
  const [noteStale, setNoteStale] = useState(false);
  useEffect(() => {
    if (!sweep || busy) {
      setNoteStale(false);
      return;
    }
    const timer = setTimeout(() => setNoteStale(true), FINAL_NOTE_MS);
    return () => clearTimeout(timer);
  }, [sweep?.at, busy]);
  const note = sweep?.note && !noteStale ? sweep.note : undefined;

  // Leaving the page is the other way of having looked: the stars were up
  // the whole time this was on screen, and they don't follow you out. The
  // ref keeps the send out of the effect's dependencies, so it fires once
  // on the way out rather than on every index update.
  const starred = useRef(false);
  starred.current = items.some((item) => item.star);
  useEffect(
    () => () => {
      if (starred.current) send({ type: "component_seen", projectId });
    },
    [projectId],
  );

  return (
    <section className="board-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Components</span>
          <span className="board-sub">{note ?? `${items.length} named`}</span>
          <button
            className="comp-sweep"
            disabled={busy}
            title={
              "Read the whole repo, name everything nobody has named yet, and — if the project " +
              "can be opened — start it up and photograph each one"
            }
            onClick={() => send({ type: "components_sweep", projectId })}
          >
            {busy ? "Sweeping…" : "Name everything"}
          </button>
        </div>

        <div className="comp-list">
          {items.length === 0 && (
            <div className="board-empty">
              Nothing named yet. Entries arrive on their own — when a session builds a piece of
              this project's interface it says so, and a card comes up in the chat with a suggested
              name; whatever you change it to is what it's called from then on. For everything
              that was already here before any of that, <b>Name everything</b> reads the repo,
              names what it finds, and takes a picture of each one it can open. Whatever it gets
              wrong, correct here.
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
        <CatchupLine projectId={projectId} />
      </div>
    </section>
  );
}
