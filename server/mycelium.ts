import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MYCELIUM_PREF, type NamedComponent } from "../shared/protocol.js";

export { rendersLive } from "../shared/protocol.js";
import { warn } from "./log.js";
import type { PrefStore } from "./prefs.js";
import { findCommand } from "./projectHooks.js";

/**
 * mycelium (github.com/justin06lee/mycelium), under the component library.
 *
 * ruri's library keeps what a person knows a component by: its name, its
 * pictures, its note. mycelium knows the code: given a component's root
 * declaration (`file#Symbol`) it traces what the component is made of on
 * every lookup, follows it through renames and moves, and renders it live.
 * With the "Live components" setting on and `myc` on this machine, an entry
 * that has a root is mirrored into the project's `.mycelium/components/`
 * (one way, ruri to mycelium) and its files come from there.
 *
 * Everything goes through the `myc` command: mycelium is a Bun library and
 * the server runs in Node. Each call reads the project afresh (seconds on
 * a large one), so the mirror is written as files and a whole project is
 * settled in one or two calls, never one per component.
 *
 * RURI_MYC names a myc to use instead (a file), or "" for none — what
 * tests set, so they never reach the real one.
 */

export function findMyc(): string | null {
  return findCommand("myc", "RURI_MYC");
}

/** Off unless turned on: it writes a `.mycelium` folder into projects. */
export function myceliumOn(ctx: { prefs: Pick<PrefStore, "all"> }): boolean {
  return ctx.prefs.all()[MYCELIUM_PREF] === "on";
}

/** The myc to use, or null when the setting is off or it isn't here. */
export function mycFor(ctx: { prefs: Pick<PrefStore, "all"> }): string | null {
  return myceliumOn(ctx) ? findMyc() : null;
}

/* ── the command ──────────────────────────────────────────────────── */

export interface MycRoot {
  file: string;
  symbol: string;
}

/** A component mycelium found in the code (`myc scan`). */
export interface MycCandidate extends MycRoot {
  kind?: string;
  exported?: boolean;
  default?: boolean;
  line?: number;
}

export type MycStatus = "ok" | "new" | "changed" | "relinked" | "orphaned";

/** One component as `myc show --json` answers it. */
export interface MycShown {
  slug: string;
  status: MycStatus;
  root: MycRoot & { line?: number };
  files?: Array<{ file: string; kind: string; ranges?: Array<[number, number]> }>;
  uses?: string[];
  shared?: string[];
}

export interface MycRun {
  code: number;
  out: string;
  err: string;
}

/** myc run in a folder. Never throws: a missing or broken myc is code -1. */
export function runMyc(bin: string, dir: string, args: string[], ms = 120_000): Promise<MycRun> {
  return new Promise((resolve) => {
    execFile(bin, ["-C", dir, ...args], { timeout: ms, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolve({ code, out: `${stdout}`, err: `${stderr}`.trim() });
    });
  });
}

/** What a `--json` call printed, whatever it exited with (`show` and
 *  `check` exit 1 over an orphan and still answer). Undefined for an
 *  error, or anything that isn't JSON. */
export async function mycJson<T>(bin: string, dir: string, args: string[]): Promise<T | undefined> {
  const run = await runMyc(bin, dir, [...args, "--json"]);
  try {
    const value = JSON.parse(run.out) as T | { error?: string };
    if (value && typeof value === "object" && !Array.isArray(value) && "error" in value) return undefined;
    return value as T;
  } catch {
    return undefined;
  }
}

/* ── roots ────────────────────────────────────────────────────────── */

export function rootRef(root: MycRoot): string {
  return `${root.file}#${root.symbol}`;
}

export function parseRoot(ref: string): { file: string; symbol?: string } {
  const at = ref.lastIndexOf("#");
  if (at < 0) return { file: ref };
  const symbol = ref.slice(at + 1);
  return { file: ref.slice(0, at), ...(symbol ? { symbol } : {}) };
}

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && w !== "the" && w !== "a");
}

/** How well a declaration's name fits an entry's: the words they share,
 *  over all the words either has. Plurals count as the same word. */
