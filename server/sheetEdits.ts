import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  IndexEditSection,
  LayerEditSection,
  LayerSheet,
  MemoryPart,
  SheetStamp,
  StackLayer,
  SystemFlow,
  TranscriptEvent,
} from "../shared/protocol.js";
import { ownsSummary } from "../shared/protocol.js";
import {
  layerFile,
  layerOfFile,
  mapLine,
  memoryLineText,
  parseMapLine,
  type BriefWrite,
  type ProjectBrief,
} from "./brief.js";
import { pushSheet, sourceLabel } from "./catchupBrief.js";
import type { ServerContext } from "./context.js";
import { slugify, uniqueSlug, type ParsedArgs } from "./library.js";
import { allLines, linesOf } from "./memoryLines.js";
import { layerCandidates } from "./sweep.js";

/**
 * A project's architecture, kept true by the sessions that work in it.
 *
 * The small model folds finished turns into the sheets, but it only ever
 * sees what the replies said — never the code — and a sheet it folds is
 * a guess from outside. The session that did the work knows: it added the
 * file, moved the responsibility, hit the trap. So a session may put right
 * whatever its work changed in the index (`ruri architecture …`) or in a
 * layer's sheet (`ruri layer <slug> …`) — everything the page shows and
 * every session reads.
 *
 * Only what it has read, though, and only as it stands. A session reads a
 * sheet with its lines numbered (`ruri architecture`, `ruri layer <slug>`,
 * or the file itself), and from then on in that chat it may edit it by
 * those numbers — until someone else changes it (the user on the page,
 * another chat, a fold), when it has to read it again, so an edit never
 * lands on a line the session hasn't seen. What it read before a compact
 * or a fresh session doesn't count: that session no longer has it.
 *
 * What a chat edited is remembered for a while too, so the fold of its
 * turn leaves those sheets to it (server/events.ts).
 */

export interface SheetAnswer {
  ok: boolean;
  text: string;
}

const yes = (text: string): SheetAnswer => ({ ok: true, text });
const no = (text: string): SheetAnswer => ({ ok: false, text });

/* ── what a chat has read, and edited ──────────────────────────────── */

/** The index, or one layer's sheet, as the reads and edits name them. */
const INDEX = "index";
const layerKey = (slug: string) => `layer:${slug}`;

/** Per chat: each sheet it has read, and when. */
const reads = new Map<string, Map<string, number>>();
/** Per chat: the sheets it edited, and when — kept an hour, for the folds. */
const edits = new Map<string, Array<{ key: string; at: number }>>();
const EDITS_KEPT_MS = 60 * 60_000;

export function noteRead(channelId: string, key: string, at = Date.now()): void {
  const mine = reads.get(channelId) ?? new Map<string, number>();
  mine.set(key, at);
  reads.set(channelId, mine);
}

/** A chat's session no longer holds what it read: a compact, or a fresh
 *  session on another harness. */
export function forgetReads(channelId: string): void {
  reads.delete(channelId);
}

function noteEdit(channelId: string, key: string, at: number): void {
  const now = Date.now();
  const mine = (edits.get(channelId) ?? []).filter((e) => now - e.at < EDITS_KEPT_MS);
  mine.push({ key, at });
  edits.set(channelId, mine);
  noteRead(channelId, key, at);
}

/** What a chat edited since `since`: the index, and layers by slug. */
export function editedSince(channelId: string, since: number): { index: boolean; layers: Set<string> } {
  const mine = (edits.get(channelId) ?? []).filter((e) => e.at >= since);
  return {
    index: mine.some((e) => e.key === INDEX),
    layers: new Set(mine.flatMap((e) => (e.key.startsWith("layer:") ? [e.key.slice(6)] : []))),
  };
}

/** Tools that read a file whole, in the harnesses' spellings. */
const READ_TOOL = /^(read|view|read_file|readfile|read_text_file|open)$/i;
const SHELL_TOOL = /^(bash|shell|exec|exec_command|run_shell_command|command)$/i;

/**
 * A sheet read with the session's own tools — its file opened, or `cat`
 * of it in the shell — counts as read, the same as the command.
 */
