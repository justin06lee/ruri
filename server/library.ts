import * as fs from "node:fs";
import * as path from "node:path";
import {
  componentStale,
  type Attachment,
  type ComponentFile,
  type ComponentProposal,
  type NamedComponent,
} from "../shared/protocol.js";
import { scoreComponent, searchComponents } from "../shared/librarySearch.js";
import { anchorsAt, checkoutFor, codeSig } from "./checkouts.js";
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

/** One file of a component, whole or the stretch that matters — read in
 *  the first of `roots` that has it (a session's worktree, then the
 *  project's own folder). */
export function readFile(roots: string | string[], ref: string, own: boolean): ComponentFile {
  const { path: file, line } = parseRef(ref);
  const base: ComponentFile = { path: file, own, ...(line !== undefined ? { line } : {}) };
  let raw: string | undefined;
  for (const root of typeof roots === "string" ? [roots] : roots) {
    const full = inside(root, file);
    if (!full) return { ...base, missing: true };
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      raw = fs.readFileSync(full, "utf8");
      break;
    } catch (err) {
      if (!isMissing(err)) warn("library", err, "readFile");
    }
  }
  if (raw === undefined) return { ...base, missing: true };
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
export function readComponent(roots: string | string[], item: NamedComponent): ComponentFile[] {
  return [
    ...item.files.map((f) => readFile(roots, f, true)),
    ...(item.uses ?? []).map((f) => readFile(roots, f, false)),
  ];
}

/* ── the listing ───────────────────────────────────────────────────── */

function shotPaths(shots: Attachment[]): string[] {
  return shots.flatMap((shot) => (shot.url ? [storedFilePath(shot.url)] : []));
}

/**
 * How an entry is written out, by where it is read:
 *  - "full": everything — the skill, `ruri show`, list_components.
 *  - "prompt": what rides down with a prompt that names it — its newest
 *    picture only, and nothing a session would only need when changing it.
 *  - "file": `.ruri/components.md`, which a project may commit — only what
 *    lasts: no pictures (paths into this machine's config folder) and no
 *    "out of date", which every merge would flip.
 */
export type EntryView = "full" | "prompt" | "file";

/** One entry the way a model should read it. */
export function entryLines(item: NamedComponent, view: EntryView = "full"): string[] {
  const lines = [`## ${item.slug} — ${item.name}`];
  if (item.note.trim()) lines.push(item.note.trim());
  if (item.aliases.length) lines.push(`Also called: ${item.aliases.join(", ")}`);
  if (item.files.length) lines.push(`Its files: ${item.files.join(", ")}`);
  if (item.uses?.length) {
    // the committed file names a line by what is on it, which moves with
    // the code; a number would change with every edit above it
    const place = (ref: string) => {
      const anchor = item.anchors?.[ref];
      return view === "file" && anchor ? `${parseRef(ref).path} (at \`${anchor}\`)` : ref;
    };
    lines.push(`Reaches into: ${item.uses.map(place).join(", ")}`);
  }
  if (view !== "prompt" && item.installs?.length)
    lines.push(`Copies installed at: ${item.installs.join(", ")}`);
  if (item.tags?.length) lines.push(`Tags: ${item.tags.join(", ")}`);
  if (item.deps?.length) lines.push(`Needs packages: ${item.deps.join(", ")}`);
  if (view !== "prompt" && item.selector) lines.push(`On screen: ${item.selector}`);
  if (view === "file") return lines;
  if (item.missing?.length) {
    lines.push(
      `Gone from the project: ${item.missing.join(", ")} — if it moved, \`ruri edit ${item.slug} --files <paths>\``,
    );
  }
  const paths = shotPaths(item.shots);
  if (view === "prompt" && paths.length) {
    lines.push(`Screenshot (read it if you need to see it): ${paths[0]}`);
  } else if (paths.length) {
    lines.push(
      paths.length === 1
        ? `Screenshot (read it if you need to see it): ${paths[0]}`
        : `Screenshots, newest first (read them if you need to see it): ${paths.join(", ")}`,
    );
  } else if (view === "full") {
    lines.push(`No picture yet — \`ruri edit ${item.slug} --shot <image>\` files one.`);
  }
  if (componentStale(item).picture) {
    lines.push(
      view === "prompt"
        ? "Its code has changed since that picture."
        : `Its code has changed since that picture — after changing it, \`ruri edit ${item.slug} --shot <new picture>\`; if it still looks like that, \`ruri edit ${item.slug} --current\``,
    );
  }
  return lines;
}

/** The whole library as a model reads it, one entry after another. */
export function libraryListing(items: NamedComponent[], view: EntryView = "full"): string {
  return items.map((item) => entryLines(item, view).join("\n")).join("\n\n");
}

