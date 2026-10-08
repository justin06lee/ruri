import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryAnchors } from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { pushSheet, repairSheets } from "./catchupBrief.js";
import { configPath } from "./configDir.js";
import type { ServerContext } from "./context.js";
import { knownBranches } from "./gitState.js";
import { anchored, checkLine, lineAnchors, lookAt, type Finding, type RepoView } from "./grounding.js";
import { warn } from "./log.js";
import { parseOps, type Ask, type RawOp } from "./memoryFold.js";
import { dayOf } from "./memoryLines.js";
import { misfiled, words } from "./memoryQuality.js";
import { linesWith, MemoryBook, type LineRecord, type MemoryChange } from "./memoryLog.js";
import { similarity } from "./similarity.js";
import { completeMemory, smallModelEnabled } from "./smallmodel.js";

/**
 * The memory checked against the code, and against itself — so a reader
 * doesn't have to.
 *
 * A pass reads the project once (server/grounding.ts RepoView) and holds
 * every current line up against it. A line whose anchors moved — a file
 * gone, a version or a value changed, a branch merged — is marked "may be
 * stale" with what moved, and every reader sees it so. A line that names
 * what the code doesn't show, or one from before anchors that names git or
 * a package, is put to a check without being shown as stale. A line that
 * holds gets its anchors written down, so the next pass compares with now.
 *
 * Then the memory model looks at each marked line with evidence read from
 * the repository just now — the files and values, the packages, the
 * branches and how far along they are, the README, the commits since the
 * line was written — and says whether it holds, is stale (with the line
 * as it now stands, where the evidence shows it), or can't be told. And
 * pairs of lines that may disagree — two values for one setting, a "now"
 * and an "open" saying one thing — are put to it too: contradictions
 * resolved for the line that holds, repeats merged.
 *
 * Runs when ruri starts, after each fold, and on `ruri memory check`.
 * Every change it makes is in the memory's log, undoable as one.
 */

/** How many lines one check of the model takes, and pairs. */
const VERIFY_BATCH = 12;
const PAIR_BATCH = 20;
/** A line the check couldn't settle is not asked about again for this
 *  long, unless what is wrong with it changes. */
const RETRY_UNSURE_MS = 7 * 24 * 60 * 60_000;
/** How much evidence one line gets. */
const EVIDENCE_CHARS = 5_000;

const views = new Map<string, { view: Promise<RepoView>; at: number }>();
const VIEW_FRESH_MS = 30_000;

/** What ruri's sheet says the project is — read as part of what the project
 *  says of itself. */
function about(ctx: ServerContext, projectId: string): string {
  const brief = ctx.briefs.get(projectId);
  return [brief.description, ...(brief.layers ?? []).map((l) => `${l.name}: ${l.what}`)].join("\n");
}

/** The project as it stands, read at most every half a minute. */
export function projectView(
  ctx: ServerContext,
  projectId: string,
  fresh = false,
): Promise<RepoView> | undefined {
  const project = ctx.store.get(projectId);
  if (!project) return undefined;
  const held = views.get(projectId);
  if (held && !fresh && Date.now() - held.at < VIEW_FRESH_MS) return held.view;
  const view = lookAt(project.path, about(ctx, projectId));
  views.set(projectId, { view, at: Date.now() });
  return view;
}

/**
 * Changes about to be applied, each new line given its anchors as the code
 * has them now — what a later check compares with. Anything that can't be
 * read leaves the changes as they were.
 */
export async function withAnchors(
  ctx: ServerContext,
  projectId: string,
  changes: MemoryChange[],
): Promise<MemoryChange[]> {
  const worded = (c: MemoryChange) => c.op === "add" || c.op === "supersede" || (c.op === "edit" && !!c.text);
  if (!changes.some(worded)) return changes;
  try {
    const view = await projectView(ctx, projectId);
    if (!view) return changes;
    return await Promise.all(
      changes.map(async (change) => {
        if (change.op === "add" || change.op === "supersede") {
          return { ...change, anchors: await lineAnchors(change.text, change.why, view) };
        }
        if (change.op === "edit" && change.text) {
          return { ...change, anchors: await lineAnchors(change.text, change.why ?? undefined, view) };
        }
        return change;
      }),
    );
  } catch (err) {
    warn("memory", err, "withAnchors");
    return changes;
  }
}

