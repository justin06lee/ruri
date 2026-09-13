/**
 * The launch sweep for what closed sessions left (server/orphans.ts): a
 * session or project no longer in projects.json loses its files, a live one
 * and Home keep theirs, and anything touched in the last ten minutes stays.
 *
 *   bun run orphans-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-orphans-"));
process.env["RURI_CONFIG_DIR"] = root;
const { sweepOrphans } = await import("../server/orphans.js");

const live = "11111111-1111-4111-8111-111111111111";
const gone = "22222222-2222-4222-8222-222222222222";
const fresh = "33333333-3333-4333-8333-333333333333";
const project = "44444444-4444-4444-8444-444444444444";
fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ projects: [{ id: project, sessions: [{ id: live }] }] }));
const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
function put(rel: string, dir = false, recent = false): string {
  const full = path.join(root, rel);
  fs.mkdirSync(dir ? full : path.dirname(full), { recursive: true });
  if (!dir) fs.writeFileSync(full, "x");
  if (!recent) fs.utimesSync(full, old, old);
  return full;
}
const keep = [put(`sessions/${live}.json`), put(`history/${live}.jsonl`), put(`turns/${live}`, true), put("sessions/home.json"), put(`checkpoints/${project}.index`), put(`sessions/${fresh}.json`, false, true)];
const drop = [put(`sessions/${gone}.json`), put(`history/${gone}.jsonl`), put(`turns/${gone}`, true), put(`bridge/${gone}`, true), put(`checkpoints/${gone}.index`)];

const removed = sweepOrphans();
let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
};
check("a closed session's files all go", drop.every((f) => !fs.existsSync(f)) && removed === drop.length);
check("a live session, its project, Home, and a fresh file stay", keep.every((f) => fs.existsSync(f)));
fs.writeFileSync(path.join(root, "projects.json"), "{ not json");
check("an unreadable projects.json removes nothing", sweepOrphans() === 0 && keep.every((f) => fs.existsSync(f)));

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all good");
