import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "./configDir.js";
import { removeRuriFile, ruriDir } from "./ruriDir.js";
import { storedFilePath } from "./uploads.js";
import type {
  Attachment,
  ConceptPlace,
  LayerSection,
  LayerSheet,
  MemoryLine,
  ProjectMemory,
  ProjectSheet,
  SheetSection,
  StackLayer,
  SystemFlow,
} from "../shared/protocol.js";
import { ownsSummary } from "../shared/protocol.js";
import { slugify, uniqueSlug } from "./library.js";
import { isMissing, warn } from "./log.js";
import { lineText, memoryEmpty, readMemory } from "./memoryLines.js";

/**
 * What ruri knows about a project as a whole, for the model that has never
 * seen it — a fresh session, a harness you just switched to, an agent
 * joining halfway. Handing it the transcript would cost thousands of tokens
 * and bury what matters; this is two short files it reads in seconds.
 *
 * Two, because a project is two different things to someone joining it:
 *
 *  - its SHAPE — `.ruri/architecture.md`: where to change what (concepts
 *    and the files they live in — the map a session with a task in hand
 *    needs first), the stack as layers from what a person touches down to
 *    the engines under it, the paths through it that matter, where things
 *    are, how to run it, the rules it lives by, what it can do. Written
 *    from a read of the repo (server/catchup.ts), which it says the commit
 *    of, and folded forward from finished turns and the files they changed.
 *  - where the WORK stands — `.ruri/catchup.md`: git's own account first
 *    (server/gitState.ts), then what was decided and why, what worked, what
 *    was tried and failed and why, the traps, and what is still open. The
 *    part nobody can read off the code, and the part a new session most
 *    needs not to relearn. Every line says when it was learned, the
 *    exchange it came from (a ref `ruri recall show` prints), and who wrote
 *    it: the small model gathering from the chats as turns finish, the
 *    agent that did the work (`ruri note`), or the user on the page
 *    (server/memoryLines.ts says who may change what).
 *
 * Neither is a changelog. The small model merges what belongs together and
 * drops what stopped mattering, so both stay a screen long however long
 * the project runs.
 *
 * The shape is itself two levels, so that it stays a screen long however
 * big the project gets. `architecture.md` is the index — the stack, top to
 * bottom, one line a layer, which every session is also shown before it
 * starts (server/briefing.ts) — and each layer with code of its own has a
 * sheet behind it, `.ruri/layers/<slug>.md`: where to change what inside
 * it, how work moves through it, its key files, its traps, what it talks
 * to. A session reads the sheet of the layer it is about to work in and
 * none of the others. A project grows by gaining layers, not by any one
 * sheet growing, and a turn only folds into the sheets of the layers whose
 * files it changed (server/events.ts).
 *
 * They are written into each project, and the session is told the files
 * are there; nothing costs context until something reads them. The
 * architecture page shows the user the same thing, and is where they
 * correct it.
 */

/** A project's sheet, server-side: the same thing the page shows. */
export type ProjectBrief = ProjectSheet;

/** The keys a write of the shape may set; anything else stays. */
export type BriefWrite = Pick<ProjectBrief, "description" | "features"> &
  Partial<
    Pick<
      ProjectBrief,
      "layers" | "flows" | "run" | "layout" | "conventions" | "map" | "layerSheets" | "builtAt"
    >
  >;

function briefsFile(): string {
  return configPath("briefs.json");
}

const EMPTY: ProjectBrief = { description: "", features: [], shots: [] };

/** An older file's lists and layers, whatever shape they arrive in. */
function list(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((l): l is string => typeof l === "string") : undefined;
}

function layersOf(value: unknown): StackLayer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((raw): StackLayer[] => {
    if (!raw || typeof raw !== "object") return [];
    const layer = raw as Partial<StackLayer>;
    if (typeof layer.name !== "string") return [];
    const paths = list(layer.paths);
    return [
      {
        name: layer.name,
        what: typeof layer.what === "string" ? layer.what : "",
        ...(typeof layer.where === "string" && layer.where ? { where: layer.where } : {}),
        ...(typeof layer.slug === "string" && layer.slug ? { slug: layer.slug } : {}),
        ...(paths?.length ? { paths } : {}),
      },
    ];
  });
}

