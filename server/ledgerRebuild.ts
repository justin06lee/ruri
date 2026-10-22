import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { dayOf, type LedgerStore } from "./ledger.js";
import { warn } from "./log.js";
import { priceUsage, type CallUsage } from "./turnCost.js";

/**
 * The ledger's past dollars, rebuilt from the Claude CLI's own transcripts.
 *
 * Until turnCost.ts each turn's cost was its CLI's running total, so every
 * day the ledger kept before then reads several times too high. Here each
 * model call in a transcript is priced once (by its message id) and put in
 * its project's day. Only ruri's own chats count: their session ids are in
 * the archive (sessions/<chat id>.json), and a chat's project is the one
 * that lists it, or for a chat no project lists any more, the one whose
 * folder the transcript sits under. Runs once, in the background, after
 * the first launch that has not done it.
 */

export interface RebuildSources {
  /** The CLI's transcripts: ~/.claude/projects, one folder per working folder */
  transcripts: string;
  /** ruri's archive: one <chat id>.json per chat, with its session ids */
  archive: string;
  /** Every project, with its folder and its chats */
  projects: { id: string; path: string; sessions: { id: string }[] }[];
  /** Calls from this instant on are the ledger's own, already right */
  before: number;
}

/** The folder a working folder's transcripts go in under ~/.claude/projects:
 *  its path, with each character that is not a letter or a digit a dash. */
export function transcriptFolder(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** project id → local day → dollars, from every transcript of ruri's chats. */
export async function transcriptCosts(src: RebuildSources): Promise<Map<string, Map<string, number>>> {
  const chatProject = new Map<string, string>();
  const folderProject = new Map<string, string>();
  for (const project of src.projects) {
    folderProject.set(transcriptFolder(project.path), project.id);
    for (const chat of project.sessions) chatProject.set(chat.id, project.id);
  }
  // session id → its chat's project, or null for a chat no project lists
  const sessionProject = new Map<string, string | null>();
  for (const name of list(src.archive)) {
    if (!name.endsWith(".json")) continue;
    let raw: { sessionIds?: unknown; lastSessionId?: unknown };
    try {
      raw = JSON.parse(fs.readFileSync(path.join(src.archive, name), "utf8")) as typeof raw;
    } catch {
      continue;
    }
    const owner = chatProject.get(name.slice(0, -".json".length)) ?? null;
    const ids = [...(Array.isArray(raw.sessionIds) ? raw.sessionIds : []), raw.lastSessionId];
    for (const id of ids) if (typeof id === "string") sessionProject.set(id, owner);
  }
  const costs = new Map<string, Map<string, number>>();
  const seen = new Set<string>();
  for (const folder of list(src.transcripts)) {
    const dir = path.join(src.transcripts, folder);
    for (const name of list(dir)) {
      const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
      if (!sessionProject.has(id)) continue;
      const projectId = sessionProject.get(id) ?? folderProject.get(folder);
      if (!projectId) continue;
      // the session's own transcript, or the folder of its subagents' beside it
      const files = name.endsWith(".jsonl")
        ? [path.join(dir, name)]
        : list(path.join(dir, name, "subagents"))
            .filter((file) => file.endsWith(".jsonl"))
            .map((file) => path.join(dir, name, "subagents", file));
      for (const file of files) await addFile(file, projectId, src.before, seen, costs);
    }
  }
  return costs;
}

async function addFile(
  file: string,
  projectId: string,
  before: number,
  seen: Set<string>,
  costs: Map<string, Map<string, number>>,
): Promise<void> {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let row: { timestamp?: string; message?: { id?: string; model?: string; usage?: CallUsage } };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const message = row.message;
    // one call is written once per content block, each line with its usage
    if (!message?.usage || !message.id || seen.has(message.id)) continue;
    const ts = Date.parse(row.timestamp ?? "");
    if (!Number.isFinite(ts) || ts >= before) continue;
    const dollars = priceUsage(message.usage, message.model);
    if (dollars === undefined) continue;
    seen.add(message.id);
    const days = costs.get(projectId) ?? new Map<string, number>();
    const day = dayOf(ts);
    days.set(day, (days.get(day) ?? 0) + dollars);
    costs.set(projectId, days);
  }
}

const DONE = "ledger-rebuilt.json";

/** After a launch, once: rebuilds the ledger's dollars from the transcripts
 *  and leaves a mark so it never runs again. A minute in, so it does not
 *  compete with the launch itself. */
export function rebuildLedgerOnce(ledger: LedgerStore, delayMs = 60_000): void {
  const mark = configPath(DONE);
  if (fs.existsSync(mark)) return;
  if (ledger.empty) {
    // nothing from before to put right
    writeJsonAtomic(mark, { at: Date.now() }, 1);
    return;
  }
  const before = Date.now();
  const claudeDir = process.env["CLAUDE_CONFIG_DIR"] || path.join(os.homedir(), ".claude");
  const timer = setTimeout(() => {
    let projects: RebuildSources["projects"] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(configPath("projects.json"), "utf8")) as {
        projects?: RebuildSources["projects"];
      };
      projects = (raw.projects ?? []).map((p) => ({ id: p.id, path: p.path, sessions: p.sessions ?? [] }));
    } catch (err) {
      warn("ledger", err, "rebuild: projects");
    }
    transcriptCosts({
      transcripts: path.join(claudeDir, "projects"),
      archive: configPath("sessions"),
      projects,
      before,
    })
      .then((costs) => {
        ledger.rebuildCosts(costs);
        writeJsonAtomic(mark, { at: Date.now(), before }, 1);
      })
      .catch((err: unknown) => warn("ledger", err, "rebuild"));
  }, delayMs);
  timer.unref();
}
