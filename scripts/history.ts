/**
 * The two-part transcript (server/archive.ts): a compaction folds the past
 * into the history, an old single-file archive is split once on load, a
 * crash between the two writes heals without duplicates, a rewind reaches
 * back into the history, a fork gets its own split, the history holds to
 * its cap, and removing a channel removes both parts.
 *
 *   bun run history-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-history-"));
process.env["RURI_CONFIG_DIR"] = root;
const { SessionArchive } = await import("../server/archive.js");
type Event = import("../shared/protocol.js").TranscriptEvent;

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("     ", JSON.stringify(detail).slice(0, 300));
  }
};
const ts = Date.now();
const turn = (n: number, pad = ""): Event[] => [
  { kind: "user", id: `u${n}`, text: `prompt ${n}${pad}`, ts },
  { kind: "assistant", id: `a${n}`, text: `reply ${n}`, ts },
  { kind: "result", id: `r${n}`, ok: true, ts },
] as Event[];
const mark = (n: number): Event => ({ kind: "compaction", id: `c${n}`, text: `brief ${n}`, ts }) as Event;
const ids = (events: Event[]) => events.map((e) => e.id).join(",");
const liveFile = (id: string) => path.join(root, "sessions", `${id}.json`);
const histFile = (id: string) => path.join(root, "history", `${id}.jsonl`);

/* a compaction folds the past away */
{
  const archive = new SessionArchive();
  for (const e of [...turn(1), ...turn(2)]) archive.append("s1", e);
  archive.setSummary("s1", "u1", "user", "note one");
  archive.append("s1", mark(1));
  for (const e of turn(3)) archive.append("s1", e);
  check("the live part opens on the mark", ids(archive.events("s1")) === "c1,u3,a3,r3", ids(archive.events("s1")));
  check("the history holds what came before", ids(archive.history("s1")) === "u1,a1,r1,u2,a2,r2");
  check("the whole conversation reads in order", ids(archive.allEvents("s1")) === "u1,a1,r1,u2,a2,r2,c1,u3,a3,r3");
  check("notes survive the fold", archive.summaries("s1")["u1"]?.user === "note one");
  archive.flushAll();
  const onDisk = JSON.parse(fs.readFileSync(liveFile("s1"), "utf8")) as { events: Event[] };
  check("the live file on disk is only the live part", ids(onDisk.events) === "c1,u3,a3,r3");
}

/* an old single-file archive is split on load, and a crash heals */
{
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
  const legacy = [...turn(1), mark(1), ...turn(2), mark(2), ...turn(3)];
  fs.writeFileSync(liveFile("s2"), JSON.stringify({ events: legacy, summaries: {} }));
  // as if a crash had landed the first append but not the live rewrite
  fs.mkdirSync(path.join(root, "history"), { recursive: true });
  fs.writeFileSync(histFile("s2"), turn(1).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const archive = new SessionArchive();
  check("a legacy archive is split at its newest mark", ids(archive.events("s2")) === "c2,u3,a3,r3", ids(archive.events("s2")));
  check("without writing anything twice", ids(archive.history("s2")) === "u1,a1,r1,c1,u2,a2,r2", ids(archive.history("s2")));
  const again = new SessionArchive();
  check("and a second load changes nothing", ids(again.allEvents("s2")) === ids(legacy));
}

/* a rewind into the history */
{
  const archive = new SessionArchive();
  const removed = archive.truncateFrom("s2", "u2");
  check("everything from the target on goes", removed.join(",") === "u2,a2,r2,c2,u3,a3,r3", removed);
  check("what is kept is split again at its own newest mark", ids(archive.events("s2")) === "c1" && ids(archive.history("s2")) === "u1,a1,r1");
  const fresh = new SessionArchive();
  check("and it reads back the same from disk", ids(fresh.allEvents("s2")) === "u1,a1,r1,c1");
}

/* a fork gets its own split */
{
  const archive = new SessionArchive();
  archive.seed("s3", { events: [...turn(1), mark(1), ...turn(2)], summaries: {}, chain: {} });
  check("a seeded fork has its own history", ids(archive.history("s3")) === "u1,a1,r1" && ids(archive.events("s3")) === "c1,u2,a2,r2");
}

/* the cap */
{
  const archive = new SessionArchive({ historyMaxBytes: 4000 });
  const pad = " ".repeat(200);
  for (let n = 0; n < 40; n++) {
    for (const e of turn(n, pad)) archive.append("s4", e);
    archive.setSummary("s4", `u${n}`, "user", `note ${n}`);
    archive.append("s4", mark(100 + n));
  }
  const size = fs.statSync(histFile("s4")).size;
  const history = archive.history("s4");
  check("the history holds to its cap", size <= 4000, size);
  check("it keeps the newest exchanges", history[history.length - 1]?.id === "u39" || history.some((e) => e.id === "u39"));
  check("the oldest are gone, and their notes with them", !history.some((e) => e.id === "u0") && archive.summaries("s4")["u0"] === undefined);
  check("it still opens where a turn does", history[0]?.kind === "user" || history[0]?.kind === "compaction");
}

/* removing a channel removes both parts */
{
  const archive = new SessionArchive();
  archive.remove("s1");
  check("both files are gone", !fs.existsSync(liveFile("s1")) && !fs.existsSync(histFile("s1")));
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all good");
