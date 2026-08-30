import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Idea } from "../shared/protocol.js";

/**
 * The ideas board: one list per project of things the user wants, in their
 * own words.
 *
 * It is deliberately dumber than the tracker. Nothing writes here but the
 * user — no model, no extraction, no review pass — because the value of a
 * board like this is that everything on it was put there on purpose. An idea
 * is done or it isn't, and a done one stays visible with a line through it
 * until it's cleared.
 *
 * Keyed by PROJECT id (the tracker is keyed by session): an idea belongs to
 * the thing being built, not to whichever chat was open when it arrived.
 * Persisted under ~/.config/ruri/ideas/<projectId>.json.
 */

function ideasDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "ideas",
  );
}

export class IdeaStore {
  private readonly data = new Map<string, Idea[]>();

  private load(projectId: string): Idea[] {
    let items = this.data.get(projectId);
    if (items) return items;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(ideasDir(), `${projectId}.json`), "utf8"),
      ) as { items?: Idea[] };
      items = Array.isArray(raw.items) ? raw.items : [];
    } catch {
      items = [];
    }
    this.data.set(projectId, items);
    return items;
  }

  private save(projectId: string): void {
    try {
      fs.mkdirSync(ideasDir(), { recursive: true });
      fs.writeFileSync(
        path.join(ideasDir(), `${projectId}.json`),
        JSON.stringify({ items: this.data.get(projectId) ?? [] }, null, 2),
      );
    } catch {
      // best-effort persistence
    }
  }

  items(projectId: string): Idea[] {
    return this.load(projectId);
  }

  add(projectId: string, text: string): Idea {
    const idea: Idea = { id: randomUUID(), text, done: false, ts: Date.now() };
    // newest first: a board is read from the top, and the thing just thought
    // of is the thing being thought about
    this.load(projectId).unshift(idea);
    this.save(projectId);
    return idea;
  }

  update(projectId: string, ideaId: string, patch: { text?: string; done?: boolean }): boolean {
    const idea = this.load(projectId).find((i) => i.id === ideaId);
    if (!idea) return false;
    if (patch.text !== undefined && patch.text.trim()) idea.text = patch.text.trim();
    if (patch.done !== undefined) idea.done = patch.done;
    this.save(projectId);
    return true;
  }

  remove(projectId: string, ideaId: string): void {
    this.data.set(
      projectId,
      this.load(projectId).filter((i) => i.id !== ideaId),
    );
    this.save(projectId);
  }

  removeProject(projectId: string): void {
    this.data.delete(projectId);
    try {
      fs.rmSync(path.join(ideasDir(), `${projectId}.json`), { force: true });
    } catch {
      // best-effort
    }
  }

  all(projectIds: Iterable<string>): Record<string, Idea[]> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.items(id)]));
  }
}
