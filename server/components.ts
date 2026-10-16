import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ComponentProposal, Attachment, NamedComponent } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";
import { removeRuriFile, ruriDir } from "./ruriDir.js";
import { componentStale } from "../shared/protocol.js";
import { entryLines, isUiEntry, libraryListing, splitFiles, slugify, uniqueSlug } from "./library.js";
import { storedFilePath } from "./uploads.js";

/**
 * The component library: every piece of a project's interface ruri has on
 * file — the user's own name for it, the library's handle (`peek-band`),
 * its code, and a picture. Each project has its own. What agents do with
 * it from their shell (`ruri search`, `ruri add`…) is server/library.ts.
 *
 * It started as an index of names, and that is still the first thing it
 * is for:
 *
 * People point at interfaces with words the repository has never heard of —
 * "the dragon gauges", "the peek skyline", "the jagged tear". The model then
 * spends a tool call or five working out what was meant, and sometimes gets
 * it wrong. This closes that gap from the other end: name a thing once, say
 * where it lives, pin a screenshot of it, and from then on the name is a
 * real address.
 *
 * Nothing here is typed by hand. The index fills itself from the one moment
 * when both parties know what a thing is: the model has just built it, and
 * it says so — a card comes up in the chat with a suggested name, the user
 * edits it to whatever they will actually call it, and that is the name.
 * Nobody has to remember a filename to write an entry.
 *
 * The library reaches the model three ways:
 *
 *  - as a file. `.ruri/components.md` is rewritten inside the project
 *    whenever the index changes, so any harness at all can read the whole
 *    thing with the tools it already has.
 *  - as prompt context. A prompt that names an indexed component carries
 *    that component's entry down with it — files, note, screenshot paths —
 *    on the model's copy only, so the transcript still shows what the user
 *    actually typed.
 *  - as a skill. Claude sessions carry a plugin whose one skill lists the
 *    library (server/library.ts) — its description never changes, so the
 *    session's prompt stays cached however often the list does.
 *
 * Kept per PROJECT id under ~/.config/ruri/components/<projectId>.json.
 */

function componentsDir(): string {
  return configPath("components");
}

/** Every name an entry answers to — its handle among them. */
function names(item: NamedComponent): string[] {
  return [item.name, ...item.aliases, item.slug].map((n) => n.trim()).filter(Boolean);
}

/** What a component's file on disk holds: the entries, when the repo was
 *  last swept, the folder `ruri add` installs to, which shape the entries
 *  are in (2: the library's — slugs, own files apart from uses; 3: pictures
 *  newest first, with when the picture and note were current; 4: what the
 *  code said when they were), and when its entries were first held up
 *  against their code that way (`checked` — until then, a turn's edits
 *  were taken for changes, and git is asked once which really were). */
interface LibraryFile {
  items?: NamedComponent[];
  sweptAt?: number;
  dir?: string;
  version?: number;
  checked?: number;
}

const VERSION = 4;

/** Pictures an entry keeps. The first is the one shown; the rest are what
 *  it used to look like, and past a handful they are only clutter. */
const MAX_SHOTS = 6;

/** When a stored picture was taken, as near as its file can say. */
function shotTime(shot: Attachment): number | undefined {
  if (!shot.url) return undefined;
  try {
    return fs.statSync(storedFilePath(shot.url)).mtimeMs;
  } catch (err) {
    if (!isMissing(err)) warn("components", err, "shotTime");
    return undefined;
  }
}

/**
 * An entry from before version 3, put the new way round. Pictures were
 * added to the end and the first one shown, so a component re-photographed
 * after it changed went on wearing its old face. Now the newest is first:
 * the old list is ordered by when each picture was filed, keeping pictures
 * filed together (one `--shot a --shot b`) in the order they were given.
 */
function newestFirst(item: NamedComponent): NamedComponent {
  const timed = item.shots.map((shot, i) => ({ shot, i, at: shotTime(shot) ?? 0 }));
  // pictures within a minute of each other came in together
  const batchOf = (at: number) => Math.floor(at / 60_000);
  timed.sort((a, b) => batchOf(b.at) - batchOf(a.at) || a.i - b.i);
  const newest = Math.max(0, ...timed.map((t) => t.at));
  return {
    ...item,
    shots: timed.map((t) => t.shot),
    ...(newest ? { shotAt: newest } : {}),
    noteAt: item.noteAt ?? item.updated ?? item.ts,
  };
}

/** Anything the library turned away as it became interface-only, kept
 *  beside it rather than thrown away. */
function setAside(projectId: string, items: NamedComponent[]): void {
  if (items.length === 0) return;
  try {
    writeJsonAtomic(path.join(componentsDir(), `${projectId}.not-ui.json`), { items }, 2);
  } catch (err) {
    warn("components", err, "setAside");
  }
}

