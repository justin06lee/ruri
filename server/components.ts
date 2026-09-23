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
import { entryLines, isUiEntry, libraryListing, splitFiles, slugify, uniqueSlug } from "./library.js";

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
 *  last swept, the folder `ruri add` installs to, and which shape the
 *  entries are in (2: the library's — slugs, own files apart from uses). */
interface LibraryFile {
  items?: NamedComponent[];
  sweptAt?: number;
  dir?: string;
  version?: number;
}

const VERSION = 2;

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

/** Regex-safe, and forgiving about the spacing between words. */
function pattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // \b would refuse to fire on a name that starts or ends in punctuation
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu");
}

export class ComponentStore {
  private readonly data = new Map<string, NamedComponent[]>();
  /** When each project's repo was last swept — the sweep reads only what
   *  has been touched since, so pressing the button again is nearly free. */
  private readonly swept = new Map<string, number>();
  /** The folder each project's `ruri add` copies into. */
  private readonly dirs = new Map<string, string>();

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
    } catch (err) {
      if (!isMissing(err)) warn("components", err, "load");
      items = [];
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
      writeJsonAtomic(
        path.join(componentsDir(), `${projectId}.json`),
        {
          version: VERSION,
          items: this.data.get(projectId) ?? [],
          ...(sweptAt ? { sweptAt } : {}),
          ...(dir ? { dir } : {}),
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

  /** Add one, or fold it into the entry of the same name if there is one —
   *  a component built twice is one component with better notes. */
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
    },
  ): NamedComponent {
    const name = input.name.trim();
    const items = this.load(projectId);
    const wantedSlug = input.slug?.trim() ? slugify(input.slug) : undefined;
    // the same name is the same component; a handle already taken by
    // another only means this one gets a number on its own
    const existing = items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    // a file given with a line is a place it reaches, not its own code
    const split = input.files
      ? splitFiles(input.files, wantedSlug ?? slugify(name), input.uses, input.exact)
      : undefined;
    if (existing) {
      if (split?.files.length) existing.files = [...new Set([...existing.files, ...split.files])];
      if (split?.uses?.length) existing.uses = [...new Set([...(existing.uses ?? []), ...split.uses])];
      if (input.tags?.length) existing.tags = [...new Set([...(existing.tags ?? []), ...input.tags])];
      if (input.deps?.length) existing.deps = [...new Set([...(existing.deps ?? []), ...input.deps])];
      if (input.note?.trim()) existing.note = input.note.trim();
      if (input.selector?.trim()) existing.selector = input.selector.trim();
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
      ...(input.deps?.length ? { deps: input.deps } : {}),
      note: input.note?.trim() ?? "",
      shots: [],
      ...(input.selector?.trim() ? { selector: input.selector.trim() } : {}),
      ...(input.route?.trim() ? { route: input.route.trim() } : {}),
      ...(input.clicks?.length ? { clicks: input.clicks } : {}),
      ...(input.found ? { found: true } : {}),
      // everything arrives new, and wears a star until it has been looked at
      star: "just",
      ts: Date.now(),
    };
    this.load(projectId).push(item);
    this.save(projectId);
    return item;
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
  ): boolean {
    const items = this.load(projectId);
    const item = items.find((i) => i.id === componentId);
    if (!item) return false;
    const clean = (list: string[]) => [...new Set(list.map((v) => v.trim()).filter(Boolean))];
    if (patch.name !== undefined && patch.name.trim()) item.name = patch.name.trim();
    if (patch.slug !== undefined && patch.slug.trim()) {
      item.slug = uniqueSlug(
        slugify(patch.slug),
        items.filter((i) => i !== item).map((i) => i.slug),
      );
    }
    if (patch.aliases !== undefined) item.aliases = clean(patch.aliases);
    if (patch.files !== undefined) item.files = clean(patch.files);
    const lists = { uses: patch.uses, tags: patch.tags, deps: patch.deps };
    for (const [key, value] of Object.entries(lists) as Array<[keyof typeof lists, string[] | undefined]>) {
      if (value === undefined) continue;
      const next = clean(value);
      if (next.length) item[key] = next;
      else delete item[key];
    }
    if (patch.note !== undefined) item.note = patch.note;
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

  addShot(projectId: string, componentId: string, shot: Attachment): boolean {
    const item = this.load(projectId).find((i) => i.id === componentId);
    if (!item) return false;
    item.shots = [...item.shots, shot];
    this.save(projectId);
    return true;
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
      "name for it, its handle, its files, and a picture. When the user names",
      "something here, this is what they mean — go straight to its files rather",
      "than searching for their words. Before building interface, look here",
      "first and reuse what exists: `ruri show <slug>` reads one with its code,",
      "`ruri add <slug>` copies it into place, `ruri help` says the rest.",
      "",
      "ruri maintains this file. Don't edit it by hand; it is rewritten whenever",
      "the library changes.",
      "",
      libraryListing(items),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "components.md"), body);
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
  /** Put the card up and wait. Resolves with the name kept, or null if the
   *  user waved it away. */
  propose(channelId: string, proposal: ComponentProposal): Promise<string | null>;
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
        "Put a piece of this project's interface you have just built or substantially changed into its component library, so the user can refer to it by name and later sessions can find and reuse it. Interface only — a screen, panel, card, control or dialog, never backend code. Shows the user a card with your suggested name and your screenshot of it; they edit the name and confirm. Call it once per component, right after you finish it.",
        {
          name: z
            .string()
            .describe(
              "Suggested name, in the words a user would use — 'the dragon gauges', not 'DragonGauge'",
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
              "Its own code: repo-relative paths of the files that make it up (what `ruri add` copies)",
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
              "Path to a picture of it — take one if you don't have one. The card shows this, " +
                "and a card without it asks the user to name something they cannot see. It is " +
                "kept with the entry, so later sessions can look at it too.",
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
          });
          return {
            content: [
              {
                type: "text",
                text: kept
                  ? `The user named it "${kept}". Call it that from now on.`
                  : "The user skipped naming this one.",
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

/** The components in the library a prompt actually names. */
export function mentionedIn(text: string, items: NamedComponent[]): NamedComponent[] {
  return items.filter((item) => names(item).some((name) => pattern(name).test(text)));
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
    ...matched.flatMap((item) => [...entryLines(item), ""]),
    "</ruri:components>",
  ].join("\n");
}