/**
 * Every layer with a handle of its own, unique in the stack. A layer the
 * model renamed keeps the handle it had (matched by name, then by what it
 * owns), so its sheet stays its sheet.
 */
export function slugLayers(layers: StackLayer[], before: StackLayer[] = []): StackLayer[] {
  const taken: string[] = [];
  return layers.map((layer) => {
    const same =
      before.find((b) => b.name.toLowerCase() === layer.name.toLowerCase()) ??
      before.find(
        (b) => b.paths?.length && layer.paths?.length && b.paths.join("|") === layer.paths.join("|"),
      );
    const paths = layer.paths?.length ? layer.paths : same?.paths;
    const slug = uniqueSlug(slugify(layer.slug || same?.slug || layer.name), taken);
    taken.push(slug);
    return { ...layer, slug, ...(paths?.length ? { paths } : {}) };
  });
}

/** A layer's own folders and files, as prefixes: "web/src/" owns what is
 *  under it, "server/bridge.ts" owns that file. */
function owns(prefix: string, file: string): boolean {
  const clean = prefix.replace(/^\.\//, "").replace(/\*+$/, "");
  if (!clean || clean === "/" || clean === ".") return false;
  return clean.endsWith("/") ? file.startsWith(clean) : file === clean || file.startsWith(`${clean}/`);
}

/** The layer a repo-relative file belongs to: the one owning it by the
 *  longest path, so "server/bridge.ts" beats "server/". */
export function layerOfFile(layers: StackLayer[], file: string): StackLayer | undefined {
  let best: StackLayer | undefined;
  let length = 0;
  for (const layer of layers) {
    for (const prefix of layer.paths ?? []) {
      if (owns(prefix, file) && prefix.length > length) {
        best = layer;
        length = prefix.length;
      }
    }
  }
  return best;
}

function layerSheetOf(value: unknown): LayerSheet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<LayerSheet>;
  return {
    summary: typeof raw.summary === "string" ? raw.summary : "",
    map: mapOf(raw.map) ?? [],
    flows: flowsOf(raw.flows) ?? [],
    files: list(raw.files) ?? [],
    rules: list(raw.rules) ?? [],
    edges: list(raw.edges) ?? [],
    ...(typeof raw.updated === "number" ? { updated: raw.updated } : {}),
  };
}

function layerSheetsOf(value: unknown): Record<string, LayerSheet> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, LayerSheet> = {};
  for (const [slug, raw] of Object.entries(value as Record<string, unknown>)) {
    const sheet = layerSheetOf(raw);
    if (sheet) out[slug] = sheet;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Whether a project's shape is layered: its stack has sheets behind it. */
export function layered(brief: ProjectBrief): boolean {
  return Object.keys(brief.layerSheets ?? {}).length > 0;
}

function flowsOf(value: unknown): SystemFlow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (f): f is SystemFlow =>
      !!f &&
      typeof f === "object" &&
      typeof (f as SystemFlow).name === "string" &&
      Array.isArray((f as SystemFlow).steps),
  );
}

export function mapOf(value: unknown): ConceptPlace[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((raw): ConceptPlace[] => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Partial<ConceptPlace>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const files =
      list(entry.files)
        ?.map((f) => f.trim())
        .filter(Boolean) ?? [];
    return name && files.length ? [{ name, files }] : [];
  });
}

/** A map line as the page edits it: "name — a, b". */
export function mapLine(place: ConceptPlace): string {
  return `${place.name} — ${place.files.join(", ")}`;
}

function parseMapLine(line: string): ConceptPlace | undefined {
  const at = line.indexOf(" — ") > 0 ? line.indexOf(" — ") : line.indexOf(" - ");
  if (at <= 0) return undefined;
  const name = line.slice(0, at).trim();
  const files = line
    .slice(at + 3)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  return name && files.length ? { name, files } : undefined;
}

