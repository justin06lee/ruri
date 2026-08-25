import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * Per-project session archive: the single source of truth for transcripts,
 * turn summaries, and the resumable Claude session id — persisted under
 * ~/.config/ruri/sessions/<projectId>.json so nothing is lost across app
 * restarts and compaction can be instant (summaries are precomputed).
 */

interface ArchiveData {
  events: TranscriptEvent[];
  /** Turn summaries keyed by the turn's opening user-event id. */
  summaries: Record<string, string>;
  lastSessionId?: string;
}

function archiveDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "sessions",
  );
}

const WRITE_DELAY_MS = 500;

export class SessionArchive {
  private readonly data = new Map<string, ArchiveData>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private load(projectId: string): ArchiveData {
    let entry = this.data.get(projectId);
    if (entry) return entry;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(archiveDir(), `${projectId}.json`), "utf8"),
      ) as Partial<ArchiveData>;
      entry = {
        events: Array.isArray(raw.events) ? raw.events : [],
        summaries: raw.summaries && typeof raw.summaries === "object" ? raw.summaries : {},
        ...(typeof raw.lastSessionId === "string" ? { lastSessionId: raw.lastSessionId } : {}),
      };
    } catch {
      entry = { events: [], summaries: {} };
    }
    this.data.set(projectId, entry);
    return entry;
  }

  private scheduleWrite(projectId: string): void {
    if (this.timers.has(projectId)) return;
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        this.flush(projectId);
      }, WRITE_DELAY_MS),
    );
  }

  private flush(projectId: string): void {
    const entry = this.data.get(projectId);
    if (!entry) return;
    try {
      fs.mkdirSync(archiveDir(), { recursive: true });
      fs.writeFileSync(
        path.join(archiveDir(), `${projectId}.json`),
        JSON.stringify(entry, null, 2),
      );
    } catch {
      // persistence is best-effort; in-memory state stays correct
    }
  }

  events(projectId: string): TranscriptEvent[] {
    return this.load(projectId).events;
  }

  append(projectId: string, event: TranscriptEvent): void {
    this.load(projectId).events.push(event);
    this.scheduleWrite(projectId);
  }

  summaries(projectId: string): Record<string, string> {
    return this.load(projectId).summaries;
  }

  setSummary(projectId: string, turnId: string, summary: string): void {
    this.load(projectId).summaries[turnId] = summary;
    this.scheduleWrite(projectId);
  }

  lastSessionId(projectId: string): string | undefined {
    return this.load(projectId).lastSessionId;
  }

  setLastSessionId(projectId: string, sessionId: string): void {
    this.load(projectId).lastSessionId = sessionId;
    this.scheduleWrite(projectId);
  }

  /** Forget a removed project entirely (memory + file). */
  remove(projectId: string): void {
    this.data.delete(projectId);
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    try {
      fs.rmSync(path.join(archiveDir(), `${projectId}.json`), { force: true });
    } catch {
      // best-effort
    }
  }

  /** Transcripts for a set of projects (used for the connect snapshot). */
  transcripts(projectIds: Iterable<string>): Record<string, TranscriptEvent[]> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.events(id)]));
  }

  allSummaries(projectIds: Iterable<string>): Record<string, Record<string, string>> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.summaries(id)]));
  }

  flushAll(): void {
    for (const [projectId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(projectId);
      this.flush(projectId);
    }
  }
}