/** One line per entry, for a quick look — with what it still needs. */
function shortLine(item: NamedComponent, prefix = ""): string {
  const note = item.note.trim().split("\n")[0] ?? "";
  const needs = [
    ...(item.missing?.length ? ["files gone"] : []),
    ...(item.shots.length === 0
      ? ["no picture"]
      : componentStale(item).picture
        ? ["picture out of date"]
        : []),
  ];
  return `${prefix}${item.slug} — ${item.name}${note ? `: ${note}` : ""}${needs.length ? ` [${needs.join(", ")}]` : ""}`;
}

/* ── finding it ────────────────────────────────────────────────────── */

/** How well an entry answers a search (shared/librarySearch.ts — the page
 *  searches the same way). */
export function score(item: NamedComponent, query: string): number {
  return scoreComponent(item, query);
}

/** The entries a search finds, best first; `roots` adds the top of each
 *  one's code to what it is found by. */
export function search(items: NamedComponent[], query: string, roots?: string[]): NamedComponent[] {
  return searchComponents(items, query, roots ? (item) => codeHead(roots, item) : undefined);
}

/** What the top of a component's code says it is: the opening comment and
 *  what it exports, for a search to find it by. */
function codeHead(roots: string[], item: NamedComponent): string {
  return item.files
    .slice(0, 3)
    .map((ref) => {
      const file = readFile(roots, ref, true);
      if (!file.text) return "";
      const exported = [
        ...file.text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const)\s+(\w+)/g),
      ]
        .map((m) => m[1])
        .join(" ");
      return `${file.text.slice(0, 600)} ${exported}`;
    })
    .join(" ");
}

/** Levenshtein distance, for a handle typed nearly right. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length]!;
}

/** What a handle that matched nothing might have meant: handles typed
 *  nearly right, then whatever a search for its words finds. */
function nearest(items: NamedComponent[], handle: string): NamedComponent[] {
  const wanted = slugify(handle);
  const typo = items.filter(
    (item) => distance(item.slug, wanted) <= Math.max(1, Math.floor(wanted.length / 5)),
  );
  return [...new Set([...typo, ...search(items, handle.replace(/[-_/]/g, " "))])].slice(0, 5);
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
  sourceDir: string | string[],
  files: string[],
  targetDir: string,
  destDir: string,
): Placement[] {
  const sources = typeof sourceDir === "string" ? [sourceDir] : sourceDir;
  const root = commonDir(files);
  return files.map((file) => {
    const from =
      sources.map((dir) => inside(dir, file)).find((full) => full && fs.existsSync(full)) ??
      inside(sources[0]!, file);
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

/** Where a project's components live, when nobody has said: the folder
 *  most of its library's own views sit in, or the usual places. */
export function guessDir(root: string, items: NamedComponent[]): string | undefined {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const file of item.files) {
      if (!VIEW_EXT.has(path.extname(file).toLowerCase())) continue;
      const dir = path.dirname(file);
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  if (top && top[1] >= 2 && top[0] !== ".") return top[0];
  return [
    "src/components/ui",
    "components/ui",
    "src/components",
    "app/components",
    "components",
    "src/lib/components",
    "web/src/components",
    "src/ui",
  ].find((dir) => fs.existsSync(path.join(root, dir)));
}

/** The node packages a project already has. */
function packagesOf(root: string): Set<string> | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    return new Set(
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) =>
        Object.keys(pkg[key] ?? {}),
      ),
    );
  } catch (err) {
    if (!isMissing(err)) warn("library", err, "packagesOf");
    return undefined;
  }
}

/** Extensions an import without one may mean, and the index files a folder
 *  import may mean. */
const RESOLVE_EXT = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".json",
];

/** Node's own modules, which no package.json lists. */
const BUILTIN =
  /^(node:|(fs|path|os|url|util|crypto|http|https|events|stream|child_process|assert|buffer|zlib|net|tls|dns|readline|worker_threads|process|module|querystring|timers)(\/|$))/;

/**
 * What a copied file imports that won't be there: relative imports that
 * no longer resolve from where it landed, and packages the project doesn't
 * have. Read from the copy itself, so it is exact rather than a reminder
 * to go and check.
 */
