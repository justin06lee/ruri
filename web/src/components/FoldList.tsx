import { useState, type ReactNode } from "react";
import { InfoTip } from "./InfoTip";

/** Whether each list was last left open or folded, by its id. */
const KEY = "ruri-folds";
function folded(id: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>)[id] === true;
  } catch {
    return false;
  }
}
function keepFolded(id: string, value: boolean): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
    all[id] = value;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // a window without storage just forgets
  }
}

/**
 * A list that folds away, as a Finder sidebar section does: a quiet
 * heading with a chevron and a count, and under it plain rows split by a
 * hairline — no tray, no descriptions. What it was left as (open or
 * folded) is remembered per list. `actions` sit at the heading's right.
 */
export function FoldList({
  id,
  title,
  count,
  info,
  actions,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  info?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [shut, setShut] = useState(() => folded(id));
  return (
    <div className={`fold-list${shut ? " shut" : ""}`}>
      <div className="fold-head">
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={!shut}
          onClick={() => {
            keepFolded(id, !shut);
            setShut(!shut);
          }}
        >
          <svg className="fold-chevron" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M6 4l4 4-4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          {title}
          {count !== undefined && <span className="fold-count">{count}</span>}
        </button>
        {info && <InfoTip>{info}</InfoTip>}
        {actions && <span className="fold-actions">{actions}</span>}
      </div>
      {!shut && <div className="fold-body">{children}</div>}
    </div>
  );
}

/** One row of a fold list: its name, a faint word or two beside it, and
 *  what can be done to it at the right. */
export function FoldRow({
  name,
  tag,
  faded = false,
  title,
  children,
}: {
  name: ReactNode;
  tag?: ReactNode;
  faded?: boolean;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`fold-row${faded ? " faded" : ""}`} title={title}>
      <span className="fold-name">{name}</span>
      {tag && <span className="fold-tag">{tag}</span>}
      <span className="fold-row-actions">{children}</span>
    </div>
  );
}
