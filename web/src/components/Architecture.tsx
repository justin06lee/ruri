import { useEffect, useRef, useState } from "react";
import type {
  MemoryLine,
  MemoryPart,
  ProjectSheet,
  SheetGit,
  SheetSection,
  SourceLabel,
} from "../../../shared/protocol";
import { since, useNoteStale } from "../lib/runNote";
import { send, useRuri } from "../store";

/**
 * The architecture page: the project at a glance — where to change what,
 * the stack it is built as from what a person touches down to the engines
 * under it, the paths through it that matter, where things are, what it
 * can do — and, under that, where the work on it stands: what git says,
 * what was decided and why, what worked, what didn't and why, the traps,
 * what's still open.
 *
 * It is the same thing every session is pointed at on its first prompt —
 * `.ruri/architecture.md` and `.ruri/catchup.md` in the project — drawn for
 * a person rather than written for a model. The small model writes the
 * shape from a read of the repo and the memory from the chats, and folds
 * both forward as turns finish; agents add what they learn with `ruri
 * note` (server/brief.ts). This page is where the user corrects all of it:
 * any line can be struck or rewritten, a memory line pinned so nothing
 * rewrites it, and a line of their own added. Their lines are pinned, and
 * sessions are told to trust them most.
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
  pin: (
    <>
      <path d="M9 4h6l-1 6 4 4H6l4-4-1-6z" />
      <path d="M12 14v6" />
    </>
  ),
  add: <path d="M12 5v14M5 12h14" />,
};

function Tool({
  icon,
  title,
  on,
  onClick,
}: {
  icon: keyof typeof ICON;
  title: string;
  on?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={`icon-button arch-tool${on ? " on" : ""}`}
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

/** A line being written or rewritten in place: Enter keeps it, Escape
 *  leaves it as it was. With `why`, a second field for the reason. */