/* ── the pass over the code ────────────────────────────────────────── */

export interface CheckReport {
  checked: number;
  /** Lines taken out for not being project memory at all. */
  misfiled: number;
  /** Key files in the layers' sheets given what they do, for the
   *  placeholder they had. */
  sheetJobs: number;
  stale: number;
  unchecked: number;
  baselined: number;
  verdicts: { holds: number; stale: number; retired: number; superseded: number; unsure: number };
  /** Pairs of lines giving one setting two values, as the pass found them
   *  — before the check settled them. */
  clashes: Array<{ a: string; b: string; names: string[] }>;
  conflicts: Array<{ a: string; b: string; verdict: string; reason?: string }>;
}

/** Run `work` over `items`, a few at a time. */
async function inTurns<T, R>(items: T[], at: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(at, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Hold every current line up against the code: mark what moved, put what
 * can't be told to a check, and write down the anchors of what holds.
 * Changes nothing in the memory's words. Answers each line's finding.
 */
export async function validate(
  ctx: ServerContext,
  projectId: string,
  view: RepoView,
  report: CheckReport,
): Promise<Map<string, Finding>> {
  const lines = linesWith(ctx.memory.state(projectId));
  const findings = await inTurns(lines, 8, (line) => checkLine(line, view));
  const changes: MemoryChange[] = [];
  const out = new Map<string, Finding>();
  lines.forEach((line, i) => {
    const finding = findings[i]!;
    out.set(line.id, finding);
    report.checked += 1;
    // what was let in before the rules were: a session's weather, a fixed
    // bug filed as a failure
    const wrong = line.pinned ? undefined : misfiled(line.part, line.text, line.why, line.by);
    if (wrong) {
      report.misfiled += 1;
      changes.push({ op: "retire", line: line.id, reason: `not project memory: ${wrong}` });
      return;
    }
    if (finding.strong.length) {
      report.stale += 1;
      changes.push({ op: "flag", line: line.id, reason: finding.strong.join("; "), kind: "stale" });
      return;
    }
    if (finding.weak.length || finding.unchecked) {
      report.unchecked += 1;
      const reason = finding.weak.length
        ? finding.weak.join("; ")
        : "never held up against git and its packages";
      // a conflict another pass found stays until it is settled
      if (line.check?.kind !== "conflict")
        changes.push({ op: "flag", line: line.id, reason, kind: "unchecked" });
      return;
    }
    if (line.check && line.check.kind !== "conflict" && !line.check.tried) {
      // what was wrong with it is right again (what a check of the line
      // itself found stays until a check says otherwise)
      changes.push({ op: "verify", line: line.id, anchors: finding.now, evidence: "the code agrees again" });
    } else if (!line.anchors && (anchored(finding.now) || view.head)) {
      report.baselined += 1;
      changes.push({ op: "verify", line: line.id, anchors: finding.now });
    }
  });
  if (changes.length) ctx.memory.apply(projectId, changes, { by: "system" });
  return out;
}

/* ── evidence ──────────────────────────────────────────────────────── */

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: dir, env: ENV, timeout: 10_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      (err, out) => resolve(err ? "" : out),
    );
  });
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…]` : text;
}

/** The lines of a file that mention any of `words`, numbered. */
function linesMentioning(dir: string, file: string, words: string[], max = 12): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, file), "utf8");
  } catch {
    return "";
  }
  const rows = text.split("\n");
  if (!words.length)
    return rows
      .slice(0, 20)
      .map((row, i) => `${i + 1}: ${row}`)
      .join("\n");
  const pattern = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
  return rows
    .flatMap((row, i) => (pattern.test(row) ? [`${i + 1}: ${row.slice(0, 200)}`] : []))
    .slice(0, max)
    .join("\n");
}

/** What the repository says now about what one line rests on. */
async function evidenceFor(
  line: LineRecord,
  finding: Finding,
  view: RepoView,
  readme: string,
): Promise<string> {
  const parts: string[] = [];
  const now = finding.now;
  const words = [
    ...(now.symbols ?? []).map((s) => s.name),
    ...(now.values ?? []).map((v) => v.name),
    ...(now.terms ?? []).map((t) => t.term),
  ];
  for (const p of (now.paths ?? []).filter((p) => p.exists).slice(0, 3)) {
    const shown = linesMentioning(view.dir, p.path, words);
    parts.push(`${p.path}${shown ? `, where it bears on the line:\n${shown}` : " exists"}`);
  }
  for (const p of (now.paths ?? []).filter((p) => !p.exists))
    parts.push(`${p.path}: no such path in the project`);
  for (const s of now.symbols ?? []) {
    if (!s.found) {
      parts.push(`${s.name}: not found anywhere in the code`);
      continue;
    }
    const files = (await view.grep(s.name)).slice(0, 4);
    parts.push(`${s.name}: in ${files.join(", ")}${files.length === 4 ? " and more" : ""}`);
  }
  for (const v of now.values ?? []) {
    const set = await view.settingsOf(v.name);
    parts.push(
      set.length
        ? `${v.name} is set to ${set.map((s) => `${s.value} in ${s.file}`).join(", ")}`
        : `${v.name}: not set in the code`,
    );
  }
  for (const name of new Set((now.packages ?? []).map((p) => p.name))) {
    const deps = view.packages.filter((d) => d.name === name);
    parts.push(`${name}: ${deps.map((d) => `${d.spec} in ${d.file}`).join(", ")}`);
  }
  if (view.git) {
    const known = knownBranches(view.git);
    for (const b of now.branches ?? []) {
      const branch = known.get(b.name);
      if (!branch) {
        parts.push(`${b.name}: no such branch (local or remote)`);
        continue;
      }
      const mainline = view.git.mainline ?? "HEAD";
      const ahead = (await git(view.dir, ["rev-list", "--count", `${mainline}..${branch.name}`])).trim();
      const last = (
        await git(view.dir, ["log", "-1", "--format=%h %ad %s", "--date=short", branch.name])
      ).trim();
      parts.push(
        `${branch.name}: ${branch.merged ? `merged into ${mainline}` : `not merged into ${mainline}, ${ahead} commits ahead`}; its last commit ${last}`,
      );
    }
  }
  if (now.terms?.length) {
    for (const t of now.terms) {
      const files = (await view.grep(t.term)).slice(0, 5);
      parts.push(
        `${t.term}: ${t.present ? "in the README, docs or description" : "not in the README, docs or description"}; in the code: ${files.length ? `${files.join(", ")}${files.length === 5 ? " and more" : ""}` : "nowhere"}`,
      );
    }
    parts.push(`The README opens:\n${readme}`);
  }
  const since = line.date ?? (line.validFrom ? dayOf(line.validFrom) : undefined);
  if (view.isRepo) {
    // since the line was written — or, for a line that never said when,
    // the latest there are
    const log = (
      await git(view.dir, [
        "log",
        ...(since ? [`--since=${since}`] : []),
        "--format=%h %ad %s",
        "--date=short",
        "-12",
      ])
    ).trim();
    if (log) parts.push(`${since ? `Commits since ${since}` : "The latest commits"}, newest first:\n${log}`);
  }
  return clip(parts.join("\n"), EVIDENCE_CHARS);
}

/* ── the check of a line ───────────────────────────────────────────── */

const VERIFY_SYSTEM = `You check lines of a software project's working memory against its code as it is now. Coding agents read this memory before they start, and act on it, so a line that no longer holds misleads every session after.