function fit(symbol: string, item: Pick<NamedComponent, "slug" | "name" | "aliases">): number {
  const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  const of = new Set(words(symbol).map(stem));
  if (of.size === 0) return 0;
  let best = 0;
  for (const name of [item.slug, item.name, ...item.aliases]) {
    const said = new Set(words(name).map(stem));
    const shared = [...of].filter((w) => said.has(w)).length;
    const all = new Set([...of, ...said]).size;
    if (all > 0) best = Math.max(best, shared / all);
  }
  return best;
}

/** A declaration's name has to be most of an entry's to be taken for it:
 *  "Button" in "the name everything button" is a word in common, no more. */
const FIT_MIN = 0.5;

/**
 * Which declaration each entry starts from, for the entries that have no
 * root yet: one of the components mycelium found in the entry's own files
 * (`candidates`: every component in the code, taken or not).
 *
 *  - the one named like the entry ("HomeTabs" for "home tabs") wins;
 *  - else the only component its files hold, whatever it is called;
 *  - else the one its first file is named after (Composer.tsx#Composer),
 *    when no other rootless entry is about that same file.
 *
 * A root goes to one entry only, the better fit, and a tie is no answer:
 * the entry stays as it is until someone says (`ruri edit --root`).
 */
export function pickRoots(
  items: Array<Pick<NamedComponent, "id" | "slug" | "name" | "aliases" | "files" | "root">>,
  candidates: MycCandidate[],
): Map<string, string> {
  const taken = new Set(items.map((item) => item.root).filter((root): root is string => !!root));
  const pathOf = (file: string) => file.replace(/:\d+$/, "");
  const firstFile = (item: { files: string[] }) => (item.files[0] ? pathOf(item.files[0]) : undefined);
  const rootless = items.filter((item) => !item.root);
  const wanted: Array<{ id: string; ref: string; score: number }> = [];
  for (const item of rootless) {
    const own = new Set(item.files.map(pathOf));
    const here = candidates.filter((c) => own.has(c.file));
    const first = firstFile(item);
    const alone = rootless.filter((other) => firstFile(other) === first).length === 1;
    for (const c of here) {
      if (taken.has(rootRef(c))) continue;
      const named = fit(c.symbol, item);
      const stem = first ? path.basename(first).replace(/\.[^.]+$/, "") : "";
      const score =
        named >= FIT_MIN
          ? 2 + named
          : here.length === 1
            ? 2
            : alone && c.file === first && c.symbol === stem
              ? 1
              : 0;
      if (score > 0) wanted.push({ id: item.id, ref: rootRef(c), score });
    }
  }
  wanted.sort((a, b) => b.score - a.score);
  const best = new Map<string, number>();
  for (const want of wanted) best.set(want.id, Math.max(best.get(want.id) ?? 0, want.score));
  const tied = new Set<string>();
  for (const [id, score] of best) {
    if (wanted.filter((w) => w.id === id && w.score === score).length > 1) tied.add(id);
  }
  const picked = new Map<string, string>();
  for (const want of wanted) {
    if (picked.has(want.id) || tied.has(want.id) || taken.has(want.ref)) continue;
    if (want.score < (best.get(want.id) ?? 0)) continue;
    // two entries after one root at the same strength: neither is sure
    const rival = wanted.some((w) => w.id !== want.id && w.ref === want.ref && w.score === want.score);
    if (rival) continue;
    picked.set(want.id, want.ref);
    taken.add(want.ref);
  }
  return picked;
}

/* ── the mirror ───────────────────────────────────────────────────── */

/** An entry as mycelium keeps it: `.mycelium/components/<slug>.json`.
 *  `ruri` is the id of the library entry it mirrors, which mycelium
 *  carries along untouched: how ruri knows which entries are its own. */
export interface MirrorEntry {
  slug: string;
  name: string;
  aliases: string[];
  note: string;
  tags: string[];
  root: MycRoot;
  pins: string[];
  examples?: Array<{ name: string; props: Record<string, unknown> }>;
  createdAt: string;
  updatedAt: string;
  ruri?: string;
  [key: string]: unknown;
}

const MYC_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function mirrorDir(dir: string): string {
  return path.join(dir, ".mycelium", "components");
}