export class ComponentStore {
  private readonly data = new Map<string, NamedComponent[]>();
  /** When each project's repo was last swept — the sweep reads only what
   *  has been touched since, so pressing the button again is nearly free. */
  private readonly swept = new Map<string, number>();
  /** The folder each project's `ruri add` copies into. */
  private readonly dirs = new Map<string, string>();
  /** When each project's entries were first held up against their code
   *  (LibraryFile.checked). */
  private readonly checkedAt = new Map<string, number>();

  private load(projectId: string): NamedComponent[] {
    let items = this.data.get(projectId);
    if (items) return items;
    let migrated = false;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(componentsDir(), `${projectId}.json`), "utf8"),
      ) as LibraryFile;
      const list = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      items = (Array.isArray(raw.items) ? raw.items : []).map((item) => ({
        ...item,
        slug: typeof item.slug === "string" ? item.slug : "",
        aliases: list(item.aliases),
        files: list(item.files),
        shots: Array.isArray(item.shots) ? item.shots : [],
        note: typeof item.note === "string" ? item.note : "",
      }));
      if (typeof raw.sweptAt === "number") this.swept.set(projectId, raw.sweptAt);
      if (typeof raw.dir === "string" && raw.dir) this.dirs.set(projectId, raw.dir);
      if (typeof raw.checked === "number") this.checkedAt.set(projectId, raw.checked);
      if ((raw.version ?? 1) < VERSION) {
        // An index of names becomes a library of interface. What was named
        // but is no part of the interface — a server module, a pipeline —
        // has no place in it, and is set aside in a file of its own; what
        // stays has its own code told apart from the places it reaches.
        const kept = items.filter(isUiEntry);
        setAside(
          projectId,
          items.filter((item) => !kept.includes(item)),
        );
        const taken = new Set<string>();
        items = kept.map((item) => {
          const slug = uniqueSlug(item.slug || slugify(item.name), taken);
          taken.add(slug);
          return { ...item, slug, ...splitFiles(item.files, slug, item.uses) };
        });
        migrated = true;
      }
      if ((raw.version ?? 1) < 3) {
        items = items.map(newestFirst);
        migrated = true;
      }
    } catch (err) {
      if (!isMissing(err)) warn("components", err, "load");
      items = [];
    }
    // a picture whose file is gone is no picture: the page drew a broken
    // image for it and sessions were sent to read a file that isn't there
    for (const item of items) {
      const kept = item.shots.filter((shot) => !shot.url || fs.existsSync(storedFilePath(shot.url)));
      if (kept.length === item.shots.length) continue;
      warn(
        "components",
        `${item.slug}: ${item.shots.length - kept.length} picture(s) gone from disk`,
        "load",
      );
      item.shots = kept;
      if (kept.length === 0) {
        delete item.shotAt;
        delete item.shotSig;
      }
      migrated = true;
    }
    // an entry that came in without a handle (an older write) gets one
    const taken = new Set(items.map((item) => item.slug).filter(Boolean));
    for (const item of items) {
      if (item.slug) continue;
      item.slug = uniqueSlug(slugify(item.name), taken);
      taken.add(item.slug);
      migrated = true;
    }
    this.data.set(projectId, items);
    if (migrated) this.save(projectId);
    return items;
  }

  private save(projectId: string): void {
    try {
      const sweptAt = this.swept.get(projectId);
      const dir = this.dirs.get(projectId);
      const checked = this.checkedAt.get(projectId);
      writeJsonAtomic(
        path.join(componentsDir(), `${projectId}.json`),
        {
          version: VERSION,
          items: this.data.get(projectId) ?? [],
          ...(sweptAt ? { sweptAt } : {}),
          ...(dir ? { dir } : {}),
          ...(checked ? { checked } : {}),
        } satisfies LibraryFile,
        2,
      );
    } catch (err) {
      warn("components", err, "save");
      // best-effort persistence
    }
  }

  /** The folder `ruri add` copies into, repo-relative — unset until an
   *  agent (or the page) says where. */
  dir(projectId: string): string | undefined {
    this.load(projectId);
    return this.dirs.get(projectId);
  }

  setDir(projectId: string, dir: string): void {
    this.load(projectId);
    const clean = dir.trim().replace(/\/+$/, "");
    if (clean) this.dirs.set(projectId, clean);
    else this.dirs.delete(projectId);
    this.save(projectId);
  }

  /** Every project's folder, for the window's first sync. */
  allDirs(projectIds: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of projectIds) {
      const dir = this.dir(id);
      if (dir) out[id] = dir;
    }
    return out;
  }

  /** The entry behind a handle, or a name it answers to. */
  find(projectId: string, handle: string): NamedComponent | undefined {
    const wanted = handle.trim().toLowerCase();
    const items = this.load(projectId);
    return (
      items.find((i) => i.slug === wanted) ??
      items.find((i) => names(i).some((n) => n.toLowerCase() === wanted)) ??
      items.find((i) => i.slug === slugify(wanted))
    );
  }

  /** Remember where `ruri add` put a copy of it. */
  noteInstall(projectId: string, componentId: string, paths: string[]): void {
    const item = this.load(projectId).find((i) => i.id === componentId);
    if (!item || paths.length === 0) return;
    item.installs = [...new Set([...(item.installs ?? []), ...paths])];
    this.save(projectId);
  }

  /** Let go of pictures whose files have gone since the library loaded —
   *  an entry left with none needs a picture. Answers whether any went. */
  pruneShots(projectId: string): boolean {
    let moved = false;
    for (const item of this.load(projectId)) {
      const kept = item.shots.filter((shot) => !shot.url || fs.existsSync(storedFilePath(shot.url)));
      if (kept.length === item.shots.length) continue;
      item.shots = kept;
      if (kept.length === 0) {
        delete item.shotAt;
        delete item.shotSig;
      }
      moved = true;
    }
    if (moved) this.save(projectId);
    return moved;
  }

  /** When this project was last read end to end (0 = never). */
  sweptAt(projectId: string): number {
    this.load(projectId);
    return this.swept.get(projectId) ?? 0;
  }

  /** Remember that everything as of `when` has been read. */
  markSwept(projectId: string, when: number): void {
    this.load(projectId);
    this.swept.set(projectId, when);
    this.save(projectId);
  }

  items(projectId: string): NamedComponent[] {
    return this.load(projectId);
  }

  /** Whether this project's entries have been held up against their code
   *  yet (see LibraryFile.checked) — false until the first check after
   *  coming from a library that went by turns. */
  checked(projectId: string): boolean {
    this.load(projectId);
    return this.checkedAt.has(projectId);
  }

  /**
   * The one-time move from turns to code: an entry's out-of-date mark
   * was stamped whenever a turn touched its files — a merge of a branch
   * whose agent had already re-taken the picture included — so those marks
   * are let go, and git's word on which entries really changed since their
   * picture or note (`changed`, id → when) is taken instead. Those stay
   * out of date, with nothing yet saying what the code was when they were
   * right; the rest are right as the code is now (check adopts it).
   */
  rebase(projectId: string, changed: Map<string, number>): void {
    for (const item of this.load(projectId)) {
      delete item.seenSig;
      delete item.shotSig;
      delete item.noteSig;
      const at = changed.get(item.id);
      if (at) item.changedAt = at;
      else delete item.changedAt;
    }
    this.checkedAt.set(projectId, Date.now());
    this.save(projectId);
  }

  /** Add one, or fold it into the entry of the same name if there is one —
   *  a component built twice is one component with better notes. `sig` is
   *  what its code says where it was written (checkouts.ts codeSig). */
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
      clicks?: string[];
      found?: boolean;
      /** Its files were named as its own on purpose — see splitFiles. */
      exact?: boolean;
      sig?: string;
      /** The worktree it was named from, when not the project's folder. */
      filedIn?: string;
      /** The text on each line it reaches into, where it was named. */
      anchors?: Record<string, string>;
      /** The user gave it its name (a naming card answered). */
      confirmed?: boolean;
    },
  ): NamedComponent {
    const name = input.name.trim();
    const items = this.load(projectId);
    const wantedSlug = input.slug?.trim() ? slugify(input.slug) : undefined;
    // the same name is the same component, and so is the same handle asked
    // for on purpose — a session updating what it built says which one
    const existing =
      items.find((i) => i.name.toLowerCase() === name.toLowerCase()) ??
      (wantedSlug ? items.find((i) => i.slug === wantedSlug) : undefined);
    // a file given with a line is a place it reaches, not its own code
    const split = input.files
      ? splitFiles(input.files, wantedSlug ?? slugify(name), input.uses, input.exact)
      : undefined;
    if (existing) {
      const files = [...new Set([...existing.files, ...(split?.files ?? [])])];
      if (files.length !== existing.files.length) this.refile(existing, files, input.sig, input.filedIn);
      if (split?.uses?.length) existing.uses = [...new Set([...(existing.uses ?? []), ...split.uses])];
      this.anchor(existing, input.anchors);
      if (input.tags?.length) existing.tags = [...new Set([...(existing.tags ?? []), ...input.tags])];
      if (input.deps?.length) existing.deps = [...new Set([...(existing.deps ?? []), ...input.deps])];
      if (input.note?.trim()) {
        existing.note = input.note.trim();
        existing.noteAt = Date.now();
        this.sign(existing, "noteSig", input.sig, input.filedIn);
      }
      if (input.selector?.trim()) existing.selector = input.selector.trim();
      if (input.confirmed) this.confirm(existing);
      existing.updated = Date.now();
      this.save(projectId);
      return existing;
    }
    const item: NamedComponent = {
      id: randomUUID(),
      name,
      slug: uniqueSlug(
        wantedSlug ?? slugify(name),
        items.map((i) => i.slug),
      ),
      aliases: [],
      files: split?.files ?? [],
      ...(split?.uses?.length ? { uses: split.uses } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.anchors && split?.uses?.some((ref) => input.anchors![ref])
        ? {
            anchors: Object.fromEntries(
              split.uses.filter((ref) => input.anchors![ref]).map((ref) => [ref, input.anchors![ref]!]),
            ),
          }
        : {}),
      ...(input.deps?.length ? { deps: input.deps } : {}),
      note: input.note?.trim() ?? "",
      noteAt: Date.now(),
      ...(input.sig ? { noteSig: input.sig } : {}),
      ...(input.sig && input.filedIn ? { filedIn: input.filedIn } : {}),
      shots: [],
      ...(input.selector?.trim() ? { selector: input.selector.trim() } : {}),
      ...(input.route?.trim() ? { route: input.route.trim() } : {}),
      ...(input.clicks?.length ? { clicks: input.clicks } : {}),
      ...(input.found ? { found: true } : {}),
      ...(input.confirmed ? { confirmed: true as const } : {}),
      // everything arrives new, and wears a star until it has been looked at
      star: "just",
      ts: Date.now(),
    };
    this.load(projectId).push(item);
    this.save(projectId);
    return item;
  }

  /** A signature for a picture or note just made current: the one given
   *  (read in `filedIn`, a worktree, when not the project's folder), or —
   *  unknown — none, for the next check to take the code as it is. */
  private sign(
    item: NamedComponent,
    key: "shotSig" | "noteSig",
    sig: string | undefined,
    filedIn?: string,
  ): void {
    if (sig) item[key] = sig;
    else delete item[key];
    if (sig && filedIn) item.filedIn = filedIn;
  }

  /** What the lines it reaches into said where they were named — kept
   *  for the places it still reaches, and only those. */
  private anchor(item: NamedComponent, given: Record<string, string> | undefined): void {
    const all = { ...item.anchors, ...given };
    const kept = Object.entries(all).filter(([ref]) => item.uses?.includes(ref));
    if (kept.length) item.anchors = Object.fromEntries(kept);
    else delete item.anchors;
  }

  /** The user's name for it, now — and no longer the sweep's guess. */
  private confirm(item: NamedComponent): void {
    item.confirmed = true;
    delete item.found;
  }

  /**
   * Its own files are now these. What the picture and note were taken
   * against was the old list, so a picture that was current stays current
   * against the new one (`sig`, what the new list says where it was
   * named); one already behind stays behind.
   */
  private refile(item: NamedComponent, files: string[], sig: string | undefined, filedIn?: string): void {
    const behind = componentStale(item);
    item.files = files;
    if (!behind.picture && item.shots.length) this.sign(item, "shotSig", sig, filedIn);
    if (!behind.note) this.sign(item, "noteSig", sig, filedIn);
    delete item.missing;
  }

  /**
   * A new prompt has gone out, so nothing is "just named" any more.
   *
   * The star doesn't come off here — being unseen and being from this exact
   * prompt are two different things, and they wear the star in two different
   * places (next to the name, and in the card's corner). This is the demotion
   * from the first to the second. Answers whether anything moved.
   */
  demote(projectId: string): boolean {
    let moved = false;
    for (const item of this.load(projectId)) {
      if (item.star !== "just") continue;
      item.star = "still";
      moved = true;
    }
    if (moved) this.save(projectId);
    return moved;
  }

  /** The user looked at it — one entry, or the whole page. */
  see(projectId: string, componentId?: string): boolean {
    let changed = false;
    for (const item of this.load(projectId)) {
      if (!item.star || (componentId && item.id !== componentId)) continue;
      delete item.star;
      changed = true;
    }
    if (changed) this.save(projectId);
    return changed;
  }

  /** Change an entry. `sig` is what its code (its new files, when they
   *  change) says where the change was made; `confirm` says the name is
   *  the user's own. */
  update(
    projectId: string,
    componentId: string,
    patch: {
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
      clicks?: string[];
    },
    opts: {
      sig?: string;
      filedIn?: string;
      anchors?: Record<string, string>;
      /** The user renamed it, or said its name is right. */
      confirm?: boolean;
      /** The user said the sweep's guess holds: confirmed as it stands. */
      accept?: boolean;
    } = {},
  ): boolean {
    const items = this.load(projectId);
    const item = items.find((i) => i.id === componentId);
    if (!item) return false;
    const clean = (list: string[]) => [...new Set(list.map((v) => v.trim()).filter(Boolean))];
    if (patch.name !== undefined && patch.name.trim()) {
      item.name = patch.name.trim();
      if (opts.confirm) this.confirm(item);
    }
    if (opts.accept) this.confirm(item);
    if (patch.slug !== undefined && patch.slug.trim()) {
      item.slug = uniqueSlug(
        slugify(patch.slug),
        items.filter((i) => i !== item).map((i) => i.slug),
      );
    }
    if (patch.aliases !== undefined) item.aliases = clean(patch.aliases);
    if (patch.files !== undefined) {
      const files = clean(patch.files);
      if (files.join("\n") !== item.files.join("\n")) this.refile(item, files, opts.sig, opts.filedIn);
    }
    const lists = { uses: patch.uses, tags: patch.tags, deps: patch.deps };
    for (const [key, value] of Object.entries(lists) as Array<[keyof typeof lists, string[] | undefined]>) {
      if (value === undefined) continue;
      const next = clean(value);
      if (next.length) item[key] = next;
      else delete item[key];
    }
    // an anchor is kept for a place still named, at the same line
    if (patch.uses !== undefined) this.anchor(item, opts.anchors);
    if (patch.note !== undefined && patch.note !== item.note) {
      item.note = patch.note;
      item.noteAt = Date.now();
      this.sign(item, "noteSig", opts.sig, opts.filedIn);
    }
    if (patch.selector !== undefined) {
      const selector = patch.selector.trim();
      if (selector) item.selector = selector;
      else delete item.selector;
    }
    if (patch.route !== undefined) {
      const route = patch.route.trim();
      if (route) item.route = route;
      else delete item.route;
    }
    if (patch.clicks !== undefined) {
      const clicks = patch.clicks.map((c) => c.trim()).filter(Boolean);
      if (clicks.length) item.clicks = clicks;
      else delete item.clicks;
    }
    item.updated = Date.now();
    this.save(projectId);
    return true;
  }

  /** A new picture, which becomes the one shown. `sig`: what its code said
   *  where the picture was taken. */
  addShot(projectId: string, componentId: string, shot: Attachment, sig?: string, filedIn?: string): boolean {
    const item = this.load(projectId).find((i) => i.id === componentId);
    if (!item) return false;
    item.shots = [shot, ...item.shots].slice(0, MAX_SHOTS);
    item.shotAt = Date.now();
    this.sign(item, "shotSig", sig, filedIn);
    this.save(projectId);
    return true;
  }

  /** Its picture and note still show it as it is (`sig`, the code now):
   *  the out-of-date mark comes off without a new picture. */
  current(projectId: string, componentId: string, sig: string | undefined, filedIn?: string): boolean {
    const item = this.load(projectId).find((i) => i.id === componentId);
    if (!item) return false;
    const now = Date.now();
    delete item.filedIn;
    if (item.shots.length) {
      item.shotAt = now;
      this.sign(item, "shotSig", sig, filedIn);
    }
    item.noteAt = now;
    this.sign(item, "noteSig", sig, filedIn);
    delete item.changedAt;
    delete item.seenSig;
    item.updated = now;
    this.save(projectId);
    return true;
  }

  /**
   * Hold every entry up against its code as it is now. `read` answers, for
   * one entry, what its own files say in the project (checkouts.ts codeSig
   * — undefined when none of them can be read), which of them are nowhere,
   * and its reach-ins re-anchored when the lines under them moved.
   *
   * A picture is out of date exactly when the code differs from what it
   * said when the picture was filed, and the same for the note: so work
   * merged from a branch that re-took the picture there is current, and a
   * change undone is no change. `changedAt` is stamped the first time the
   * code is seen to differ (again for each new difference), and the picture
   * or note still matching it is moved up to it — the page tells "out of
   * date" by those stamps (componentStale). An entry with nothing yet
   * saying what its code was takes it as it is now, unless it is already
   * out of date. Answers whether anything moved.
   */
  check(
    projectId: string,
    read: (item: NamedComponent) => {
      sig?: string;
      /** What its code says in `filedIn`, the worktree its picture or note
       *  came from — undefined when there is none, or it is gone. */
      wip?: string;
      missing: string[];
      uses?: string[];
      anchors?: Record<string, string>;
    },
  ): boolean {
    let moved = false;
    const now = Date.now();
    const state = (item: NamedComponent) =>
      JSON.stringify([
        item.changedAt,
        item.shotAt,
        item.noteAt,
        item.shotSig,
        item.noteSig,
        item.filedIn,
        item.missing,
        item.uses,
        item.anchors,
      ]);
    for (const item of this.load(projectId)) {
      const before = state(item);
      const seen = read(item);
      if (seen.missing.length) item.missing = seen.missing;
      else delete item.missing;
      if (seen.uses) item.uses = seen.uses;
      if (seen.anchors) {
        if (Object.keys(seen.anchors).length) item.anchors = seen.anchors;
        else delete item.anchors;
      }
      const { sig: cur, wip } = seen;
      // the worktree it was filed from is gone, or its work is in
      if (
        item.filedIn &&
        (!wip || (cur && (!item.shots.length || item.shotSig === cur) && item.noteSig === cur))
      ) {
        delete item.filedIn;
      }
      const base = cur ?? wip;
      if (base) {
        const was = componentStale(item);
        if (item.shots.length && !item.shotSig && !was.picture) item.shotSig = base;
        if (!item.noteSig && !was.note) item.noteSig = base;
        const holds = (sig: string | undefined) => sig !== undefined && (sig === cur || sig === wip);
        const picture = item.shots.length === 0 || holds(item.shotSig);
        const note = holds(item.noteSig);
        if (picture && note) {
          delete item.changedAt;
          delete item.seenSig;
        } else {
          if (item.seenSig !== base) {
            // a mark from before signatures keeps its date the first time
            if (item.seenSig !== undefined || !item.changedAt) item.changedAt = now;
            item.seenSig = base;
          }
          // the stamps say what the signatures say (componentStale reads
          // the stamps), even within one millisecond
          let at = item.changedAt ?? now;
          if (!picture && item.shots.length) at = Math.max(at, (item.shotAt ?? 0) + 1);
          if (!note) at = Math.max(at, (item.noteAt ?? item.ts) + 1);
          item.changedAt = at;
          if (picture && item.shots.length && (item.shotAt ?? 0) < at) item.shotAt = at;
          if (note && (item.noteAt ?? item.ts) < at) item.noteAt = at;
        }
      }
      if (state(item) !== before) moved = true;
    }
    if (moved) this.save(projectId);
    return moved;
  }

  /**
   * A change to an entry has been looked at: its note rewritten (or found
   * still true), and its look judged. A look that didn't change keeps the
   * picture it has; one that did is left out of date, for a new picture.
   * `sig` is the code that was read.
   */
  reviewed(
    projectId: string,
    componentId: string,
    outcome: { note?: string; looks: boolean },
    sig?: string,
  ): void {
    const item = this.load(projectId).find((i) => i.id === componentId);
    if (!item) return;
    const now = Date.now();
    if (outcome.note?.trim()) item.note = outcome.note.trim();
    item.noteAt = now;
    this.sign(item, "noteSig", sig);
    if (!outcome.looks && item.shots.length) {
      item.shotAt = now;
      this.sign(item, "shotSig", sig);
    }
    item.updated = now;
    this.save(projectId);
  }

  /**
   * Take out the entries whose code is gone, keeping them beside the
   * library rather than throwing them away — the same file-of-its-own
   * the move to interface-only used.
   */
  retire(projectId: string, componentIds: string[]): NamedComponent[] {
    const gone = new Set(componentIds);
    const items = this.load(projectId);
    const out = items.filter((i) => gone.has(i.id));
    if (out.length === 0) return [];
    this.data.set(
      projectId,
      items.filter((i) => !gone.has(i.id)),
    );
    try {
      const file = path.join(componentsDir(), `${projectId}.gone.json`);
      let before: NamedComponent[] = [];
      try {
        before = (JSON.parse(fs.readFileSync(file, "utf8")) as { items?: NamedComponent[] }).items ?? [];
      } catch (err) {
        if (!isMissing(err)) warn("components", err, "retire read");
      }
      writeJsonAtomic(file, { items: [...before, ...out] }, 2);
    } catch (err) {
      warn("components", err, "retire");
    }
    this.save(projectId);
    return out;
  }

  removeShot(projectId: string, componentId: string, shotId: string): boolean {
    const item = this.load(projectId).find((i) => i.id === componentId);
    if (!item) return false;
    item.shots = item.shots.filter((s) => s.id !== shotId);
    this.save(projectId);
    return true;
  }

  remove(projectId: string, componentId: string): void {
    this.data.set(
      projectId,
      this.load(projectId).filter((i) => i.id !== componentId),
    );
    this.save(projectId);
  }

  removeProject(projectId: string): void {
    this.data.delete(projectId);
    try {
      fs.rmSync(path.join(componentsDir(), `${projectId}.json`), { force: true });
    } catch (err) {
      warn("components", err, "removeProject");
      // best-effort
    }
  }

  all(projectIds: Iterable<string>): Record<string, NamedComponent[]> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.items(id)]));
  }
}

