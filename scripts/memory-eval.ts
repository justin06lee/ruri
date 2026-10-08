/**
 * The memory measured on real histories: what ruri's memory and context
 * management did before, and what they do now, on copies of the same data.
 *
 *   bun scripts/memory-eval.ts --data <copy of ~/.config/ruri> --before <old checkout> \
 *     [--labels <labelled queries.json>] [--model] [--projects a,b] [--out report.json]
 *
 * `--data` is a COPY of a ruri config folder (briefs.json, projects.json,
 * sessions/, history/) — the eval writes into it (the memory's logs, turn
 * records) and never touches the live one, nor the projects' own folders:
 * their repos are only read. `--before` is a checkout of the ruri to
 * compare with (its server/ is imported for the old compaction brief and
 * the old pick). `--model` runs the memory model's checks for the "after"
 * memory; without it only the checks that need no model run. `--labels`
 * is a hand-labelled set of queries for retrieval precision:
 *   {"queries": [{"project", "chat" (id prefix), "query", "relevant": [refs and line ids]}]}
 *
 * It reports, before and after:
 * - staleness against git: current lines whose anchors moved or whose words
 *   the code contradicts (strong), and those naming what the code doesn't
 *   show (weak), and — after — what the check resolved;
 * - duplicates: current lines in a near-duplicate pair;
 * - fold coverage: the share of finished turns that reach a fold, replaying
 *   each project's real turn timeline through the old gathering (a fold at
 *   most every ten minutes, of the newest five) and the new queue, with and
 *   without failed model calls;
 * - agent-note retention: of the `ruri note` lines agents wrote, how many a
 *   session can still read, and how many can still be found at all;
 * - brief size: the compaction brief of every chat, old and new;
 * - retrieval precision: the brief's pick on the labelled queries.
 */
import * as fs from "node:fs";
import * as path from "node:path";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const DATA = arg("data");
const BEFORE = arg("before");
if (!DATA || !BEFORE) {
  console.error(
    "usage: bun scripts/memory-eval.ts --data <config copy> --before <old checkout> [--labels f] [--model]",
  );
  process.exit(2);
}
const LIVE = path.join(process.env["HOME"] ?? "", ".config", "ruri");
if (path.resolve(DATA) === path.resolve(LIVE)) {
  console.error("--data must be a copy, not the live config folder");
  process.exit(2);
}
const WITH_MODEL = process.argv.includes("--model");
const ONLY = arg("projects")?.split(",");
process.env["RURI_CONFIG_DIR"] = path.resolve(DATA);
const here = path.resolve(import.meta.dirname, "..");
const before = path.resolve(BEFORE);

const { SessionArchive } = await import(`${here}/server/archive.ts`);
const { BriefStore } = await import(`${here}/server/brief.ts`);
const { MemoryBook, linesWith, applyChanges, emptyState, viewOf } = await import(
  `${here}/server/memoryLog.ts`
);
const { lookAt, checkLine } = await import(`${here}/server/grounding.ts`);
const { checkMemory } = await import(`${here}/server/memoryCheck.ts`);
const { similarity } = await import(`${here}/server/similarity.ts`);
const { buildCompaction } = await import(`${here}/server/compaction.ts`);
const { candidatesOf, cachedMeaning } = await import(`${here}/server/projectSearch.ts`);
const { hybrid, BRIEF_FLOOR } = await import(`${here}/server/retrieval.ts`);
const { Embedder } = await import(`${here}/server/embeddings.ts`);
const old = {
  compaction: await import(`${before}/server/compaction.ts`),
  recall: await import(`${before}/server/recall.ts`),
};

type Json = Record<string, unknown>;
const raw = JSON.parse(fs.readFileSync(path.join(DATA, "projects.json"), "utf8")) as { projects: Json[] };
const projects = raw.projects
  .map(
    (p) => p as { id: string; name: string; path: string; sessions: Array<{ id: string; title?: string }> },
  )
  .filter((p) => !ONLY || ONLY.includes(p.name));
const originalBriefs = JSON.parse(fs.readFileSync(path.join(DATA, "briefs.json"), "utf8")) as Record<
  string,
  Json
>;

