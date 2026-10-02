import { useEffect, useRef, useState } from "react";
import type {
  LayerSection,
  LayerSheet,
  MemoryLine,
  MemoryPart,
  ProjectSheet,
  SheetSection,
  SheetStamp,
  StackLayer,
  SystemFlow,
} from "../../../shared/protocol";
import { ownsSummary } from "../../../shared/protocol";
import { since, useNoteStale } from "../lib/runNote";
import { send, useRuri } from "../store";

/**
 * The architecture page: the project at a glance — the stack it is built
 * as, from what a person touches down to the engines under it, the paths
 * through it that matter, where things are, how to run it, what it can do.
 *
 * The stack is the index. Every session in the project is shown it before
 * it starts, and each layer with code of its own has a sheet behind it —
 * where to change what inside it, how it works, its key files, its traps —
 * which a session reads before working in that layer. Here a bar opens its
 * sheet underneath, so the user sees exactly what an agent gets. (An older
 * sheet, not read since layers had sheets, keeps its one map of where to
 * change what at the top instead.)
 *
 * It is `.ruri/architecture.md` and `.ruri/layers/` in the project, drawn
 * for a person rather than written for a model. The small model writes it
 * from a read of the repo; the sessions that work in a layer keep its sheet
 * true as they go (server/sheetEdits.ts — each only what it has read), and
 * the small model folds in what they leave; this page is where the user
 * corrects it: any line can be struck or rewritten. Each sheet says who
 * changed it last.
 *
 * The shape, and what sessions learned in each layer — which is what a
 * session gets with the layer's sheet. Where the work stands across the
 * project (catchup.md) was drawn here once, and was the wrong thing to put
 * beside the stack: a page of dated, one-chat details that buried the part
 * worth reading.
 */

/** "path — what it is", split so the path can be set as a path. */
function split(line: string): [string, string] {
  const at = line.indexOf(" — ");
  return at > 0 ? [line.slice(0, at), line.slice(at + 3)] : [line, ""];
}

/* ── small parts ────────────────────────────────────────────────────── */

const ICON = {
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  strike: <path d="M6 6l12 12M18 6L6 18" />,
};

function Tool({ icon, title, onClick }: { icon: keyof typeof ICON; title: string; onClick(): void }) {
  return (
    <button
      type="button"
      className="icon-button arch-tool"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
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
        {ICON[icon]}
      </svg>
    </button>
  );
}

/** A line being rewritten in place: Enter keeps it, Escape leaves it as
 *  it was. */