export class BriefStore {
  private readonly briefs = new Map<string, ProjectBrief>();

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(briefsFile(), "utf8")) as Record<string, ProjectBrief>;
      for (const [projectId, brief] of Object.entries(raw)) {
        if (!brief || typeof brief !== "object") continue;
        const layers = layersOf(brief.layers);
        const flows = flowsOf(brief.flows);
        const memory = readMemory(brief.memory);
        const map = mapOf(brief.map);
        const layerSheets = layerSheetsOf(brief.layerSheets);
        const number = (key: "updated" | "built" | "remembered" | "recalled") =>
          typeof brief[key] === "number" ? { [key]: brief[key] } : {};
        this.briefs.set(projectId, {
          description: typeof brief.description === "string" ? brief.description : "",
          features: list(brief.features) ?? [],
          ...(layers?.length ? { layers } : {}),
          ...(flows?.length ? { flows } : {}),
          ...(list(brief.stack) ? { stack: list(brief.stack) } : {}),
          ...(list(brief.run) ? { run: list(brief.run) } : {}),
          ...(list(brief.layout) ? { layout: list(brief.layout) } : {}),
          ...(list(brief.conventions) ? { conventions: list(brief.conventions) } : {}),
          ...(map?.length ? { map } : {}),
          ...(layerSheets ? { layerSheets } : {}),
          ...(memory ? { memory } : {}),
          ...(typeof brief.builtAt === "string" ? { builtAt: brief.builtAt } : {}),
          shots: Array.isArray(brief.shots) ? brief.shots : [],
          ...number("updated"),
          ...number("built"),
          ...number("remembered"),
          ...number("recalled"),
        });
      }
    } catch (err) {
      if (!isMissing(err)) warn("brief", err, "new BriefStore");
      // first run, or a file worth starting over from
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(briefsFile()), { recursive: true });
      fs.writeFileSync(briefsFile(), JSON.stringify(Object.fromEntries(this.briefs), null, 2));
    } catch (err) {
      warn("brief", err, "save");
      // best-effort persistence
    }
  }

  get(projectId: string): ProjectBrief {
    return this.briefs.get(projectId) ?? EMPTY;
  }

  /** Replace the shape; the memory and the pinned screenshots stay as they
   *  are. A fold sets what finished work can change; a whole build sets it
   *  all, stamps when the repo was read, and retires an older sheet's
   *  one-line stack for its layers. */
  write(projectId: string, next: BriefWrite, built = false): ProjectBrief {
    const { stack: _stack, ...kept } = this.get(projectId);
    const merged: ProjectBrief = {
      ...(built && next.layers?.length ? kept : this.get(projectId)),
      ...next,
      updated: Date.now(),
      ...(built ? { built: Date.now() } : {}),
    };
    // every layer has a handle, and a sheet goes when its layer does
    const layers = merged.layers?.length
      ? slugLayers(merged.layers, this.get(projectId).layers)
      : merged.layers;
    const slugs = new Set((layers ?? []).map((l) => l.slug));
    const sheets = Object.fromEntries(
      Object.entries(merged.layerSheets ?? {}).filter(([slug]) => slugs.has(slug)),
    );
    const { layerSheets: _sheets, ...rest } = merged;
    const brief: ProjectBrief = {
      ...rest,
      ...(layers ? { layers } : {}),
      ...(Object.keys(sheets).length ? { layerSheets: sheets } : {}),
    };
    this.briefs.set(projectId, brief);
    this.save();
    return brief;
  }

  /** One layer's sheet, written whole or folded forward. */
  writeLayer(projectId: string, slug: string, sheet: LayerSheet): ProjectBrief {
    const brief = this.get(projectId);
    if (!brief.layers?.some((l) => l.slug === slug)) return brief;
    const next: ProjectBrief = {
      ...brief,
      layerSheets: { ...brief.layerSheets, [slug]: { ...sheet, updated: Date.now() } },
      updated: Date.now(),
    };
    this.briefs.set(projectId, next);
    this.save();
    return next;
  }

  /**
   * The user's correction of one line of a layer's sheet: `text` in place
   * of the line at `index`, or the line struck; the summary is rewritten
   * whole. Null when there is no such line, or a map line doesn't read
   * "name — files".
   */
  correctLayer(
    projectId: string,
    slug: string,
    section: LayerSection | "summary",
    index: number,
    text?: string,
  ): ProjectBrief | null {
    const brief = this.get(projectId);
    const sheet = brief.layerSheets?.[slug];
    if (!sheet) return null;
    let next: LayerSheet;
    if (section === "summary") {
      next = { ...sheet, summary: (text ?? "").trim() };
    } else if (section === "map") {
      const map = [...sheet.map];
      if (index >= map.length) return null;
      if (text === undefined) map.splice(index, 1);
      else {
        const place = parseMapLine(text);
        if (!place) return null;
        map[index] = place;
      }
      next = { ...sheet, map };
    } else {
      const items = [...sheet[section]];
      if (index >= items.length) return null;
      if (text === undefined) items.splice(index, 1);
      else items[index] = text.trim();
      next = { ...sheet, [section]: items };
    }
    const out: ProjectBrief = { ...brief, layerSheets: { ...brief.layerSheets, [slug]: next } };
    this.briefs.set(projectId, out);
    this.save();
    return out;
  }

  /** Replace the working memory. `recalled`: it was written from the
   *  chats' histories whole, rather than folded forward from a turn. */
  remember(projectId: string, memory: ProjectMemory, recalled = false): ProjectBrief {
    const brief: ProjectBrief = {
      ...this.get(projectId),
      memory,
      remembered: Date.now(),
      ...(recalled ? { recalled: Date.now() } : {}),
    };
    this.briefs.set(projectId, brief);
    this.save();
    return brief;
  }

  /**
   * The user's correction of one line of the shape: `text` in place of the
   * line at `index`, or the line struck. Null when there is no such line,
   * or a map line doesn't read "name — files".
   */
  correct(projectId: string, section: SheetSection, index: number, text?: string): ProjectBrief | null {
    const brief = this.get(projectId);
    let next: ProjectBrief;
    if (section === "map") {
      const map = [...(brief.map ?? [])];
      if (index >= map.length) return null;
      if (text === undefined) map.splice(index, 1);
      else {
        const place = parseMapLine(text);
        if (!place) return null;
        map[index] = place;
      }
      next = { ...brief, map };
    } else {
      const lines = [...(brief[section] ?? [])];
      if (index >= lines.length) return null;
      if (text === undefined) lines.splice(index, 1);
      else lines[index] = text.trim();
      next = { ...brief, [section]: lines };
    }
    this.briefs.set(projectId, next);
    this.save();
    return next;
  }

  /** Whether a brief exists under this id at all. */
  has(projectId: string): boolean {
    return this.briefs.has(projectId);
  }

  /** Move a brief kept under one id to another (the per-session keys of
   *  older versions, gathered up under their project). */
  move(from: string, to: string): void {
    const brief = this.briefs.get(from);
    if (!brief) return;
    this.briefs.delete(from);
    const there = this.briefs.get(to);
    if (!there || (brief.updated ?? 0) > (there.updated ?? 0)) this.briefs.set(to, brief);
    this.save();
  }

  pin(projectId: string, shot: Attachment): ProjectBrief {
    const brief = this.get(projectId);
    const next: ProjectBrief = { ...brief, shots: [...brief.shots, shot] };
    this.briefs.set(projectId, next);
    this.save();
    return next;
  }

  unpin(projectId: string, shotId: string): ProjectBrief {
    const brief = this.get(projectId);
    const next: ProjectBrief = { ...brief, shots: brief.shots.filter((s) => s.id !== shotId) };
    this.briefs.set(projectId, next);
    this.save();
    return next;
  }

  remove(projectId: string): void {
    if (!this.briefs.delete(projectId)) return;
    this.save();
  }
}

