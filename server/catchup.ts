import * as fs from "node:fs";
import * as path from "node:path";
import type { ConceptPlace, LayerSheet, Project, StackLayer } from "../shared/protocol.js";
import { layerOfFile } from "./brief.js";
import { catchupBrief, placeFiles, splitLayer, writeLayerSheet, type FullBrief } from "./smallmodel.js";
import { describeFile, layerCandidates, sourceFiles, sweepCandidates } from "./sweep.js";
import { isMissing, warn } from "./log.js";

/**
 * A project's shape (`.ruri/architecture.md`), written whole.
 *
 * The shape usually folds itself forward a few turns at a time (see
 * brief.ts): what finished work added to what the project can do, or to
 * how it is built. That is no help to a project that arrives in ruri with
 * a year of work already in it — nothing has happened here yet, so the
 * sheet is empty, and the first session in it starts from nothing.
 *
 * This is the other door: read the repo the way a person joining it would
 * — the README, the manifest, the Makefile, the agent instructions, the
 * shape of the tree, the top of the files that matter — and have the small
 * model write the sheet in one go: what it is, what it does, the stack as
 * layers, the paths through it, how to run it, where things are, and the
 * rules it lives by. It runs when a project is opened without a sheet, and
 * whenever the user asks for it again.
 *
 * Then each layer with code of its own is read the same way, on its own —
 * every path it owns, the openings of its central files, what was already
 * known of where to change what in it — and gets a sheet of its own
 * (buildLayerSheets): the part a session about to work there reads.
 */

/** How much of each file rides along. */
const README_CHARS = 7000;
const MANIFEST_CHARS = 2500;
const RULES_CHARS = 3500;
const HEAD_CHARS = 900;
/** How many source files' openings the model sees. */
const SOURCE_FILES = 26;
/** How many source paths it sees, so the map can name where things are. */
const SOURCE_PATHS = 500;

/** Every source path, a line per folder: "server/: a.ts, b.ts" — the whole
 *  of where things are, at a few tokens a file. */
function pathList(files: string[]): string {
  const byDir = new Map<string, string[]>();
  for (const rel of files.slice(0, SOURCE_PATHS)) {
    const dir = path.dirname(rel);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path.basename(rel)]);
  }
  return [...byDir]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dir, names]) => `${dir === "." ? "" : `${dir}/`}: ${names.join(", ")}`)
    .join("\n");
}

/** Folders that are nobody's layout. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-web",
  "dist-app",
  "dist-electron",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
]);

function readHead(file: string, chars: number): string | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.length > chars ? `${raw.slice(0, chars)}\n…` : raw;
  } catch (err) {
    if (!isMissing(err)) warn("catchup", err, "readHead");
    return undefined;
  }
}

/** The tree two levels down, one line per entry, with file counts inside. */
function tree(dir: string): string {
  const lines: string[] = [];
  const list = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (err) {
      if (!isMissing(err)) warn("catchup", err, "list");
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."));
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith("."));
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      let count = 0;
      try {
        count = fs.readdirSync(path.join(dir, child)).length;
      } catch (err) {
        if (!isMissing(err)) warn("catchup", err, "list");
        // unreadable
      }
      lines.push(`${"  ".repeat(depth)}${d.name}/ (${count})`);
      if (depth < 1) list(child, depth + 1);
      if (lines.length > 120) return;
    }
    if (depth === 0) {
      for (const f of files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)) lines.push(f.name);
    }
  };
  list("", 0);
  return lines.join("\n");
}

