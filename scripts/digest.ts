/**
 * The digest (server/compaction.ts): a compaction brief lists at most
 * BRIEF_LISTED exchanges, and the oldest past that are folded into one
 * condensed memory by the small model. No tokens — a scripted fold stands in
 * for the model, and a real archive runs in a scratch config dir:
 *   bun run digest-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { SessionArchive } from "../server/archive.js";
import {
  BRIEF_LISTED,
  buildCompaction,
  DigestFolder,
  dueForDigest,
  type FoldDigest,
} from "../server/compaction.js";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-digest-"));
process.env["RURI_CONFIG_DIR"] = configDir;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("    ", JSON.stringify(detail));
  }
}

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `u${from + i}`);

// ── what is due ─────────────────────────────────────────────────────
check(`${BRIEF_LISTED} listed exchanges are within the cap`, dueForDigest(ids(40), undefined).length === 0);
check(
  "one past it folds the oldest down to 30 left",
  dueForDigest(ids(41), undefined).join() === ids(11).join(),
);
check(
  "a digest's own exchanges are never due again",
  dueForDigest(ids(55), { text: "m", through: "u10" }).join() === ids(15, 11).join(),
);
check("a long chat's first fold takes at most 40", dueForDigest(ids(117), undefined).length === 40);

// ── the folder, on a real archive ───────────────────────────────────
const archive = new SessionArchive();
const channel = "digest-chat";
let clock = 1_000;
function exchange(n: number): void {
  const at = (clock += 10);
  archive.append(channel, { kind: "user", id: `u${n}`, text: `prompt number ${n}`, ts: at });
  archive.append(channel, { kind: "assistant", id: `a${n}`, text: `reply number ${n}`, ts: at + 1 });
  archive.append(channel, { kind: "result", id: `r${n}`, ok: true, ts: at + 2 } as TranscriptEvent);
  archive.setSummary(channel, `u${n}`, "user", `ask ${n}`);
  archive.setSummary(channel, `u${n}`, "reply", `did ${n}`);
}
for (let n = 1; n <= 95; n++) exchange(n);

const calls: number[][] = [];
let gate: (() => void) | null = null;
const fold: FoldDigest = async (memory, exchanges) => {
  calls.push(exchanges.map((e) => e.n));
  if (gate) await new Promise<void>((resolve) => (gate = resolve));
  return `${memory}${memory ? "\n" : ""}folded ${exchanges[0]!.n}-${exchanges[exchanges.length - 1]!.n}: ${exchanges.map((e) => e.user).join(", ")}`;
};
const folder = new DigestFolder(archive, fold);

await Promise.all([folder.run(channel), folder.run(channel)]);
check(
  "95 exchanges fold in two goes, 1–40 then 41–65",
  JSON.stringify(calls.map((c) => [c[0], c.at(-1)])) === "[[1,40],[41,65]]",
  calls.map((c) => [c[0], c.at(-1)]),
);
check("a second run at the same time adds nothing", calls.length === 2);
check("the digest ends on exchange 65", archive.digest(channel)?.through === "u65", archive.digest(channel));
check("and folds its notes, not raw text", archive.digest(channel)?.text.includes("ask 1, ask 2") === true);

const built = buildCompaction(
  channel,
  archive.allEvents(channel),
  archive.summaries(channel),
  archive.digest(channel),
);
check("the brief lists only the 30 after the digest", built?.entries.length === 30, built?.entries.length);
check(
  "numbered as in the whole conversation",
  built?.entries[0]?.n === 66 && built?.entries.at(-1)?.n === 95,
);
check(
  "the brief opens on the digest, naming the records",
  Boolean(
    built?.brief.includes("<condensed>") &&
    built.brief.includes("Exchanges 1–65") &&
    built.brief.includes("065.md"),
  ),
);
check(
  "the digest's exchanges are not listed again",
  !built?.brief.includes("\n1. user:") && Boolean(built?.brief.includes("\n66. user: ask 66")),
);
check("the mark carries the digest for the window", built?.digest?.through === 65);
check(
  "every exchange keeps its record on disk",
  fs.existsSync(path.join(configDir, "turns", channel, "095.md")),
);

calls.length = 0;
for (let n = 96; n <= 105; n++) exchange(n);
await folder.run(channel);
check(
  "40 listed after the digest is still within the cap",
  calls.length === 0 && archive.turnIds(channel).length === 105,
);
exchange(106);
await folder.run(channel);
check(
  "the 41st folds the oldest 11 back down to 30",
  JSON.stringify(calls) === JSON.stringify([ids(11, 66).map((id) => Number(id.slice(1)))]),
  calls,
);
check("and the digest keeps what it had", Boolean(archive.digest(channel)?.text.startsWith("folded 1-40")));

// a rewind back past the digest's end, while a fold is in flight
for (let n = 107; n <= 117; n++) exchange(n);
calls.length = 0;
gate = () => {};
const running = folder.run(channel);
await new Promise((resolve) => setTimeout(resolve, 20));
archive.truncateFrom(channel, "u70");
const release = gate as (() => void) | null;
gate = null;
release?.();
await running;
check(
  "a fold finishing after a rewind took its exchanges is dropped",
  archive.digest(channel) === undefined,
  archive.digest(channel),
);

// without a digest the brief is what it always was
const plain = buildCompaction(channel, archive.allEvents(channel), archive.summaries(channel), undefined);
check(
  "no digest: every exchange listed from 1",
  plain?.entries[0]?.n === 1 && !plain.brief.includes("<condensed>"),
);

archive.flushAll();
fs.rmSync(configDir, { recursive: true, force: true });
console.log(failed === 0 ? "all good" : `${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