/** A list section, when it has anything in it. */
function section(lines: string[], title: string, items: string[] | undefined): void {
  if (!items?.length) return;
  lines.push(`## ${title}`, "");
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
}

/**
 * What the files carry beyond the sheet itself, worked out by the app as
 * they are written: each memory line's exchange as a ref (`7a3637b4#16`),
 * what git says about the branches a line names, and the repo as git has
 * it right now.
 */
export interface SheetExtras {
  refs?: Record<string, string>;
  facts?: Record<string, string>;
  /** Plain lines of git fact (server/gitState.ts). */
  git?: string[];
  /** The time the git lines were read, HH:MM. */
  asOf?: string;
  /** Commits since the repo was read for the shape. */
  sinceRead?: number;
}

/** Files a map entry names that are still in the project. */
function present(projectDir: string | undefined, files: string[]): string[] {
  if (!projectDir) return files;
  return files.filter((file) => {
    try {
      return fs.existsSync(path.join(projectDir, file.replace(/:\d+$/, "")));
    } catch {
      return false;
    }
  });
}

/** Where a layer's sheet lives, from the project's root. */
export function layerFile(slug: string): string {
  return `.ruri/layers/${slug}.md`;
}

/** What a layer owns, as one short string — folders and a count, for the
 *  stack; every path, for its own sheet. */
