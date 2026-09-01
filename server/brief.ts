import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ruriDir } from "./components.js";
import { storedFilePath } from "./uploads.js";
import type { Attachment } from "../shared/protocol.js";

/**
 * The catch-up brief: what a project is and what's in it, in as few lines as
 * it can be said.
 *
 * It exists for the model that has never seen this project — a fresh
 * session, a harness you just switched to, an agent joining halfway. Handing
 * it the transcript would cost thousands of tokens and bury the shape of the
 * thing; the brief is a paragraph and a list of one-liners, plus whatever
 * screenshots you've pinned to it, and it reads in seconds.
 *
 * It writes itself: the small model folds each finished turn in, merging
 * what belongs together rather than growing a changelog.
 *
 * It is not a page the user opens — it never was for them. It is written
 * into each project as `.ruri/catchup.md`, and the session is told the file
 * is there; a model that finds itself in a project it doesn't know reads it
 * and stops guessing. Nothing costs context until something reads it.
 */

/**
 * A project's catch-up brief: what it is, what's in it, and what it looks
 * like. Server-side only — it never crosses the wire, because the UI has
 * nothing to do with it.
 */
export interface ProjectBrief {
  /** One sentence: what this project is. */
  description: string;
  /** One line per capability, merged as hard as they will merge. */
  features: string[];
  /** Pinned screenshots — the main pages, however many that takes. */
  shots: Attachment[];
  /** When the written half last changed. */
  updated?: number;
}

function briefsFile(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "briefs.json",
  );
}

const EMPTY: ProjectBrief = { description: "", features: [], shots: [] };

export class BriefStore {
  private readonly briefs = new Map<string, ProjectBrief>();

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(briefsFile(), "utf8")) as Record<string, ProjectBrief>;
      for (const [projectId, brief] of Object.entries(raw)) {
        if (!brief || typeof brief !== "object") continue;
        this.briefs.set(projectId, {
          description: typeof brief.description === "string" ? brief.description : "",
          features: Array.isArray(brief.features) ? brief.features : [],
          shots: Array.isArray(brief.shots) ? brief.shots : [],
          ...(typeof brief.updated === "number" ? { updated: brief.updated } : {}),
        });
      }
    } catch {
      // first run, or a file worth starting over from
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(briefsFile()), { recursive: true });
      fs.writeFileSync(briefsFile(), JSON.stringify(Object.fromEntries(this.briefs), null, 2));
    } catch {
      // best-effort persistence
    }
  }

  get(projectId: string): ProjectBrief {
    return this.briefs.get(projectId) ?? EMPTY;
  }

  /** Replace the written half; the pinned screenshots stay as they are. */
  write(projectId: string, description: string, features: string[]): ProjectBrief {
    const brief: ProjectBrief = {
      ...this.get(projectId),
      description,
      features,
      updated: Date.now(),
    };
    this.briefs.set(projectId, brief);
    this.save();
    return brief;
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

  /** A forked session starts with its parent's brief. */
  copy(from: string, to: string): void {
    const brief = this.briefs.get(from);
    if (!brief) return;
    this.briefs.set(to, { ...brief, features: [...brief.features], shots: [...brief.shots] });
    this.save();
  }
}

/**
 * The brief as the model reads it — the format is the point: a header it can
 * parse at a glance, then one line per thing the project does.
 */
export function briefText(name: string, brief: ProjectBrief): string {
  const lines = [
    `# ${name} — catch-up`,
    "",
    "The whole shape of this project, for a model that has never seen it.",
    "ruri writes this file; don't edit it by hand.",
    "",
  ];
  if (brief.description) lines.push(brief.description, "");
  if (brief.features.length) {
    lines.push("## What's in it", "");
    for (const feature of brief.features) lines.push(`- ${feature}`);
    lines.push("");
  }
  const shots = brief.shots.flatMap((shot) => (shot.url ? [storedFilePath(shot.url)] : []));
  if (shots.length) {
    lines.push("## What it looks like", "");
    for (const shot of shots) lines.push(`- ${shot}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Put the brief where the model can reach it: `<project>/.ruri/catchup.md`.
 *
 * A file, rather than a tool or an injected paragraph, because every harness
 * ruri drives can read a file and only some of them can do anything else —
 * and because a file costs nothing until it is opened. An empty brief takes
 * the file away rather than leaving a stale one to be believed.
 */
export function writeCatchupFile(projectDir: string, name: string, brief: ProjectBrief): void {
  const file = path.join(projectDir, ".ruri", "catchup.md");
  try {
    if (!brief.description && brief.features.length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    ruriDir(projectDir);
    fs.writeFileSync(file, briefText(name, brief));
  } catch {
    // a read-only project directory is not worth failing a turn over
  }
}
