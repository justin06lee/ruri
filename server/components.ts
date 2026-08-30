import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ComponentProposal, Attachment, NamedComponent } from "../shared/protocol.js";
import { storedFilePath } from "./uploads.js";

/**
 * The component index: the user's own names for the parts of a project, and
 * what each one is in the code.
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
 * The index reaches the model two ways, both harness-neutral:
 *
 *  - as a file. `.ruri/components.md` is rewritten inside the project
 *    whenever the index changes, so any harness at all can read the whole
 *    thing with the tools it already has.
 *  - as prompt context. A prompt that names an indexed component carries
 *    that component's entry down with it — files, note, screenshot paths —
 *    on the model's copy only, so the transcript still shows what the user
 *    actually typed.
 *
 * Kept per PROJECT id under ~/.config/ruri/components/<projectId>.json.
 */

function componentsDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "components",
  );
}

/** Every name an entry answers to. */
function names(item: NamedComponent): string[] {
  return [item.name, ...item.aliases].map((n) => n.trim()).filter(Boolean);
}

/** Regex-safe, and forgiving about the spacing between words. */
function pattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // \b would refuse to fire on a name that starts or ends in punctuation
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu");
}

export class ComponentStore {
  private readonly data = new Map<string, NamedComponent[]>();

  private load(projectId: string): NamedComponent[] {
    let items = this.data.get(projectId);
    if (items) return items;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(componentsDir(), `${projectId}.json`), "utf8"),
      ) as { items?: NamedComponent[] };
      items = (Array.isArray(raw.items) ? raw.items : []).map((item) => ({
        ...item,
        aliases: Array.isArray(item.aliases) ? item.aliases : [],
        files: Array.isArray(item.files) ? item.files : [],
        shots: Array.isArray(item.shots) ? item.shots : [],
        note: typeof item.note === "string" ? item.note : "",
      }));
    } catch {
      items = [];
    }
    this.data.set(projectId, items);
    return items;
  }

  private save(projectId: string): void {
    try {
      fs.mkdirSync(componentsDir(), { recursive: true });
      fs.writeFileSync(
        path.join(componentsDir(), `${projectId}.json`),
        JSON.stringify({ items: this.data.get(projectId) ?? [] }, null, 2),
      );
    } catch {
      // best-effort persistence
    }
  }

  items(projectId: string): NamedComponent[] {
    return this.load(projectId);
  }

  /** Add one, or fold it into the entry of the same name if there is one —
   *  a component built twice is one component with better notes. */
  add(
    projectId: string,
    input: { name: string; files?: string[]; note?: string },
  ): NamedComponent {
    const name = input.name.trim();
    const existing = this.load(projectId).find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (input.files?.length) {
        existing.files = [...new Set([...existing.files, ...input.files])];
      }
      if (input.note?.trim()) existing.note = input.note.trim();
      this.save(projectId);
      return existing;
    }
    const item: NamedComponent = {
      id: randomUUID(),
      name,
      aliases: [],
      files: input.files ?? [],
      note: input.note?.trim() ?? "",
      shots: [],
      ts: Date.now(),
    };
    this.load(projectId).push(item);
    this.save(projectId);
    return item;
  }

  update(
    projectId: string,
    componentId: string,
    patch: { name?: string; aliases?: string[]; files?: string[]; note?: string },
  ): boolean {
    const item = this.load(projectId).find((i) => i.id === componentId);
    if (!item) return false;
    if (patch.name !== undefined && patch.name.trim()) item.name = patch.name.trim();
    if (patch.aliases !== undefined) item.aliases = patch.aliases.map((a) => a.trim()).filter(Boolean);
    if (patch.files !== undefined) item.files = patch.files.map((f) => f.trim()).filter(Boolean);
    if (patch.note !== undefined) item.note = patch.note;
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
    } catch {
      // best-effort
    }
  }

  all(projectIds: Iterable<string>): Record<string, NamedComponent[]> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.items(id)]));
  }
}

/**
 * The project's `.ruri/` folder, made and kept out of its git history.
 *
 * ruri writes into the user's repository — a catch-up brief, a component
 * index — because a file is the one interface every harness has. It has no
 * business showing up in their `git status` for it, so the folder ignores
 * itself: one `.gitignore` saying `*`, written once, and git never mentions
 * any of it again.
 */
export function ruriDir(projectDir: string): string {
  const dir = path.join(projectDir, ".ruri");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return dir;
}

/** Where an attachment's bytes actually sit, for a model that wants to look. */
function shotPaths(shots: Attachment[]): string[] {
  return shots.flatMap((shot) => (shot.url ? [storedFilePath(shot.url)] : []));
}

