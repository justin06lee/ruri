import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/**
 * Where each exchange's full record is written (server/compaction.ts writes
 * them): ~/.config/ruri/turns/<chat>/<n>.md, `n` the exchange's number in
 * the chat (SessionArchive.exchangeNo). The number never moves, so a record
 * never has to be renamed — only taken away when a rewind takes its
 * exchange out of the conversation.
 */

export function turnsDir(channelId: string): string {
  return configPath("turns", channelId);
}

/** One exchange's record, by its number. */
export function turnRecordPath(channelId: string, n: number): string {
  return path.join(turnsDir(channelId), `${String(n).padStart(3, "0")}.md`);
}

/** The records of exchanges a rewind took out — they name nothing now. */
export function removeTurnRecords(channelId: string, numbers: Iterable<number>): void {
  for (const n of numbers) {
    try {
      fs.rmSync(turnRecordPath(channelId, n), { force: true });
    } catch (err) {
      if (!isMissing(err)) warn("turns", err, "removeTurnRecords");
      // a stale record only costs disk
    }
  }
}

/** One record's text, if it is on disk — what is left of an exchange the
 *  history's cap dropped. */
export function readTurnRecord(channelId: string, n: number): string | undefined {
  try {
    return fs.readFileSync(turnRecordPath(channelId, n), "utf8");
  } catch (err) {
    if (!isMissing(err)) warn("turns", err, "readTurnRecord");
    return undefined;
  }
}