export function importGaps(root: string, files: string[]): { unresolved: string[]; packages: string[] } {
  const unresolved: string[] = [];
  const wanted = new Set<string>();
  const have = packagesOf(root);
  for (const rel of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, rel), "utf8");
    } catch (err) {
      if (!isMissing(err)) warn("library", err, "importGaps");
      continue;
    }
    const specs = [
      ...text.matchAll(/(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']/g),
      ...text.matchAll(/import\s*\(?\s*["']([^"']+)["']/g),
      ...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
      ...text.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g),
    ].map((m) => m[1]!);
    for (const spec of new Set(specs)) {
      if (spec.startsWith(".")) {
        const base = path.resolve(root, path.dirname(rel), spec);
        const found = RESOLVE_EXT.some(
          (ext) => fs.existsSync(base + ext) || (ext && fs.existsSync(path.join(base, `index${ext}`))),
        );
        if (!found) unresolved.push(`${rel} imports ${spec}`);
        continue;
      }
      if (spec.startsWith("/") || BUILTIN.test(spec) || /^[a-z]+:/i.test(spec)) continue;
      // "@scope/name/sub" and "name/sub" are the packages "@scope/name" and "name"
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      // an alias the project resolves itself ("@/lib/x", "~/x") is not a package
      if (/^[@~]\//.test(spec) || name === "@" || name === "~") {
        unresolved.push(`${rel} imports ${spec} (a path alias — check it means the same here)`);
        continue;
      }
      if (have && !have.has(name)) wanted.add(name);
    }
  }
  return { unresolved, packages: [...wanted] };
}

/* ── the command ───────────────────────────────────────────────────── */

/** Flags that take a value; every other flag is a switch. */
const VALUED = new Set([
  "update",
  "reason",
  "layer",
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
  "alias",
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

  ruri list [<project>]              everything in the library (or another open project's)
  ruri search <words> [--all]        find components by what they are; --all looks in every open project
  ruri show <slug> [--no-code]       one component: what it is, its files, pictures, and its code
  ruri show <project>/<slug>         one from another open project's library
  ruri add <slug> [--dir <folder>] [--overwrite]
                                     copy a component's files into the project (the checkout you are in);
                                     --dir is remembered, and without one it goes where the project's
                                     components live
  ruri add <project>/<slug> ...      copy one from another open project's library (it joins this one's)
  ruri register <slug> --name "<what a person calls it>" --files <paths> --note "<one line>"
                [--uses <paths:line>] [--tags a,b] [--deps pkg,pkg] [--shot <image>]
                                     put a piece of interface you built into the library — the name is the
                                     user's own words for it, never a file or class name
  ruri edit <slug> [--name] [--slug] [--note] [--files] [--uses] [--tags] [--deps] [--aliases]
                [--alias "<another name>"] [--shot <image>] [--current]
                                     change an entry (lists replace what was there; --alias adds a name the
                                     user calls it by; --shot adds a picture, which becomes the one shown;
                                     --current says its picture and note still show it as it is) — do this
                                     after changing one that is already in the library
  ruri remove <slug>                 take it out of the library (its code stays in the project)
  ruri dir [<folder>]                show or set the folder \`ruri add\` copies into

Interface only: screens, panels, cards, controls, dialogs, their styles and pictures — never backend code.
Paths are from the root of the checkout you are in (a git worktree of the project counts), or from where
you are. Lists take commas: --files a.tsx,a.css`;

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
   *  in bypass or from a chat the user isn't in ("added"), or on a card
   *  asking the user what to call it ("asked") — which the command does
   *  not wait on. */
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
      sig?: string;
      filedIn?: string;
    },
  ): NamedComponent;
  /** `filed`: what its code says where the change was made, and that
   *  checkout when it is a worktree (see Filed). */
  update(projectId: string, componentId: string, patch: LibraryPatch, filed?: Filed): boolean;
  remove(projectId: string, componentId: string): void;
  /** Keep a picture with an entry — false when the file can't be read. */
  shoot(projectId: string, componentId: string, file: string, filed?: Filed): boolean;
  /** Give an entry another's pictures. */
  copyShots(projectId: string, componentId: string, shots: Attachment[]): void;
  /** Its picture and note still show it as its code is where it was
   *  said (`filed`). */
  current(projectId: string, componentId: string, filed?: Filed): void;
  dir(projectId: string): string | undefined;
  setDir(projectId: string, dir: string): void;
  noteInstall(projectId: string, componentId: string, paths: string[]): void;
  /** Follow an entry's files that are no longer where it says, through
   *  git's renames, before it is read or copied. */
  follow(projectId: string, componentId: string): Promise<void>;
  /** Something changed: the files in the project, the skill, the windows. */
  changed(projectId: string): void;
}

/** Where a picture or note was filed: what the component's code said
 *  there (checkouts.ts codeSig), and that checkout when it is a worktree
 *  rather than the project's own folder. */
