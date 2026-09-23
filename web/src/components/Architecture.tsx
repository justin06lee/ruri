import { useEffect } from "react";
import type { ProjectMemory, ProjectSheet } from "../../../shared/protocol";
import { since, useNoteStale } from "../lib/runNote";
import { send, useRuri } from "../store";

/**
 * The architecture page: the project at a glance — what it is, the stack
 * it is built as from what a person touches down to the engines under it,
 * the paths through it that matter, what it can do, where things are —
 * and, under that, where the work on it stands: what was decided and why,
 * what worked, what didn't and why, the traps, what's still open.
 *
 * It is the same thing every session is pointed at on its first prompt —
 * `.ruri/architecture.md` and `.ruri/catchup.md` in the project — drawn for
 * a person rather than written for a model. Nothing here is typed by hand:
 * the small model writes the shape from a read of the repo and the memory
 * from the chats, and folds both forward as turns finish (server/brief.ts).
 * The two buttons read the repo, or the chats, whole again.
 */

/** "path — what it is", split so the path can be set as a path. */
function split(line: string): [string, string] {
  const at = line.indexOf(" — ");
  return at > 0 ? [line.slice(0, at), line.slice(at + 3)] : [line, ""];
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
  last?: number;
  lastLabel: string;
  button: string;
  busyLabel: string;
  title: string;
  onRun(): void;
}) {
  const stale = useNoteStale(at, busy);
  return (
    <span className="arch-rerun">
      <span className="arch-rerun-note">{note && !stale ? note : `${lastLabel} ${since(last)}`}</span>
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
  return <div className="arch-empty">Not drawn yet — rebuild it from the repo.</div>;
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

/** "path — what it is" lines: the path set as a path. */
function Pairs({ lines, mono }: { lines: string[]; mono?: boolean }) {
  return (
    <div className="arch-pairs">
      {lines.map((line) => {
        const [key, value] = split(line);
        return (
          <div key={line} className="arch-pair">
            <span className={mono ? "arch-pair-key mono" : "arch-pair-key"}>{key}</span>
            <span className="arch-pair-value">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The parts of the memory, in the order a newcomer needs them. */
const MEMORY_PARTS: Array<{ key: keyof ProjectMemory; title: string; hint: string }> = [
  { key: "decisions", title: "Decisions, and why", hint: "settled — don't redo them without a new reason" },
  { key: "failed", title: "What didn't work, and why", hint: "tried already" },
  { key: "worked", title: "What worked", hint: "worth repeating" },
  { key: "gotchas", title: "Gotchas and rules", hint: "traps, constraints, what the user insists on" },
  { key: "open", title: "Still open", hint: "asked for and not done, or known broken" },
];

function Memory({ memory }: { memory: ProjectMemory | undefined }) {
  const empty = !memory || Object.values(memory).every((part) => part.length === 0);
  if (empty) {
    return (
      <div className="arch-empty">
        Nothing gathered yet. It fills itself from every chat in this project as turns finish — or read the
        chats whole now.
      </div>
    );
  }
  return (
    <>
      {memory.now.length > 0 && (
        <div className="arch-now">
          <span className="arch-now-label">Where it stands</span>
          <ul>
            {memory.now.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="arch-memory">
        {MEMORY_PARTS.map(({ key, title, hint }) => (
          <div key={key} className={`arch-card ${key}`}>
            <div className="arch-card-head">
              {title}
              <span className="arch-card-hint">{hint}</span>
            </div>
            {memory[key].length ? (
              <ul>
                {memory[key].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <div className="arch-card-none">nothing yet</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function Architecture({ projectId }: { projectId: string }) {
  const sheet = useRuri((s) => s.sheets[projectId]);
  const title = useRuri((s) => s.projects.find((p) => p.id === projectId)?.name) ?? "This project";
  const shape = useRuri((s) => s.catchups[projectId]);
  const recall = useRuri((s) => s.recalls[projectId]);

  // the sheet is the server's: asked for when the page opens, and kept
  // current after that by every change it broadcasts
  useEffect(() => {
    send({ type: "sheet_get", projectId });
  }, [projectId]);

  const readRepo = (
    <Rerun
      busy={shape?.busy === true}
      {...(shape?.note ? { note: shape.note } : {})}
      {...(shape?.at ? { at: shape.at } : {})}
      {...(sheet?.built ? { last: sheet.built } : {})}
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
      {...(sheet?.remembered ? { last: sheet.remembered } : {})}
      lastLabel="last gathered"
      button="Read the chats"
      busyLabel="Reading…"
      title="Read every chat in this project again and write where the work stands afresh"
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
            <Section title="The stack, top to bottom" extra={readRepo}>
              <Stack sheet={sheet} />
            </Section>

            {sheet.flows?.length ? (
              <Section title="How it flows">
                <Flows sheet={sheet} />
              </Section>
            ) : null}

            {sheet.features.length > 0 && (
              <Section title="What it does">
                <ul className="arch-list two">
                  {sheet.features.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Section>
            )}

            {sheet.layout?.length ? (
              <Section title="Where things are">
                <Pairs lines={sheet.layout} mono />
              </Section>
            ) : null}

            {sheet.run?.length ? (
              <Section title="How to run it">
                <Pairs lines={sheet.run} mono />
              </Section>
            ) : null}

            {sheet.conventions?.length ? (
              <Section title="Conventions">
                <ul className="arch-list">
                  {sheet.conventions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </Section>
            ) : null}
          </>
        )}

        <div className="arch-divider" />
        <Section title="Where the work stands" extra={readChats}>
          <Memory memory={sheet.memory} />
        </Section>

        <div className="board-foot">
          Written into the project as <code>.ruri/architecture.md</code> and <code>.ruri/catchup.md</code>,
          and every session here is told to read them first. Both fold in what each chat's turns do as they
          finish.
        </div>
      </div>
    </section>
  );
}