/**
 * Rewrite `<project>/.ruri/components.md`. Every harness can read a file;
 * none of them can read ruri's config dir and know what it means.
 *
 * It holds what lasts: names, handles, notes, files. Pictures (paths into
 * this machine's config folder) and "its code has changed since" are left
 * to `ruri show`, the skill and the prompt — in a file a project commits,
 * they turned every merge into a change to it. Written only when what it
 * says changes.
 *
 * An empty library removes the file rather than leaving an empty one
 * behind — a stale list is worse than none — and a project that is still
 * blank gets no file at all (server/ruriDir.ts).
 */
export function writeIndexFile(projectDir: string, items: NamedComponent[]): void {
  try {
    const dir = items.length > 0 ? ruriDir(projectDir) : undefined;
    if (!dir) {
      removeRuriFile(projectDir, "components.md");
      return;
    }
    const body = [
      "# Component library",
      "",
      "Every piece of this project's interface ruri has on file: the user's own",
      "name for it, its handle, and its files. When the user names something",
      "here, this is what they mean — go straight to its files rather than",
      "searching for their words. Before building interface, look here first",
      "and reuse what exists: `ruri search <words>` finds one, `ruri show <slug>`",
      "reads it with its code and its pictures, `ruri add <slug>` copies it into",
      "place, `ruri help` says the rest.",
      "",
      "ruri maintains this file. Don't edit it by hand; it is rewritten whenever",
      "the library changes.",
      "",
      libraryListing(items, "file"),
      "",
    ].join("\n");
    const file = path.join(dir, "components.md");
    let before: string | undefined;
    try {
      before = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (!isMissing(err)) warn("components", err, "writeIndexFile");
    }
    if (before !== body) fs.writeFileSync(file, body);
  } catch (err) {
    warn("components", err, "writeIndexFile");
    // a read-only project directory is not worth failing a save over
  }
}

