import { useEffect, useRef, useState } from "react";
import type {
  LayerSection,
  LayerSheet,
  ProjectSheet,
  SheetSection,
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
 * from a read of the repo and folds it forward as turns finish, a turn only
 * into the layers whose files it changed (server/brief.ts); this page is
 * where the user corrects it: any line can be struck or rewritten.
 *
 * The shape only. Where the work stands — the running log of what was
 * decided, tried, and left open — was drawn here too, and was the wrong
 * thing to put beside the stack: a page of dated, one-chat details that
 * buried the part worth reading.
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
 * the part a session reads before working in it.
 */
function Stack({ projectId, sheet }: { projectId: string; sheet: ProjectSheet }) {
  const [open, setOpen] = useState<string>();
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
          if (!layerSheet || !layer.slug) {
            return (
              <div key={`${layer.name}-${i}`} className="arch-layer">
                {body}
              </div>
            );
          }
          const shown = open === layer.slug;
          return (
            <div key={layer.slug} className={`arch-layer-wrap${shown ? " open" : ""}`}>
              <button
                type="button"
                className="arch-layer has-sheet"
                aria-expanded={shown}
                title={shown ? "Fold its sheet away" : "Open this layer's sheet"}
                onClick={() => setOpen(shown ? undefined : layer.slug)}
              >
                {body}
              </button>
              {shown && <LayerPanel projectId={projectId} slug={layer.slug} sheet={layerSheet} />}
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

/**
 * One layer's own sheet, under its bar: what it is, where to change what
 * inside it, how work moves through it, its key files, its traps, what it
 * talks to — exactly what `.ruri/layers/<slug>.md` gives a session. Every
 * line is the user's to rewrite or strike.
 */
function LayerPanel({ projectId, slug, sheet }: { projectId: string; slug: string; sheet: LayerSheet }) {
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
      <div className="arch-layer-file">
        <code>.ruri/layers/{slug}.md</code> · <code>ruri layer {slug}</code>
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
                  Every session here is shown this stack, and reads the sheet of the layer it is about to work
                  in — open one to see what it gets.
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
          <code>.ruri/layers/</code>. It folds in what each chat&apos;s turns change as they finish — a turn
          only into the layers whose files it changed. Hover a line to rewrite or strike it.
        </div>
      </div>
    </section>
  );
}