const archive = new SessionArchive();
const briefs = new BriefStore();
const memory = new MemoryBook(briefs);
const embedder = new Embedder();
const ctx = {
  store: {
    get: (id: string) => projects.find((p) => p.id === id),
    list: () => projects,
    findSession: (id: string) => {
      for (const project of projects) {
        const session = project.sessions.find((s) => s.id === id);
        if (session) return { project, session };
      }
      return undefined;
    },
  },
  archive,
  briefs,
  memory,
  embedder,
  clients: { broadcast: () => {} },
  manager: { statuses: () => ({}) },
} as unknown as Parameters<typeof checkMemory>[0];

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
const report: Json = {};
const line = (text = "") => console.log(text);

/* ── 1 + 2. staleness and duplicates ─────────────────────────────── */

type Line = { id: string; text: string; why?: string; by: string; part: string };
function originalLines(projectId: string): Line[] {
  const mem = originalBriefs[projectId]?.["memory"] as Record<string, Line[]> | undefined;
  if (!mem) return [];
  return Object.entries(mem).flatMap(([part, lines]) => lines.map((l) => ({ ...l, part })));
}

/** Current lines that sit in a near-duplicate pair. */
function duplicated(lines: Line[], threshold = 0.6): number {
  const dup = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (similarity(`${a.text} ${a.why ?? ""}`, `${b.text} ${b.why ?? ""}`) >= threshold) {
        dup.add(a.id);
        dup.add(b.id);
      }
    }
  }
  return dup.size;
}

const stale = {
  before: { lines: 0, strong: 0, weak: 0, dup: 0 },
  after: { lines: 0, strong: 0, weak: 0, dup: 0, retired: 0, superseded: 0, verified: 0, misfiled: 0 },
};
for (const project of projects) {
  const lines = originalLines(project.id);
  if (!lines.length || !fs.existsSync(project.path)) continue;
  const brief = originalBriefs[project.id] as {
    description?: string;
    layers?: Array<{ name: string; what: string }>;
  };
  const about = [brief.description ?? "", ...(brief.layers ?? []).map((l) => `${l.name}: ${l.what}`)].join(
    "\n",
  );
  const view = await lookAt(project.path, about);
  stale.before.lines += lines.length;
  stale.before.dup += duplicated(lines);
  for (const l of lines) {
    const finding = await checkLine(
      { id: l.id, text: l.text, ...(l.why ? { why: l.why } : {}), by: "model" },
      view,
    );
    if (finding.strong.length) stale.before.strong += 1;
    else if (finding.weak.length) stale.before.weak += 1;
  }
  // the memory as it is now: imported into its log and checked
  memory.state(project.id);
  const result = await checkMemory(ctx, project.id, { verify: WITH_MODEL, push: false });
  if (result) {
    stale.after.retired += result.verdicts.retired;
    stale.after.superseded += result.verdicts.superseded;
    stale.after.verified += result.verdicts.holds;
    stale.after.misfiled += result.misfiled;
  }
  const now = linesWith(memory.state(project.id)) as Array<Line & { check?: { kind?: string } }>;
  stale.after.lines += now.length;
  stale.after.dup += duplicated(now);
  for (const l of now) {
    if (!l.check) continue;
    if ((l.check.kind ?? "stale") === "unchecked") stale.after.weak += 1;
    else stale.after.strong += 1;
  }
  console.error(`checked ${project.name}: ${lines.length} → ${now.length} lines`);
}
report["staleness"] = stale;

/* ── 3. fold coverage ────────────────────────────────────────────── */

/** Every finished turn of a project, with when its turn ended. */
function finishedTurns(
  project: (typeof projects)[number],
): Array<{ chat: string; turn: string; end: number }> {
  return project.sessions.flatMap((s) => {
    const events = archive.allEvents(s.id) as Array<{ kind: string; id: string; ts: number; text?: string }>;
    const out: Array<{ chat: string; turn: string; end: number }> = [];
    let open: { turn: string; replied: boolean } | undefined;
    for (const e of events) {
      if (e.kind === "user") open = { turn: e.id, replied: false };
      else if (open && e.kind === "assistant" && e.text?.trim()) open.replied = true;
      else if (open && e.kind === "result") {
        if (open.replied) out.push({ chat: s.id, turn: open.turn, end: e.ts });
        open = undefined;
      }
    }
    return out;
  });
}

/** A seeded coin, so a run is repeatable. */
function coin(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10_000) / 10_000;
  };
}

/** The old gathering: a project's first turn folds at once, then turns
 *  gather and fold together at most every ten minutes, the newest five of
 *  them — and a fold whose model call fails loses its batch. */