Each line comes with its id, its part (decisions, worked, failed, gotchas, open, now), who wrote it, when, why it was put to you — what moved in the code, or what it names that the code doesn't show — and evidence read from the repository just now: files and the lines in them that bear on it, the values the code sets, the packages and their versions, the branches and how far along they are, the README, the commits since the line was written.

Read WHAT THE PROJECT IS NOW first: its README and description, and its latest commits. Then for each line decide:
- "holds": still true and still worth reading — the evidence agrees, or the line is about something outside the repository (the user's machine, another program, a service, the user's preferences) that the evidence doesn't touch. A "failed" or "worked" line is a record of what happened, and holds while what it is about is still part of the project.
- "stale": it no longer holds, or no longer matters: a decision the project went another way on; a value or a version that changed; an open item that was done, or whose subject the project dropped; a plan, a trap or a lesson about a tool, an engine or a design the project no longer uses — when the README and the code show the project built on something else, every line about the thing it left is stale, even where nothing contradicts it word for word. Where the evidence shows what is true now and it is worth keeping, give the line as it should read in "text" (and "why"), same part, under 25 words, in the line's own manner. Leave "text" out when nothing should take its place, and it is retired.
- "unsure": the evidence can't settle it either way. Not for a line whose subject the project plainly left.
Lines about one subject come together: settle them together, consistently.

