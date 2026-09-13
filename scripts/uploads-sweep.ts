/**
 * The upload sweep (server/uploads.ts): what nothing mentions goes, a day
 * after it was written; what any archive, draft, note or turn file names
 * stays; and what is younger than a day stays whatever mentions it.
 *
 *   bun run uploads-sweep-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-sweep-"));
process.env["RURI_CONFIG_DIR"] = root;
const { sweepUploads } = await import("../server/uploads.js");

const uploads = path.join(root, "uploads");
fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
fs.mkdirSync(path.join(root, "turns", "abc"), { recursive: true });
fs.mkdirSync(path.join(root, "bridge", "abc"), { recursive: true });

const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
function put(name: string, old = true): void {
  const file = path.join(uploads, name);
  fs.writeFileSync(file, "x");
  if (old) fs.utimesSync(file, twoDaysAgo, twoDaysAgo);
}

put("aaaa-kept-by-archive.png");
put("bbbb-kept-by-turn-file.mov");
put("cccc-kept-by-draft.pdf");
put("dddd-orphan.png");
put("eeee-orphan-but-fresh.png", false);
put("ffff-mentioned-only-from-bridge.png");

fs.writeFileSync(
  path.join(root, "sessions", "s1.json"),
  JSON.stringify({ events: [{ kind: "user", attachments: [{ url: "/uploads/aaaa-kept-by-archive.png" }] }] }),
);
fs.writeFileSync(
  path.join(root, "turns", "abc", "001.md"),
  `the file was saved at ${path.join(uploads, "bbbb-kept-by-turn-file.mov")} — inspect it`,
);
fs.writeFileSync(path.join(root, "drafts.json"), JSON.stringify({ s1: { attachments: [{ url: "/uploads/cccc-kept-by-draft.pdf" }] } }));
// a bridge file is a picture, not an index: a mention in there does not count
fs.writeFileSync(path.join(root, "bridge", "abc", "note.md"), "/uploads/ffff-mentioned-only-from-bridge.png");

const removed = sweepUploads();
const left = new Set(fs.readdirSync(uploads));
const checks: Array<[string, boolean]> = [
  ["two went", removed === 2],
  ["the archive's stays", left.has("aaaa-kept-by-archive.png")],
  ["the turn file's stays", left.has("bbbb-kept-by-turn-file.mov")],
  ["the draft's stays", left.has("cccc-kept-by-draft.pdf")],
  ["the orphan goes", !left.has("dddd-orphan.png")],
  ["a fresh orphan stays for now", left.has("eeee-orphan-but-fresh.png")],
  ["a mention from under bridge/ does not count", !left.has("ffff-mentioned-only-from-bridge.png")],
  ["a second pass finds nothing more", sweepUploads() === 0],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all good");