function ownsText(layer: StackLayer, whole = false): string {
  if (!layer.paths?.length) return layer.where ?? "";
  return whole ? layer.paths.join(", ") : ownsSummary(layer.paths);
}

/** The stack, one line a layer: its name, its handle, what it is, what it
 *  owns — for the index and for every session's briefing. */
export function stackLines(brief: ProjectBrief): string[] {
  return (brief.layers ?? []).map((layer, i) => {
    const sheet = layer.slug && brief.layerSheets?.[layer.slug] ? ` → \`${layerFile(layer.slug)}\`` : "";
    const owns = ownsText(layer);
    return `${i + 1}. **${layer.name}**${layer.what ? ` — ${layer.what}` : ""}${owns ? ` (\`${owns}\`)` : ""}${sheet}`;
  });
}

/**
 * The shape as the model reads it.
 *
 * Layered (every project whose repo has been read since layers had sheets):
 * the index — the stack first, each layer pointing at its sheet, then the
 * paths across layers, where things are, how to run it, the rules, what it
 * does. Where to change what lives in the layers' sheets.
 *
 * An older sheet, with no layer sheets yet: where to change what first,
 * because that is what a session with a task in hand needs, then the rest.
 */
export function architectureText(
  name: string,
  brief: ProjectBrief,
  extra: SheetExtras = {},
  projectDir?: string,
): string {
  const indexed = layered(brief);
  const lines = [
    `# ${name} — architecture`,
    "",
    indexed
      ? "The shape of this project, for a model that has never seen it: the stack it is built as, top to bottom, how the parts connect, where things are, how to run it. This is the index. Each layer has a sheet of its own in `.ruri/layers/` — where to change what inside it, how it works, its key files, its traps — so read the one for the layer you are about to work in (`ruri layer <slug>` prints it), and leave the rest. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file."
      : "The shape of this project, for a model that has never seen it: where to change what, the stack it is built as, how the parts connect, where things are, how to run it. Where the work stands — git, decisions, what worked and what didn't, what's open — is in catchup.md beside this file.",
    "ruri writes this file; don't edit it by hand — the user corrects it on the architecture page.",
    "",
  ];
  if (brief.builtAt) {
    const since =
      extra.sinceRead === undefined
        ? ""
        : extra.sinceRead === 0
          ? ", which is still HEAD"
          : `, ${extra.sinceRead} commit${extra.sinceRead === 1 ? "" : "s"} ago`;
    lines.push(
      `Read from the repo at ${brief.builtAt}${since}; folded forward from finished turns since. Where it and the code disagree, the code is right.`,
      "",
    );
  }
  if (brief.description) lines.push(brief.description, "");
  if (!indexed) {
    const map = (brief.map ?? []).flatMap((place) => {
      const files = present(projectDir, place.files);
      return files.length ? [`**${place.name}:** ${files.join(", ")}`] : [];
    });
    section(lines, "Where to change what", map);
  }
  if (brief.layers?.length) {
    lines.push("## The stack, top to bottom", "", ...stackLines(brief), "");
  } else section(lines, "Stack", brief.stack);
  if (brief.flows?.length) {
    lines.push("## How it flows", "");
    for (const flow of brief.flows) lines.push(`- **${flow.name}:** ${flow.steps.join(" → ")}`);
    lines.push("");
  }
  section(lines, "Where things are", brief.layout);
  section(lines, "How to run it", brief.run);
  section(lines, "Conventions", brief.conventions);
  section(lines, "What it does", brief.features);
  const shots = brief.shots.flatMap((shot) => (shot.url ? [storedFilePath(shot.url)] : []));
  section(lines, "What it looks like", shots);
  return lines.join("\n");
}

/** One layer's sheet as the model reads it: what it is and owns, then
 *  where to change what — the part a session with a task in hand wants —
 *  how work moves through it, its key files, its traps, what it talks to. */
export function layerText(
  projectName: string,
  layer: StackLayer,
  sheet: LayerSheet,
  projectDir?: string,
): string {
  const owns = ownsText(layer, true);
  const lines = [
    `# ${projectName} — ${layer.name}`,
    "",
    `One layer of ${projectName}'s stack${owns ? `, owning \`${owns}\`` : ""}. The whole stack, and how the layers connect, is in \`.ruri/architecture.md\`.`,
    "ruri writes this file; don't edit it by hand — the user corrects it on the architecture page. Where it and the code disagree, the code is right.",
    "",
  ];
  if (sheet.summary) lines.push(sheet.summary, "");
  else if (layer.what) lines.push(layer.what, "");
  const map = sheet.map.flatMap((place) => {
    const files = present(projectDir, place.files);
    return files.length ? [`**${place.name}:** ${files.join(", ")}`] : [];
  });
  section(lines, "Where to change what", map);
  if (sheet.flows.length) {
    lines.push("## How it works", "");
    for (const flow of sheet.flows) lines.push(`- **${flow.name}:** ${flow.steps.join(" → ")}`);
    lines.push("");
  }
  section(lines, "Key files", sheet.files);
  section(lines, "Rules and traps", sheet.rules);
  section(lines, "What it talks to", sheet.edges);
  return lines.join("\n");
}

