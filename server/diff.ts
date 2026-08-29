/**
 * The patch a Write or Edit produced, built the way git builds one: line
 * diff, three lines of context, hunks.
 *
 * The pre-image is read off disk when the tool_use block arrives — the CLI
 * has not run the tool yet at that point, so the file still holds the old
 * bytes. The post-image is what the tool is about to write: `content` for a
 * Write, or the pre-image with the edit applied for an Edit.
 */

import * as fs from "node:fs";
import type { DiffHunk, DiffLine, FileDiff } from "../shared/protocol.js";

/** Context lines kept either side of a change, as git does by default. */
const CONTEXT = 3;

/** Beyond this many changed lines the patch stops being worth reading. */
const MAX_LINES = 600;

/** Files this large skip the line-by-line pass — see diffLines. */
const LCS_LIMIT = 2500;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // a trailing newline is a line terminator, not an empty last line
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Longest common subsequence over lines, after trimming the common head and
 * tail — which for a normal edit leaves a handful of lines to compare even
 * in a very long file. Anything still too big to compare pairwise is
 * reported as one wholesale replacement rather than hanging the server.
 */
function diffLines(before: string[], after: string[]): DiffLine[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: "ctx", text: before[i]! });

  if (midBefore.length > LCS_LIMIT || midAfter.length > LCS_LIMIT) {
    for (const text of midBefore) out.push({ kind: "del", text });
    for (const text of midAfter) out.push({ kind: "add", text });
  } else {
    // classic LCS table, then walk it back into a line script
    const n = midBefore.length;
    const m = midAfter.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] =
          midBefore[i] === midAfter[j]
            ? lcs[i + 1]![j + 1]! + 1
            : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midBefore[i] === midAfter[j]) {
        out.push({ kind: "ctx", text: midBefore[i]! });
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        out.push({ kind: "del", text: midBefore[i]! });
        i++;
      } else {
        out.push({ kind: "add", text: midAfter[j]! });
        j++;
      }
    }
    for (; i < n; i++) out.push({ kind: "del", text: midBefore[i]! });
    for (; j < m; j++) out.push({ kind: "add", text: midAfter[j]! });
  }

  for (let k = 0; k < tail; k++) out.push({ kind: "ctx", text: after[after.length - tail + k]! });
  return out;
}

/** Group a line script into hunks, dropping context runs longer than 2×CONTEXT. */
function toHunks(script: DiffLine[]): { hunks: DiffHunk[]; truncated: boolean } {
  const changed = script.map((l) => l.kind !== "ctx");
  const keep = script.map((_, i) => {
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(script.length - 1, i + CONTEXT); k++) {
      if (changed[k]) return true;
    }
    return false;
  });

  const hunks: DiffHunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: DiffHunk | null = null;
  let budget = MAX_LINES;
  let truncated = false;

  for (let i = 0; i < script.length; i++) {
    const line = script[i]!;
    if (keep[i]) {
      if (!current) {
        current = { oldStart: oldLine, newStart: newLine, lines: [] };
        hunks.push(current);
      }
      if (budget > 0) {
        current.lines.push(line);
        budget--;
      } else {
        truncated = true;
      }
    } else if (current) {
      current = null;
    }
    if (line.kind !== "add") oldLine++;
    if (line.kind !== "del") newLine++;
  }
  return { hunks: hunks.filter((h) => h.lines.length > 0), truncated };
}

/** Build the patch between two whole-file strings. Null when nothing moved. */
export function buildDiff(
  displayPath: string,
  before: string | null,
  after: string,
): FileDiff | null {
  if (before === after) return null;
  const script = diffLines(splitLines(before ?? ""), splitLines(after));
  const added = script.filter((l) => l.kind === "add").length;
  const removed = script.filter((l) => l.kind === "del").length;
  if (added === 0 && removed === 0) return null;
  const { hunks, truncated } = toHunks(script);
  return {
    path: displayPath,
    added,
    removed,
    hunks,
    ...(before === null ? { created: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * A patch a harness handed us already made: Codex sends unified diffs with
 * its apply_patch call, so there is nothing to compute — the hunk headers
 * carry the real line numbers and the body carries the change.
 */
export function parseUnifiedDiff(
  displayPath: string,
  patch: string,
  options?: { created?: boolean },
): FileDiff | null {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let added = 0;
  let removed = 0;
  let budget = MAX_LINES;
  let truncated = false;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    // the ---/+++ preamble, and git's "\ No newline at end of file"
    if (!current || raw.startsWith("\\")) continue;
    const kind: DiffLine["kind"] = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "ctx";
    if (kind === "add") added++;
    else if (kind === "del") removed++;
    if (budget <= 0) {
      truncated = true;
      continue;
    }
    budget--;
    current.lines.push({ kind, text: raw.slice(1) });
  }
  if (added === 0 && removed === 0) return null;
  return {
    path: displayPath,
    added,
    removed,
    hunks: hunks.filter((h) => h.lines.length > 0),
    ...(options?.created ? { created: true } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/** The file's current bytes, or null when it does not exist yet. */
export function readBefore(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