/* ── how the model puts things in it ──────────────────────────────── */

/** What naming a component needs from the app. Both calls take the CHANNEL
 *  id — the card belongs in the session that raised it, and the app maps that
 *  back to the project whose index it is. */
export interface ComponentHost {
  /** Put it in: at once when nobody is to be asked (bypass, or a chat the
   *  user isn't in), on a card otherwise — resolving with the name kept and
   *  whether the user chose it, or null if they waved it away. */
  propose(
    channelId: string,
    proposal: ComponentProposal,
  ): Promise<{ name: string; slug: string; asked: boolean } | null>;
  /** What's already named, for "what component is what". */
  list(channelId: string): NamedComponent[];
}

/** The tool names, auto-allowed: they ask the user themselves. */
export const COMPONENT_TOOLS = ["mcp__ruri__name_component", "mcp__ruri__list_components"];

/** The in-process MCP server a Claude project session gets — its naming
 *  tools, and whatever else of ruri's rides on the same server (`more`:
 *  the talk tools, server/talk.ts). */
export function componentTools(
  host: ComponentHost,
  channelId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's own element type for a mixed list
  more: Array<SdkMcpToolDefinition<any>> = [],
) {
  return createSdkMcpServer({
    name: "ruri",
    version: "1.0.0",
    tools: [
      tool(
        "name_component",
        "Put a piece of this project's interface you have just built into its component library, so the user can refer to it by name and later sessions can find and reuse it. Interface only — a screen, panel, card, control or dialog, never backend code. Call it once per component, right after you finish it, with a screenshot of it. When the user can be asked, they get a card with your name and picture to correct; otherwise it goes straight in under your name, and they rename it on the Components page. For one already in the library that you changed, update it instead (`ruri edit <slug> --shot <new screenshot>`).",
        {
          name: z
            .string()
            .describe(
              "What a person calls it — the user's own words for it when it came from them ('the price cards', 'the dragon gauges'), never a file or class name ('PriceCard')",
            ),
          slug: z
            .string()
            .optional()
            .describe(
              "The library's handle for it, kebab-case: 'dragon-gauges'. Made from the name if left out",
            ),
          files: z
            .array(z.string())
            .describe(
              "Its own code: repo-relative paths of the files that make it up (what `ruri add` copies) — not the screen it sits on or the app's shared stylesheet",
            ),
          uses: z
            .array(z.string())
            .optional()
            .describe(
              "Places it reaches into beyond its own files — the shared stylesheet, the screen it sits on — optionally with :line",
            ),
          tags: z
            .array(z.string())
            .optional()
            .describe("A few words to find it by: 'dialog', 'nav', 'animation'"),
          note: z.string().describe("One line on what it is and anything to know before touching it"),
          screenshot: z
            .string()
            .optional()
            .describe(
              "Absolute path to a picture of it — take one if you don't have one. The card shows this, " +
                "and a card without it asks the user to name something they cannot see. It is " +
                "kept with the entry, so later sessions can look at it too.",
            ),
          checkout: z
            .string()
            .optional()
            .describe(
              "Absolute path of the git worktree you built it in, when that isn't the project's own folder — its files are read there",
            ),
        },
        async (args) => {
          const kept = await host.propose(channelId, {
            name: args.name,
            files: args.files,
            note: args.note,
            ...(args.slug ? { slug: args.slug } : {}),
            ...(args.uses?.length ? { uses: args.uses } : {}),
            ...(args.tags?.length ? { tags: args.tags } : {}),
            ...(args.screenshot ? { shot: args.screenshot } : {}),
            ...(args.checkout ? { checkout: args.checkout } : {}),
          });
          return {
            content: [
              {
                type: "text",
                text: !kept
                  ? "The user skipped naming this one."
                  : kept.asked
                    ? `The user named it "${kept.name}" (handle ${kept.slug}). Call it that from now on.`
                    : `In the library as "${kept.name}" (handle ${kept.slug}). The user may rename it on the Components page.`,
              },
            ],
          };
        },
      ),
      tool(
        "list_components",
        "List this project's component library: every piece of its interface on file, with its handle, where it lives and a screenshot. Use it when the user refers to something by a name you don't recognise, when they ask what exists, and before building interface that may already be there.",
        {},
        async () => ({
          content: [
            {
              type: "text",
              text: libraryListing(host.list(channelId)) || "(the library is empty)",
            },
          ],
        }),
      ),
      ...more,
    ],
  });
}