/**
 * The stack as every session in the project is shown it before it starts
 * (server/briefing.ts): a line a layer, its name, its handle and what it
 * does — the handle is its sheet's name, so the folders and paths stay in
 * the index and the sheets. Nothing, for a project with no layer sheets.
 */
export function stackBriefing(brief: ProjectBrief): string {
  if (!layered(brief)) return "";
  return (brief.layers ?? [])
    .map((layer, i) => {
      const sheet = layer.slug && brief.layerSheets?.[layer.slug];
      const handle = sheet ? ` (${layer.slug})` : "";
      return `${i + 1}. ${layer.name}${handle}${layer.what ? ` — ${layer.what}` : ""}`;
    })
    .join("\n");
}

/** How the file says who wrote a line. */
function byLabel(line: MemoryLine): string {
  if (line.by === "user") return "by the user";
  if (line.pinned) return "pinned by the user";
  return line.by === "agent" ? "by an agent" : "";
}

/** A memory line as the file has it: what, why, git's word on the branches
 *  it names, and when, where and by whom. */
export function memoryLineText(line: MemoryLine, extra: SheetExtras = {}): string {
  const fact = extra.facts?.[line.id];
  const tail = [line.date, extra.refs?.[line.id], byLabel(line)].filter(Boolean).join(" · ");
  return `${lineText(line)}${fact ? ` ${fact}` : ""}${tail ? ` (${tail})` : ""}`;
}