export function noteToolRead(channelId: string, event: TranscriptEvent): void {
  if (event.kind !== "tool" || event.diff) return;
  const shellCat = SHELL_TOOL.test(event.name) && /^\s*cat\s/.test(event.summary);
  if (!READ_TOOL.test(event.name) && !shellCat) return;
  if (event.summary.includes(".ruri/architecture.md")) noteRead(channelId, INDEX);
  for (const match of event.summary.matchAll(/\.ruri\/layers\/([a-z0-9-]+)\.md/g)) {
    noteRead(channelId, layerKey(match[1]!));
  }
}

/* ── who changed it ────────────────────────────────────────────────── */

function ago(ts: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** Who a stamp says wrote a sheet, as a sentence's end. */
function whoWrote(ctx: ServerContext, stamp: SheetStamp | undefined, channelId?: string): string {
  if (!stamp) return "";
  const who =
    stamp.by === "repo"
      ? "from a read of the repo"
      : stamp.by === "model"
        ? "by the small model, from finished turns"
        : stamp.by === "user"
          ? "by the user, on the page"
          : stamp.chat === channelId
            ? "by you, in this chat"
            : `by the "${(stamp.chat && ctx.store.findSession(stamp.chat)?.session.title) || "untitled"}" chat`;
  return `${ago(stamp.at)}, ${who}`;
}

/**
 * Why this chat may not edit a sheet now — undefined when it may: it read
 * it in this session, and nobody else has changed it since.
 */
function mayNotEdit(
  ctx: ServerContext,
  channelId: string,
  key: string,
  changed: { at: number; stamp?: SheetStamp },
  read: string,
): string | undefined {
  const at = reads.get(channelId)?.get(key);
  const what = key === INDEX ? "the architecture index" : `the ${key.slice(6)} sheet`;
  if (at === undefined) {
    return `you haven't read ${what} in this chat's session — \`${read}\` prints it with every line numbered; edit it once you have read it`;
  }
  if (changed.at > at && changed.stamp?.chat !== channelId) {
    return `${what} has changed since you read it (${whoWrote(ctx, changed.stamp, channelId) || ago(changed.at)}) — \`${read}\` again, and edit it as it stands then`;
  }
  return undefined;
}

/* ── lines, and the parts they come in ─────────────────────────────── */

function flowLine(flow: SystemFlow): string {
  return `${flow.name}: ${flow.steps.join(" → ")}`;
}

function parseFlow(text: string): SystemFlow | string {
  const at = text.indexOf(":");
  const name = at > 0 ? text.slice(0, at).trim() : "";
  const steps = (at > 0 ? text.slice(at + 1) : "")
    .split(/\s*(?:→|->)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!name || steps.length < 2) return 'a flow reads "Name: part → part → part", two parts at least';
  return { name, steps };
}

/** "key — value", as the pair lines have it. */
function pair(text: string): [string, string] | undefined {
  const at = text.indexOf(" — ") > 0 ? text.indexOf(" — ") : text.indexOf(" - ");
  if (at <= 0) return undefined;
  const key = text.slice(0, at).trim();
  const value = text.slice(at + 3).trim();
  return key && value ? [key, value] : undefined;
}

/** A project-relative path as it is on disk: a folder ends in "/".
 *  Undefined when there is nothing there. */
function onDisk(projectDir: string, rel: string): string | undefined {
  const clean = rel.trim().replace(/^\.\//, "").replace(/:\d+$/, "");
  if (!clean || path.isAbsolute(clean) || clean.startsWith("..")) return undefined;
  try {
    const stat = fs.statSync(path.join(projectDir, clean));
    return stat.isDirectory() ? `${clean.replace(/\/+$/, "")}/` : clean;
  } catch {
    return undefined;
  }
}

/** One list section of a sheet: what it is called, how a line reads, how
 *  many it keeps, and how a line is checked. */
interface ListSection {
  title: string;
  format?: string;
  max: number;
  /** The line as it will be kept, or why it can't be. */
  check(text: string, projectDir: string): string | { error: string };
}

const free = (text: string) => text.trim();

function checkPairLine(format: string) {
  return (text: string) => (pair(text) ? text.trim() : { error: `a line here reads ${format}` });
}

function checkFileLine(text: string, projectDir: string): string | { error: string } {
  const parts = pair(text);
  if (!parts) return { error: 'a key file reads "path — its job"' };
  const file = onDisk(projectDir, parts[0]);
  return file ? `${file} — ${parts[1]}` : { error: `there is no ${parts[0]} in the project` };
}

function checkMapLine(text: string, projectDir: string): string | { error: string } {
  const place = parseMapLine(text);
  if (!place) return { error: 'a map line reads "what a person calls it — file, file"' };
  const missing = place.files.filter((file) => !onDisk(projectDir, file));
  if (missing.length) return { error: `there is no ${missing.join(", ")} in the project` };
  return mapLine(place);
}

function checkFlowLine(text: string): string | { error: string } {
  const flow = parseFlow(text);
  return typeof flow === "string" ? { error: flow } : flowLine(flow);
}

/** A layer's lists, with the caps the folds keep them to. */
const LAYER_LISTS: Record<Exclude<LayerEditSection, "summary" | "owns">, ListSection> = {
  map: {
    title: "where to change what",
    format: '"what a person calls it — file, file"',
    max: 12,
    check: checkMapLine,
  },
  flows: { title: "how it works", format: '"Name: part → part → part"', max: 3, check: checkFlowLine },
  files: { title: "key files", format: '"path — its job"', max: 10, check: checkFileLine },
  rules: { title: "rules and traps", max: 6, check: free },
  edges: {
    title: "what it talks to",
    format: '"layer — how"',
    max: 5,
    check: checkPairLine('"layer — how"'),
  },
};

const INDEX_LISTS: Record<Exclude<IndexEditSection, "description">, ListSection> = {
  stack: {
    title: "the stack, top to bottom",
    format: '"Name — what it does"',
    max: 24,
    check: checkPairLine('"Name — what it does"'),
  },
  flows: {
    title: "how it flows, across the layers",
    format: '"Name: part → part → part"',
    max: 5,
    check: checkFlowLine,
  },
  where: {
    title: "where things are",
    format: '"path — what it is for"',
    max: 16,
    check: checkPairLine('"path — what it is for"'),
  },
  run: { title: "how to run it", max: 16, check: free },
  conventions: { title: "conventions", max: 16, check: free },
  features: { title: "what it does", max: 16, check: free },
};

/** A layer sheet's list as lines. */
function layerLines(sheet: LayerSheet, section: keyof typeof LAYER_LISTS): string[] {
  if (section === "map") return sheet.map.map(mapLine);
  if (section === "flows") return sheet.flows.map(flowLine);
  return sheet[section];
}

/** Lines back into a layer sheet's list. */
function withLayerLines(sheet: LayerSheet, section: keyof typeof LAYER_LISTS, lines: string[]): LayerSheet {
  if (section === "map") return { ...sheet, map: lines.flatMap((l) => parseMapLine(l) ?? []) };
  if (section === "flows") {
    return {
      ...sheet,
      flows: lines.flatMap((l) => (typeof parseFlow(l) === "string" ? [] : [parseFlow(l) as SystemFlow])),
    };
  }
  return { ...sheet, [section]: lines };
}

function indexLines(brief: ProjectBrief, section: keyof typeof INDEX_LISTS): string[] {
  switch (section) {
    case "stack":
      return (brief.layers ?? []).map((l) => `${l.name} — ${l.what}`);
    case "flows":
      return (brief.flows ?? []).map(flowLine);
    case "where":
      return brief.layout ?? [];
    case "run":
      return brief.run ?? [];
    case "conventions":
      return brief.conventions ?? [];
    case "features":
      return brief.features;
  }
}

/** A numbered list, as the commands print it. */
function numbered(lines: string[]): string[] {
  return lines.length ? lines.map((line, i) => `  ${i + 1}. ${line}`) : ["  (none yet)"];
}

/* ── an edit, as the words ask for it ──────────────────────────────── */

type Edit =
  | { verb: "add"; section: string; text: string }
  | { verb: "set"; section: string; n?: number; text: string }
  | { verb: "drop"; section: string; n: number }
  | { verb: "own"; paths: string[] }
  | { verb: "disown"; paths: string[] };

const VERBS = new Set(["add", "set", "drop", "own", "disown"]);

/** The edit `words` ask for (they start at the verb), or what's wrong. */
function parseEdit(words: string[], single: string): Edit | string {
  const verb = (words[0] ?? "").toLowerCase();
  if (verb === "own" || verb === "disown") {
    const paths = words
      .slice(1)
      .flatMap((w) => w.split(","))
      .map((w) => w.trim())
      .filter(Boolean);
    return paths.length ? { verb, paths } : `${verb} <path>… — which files or folders?`;
  }
  const section = (words[1] ?? "").toLowerCase();
  if (!section) return `${verb} <section> … — which section?`;
  if (verb === "add") {
    const text = words.slice(2).join(" ").trim();
    return text ? { verb, section, text } : `add ${section} "<line>" — what line?`;
  }
  if (verb === "set" && section === single) {
    const text = words.slice(2).join(" ").trim();
    return text ? { verb, section, text } : `set ${section} "<text>" — what should it say?`;
  }
  const n = Number(words[2]);
  if (!Number.isInteger(n) || n < 1) return `${verb} ${section} <n> — n is the line's number as printed`;
  if (verb === "drop") return { verb, section, n };
  const text = words.slice(3).join(" ").trim();
  return text ? { verb: "set", section, n, text } : `set ${section} ${n} "<line>" — what should it say?`;
}

/** A list with one edit made, or what's wrong with it. */
function editList(
  lines: string[],
  edit: Extract<Edit, { section: string }>,
  spec: ListSection,
  projectDir: string,
): string[] | string {
  if (edit.verb === "drop") {
    if (edit.n > lines.length) return `there is no line ${edit.n} — ${lines.length} in all`;
    return lines.filter((_, i) => i !== edit.n - 1);
  }
  const checked = spec.check(edit.text, projectDir);
  if (typeof checked !== "string") return checked.error;
  if (edit.verb === "add") {
    if (lines.length >= spec.max) {
      return `${spec.title} is full at ${spec.max} — merge into a line, or drop one that no longer holds, first (sheets stay short so they get read)`;
    }
    return [...lines, checked];
  }
  if (edit.n === undefined || edit.n > lines.length)
    return `there is no line ${edit.n} — ${lines.length} in all`;
  return lines.map((line, i) => (i === edit.n! - 1 ? checked : line));
}

/* ── git's word on a layer ─────────────────────────────────────────── */

/** The last commits that touched a layer's files: day, commit, subject. */
function layerLog(projectDir: string, paths: string[], n = 8): Promise<string[]> {
  if (!paths.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["log", "--no-merges", `-n${n}`, "--format=%ad %h %s", "--date=format:%m-%d", "--", ...paths],
      { cwd: projectDir, timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : stdout.split("\n").filter(Boolean)),
    );
  });
}

