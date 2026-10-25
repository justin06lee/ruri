/**
 * Turns that were running when ruri closed or crashed, and carrying them
 * on at the next launch.
 *
 * Turns (server/turns.ts) is memory only, so the channels with a turn in
 * flight are also kept in `resume.json`: added when a turn starts, taken
 * out when it ends. A quit ends turns too, so the book is frozen as the
 * server closes (freezeResume) — what is in it then is what was at work.
 * At launch each channel in it gets one prompt telling it to carry on, and
 * the book starts over: a turn that dies the same way again is picked up
 * once per launch, never in a loop.
 */
import * as fs from "node:fs";
import { HOME_ID } from "../shared/protocol.js";
import { writeTextAtomic } from "./atomic.js";
import { channelProject } from "./channel.js";
import { configPath } from "./configDir.js";
import type { ServerContext } from "./context.js";
import { dispatch } from "./dispatch.js";
import { warn } from "./log.js";

/** The mark ruri's own prompts open with (see status.ts: ↻), and what it says. */
export const RESUME_PROMPT =
  "↻ ruri was closed while you were working and has started again. Carry on exactly where you left off: finish what the turn was doing when it stopped. Look at the files and the repo before you redo anything — what is already done stays done.";

let frozen = false;

function file(): string {
  return configPath("resume.json");
}

function read(): string[] {
  try {
    const ids: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: string[]): void {
  try {
    writeTextAtomic(file(), JSON.stringify(ids));
  } catch (err) {
    warn("resume", err, "writing the turns in flight");
  }
}

/** A turn started on this channel. */
export function markResume(channelId: string): void {
  if (frozen || channelId === HOME_ID) return;
  const ids = read();
  if (!ids.includes(channelId)) write([...ids, channelId]);
}

/** A turn ended on this channel (done, stopped, or failed — not the quit). */
export function clearResume(channelId: string): void {
  if (frozen) return;
  const ids = read();
  if (ids.includes(channelId)) write(ids.filter((id) => id !== channelId));
}

/** The server is closing: what ends now ends because of the quit. */
export function freezeResume(): void {
  frozen = true;
}

/** Launch: take the book and send each channel on. */
export function resumeTurns(ctx: ServerContext): number {
  const ids = read();
  if (ids.length === 0) return 0;
  write([]);
  let sent = 0;
  for (const id of ids) {
    const project = channelProject(ctx, id);
    if (!project || ctx.turns.progress.has(id)) continue;
    try {
      dispatch(ctx, id, RESUME_PROMPT, [], true);
      sent++;
    } catch (err) {
      warn("resume", err, `carrying on ${id}`);
    }
  }
  return sent;
}
