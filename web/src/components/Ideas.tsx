import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ideaDraftKey,
  type Attachment,
  type DraftAttachmentUpload,
  type Idea,
} from "../../../shared/protocol";
import { fileToBase64 } from "../lib/files";
import { fitBox, markerText, releaseMarkers, stripMarkers } from "../lib/markers";
import {
  clearComposerDraft,
  composeInto,
  composerDrafts,
  HTTP_BASE,
  send,
  setComposerDraft,
  useRuri,
} from "../store";
import { AttachmentStrip, fileKind, Viewer, type ComposerAttachment, type ViewTarget } from "./Attachments";

/**
 * The ideas board: a project's list of wants, in the user's own words.
 *
 * It is the tracker's opposite number. The tracker is written by the model
 * and reviewed by the user; this is written by the user and read by nobody
 * until they say so. Nothing lands here on its own, nothing leaves on its
 * own, and the only states are "still want this" and "done".
 *
 * An idea is worked on before it is added: the box grows with what is
 * written in it, takes pictures pasted, dropped or picked, and whatever is
 * in it waits there — through leaving the page, through a relaunch — in the
 * composer-draft store, under the project's idea key. So a thought can be
 * started, left, and come back to.
 *
 * The arrow on a row is the whole bridge to the rest of the app: it drops
 * the idea into the composer as a prompt, pictures and all, where it stops
 * being an idea.
 */

/** Tallest the boxes grow before they scroll. */
const BOX_CAP = 320;

const EMPTY_COUNTER = { image: 0, video: 0, file: 0, region: 0 };