/* ── the index ─────────────────────────────────────────────────────── */

type Project = { id: string; name: string; path: string };

/** The index as a session reads it to edit: every line numbered, each
 *  section by the name an edit takes. */
async function indexText(ctx: ServerContext, channelId: string, project: Project): Promise<string> {
  const brief = ctx.briefs.get(project.id);
  const out = [
    `${project.name} — its architecture index (.ruri/architecture.md), every line numbered. You have read it now, so in this chat you can put right what your work changes in it:`,
    `  ruri architecture add <section> "<line>"  ·  set <section> <n> "<line>"  ·  drop <section> <n>  ·  set description "<text>"`,
  ];
  const last = whoWrote(ctx, brief.stamp, channelId);
  if (last) out.push(`Last changed ${last}.`);
  out.push("", "description:", `  ${brief.description || "(none yet)"}`);
  for (const [section, spec] of Object.entries(INDEX_LISTS) as Array<
    [keyof typeof INDEX_LISTS, ListSection]
  >) {
    out.push("", `${section} — ${spec.title}${spec.format ? `, ${spec.format}` : ""}:`);
    if (section === "stack") {
      const layers = brief.layers ?? [];
      out.push(
        ...(layers.length
          ? layers.map(
              (l, i) =>
                `  ${i + 1}. ${l.name} — ${l.what}   [${l.slug ?? slugify(l.name)}${l.paths?.length ? ` · owns ${ownsSummary(l.paths)}` : ""}]`,
            )
          : ["  (none yet)"]),
      );
      if (layers.length) out.push("  Each layer's own sheet, and the files it owns: ruri layer <handle>.");
    } else out.push(...numbered(indexLines(brief, section)));
  }
  const unowned = brief.layers?.length
    ? (await layerCandidates(project.path).catch(() => [] as string[])).filter(
        (file) => !layerOfFile(brief.layers!, file),
      )
    : [];
  if (unowned.length) {
    out.push(
      "",
      `Files no layer owns (${unowned.length}) — no sheet speaks for them, and no turn that changes them folds into one. \`ruri layer <handle> own <path>…\` gives them a home (a folder takes everything under it):`,
      `  ${unowned.slice(0, 20).join(", ")}${unowned.length > 20 ? `, and ${unowned.length - 20} more` : ""}`,
    );
  }
  return out.join("\n");
}