/* ── a prompt that names one ──────────────────────────────────────── */

/** A name as a prompt would say it: lower case, hyphens as spaces, no
 *  article in front — "the rapid-fire bar" is "rapid fire bar". */
function spoken(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(the|a|an) /, "");
}

/** Regex-safe, and forgiving about the spacing between words. */
function pattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  // \b would refuse to fire on a name that starts or ends in punctuation
  return new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=[^\\p{L}\\p{N}_]|$)`, "giu");
}

/** The most entries one prompt carries down: past this it is a list, and
 *  the library is the place for lists. */
const MAX_MENTIONS = 5;

/**
 * The components in the library a prompt actually names: by any of its
 * names, said with or without its article and with spaces or hyphens.
 * Where one name sits inside a longer one ("the drawing page" in "the
 * drawing page text box"), the longer is meant. A one-word name the sweep
 * guessed and nobody has confirmed — "the patch", "the player" — is too
 * ordinary a word to count.
 */
export function mentionedIn(text: string, items: NamedComponent[]): NamedComponent[] {
  const said = text.replace(/[-_]+/g, " ");
  const hits: Array<{ item: NamedComponent; start: number; end: number }> = [];
  for (const item of items) {
    const guessed = item.found && !item.confirmed;
    let best: { start: number; end: number } | undefined;
    for (const name of new Set([item.name, ...item.aliases, item.slug].map(spoken).filter(Boolean))) {
      if (guessed && !name.includes(" ")) continue;
      const re = pattern(name);
      for (let m = re.exec(said); m; m = re.exec(said)) {
        const start = m.index + m[1]!.length;
        const end = start + m[2]!.length;
        if (!best || end - start > best.end - best.start) best = { start, end };
      }
    }
    if (best) hits.push({ item, ...best });
  }
  const inside = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    b.start <= a.start && a.end <= b.end && b.end - b.start > a.end - a.start;
  return hits
    .filter((hit) => !hits.some((other) => other !== hit && inside(hit, other)))
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_MENTIONS)
    .map((hit) => hit.item);
}

/**
 * What rides down with a prompt that named something in the index — on the
 * model's copy only. Short on purpose: the model gets the address and the
 * picture, and goes and looks for itself.
 */
export function mentionBlock(matched: NamedComponent[]): string {
  if (matched.length === 0) return "";
  return [
    "",
    "",
    "<ruri:components>",
    "The prompt above names parts of this project that are in its component library:",
    "",
    ...matched.flatMap((item) => [...entryLines(item, "prompt"), ""]),
    "</ruri:components>",
  ].join("\n");
}
