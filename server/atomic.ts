import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Files written beside and renamed over, so a crash mid-write leaves the
 * last good file rather than half of this one. The temp name carries the
 * pid and a random tail: two ruris (or two flushes) writing the same file
 * never trip over one temp file.
 */

function tempName(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

function finish(tmp: string, file: string): void {
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Write `text` to `file` atomically, creating the directory if need be. */
export function writeTextAtomic(file: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  // the mode lands on the fresh temp file, which is the file once renamed
  fs.writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  finish(tmp, file);
}

/** Write `value` as JSON atomically (`space` as for JSON.stringify). */
export function writeJsonAtomic(file: string, value: unknown, space?: number, mode?: number): void {
  writeTextAtomic(file, JSON.stringify(value, null, space), mode);
}

/**
 * The async twin: the bytes go out off the main thread, but the rename is
 * synchronous on purpose — the caller decides on the main thread whether
 * this write is still the newest, and nothing can slip in between that
 * decision and the rename. `stale` says whether to discard instead.
 */
export async function writeTextAtomicAsync(
  file: string,
  text: string,
  stale: () => boolean = () => false,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  await fs.promises.writeFile(tmp, text);
  if (stale()) {
    fs.rmSync(tmp, { force: true });
    return;
  }
  finish(tmp, file);
}