/** The index with one edit made, in the words the answer gives back. */
function editIndex(ctx: ServerContext, channelId: string, project: Project, edit: Edit): SheetAnswer {
  const brief = ctx.briefs.get(project.id);
  if (edit.verb === "own" || edit.verb === "disown") {
    return no(`files are owned by a layer — \`ruri layer <handle> ${edit.verb} <path>…\``);
  }
  const section = edit.section as IndexEditSection;
  const base: BriefWrite = { description: brief.description, features: brief.features };
  const stamp = { by: "agent" as const, chat: channelId };
  if (section === "description") {
    if (edit.verb !== "set")
      return no('the description is one piece — `ruri architecture set description "<text>"`');
    const written = ctx.briefs.write(project.id, { ...base, description: edit.text }, false, stamp);
    return done(
      ctx,
      channelId,
      project.id,
      INDEX,
      written.stamp!.at,
      `description now reads:\n  ${edit.text}`,
    );
  }
  const spec = INDEX_LISTS[section as keyof typeof INDEX_LISTS];
  if (!spec) {
    return no(
      `no section "${edit.section}" in the index — it has description, ${Object.keys(INDEX_LISTS).join(", ")}`,
    );
  }
  if (section === "stack") return editStack(ctx, channelId, project, brief, edit, spec);
  const lines = editList(indexLines(brief, section as keyof typeof INDEX_LISTS), edit, spec, project.path);
  if (typeof lines === "string") return no(lines);
  const next: BriefWrite = { ...base };
  if (section === "flows") next.flows = lines.map((l) => parseFlow(l) as SystemFlow);
  else if (section === "where") next.layout = lines;
  else if (section === "run") next.run = lines;
  else if (section === "conventions") next.conventions = lines;
  else if (section === "features") next.features = lines;
  const written = ctx.briefs.write(project.id, next, false, stamp);
  return done(
    ctx,
    channelId,
    project.id,
    INDEX,
    written.stamp!.at,
    `${section} now reads:\n${numbered(indexLines(written, section as keyof typeof INDEX_LISTS)).join("\n")}`,
  );
}

