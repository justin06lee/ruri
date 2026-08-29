import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Attachment, ProjectBrief } from "../shared/protocol.js";

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
 * what belongs together rather than growing a changelog. Editing it by hand
 * is the same thing as writing it — the file is the truth either way.
 */

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

  all(projectIds: string[]): Record<string, ProjectBrief> {
    return Object.fromEntries(
      projectIds.filter((id) => this.briefs.has(id)).map((id) => [id, this.get(id)]),
    );
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
}

/**
 * The brief as the model reads it — the format is the point: a header it can
 * parse at a glance, then one line per thing the project does.
 */
export function briefPrompt(name: string, brief: ProjectBrief): string {
  const lines = [
    "Catching you up on this project before we start. This is the whole shape of it:",
    "",
    `Project: ${name}`,
  ];
  if (brief.description) lines.push(`Description: ${brief.description}`);
  if (brief.features.length) {
    lines.push("");
    for (const feature of brief.features) lines.push(`- ${feature}`);
  }
  if (brief.shots.length) {
    lines.push("");
    lines.push(
      brief.shots.length === 1
        ? "The image is what it looks like."
        : `The ${brief.shots.length} images are what it looks like.`,
    );
  }
  lines.push("");
  lines.push("Read it, look around the code if you need to, and say you're ready.");
  return lines.join("\n");
}