/** Every entry mycelium has for a project, by slug. */
export function readMirror(dir: string): Map<string, MirrorEntry> {
  const all = new Map<string, MirrorEntry>();
  let names: string[];
  try {
    names = fs.readdirSync(mirrorDir(dir));
  } catch {
    return all;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(mirrorDir(dir), name), "utf8")) as MirrorEntry;
      if (entry && typeof entry.slug === "string" && entry.root?.file) all.set(entry.slug, entry);
    } catch {
      // a file that isn't an entry is mycelium's to complain about
    }
  }
  return all;
}

function writeEntry(dir: string, entry: MirrorEntry): void {
  fs.mkdirSync(mirrorDir(dir), { recursive: true });
  fs.writeFileSync(path.join(mirrorDir(dir), `${entry.slug}.json`), `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Write the library's rooted entries into the project's mycelium, and take
 * out the ones ruri put there for entries that are gone or renamed.
 * Entries mycelium has that ruri never wrote are left alone. Answers the
 * slugs now mirrored, and whether a file was written.
 */
export function writeMirror(
  dir: string,
  items: Array<Pick<NamedComponent, "id" | "slug" | "name" | "aliases" | "note" | "tags" | "root">>,
): { slugs: string[]; wrote: boolean } {
  const have = readMirror(dir);
  const rooted = items.filter((item) => item.root && parseRoot(item.root).symbol && MYC_SLUG.test(item.slug));
  const ours = new Set(rooted.map((item) => item.slug));
  let wrote = false;
  for (const [slug, entry] of have) {
    if (!entry.ruri || ours.has(slug)) continue;
    fs.rmSync(path.join(mirrorDir(dir), `${slug}.json`), { force: true });
    wrote = true;
  }
  const now = new Date().toISOString();
  for (const item of rooted) {
    const root = parseRoot(item.root!) as MycRoot;
    const was = have.get(item.slug);
    // one that was there under another entry's id, or by hand, is taken over
    const next: MirrorEntry = {
      ...(was ?? { pins: [], createdAt: now }),
      slug: item.slug,
      name: item.name,
      aliases: item.aliases,
      note: item.note.trim().split("\n")[0] ?? "",
      tags: item.tags ?? [],
      root: { file: root.file, symbol: root.symbol },
      pins: was?.pins ?? [],
      createdAt: was?.createdAt ?? now,
      updatedAt: was?.updatedAt ?? now,
      ruri: item.id,
    };
    const same =
      was !== undefined &&
      JSON.stringify({ ...was, updatedAt: "" }) === JSON.stringify({ ...next, updatedAt: "" });
    if (same) continue;
    // a root that moved by hand is measured anew
    if (was && rootRef(was.root) !== rootRef(next.root)) delete next["fingerprint"];
    next.updatedAt = now;
    writeEntry(dir, next);
    wrote = true;
  }
  return { slugs: rooted.map((item) => item.slug), wrote };
}

/** Files a mirrored entry holds whole, whatever the imports say. */
function pin(dir: string, slug: string, files: string[]): void {
  const entry = readMirror(dir).get(slug);
  if (!entry) return;
  entry.pins = [...new Set([...entry.pins, ...files])];
  writeEntry(dir, entry);
}

/** `name={json props}`, the way `myc edit --example` takes it. */
export function parseExample(spec: string): { name: string; props: Record<string, unknown> } | string {
  const at = spec.indexOf("=");
  if (at <= 0) return `--example '<name>={"prop": value}': "${spec}" has no name before its =`;
  const name = spec.slice(0, at).trim();
  if (!/^[\w-]+$/.test(name)) return `an example's name is a word ("basic", "long-title"), not "${name}"`;
  try {
    const props: unknown = JSON.parse(spec.slice(at + 1));
    if (!props || typeof props !== "object" || Array.isArray(props))
      return `${name}'s props are a JSON object: {"title": "Hello"}`;
    return { name, props: props as Record<string, unknown> };
  } catch {
    return `${name}'s props aren't JSON: {"title": "Hello"}`;
  }
}

/** Give a mirrored entry examples to render with (same name replaces), or
 *  take some away. False when the entry isn't mirrored. */
export function setExamples(
  dir: string,
  slug: string,
  add: Array<{ name: string; props: Record<string, unknown> }>,
  remove: string[] = [],
): boolean {
  const entry = readMirror(dir).get(slug);
  if (!entry) return false;
  const gone = new Set([...remove, ...add.map((example) => example.name)]);
  const examples = [...(entry.examples ?? []).filter((example) => !gone.has(example.name)), ...add];
  if (examples.length) entry.examples = examples;
  else delete entry.examples;
  entry.updatedAt = new Date().toISOString();
  writeEntry(dir, entry);
  return true;
}

/* ── keeping the library true to the code ─────────────────────────── */

/** What the library needs from its store to follow mycelium. */
export interface MyceliumHost {
  items(): NamedComponent[];
  /** Set an entry's root (null takes it away) and whether it is lost. */
  link(componentId: string, patch: { root?: string | null; orphaned?: boolean }): boolean;
  /** Its own files are now these. */
  refile(componentId: string, files: string[]): boolean;
}

export interface Settled {
  /** Whether the library changed. */
  changed: boolean;
  linked: number;
  orphaned: number;
  /** Components in the code that aren't in the library. */
  unnamed?: number;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Hold a project's library up against mycelium's reading of its code:
 *
 *  1. entries with no root get one where it can be told (pickRoots), when
 *     `link` is asked for — a scan, so not after every turn;
 *  2. the rooted entries are mirrored into `.mycelium/components/`;
 *  3. mycelium finds every one again (`show`): a root that was renamed or
 *     moved is followed, the files an entry is made of are taken from the
 *     trace, and one found nowhere is marked lost;
 *  4. what changed is recorded (`check --update`), so the next look
 *     measures from here.
 */
export async function settleMycelium(
  bin: string,
  dir: string,
  host: MyceliumHost,
  opts: { link?: boolean } = {},
): Promise<Settled> {
  let changed = false;
  let unnamed: number | undefined;
  if (opts.link) {
    const found = await mycJson<MycCandidate[]>(bin, dir, ["scan", "--all"]);
    if (Array.isArray(found)) {
      const have = [...readMirror(dir).values()];
      // one mycelium already holds under an entry's own slug is that entry's
      for (const item of host.items()) {
        const held = have.find((entry) => entry.slug === item.slug);
        if (!item.root && held && item.files.includes(held.root.file))
          changed = host.link(item.id, { root: rootRef(held.root) }) || changed;
      }
      // every component in the code: the unregistered, and mycelium's own
      const all = [...found, ...have.map((entry) => entry.root)];
      for (const [id, ref] of pickRoots(host.items(), all)) changed = host.link(id, { root: ref }) || changed;
      const rooted = new Set(host.items().map((item) => item.root));
      unnamed = found.filter((c) => c.exported !== false && !rooted.has(rootRef(c))).length;
    }
  }
  const { slugs, wrote } = writeMirror(dir, host.items());
  if (slugs.length === 0) return { changed, linked: 0, orphaned: 0, ...(unnamed !== undefined ? { unnamed } : {}) };
  const answer = await mycJson<MycShown | MycShown[]>(bin, dir, ["show", ...slugs, "--no-code"]);
  if (!answer) {
    warn("mycelium", new Error(`myc show answered nothing in ${dir}`), "settleMycelium");
    return { changed, linked: slugs.length, orphaned: 0, ...(unnamed !== undefined ? { unnamed } : {}) };
  }
  const shown = Array.isArray(answer) ? answer : [answer];
  const roots = new Set(shown.map((one) => one.root.file));
  let orphaned = 0;
  let record = wrote;
  for (const one of shown) {
    const item = host.items().find((i) => i.slug === one.slug);
    if (!item) continue;
    if (one.status === "orphaned") {
      orphaned++;
      changed = host.link(item.id, { orphaned: true }) || changed;
      continue;
    }
    if (one.status !== "ok") record = true;
    const ref = rootRef(one.root);
    if (ref !== item.root || item.orphaned) changed = host.link(item.id, { root: ref, orphaned: false }) || changed;
    // its own code, root's file first
    const traced = [...new Set((one.files ?? []).map((f) => f.file))];
    if (traced.length === 0) continue;
    // linked just now: a file the entry called its own that the imports
    // don't lead to (a stylesheet nothing imports, an asset) is pinned, so
    // it stays the entry's. One mycelium knows as shared, or as another
    // entry's root, is not: that is the trace being more exact.
    const pins =
      one.status === "new"
        ? item.files
            .map((file) => file.replace(/:\d+$/, ""))
            .filter(
              (file) =>
                !traced.includes(file) &&
                !(one.shared ?? []).some((shared) => shared === file || shared.startsWith(`${file}#`)) &&
                !roots.has(file) &&
                fs.existsSync(path.join(dir, file)),
            )
        : [];
    if (pins.length) pin(dir, one.slug, pins);
    const files = [...traced, ...pins];
    if (!sameList(files, item.files)) changed = host.refile(item.id, files) || changed;
  }
  if (record) await runMyc(bin, dir, ["check", "--update", "--json"]);
  return { changed, linked: slugs.length - orphaned, orphaned, ...(unnamed !== undefined ? { unnamed } : {}) };
}

/* ── live rendering ───────────────────────────────────────────────── */

interface Playing {
  child: ChildProcess;
  url: Promise<string>;
  stop: ReturnType<typeof setTimeout>;
}

/** How long a playground outlives the last window that asked for it. */
export const PLAY_IDLE_MS = 10 * 60_000;
const PLAY_START_MS = 60_000;

const playing = new Map<string, Playing>();

function stopPlay(dir: string): void {
  const play = playing.get(dir);
  if (!play) return;
  clearTimeout(play.stop);
  playing.delete(dir);
  play.child.kill();
}

/**
 * The address of a project's playground (`myc play`), started on first
 * ask and kept while windows keep asking: every component rendered from
 * its code at `<url>c/<slug>`. One per project; it picks its own port.
 * Rejects when it doesn't come up.
 */
export function playUrl(bin: string, dir: string, idleMs = PLAY_IDLE_MS): Promise<string> {
  const running = playing.get(dir);
  if (running) {
    clearTimeout(running.stop);
    running.stop = setTimeout(() => stopPlay(dir), idleMs);
    return running.url;
  }
  const child = spawn(bin, ["-C", dir, "play"], { stdio: ["ignore", "pipe", "pipe"] });
  const url = new Promise<string>((resolve, reject) => {
    let said = "";
    let errors = "";
    const late = setTimeout(() => fail(new Error("the playground didn't start in a minute")), PLAY_START_MS);
    const fail = (err: Error): void => {
      clearTimeout(late);
      if (playing.get(dir)?.child === child) stopPlay(dir);
      reject(err);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      said += chunk.toString();
      const at = /myc play: (https?:\/\/\S+)/.exec(said);
      if (!at) return;
      clearTimeout(late);
      resolve(at[1]!.endsWith("/") ? at[1]! : `${at[1]!}/`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on("error", (err) => fail(err));
    child.on("exit", () => fail(new Error(errors.trim().split("\n").pop() || "the playground stopped")));
  });
  // a failed start is told to whoever asked; nothing else is waiting on it
  url.catch(() => {});
  playing.set(dir, { child, url, stop: setTimeout(() => stopPlay(dir), idleMs) });
  return url;
}

/** Every playground stopped: the server is closing, or the setting is off. */
export function stopPlays(): void {
  for (const dir of [...playing.keys()]) stopPlay(dir);
}

process.once("exit", stopPlays);

/* ── what a session is told ───────────────────────────────────────── */

/** The lines the library's briefing gains while mycelium is under it. */
export const MYCELIUM_BRIEFING = [
  "Entries here are tied to the code: one that has a root (the declaration it starts from, `file#Symbol`) has its files traced from that root, is followed through renames and moves, and `ruri show` answers with exactly its code from every file it spans, what it uses and what uses it.",
  'Name the root when you register: `ruri register <slug> --name "…" --root <file#Symbol> --note "…" --shot <screenshot>` (then `--files` is only for files the imports don\'t lead to); `ruri edit <slug> --root <file#Symbol>` ties one that has none.',
  'A rooted React component is rendered live from its code on the Components page. One that needs props to show anything gets them from you: `ruri edit <slug> --example \'basic={"title":"Hello"}\'`, one `--example` per state worth seeing.',
].join("\n");