/** The manifest, trimmed to what says something: scripts and dependencies. */
function manifest(dir: string): string | undefined {
  const pkg = readHead(path.join(dir, "package.json"), 20_000);
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      const keep: Record<string, unknown> = {};
      for (const key of [
        "name",
        "description",
        "scripts",
        "dependencies",
        "devDependencies",
        "engines",
        "main",
        "bin",
      ]) {
        if (parsed[key] !== undefined) keep[key] = parsed[key];
      }
      return `package.json:\n${JSON.stringify(keep, null, 1).slice(0, MANIFEST_CHARS)}`;
    } catch (err) {
      warn("catchup", err, "manifest");
      return `package.json:\n${pkg.slice(0, MANIFEST_CHARS)}`;
    }
  }
  for (const name of [
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Package.swift",
    "build.gradle",
    "pom.xml",
    "Gemfile",
    "composer.json",
    "mix.exs",
    "deno.json",
  ]) {
    const text = readHead(path.join(dir, name), MANIFEST_CHARS);
    if (text) return `${name}:\n${text}`;
  }
  return undefined;
}

/** Everything the model reads, as one document with headed sections. */
async function catchupMaterial(project: Project): Promise<string> {
  const dir = project.path;
  const parts: string[] = [`PROJECT: ${project.name}\nPATH: ${dir}`];
  const readme = ["README.md", "readme.md", "README", "README.rst", "README.txt"]
    .map((name) => readHead(path.join(dir, name), README_CHARS))
    .find(Boolean);
  if (readme) parts.push(`=== README ===\n${readme}`);
  const man = manifest(dir);
  if (man) parts.push(`=== MANIFEST ===\n${man}`);
  const make = readHead(path.join(dir, "Makefile"), MANIFEST_CHARS);
  if (make) parts.push(`=== Makefile ===\n${make}`);
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const text = readHead(path.join(dir, name), RULES_CHARS);
    if (text) parts.push(`=== ${name} ===\n${text}`);
  }
  parts.push(`=== TREE (two levels) ===\n${tree(dir)}`);
  const paths = await sourceFiles(dir);
  if (paths.length) parts.push(`=== SOURCE FILES (every path, by folder) ===\n${pathList(paths)}`);
  const heads = (await sweepCandidates(dir)).slice(0, SOURCE_FILES).flatMap((rel) => {
    const d = describeFile(dir, rel, HEAD_CHARS);
    return d ? [`--- ${d.path} ---\n${d.head}`] : [];
  });
  if (heads.length) parts.push(`=== SOURCE FILES (openings) ===\n${heads.join("\n\n")}`);
  return parts.join("\n\n");
}

/** Read the repo and write the whole shape. Null when the model gave
 *  nothing usable (the sheet then stays as it was). */
export async function buildCatchup(project: Project, current: Partial<FullBrief>): Promise<FullBrief | null> {
  return catchupBrief(project.name, await catchupMaterial(project), current, project.path);
}

/* ── a stack cut fine enough to have a sheet a layer ────────────────── */

/** A layer owning more files than this is cut into its parts: past it, one
 *  sheet can only skim what a session working in any one part needs. */
export const SPLIT_AT = 30;
/** The most layers a stack is cut into. */
const MAX_LAYERS = 16;

/** The first thing a file says about itself, past its imports: its opening
 *  comment in most codebases, its first lines of code in the rest. */