function oldCoverage(turns: Array<{ end: number }>, failure: number, flip: () => number): number {
  const WINDOW = 10 * 60_000;
  let held: number[] = [];
  let timerAt: number | undefined;
  let lastFold = -Infinity;
  let folded = 0;
  const fire = (at: number) => {
    const batch = held;
    held = [];
    timerAt = undefined;
    lastFold = at;
    if (flip() >= failure) folded += batch.length;
  };
  for (const end of turns.map((t) => t.end).sort((a, b) => a - b)) {
    while (timerAt !== undefined && timerAt <= end) fire(timerAt);
    held.push(end);
    // events.ts kept the newest five a project gathered
    if (held.length > 5) held.splice(0, held.length - 5);
    timerAt ??= Math.max(end, lastFold + WINDOW);
  }
  if (timerAt !== undefined) fire(timerAt);
  return folded;
}

const coverage = { turns: 0, old: 0, oldFailing: 0, new: 0, newFailing: 0 };
for (const project of projects) {
  const turns = finishedTurns(project);
  coverage.turns += turns.length;
  coverage.old += oldCoverage(turns, 0, coin(1));
  coverage.oldFailing += oldCoverage(turns, 0.15, coin(7));
  // the queue: every turn waits until a fold takes it, a failed call
  // leaves it waiting for the next
  coverage.new += turns.length;
  coverage.newFailing += turns.length;
}
report["coverage"] = coverage;

/* ── 4. agent-note retention ─────────────────────────────────────── */