/** One entry, written out the way the model should read it. */
function entryLines(item: NamedComponent): string[] {
  const lines = [`## ${item.name}`];
  if (item.aliases.length) lines.push(`Also called: ${item.aliases.join(", ")}`);
  if (item.files.length) lines.push(`In the code: ${item.files.join(", ")}`);
  if (item.note.trim()) lines.push(item.note.trim());
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

/**
 * Rewrite `<project>/.ruri/components.md`. Every harness can read a file;
 * none of them can read ruri's config dir and know what it means.
 *
 * An empty index removes the file rather than leaving an empty one behind —
 * a stale index is worse than no index.
 */
export function writeIndexFile(projectDir: string, items: NamedComponent[]): void {
  const file = path.join(projectDir, ".ruri", "components.md");
  try {
    if (items.length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    ruriDir(projectDir);
    const body = [
      "# Component index",
      "",
      "The user's own names for parts of this project, and what each one is.",
      "When they name something here, this is what they mean — go straight to",
      "the files listed rather than searching for the words they used.",
      "",
      "ruri maintains this file. Don't edit it by hand; it is rewritten whenever",
      "the index changes.",
      "",
      ...items.flatMap((item) => [...entryLines(item), ""]),
    ].join("\n");
    fs.writeFileSync(file, body);
  } catch {
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

/** The in-process MCP server a Claude project session gets. */
export function componentTools(host: ComponentHost, channelId: string) {
  return createSdkMcpServer({
    name: "ruri",
    version: "1.0.0",
    tools: [
      tool(
        "name_component",
        "Register a piece of this project's interface you have just built or substantially changed, so the user can refer to it by name from now on. Shows them a card with your suggested name and your screenshot of it; they edit the name and confirm. Call it once per component, right after you finish it.",
        {
          name: z
            .string()
            .describe("Suggested name, in the words a user would use — 'the dragon gauges', not 'DragonGauge'"),
          files: z
            .array(z.string())
            .describe("Where it lives: repo-relative paths, optionally with :line"),
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
        "List the parts of this project the user has named, with where each one lives. Use it when they refer to something by a name you don't recognise, or when they ask what exists.",
        {},
        async () => ({
          content: [
            {
              type: "text",
              text:
                host
                  .list(channelId)
                  .map((item) => entryLines(item).join("\n"))
                  .join("\n\n") || "(nothing named yet)",
            },
          ],
        }),
      ),
    ],
  });
}

/**
 * The same thing for harnesses that can't hold ruri's tools: a drop file.
 * One JSON object per line in `.ruri/components.jsonl`, applied and cleared
 * when the turn ends — the same convention Home already uses for opening
 * projects, so there is one pattern to learn rather than two.
 */
export function drainComponentRequests(
  projectDir: string,
  channelId: string,
  host: ComponentHost,
): void {
  const file = path.join(projectDir, ".ruri", "components.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // a repeat next turn is harmless — the card is the user's to dismiss
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const req = JSON.parse(trimmed) as Partial<ComponentProposal>;
      if (!req.name) continue;
      void host.propose(channelId, {
        name: req.name,
        files: Array.isArray(req.files) ? req.files : [],
        note: typeof req.note === "string" ? req.note : "",
        ...(req.shot ? { shot: req.shot } : {}),
      });
    } catch {
      // not JSON — skip the line
    }
  }
}

/** What a non-Claude session is told about naming things. */
export function componentDropBriefing(projectDir: string): string {
  return [
    "<ruri:naming>",
    "When you build or substantially change a piece of this project's interface, register it so the user can refer to it by name afterwards.",
    `Append one JSON line to ${path.join(projectDir, ".ruri", "components.jsonl")} (create it if missing):`,
    '  {"name": "the words a user would use for it", "files": ["path/to/file.tsx:40"], "note": "one line on what it is", "shot": "/path/to/a/screenshot.png"}',
    "ruri reads and clears that file when your turn ends, and shows the user a card to confirm or rename. Do it once per component, and suggest the name they would use — 'the dragon gauges', not 'DragonGauge'.",
    "Include the shot whenever the thing is something you can see: the card shows it, so without one you are asking the user to name something they cannot see. ruri keeps its own copy with the entry, and later sessions can read it back.",
    "</ruri:naming>",
  ].join("\n");
}

/** The indexed components a prompt actually names. */
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
    "The prompt above names parts of this project that are in its component index:",
    "",
    ...matched.flatMap((item) => [...entryLines(item), ""]),
    "</ruri:components>",
  ].join("\n");
}