Give "reason" — one short sentence — and "evidence": what in the evidence shows it (a file and the value in it, a commit, a phrase of the README). Never invent: a corrected line must come from the evidence.

Reply as JSON and nothing else: {"verdicts": [{"id": "...", "verdict": "holds", "reason": "...", "evidence": "..."}, {"id": "...", "verdict": "stale", "reason": "...", "evidence": "...", "text": "...", "why": "..."}]}`;

/** A line, as the check is shown it. */
function lineForCheck(line: LineRecord, evidence: string): string {
  const who = line.by === "user" || line.pinned ? "the user" : line.by === "agent" ? "an agent" : "the model";
  return [
    `LINE ${line.id} (${line.part}${line.layer ? `, layer ${line.layer}` : ""}; by ${who}${line.date ? `, ${line.date}` : ""})`,
    `  ${line.text}${line.why ? ` — ${line.why}` : ""}`,
    `  put to you because: ${line.check?.reason ?? "it was never checked"}`,
    `  evidence:\n${evidence
      .split("\n")
      .map((row) => `    ${row}`)
      .join("\n")}`,
  ].join("\n");
}

/** Marked lines in an order that keeps lines about one subject together —
 *  by the first term, symbol or path each names — so a batch settles them
 *  as one. */
function bySubject(lines: LineRecord[], findings: Map<string, Finding>): LineRecord[] {
  const subject = (line: LineRecord) => {
    const now = findings.get(line.id)?.now ?? line.anchors;
    return (
      now?.terms?.[0]?.term ??
      now?.packages?.[0]?.name ??
      now?.symbols?.[0]?.name ??
      now?.paths?.[0]?.path ??
      now?.branches?.[0]?.name ??
      "~"
    ).toLowerCase();
  };
  return [...lines].sort((a, b) => subject(a).localeCompare(subject(b)));
}

/** Whether a marked line is due a check. */
function due(line: LineRecord): boolean {
  if (!line.check || line.quarantined) return false;
  return !line.check.tried || Date.now() - line.check.tried > RETRY_UNSURE_MS;
}

/** The marked lines put to the memory model, a few at a time, and what it
 *  says applied — each batch a fold of its own, undoable. */
export async function verifyMarked(
  ctx: ServerContext,
  projectId: string,
  view: RepoView,
  findings: Map<string, Finding>,
  ask: Ask,
  report: CheckReport,
): Promise<void> {
  const marked = bySubject(
    linesWith(ctx.memory.state(projectId)).filter((line) => due(line) && line.check?.kind !== "conflict"),
    findings,
  );
  if (!marked.length) return;
  const readme = clip(
    (() => {
      for (const name of ["README.md", "readme.md", "README", "README.txt"]) {
        try {
          return fs.readFileSync(path.join(view.dir, name), "utf8");
        } catch {
          // the next name
        }
      }
      return "(no README)";
    })(),
    1500,
  );
  // what the project is now, once for every batch: what it says of itself,
  // and its latest commits
  const brief = ctx.briefs.get(projectId);
  const latest = view.isRepo
    ? (await git(view.dir, ["log", "--format=%h %ad %s", "--date=short", "-15"])).trim()
    : "";
  const now = [
    ...(brief.description ? [`Description: ${brief.description}`] : []),
    `README:\n${readme}`,
    ...(latest ? [`Latest commits:\n${latest}`] : []),
  ].join("\n\n");
  for (let i = 0; i < marked.length; i += VERIFY_BATCH) {
    const batch = marked.slice(i, i + VERIFY_BATCH);
    const shown = await Promise.all(
      batch.map(async (line) => {
        const finding = findings.get(line.id) ?? (await checkLine(line, view));
        return lineForCheck(line, await evidenceFor(line, finding, view, readme));
      }),
    );
    const prompt =
      `PROJECT: ${ctx.store.get(projectId)?.name ?? projectId}\nTODAY: ${dayOf()}\nHEAD: ${view.head ?? "(not a git repository)"}\n\n` +
      `WHAT THE PROJECT IS NOW:\n${now}\n\n` +
      shown.join("\n\n");
    let verdicts: RawOp[];
    try {
      verdicts = parseOps(await ask(VERIFY_SYSTEM, prompt, 3000), "verdicts");
    } catch (err) {
      warn("memory", err, "verifyMarked");
      return;
    }
    const fold = MemoryBook.foldId();
    const changes: MemoryChange[] = [];
    const answered = new Set<string>();
    for (const verdict of verdicts) {
      const id = typeof verdict["id"] === "string" ? verdict["id"] : "";
      const line = batch.find((l) => l.id === id);
      if (!line || answered.has(id)) continue;
      answered.add(id);
      const kind = typeof verdict["verdict"] === "string" ? verdict["verdict"].toLowerCase() : "";
      const reason = typeof verdict["reason"] === "string" ? verdict["reason"].trim() : "";
      const evidence = typeof verdict["evidence"] === "string" ? verdict["evidence"].trim() : "";
      const text = typeof verdict["text"] === "string" ? verdict["text"].trim() : "";
      const why = typeof verdict["why"] === "string" ? verdict["why"].trim() : "";
      const anchors: MemoryAnchors | undefined = findings.get(id)?.now;
      if (kind === "holds") {
        report.verdicts.holds += 1;
        changes.push({
          op: "verify",
          line: id,
          ...(anchors ? { anchors } : {}),
          evidence: evidence || reason,
        });
      } else if (kind === "stale" && line.by !== "user" && !line.pinned) {
        report.verdicts.stale += 1;
        const why_ = reason || "the code moved on";
        if (text) {
          report.verdicts.superseded += 1;
          changes.push({
            op: "supersede",
            line: id,
            text,
            ...(why ? { why } : {}),
            reason: `checked against the code: ${why_}`,
            evidence: evidence || why_,
            ...(anchors ? { anchors } : {}),
          });
        } else {
          report.verdicts.retired += 1;
          changes.push({
            op: "retire",
            line: id,
            reason: `checked against the code: ${why_}`,
            evidence: evidence || why_,
          });
        }
      } else {
        // the user's line is the user's to change: it stays, marked with
        // what the check found; one nobody could settle is asked again later
        report.verdicts.unsure += kind === "stale" ? 0 : 1;
        if (kind === "stale") report.verdicts.stale += 1;
        changes.push({
          op: "flag",
          line: id,
          reason:
            kind === "stale"
              ? `${reason || "the check found it stale"}${evidence ? ` (${evidence})` : ""}`
              : line.check!.reason,
          kind: kind === "stale" ? "stale" : (line.check!.kind ?? "stale"),
          tried: Date.now(),
        });
      }
    }
    // a line the answer skipped is tried again next time, not marked settled
    const result = ctx.memory.apply(projectId, changes, { by: "model", fold });
    for (const { change, reason } of result.refused) {
      warn(
        "memory",
        new Error(`${change.op} ${"line" in change ? change.line : ""} refused: ${reason}`),
        "verifyMarked",
      );
    }
  }
}

/* ── lines against each other ──────────────────────────────────────── */

const PAIRS_SYSTEM = `You keep a software project's working memory consistent. You are given pairs of its lines that may disagree or repeat each other, each line with its id, part, author and date, and — where the code bears on it — what the code says now.