function firstWords(dir: string, rel: string): string {
  const head = readHead(path.join(dir, rel), 1500) ?? "";
  const body = head
    .split("\n")
    .filter((line) => !/^\s*(import\b|export .* from |["']use |#!|$)/.test(line))
    .join(" ")
    .replace(/^[\s/*#-]+/, "")
    .replace(/\s+/g, " ");
  return body.slice(0, 160);
}

/**
 * The stack with every too-big layer cut into its parts — one small-model
 * call a big layer, each part taking that layer's place in the order. The
 * model is asked for a fine enough stack in the first place; this is the
 * guarantee, since "one layer owns the whole backend" is exactly what it
 * falls back on.
 */
export async function splitBigLayers(
  project: Project,
  layers: StackLayer[],
  onNote: (note: string) => void,
): Promise<StackLayer[]> {
  const files = await layerCandidates(project.path);
  const owned = new Map(
    layers.map((layer) => [layer, files.filter((f) => layerOfFile(layers, f) === layer)]),
  );
  const stack = layers
    .map((l, i) => `${i + 1}. ${l.name} — ${l.what}${l.paths?.length ? ` (${l.paths.join(", ")})` : ""}`)
    .join("\n");
  const out: StackLayer[] = [];
  for (const layer of layers) {
    const mine = owned.get(layer) ?? [];
    const room = MAX_LAYERS - (out.length + (layers.length - layers.indexOf(layer)));
    if (mine.length <= SPLIT_AT || room < 1) {
      out.push(layer);
      continue;
    }
    onNote(`cutting ${layer.name} (${mine.length} files) into its parts…`);
    const list = mine.map((rel) => `${rel} — ${firstWords(project.path, rel)}`).join("\n");
    const parts = await splitLayer(project.name, layer, stack, list, project.path);
    out.push(...(parts.length ? parts.slice(0, room + 1) : [layer]));
  }
  return out;
}

/** Files a placing call takes at once. */
const PLACE_BATCH = 150;

/**
 * Every source file owned by some layer. The model draws the stack from a
 * read of the repo and often names a layer's files one by one, which leaves
 * the rest of the folder to nobody — and a file nobody owns is one no
 * session can find a sheet for, and no turn that edits it folds into. So
 * whatever is left is placed: by the small model from what each file says
 * it is for, and what it won't place goes to the layer owning the most
 * files beside it. `layers` must have their handles (brief.ts slugLayers).
 */
export async function placeUnowned(
  project: Project,
  layers: StackLayer[],
  onNote: (note: string) => void,
): Promise<StackLayer[]> {
  const files = await layerCandidates(project.path);
  const unowned = files.filter((rel) => !layerOfFile(layers, rel));
  if (unowned.length === 0) return layers;
  onNote(`placing ${unowned.length} files no layer owns…`);
  const owned = new Map(layers.map((layer) => [layer.slug, [...(layer.paths ?? [])]]));
  const stack = layers
    .map(
      (l) =>
        `${l.slug} — ${l.name}: ${l.what}${l.paths?.length ? ` (owns ${l.paths.slice(0, 8).join(", ")}${l.paths.length > 8 ? ", …" : ""})` : ""}`,
    )
    .join("\n");
  const placed: Record<string, string> = {};
  for (let at = 0; at < unowned.length; at += PLACE_BATCH) {
    const batch = unowned.slice(at, at + PLACE_BATCH);
    const list = batch.map((rel) => `${rel} — ${firstWords(project.path, rel)}`).join("\n");
    Object.assign(placed, await placeFiles(project.name, stack, list));
  }
  for (const rel of unowned) {
    const slug = placed[rel];
    if (slug === "none") continue;
    const target = (slug && owned.has(slug) ? slug : undefined) ?? neighbour(layers, files, rel);
    if (target) owned.get(target)!.push(rel);
  }
  return layers.map((layer) => {
    const paths = owned.get(layer.slug) ?? [];
    return paths.length ? { ...layer, paths } : layer;
  });
}

/** The layer owning the most files in a file's folder, or the nearest
 *  folder above it that has any. */
function neighbour(layers: StackLayer[], files: string[], rel: string): string | undefined {
  for (let dir = path.dirname(rel); ; dir = path.dirname(dir)) {
    const counts = new Map<string, number>();
    for (const other of files) {
      if (other === rel || !(dir === "." ? true : other.startsWith(`${dir}/`))) continue;
      const slug = layerOfFile(layers, other)?.slug;
      if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) return best[0];
    if (dir === "." || dir === "/") return undefined;
  }
}

/* ── each layer's own sheet ─────────────────────────────────────────── */

/** How many of a layer's files have their openings read, and how much. */
const LAYER_HEADS = 14;
const LAYER_HEAD_CHARS = 1200;
/** How many of its paths are listed. */
const LAYER_PATHS = 400;

/** A file's size, for picking a layer's central files — the big ones are
 *  rarely the leaves. */
function sizeOf(dir: string, rel: string): number {
  try {
    return fs.statSync(path.join(dir, rel)).size;
  } catch (err) {
    if (!isMissing(err)) warn("catchup", err, "sizeOf");
    return 0;
  }
}

/** What the model reads to write one layer's sheet. */
function layerMaterial(
  dir: string,
  stack: StackLayer[],
  layer: StackLayer,
  owned: string[],
  known: ConceptPlace[],
): string {
  const parts = [
    `=== THE WHOLE STACK, top to bottom ===\n${stack
      .map((l, i) => `${i + 1}. ${l.name} — ${l.what}${l.paths?.length ? ` (${l.paths.join(", ")})` : ""}`)
      .join("\n")}`,
    `=== THIS LAYER'S FILES (every path, by folder) ===\n${pathList(owned.slice(0, LAYER_PATHS))}`,
  ];
  if (known.length) {
    parts.push(
      `=== WHERE TO CHANGE WHAT, AS ALREADY KNOWN (from work done in it) ===\n${known
        .map((place) => `${place.name}: ${place.files.join(", ")}`)
        .join("\n")}`,
    );
  }
  // the files work has already pointed at first, then the biggest
  const named = new Set(known.flatMap((place) => place.files.map((f) => f.replace(/:\d+$/, ""))));
  const central = [
    ...owned.filter((rel) => named.has(rel)),
    ...owned.filter((rel) => !named.has(rel)).sort((a, b) => sizeOf(dir, b) - sizeOf(dir, a)),
  ].slice(0, LAYER_HEADS);
  const heads = central.flatMap((rel) => {
    const d = describeFile(dir, rel, LAYER_HEAD_CHARS);
    return d ? [`--- ${d.path} ---\n${d.head}`] : [];
  });
  if (heads.length) parts.push(`=== ITS CENTRAL FILES (openings) ===\n${heads.join("\n\n")}`);
  return parts.join("\n\n");
}

/**
 * Read each layer of the stack that owns files and write its sheet — one
 * small-model call a layer, a couple at a time. `known` is where to change
 * what as the sheet knew it before it had layers (each entry goes to the
 * layer owning its first file), so nothing learned from work is lost in
 * the move. `onSheet` takes each sheet as it arrives, so the page fills
 * in layer by layer; `onNote` says which layer is being read.
 */
export async function buildLayerSheets(
  project: Project,
  layers: StackLayer[],
  current: Record<string, LayerSheet>,
  known: ConceptPlace[],
  onSheet: (slug: string, sheet: LayerSheet) => void,
  onNote: (note: string) => void,
): Promise<number> {
  const files = await layerCandidates(project.path);
  const work = layers.flatMap((layer) => {
    if (!layer.slug) return [];
    const owned = files.filter((rel) => layerOfFile(layers, rel) === layer);
    if (owned.length === 0) return [];
    const mine = (place: ConceptPlace) => {
      const first = place.files[0]?.replace(/:\d+$/, "");
      return first !== undefined && layerOfFile(layers, first) === layer;
    };
    const hints = [...known.filter(mine), ...(current[layer.slug]?.map ?? [])];
    return [{ layer, owned, hints }];
  });
  let done = 0;
  let written = 0;
  let next = 0;
  onNote(`reading ${work.length} layers…`);
  const workers = Array.from({ length: Math.min(2, work.length) }, async () => {
    for (;;) {
      const job = work[next++];
      if (!job) return;
      const { layer, owned, hints } = job;
      const sheet = await writeLayerSheet(
        project.name,
        layer,
        layerMaterial(project.path, layers, layer, owned, hints),
        current[layer.slug!],
        project.path,
      );
      done += 1;
      if (sheet) {
        written += 1;
        onSheet(layer.slug!, sheet);
      }
      onNote(`read ${done} of ${work.length} layers — ${layer.name}`);
    }
  });
  await Promise.all(workers);
  return written;
}
