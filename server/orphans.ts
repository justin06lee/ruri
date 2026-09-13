import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * What closed sessions and projects left behind.
 *
 * Closing a session removes its transcript and turn files as it goes — but
 * not every version did, and not everything went: an archive, a history, a
 * session's turn records and bridge screenshots, a checkpoint index. Any of
 * those whose session (or project) is no longer in the workspace is
 * removed. The workspace is read straight from projects.json, hidden
 * projects included; nothing is removed unless that file reads cleanly, and
 * nothing touched in the last ten minutes (a session being made right now).
 * Home's own files are never candidates. Returns how many entries went.
 */
const RECENT_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export function sweepOrphans(): number {
  const root = process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri");
  let data: { projects?: Array<{ id?: unknown; sessions?: Array<{ id?: unknown }> }> };
  try {
    data = JSON.parse(fs.readFileSync(path.join(root, "projects.json"), "utf8")) as typeof data;
  } catch {
    return 0;
  }
  const projects = new Set<string>();
  const sessions = new Set<string>();
  for (const project of data.projects ?? []) {
    if (typeof project.id === "string") projects.add(project.id);
    for (const session of project.sessions ?? []) if (typeof session.id === "string") sessions.add(session.id);
  }
  if (projects.size === 0) return 0;

  const cutoff = Date.now() - RECENT_MS;
  let removed = 0;
  const sweep = (dir: string, idOf: (name: string) => string | undefined, known: (id: string) => boolean): void => {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, dir));
    } catch {
      return;
    }
    for (const name of names) {
      const id = idOf(name);
      if (!id || known(id)) continue;
      const full = path.join(root, dir, name);
      try {
        if (fs.statSync(full).mtimeMs > cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch {
        // gone already
      }
    }
  };
  const lead = (name: string) => UUID.exec(name)?.[0];
  const isSession = (id: string) => sessions.has(id);
  sweep("sessions", lead, isSession);
  sweep("history", lead, isSession);
  sweep("turns", lead, isSession);
  sweep("bridge", lead, isSession);
  sweep("checkpoints", (name) => (name.endsWith(".index") ? lead(name) : undefined), (id) => sessions.has(id) || projects.has(id));
  return removed;
}