For each pair decide:
- "contradict": they cannot both be true now — two values for one setting, a decision and its reversal, "X is open" beside "X is done". Name the line that holds in "keep" when the code or the dates show which; leave "keep" out when nothing does.
- "duplicate": they say the same thing (a "now" and an "open" restating one fact count). Name the one to keep — the more exact, or the user's, or an agent's over the model's.
- "consistent": they are about different things, or one refines the other.

Give "reason" — one short sentence — and "evidence" where the code decides it.

Reply as JSON and nothing else: {"pairs": [{"pair": 1, "verdict": "contradict", "keep": "d9c2j", "reason": "...", "evidence": "..."}, {"pair": 2, "verdict": "consistent"}]}`;

/** Two lines that give one name two different numbers. */
function valueClash(a: LineRecord, b: LineRecord): string[] {
  const valuesIn = (text: string) =>
    new Map(
      [
        ...text.matchAll(
          /\b([A-Z][A-Z0-9_]{2,}|[a-z]+[A-Z]\w*)\s*(?:=|:|\s)\s*(-?\d+(?:\.\d+)?)(?![\d.]*[A-Za-z%])/g,
        ),
      ].map((m) => [m[1]!, m[2]!]),
    );
  const left = valuesIn(`${a.text} ${a.why ?? ""}`);
  const right = valuesIn(`${b.text} ${b.why ?? ""}`);
  return [...left].flatMap(([name, value]) => (right.has(name) && right.get(name) !== value ? [name] : []));
}

/** Pairs worth asking about: alike enough to repeat each other, or giving
 *  one setting two values. */
export function candidatePairs(
  lines: LineRecord[],
): Array<{ a: LineRecord; b: LineRecord; clash: string[] }> {
  const out: Array<{ a: LineRecord; b: LineRecord; clash: string[]; score: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (a.quarantined || b.quarantined) continue;
      const clash = valueClash(a, b);
      const score = similarity(`${a.text} ${a.why ?? ""}`, `${b.text} ${b.why ?? ""}`);
      if (clash.length ? score >= 0.3 : score >= 0.45) out.push({ a, b, clash, score });
    }
  }
  return out.sort((x, y) => y.clash.length - x.clash.length || y.score - x.score).slice(0, 60);
}

/** Pairs already judged to be about different things, so a pass doesn't
 *  ask again — by the two lines' ids and words. */
function judgedFile(projectId: string): string {
  return configPath("memory", `${projectId}.pairs.json`);
}

function pairKey(a: LineRecord, b: LineRecord): string {
  const [x, y] = [a, b].sort((p, q) => p.id.localeCompare(q.id));
  return `${x!.id}|${y!.id}|${x!.text.length}:${y!.text.length}:${(x!.why ?? "").length}:${(y!.why ?? "").length}`;
}

function readJudged(projectId: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(judgedFile(projectId), "utf8")) as { pairs?: unknown };
    return new Set(
      Array.isArray(raw.pairs) ? raw.pairs.filter((p): p is string => typeof p === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function writeJudged(projectId: string, judged: Set<string>): void {
  try {
    writeJsonAtomic(judgedFile(projectId), { pairs: [...judged].slice(-5000) });
  } catch (err) {
    warn("memory", err, "writeJudged");
  }
}

/** Pairs that may disagree or repeat, put to the memory model; what it
 *  finds applied — the line that doesn't hold retired, a repeat merged,
 *  an undecided contradiction marked on both lines. */
export async function settlePairs(
  ctx: ServerContext,
  projectId: string,
  view: RepoView,
  ask: Ask,
  report: CheckReport,
): Promise<void> {
  const lines = linesWith(ctx.memory.state(projectId));
  const judged = readJudged(projectId);
  const pairs = candidatePairs(lines).filter(
    ({ a, b }) =>
      !judged.has(pairKey(a, b)) &&
      !(a.check?.kind === "conflict" && b.check?.kind === "conflict" && a.check.tried && b.check.tried),
  );
  for (let i = 0; i < pairs.length; i += PAIR_BATCH) {
    const batch = pairs.slice(i, i + PAIR_BATCH);
    const shown = await Promise.all(
      batch.map(async ({ a, b, clash }, k) => {
        const code = await Promise.all(
          clash.map(async (name) => {
            const set = await view.settingsOf(name);
            return set.length
              ? `${name} is set to ${set.map((s) => `${s.value} in ${s.file}`).join(", ")}`
              : "";
          }),
        );
        const one = (line: LineRecord) =>
          `  ${line.id} (${line.part}, by ${line.by === "user" || line.pinned ? "the user" : line.by}${line.date ? `, ${line.date}` : ""}): ${line.text}${line.why ? ` — ${line.why}` : ""}`;
        return [`PAIR ${k + 1}`, one(a), one(b), ...code.filter(Boolean).map((c) => `  the code: ${c}`)].join(
          "\n",
        );
      }),
    );
    let verdicts: RawOp[];
    try {
      verdicts = parseOps(await ask(PAIRS_SYSTEM, shown.join("\n\n"), 2500), "pairs");
    } catch (err) {
      warn("memory", err, "settlePairs");
      return;
    }
    const changes: MemoryChange[] = [];
    const leaving = new Set<string>();
    for (const verdict of verdicts) {
      const pair = batch[Number(verdict["pair"]) - 1];
      if (!pair) continue;
      const kind = typeof verdict["verdict"] === "string" ? verdict["verdict"].toLowerCase() : "";
      const keepId = typeof verdict["keep"] === "string" ? verdict["keep"] : "";
      const reason = typeof verdict["reason"] === "string" ? verdict["reason"].trim() : "";
      const evidence = typeof verdict["evidence"] === "string" ? verdict["evidence"].trim() : "";
      report.conflicts.push({ a: pair.a.id, b: pair.b.id, verdict: kind, ...(reason ? { reason } : {}) });
      if (kind !== "contradict" && kind !== "duplicate") {
        if (kind === "consistent") judged.add(pairKey(pair.a, pair.b));
        continue;
      }
      let keep = keepId === pair.a.id ? pair.a : keepId === pair.b.id ? pair.b : undefined;
      if (kind === "duplicate") {
        // of two lines saying one thing, the user's stays over an agent's and
        // an agent's over the model's, whatever the judge preferred — and a
        // line that says a good deal more is not a repeat to merge away
        const rank = (line: LineRecord) =>
          line.by === "user" || line.pinned ? 3 : line.by === "agent" ? 2 : 1;
        if (rank(pair.a) !== rank(pair.b)) keep = rank(pair.a) > rank(pair.b) ? pair.a : pair.b;
        const other = keep === pair.a ? pair.b : pair.a;
        if (
          keep &&
          words(`${other.text} ${other.why ?? ""}`) > 1.5 * words(`${keep.text} ${keep.why ?? ""}`)
        ) {
          judged.add(pairKey(pair.a, pair.b));
          continue;
        }
      }
      const lose = keep ? (keep === pair.a ? pair.b : pair.a) : undefined;
      if (
        keep &&
        lose &&
        !leaving.has(lose.id) &&
        !leaving.has(keep.id) &&
        lose.by !== "user" &&
        !lose.pinned
      ) {
        leaving.add(lose.id);
        changes.push(
          kind === "duplicate"
            ? {
                op: "merge",
                line: lose.id,
                into: keep.id,
                reason: reason || `says what ${keep.id} says`,
                evidence: evidence || `repeats ${keep.id}`,
              }
            : {
                op: "retire",
                line: lose.id,
                reason: `contradicted by ${keep.id}: ${reason || "they cannot both hold"}`,
                evidence: evidence || `${keep.id} holds`,
              },
        );
        continue;
      }
      if (kind === "contradict") {
        // nothing says which holds, or the one that doesn't is the user's
        for (const [line, other] of [
          [pair.a, pair.b],
          [pair.b, pair.a],
        ] as const) {
          if (leaving.has(line.id)) continue;
          changes.push({
            op: "flag",
            line: line.id,
            reason: `disagrees with ${other.id}${reason ? `: ${reason}` : ""}`,
            kind: "conflict",
            tried: Date.now(),
          });
        }
      }
    }
    if (changes.length) ctx.memory.apply(projectId, changes, { by: "model", fold: MemoryBook.foldId() });
    writeJudged(projectId, judged);
  }
}

/* ── running it ────────────────────────────────────────────────────── */

const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

/** One whole check of a project's memory: against the code, then by the
 *  memory model when `verify` (and the model layer is on). */
export async function checkMemory(
  ctx: ServerContext,
  projectId: string,
  options: { verify?: boolean; ask?: Ask; push?: boolean } = {},
): Promise<CheckReport | undefined> {
  const report: CheckReport = {
    checked: 0,
    misfiled: 0,
    sheetJobs: 0,
    stale: 0,
    unchecked: 0,
    baselined: 0,
    verdicts: { holds: 0, stale: 0, retired: 0, superseded: 0, unsure: 0 },
    clashes: [],
    conflicts: [],
  };
  if (running.has(projectId) || !ctx.store.get(projectId)) return undefined;
  running.add(projectId);
  try {
    const verifying = options.verify !== false && smallModelEnabled();
    const ask = options.ask ?? completeMemory;
    // the layers' sheets first: a key file listed with no word on what it does
    report.sheetJobs = await repairSheets(ctx, projectId, verifying ? ask : undefined, options.push !== false);
    if (!ctx.memory.view(projectId)) return report;
    const view = await projectView(ctx, projectId, true);
    if (!view) return report;
    const findings = await validate(ctx, projectId, view, report);
    report.clashes = candidatePairs(linesWith(ctx.memory.state(projectId)))
      .filter((pair) => pair.clash.length)
      .map(({ a, b, clash }) => ({ a: a.id, b: b.id, names: clash }));
    if (verifying) {
      await verifyMarked(ctx, projectId, view, findings, ask, report);
      await settlePairs(ctx, projectId, view, ask, report);
    }
    if (options.push !== false) pushSheet(ctx, projectId);
    return report;
  } catch (err) {
    warn("memory", err, "checkMemory");
    return report;
  } finally {
    running.delete(projectId);
  }
}

/** Every check waiting, called off (a test's end). */
export function cancelChecks(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

/** A check soon — after a fold, at launch. A burst asks once. */
export function scheduleCheck(ctx: ServerContext, projectId: string, delay = 20_000): void {
  if (timers.has(projectId)) return;
  const timer = setTimeout(() => {
    timers.delete(projectId);
    void checkMemory(ctx, projectId);
  }, delay);
  timer.unref?.();
  timers.set(projectId, timer);
}

/** Every project with a memory checked once after launch, one after another
 *  — not all at once, which would be every project's git at the same time. */
export function checkAllSoon(ctx: ServerContext, first = 90_000, apart = 45_000): void {
  ctx.store.list().forEach((project, i) => scheduleCheck(ctx, project.id, first + i * apart));
}