function LineEditor({
  text,
  why,
  withWhy,
  placeholder,
  onSave,
  onCancel,
}: {
  text: string;
  why?: string;
  withWhy?: boolean;
  placeholder: string;
  onSave(text: string, why?: string): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(text);
  const [reason, setReason] = useState(why ?? "");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const save = () => {
    const kept = draft.trim();
    if (!kept) return onCancel();
    onSave(kept, withWhy ? reason.trim() : undefined);
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
      {withWhy && (
        <input
          className="arch-editor-why"
          value={reason}
          placeholder="why (optional)"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={keys}
        />
      )}
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

function Stack({ sheet }: { sheet: ProjectSheet }) {
  if (sheet.layers?.length) {
    return (
      <div className="arch-stack">
        {sheet.layers.map((layer, i) => (
          <div key={`${layer.name}-${i}`} className="arch-layer">
            <span className="arch-layer-name">{layer.name}</span>
            <span className="arch-layer-what">{layer.what}</span>
            {layer.where && <span className="arch-layer-where">{layer.where}</span>}
          </div>
        ))}
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

function Flows({ sheet }: { sheet: ProjectSheet }) {
  return (
    <div className="arch-flows">
      {(sheet.flows ?? []).map((flow) => (
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
  projectId,
  section,
  lines,
  pairs,
  mono,
  monoValue,
  two,
}: {
  projectId: string;
  section: SheetSection;
  lines: string[];
  pairs?: boolean;
  mono?: boolean;
  monoValue?: boolean;
  two?: boolean;
}) {
  const [editing, setEditing] = useState<number>();
  const tools = (i: number) => (
    <span className="arch-actions">
      <Tool icon="edit" title="Rewrite this line" onClick={() => setEditing(i)} />
      <Tool
        icon="strike"
        title="Strike this line — it's wrong, or gone"
        onClick={() => send({ type: "sheet_line", projectId, section, index: i })}
      />
    </span>
  );
  const editor = (i: number, line: string) => (
    <LineEditor
      text={line}
      placeholder={section === "map" ? "what it is — file, file" : "the line"}
      onCancel={() => setEditing(undefined)}
      onSave={(text) => {
        send({ type: "sheet_line", projectId, section, index: i, text });
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

/* ── where the work stands ──────────────────────────────────────────── */

/** The parts of the memory, in the order a newcomer needs them. */
const MEMORY_PARTS: Array<{ key: Exclude<MemoryPart, "now">; title: string; hint: string; why?: boolean }> = [
  {
    key: "decisions",
    title: "Decisions, and why",
    hint: "settled — don't redo them without a new reason",
    why: true,
  },
  { key: "failed", title: "What didn't work, and why", hint: "tried already", why: true },
  { key: "worked", title: "What worked", hint: "worth repeating" },
  { key: "gotchas", title: "Gotchas and rules", hint: "traps, constraints, what you insist on" },
  { key: "open", title: "Still open", hint: "asked for and not done, or known broken" },
];

/** Who wrote a line, as the page says it. */
function author(line: MemoryLine): string | undefined {
  if (line.by === "user") return "you";
  if (line.by === "agent") return "an agent";
  return undefined;
}

function MemoryItem({
  projectId,
  part,
  line,
  source,
  withWhy,
}: {
  projectId: string;
  part: MemoryPart;
  line: MemoryLine;
  source?: SourceLabel;
  withWhy?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="arch-line editing">
        <LineEditor
          text={line.text}
          {...(line.why ? { why: line.why } : {})}
          withWhy={withWhy || Boolean(line.why)}
          placeholder="the line"
          onCancel={() => setEditing(false)}
          onSave={(text, why) => {
            send({
              type: "memory_write",
              projectId,
              part,
              lineId: line.id,
              text,
              ...(why ? { why } : {}),
            });
            setEditing(false);
          }}
        />
      </li>
    );
  }
  const by = author(line);
  const pinned = line.pinned === true;
  return (
    <li className={`arch-line${pinned ? " pinned" : ""}`}>
      <span className="arch-line-text">{line.text}</span>
      {line.why && <span className="arch-line-why"> — {line.why}</span>}
      {(line.date || source || by || pinned) && (
        <span className="arch-line-meta">
          {line.date && <span>{line.date}</span>}
          {source && (
            <span className="arch-source" title={`ruri recall show ${source.ref}`}>
              “{source.chat}” #{source.n}
            </span>
          )}
          {by && <span>by {by}</span>}
          {pinned && <span className="arch-pinned">pinned</span>}
        </span>
      )}
      {part !== "now" ? (
        <span className="arch-actions">
          <Tool
            icon="pin"
            on={pinned}
            title={pinned ? "Unpin — let later work rewrite or retire it" : "Pin — keep it exactly as it is"}
            onClick={() =>
              send({
                type: "memory_line",
                projectId,
                part,
                lineId: line.id,
                action: pinned ? "unpin" : "pin",
              })
            }
          />
          <Tool icon="edit" title="Correct this line — it becomes yours" onClick={() => setEditing(true)} />
          <Tool
            icon="strike"
            title="Strike this line — it's wrong, or no longer true"
            onClick={() => send({ type: "memory_line", projectId, part, lineId: line.id, action: "remove" })}
          />
        </span>
      ) : (
        <span className="arch-actions">
          <Tool
            icon="strike"
            title="Strike this line"
            onClick={() => send({ type: "memory_line", projectId, part, lineId: line.id, action: "remove" })}
          />
        </span>
      )}
    </li>
  );
}

function MemoryCard({
  projectId,
  part,
  title,
  hint,
  why,
  lines,
  sources,
}: {
  projectId: string;
  part: MemoryPart;
  title: string;
  hint: string;
  why?: boolean;
  lines: MemoryLine[];
  sources: Record<string, SourceLabel>;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className={`arch-card ${part}`}>
      <div className="arch-card-head">
        {title}
        <span className="arch-card-hint">{hint}</span>
        <span className="arch-card-add">
          <Tool icon="add" title="Add a line of your own" onClick={() => setAdding(true)} />
        </span>
      </div>
      {lines.length || adding ? (
        <ul>
          {lines.map((line) => (
            <MemoryItem
              key={line.id}
              projectId={projectId}
              part={part}
              line={line}
              {...(sources[line.id] ? { source: sources[line.id] } : {})}
              {...(why ? { withWhy: true } : {})}
            />
          ))}
          {adding && (
            <li className="arch-line editing">
              <LineEditor
                text=""
                withWhy={why ?? false}
                placeholder="a line of your own"
                onCancel={() => setAdding(false)}
                onSave={(text, reason) => {
                  send({ type: "memory_write", projectId, part, text, ...(reason ? { why: reason } : {}) });
                  setAdding(false);
                }}
              />
            </li>
          )}
        </ul>
      ) : (
        <div className="arch-card-none">nothing yet</div>
      )}
    </div>
  );
}

/** Git's account, in one line. */
function GitLine({ git }: { git: SheetGit }) {
  return (
    <div className="arch-git">
      <span className="arch-now-label">Git</span>
      <span>
        on <code>{git.branch}</code> ({git.head})
      </span>
      <span>{git.dirty ? `${git.dirty} uncommitted` : "clean"}</span>
      {git.unmerged.length > 0 && (
        <span>
          not merged:{" "}
          {git.unmerged.map((name, i) => (
            <span key={name}>
              {i > 0 && ", "}
              <code>{name}</code>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function Memory({
  projectId,
  sheet,
  sources,
  git,
}: {
  projectId: string;
  sheet: ProjectSheet;
  sources: Record<string, SourceLabel>;
  git?: SheetGit;
}) {
  const memory = sheet.memory;
  return (
    <>
      {(git || memory?.now.length) && (
        <div className="arch-now">
          {git && <GitLine git={git} />}
          {memory?.now.length ? (
            <div className="arch-now-chats">
              <span className="arch-now-label">Where it stands</span>
              <ul>
                {memory.now.map((line) => (
                  <MemoryItem key={line.id} projectId={projectId} part="now" line={line} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
      <div className="arch-memory">
        {MEMORY_PARTS.map(({ key, title, hint, why }) => (
          <MemoryCard
            key={key}
            projectId={projectId}
            part={key}
            title={title}
            hint={hint}
            {...(why ? { why } : {})}
            lines={memory?.[key] ?? []}
            sources={sources}
          />
        ))}
      </div>
    </>
  );
}

export function Architecture({ projectId }: { projectId: string }) {
  const sheet = useRuri((s) => s.sheets[projectId]);
  const facts = useRuri((s) => s.sheetFacts[projectId]);
  const title = useRuri((s) => s.projects.find((p) => p.id === projectId)?.name) ?? "This project";
  const shape = useRuri((s) => s.catchups[projectId]);
  const recall = useRuri((s) => s.recalls[projectId]);

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
  const readChats = (
    <Rerun
      busy={recall?.busy === true}
      {...(recall?.note ? { note: recall.note } : {})}
      {...(recall?.at ? { at: recall.at } : {})}
      last={since(sheet?.remembered)}
      lastLabel="last gathered"
      button="Read the chats"
      busyLabel="Reading…"
      title="Read every chat in this project again and write where the work stands afresh — your lines, pinned lines and agents' notes stay"
      onRun={() => send({ type: "memory_rebuild", projectId })}
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
              Nothing written about this project yet. Every session here is pointed at this sheet before it
              starts —<code>.ruri/architecture.md</code> for its shape and <code>.ruri/catchup.md</code> for
              where the work stands — so it is worth having.
            </p>
            {readRepo}
          </div>
        ) : (
          <>
            <Section title="Where to change what" extra={readRepo}>
              {map.length ? (
                <SheetLines projectId={projectId} section="map" lines={map} pairs monoValue />
              ) : (
                <div className="arch-empty">
                  Not mapped yet — reading the repo maps it, and every turn adds the files it worked on.
                </div>
              )}
            </Section>

            <Section title="The stack, top to bottom">
              <Stack sheet={sheet} />
            </Section>

            {sheet.flows?.length ? (
              <Section title="How it flows">
                <Flows sheet={sheet} />
              </Section>
            ) : null}

            {sheet.layout?.length ? (
              <Section title="Where things are">
                <SheetLines projectId={projectId} section="layout" lines={sheet.layout} pairs mono />
              </Section>
            ) : null}

            {sheet.run?.length ? (
              <Section title="How to run it">
                <SheetLines projectId={projectId} section="run" lines={sheet.run} pairs mono />
              </Section>
            ) : null}

            {sheet.conventions?.length ? (
              <Section title="Conventions">
                <SheetLines projectId={projectId} section="conventions" lines={sheet.conventions} />
              </Section>
            ) : null}

            {sheet.features.length > 0 && (
              <Section title="What it does">
                <SheetLines projectId={projectId} section="features" lines={sheet.features} two />
              </Section>
            )}
          </>
        )}

        <div className="arch-divider" />
        <Section title="Where the work stands" extra={readChats}>
          <Memory
            projectId={projectId}
            sheet={sheet}
            sources={facts?.sources ?? {}}
            {...(facts?.git ? { git: facts.git } : {})}
          />
        </Section>

        <div className="board-foot">
          Written into the project as <code>.ruri/architecture.md</code> and <code>.ruri/catchup.md</code>,
          and every session here is told to read them first. Both fold in what each chat&apos;s turns do as
          they finish, and agents add what they learn with <code>ruri note</code>. Hover a line to correct,
          pin or strike it — your lines are pinned, and sessions are told to trust them most.
        </div>
      </div>
    </section>
  );
}