function LineEditor({
  text,
  placeholder,
  onSave,
  onCancel,
}: {
  text: string;
  placeholder: string;
  onSave(text: string): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(text);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const save = () => {
    const kept = draft.trim();
    if (!kept) return onCancel();
    onSave(kept);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };
  return (
    <span className="arch-editor">
      <input
        ref={first}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={keys}
      />
      <span className="arch-editor-buttons">
        <button type="button" className="primary" onClick={save}>
          Keep
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </span>
  );
}

/** A background run's control: when it last ran, what it just said, and
 *  the button that runs it again. */
function Rerun({
  busy,
  note,
  at,
  last,
  lastLabel,
  button,
  busyLabel,
  title,
  onRun,
}: {
  busy: boolean;
  note?: string;
  at?: number;
  last: string;
  lastLabel: string;
  button: string;
  busyLabel: string;
  title: string;
  onRun(): void;
}) {
  const stale = useNoteStale(at, busy);
  return (
    <span className="arch-rerun">
      <span className="arch-rerun-note">{note && !stale ? note : `${lastLabel} ${last}`}</span>
      <button type="button" disabled={busy} title={title} onClick={onRun}>
        {busy ? busyLabel : button}
      </button>
    </span>
  );
}

function Section({
  title,
  children,
  extra,
}: {
  title: string;
  children: React.ReactNode;
  extra?: React.ReactNode;
}) {
  return (
    <section className="arch-section">
      <div className="arch-section-head">
        <span className="arch-section-title">{title}</span>
        {extra}
      </div>
      {children}
    </section>
  );
}

/* ── who changed it ─────────────────────────────────────────────────── */

/** Who a stamp says last changed a sheet, and when — "kept by the
 *  "Backend" chat 5m ago". */
function useStampText(stamp: SheetStamp | undefined): string | undefined {
  const title = useRuri((s) =>
    stamp?.chat ? s.projects.flatMap((p) => p.sessions).find((x) => x.id === stamp.chat)?.title : undefined,
  );
  if (!stamp) return undefined;
  const when = since(stamp.at);
  if (stamp.by === "repo") return `read from the repo ${when}`;
  if (stamp.by === "model") return `folded in by the small model ${when}`;
  if (stamp.by === "user") return `corrected by you ${when}`;
  return `kept by ${title ? `the “${title}” chat` : "a chat"} ${when}`;
}

function Stamp({ stamp }: { stamp: SheetStamp | undefined }) {
  const text = useStampText(stamp);
  return text ? <span className="arch-stamp">{text}</span> : null;
}

/* ── the shape ──────────────────────────────────────────────────────── */

/** What a layer owns, as its bar shows it: folders and a count (its sheet
 *  lists every path). */
function owns(layer: StackLayer): string {
  return layer.paths?.length ? ownsSummary(layer.paths) : (layer.where ?? "");
}

/** Correcting a line of the sheet's own lists. */
function sheetLine(projectId: string, section: SheetSection) {
  return (index: number, text?: string) =>
    send({ type: "sheet_line", projectId, section, index, ...(text !== undefined ? { text } : {}) });
}

/** Correcting a line of one layer's sheet. */
function layerLine(projectId: string, slug: string, section: LayerSection | "summary") {
  return (index: number, text?: string) =>
    send({ type: "layer_line", projectId, slug, section, index, ...(text !== undefined ? { text } : {}) });
}

/**
 * The stack, top to bottom — the index every session is shown. A bar with
 * a sheet behind it opens it underneath: the layer's own architecture,
 * the part a session reads before working in it. A layer that owns files
 * but has no sheet yet — sheets are written as work reaches each layer —
 * opens too, and asks for its sheet to be written now.
 */
function Stack({ projectId, sheet }: { projectId: string; sheet: ProjectSheet }) {
  const [open, setOpen] = useState<string>();
  const shape = useRuri((s) => s.catchups[projectId]);
  if (sheet.layers?.length) {
    return (
      <div className="arch-stack">
        {sheet.layers.map((layer, i) => {
          const layerSheet = layer.slug ? sheet.layerSheets?.[layer.slug] : undefined;
          const where = owns(layer);
          const body = (
            <>
              <span className="arch-layer-name">{layer.name}</span>
              <span className="arch-layer-what">{layer.what}</span>
              {where && (
                <span className="arch-layer-where" title={layer.paths?.join("\n") ?? where}>
                  {where}
                </span>
              )}
            </>
          );
          if (!layer.slug || (!layerSheet && !layer.paths?.length)) {
            return (
              <div key={`${layer.name}-${i}`} className="arch-layer">
                {body}
              </div>
            );
          }
          const shown = open === layer.slug;
          const slug = layer.slug;
          return (
            <div key={layer.slug} className={`arch-layer-wrap${shown ? " open" : ""}`}>
              <button
                type="button"
                className="arch-layer has-sheet"
                aria-expanded={shown}
                title={
                  shown
                    ? "Fold its sheet away"
                    : layerSheet
                      ? "Open this layer's sheet"
                      : "Read this layer and write its sheet"
                }
                onClick={() => {
                  if (!shown && !layerSheet) send({ type: "layer_sheet_write", projectId, slug });
                  setOpen(shown ? undefined : slug);
                }}
              >
                {body}
              </button>
              {shown &&
                (layerSheet ? (
                  <LayerPanel
                    projectId={projectId}
                    slug={slug}
                    sheet={layerSheet}
                    notes={notesOf(sheet, slug)}
                  />
                ) : (
                  <div className="arch-layer-sheet">
                    <div className="arch-empty">{shape?.note ?? "Reading this layer's files…"}</div>
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    );
  }
  if (sheet.stack?.length) {
    return (
      <ul className="arch-list">
        {sheet.stack.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    );
  }
  return <div className="arch-empty">Not drawn yet — read the repo to draw it.</div>;
}

function Flows({ flows }: { flows: SystemFlow[] }) {
  return (
    <div className="arch-flows">
      {flows.map((flow) => (
        <div key={flow.name} className="arch-flow">
          <div className="arch-flow-name">{flow.name}</div>
          <div className="arch-flow-steps">
            {flow.steps.map((step, i) => (
              <span key={`${step}-${i}`} className="arch-flow-part">
                {i > 0 && (
                  <svg className="arch-arrow" viewBox="0 0 24 12" aria-hidden>
                    <path
                      d="M1 6h20M16 1.5l5 4.5-5 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                  </svg>
                )}
                <span className="arch-step">{step}</span>
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A list of the shape's lines, each correctable where it stands: rewritten
 * in place, or struck. `pairs` sets "key — value" lines as two columns,
 * the key as a path when `mono`.
 */
function SheetLines({
  onLine,
  lines,
  placeholder = "the line",
  pairs,
  mono,
  monoValue,
  two,
}: {
  /** The line at `index` rewritten as `text`, or struck. */
  onLine(index: number, text?: string): void;
  lines: string[];
  placeholder?: string;
  pairs?: boolean;
  mono?: boolean;
  monoValue?: boolean;
  two?: boolean;
}) {
  const [editing, setEditing] = useState<number>();
  const tools = (i: number) => (
    <span className="arch-actions">
      <Tool icon="edit" title="Rewrite this line" onClick={() => setEditing(i)} />
      <Tool icon="strike" title="Strike this line — it's wrong, or gone" onClick={() => onLine(i)} />
    </span>
  );
  const editor = (i: number, line: string) => (
    <LineEditor
      text={line}
      placeholder={placeholder}
      onCancel={() => setEditing(undefined)}
      onSave={(text) => {
        onLine(i, text);
        setEditing(undefined);
      }}
    />
  );
  if (pairs) {
    return (
      <div className="arch-pairs">
        {lines.map((line, i) => {
          if (editing === i) {
            return (
              <div key={`${line}-${i}`} className="arch-pair editing">
                {editor(i, line)}
              </div>
            );
          }
          const [key, value] = split(line);
          return (
            <div key={`${line}-${i}`} className="arch-pair">
              <span className={mono ? "arch-pair-key mono" : "arch-pair-key"}>{key}</span>
              <span className={monoValue ? "arch-pair-value mono" : "arch-pair-value"}>
                {value}
                {tools(i)}
              </span>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <ul className={two ? "arch-list two" : "arch-list"}>
      {lines.map((line, i) => (
        <li key={`${line}-${i}`} className="arch-line">
          {editing === i ? (
            editor(i, line)
          ) : (
            <>
              {line}
              {tools(i)}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A heading inside a layer's sheet. */
function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="arch-layer-part">
      <div className="arch-layer-part-title">{title}</div>
      {children}
    </div>
  );
}

/** A layer's summary, rewritable in place. */
function Summary({ text, onSave }: { text: string; onSave(text: string): void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="arch-layer-summary editing">
        <LineEditor
          text={text}
          placeholder="what this layer is and does"
          onCancel={() => setEditing(false)}
          onSave={(next) => {
            onSave(next);
            setEditing(false);
          }}
        />
      </div>
    );
  }
  return (
    <p className="arch-layer-summary arch-line">
      {text}
      <span className="arch-actions">
        <Tool icon="edit" title="Rewrite the summary" onClick={() => setEditing(true)} />
      </span>
    </p>
  );
}

const NOTE_LABEL: Record<MemoryPart, string> = {
  now: "now",
  decisions: "decision",
  worked: "worked",
  failed: "didn't work",
  gotchas: "trap",
  open: "still open",
};

/** What sessions learned working in one layer — read with its sheet. A
 *  line struck here is gone from the memory. */
function LayerNotes({
  projectId,
  notes,
}: {
  projectId: string;
  notes: Array<{ part: MemoryPart; line: MemoryLine }>;
}) {
  return (
    <ul className="arch-list arch-notes">
      {notes.map(({ part, line }) => (
        <li key={line.id} className="arch-line">
          <span className="arch-note-kind">{NOTE_LABEL[part]}</span> {line.text}
          {line.why && <span className="arch-note-why"> — {line.why}</span>}
          <span className="arch-actions">
            <Tool
              icon="strike"
              title="Strike this line — it no longer holds"
              onClick={() =>
                send({ type: "memory_line", projectId, part, lineId: line.id, action: "remove" })
              }
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A layer's own lines in the memory, every part. */
function notesOf(sheet: ProjectSheet, slug: string): Array<{ part: MemoryPart; line: MemoryLine }> {
  const memory = sheet.memory;
  if (!memory) return [];
  const parts: MemoryPart[] = ["decisions", "worked", "failed", "gotchas", "open"];
  return parts.flatMap((part) =>
    memory[part].filter((line) => line.layer === slug).map((line) => ({ part, line })),
  );
}

/**
 * One layer's own sheet, under its bar: what it is, where to change what
 * inside it, how work moves through it, its key files, its traps, what it
 * talks to, and what sessions learned working there — exactly what
 * `ruri layer <slug>` gives a session. Every line is the user's to rewrite
 * or strike.
 */
function LayerPanel({
  projectId,
  slug,
  sheet,
  notes,
}: {
  projectId: string;
  slug: string;
  sheet: LayerSheet;
  notes: Array<{ part: MemoryPart; line: MemoryLine }>;
}) {
  const map = sheet.map.map((place) => `${place.name} — ${place.files.join(", ")}`);
  return (
    <div className="arch-layer-sheet">
      {sheet.summary && (
        <Summary text={sheet.summary} onSave={(text) => layerLine(projectId, slug, "summary")(0, text)} />
      )}
      {map.length > 0 && (
        <Part title="Where to change what">
          <SheetLines
            onLine={layerLine(projectId, slug, "map")}
            lines={map}
            placeholder="what it is — file, file"
            pairs
            monoValue
          />
        </Part>
      )}
      {sheet.flows.length > 0 && (
        <Part title="How it works">
          <Flows flows={sheet.flows} />
        </Part>
      )}
      {sheet.files.length > 0 && (
        <Part title="Key files">
          <SheetLines onLine={layerLine(projectId, slug, "files")} lines={sheet.files} pairs mono />
        </Part>
      )}
      {sheet.rules.length > 0 && (
        <Part title="Rules and traps">
          <SheetLines onLine={layerLine(projectId, slug, "rules")} lines={sheet.rules} />
        </Part>
      )}
      {sheet.edges.length > 0 && (
        <Part title="What it talks to">
          <SheetLines onLine={layerLine(projectId, slug, "edges")} lines={sheet.edges} pairs />
        </Part>
      )}
      {notes.length > 0 && (
        <Part title="From the sessions that worked here">
          <LayerNotes projectId={projectId} notes={notes} />
        </Part>
      )}
      <div className="arch-layer-file">
        <code>.ruri/layers/{slug}.md</code> · <code>ruri layer {slug}</code>
        {sheet.stamp ? (
          <>
            {" · "}
            <Stamp stamp={sheet.stamp} />
          </>
        ) : sheet.updated ? (
          // a sheet from before stamps says only when
          <span className="arch-stamp"> · changed {since(sheet.updated)}</span>
        ) : null}
      </div>
    </div>
  );
}

export function Architecture({ projectId }: { projectId: string }) {
  const sheet = useRuri((s) => s.sheets[projectId]);
  const facts = useRuri((s) => s.sheetFacts[projectId]);
  const title = useRuri((s) => s.projects.find((p) => p.id === projectId)?.name) ?? "This project";
  const shape = useRuri((s) => s.catchups[projectId]);

  // the sheet is the server's: asked for when the page opens, and kept
  // current after that by every change it broadcasts
  useEffect(() => {
    send({ type: "sheet_get", projectId });
  }, [projectId]);

  // how old the read of the repo is: in commits where git can say, which is
  // what makes a sheet stale — a quiet month changes nothing
  const behind = facts?.git?.sinceRead;
  const readAge =
    behind === undefined
      ? since(sheet?.built)
      : behind === 0
        ? "at the current commit"
        : `${behind} commit${behind === 1 ? "" : "s"} ago`;
  const readRepo = (
    <Rerun
      busy={shape?.busy === true}
      {...(shape?.note ? { note: shape.note } : {})}
      {...(shape?.at ? { at: shape.at } : {})}
      last={sheet?.built ? readAge : "never"}
      lastLabel="read from the repo"
      button="Read the repo"
      busyLabel="Reading…"
      title="Read the whole repo again and write the architecture afresh — what it is and does is kept where it still holds"
      onRun={() => send({ type: "catchup_rebuild", projectId })}
    />
  );
  if (!sheet) {
    return (
      <section className="board-page arch-page">
        <div className="board-inner arch-inner">
          <div className="arch-empty">Reading…</div>
        </div>
      </section>
    );
  }

  const blank = !sheet.description && sheet.features.length === 0;
  const layered = Object.keys(sheet.layerSheets ?? {}).length > 0;
  const map = (sheet.map ?? []).map((place) => `${place.name} — ${place.files.join(", ")}`);
  return (
    <section className="board-page arch-page">
      <div className="board-inner arch-inner">
        <header className="arch-head">
          <div className="arch-title">{title}</div>
          {sheet.description && <p className="arch-purpose">{sheet.description}</p>}
        </header>

        {blank ? (
          <div className="arch-blank">
            <p>
              Nothing written about this project yet. Every session here is pointed at this sheet —{" "}
              <code>.ruri/architecture.md</code> — before it starts, so it is worth having.
            </p>
            {readRepo}
          </div>
        ) : (
          <>
            {/* where to change what is each layer's own now — an older
                sheet, not read since, still has the one map */}
            {!layered && (
              <Section title="Where to change what" extra={readRepo}>
                {map.length ? (
                  <SheetLines
                    onLine={sheetLine(projectId, "map")}
                    lines={map}
                    placeholder="what it is — file, file"
                    pairs
                    monoValue
                  />
                ) : (
                  <div className="arch-empty">
                    Not mapped yet — reading the repo maps it, and every turn adds the files it worked on.
                  </div>
                )}
              </Section>
            )}

            <Section title="The stack, top to bottom" {...(layered ? { extra: readRepo } : {})}>
              <Stack projectId={projectId} sheet={sheet} />
              {layered && (
                <div className="arch-stack-note">
                  Every session here is shown this stack, reads the sheet of the layer it is about to work in,
                  and keeps it true to what its work changed — open one to see what it gets.
                  {sheet.stamp && (
                    <>
                      {" "}
                      The index was last <Stamp stamp={sheet.stamp} />.
                    </>
                  )}
                </div>
              )}
            </Section>

            {sheet.flows?.length ? (
              <Section title="How it flows">
                <Flows flows={sheet.flows} />
              </Section>
            ) : null}

            {sheet.layout?.length ? (
              <Section title="Where things are">
                <SheetLines onLine={sheetLine(projectId, "layout")} lines={sheet.layout} pairs mono />
              </Section>
            ) : null}

            {sheet.run?.length ? (
              <Section title="How to run it">
                <SheetLines onLine={sheetLine(projectId, "run")} lines={sheet.run} pairs mono />
              </Section>
            ) : null}

            {sheet.conventions?.length ? (
              <Section title="Conventions">
                <SheetLines onLine={sheetLine(projectId, "conventions")} lines={sheet.conventions} />
              </Section>
            ) : null}

            {sheet.features.length > 0 && (
              <Section title="What it does">
                <SheetLines onLine={sheetLine(projectId, "features")} lines={sheet.features} two />
              </Section>
            )}
          </>
        )}

        <div className="board-foot">
          Written into the project as <code>.ruri/architecture.md</code>, with each layer&apos;s sheet in{" "}
          <code>.ruri/layers/</code>. A session that has read a sheet puts right what its work changed there (
          <code>ruri layer &lt;handle&gt;</code>, <code>ruri architecture</code>); what it leaves, the small
          model folds in as its turns finish — a turn only into the layers whose files it changed. Hover a
          line to rewrite or strike it.
        </div>
      </div>
    </section>
  );
}
