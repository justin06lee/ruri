/**
 * The patch a Write or Edit made: what actually changed, read the way a git
 * diff reads. It names its own file — the name in the head, the path along
 * the bottom — so it stands alone, with no chip above it repeating either.
 * Line numbers come from the hunk headers the server built, so they point at
 * real lines in the file rather than at offsets into the patch.
 */

import { memo, useState } from "react";
import type { FileDiff } from "../../../shared/protocol";

/** The gutter number a line carries: its own side's line. */
function numbersFor(hunkOld: number, hunkNew: number, diff: FileDiff["hunks"][number]) {
  let oldLine = hunkOld;
  let newLine = hunkNew;
  return diff.lines.map((line) => {
    const n = line.kind === "del" ? oldLine++ : line.kind === "add" ? newLine++ : (oldLine++, newLine++);
    return n;
  });
}

export const DiffView = memo(function DiffView({ diff }: { diff: FileDiff }) {
  const [open, setOpen] = useState(true);
  const cut = diff.path.lastIndexOf("/");
  const name = cut === -1 ? diff.path : diff.path.slice(cut + 1);
  return (
    <div className="diff">
      <button
        className="diff-head"
        title={open ? "Hide the patch" : "Show the patch"}
        onClick={() => setOpen(!open)}
      >
        <svg
          className={`diff-chevron ${open ? "open" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        <span className="diff-file">{name}</span>
        {diff.created && <span className="diff-new">new file</span>}
        <span className="diff-added">+{diff.added}</span>
        <span className="diff-removed">−{diff.removed}</span>
      </button>
      {open && (
        <div className="diff-body">
          {diff.hunks.map((hunk, h) => {
            const nums = numbersFor(hunk.oldStart, hunk.newStart, hunk);
            return (
              <div className="diff-hunk" key={h}>
                {hunk.lines.map((line, i) => (
                  <div className={`diff-line ${line.kind}`} key={i}>
                    <span className="diff-n">{nums[i]}</span>
                    <span className="diff-sign">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
                    </span>
                    <span className="diff-text">{line.text || " "}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {diff.truncated && <div className="diff-more">patch trimmed — the rest is not shown</div>}
        </div>
      )}
      <div className="diff-path" title={diff.path}>
        {diff.path}
      </div>
    </div>
  );
});