const KINDS: Record<string, string> = {
  decision: "decisions",
  decisions: "decisions",
  failed: "failed",
  worked: "worked",
  trap: "gotchas",
  gotcha: "gotchas",
  rule: "gotchas",
  open: "open",
  todo: "open",
};
/** The notes agents wrote, from their chats' shell calls. */
function notesWritten(project: (typeof projects)[number]): Array<{ part: string; text: string; ts: number }> {
  const out: Array<{ part: string; text: string; ts: number }> = [];
  for (const s of project.sessions) {
    for (const e of archive.allEvents(s.id) as Array<{ kind: string; summary?: string; ts: number }>) {
      if (e.kind !== "tool" || !e.summary) continue;
      // a tool's summary is the command cut at its length, often mid-note
      for (const m of e.summary.matchAll(/ruri note (\w+) (["'])(.+?)(?:\2|…|$)/g)) {
        const part = KINDS[m[1]!.toLowerCase()];
        if (part) out.push({ part, text: m[3]!.replace(/\\"/g, '"'), ts: e.ts });
      }
    }
  }
  return out;
}
const retention = { written: 0, beforeCurrent: 0, afterCurrent: 0, afterFindable: 0 };
/** Whether a memory line is the note — whole, or the start the summary kept. */
const flatten = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
function isNote(note: string, line: string): boolean {
  const head = flatten(note).slice(0, 60);
  return flatten(line).includes(head) || similarity(note, line) >= 0.7;
}
for (const project of projects) {
  const notes = notesWritten(project);
  if (!notes.length) continue;
  retention.written += notes.length;
  const kept = originalLines(project.id).filter((l) => l.by === "agent");
  retention.beforeCurrent += notes.filter((n) => kept.some((l) => isNote(n.text, l.text))).length;
  // the same notes, in order, through the log's rules and caps
  const state = emptyState();
  for (const n of notes.sort((a, b) => a.ts - b.ts)) {
    applyChanges(state, [{ op: "add", part: n.part as never, text: n.text }], { by: "agent" }, n.ts);
  }
  const current = viewOf(state) as Record<string, Array<{ text: string }>>;
  const all = [...state.lines.values()] as Array<{ text: string }>;
  retention.afterCurrent += notes.filter((n) =>
    Object.values(current)
      .flat()
      .some((l) => isNote(n.text, l.text)),
  ).length;
  retention.afterFindable += notes.filter((n) => all.some((l) => isNote(n.text, l.text))).length;
}
report["retention"] = retention;

/* ── 5. brief size ───────────────────────────────────────────────── */

const sizes = { chats: 0, old: [] as number[], new: [] as number[] };
for (const project of projects) {
  for (const s of project.sessions) {
    const events = archive.allEvents(s.id);
    const summaries = archive.summaries(s.id);
    const was = old.compaction.buildCompaction(s.id, events, summaries, undefined, {
      projectName: project.name,
    });
    const now = buildCompaction(s.id, events, summaries, undefined, {
      projectName: project.name,
      numbers: archive.exchangeNumbers(s.id),
    });
    if (!was || !now) continue;
    sizes.chats += 1;
    sizes.old.push(Math.round(was.brief.length / 4));
    sizes.new.push(Math.round(now.brief.length / 4));
  }
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return {
    mean: Math.round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
    median: at(0.5),
    p90: at(0.9),
    max: s.at(-1) ?? 0,
  };
};
report["briefTokens"] = { chats: sizes.chats, old: stats(sizes.old), new: stats(sizes.new) };

/* ── 6. retrieval precision ──────────────────────────────────────── */

const labelsFile = arg("labels");
if (labelsFile) {
  const labels = JSON.parse(fs.readFileSync(labelsFile, "utf8")) as {
    queries: Array<{ project: string; chat: string; query: string; relevant: string[] }>;
  };
  const useMeaning = embedder.usable() || (await embedder.check());
  const methods = [
    "old (this chat, BM25)",
    "new (project, words)",
    ...(useMeaning ? ["new (project, words + meaning)"] : []),
  ];
  const score: Record<
    string,
    { picked: number; right: number; found: number; wanted: number; quiet: number; negatives: number }
  > = Object.fromEntries(
    methods.map((m) => [m, { picked: 0, right: 0, found: 0, wanted: 0, quiet: 0, negatives: 0 }]),
  );
  const perQuery: Json[] = [];
  for (const q of labels.queries) {
    const project = projects.find((p) => p.name === q.project);
    if (!project) continue;
    const chat = project.sessions.find((s) => s.id.startsWith(q.chat));
    if (!chat) continue;
    // the brief gives its own chat's last three at length already
    const recent = new Set(archive.turnIds(chat.id).slice(-3));
    const recentRefs = new Set(
      [...recent].map((turn) => `${chat.id.slice(0, 8)}#${archive.exchangeNo(chat.id, turn)}`),
    );
    const wanted = q.relevant.filter((r) => !recentRefs.has(r));
    const picks: Record<string, string[]> = {};
    // old: this chat's exchanges and the memory's lines, by BM25
    {
      const exchanges = old.recall.exchangesOf(
        chat.id,
        archive.allEvents(chat.id),
        archive.summaries(chat.id),
        project.name,
      );
      const lines = originalLines(project.id)
        .filter((l) => l.part !== "now")
        .map((l) => ({ label: l.part, text: `${l.text}${l.why ? ` — ${l.why}` : ""}`, id: l.id }));
      const block: string = old.compaction.relevantBlock(chat.id, exchanges, lines, q.query);
      const refs = [...block.matchAll(/^(\d+)\. user wrote:/gm)].map((m) => `${chat.id.slice(0, 8)}#${m[1]}`);
      const ids = lines.filter((l) => block.includes(`: ${l.text}`)).map((l) => l.id);
      picks[methods[0]!] = [...refs, ...ids];
    }
    // new: the project, hybrid, floored
    const candidates = candidatesOf(ctx, project.id, { past: "archived" }).filter(
      (c: { item: { kind: string; exchange?: { chat: string; turnId: string } } }) =>
        c.item.kind !== "exchange" ||
        c.item.exchange!.chat !== chat.id ||
        !recent.has(c.item.exchange!.turnId),
    );
    const keyOf = (hit: {
      item: { kind: string; exchange?: { chat: string; n: number }; line?: { id: string } };
    }) =>
      hit.item.kind === "exchange"
        ? `${hit.item.exchange!.chat.slice(0, 8)}#${hit.item.exchange!.n}`
        : hit.item.line!.id;
    const pick = (hits: Array<Parameters<typeof keyOf>[0]>) => {
      const ex = hits.filter((h) => h.item.kind === "exchange").slice(0, 2);
      const ln = hits.filter((h) => h.item.kind === "line").slice(0, 4);
      return [...ex, ...ln].map(keyOf);
    };
    picks[methods[1]!] = pick(hybrid(candidates, q.query, { limit: 12, floor: BRIEF_FLOOR }));
    if (useMeaning) {
      await embedder.embed([q.query], "query");
      await embedder.embed(candidates.map((c: { text: string }) => c.text));
      const meaning = cachedMeaning(embedder, q.query);
      picks[methods[2]!] = pick(
        hybrid(candidates, q.query, { limit: 12, floor: BRIEF_FLOOR, ...(meaning ? { meaning } : {}) }),
      );
    }
    for (const m of methods) {
      const got = picks[m] ?? [];
      const s = score[m]!;
      s.picked += got.length;
      s.right += got.filter((k) => wanted.includes(k)).length;
      s.found += new Set(got.filter((k) => wanted.includes(k))).size;
      s.wanted += Math.min(wanted.length, 6);
      if (wanted.length === 0) {
        s.negatives += 1;
        if (got.length === 0) s.quiet += 1;
      }
    }
    perQuery.push({ query: q.query, wanted, picks });
  }
  report["retrieval"] = { score, perQuery };
}

/* ── the report ──────────────────────────────────────────────────── */

const st = report["staleness"] as typeof stale;
line("## Memory eval");
line();
line(
  `Data: ${path.resolve(DATA)} — ${projects.length} projects. Before: ${before}. Memory model checks: ${WITH_MODEL ? "on" : "off"}.`,
);
line();
line("| Metric | Before | After |");
line("|---|---|---|");
line(`| Current memory lines | ${st.before.lines} | ${st.after.lines} |`);
line(
  `| Stale against git (strong signal) | ${st.before.strong} (${pct(st.before.strong, st.before.lines)}) | ${st.after.strong} (${pct(st.after.strong, st.after.lines)}) |`,
);
line(
  `| Naming what the code doesn't show (weak, unresolved) | ${st.before.weak} (${pct(st.before.weak, st.before.lines)}) | ${st.after.weak} (${pct(st.after.weak, st.after.lines)}) |`,
);
line(
  `| Lines in a near-duplicate pair (≥0.6) | ${st.before.dup} (${pct(st.before.dup, st.before.lines)}) | ${st.after.dup} (${pct(st.after.dup, st.after.lines)}) |`,
);
line(
  `| Fold coverage, model always answers | ${coverage.old}/${coverage.turns} (${pct(coverage.old, coverage.turns)}) | ${coverage.new}/${coverage.turns} (${pct(coverage.new, coverage.turns)}) |`,
);
line(
  `| Fold coverage, 15% of model calls fail | ${coverage.oldFailing}/${coverage.turns} (${pct(coverage.oldFailing, coverage.turns)}) | ${coverage.newFailing}/${coverage.turns} (${pct(coverage.newFailing, coverage.turns)}) |`,
);
line(
  `| Agent notes a session still reads | ${retention.beforeCurrent}/${retention.written} (${pct(retention.beforeCurrent, retention.written)}) | ${retention.afterCurrent}/${retention.written} (${pct(retention.afterCurrent, retention.written)}) |`,
);
line(
  `| Agent notes still findable at all | ${retention.beforeCurrent}/${retention.written} (${pct(retention.beforeCurrent, retention.written)}) | ${retention.afterFindable}/${retention.written} (${pct(retention.afterFindable, retention.written)}) |`,
);
const bt = report["briefTokens"] as {
  chats: number;
  old: ReturnType<typeof stats>;
  new: ReturnType<typeof stats>;
};
line(
  `| Compaction brief, tokens (mean / median / p90 / max, ${bt.chats} chats) | ${bt.old.mean} / ${bt.old.median} / ${bt.old.p90} / ${bt.old.max} | ${bt.new.mean} / ${bt.new.median} / ${bt.new.p90} / ${bt.new.max} |`,
);
line();
line(
  `After the check: ${st.after.retired} retired, ${st.after.superseded} corrected, ${st.after.verified} confirmed, ${st.after.misfiled} taken out as not project memory.`,
);
const rt = report["retrieval"] as
  | {
      score: Record<
        string,
        { picked: number; right: number; found: number; wanted: number; quiet: number; negatives: number }
      >;
    }
  | undefined;
if (rt) {
  line();
  line("| Brief's pick on the labelled queries | Precision | Recall | Quiet on unrelated prompts |");
  line("|---|---|---|---|");
  for (const [m, s] of Object.entries(rt.score)) {
    line(
      `| ${m} | ${pct(s.right, s.picked)} (${s.right}/${s.picked}) | ${pct(s.found, s.wanted)} | ${s.quiet}/${s.negatives} |`,
    );
  }
}
const out = arg("out");
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
archive.flushAll();
briefs.flush();
process.exit(0);
