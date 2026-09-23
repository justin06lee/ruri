import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "./configDir.js";
import { removeRuriFile, ruriDir } from "./ruriDir.js";
import { storedFilePath } from "./uploads.js";
import type { Attachment, ProjectMemory, ProjectSheet, StackLayer, SystemFlow } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";

/**
 * What ruri knows about a project as a whole, for the model that has never
 * seen it — a fresh session, a harness you just switched to, an agent
 * joining halfway. Handing it the transcript would cost thousands of tokens
 * and bury what matters; this is two short files it reads in seconds.
 *
 * Two, because a project is two different things to someone joining it:
 *
 *  - its SHAPE — `.ruri/architecture.md`: what it is and who it's for, the
 *    stack as layers from what a person touches down to the engines under
 *    it, the paths through it that matter, what it can do, where things
 *    are, how to run it, the rules it lives by. Written from a read of the
 *    repo (server/catchup.ts), and folded forward from finished turns.
 *  - where the WORK stands — `.ruri/catchup.md`: what was decided and why,
 *    what worked, what was tried and failed and why, the traps, and what is
 *    still open. The part nobody can read off the code, and the part a new
 *    session most needs not to relearn. Gathered from every chat in the
 *    project as its turns finish, so a chat opened tomorrow knows what one
 *    closed today found out; seeded once from the chats' histories
 *    (server/memory.ts).
 *
 * Neither is a changelog. The small model merges what belongs together and
 * drops what stopped mattering, so both stay a screen long however long
 * the project runs.
 *
 * They are written into each project, and the session is told the files
 * are there; nothing costs context until something reads them. The
 * architecture page shows the user the same thing.
 */

/** A project's sheet, server-side: the same thing the page shows. */
export type ProjectBrief = ProjectSheet;

/** The keys a write of the shape may set; anything else stays. */
export type BriefWrite = Pick<ProjectBrief, "description" | "features"> &
  Partial<Pick<ProjectBrief, "layers" | "flows" | "run" | "layout" | "conventions">>;

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
  return value.filter(
    (l): l is StackLayer => !!l && typeof l === "object" && typeof (l as StackLayer).name === "string",
  );
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

function memoryOf(value: unknown): ProjectMemory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    now: list(raw["now"]) ?? [],
    decisions: list(raw["decisions"]) ?? [],
    worked: list(raw["worked"]) ?? [],
    failed: list(raw["failed"]) ?? [],
    gotchas: list(raw["gotchas"]) ?? [],
    open: list(raw["open"]) ?? [],
  };
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
        const memory = memoryOf(brief.memory);
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
          ...(memory ? { memory } : {}),
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
    const brief: ProjectBrief = {
      ...(built && next.layers?.length ? kept : this.get(projectId)),
      ...next,
      updated: Date.now(),
      ...(built ? { built: Date.now() } : {}),
    };
    this.briefs.set(projectId, brief);
    this.save();
    return brief;
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
 * The shape as the model reads it: the stack numbered from the top, each
 * flow one line of arrows — the form is the point, read at a glance.
 */
export function architectureText(name: string, brief: ProjectBrief): string {
  const lines = [
    `# ${name} — architecture`,
    "",
    "The shape of this project, for a model that has never seen it: what it is, the stack it is built as, how the parts connect, where things are, how to run it. Where the work stands — decisions, what worked and what didn't, what's open — is in catchup.md beside this file.",
    "ruri writes this file; don't edit it by hand.",
    "",
  ];
  if (brief.description) lines.push(brief.description, "");
  if (brief.layers?.length) {
    lines.push("## The stack, top to bottom", "");
    brief.layers.forEach((layer, i) => {
      lines.push(
        `${i + 1}. **${layer.name}**${layer.what ? ` — ${layer.what}` : ""}${layer.where ? ` (\`${layer.where}\`)` : ""}`,
      );
    });
    lines.push("");
  } else section(lines, "Stack", brief.stack);
  if (brief.flows?.length) {
    lines.push("## How it flows", "");
    for (const flow of brief.flows) lines.push(`- **${flow.name}:** ${flow.steps.join(" → ")}`);
    lines.push("");
  }
  section(lines, "What it does", brief.features);
  section(lines, "Where things are", brief.layout);
  section(lines, "How to run it", brief.run);
  section(lines, "Conventions", brief.conventions);
  const shots = brief.shots.flatMap((shot) => (shot.url ? [storedFilePath(shot.url)] : []));
  section(lines, "What it looks like", shots);
  return lines.join("\n");
}

/** The working memory as the model reads it. */
export function catchupText(name: string, brief: ProjectBrief): string {
  const lines = [
    `# ${name} — catch-up`,
    "",
    "Where the work on this project stands, for a model picking it up cold: what was decided and why, what worked, what was tried and failed and why, the traps, and what's still open — gathered from every chat in this project as its turns finish. Read it before you start, and don't redo a settled decision or retry what already failed without a new reason. The project's shape (the stack, how it fits together, where things are, how to run it) is in architecture.md beside this file.",
    "ruri writes this file; don't edit it by hand.",
    "",
  ];
  if (brief.description) lines.push(brief.description, "");
  const memory = brief.memory;
  if (!memory || Object.values(memory).every((part) => part.length === 0)) {
    lines.push("Nothing has been gathered from the work yet.", "");
    return lines.join("\n");
  }
  section(lines, "Where it stands", memory.now);
  section(lines, "Decisions, and why", memory.decisions);
  section(lines, "What worked", memory.worked);
  section(lines, "What didn't, and why", memory.failed);
  section(lines, "Gotchas and rules", memory.gotchas);
  section(lines, "Still open", memory.open);
  return lines.join("\n");
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
export function writeBriefFiles(projectDir: string, name: string, brief: ProjectBrief): void {
  try {
    const dir = brief.description || brief.features.length > 0 ? ruriDir(projectDir) : undefined;
    if (!dir) {
      removeRuriFile(projectDir, "catchup.md");
      removeRuriFile(projectDir, "architecture.md");
      return;
    }
    fs.writeFileSync(path.join(dir, "architecture.md"), architectureText(name, brief));
    fs.writeFileSync(path.join(dir, "catchup.md"), catchupText(name, brief));
  } catch (err) {
    warn("brief", err, "writeBriefFiles");
    // a read-only project directory is not worth failing a turn over
  }
}
