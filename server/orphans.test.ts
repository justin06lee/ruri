import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sweepOrphans } from "./orphans.js";

const LIVE = "11111111-1111-4111-8111-111111111111";
const GONE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

let root: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-orphans-"));
  process.env["RURI_CONFIG_DIR"] = root;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

/** A file (or directory) under the config dir, aged an hour unless told. */
function put(rel: string, { dir = false, fresh = false } = {}): string {
  const full = path.join(root, rel);
  fs.mkdirSync(dir ? full : path.dirname(full), { recursive: true });
  if (!dir) fs.writeFileSync(full, "{}");
  if (!fresh) {
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(full, hourAgo, hourAgo);
  }
  return full;
}

function workspace(): void {
  fs.writeFileSync(
    path.join(root, "projects.json"),
    JSON.stringify({ projects: [{ id: PROJECT, sessions: [{ id: LIVE }] }] }),
  );
}

test("what a session no longer in the workspace left is removed; the rest stays", () => {
  workspace();
  const keep = [put(`sessions/${LIVE}.json`), put(`history/${LIVE}.jsonl`), put(`turns/${LIVE}`, { dir: true })];
  const drop = [
    put(`sessions/${GONE}.json`),
    put(`history/${GONE}.jsonl`),
    put(`turns/${GONE}`, { dir: true }),
    put(`bridge/${GONE}-shot.png`),
  ];
  expect(sweepOrphans()).toBe(drop.length);
  for (const file of keep) expect(fs.existsSync(file)).toBe(true);
  for (const file of drop) expect(fs.existsSync(file)).toBe(false);
});

test("the id is read off the front of a name; names without one are never touched", () => {
  workspace();
  const notes = put("sessions/home.json");
  const readme = put("history/README");
  expect(sweepOrphans()).toBe(0);
  expect(fs.existsSync(notes)).toBe(true);
  expect(fs.existsSync(readme)).toBe(true);
});

test("checkpoint indexes answer to a session or a project, and only .index files count", () => {
  workspace();
  const bySession = put(`checkpoints/${LIVE}.index`);
  const byProject = put(`checkpoints/${PROJECT}.index`);
  const orphan = put(`checkpoints/${GONE}.index`);
  const other = put(`checkpoints/${GONE}.lock`);
  expect(sweepOrphans()).toBe(1);
  expect(fs.existsSync(bySession)).toBe(true);
  expect(fs.existsSync(byProject)).toBe(true);
  expect(fs.existsSync(orphan)).toBe(false);
  expect(fs.existsSync(other)).toBe(true);
});

test("anything touched in the last ten minutes is left: it may be a session being made", () => {
  workspace();
  const fresh = put(`sessions/${GONE}.json`, { fresh: true });
  expect(sweepOrphans()).toBe(0);
  expect(fs.existsSync(fresh)).toBe(true);
});

test("nothing goes unless projects.json reads cleanly and names a project", () => {
  const orphan = put(`sessions/${GONE}.json`);
  expect(sweepOrphans()).toBe(0); // no file
  fs.writeFileSync(path.join(root, "projects.json"), "{ half");
  expect(sweepOrphans()).toBe(0); // unreadable
  fs.writeFileSync(path.join(root, "projects.json"), JSON.stringify({ projects: [] }));
  expect(sweepOrphans()).toBe(0); // empty: more likely a wiped file than a workspace with nothing in it
  expect(fs.existsSync(orphan)).toBe(true);
});