/** The stack itself: a layer added (with an empty sheet of its own),
 *  renamed or described anew (its handle and files stay), or taken out —
 *  only once it owns nothing. */
function editStack(
  ctx: ServerContext,
  channelId: string,
  project: Project,
  brief: ProjectBrief,
  edit: Extract<Edit, { section: string }>,
  spec: ListSection,
): SheetAnswer {
  const layers = brief.layers ?? [];
  const base: BriefWrite = { description: brief.description, features: brief.features };
  const stamp = { by: "agent" as const, chat: channelId };
  if (edit.verb === "drop") {
    const gone = layers[edit.n - 1];
    if (!gone) return no(`there is no layer ${edit.n} — ${layers.length} in all`);
    if (gone.paths?.length) {
      return no(
        `${gone.slug} still owns ${ownsSummary(gone.paths)} — give those to the layers they belong to first (\`ruri layer <handle> own <path>…\`), or \`ruri layer ${gone.slug} disown …\` them`,
      );
    }
    const written = ctx.briefs.write(
      project.id,
      { ...base, layers: layers.filter((l) => l !== gone) },
      false,
      stamp,
    );
    return done(
      ctx,
      channelId,
      project.id,
      INDEX,
      written.stamp!.at,
      `took ${gone.name} (${gone.slug}) out of the stack, and its sheet with it`,
    );
  }
  const checked = spec.check(edit.text, project.path);
  if (typeof checked !== "string") return no(checked.error);
  const [name, what] = pair(checked)!;
  if (edit.verb === "set") {
    const at = (edit.n ?? 0) - 1;
    if (!layers[at]) return no(`there is no layer ${edit.n} — ${layers.length} in all`);
    const next = layers.map((l, i) => (i === at ? { ...l, name, what } : l));
    const written = ctx.briefs.write(project.id, { ...base, layers: next }, false, stamp);
    return done(
      ctx,
      channelId,
      project.id,
      INDEX,
      written.stamp!.at,
      `layer ${edit.n} now reads: ${name} — ${what} [${layers[at]!.slug}]`,
    );
  }
  if (layers.length >= spec.max)
    return no(`the stack is full at ${spec.max} layers — fold a layer into another first`);
  const slug = uniqueSlug(
    slugify(name),
    layers.map((l) => l.slug ?? slugify(l.name)),
  );
  const written = ctx.briefs.write(
    project.id,
    { ...base, layers: [...layers, { name, what, slug }] },
    false,
    stamp,
  );
  const sheet: LayerSheet = { summary: what, map: [], flows: [], files: [], rules: [], edges: [] };
  ctx.briefs.writeLayer(project.id, slug, sheet, stamp);
  noteEdit(channelId, layerKey(slug), Date.now());
  return done(
    ctx,
    channelId,
    project.id,
    INDEX,
    written.stamp!.at,
    `added ${name} to the bottom of the stack as ${slug}, with an empty sheet. Give it its files — \`ruri layer ${slug} own <path>…\` — and fill its sheet: \`ruri layer ${slug} add map|files|rules|edges|flows "<line>"\`.`,
  );
}

