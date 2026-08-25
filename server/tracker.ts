import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TrackerItem, TrackerStatus } from "../shared/protocol.js";

/**
 * Feature/prompt tracker: a per-project checklist of things the user should
 * test by hand. Items arrive from the small model (one extraction per
 * finished turn) or manually from the UI, and persist under
 * ~/.config/ruri/tracker/<projectId>.json.
 */

function trackerDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "tracker",
  );
}

export class TrackerStore {
  private readonly data = new Map<string, TrackerItem[]>();

  private load(projectId: string): TrackerItem[] {
    let items = this.data.get(projectId);
    if (items) return items;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(trackerDir(), `${projectId}.json`), "utf8"),
      ) as { items?: TrackerItem[] };
      items = Array.isArray(raw.items) ? raw.items : [];
    } catch {
      items = [];
    }
    this.data.set(projectId, items);
    return items;
  }

  private save(projectId: string): void {
    try {
      fs.mkdirSync(trackerDir(), { recursive: true });
      fs.writeFileSync(
        path.join(trackerDir(), `${projectId}.json`),
        JSON.stringify({ items: this.data.get(projectId) ?? [] }, null, 2),
      );
    } catch {
      // best-effort persistence
    }
  }

  items(projectId: string): TrackerItem[] {
    return this.load(projectId);
  }

  /** Texts of not-yet-liked items — the dedupe context for extraction. */
  openTexts(projectId: string): string[] {
    return this.load(projectId)
      .filter((item) => item.status !== "liked")
      .map((item) => item.text);
  }

  add(projectId: string, text: string, source: "auto" | "manual", turnId?: string, note = ""): TrackerItem {
    const item: TrackerItem = {
      id: randomUUID(),
      text,
      note,
      status: "open",
      source,
      ...(turnId ? { turnId } : {}),
      ts: Date.now(),
    };
    this.load(projectId).push(item);
    this.save(projectId);
    return item;
  }

  update(
    projectId: string,
    itemId: string,
    patch: { status?: TrackerStatus; note?: string; text?: string },
  ): boolean {
    const item = this.load(projectId).find((i) => i.id === itemId);
    if (!item) return false;
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.note !== undefined) item.note = patch.note;
    if (patch.text !== undefined && patch.text.trim()) item.text = patch.text.trim();
    this.save(projectId);
    return true;
  }

  remove(projectId: string, itemId: string): void {
    this.data.set(
      projectId,
      this.load(projectId).filter((i) => i.id !== itemId),
    );
    this.save(projectId);
  }

  removeProject(projectId: string): void {
    this.data.delete(projectId);
    try {
      fs.rmSync(path.join(trackerDir(), `${projectId}.json`), { force: true });
    } catch {
      // best-effort
    }
  }

  all(projectIds: Iterable<string>): Record<string, TrackerItem[]> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.items(id)]));
  }
}
