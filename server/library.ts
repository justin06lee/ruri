import * as fs from "node:fs";
import * as path from "node:path";
import type { Attachment, ComponentFile, ComponentProposal, NamedComponent } from "../shared/protocol.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";
import { storedFilePath } from "./uploads.js";

/**
 * The component library from an agent's side: the `ruri` command.
 *
 * Every project has a library of its own interface — each piece with the
 * user's name for it, a handle (`peek-band`), its code, and a picture
 * (server/components.ts keeps it). What makes it a library rather than an
 * index is that the agents working in the project use it the way a person
 * uses shadcn: look for what exists before building it again, read it, and
 * copy it into place —
 *
 *   ruri search dialog
 *   ruri show confirm-card
 *   ruri add confirm-card --dir src/components/ui
 *   ruri add other-project/peek-band
 *
 * — and put back what they build, so the next agent finds it:
 *
 *   ruri register peek-band --files web/src/components/PeekBand.tsx \
 *     --note "the strip of pictures across the sidebar's top" --shot /tmp/band.png
 *
 * The command is a few lines of shell ruri puts on every session's PATH
 * (installCli). It posts its arguments to this server, which runs them
 * here (runLibrary) and prints what comes back — so it works the same in
 * every harness, and needs nothing on the machine but curl.
 *
 * The library holds interface only: screens, panels, cards, controls,
 * dialogs, the styles and pictures they are made of. A server module has
 * no business in it, and `ruri register` says so.
 */

/* ── handles ───────────────────────────────────────────────────────── */

/** A handle from a name: "the peek band" → "peek-band". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "component";
}

/** The handle itself, or with a number on it when it is taken. */
export function uniqueSlug(wanted: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const next = `${wanted}-${n}`;
    if (!used.has(next)) return next;
  }
}

/* ── what counts as interface ──────────────────────────────────────── */

/** "web/src/styles.css:2864" → the path and the line. */
export function parseRef(ref: string): { path: string; line?: number } {
  const trimmed = ref.trim();
  const match = /^(.*?):(\d+)(?::\d+)?$/.exec(trimmed);
  return match ? { path: match[1]!, line: Number(match[2]) } : { path: trimmed };
}

/** Views: a person sees these wherever they sit in the tree. */
const VIEW_EXT = new Set([
  ".tsx",
  ".jsx",
  ".vue",
  ".svelte",
  ".astro",
  ".html",
  ".htm",
  ".swift",
  ".xib",
  ".storyboard",
  ".xaml",
  ".qml",
  ".ui",
  ".mdx",
]);
const STYLE_EXT = new Set([".css", ".scss", ".sass", ".less", ".styl", ".pcss"]);
const ASSET_EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".avif"]);

/** Folders that are the interface, and folders that are not. */
const UI_DIR =
  /(^|\/)(components?|ui|views?|pages?|screens?|widgets?|layouts?|app|routes|frontend|client|web|web-client|desktop|tui|gui|interface|styles?|themes?|icons?|assets)(\/|$)/i;
const BACKEND_DIR =
  /(^|\/)(server|api|backend|db|database|migrations?|workers?|jobs|cron|scripts|cli|bin|models|services|handlers)(\/|$)/i;
/** File names that are a piece of interface in any language. */
const UI_NAME =
  /(view|screen|panel|dock|window|dialog|modal|menu|tray|widget|button|card|page|layout|splash|hero|theme|style|icon|toolbar|sidebar)/i;

/** Stylesheets every component shares: a place a component reaches into,
 *  never a file of its own to copy. */
const SHARED_STYLES = new Set([
  "styles.css",
  "style.css",
  "globals.css",
  "global.css",
  "index.css",
  "app.css",
  "main.css",
  "tailwind.css",
]);

/** Whether a file is interface: a view, a style, a picture, or code that
 *  sits where the interface lives. Generous — this decides what the
 *  library may hold, and a wrong no is worse than a wrong yes. */
export function isUiFile(ref: string): boolean {
  const file = parseRef(ref).path;
  const ext = path.extname(file).toLowerCase();
  if (VIEW_EXT.has(ext) || STYLE_EXT.has(ext) || ASSET_EXT.has(ext)) return true;
  const dir = path.dirname(file);
  if (BACKEND_DIR.test(dir)) return false;
  return UI_DIR.test(dir) || UI_NAME.test(path.basename(file));
}

/** Whether an entry is a piece of interface at all: something in it is a
 *  UI file, or somebody has a picture of it. */
export function isUiEntry(item: Pick<NamedComponent, "files" | "uses" | "shots">): boolean {
  return item.shots.length > 0 || item.files.some(isUiFile) || (item.uses ?? []).some((f) => isUiFile(f));
}

