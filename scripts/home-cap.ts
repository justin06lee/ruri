/**
 * Home keeps its newest HOME_TRANSCRIPT_MAX events (server/archive.ts): the
 * cut lands where a turn starts, the dropped turns' notes go with them, the
 * file on disk is capped too, and other chats are untouched.
 *
 *   bun run home-cap-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-home-cap-"));
process.env["RURI_CONFIG_DIR"] = root;
const { SessionArchive } = await import("../server/archive.js");
const { HOME_TRANSCRIPT_MAX, keepRecent } = await import("../shared/protocol.js");
type Event = import("../shared/protocol.js").TranscriptEvent;

function turn(n: number): Event[] {
  const ts = Date.now();
  return [
    { kind: "user", id: `u${n}`, text: `prompt ${n}`, ts },
    { kind: "tool", id: `t${n}a`, name: "Read", summary: "a file", ts },
    { kind: "tool", id: `t${n}b`, name: "Grep", summary: "a word", ts },
    { kind: "assistant", id: `a${n}`, text: `reply ${n}`, ts },
    { kind: "result", id: `r${n}`, ok: true, ts },
  ] as Event[];
}

const archive = new SessionArchive();
archive.cap("home", HOME_TRANSCRIPT_MAX);
for (let n = 0; n < 23; n++) {
  for (const event of turn(n)) {
    archive.append("home", event);
    archive.append("other", event);
  }
  archive.setSummary("home", `u${n}`, "user", `note ${n}`);
}

const home = archive.events("home");
let failed = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
};
check(`home holds at most ${HOME_TRANSCRIPT_MAX}`, home.length <= HOME_TRANSCRIPT_MAX && home.length > HOME_TRANSCRIPT_MAX - 5);
check("home opens on a prompt", home[0]?.kind === "user");
check("home ends on the newest event", home[home.length - 1]?.id === "r22");
check("a dropped turn's note went with it", archive.summaries("home")["u0"] === undefined);
check("a kept turn's note stayed", archive.summaries("home")["u22"]?.user === "note 22");
check("other chats are not capped", archive.events("other").length === 23 * 5);

archive.flushAll();
const onDisk = JSON.parse(fs.readFileSync(path.join(root, "sessions", "home.json"), "utf8")) as { events: Event[] };
check("the file on disk is capped too", onDisk.events.length === home.length);

const long = Array.from({ length: 80 }, (_, i) => ({ kind: i === 0 ? "user" : "tool", id: String(i) }));
check("one turn longer than the cap is cut at the cap", keepRecent(long, 50).length === 50);

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all good");