/** An edit made: noted as this chat's, the files written, and the answer. */
function done(
  ctx: ServerContext,
  channelId: string,
  projectId: string,
  key: string,
  at: number,
  text: string,
): SheetAnswer {
  noteEdit(channelId, key, at);
  pushSheet(ctx, projectId);
  return yes(text);
}

/**
 * `ruri architecture` — the index, numbered, which is what lets this chat
 * edit it; `ruri architecture add|set|drop <section> …` edits it.
 */
export async function runIndexCommand(
  ctx: ServerContext,
  channelId: string,
  project: Project,
  args: ParsedArgs,
): Promise<SheetAnswer> {
  const brief = ctx.briefs.get(project.id);
  if (!brief.description && !brief.features.length && !brief.layers?.length) {
    return yes(
      `${project.name} has no architecture on file yet — the user can have it read from the repo on the architecture page`,
    );
  }
  const words = args.words.slice(1);
  if (!words.length) {
    const text = await indexText(ctx, channelId, project);
    noteRead(channelId, INDEX);
    return yes(text);
  }
  if (!VERBS.has(words[0]!.toLowerCase())) {
    return no(
      `ruri architecture ${words[0]} — the index prints with \`ruri architecture\`, and edits take add, set or drop`,
    );
  }
  const edit = parseEdit(words, "description");
  if (typeof edit === "string") return no(`ruri architecture ${edit}`);
  const refused = mayNotEdit(
    ctx,
    channelId,
    INDEX,
    { at: brief.stamp?.at ?? 0, ...(brief.stamp ? { stamp: brief.stamp } : {}) },
    "ruri architecture",
  );
  if (refused) return no(refused);
  return editIndex(ctx, channelId, project, edit);
}

/* ── one layer ─────────────────────────────────────────────────────── */

const PART_LABEL: Record<MemoryPart, string> = {
  now: "now",
  decisions: "decision",
  worked: "worked",
  failed: "didn't work",
  gotchas: "trap",
  open: "still open",
};

/** When a layer's sheet last changed, and who changed it. */
function layerChanged(sheet: LayerSheet): { at: number; stamp?: SheetStamp } {
  return { at: sheet.stamp?.at ?? sheet.updated ?? 0, ...(sheet.stamp ? { stamp: sheet.stamp } : {}) };
}

/** A layer's sheet as a session reads it to edit — every line numbered,
 *  what git says changed in it lately, and what the sessions that worked
 *  there learned. */