/** The words in a handle worth finding in a file name. */
function handleWords(slug: string): string[] {
  return slug
    .split("-")
    .filter((w) => w.length >= 3)
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** Whether a file is named after the component ("PeekBand.tsx",
 *  "peekBand.ts" for peek-band). */
function namedAfter(file: string, words: string[]): boolean {
  const base = path
    .basename(file)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return words.some((w) => base.includes(w));
}

/**
 * Tell a component's own code from the places it reaches into.
 *
 * Its own files are the ones `ruri add` copies. A file named with a line
 * is a place (a stretch of something bigger); so is a stylesheet the whole
 * app shares, and anything in the backend. Views are its own — but when
 * some of them carry the component's name ("PeekBand.tsx" for peek-band),
 * those are, and the rest are where it sits: the sidebar it is drawn in is
 * not part of it. Other code (a hook, the logic behind it) is its own only
 * when named after it; a store the whole app shares is a place it reaches.
 */
export function splitFiles(
  refs: string[],
  slug: string,
  uses: string[] = [],
  /** The files were named as its own on purpose (`ruri register`): only a
   *  line number makes one a place it reaches. */
  exact = false,
): { files: string[]; uses?: string[] } {
  const words = handleWords(slug);
  const views: string[] = [];
  const code: string[] = [];
  const reach: string[] = [...uses];
  for (const ref of refs.map((r) => r.trim()).filter(Boolean)) {
    const { path: file, line } = parseRef(ref);
    if (line !== undefined) {
      reach.push(ref);
      continue;
    }
    if (exact) {
      views.push(file);
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    const view = VIEW_EXT.has(ext) || STYLE_EXT.has(ext) || ASSET_EXT.has(ext);
    if (SHARED_STYLES.has(path.basename(file).toLowerCase()) || BACKEND_DIR.test(path.dirname(file)))
      reach.push(ref);
    else if (view) views.push(file);
    else if (namedAfter(file, words)) code.push(file);
    else reach.push(ref);
  }
  const named = exact ? [] : views.filter((file) => namedAfter(file, words));
  const ownViews = named.length > 0 ? named : views;
  for (const file of views) if (!ownViews.includes(file)) reach.push(file);
  const files = [...new Set([...ownViews, ...code])];
  const unique = [...new Set(reach)].filter((ref) => !files.includes(ref));
  return { files, ...(unique.length ? { uses: unique } : {}) };
}

/* ── reading it ────────────────────────────────────────────────────── */

/** A path the entry names, inside the project — or nothing, for one that
 *  would climb out of it. */
export function inside(projectDir: string, file: string): string | undefined {
  const root = path.resolve(projectDir);
  const full = path.resolve(root, file);
  return full === root || full.startsWith(root + path.sep) ? full : undefined;
}

/** Files up to this long are shown whole. */
const WHOLE_LINES = 1500;
/** Around a line the entry points at: this much before, this much after. */
const BEFORE = 30;
const AFTER = 170;
/** Past this a file is not read at all. */
const MAX_BYTES = 3_000_000;

/** One file of a component, whole or the stretch that matters. */
export function readFile(projectDir: string, ref: string, own: boolean): ComponentFile {
  const { path: file, line } = parseRef(ref);
  const base: ComponentFile = { path: file, own, ...(line !== undefined ? { line } : {}) };
  const full = inside(projectDir, file);
  if (!full) return { ...base, missing: true };
  let raw: string;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { ...base, missing: true };
    raw = fs.readFileSync(full, "utf8");
  } catch (err) {
    if (!isMissing(err)) warn("library", err, "readFile");
    return { ...base, missing: true };
  }
  const lines = raw.split("\n");
  if (line !== undefined && lines.length > 400) {
    const from = Math.max(1, line - BEFORE);
    const to = Math.min(lines.length, line + AFTER);
    return { ...base, text: lines.slice(from - 1, to).join("\n"), from, lines: lines.length };
  }
  if (lines.length > WHOLE_LINES) {
    return { ...base, text: lines.slice(0, WHOLE_LINES).join("\n"), from: 1, lines: lines.length };
  }
  return { ...base, text: raw, from: 1, lines: lines.length };
}

/** Everything a component is made of, its own files first. */
export function readComponent(projectDir: string, item: NamedComponent): ComponentFile[] {
  return [
    ...item.files.map((f) => readFile(projectDir, f, true)),
    ...(item.uses ?? []).map((f) => readFile(projectDir, f, false)),
  ];
}

/* ── the listing ───────────────────────────────────────────────────── */

function shotPaths(shots: Attachment[]): string[] {
  return shots.flatMap((shot) => (shot.url ? [storedFilePath(shot.url)] : []));
}

/** One entry the way a model should read it. */
export function entryLines(item: NamedComponent): string[] {
  const lines = [`## ${item.slug} — ${item.name}`];
  if (item.note.trim()) lines.push(item.note.trim());
  if (item.aliases.length) lines.push(`Also called: ${item.aliases.join(", ")}`);
  if (item.files.length) lines.push(`Its files: ${item.files.join(", ")}`);
  if (item.uses?.length) lines.push(`Reaches into: ${item.uses.join(", ")}`);
  if (item.installs?.length) lines.push(`Copies installed at: ${item.installs.join(", ")}`);
  if (item.tags?.length) lines.push(`Tags: ${item.tags.join(", ")}`);
  if (item.deps?.length) lines.push(`Needs packages: ${item.deps.join(", ")}`);
  if (item.selector) lines.push(`On screen: ${item.selector}`);
  const paths = shotPaths(item.shots);
  if (paths.length) {
    lines.push(
      paths.length === 1
        ? `Screenshot (read it if you need to see it): ${paths[0]}`
        : `Screenshots (read them if you need to see it): ${paths.join(", ")}`,
    );
  }
  return lines;
}

/** The whole library as a model reads it, one entry after another. */
export function libraryListing(items: NamedComponent[]): string {
  return items.map((item) => entryLines(item).join("\n")).join("\n\n");
}

/** One line per entry, for a quick look. */
function shortLine(item: NamedComponent): string {
  const note = item.note.trim().split("\n")[0] ?? "";
  return `${item.slug} — ${item.name}${note ? `: ${note}` : ""}`;
}

/* ── finding it ────────────────────────────────────────────────────── */

/** How well an entry answers a search: every word has to be somewhere in
 *  it, and a word in the handle or the name counts for more. */
export function score(item: NamedComponent, query: string): number {
  const words = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (words.length === 0) return 0;
  const strong = [item.slug, item.name, ...item.aliases, ...(item.tags ?? [])].join(" ").toLowerCase();
  const weak = [item.note, ...item.files, ...(item.uses ?? [])].join(" ").toLowerCase();
  let total = 0;
  for (const word of words) {
    if (strong.includes(word)) total += 3;
    else if (weak.includes(word)) total += 1;
    else return 0;
  }
  return total;
}

export function search(items: NamedComponent[], query: string): NamedComponent[] {
  return items
    .map((item) => ({ item, score: score(item, query) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug))
    .map((hit) => hit.item);
}

/* ── copying it into place ─────────────────────────────────────────── */

/** Where each of a component's files would land, and how that goes. */
export interface Placement {
  /** Where it is copied from, absolute. */
  from: string;
  /** Where it goes, repo-relative. */
  to: string;
  state: "new" | "same" | "differs" | "missing";
}

/** The folder a set of files has in common. */
function commonDir(files: string[]): string {
  if (files.length === 0) return "";
  const split = files.map((f) => path.dirname(f).split("/"));
  const first = split[0]!;
  let n = 0;
  while (n < first.length && split.every((parts) => parts[n] === first[n])) n++;
  return first.slice(0, n).join("/");
}

/**
 * Work out a copy: each of the component's own files into `destDir` in
 * the target project, laid out under it the way they sit under the
 * folder they share (one folder of them lands flat, as shadcn's do).
 */
export function planCopy(
  sourceDir: string,
  files: string[],
  targetDir: string,
  destDir: string,
): Placement[] {
  const root = commonDir(files);
  return files.map((file) => {
    const from = inside(sourceDir, file);
    const rel = root ? path.relative(root, file) : file;
    const to = path.join(destDir, rel).split(path.sep).join("/");
    if (!from || !fs.existsSync(from)) return { from: from ?? file, to, state: "missing" as const };
    const at = inside(targetDir, to);
    if (!at) return { from, to, state: "missing" as const };
    if (!fs.existsSync(at)) return { from, to, state: "new" as const };
    try {
      return {
        from,
        to,
        state: fs.readFileSync(at).equals(fs.readFileSync(from)) ? ("same" as const) : ("differs" as const),
      };
    } catch (err) {
      warn("library", err, "planCopy");
      return { from, to, state: "differs" as const };
    }
  });
}

/** How this project installs a package: by its lockfile, bun if it has
 *  none. */
export function installCommand(projectDir: string, deps: string[]): string {
  const has = (name: string) => fs.existsSync(path.join(projectDir, name));
  const tool =
    has("bun.lock") || has("bun.lockb")
      ? "bun add"
      : has("pnpm-lock.yaml")
        ? "pnpm add"
        : has("yarn.lock")
          ? "yarn add"
          : has("package-lock.json")
            ? "npm install"
            : "bun add";
  return `${tool} ${deps.join(" ")}`;
}

/* ── the command ───────────────────────────────────────────────────── */

/** Flags that take a value; every other flag is a switch. */
const VALUED = new Set([
  "why",
  "dir",
  "name",
  "slug",
  "note",
  "files",
  "uses",
  "tags",
  "deps",
  "aliases",
  "shot",
  "selector",
  "route",
]);

export interface ParsedArgs {
  words: string[];
  flags: Map<string, string[]>;
  switches: Set<string>;
}

/** `add peek-band --dir src/ui --overwrite` → words, flags, switches. A
 *  flag given twice keeps both values. */
export function parseArgs(argv: string[]): ParsedArgs {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--") || arg === "--") {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = (eq > 0 ? arg.slice(2, eq) : arg.slice(2)).toLowerCase();
    if (!VALUED.has(key)) {
      switches.add(key);
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) continue;
    flags.set(key, [...(flags.get(key) ?? []), value]);
  }
  return { words, flags, switches };
}

/** A list flag's values, commas and repeats both: `--files a.tsx,b.css`. */
function listFlag(args: ParsedArgs, key: string): string[] | undefined {
  const raw = args.flags.get(key);
  if (!raw) return undefined;
  return raw
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function oneFlag(args: ParsedArgs, key: string): string | undefined {
  return args.flags.get(key)?.at(-1);
}

export const HELP = `ruri — this project's component library, and its memory

  ruri list                          everything in the library
  ruri search <words>                find components by what they are
  ruri show <slug> [--no-code]       one component: what it is, its files, screenshots, and its code
  ruri add <slug> [--dir <folder>] [--overwrite]
                                     copy a component's files into the project; the folder is
                                     remembered, so later adds need no --dir
  ruri add <project>/<slug> ...      copy one from another open project's library (it joins this one's)
  ruri register <slug> --files <paths> --note "<one line>" [--name "<what the user calls it>"]
                [--uses <paths:line>] [--tags a,b] [--deps pkg,pkg] [--shot <image>]
                                     put a piece of interface you built into the library
  ruri edit <slug> [--name] [--slug] [--note] [--files] [--uses] [--tags] [--deps] [--aliases] [--shot]
                                     change an entry (lists replace what was there; --shot adds a picture)
  ruri remove <slug>                 take it out of the library (its code stays in the project)
  ruri dir [<folder>]                show or set the folder \`ruri add\` copies into

Interface only: screens, panels, cards, controls, dialogs, their styles and pictures — never backend code.
Paths are relative to the project's root. Lists take commas: --files a.tsx,a.css`;

/** A project the command can reach. */
export interface LibraryProject {
  id: string;
  name: string;
  path: string;
}

/** What the command needs from the app. */
export interface LibraryHost {
  /** The project the asking session works in. */
  here: LibraryProject;
  /** Every open project, for `ruri add <project>/<slug>`. */
  projects(): LibraryProject[];
  /** Put something into the library the way the naming tool does: at once
   *  in bypass ("added"), or on a card asking the user what to call it
   *  ("asked") — which the command does not wait on. */
  ask(proposal: ComponentProposal): "added" | "asked";
  items(projectId: string): NamedComponent[];
  find(projectId: string, handle: string): NamedComponent | undefined;
  add(
    projectId: string,
    input: {
      name: string;
      slug?: string;
      files?: string[];
      uses?: string[];
      tags?: string[];
      deps?: string[];
      note?: string;
      selector?: string;
      route?: string;
      exact?: boolean;
    },
  ): NamedComponent;
  update(projectId: string, componentId: string, patch: LibraryPatch): boolean;
  remove(projectId: string, componentId: string): void;
  /** Keep a picture with an entry — false when the file can't be read. */
  shoot(projectId: string, componentId: string, file: string): boolean;
  /** Give an entry another's pictures. */
  copyShots(projectId: string, componentId: string, shots: Attachment[]): void;
  dir(projectId: string): string | undefined;
  setDir(projectId: string, dir: string): void;
  noteInstall(projectId: string, componentId: string, paths: string[]): void;
  /** Something changed: the files in the project, the skill, the windows. */
  changed(projectId: string): void;
}

/** What `ruri edit` may change. */
export interface LibraryPatch {
  name?: string;
  slug?: string;
  aliases?: string[];
  files?: string[];
  uses?: string[];
  tags?: string[];
  deps?: string[];
  note?: string;
  selector?: string;
  route?: string;
}

export interface LibraryAnswer {
  ok: boolean;
  text: string;
}

const yes = (text: string): LibraryAnswer => ({ ok: true, text });
const no = (text: string): LibraryAnswer => ({ ok: false, text });

/** What a session's working directory is, relative to its project — so a
 *  path an agent types from a subfolder still means that file. */
function fromCwd(project: LibraryProject, cwd: string | undefined, file: string): string {
  if (!cwd || path.isAbsolute(file)) {
    return path.isAbsolute(file) ? path.relative(project.path, file) : file;
  }
  const rel = path.relative(project.path, path.resolve(cwd, file));
  return rel.startsWith("..") ? file : rel;
}

/** Most of a code file an answer carries before it stops. */
const SHOW_BUDGET = 60_000;

function showText(project: LibraryProject, item: NamedComponent, code: boolean): string {
  const parts = [entryLines(item).join("\n"), "", `Install: ruri add ${item.slug}`];
  if (!code) return parts.join("\n");
  let budget = SHOW_BUDGET;
  for (const file of readComponent(project.path, item)) {
    const label = `${file.path}${file.line ? `:${file.line}` : ""}${file.own ? "" : " (reaches into)"}`;
    if (file.missing) {
      parts.push("", `--- ${label} — not found ---`);
      continue;
    }
    let text = file.text ?? "";
    const window =
      file.from !== undefined &&
      file.lines !== undefined &&
      (file.from > 1 || text.split("\n").length < file.lines)
        ? ` (lines ${file.from}–${file.from + text.split("\n").length - 1} of ${file.lines})`
        : "";
    if (text.length > budget)
      text = `${text.slice(0, Math.max(0, budget))}\n… (cut here — read the file for the rest)`;
    budget -= text.length;
    parts.push("", `--- ${label}${window} ---`, text);
    if (budget <= 0) {
      parts.push("", "… (the rest is cut — read the files themselves)");
      break;
    }
  }
  return parts.join("\n");
}

/** The handle in `add other-project/peek-band`: which project, which one. */
function resolveSource(
  host: LibraryHost,
  handle: string,
): { project: LibraryProject; item: NamedComponent } | string {
  const slash = handle.lastIndexOf("/");
  if (slash > 0) {
    const name = handle.slice(0, slash).toLowerCase();
    const slug = handle.slice(slash + 1);
    const project = host
      .projects()
      .find((p) => p.name.toLowerCase() === name || slugify(p.name) === slugify(name) || p.id === name);
    if (!project) {
      return `no open project called "${handle.slice(0, slash)}" — open ones: ${host
        .projects()
        .map((p) => p.name)
        .join(", ")}`;
    }
    const item = host.find(project.id, slug);
    return item ? { project, item } : `${project.name}'s library has nothing called "${slug}"`;
  }
  const item = host.find(host.here.id, handle);
  if (item) return { project: host.here, item };
  const near = search(host.items(host.here.id), handle.replace(/-/g, " ")).slice(0, 5);
  return `nothing called "${handle}" in the library${near.length ? ` — did you mean: ${near.map((i) => i.slug).join(", ")}?` : ""}`;
}

function add(host: LibraryHost, args: ParsedArgs): LibraryAnswer {
  const handles = args.words.slice(1);
  if (handles.length === 0) return no("ruri add <slug> [--dir <folder>] — which component?");
  const here = host.here;
  const asked = oneFlag(args, "dir")?.trim().replace(/\/+$/, "");
  const saved = host.dir(here.id);
  const destDir = asked || saved;
  if (!destDir) {
    return no(
      "This project has no components folder yet. Say where they go once — `ruri add <slug> --dir src/components/ui` (or `ruri dir <folder>`) — and it is remembered.",
    );
  }
  if (!inside(here.path, destDir)) return no(`${destDir} is outside the project`);
  if (asked && !saved) host.setDir(here.id, asked);
  const overwrite = args.switches.has("overwrite");
  const out: string[] = [];
  let failed = false;
  for (const handle of handles) {
    const found = resolveSource(host, handle);
    if (typeof found === "string") {
      out.push(found);
      failed = true;
      continue;
    }
    const { project, item } = found;
    if (item.files.length === 0) {
      out.push(
        `${item.slug} has no files of its own to copy — it lives inside ${(item.uses ?? []).join(", ") || "other files"}. \`ruri show ${item.slug}\` shows it.`,
      );
      failed = true;
      continue;
    }
    const plan = planCopy(project.path, item.files, here.path, destDir);
    const written: string[] = [];
    const lines: string[] = [];
    for (const place of plan) {
      if (place.state === "missing") {
        lines.push(`  ${place.to} — skipped: its source is gone`);
        failed = true;
        continue;
      }
      if (place.state === "same") {
        lines.push(`  ${place.to} — already there, unchanged`);
        written.push(place.to);
        continue;
      }
      if (place.state === "differs" && !overwrite) {
        lines.push(`  ${place.to} — already there and different; kept (--overwrite replaces it)`);
        continue;
      }
      try {
        const target = inside(here.path, place.to)!;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(place.from, target);
        lines.push(`  ${place.to} — ${place.state === "new" ? "written" : "replaced"}`);
        written.push(place.to);
      } catch (err) {
        lines.push(`  ${place.to} — could not be written: ${(err as Error).message}`);
        failed = true;
      }
    }
    const from = project.id === here.id ? "" : ` from ${project.name}`;
    out.push(`${item.slug}${from}:`, ...lines);
    if (written.length === 0) continue;
    if (project.id === here.id) {
      // a copy of one of this project's own is still that component
      const elsewhere = written.filter((w) => !item.files.includes(w));
      host.noteInstall(here.id, item.id, elsewhere);
    } else {
      // one taken from another project joins this one's library (the
      // entry of the same name, when there is one)
      const entry = host.add(here.id, {
        name: item.name,
        slug: item.slug,
        files: written,
        exact: true,
        ...(item.tags?.length ? { tags: item.tags } : {}),
        ...(item.deps?.length ? { deps: item.deps } : {}),
        note: item.note,
      });
      if (entry.shots.length === 0 && item.shots.length > 0) host.copyShots(here.id, entry.id, item.shots);
      out.push(`  now in this project's library as ${entry.slug}`);
    }
    const moved =
      plan.some((p) => p.state !== "missing" && !item.files.includes(p.to)) || project.id !== here.id;
    if (moved)
      out.push("  check its imports: anything it imported by a relative path now sits somewhere else");
    if (item.deps?.length) out.push(`  it needs packages: ${installCommand(here.path, item.deps)}`);
  }
  host.changed(here.id);
  return { ok: !failed, text: out.join("\n") };
}

function register(host: LibraryHost, args: ParsedArgs, cwd?: string): LibraryAnswer {
  const here = host.here;
  const handle = args.words[1];
  if (!handle) return no('ruri register <slug> --files <paths> --note "<one line>" — what is it called?');
  const slug = slugify(handle);
  if (host.find(here.id, slug)?.slug === slug) {
    return no(`${slug} is already in the library — \`ruri edit ${slug} ...\` changes it`);
  }
  const files = (listFlag(args, "files") ?? []).map((f) => fromCwd(here, cwd, f));
  const uses = (listFlag(args, "uses") ?? []).map((f) => fromCwd(here, cwd, f));
  if (files.length === 0) return no(`ruri register ${slug} --files <paths> — which files is it?`);
  const all = [...files, ...uses];
  if (!all.some(isUiFile)) {
    return no(
      `None of ${all.join(", ")} looks like interface. The library holds screens, panels, cards, controls and dialogs — the files a person sees — never backend code.`,
    );
  }
  const outside = all.filter((f) => !inside(here.path, parseRef(f).path));
  if (outside.length) return no(`outside the project: ${outside.join(", ")}`);
  const missing = all.filter((f) => !fs.existsSync(path.join(here.path, parseRef(f).path)));
  const name = oneFlag(args, "name")?.trim() || slug.replace(/-/g, " ");
  const shot = oneFlag(args, "shot");
  const shotFile = shot ? (cwd ? path.resolve(cwd, shot) : path.resolve(here.path, shot)) : undefined;
  if (shotFile && !fs.existsSync(shotFile)) return no(`no picture at ${shot}`);
  const outcome = host.ask({
    name,
    slug,
    files,
    note: oneFlag(args, "note") ?? "",
    ...(uses.length ? { uses } : {}),
    ...(listFlag(args, "tags") ? { tags: listFlag(args, "tags")! } : {}),
    ...(listFlag(args, "deps") ? { deps: listFlag(args, "deps")! } : {}),
    ...(shotFile ? { shot: shotFile } : {}),
  });
  const notes = [
    ...(missing.length ? [`  not found (yet?): ${missing.join(", ")}`] : []),
    ...(shot ? [] : ["  no screenshot — the card is much easier to answer with one (--shot <image>)"]),
  ];
  if (outcome === "asked") {
    return yes(
      [
        `asked the user what to call it — a card is up in the chat with "${name}" on it. It joins the library as ${slug} when they answer (they may rename it, or skip it); nothing to wait for.`,
        ...notes,
      ].join("\n"),
    );
  }
  const item = host.find(here.id, slug) ?? host.find(here.id, name);
  host.changed(here.id);
  if (!item) return no(`${slug} could not be put in the library`);
  const lines = [
    `registered ${item.slug} — "${item.name}"`,
    `  its files: ${item.files.join(", ") || "(none)"}`,
  ];
  if (item.uses?.length) lines.push(`  reaches into: ${item.uses.join(", ")}`);
  return yes([...lines, ...notes].join("\n"));
}

function edit(host: LibraryHost, args: ParsedArgs, cwd?: string): LibraryAnswer {
  const here = host.here;
  const handle = args.words[1];
  if (!handle) return no("ruri edit <slug> [--name ...] — which one?");
  const item = host.find(here.id, handle);
  if (!item) return no(`nothing called "${handle}" in the library`);
  const rel = (list: string[] | undefined) => list?.map((f) => fromCwd(here, cwd, f));
  const patch = {
    ...(oneFlag(args, "name") !== undefined ? { name: oneFlag(args, "name")! } : {}),
    ...(oneFlag(args, "slug") !== undefined ? { slug: oneFlag(args, "slug")! } : {}),
    ...(oneFlag(args, "note") !== undefined ? { note: oneFlag(args, "note")! } : {}),
    ...(listFlag(args, "files") ? { files: rel(listFlag(args, "files"))! } : {}),
    ...(listFlag(args, "uses") ? { uses: rel(listFlag(args, "uses"))! } : {}),
    ...(listFlag(args, "tags") ? { tags: listFlag(args, "tags")! } : {}),
    ...(listFlag(args, "deps") ? { deps: listFlag(args, "deps")! } : {}),
    ...(listFlag(args, "aliases") ? { aliases: listFlag(args, "aliases")! } : {}),
    ...(oneFlag(args, "selector") !== undefined ? { selector: oneFlag(args, "selector")! } : {}),
    ...(oneFlag(args, "route") !== undefined ? { route: oneFlag(args, "route")! } : {}),
  };
  const shots = args.flags.get("shot") ?? [];
  if (Object.keys(patch).length === 0 && shots.length === 0) {
    return no(`nothing to change — ruri edit ${item.slug} --note "..." (see ruri help)`);
  }
  if (patch.files && !patch.files.some(isUiFile) && !(patch.uses ?? item.uses ?? []).some(isUiFile)) {
    return no("none of those files looks like interface — the library holds interface only");
  }
  host.update(here.id, item.id, patch);
  const unread = shots.filter((shot) => !host.shoot(here.id, item.id, cwd ? path.resolve(cwd, shot) : shot));
  host.changed(here.id);
  const now = host.find(here.id, patch.slug ?? item.slug) ?? item;
  return yes(
    [`updated ${now.slug}`, ...(unread.length ? [`  could not read: ${unread.join(", ")}`] : [])].join("\n"),
  );
}

/**
 * Run one `ruri` command for a session in `host.here`. `cwd` is where the
 * session's shell stood, so paths typed from a subfolder mean what they
 * say. Never throws: every failure is an answer the agent can read.
 */
export function runLibrary(host: LibraryHost, argv: string[], cwd?: string): LibraryAnswer {
  const args = parseArgs(argv);
  const command = (args.words[0] ?? "help").toLowerCase();
  const here = host.here;
  try {
    switch (command) {
      case "help":
      case "-h":
        return yes(HELP);
      case "list":
      case "ls": {
        const items = host.items(here.id);
        if (items.length === 0) {
          return yes(
            'The library is empty. Register what you build: ruri register <slug> --files <paths> --note "..." --shot <image>',
          );
        }
        const dir = host.dir(here.id);
        return yes(
          [
            `${here.name} — ${items.length} component${items.length === 1 ? "" : "s"}${dir ? ` (installs into ${dir})` : ""}`,
            "",
            ...items.map(shortLine),
            "",
            "ruri show <slug> for one in full, with its code.",
          ].join("\n"),
        );
      }
      case "search":
      case "find": {
        const query = args.words.slice(1).join(" ");
        if (!query.trim()) return no("ruri search <words>");
        const hits = search(host.items(here.id), query);
        if (hits.length === 0) {
          return yes(`nothing in the library matches "${query}" — \`ruri list\` shows everything`);
        }
        return yes([...hits.slice(0, 12).map(shortLine), "", "ruri show <slug> for one in full."].join("\n"));
      }
      case "show":
      case "view": {
        const handle = args.words[1];
        if (!handle) return no("ruri show <slug>");
        const found = resolveSource(host, handle);
        if (typeof found === "string") return no(found);
        return yes(showText(found.project, found.item, !args.switches.has("no-code")));
      }
      case "add":
      case "install":
        return add(host, args);
      case "register":
      case "new":
        return register(host, args, cwd);
      case "edit":
      case "update":
        return edit(host, args, cwd);
      case "remove":
      case "rm": {
        const handle = args.words[1];
        if (!handle) return no("ruri remove <slug>");
        const item = host.find(here.id, handle);
        if (!item) return no(`nothing called "${handle}" in the library`);
        host.remove(here.id, item.id);
        host.changed(here.id);
        return yes(`removed ${item.slug} from the library — its code is still in the project`);
      }
      case "dir": {
        const dir = args.words[1];
        if (dir === undefined) {
          const set = host.dir(here.id);
          return yes(
            set ? `components install into ${set}` : "no components folder set yet — ruri dir <folder>",
          );
        }
        const rel = fromCwd(here, undefined, dir.replace(/\/+$/, ""));
        if (!inside(here.path, rel)) return no(`${dir} is outside the project`);
        host.setDir(here.id, rel);
        host.changed(here.id);
        return yes(`components install into ${rel} from now on`);
      }
      default:
        return no(`ruri: no command "${command}"\n\n${HELP}`);
    }
  } catch (err) {
    warn("library", err, command);
    return no(`ruri ${command} failed: ${(err as Error).message}`);
  }
}

/* ── on every session's PATH ───────────────────────────────────────── */

/** The folder the command lives in. */
export function cliDir(): string {
  return configPath("bin");
}

/**
 * The command itself: a few lines of sh that post the arguments to the
 * server the session belongs to ($RURI_LIBRARY, set per session) and print
 * the answer. curl does the encoding, so any argument survives the trip.
 */
const CLI = `#!/bin/sh
# ruri's component library, for agents in a session ruri started
# (server/library.ts). \`ruri help\` says what it does.
if [ -z "$RURI_LIBRARY" ]; then
  echo "ruri: this works inside a session ruri started" >&2
  exit 2
fi
n=$#
for a do
  set -- "$@" --data-urlencode "a=$a"
done
shift "$n"
nl='
'
reply=$(curl -sS -X POST --data-urlencode "cwd=$PWD" "$@" -w "$nl%{http_code}" "$RURI_LIBRARY") || {
  echo "ruri: ruri isn't answering — is the app still open?" >&2
  exit 3
}
status=\${reply##*"$nl"}
printf '%s\\n' "\${reply%"$nl"*}"
[ "$status" = 200 ]
`;

/** Put the command where sessions will find it, if it isn't there as is. */
export function installCli(): void {
  const file = path.join(cliDir(), "ruri");
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === CLI) return;
    fs.mkdirSync(cliDir(), { recursive: true });
    fs.writeFileSync(file, CLI, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  } catch (err) {
    warn("library", err, "installCli");
  }
}

/** A session's environment for the command: where to post, and the
 *  command on its PATH ahead of anything of the same name. */
export function cliEnv(endpoint: string): Record<string, string> {
  return {
    RURI_LIBRARY: endpoint,
    PATH: [cliDir(), process.env["PATH"] ?? "/usr/bin:/bin"].join(path.delimiter),
  };
}

/* ── the skill ─────────────────────────────────────────────────────── */

/**
 * The library as a Claude skill, in a plugin of ruri's own per project
 * (~/.config/ruri/library/<projectId>/), handed to every Claude session in
 * the project.
 *
 * A skill's description sits in the session's system prompt, and its body
 * is read only when the skill is used. So the description here never
 * changes — not the count, not a name — and the prompt stays cached turn
 * after turn however often the library does; the body, which is the list,
 * is rewritten whenever the library changes.
 */
export function skillDir(projectId: string): string {
  return configPath("library", projectId);
}

export const SKILL_DESCRIPTION =
  "This project's UI component library, kept by ruri: every piece of its interface on file — what each is, its files, screenshots, and how to install it. Use it before building or changing any interface in this project, to reuse or extend what exists rather than build it again, and when the user names a part of the interface you can't place.";

export function writeLibrarySkill(
  projectId: string,
  projectName: string,
  items: NamedComponent[],
  dir?: string,
): void {
  const root = skillDir(projectId);
  const body = [
    "---",
    "name: components",
    `description: ${SKILL_DESCRIPTION}`,
    "---",
    "",
    `# ${projectName} — component library`,
    "",
    items.length === 0
      ? "Nothing is in the library yet."
      : `${items.length} component${items.length === 1 ? "" : "s"}, as of ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.${dir ? ` \`ruri add\` installs into ${dir}.` : ""}`,
    "",
    'Before building any interface here, look for it below (or `ruri search <words>`), and reuse or extend what exists. After building a reusable piece of interface, put it in the library: `ruri register <slug> --files <paths> --note "<one line>" --shot <screenshot>` (or name it with mcp__ruri__name_component, which asks the user what to call it).',
    "",
    "- `ruri show <slug>` — one in full, with its code",
    "- `ruri add <slug> [--dir <folder>]` — copy it into the project; `ruri add <project>/<slug>` takes one from another open project",
    "- `ruri edit <slug> ...`, `ruri remove <slug>`, `ruri help`",
    "",
    "This list is rewritten whenever the library changes; if this session has been going a while, `ruri list` has anything added since.",
    "",
    libraryListing(items),
    "",
  ].join("\n");
  try {
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "components"), { recursive: true });
    const manifest = path.join(root, ".claude-plugin", "plugin.json");
    const plugin = JSON.stringify(
      {
        name: "ruri",
        version: "1.0.0",
        description: "What ruri knows about this project, for Claude sessions it starts",
      },
      null,
      2,
    );
    if (!fs.existsSync(manifest) || fs.readFileSync(manifest, "utf8") !== plugin)
      fs.writeFileSync(manifest, plugin);
    fs.writeFileSync(path.join(root, "skills", "components", "SKILL.md"), body);
  } catch (err) {
    warn("library", err, "writeLibrarySkill");
  }
}

/** Forget a removed project's skill. */
export function removeLibrarySkill(projectId: string): void {
  try {
    fs.rmSync(skillDir(projectId), { recursive: true, force: true });
  } catch (err) {
    warn("library", err, "removeLibrarySkill");
  }
}