/** The working memory as the model reads it. */
export function catchupText(name: string, brief: ProjectBrief, extra: SheetExtras = {}): string {
  const lines = [
    `# ${name} — catch-up`,
    "",
    "Where the work on this project stands, for a model picking it up cold: what git says, what was decided and why, what worked, what was tried and failed and why, the traps, and what's still open — gathered from every chat in this project as its turns finish. Read it before you start, and don't redo a settled decision or retry what already failed without a new reason. The project's shape (where to change what, the stack, how to run it) is in architecture.md beside this file.",
    "Each line ends with the day it was learned and the exchange it came from: `7a3637b4#16` is exchange 16 of one of this project's chats, and `ruri recall show 7a3637b4#16` prints it whole — check a line there before you lean on it. Lines by the user are the user's own word; lines by an agent were written by the session that did the work; the rest were gathered by a small model and can be wrong.",
    'When your work settles something the next session will need — a decision and why, an approach that failed and why, a trap, something left open — add it: `ruri note decision "<what>" --why "<why>"` (or failed, worked, trap, open).',
    "ruri writes this file; don't edit it by hand — the user corrects it on the architecture page.",
    "",
  ];
  if (brief.description) lines.push(brief.description, "");
  const memory = brief.memory;
  if (extra.git?.length || memory?.now.length) {
    lines.push("## Where it stands", "");
    if (extra.git?.length) {
      lines.push(
        `From git${extra.asOf ? ` at ${extra.asOf}` : ""} — \`ruri state\` has it live:`,
        "",
        ...extra.git.map((line) => `- ${line}`),
        "",
      );
    }
    if (memory?.now.length) {
      if (extra.git?.length) lines.push("From the chats:", "");
      for (const line of memory.now) lines.push(`- ${memoryLineText(line, extra)}`);
      lines.push("");
    }
  }
  if (memoryEmpty(memory)) {
    lines.push("Nothing has been gathered from the work yet.", "");
    return lines.join("\n");
  }
  const part = (title: string, items: MemoryLine[] | undefined) =>
    section(
      lines,
      title,
      items?.map((line) => memoryLineText(line, extra)),
    );
  part("Decisions, and why", memory!.decisions);
  part("What worked", memory!.worked);
  part("What didn't, and why", memory!.failed);
  part("Gotchas and rules", memory!.gotchas);
  part("Still open", memory!.open);
  return lines.join("\n");
}

/** Each layer's sheet into `.ruri/layers/`, and nothing else left there —
 *  a layer that went takes its file with it. */
function writeLayerFiles(dir: string, name: string, brief: ProjectBrief, projectDir: string): void {
  const folder = path.join(dir, "layers");
  const written = new Set<string>();
  for (const layer of brief.layers ?? []) {
    const sheet = layer.slug ? brief.layerSheets?.[layer.slug] : undefined;
    if (!layer.slug || !sheet) continue;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${layer.slug}.md`), layerText(name, layer, sheet, projectDir));
    written.add(`${layer.slug}.md`);
  }
  let there: string[];
  try {
    there = fs.readdirSync(folder);
  } catch (err) {
    if (!isMissing(err)) warn("brief", err, "writeLayerFiles");
    return;
  }
  for (const file of there) {
    if (file.endsWith(".md") && !written.has(file)) fs.rmSync(path.join(folder, file), { force: true });
  }
  if (written.size === 0) fs.rmSync(folder, { recursive: true, force: true });
}

/**
 * Put both where the model can reach them: `<project>/.ruri/architecture.md`
 * and `<project>/.ruri/catchup.md`.
 *
 * Files, rather than a tool or an injected paragraph, because every harness
 * ruri drives can read a file and only some of them can do anything else —
 * and because a file costs nothing until it is opened. A sheet with nothing
 * in it takes the files away rather than leaving stale ones to be believed,
 * and a project that is still blank gets none at all (server/ruriDir.ts).
 */
export function writeBriefFiles(
  projectDir: string,
  name: string,
  brief: ProjectBrief,
  extra: SheetExtras = {},
): void {
  try {
    const dir = brief.description || brief.features.length > 0 ? ruriDir(projectDir) : undefined;
    if (!dir) {
      fs.rmSync(path.join(projectDir, ".ruri", "layers"), { recursive: true, force: true });
      removeRuriFile(projectDir, "catchup.md");
      removeRuriFile(projectDir, "architecture.md");
      return;
    }
    fs.writeFileSync(path.join(dir, "architecture.md"), architectureText(name, brief, extra, projectDir));
    fs.writeFileSync(path.join(dir, "catchup.md"), catchupText(name, brief, extra));
    writeLayerFiles(dir, name, brief, projectDir);
  } catch (err) {
    warn("brief", err, "writeBriefFiles");
    // a read-only project directory is not worth failing a turn over
  }
}