/** One marker in an idea's words: [image #2]. */
const MARKER = /\[(image|video|file) #(\d+)\]/g;

/** An idea's words with its markers drawn as the chips they are in the
 *  composer — the picture they point at is right underneath. */
function IdeaWords({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(MARKER)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(
      <span key={match.index} className="idea-marker">
        {match[1]} #{match[2]}
      </span>,
    );
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Files as attachments, numbered on from what the counter has handed out. */
function attach(files: Iterable<File>, counter: typeof EMPTY_COUNTER): ComposerAttachment[] {
  return [...files].map((file) => {
    const kind = fileKind(file);
    counter[kind] += 1;
    return {
      id: crypto.randomUUID(),
      file,
      kind,
      mediaType: file.type || "application/octet-stream",
      name: file.name || `${kind}.png`,
      n: counter[kind],
      objectUrl: URL.createObjectURL(file),
      regions: [],
    };
  });
}

/** `markers` dropped into `text` at `at`, a space either side where a word
 *  would otherwise touch them. Returns the text and where the caret goes. */
function insertAt(text: string, at: number, markers: string): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = /^\s/.test(after) ? "" : " ";
  return {
    text: `${before}${lead}${markers}${tail}${after}`,
    caret: before.length + lead.length + markers.length + tail.length,
  };
}

/** The picker behind the picture button — one hidden input per box. */
function PictureButton({ onFiles }: { onFiles(files: File[]): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="ghost idea-picture"
        title="Put a picture in"
        onClick={() => input.current?.click()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <circle cx="9" cy="10" r="1.8" />
          <path d="M21 16l-5-5-9 9" />
        </svg>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/**
 * The box a new idea is written in. Its words and pictures are the
 * project's idea draft: every change is written there (and on to the
 * server), and the box reads it back when it mounts — which is all it
 * takes for an idea half-written to still be here after going elsewhere.
 */
function IdeaComposer({ projectId }: { projectId: string }) {
  const key = ideaDraftKey(projectId);
  const saved = composerDrafts.get(key);
  const [text, setText] = useState(saved?.text ?? "");
  const [atts, setAtts] = useState<ComposerAttachment[]>(saved?.atts ?? []);
  const counter = useRef({ ...(saved?.counter ?? EMPTY_COUNTER) });
  const [viewing, setViewing] = useState<ComposerAttachment | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setComposerDraft(key, { text, atts, counter: counter.current });
  }, [key, text, atts]);

  // a relaunch brings the draft's words first and its pictures after them,
  // fetched back one by one; the bump says they have landed — heard from
  // the store as it lands, the way the composer hears its own
  const draftBump = useRuri((s) => s.draftBumps[key] ?? 0);
  const bumpSeen = useRef(draftBump);
  useEffect(() => {
    return useRuri.subscribe((s) => {
      const bump = s.draftBumps[key] ?? 0;
      if (bump === bumpSeen.current) return;
      bumpSeen.current = bump;
      const fresh = composerDrafts.get(key);
      if (!fresh) return;
      setText(fresh.text);
      setAtts(fresh.atts);
      counter.current = { ...fresh.counter };
    });
  }, [key]);

  useLayoutEffect(() => {
    if (area.current) fitBox(area.current, BOX_CAP);
  }, [text]);

  const addFiles = (files: File[], at?: number) => {
    const added = attach(files, counter.current);
    if (added.length === 0) return;
    setAtts((prev) => [...prev, ...added]);
    const where = at ?? area.current?.selectionStart ?? text.length;
    const next = insertAt(text, where, added.map((a) => markerText(a.kind, a.n)).join(" "));
    setText(next.text);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const removeAtt = (id: string) => {
    const gone = atts.find((a) => a.id === id);
    if (!gone) return;
    URL.revokeObjectURL(gone.objectUrl);
    setAtts((prev) => prev.filter((a) => a.id !== id));
    setText((prev) => stripMarkers(prev, (m) => m.kind === gone.kind && m.n === gone.n));
  };

  const add = async () => {
    const words = releaseMarkers(text).trim();
    if (!words && atts.length === 0) return;
    const attachments = await Promise.all(
      atts.map(async (att) => ({
        id: att.id,
        kind: att.kind,
        mediaType: att.mediaType,
        name: att.name,
        n: att.n,
        data: await fileToBase64(att.file),
      })),
    );
    if (!send({ type: "idea_add", projectId, text: words, ...(attachments.length ? { attachments } : {}) }))
      return; // not connected: it stays in the box to add again
    for (const att of atts) URL.revokeObjectURL(att.objectUrl);
    clearComposerDraft(key);
    counter.current = { ...EMPTY_COUNTER };
    setAtts([]);
    setText("");
  };

  const empty = !text.trim() && atts.length === 0;
  return (
    <div
      className={`idea-compose ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <AttachmentStrip attachments={atts} onRemove={removeAtt} onView={setViewing} />
      <textarea
        ref={area}
        rows={2}
        placeholder="Something you want… (Shift+Enter for a new line, paste or drop a picture)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void add();
          }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length === 0) return;
          e.preventDefault();
          addFiles(files, e.currentTarget.selectionStart);
        }}
      />
      <div className="idea-compose-bar">
        <PictureButton onFiles={(files) => addFiles(files)} />
        <span className="idea-compose-hint">
          {empty ? "kept here until you add it — even if you leave" : "Enter adds it"}
        </span>
        <button className="ghost" disabled={empty} onClick={() => void add()}>
          Add
        </button>
      </div>
      {viewing && (
        <Viewer
          target={{
            kind: viewing.kind,
            src: viewing.objectUrl,
            label: `${viewing.kind} #${viewing.n} — ${viewing.name}`,
            name: viewing.name,
            mediaType: viewing.mediaType,
          }}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/** The pictures under an idea, each opening full size; while the idea is
 *  being edited each one can be taken off. */
function IdeaPictures({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove?: (att: Attachment) => void;
}) {
  const [view, setView] = useState<ViewTarget | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className="att-strip idea-pictures">
        {attachments.map((att) => {
          const src = HTTP_BASE + (att.url ?? "");
          return (
            <div
              key={att.id}
              className="att-thumb"
              title={att.name}
              onClick={() =>
                setView({
                  kind: att.kind,
                  src,
                  label: `${att.kind} #${att.n} — ${att.name}`,
                  name: att.name,
                  mediaType: att.mediaType,
                })
              }
            >
              {att.kind === "image" ? (
                <img src={src} alt="" />
              ) : att.kind === "video" ? (
                <video src={src} muted />
              ) : (
                <span className="idea-file">{att.name}</span>
              )}
              <span className="att-n">{`${att.kind === "image" ? "img" : att.kind} #${att.n}`}</span>
              {onRemove && (
                <button
                  className="att-remove"
                  title="Take this off the idea"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(att);
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      {view && <Viewer target={view} onClose={() => setView(null)} />}
    </>
  );
}

/** What an update sends for the pictures an idea keeps: their ids alone,
 *  since the server already holds their bytes. */
function kept(attachments: Attachment[]): DraftAttachmentUpload[] {
  return attachments.map(({ id, kind, mediaType, name, n }) => ({ id, kind, mediaType, name, n }));
}

function IdeaRow({ projectId, channelId, idea }: { projectId: string; channelId: string; idea: Idea }) {
  const [draft, setDraft] = useState(idea.text);
  const [editing, setEditing] = useState(false);
  const attachments = idea.attachments ?? [];
  const area = useRef<HTMLTextAreaElement>(null);

  const save = useCallback(
    (text: string) => {
      setEditing(false);
      const words = releaseMarkers(text).trim();
      if ((!words && attachments.length === 0) || words === idea.text) {
        setDraft(idea.text);
        return;
      }
      send({ type: "idea_update", projectId, ideaId: idea.id, text: words });
    },
    [attachments.length, idea.id, idea.text, projectId],
  );

  // Leaving the page with an edit open keeps the edit: the box going away
  // is not a blur, so nothing else would.
  const pending = useRef<{ text: string; save: typeof save } | null>(null);
  useEffect(() => {
    pending.current = editing ? { text: draft, save } : null;
  }, [editing, draft, save]);
  useEffect(
    () => () => {
      const open = pending.current;
      if (open) open.save(open.text);
    },
    [],
  );

  useLayoutEffect(() => {
    if (editing && area.current) fitBox(area.current, BOX_CAP);
  }, [editing, draft]);

  /** Pictures pasted or dropped onto an idea being edited join it now,
   *  their markers where the caret was. */
  const addFiles = (files: File[], at: number) => {
    const counter = { ...EMPTY_COUNTER };
    for (const att of attachments) counter[att.kind] = Math.max(counter[att.kind], att.n);
    const added = attach(files, counter);
    if (added.length === 0) return;
    void (async () => {
      const uploads = await Promise.all(
        added.map(async (att) => ({
          id: att.id,
          kind: att.kind,
          mediaType: att.mediaType,
          name: att.name,
          n: att.n,
          data: await fileToBase64(att.file),
        })),
      );
      for (const att of added) URL.revokeObjectURL(att.objectUrl);
      const next = insertAt(draft, at, added.map((a) => markerText(a.kind, a.n)).join(" "));
      setDraft(next.text);
      send({
        type: "idea_update",
        projectId,
        ideaId: idea.id,
        text: releaseMarkers(next.text).trim(),
        attachments: [...kept(attachments), ...uploads],
      });
    })();
  };

  const removePicture = (att: Attachment) => {
    const text = releaseMarkers(stripMarkers(draft, (m) => m.kind === att.kind && m.n === att.n)).trim();
    setDraft(text);
    send({
      type: "idea_update",
      projectId,
      ideaId: idea.id,
      text,
      attachments: kept(attachments.filter((a) => a.id !== att.id)),
    });
  };

  return (
    <div className={`idea-row ${idea.done ? "done" : ""} ${editing ? "editing" : ""}`}>
      <button
        className="idea-box"
        title={idea.done ? "Not done after all" : "Done"}
        onClick={() => send({ type: "idea_update", projectId, ideaId: idea.id, done: !idea.done })}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="3" width="18" height="18" rx="4" />
          {idea.done && <path d="M8 12.5l3 3 5.5-6" />}
        </svg>
      </button>

      <div className="idea-body">
        {editing ? (
          <textarea
            ref={area}
            className="idea-edit"
            autoFocus
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => save(draft)}
            onFocus={(e) => {
              const end = e.currentTarget.value.length;
              e.currentTarget.setSelectionRange(end, end);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                save(draft);
              }
              if (e.key === "Escape") {
                setDraft(idea.text);
                setEditing(false);
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length === 0) return;
              e.preventDefault();
              addFiles(files, e.currentTarget.selectionStart);
            }}
            onDrop={(e) => {
              const files = [...e.dataTransfer.files];
              if (files.length === 0) return;
              e.preventDefault();
              addFiles(files, e.currentTarget.selectionStart);
            }}
          />
        ) : (
          <span
            className="idea-text"
            onClick={() => {
              setDraft(idea.text);
              setEditing(true);
            }}
            title="Click to edit"
          >
            {idea.text ? <IdeaWords text={idea.text} /> : <em className="idea-untitled">a picture</em>}
          </span>
        )}
        <IdeaPictures attachments={attachments} {...(editing ? { onRemove: removePicture } : {})} />
      </div>

      <button
        className="idea-send"
        title="Put it in the composer as a prompt"
        onClick={() => composeInto(channelId, idea.text, attachments)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
      <button
        className="idea-drop"
        title="Off the board"
        onClick={() => send({ type: "idea_remove", projectId, ideaId: idea.id })}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export function Ideas({ projectId, channelId }: { projectId: string; channelId: string }) {
  const ideas = useRuri((s) => s.ideas[projectId]) ?? [];
  const open = ideas.filter((i) => !i.done);
  const done = ideas.filter((i) => i.done);

  return (
    <section className="board-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Ideas</span>
          <span className="board-sub">{open.length} open</span>
        </div>

        <IdeaComposer key={projectId} projectId={projectId} />

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