async function layerSheetText(
  ctx: ServerContext,
  channelId: string,
  project: Project,
  layer: StackLayer,
  sheet: LayerSheet,
): Promise<string> {
  const slug = layer.slug!;
  const brief = ctx.briefs.get(project.id);
  const out = [
    `${project.name} — ${layer.name} (${slug}): its sheet, every line numbered. You have read it now, so in this chat you can put right what your work changes in it:`,
    `  ruri layer ${slug} add <section> "<line>"  ·  set <section> <n> "<line>"  ·  drop <section> <n>  ·  set summary "<text>"`,
    `  ruri layer ${slug} own <path>…  ·  disown <path>…   (a folder owns everything under it; the longest owning path wins)`,
  ];
  // a sheet from before stamps says only when
  const last = whoWrote(ctx, sheet.stamp, channelId) || (sheet.updated ? ago(sheet.updated) : "");
  if (last) out.push(`Last changed ${last}.`);
  out.push("", `owns: ${layer.paths?.length ? layer.paths.join(", ") : "nothing yet"}`);
  out.push("", "summary:", `  ${sheet.summary || layer.what || "(none yet)"}`);
  for (const [section, spec] of Object.entries(LAYER_LISTS) as Array<
    [keyof typeof LAYER_LISTS, ListSection]
  >) {
    out.push(
      "",
      `${section} — ${spec.title}${spec.format ? `, ${spec.format}` : ""}:`,
      ...numbered(layerLines(sheet, section)),
    );
  }
  const log = await layerLog(project.path, layer.paths ?? []);
  if (log.length) out.push("", "Lately in this layer, from git:", ...log.map((l) => `  ${l}`));
  const notes = allLines(linesOf(brief.memory, slug));
  if (notes.length) {
    out.push(
      "",
      "From the sessions that worked here (`ruri forget <id>` takes out one that no longer holds):",
    );
    for (const { part, line } of notes) {
      const ref = line.source ? sourceLabel(ctx, line.source)?.ref : undefined;
      out.push(
        `  ${line.id}  ${PART_LABEL[part]}: ${memoryLineText(line, ref ? { refs: { [line.id]: ref } } : {})}`,
      );
    }
  }
  out.push(
    "",
    `What you learn working here that the next session will need: \`ruri note <kind> "<what>" --why "<why>" --layer ${slug}\`. The sheet alone is at ${layerFile(slug)}.`,
  );
  return out.join("\n");
}

/** A layer's owned paths changed: `own` takes them (from whichever layer
 *  had them exactly), `disown` lets them go. */