export interface Filed {
  sig?: string;
  in?: string;
  /** The text on each line its new `uses` name, there. */
  anchors?: Record<string, string>;
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

/** Where a session stands: the checkout its shell is in (the project, or a
 *  worktree of it), and the folder it typed from. */
interface Where {
  root: string;
  cwd: string;
  /** Where to read: its checkout, then the project's own folder. */
  roots: string[];
}

function whereFor(project: LibraryProject, cwd: string | undefined): Where {
  const root = checkoutFor(project.path, cwd);
  return { root, cwd: cwd ?? root, roots: root === project.path ? [root] : [root, project.path] };
}

/**
 * A path a session typed, from the root of its checkout. From where its
 * shell stands first — but a root-relative path typed from a subfolder,
 * which is how most paths are written, is taken as that when that is the
 * one that exists. An absolute path into the project or the checkout is
 * made relative; anything else is kept as typed.
 */
function fromCwd(project: LibraryProject, where: Where, typed: string): string {
  const { path: file } = parseRef(typed);
  // ":2864" (and a column) rides along untouched
  const suffix = typed.trim().slice(file.length);
  const back = (rel: string) => rel.split(path.sep).join("/") + suffix;
  const absolute = path.isAbsolute(file);
  const fromHere = absolute ? file : path.resolve(where.cwd, file);
  for (const root of [where.root, project.path]) {
    const rel = path.relative(root, fromHere);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (absolute || fs.existsSync(fromHere) || !fs.existsSync(path.join(where.root, file))) return back(rel);
    break;
  }
  return back(path.normalize(file));
}

/** A shot file a session typed, resolved from where it stands. */
function shotFile(where: Where, typed: string): string {
  return path.isAbsolute(typed) ? typed : path.resolve(where.cwd, typed);
}

/** Whether a name reads like code rather than words a person says. */
function codeLike(name: string): boolean {
  const t = name.trim();
  return (
    /^[a-z0-9]+(-[a-z0-9]+)+$/.test(t) || // kebab-case: a handle
    /^[a-z0-9]+(_[a-z0-9]+)+$/i.test(t) || // snake_case
    /^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+$/.test(t) || // PascalCase
    /^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(t) || // camelCase
    /\.[a-z]{2,4}$/i.test(t) // a file
  );
}

/** Most of a code file an answer carries before it stops. */
const SHOW_BUDGET = 60_000;

function showText(roots: string[], item: NamedComponent, code: boolean, handle: string): string {
  const parts = [entryLines(item).join("\n"), "", `Install: ruri add ${handle}`];
  if (!code) return parts.join("\n");
  let budget = SHOW_BUDGET;
  for (const file of readComponent(roots, item)) {
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

/** Another open project, by its name, its folder's name, or its id. */
function projectNamed(host: LibraryHost, name: string): LibraryProject | undefined {
  const wanted = name.toLowerCase();
  return host
    .projects()
    .find(
      (p) =>
        p.name.toLowerCase() === wanted ||
        slugify(p.name) === slugify(wanted) ||
        path.basename(p.path).toLowerCase() === wanted ||
        p.id === name,
    );
}

/** The handle in `add other-project/peek-band`: which project, which one —
 *  with its files followed first if they moved. */
async function resolveSource(
  host: LibraryHost,
  handle: string,
): Promise<{ project: LibraryProject; item: NamedComponent } | string> {
  const slash = handle.lastIndexOf("/");
  let project = host.here;
  let wanted = handle;
  if (slash > 0) {
    const found = projectNamed(host, handle.slice(0, slash));
    if (!found) {
      return `no open project called "${handle.slice(0, slash)}" — open ones: ${host
        .projects()
        .map((p) => p.name)
        .join(", ")}`;
    }
    project = found;
    wanted = handle.slice(slash + 1);
  }
  const item = host.find(project.id, wanted);
  if (!item) {
    const near = nearest(host.items(project.id), wanted);
    const where = project.id === host.here.id ? "the library" : `${project.name}'s library`;
    const prefix = project.id === host.here.id ? "" : `${project.name}/`;
    return `nothing called "${wanted}" in ${where}${near.length ? ` — did you mean: ${near.map((i) => prefix + i.slug).join(", ")}?` : ""}`;
  }
  const lost = item.files.some((f) => !fs.existsSync(path.join(project.path, parseRef(f).path)));
  if (!lost) return { project, item };
  await host.follow(project.id, item.id);
  return { project, item: host.find(project.id, item.slug) ?? item };
}

async function add(host: LibraryHost, args: ParsedArgs, cwd?: string): Promise<LibraryAnswer> {
  const handles = args.words.slice(1);
  if (handles.length === 0) return no("ruri add <slug> [--dir <folder>] — which component?");
  const here = host.here;
  const where = whereFor(here, cwd);
  const asked = oneFlag(args, "dir")?.trim().replace(/\/+$/, "");
  const saved = host.dir(here.id);
  const guessed = asked || saved ? undefined : guessDir(where.root, host.items(here.id));
  const destDir = asked ? fromCwd(here, where, asked) : (saved ?? guessed);
  if (!destDir) {
    return no(
      "This project has no components folder yet, and none to guess from. Say where they go once — `ruri add <slug> --dir src/components/ui` (or `ruri dir <folder>`) — and it is remembered.",
    );
  }
  if (!inside(where.root, destDir)) return no(`${destDir} is outside the project`);
  if (asked && !saved) host.setDir(here.id, destDir);
  const overwrite = args.switches.has("overwrite");
  const out: string[] = [];
  if (guessed) {
    out.push(`into ${guessed} — where this project's components live (\`ruri dir <folder>\` sets another)`);
  }
  if (where.root !== here.path) out.push(`into the checkout you are in: ${where.root}`);
  let failed = false;
  for (const handle of handles) {
    const found = await resolveSource(host, handle);
    if (typeof found === "string") {
      out.push(found);
      failed = true;
      continue;
    }
    const { project, item } = found;
    const label = project.id === here.id ? item.slug : `${project.name}/${item.slug}`;
    if (item.files.length === 0) {
      out.push(
        `${label} has no files of its own to copy — it lives inside ${(item.uses ?? []).join(", ") || "other files"}. \`ruri show ${label}\` shows it.`,
      );
      failed = true;
      continue;
    }
    // this project's own come from the checkout you are in; another's from
    // that project's folder
    const sources = project.id === here.id ? where.roots : [project.path];
    const plan = planCopy(sources, item.files, where.root, destDir);
    const written: string[] = [];
    const copied: string[] = [];
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
        const target = inside(where.root, place.to)!;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(place.from, target);
        lines.push(`  ${place.to} — ${place.state === "new" ? "written" : "replaced"}`);
        written.push(place.to);
        copied.push(place.to);
      } catch (err) {
        lines.push(`  ${place.to} — could not be written: ${(err as Error).message}`);
        failed = true;
      }
    }
    out.push(`${label}:`, ...lines);
    if (written.length === 0) continue;
    if (project.id === here.id) {
      // a copy of one of this project's own is still that component
      const elsewhere = written.filter((w) => !item.files.includes(w));
      host.noteInstall(here.id, item.id, elsewhere);
    } else {
      const entry = joinLibrary(host, project, item, written, where);
      out.push(
        `  now in this project's library as ${entry.slug}${entry.name !== item.name ? ` ("${entry.name}")` : ""}`,
      );
    }
    // what the copy needs that isn't where it landed
    const gaps = importGaps(where.root, copied);
    for (const gap of gaps.unresolved) out.push(`  ${gap} — not there; copy it too or change the import`);
    const packages = [...new Set([...(item.deps ?? []), ...gaps.packages])].filter(
      (dep) => !packagesOf(where.root)?.has(dep),
    );
    if (packages.length) out.push(`  it needs packages: ${installCommand(where.root, packages)}`);
    if (project.id !== here.id && item.uses?.length) {
      out.push(
        `  not copied — it also reaches into ${item.uses.join(", ")} there (styles, the screen it sits on); \`ruri show ${label}\` has that code`,
      );
    }
  }
  host.changed(here.id);
  return { ok: !failed, text: out.join("\n") };
}

/**
 * One taken from another project, in this one's library: the entry it
 * already became, when the same files were added before; otherwise a new
 * entry — never folded into a different component that happens to share
 * its handle or name.
 */
function joinLibrary(
  host: LibraryHost,
  project: LibraryProject,
  item: NamedComponent,
  written: string[],
  where: Where,
): NamedComponent {
  const here = host.here;
  const items = host.items(here.id);
  const same = items.find(
    (entry) => entry.files.length === written.length && written.every((f) => entry.files.includes(f)),
  );
  const sig = codeSig(where.root, written);
  const filedIn = where.root !== here.path ? where.root : undefined;
  if (same) {
    host.update(
      here.id,
      same.id,
      { note: item.note },
      { ...(sig ? { sig } : {}), ...(filedIn ? { in: filedIn } : {}) },
    );
    if (same.shots.length === 0 && item.shots.length > 0) host.copyShots(here.id, same.id, item.shots);
    return same;
  }
  const taken = items.some((entry) => entry.name.toLowerCase() === item.name.toLowerCase());
  const entry = host.add(here.id, {
    name: taken ? `${item.name} (from ${project.name})` : item.name,
    slug: uniqueSlug(
      item.slug,
      items.map((entry) => entry.slug),
    ),
    files: written,
    exact: true,
    ...(item.tags?.length ? { tags: item.tags } : {}),
    ...(item.deps?.length ? { deps: item.deps } : {}),
    note: item.note,
    ...(sig ? { sig } : {}),
    ...(sig && filedIn ? { filedIn } : {}),
  });
  if (entry.shots.length === 0 && item.shots.length > 0) host.copyShots(here.id, entry.id, item.shots);
  return entry;
}

function register(host: LibraryHost, args: ParsedArgs, cwd?: string): LibraryAnswer {
  const here = host.here;
  const where = whereFor(here, cwd);
  const handle = args.words[1];
  if (!handle) {
    return no(
      'ruri register <slug> --name "<what a person calls it>" --files <paths> --note "<one line>" — what is it?',
    );
  }
  const slug = slugify(handle);
  const taken = host.find(here.id, slug);
  if (taken?.slug === slug) {
    return no(`${slug} is already in the library ("${taken.name}") — \`ruri edit ${slug} ...\` changes it`);
  }
  const name = oneFlag(args, "name")?.trim();
  if (!name || codeLike(name)) {
    return no(
      [
        name
          ? `"${name}" is a name for code, not one a person says.`
          : `ruri register ${slug} needs --name "<what a person calls it>".`,
        `The name is how the user will refer to it, and how a prompt that mentions it is recognised: the user's own words for it when it came from them ("the price cards", "the confirm dialog"), or what they would call it on sight — never a file, class or handle.`,
      ].join(" "),
    );
  }
  const sameName = host.items(here.id).find((item) => item.name.toLowerCase() === name.toLowerCase());
  if (sameName) {
    return no(
      `"${name}" is already ${sameName.slug}'s name — if this is that one, \`ruri edit ${sameName.slug} ...\`; if not, name it apart`,
    );
  }
  const typed = (listFlag(args, "files") ?? []).map((f) => fromCwd(here, where, f));
  const usesTyped = (listFlag(args, "uses") ?? []).map((f) => fromCwd(here, where, f));
  if (typed.length === 0 && usesTyped.length === 0) {
    return no(
      `ruri register ${slug} --files <paths> — which files are its own? (a part that lives inside other files: --uses <file>:<line>)`,
    );
  }
  const all = [...typed, ...usesTyped];
  if (!all.some(isUiFile)) {
    return no(
      `None of ${all.join(", ")} looks like interface. The library holds screens, panels, cards, controls and dialogs — the files a person sees — never backend code.`,
    );
  }
  const outside = all.filter((f) => !inside(where.root, parseRef(f).path));
  if (outside.length) return no(`outside the project: ${outside.join(", ")}`);
  // the app's shared stylesheet and a file named at a line are places it
  // reaches into: `ruri add` must not copy them as if they were its own
  const shared = typed.filter(
    (f) => parseRef(f).line !== undefined || SHARED_STYLES.has(path.basename(parseRef(f).path).toLowerCase()),
  );
  const files = typed.filter((f) => !shared.includes(f));
  const uses = [...new Set([...usesTyped, ...shared])];
  if (files.length === 0 && shared.length > 0 && usesTyped.length === 0) {
    return no(
      `${shared.join(", ")} ${shared.length === 1 ? "is a place" : "are places"} it reaches into (a shared stylesheet, or a stretch of a bigger file), not its own code. Name its own files with --files, and the rest with --uses — a part that lives inside other files takes --uses alone.`,
    );
  }
  const exists = (ref: string) =>
    where.roots.some((root) => fs.existsSync(path.join(root, parseRef(ref).path)));
  const absent = files.filter((f) => !exists(f));
  if (absent.length) {
    return no(
      `not found: ${absent.join(", ")} — register what exists, with paths from the root of the checkout you are in (${where.root})`,
    );
  }
  // the same code under another handle is the same component
  for (const item of host.items(here.id)) {
    const overlap = files.filter((f) => item.files.includes(f));
    if (files.length > 0 && overlap.length === files.length) {
      return no(
        `${overlap.join(", ")} ${overlap.length === 1 ? "is" : "are"} already ${item.slug}'s ("${item.name}") — if this is that component, \`ruri edit ${item.slug} ...\` (--alias "${name}" adds your name for it); if it is a part inside it, register the part with --uses ${overlap[0]}:<line> instead of --files`,
      );
    }
  }
  const shot = oneFlag(args, "shot");
  const picture = shot ? shotFile(where, shot) : undefined;
  if (picture && !fs.existsSync(picture)) return no(`no picture at ${shot}`);
  const shares = host
    .items(here.id)
    .flatMap((item) => files.filter((f) => item.files.includes(f)).map((f) => `${f} (with ${item.slug})`));
  const sig = codeSig(where.root, files);
  const outcome = host.ask({
    name,
    slug,
    files,
    note: oneFlag(args, "note") ?? "",
    ...(uses.length ? { uses } : {}),
    ...(listFlag(args, "tags") ? { tags: listFlag(args, "tags")! } : {}),
    ...(listFlag(args, "deps") ? { deps: listFlag(args, "deps")! } : {}),
    ...(picture ? { shot: picture } : {}),
    ...(where.root !== here.path ? { checkout: where.root } : {}),
    ...(sig ? { sig } : {}),
    ...(uses.length ? { anchors: anchorsAt(where.roots, uses) } : {}),
  });
  const missingUses = uses.filter((f) => !exists(f));
  const notes = [
    ...(shared.length
      ? [`  ${shared.join(", ")}: a place it reaches into, not its own — kept under "reaches into"`]
      : []),
    ...(shares.length ? [`  shares ${shares.join(", ")}`] : []),
    ...(missingUses.length ? [`  not found: ${missingUses.join(", ")}`] : []),
    ...(shot
      ? []
      : [
          `  no picture — \`ruri edit ${slug} --shot <image>\` files one; an entry without one is hard to tell apart`,
        ]),
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
  const where = whereFor(here, cwd);
  const handle = args.words[1];
  if (!handle) return no("ruri edit <slug> [--name ...] — which one?");
  const item = host.find(here.id, handle);
  if (!item) {
    const near = nearest(host.items(here.id), handle);
    return no(
      `nothing called "${handle}" in the library${near.length ? ` — did you mean: ${near.map((i) => i.slug).join(", ")}?` : ""}`,
    );
  }
  const rel = (list: string[] | undefined) => list?.map((f) => fromCwd(here, where, f));
  const added = listFlag(args, "alias");
  const aliases = listFlag(args, "aliases") ?? (added ? [...item.aliases, ...added] : undefined);
  const patch: LibraryPatch = {
    ...(oneFlag(args, "name") !== undefined ? { name: oneFlag(args, "name")! } : {}),
    ...(oneFlag(args, "slug") !== undefined ? { slug: oneFlag(args, "slug")! } : {}),
    ...(oneFlag(args, "note") !== undefined ? { note: oneFlag(args, "note")! } : {}),
    ...(listFlag(args, "files") ? { files: rel(listFlag(args, "files"))! } : {}),
    ...(listFlag(args, "uses") ? { uses: rel(listFlag(args, "uses"))! } : {}),
    ...(listFlag(args, "tags") ? { tags: listFlag(args, "tags")! } : {}),
    ...(listFlag(args, "deps") ? { deps: listFlag(args, "deps")! } : {}),
    ...(aliases ? { aliases } : {}),
    ...(oneFlag(args, "selector") !== undefined ? { selector: oneFlag(args, "selector")! } : {}),
    ...(oneFlag(args, "route") !== undefined ? { route: oneFlag(args, "route")! } : {}),
  };
  const shots = (args.flags.get("shot") ?? []).map((shot) => ({ shot, file: shotFile(where, shot) }));
  const current = args.switches.has("current");
  if (Object.keys(patch).length === 0 && shots.length === 0 && !current) {
    return no(`nothing to change — ruri edit ${item.slug} --note "..." (see ruri help)`);
  }
  if (patch.name !== undefined && codeLike(patch.name)) {
    return no(`"${patch.name}" is a name for code, not one a person says — the user's own words for it`);
  }
  if (patch.files && !patch.files.some(isUiFile) && !(patch.uses ?? item.uses ?? []).some(isUiFile)) {
    return no("none of those files looks like interface — the library holds interface only");
  }
  if (patch.files) {
    const absent = patch.files.filter(
      (f) => !where.roots.some((root) => fs.existsSync(path.join(root, parseRef(f).path))),
    );
    if (absent.length)
      return no(`not found: ${absent.join(", ")} (paths are from the root of ${where.root})`);
  }
  const unreadable = shots.filter((s) => !fs.existsSync(s.file));
  if (unreadable.length)
    return no(`no picture at ${unreadable.map((s) => s.shot).join(", ")} — nothing was changed`);
  const sig = codeSig(where.root, patch.files ?? item.files);
  const filed: Filed = {
    ...(sig ? { sig } : {}),
    ...(where.root !== here.path ? { in: where.root } : {}),
    ...(patch.uses ? { anchors: anchorsAt(where.roots, patch.uses) } : {}),
  };
  host.update(here.id, item.id, patch, filed);
  if (current) host.current(here.id, item.id, filed);
  // each new picture goes in front, so the first one given is filed last
  // and ends up the one shown
  const unread = [...shots].reverse().filter((s) => !host.shoot(here.id, item.id, s.file, filed));
  host.changed(here.id);
  const now = host.find(here.id, patch.slug ?? item.slug) ?? item;
  if (unread.length)
    return no(`updated ${now.slug}, but could not file: ${unread.map((s) => s.shot).join(", ")}`);
  return yes(
    [
      `updated ${now.slug}`,
      ...(shots.length
        ? [`  ${shots.length === 1 ? "the picture is" : "the first picture is"} now the one shown`]
        : []),
      ...(current ? ["  its picture and note are marked as showing it as it is"] : []),
    ].join("\n"),
  );
}

function listing(host: LibraryHost, project: LibraryProject): LibraryAnswer {
  const items = host.items(project.id);
  const prefix = project.id === host.here.id ? "" : `${project.name}/`;
  if (items.length === 0) {
    return yes(
      prefix
        ? `${project.name}'s library is empty.`
        : 'The library is empty. Register what you build: ruri register <slug> --name "<what a person calls it>" --files <paths> --note "..." --shot <image>',
    );
  }
  const dir = host.dir(project.id);
  return yes(
    [
      `${project.name} — ${items.length} component${items.length === 1 ? "" : "s"}${dir ? ` (installs into ${dir})` : ""}`,
      "",
      ...items.map((item) => shortLine(item, prefix)),
      "",
      `ruri show ${prefix}<slug> for one in full, with its code.`,
    ].join("\n"),
  );
}

function searching(host: LibraryHost, args: ParsedArgs, cwd?: string): LibraryAnswer {
  const query = args.words.slice(1).join(" ");
  if (!query.trim()) return no("ruri search <words> [--all]");
  const here = host.here;
  const where = whereFor(here, cwd);
  const others = host.projects().filter((p) => p.id !== here.id);
  const elsewhere = (limit: number) =>
    others
      .flatMap((p) => search(host.items(p.id), query).map((item) => shortLine(item, `${p.name}/`)))
      .slice(0, limit);
  const hits = search(host.items(here.id), query, where.roots).map((item) => shortLine(item));
  if (args.switches.has("all")) {
    const all = [...hits, ...elsewhere(20)];
    if (all.length === 0) return yes(`nothing in any open project's library matches "${query}"`);
    return yes(
      [...all.slice(0, 24), "", "ruri show <slug> (or <project>/<slug>) for one in full."].join("\n"),
    );
  }
  if (hits.length === 0) {
    const there = elsewhere(5);
    return yes(
      [
        `nothing in this project's library matches "${query}" — \`ruri list\` shows everything`,
        ...(there.length
          ? [
              "",
              "Other projects have:",
              ...there,
              "",
              "ruri show <project>/<slug> reads one; ruri add <project>/<slug> copies it here.",
            ]
          : []),
      ].join("\n"),
    );
  }
  return yes([...hits.slice(0, 12), "", "ruri show <slug> for one in full."].join("\n"));
}

/**
 * Run one `ruri` command for a session in `host.here`. `cwd` is where the
 * session's shell stood — in the project or a worktree of it — so paths
 * typed from there mean what they say, and copies land there. Never
 * throws: every failure is an answer the agent can read.
 */
export async function runLibrary(host: LibraryHost, argv: string[], cwd?: string): Promise<LibraryAnswer> {
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
        const named = args.words[1];
        if (!named) return listing(host, here);
        const project = projectNamed(host, named);
        return project
          ? listing(host, project)
          : no(
              `no open project called "${named}" — open ones: ${host
                .projects()
                .map((p) => p.name)
                .join(", ")}`,
            );
      }
      case "search":
      case "find":
        return searching(host, args, cwd);
      case "show":
      case "view": {
        const handle = args.words[1];
        if (!handle) return no("ruri show <slug>");
        const found = await resolveSource(host, handle);
        if (typeof found === "string") return no(found);
        const theirs = found.project.id !== here.id;
        const roots = theirs ? [found.project.path] : whereFor(here, cwd).roots;
        const label = theirs ? `${found.project.name}/${found.item.slug}` : found.item.slug;
        return yes(showText(roots, found.item, !args.switches.has("no-code"), label));
      }
      case "add":
      case "install":
        return await add(host, args, cwd);
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
          const guess = set ? undefined : guessDir(whereFor(here, cwd).root, host.items(here.id));
          return yes(
            set
              ? `components install into ${set}`
              : guess
                ? `no components folder set — \`ruri add\` would use ${guess}, where this project's components live; ruri dir <folder> sets one`
                : "no components folder set yet — ruri dir <folder>",
          );
        }
        const where = whereFor(here, cwd);
        const rel = fromCwd(here, where, dir.replace(/\/+$/, ""));
        if (!inside(where.root, rel)) return no(`${dir} is outside the project`);
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
    "Before building any interface here, look for it below (or `ruri search <words>`; `--all` looks in every open project), and reuse or extend what exists.",
    "",
    'After building a reusable piece of interface, put it in the library: `ruri register <slug> --name "<what a person calls it>" --files <paths> --note "<one line>" --shot <screenshot>` (or name it with mcp__ruri__name_component). The name is the user\'s own words for it when it came from them — "the price cards", never "PriceCard" — because it is how they will refer to it, and how a prompt that names it is recognised. Its files are its own code; the app\'s shared stylesheet and the screen it sits on go under `--uses`.',
    "",
    'After changing one that is already here, update its entry: `ruri edit <slug> --shot <new screenshot>`, and `--note` if it no longer holds; if it still looks the same, `ruri edit <slug> --current`. When the user calls one by a name it doesn\'t have, add theirs: `ruri edit <slug> --alias "<their words>"`.',
    "",
    "- `ruri show <slug>` — one in full, with its code and pictures (`ruri show <project>/<slug>` for another project's)",
    "- `ruri add <slug> [--dir <folder>]` — copy it into the checkout you are in; `ruri add <project>/<slug>` takes one from another open project and says what it needs that isn't there",
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