function editOwns(
  ctx: ServerContext,
  channelId: string,
  project: Project,
  layer: StackLayer,
  edit: Extract<Edit, { paths: string[] }>,
): SheetAnswer {
  const brief = ctx.briefs.get(project.id);
  const layers = brief.layers ?? [];
  const slug = layer.slug!;
  if (edit.verb === "disown") {
    const wanted = new Set(edit.paths.map((p) => p.replace(/^\.\//, "")));
    const kept = (layer.paths ?? []).filter((p) => !wanted.has(p) && !wanted.has(p.replace(/\/$/, "")));
    if (kept.length === (layer.paths ?? []).length)
      return no(
        `${slug} owns none of ${edit.paths.join(", ")} by that name — \`ruri layer ${slug}\` lists what it owns`,
      );
    return writeOwns(
      ctx,
      channelId,
      project,
      brief,
      layers.map((l) => (l === layer ? { ...l, paths: kept } : l)),
      slug,
      [],
    );
  }
  const paths: string[] = [];
  for (const raw of edit.paths) {
    const found = onDisk(project.path, raw);
    if (!found) return no(`there is no ${raw} in the project`);
    paths.push(found);
  }
  // a path another layer owns by exactly that name moves here — which edits
  // that layer too, so its sheet must have been read as well
  const from = layers.filter((l) => l !== layer && l.paths?.some((p) => paths.includes(p)));
  for (const other of from) {
    const refused = mayNotEdit(
      ctx,
      channelId,
      layerKey(other.slug!),
      layerChanged(
        brief.layerSheets?.[other.slug!] ?? {
          summary: "",
          map: [],
          flows: [],
          files: [],
          rules: [],
          edges: [],
        },
      ),
      `ruri layer ${other.slug}`,
    );
    if (refused)
      return no(
        `${paths.filter((p) => other.paths!.includes(p)).join(", ")} is ${other.slug}'s now, so taking it edits that layer too: ${refused}`,
      );
  }
  const next = layers.map((l) => {
    if (l === layer) return { ...l, paths: [...(l.paths ?? []).filter((p) => !paths.includes(p)), ...paths] };
    return from.includes(l) ? { ...l, paths: l.paths!.filter((p) => !paths.includes(p)) } : l;
  });
  return writeOwns(
    ctx,
    channelId,
    project,
    brief,
    next,
    slug,
    from.map((l) => l.slug!),
  );
}

function writeOwns(
  ctx: ServerContext,
  channelId: string,
  project: Project,
  brief: ProjectBrief,
  layers: StackLayer[],
  slug: string,
  alsoEdited: string[],
): SheetAnswer {
  const stamp = { by: "agent" as const, chat: channelId };
  const written = ctx.briefs.write(
    project.id,
    { description: brief.description, features: brief.features, layers },
    false,
    stamp,
  );
  // the sheets say what their layers own at the top, so they changed too
  for (const each of [slug, ...alsoEdited]) {
    const sheet = written.layerSheets?.[each];
    if (sheet) ctx.briefs.writeLayer(project.id, each, sheet, stamp);
    noteEdit(channelId, layerKey(each), Date.now());
  }
  noteEdit(channelId, INDEX, Date.now());
  pushSheet(ctx, project.id);
  const owns = written.layers?.find((l) => l.slug === slug)?.paths ?? [];
  return yes(
    `${slug} now owns: ${owns.length ? owns.join(", ") : "nothing"}${alsoEdited.length ? ` (taken from ${alsoEdited.join(", ")})` : ""}`,
  );
}

/**
 * `ruri layer <slug>` — one layer's sheet, numbered, with git's word on it
 * and the sessions' notes; reading it this way is what lets this chat edit
 * it. `ruri layer <slug> add|set|drop <section> …` and `own|disown <path>…`
 * edit it. `layer` is the one the words named.
 */
export async function runLayerCommand(
  ctx: ServerContext,
  channelId: string,
  project: Project,
  layer: StackLayer,
  words: string[],
): Promise<SheetAnswer> {
  const brief = ctx.briefs.get(project.id);
  const slug = layer.slug ?? slugify(layer.name);
  const sheet = brief.layerSheets?.[slug];
  if (!sheet) {
    return yes(
      `${layer.name} has no sheet of its own${layer.paths?.length ? ` — it owns ${layer.paths.join(", ")}` : " — it has no code of its own"}.${layer.what ? ` ${layer.what}.` : ""}`,
    );
  }
  if (!words.length) {
    const text = await layerSheetText(ctx, channelId, project, { ...layer, slug }, sheet);
    noteRead(channelId, layerKey(slug));
    return yes(text);
  }
  const edit = parseEdit(words, "summary");
  if (typeof edit === "string") return no(`ruri layer ${slug} ${edit}`);
  const refused = mayNotEdit(ctx, channelId, layerKey(slug), layerChanged(sheet), `ruri layer ${slug}`);
  if (refused) return no(refused);
  if (edit.verb === "own" || edit.verb === "disown") return editOwns(ctx, channelId, project, layer, edit);
  const stamp = { by: "agent" as const, chat: channelId };
  const section = edit.section as LayerEditSection;
  if (section === "owns") {
    return no(`what ${slug} owns changes with \`ruri layer ${slug} own <path>…\` and \`disown <path>…\``);
  }
  if (section === "summary") {
    if (edit.verb !== "set")
      return no(`the summary is one piece — \`ruri layer ${slug} set summary "<text>"\``);
    const written = ctx.briefs.writeLayer(project.id, slug, { ...sheet, summary: edit.text }, stamp);
    return done(
      ctx,
      channelId,
      project.id,
      layerKey(slug),
      written.layerSheets![slug]!.stamp!.at,
      `summary now reads:\n  ${edit.text}`,
    );
  }
  const spec = LAYER_LISTS[section as keyof typeof LAYER_LISTS];
  if (!spec) {
    return no(
      `no section "${edit.section}" in a layer's sheet — it has summary, ${Object.keys(LAYER_LISTS).join(", ")}, and what it owns (own/disown)`,
    );
  }
  const key = section as keyof typeof LAYER_LISTS;
  const lines = editList(layerLines(sheet, key), edit, spec, project.path);
  if (typeof lines === "string") return no(lines);
  const written = ctx.briefs.writeLayer(project.id, slug, withLayerLines(sheet, key, lines), stamp);
  const now = written.layerSheets![slug]!;
  return done(
    ctx,
    channelId,
    project.id,
    layerKey(slug),
    now.stamp!.at,
    `${section} now reads:\n${numbered(layerLines(now, key)).join("\n")}`,
  );
}

/** Whether the words after a layer's handle ask for an edit. */
export function isEdit(word: string | undefined): boolean {
  return !!word && VERBS.has(word.toLowerCase());
}
