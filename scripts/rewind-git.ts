/**
 * A rewind against a real repository, through the real server, with no
 * model in the loop.
 *
 * Three turns are played out by hand on a scratch git repository — each
 * with the checkpoint ruri takes as its prompt goes out and the one it
 * takes as the turn ends — the second of them committing, and a file
 * written by hand in between. The chat's archive is seeded to match, with
 * the context reading each turn left behind. Then the second prompt is
 * rewound over the socket, and everything that should have gone back is
 * checked: the files (and only the discarded turns' changes), the branch,
 * the transcript, the prompt in the composer, and the context gauge, which
 * must read what the first exchange left rather than the tip.
 *
 * Costs nothing — no turn is ever run: bun scripts/rewind-git.ts
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { createCheckpoints } from "../server/checkpoints.js";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7897;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-git-config-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-git-repo-"));
const PROJECT_ID = "p-rewind-git";
const CHANNEL = "c-rewind-git";

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");

git("init", "-q", "-b", "master");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
write("app.txt", "v0\n");
git("add", "-A");
git("commit", "-q", "-m", "init");

// ── the three turns, played by hand ─────────────────────────────────────
// the checkpoints are the server's own kind, in the server's config dir
process.env["RURI_CONFIG_DIR"] = configDir;
const ckpt = createCheckpoints();
const project = { id: PROJECT_ID, path: repo };
const turn = async (id: string, work: () => void) => {
  await ckpt.capture(project, CHANNEL, id);
  work();
  await ckpt.settle(project, CHANNEL, id);
};
await turn("u1", () => write("app.txt", "v1\n"));
const afterFirst = git("rev-parse", "HEAD");
await turn("u2", () => {
  write("app.txt", "v2\n");
  write("feature.txt", "made and committed by turn two\n");
  git("add", "-A");
  git("commit", "-q", "-m", "turn two");
});
write("mine.txt", "written by hand between turns\n");
await turn("u3", () => write("app.txt", "v3\n"));

// ── the chat, as the archive would hold it ─────────────────────────────
const ts = 1_700_000_000_000;
const events: TranscriptEvent[] = [
  { kind: "user", id: "u1", text: "first", ts },
  { kind: "assistant", id: "a1", text: "did the first", ts: ts + 1 },
  { kind: "result", id: "r1", ok: true, ts: ts + 2 },
  { kind: "user", id: "u2", text: "second, which commits", ts: ts + 3 },
  { kind: "assistant", id: "a2", text: "did the second", ts: ts + 4 },
  { kind: "result", id: "r2", ok: true, ts: ts + 5 },
  { kind: "user", id: "u3", text: "third", ts: ts + 6 },
  { kind: "assistant", id: "a3", text: "did the third", ts: ts + 7 },
  { kind: "result", id: "r3", ok: true, ts: ts + 8 },
];
fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      {
        id: PROJECT_ID,
        name: "rewind-git",
        path: repo,
        sessions: [{ id: CHANNEL, title: "Rewind" }],
        model: "claude-fable-5[1m]",
      },
    ],
  }),
);
fs.writeFileSync(
  path.join(configDir, "sessions", `${CHANNEL}.json`),
  JSON.stringify({
    events,
    summaries: {},
    // the Claude session the chat is on, and the first exchange's last
    // chain entry in it: where the conversation forks. (With no session
    // there is nothing to fork, and the rewind restarts from a brief.)
    lastSessionId: "5e55107e-0000-4000-8000-000000000001",
    chain: { u1: { last: "chain-after-u1" } },
    contextTokens: 50_000,
    contextAt: { u1: 12_000, u2: 30_000, u3: 50_000 },
  }),
);

const root = path.join(import.meta.dirname, "..");
const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    RURI_PORT: String(PORT),
    RURI_TOKEN: TOKEN,
    RURI_CONFIG_DIR: configDir,
    RURI_NO_MEMORY: "1",
  },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));

function done(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("FAIL: timed out");
  done(1);
}, 60_000).unref();

async function connect(): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      const ws = new WebSocket(wsUrl(PORT));
      // a refused first try can say so twice; the once below hears one
      ws.on("error", () => {});
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      return ws;
    } catch {
      if (Date.now() - start > 20_000) throw new Error("server never came up");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const ws = await connect();
const seen: ServerMessage[] = [];
ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as ServerMessage));
const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
const settle = () => new Promise((r) => setTimeout(r, 1500));
/** A rewind's answer: the prompt back in the composer (or the refusal), and
 *  a moment for the notice behind it — not a fixed wait, which a server
 *  still probing its harnesses as it starts can overrun. */
const rewound = async () => {
  const start = Date.now();
  while (
    Date.now() - start < 30_000 &&
    !seen.some((m) => m.type === "compose" || (m.type === "error" && m.message.startsWith("rewind failed")))
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
};
await settle();
seen.length = 0;

let bad = 0;
const check = (ok: boolean, what: string, got?: unknown) => {
  if (ok) console.log(`ok    ${what}`);
  else {
    console.error(`FAIL  ${what}${got === undefined ? "" : ` (got ${JSON.stringify(got)})`}`);
    bad++;
  }
};
const find = <T extends ServerMessage["type"]>(type: T) =>
  seen.filter((m) => m.type === type) as Array<Extract<ServerMessage, { type: T }>>;

// ── rewind to the second prompt ─────────────────────────────────────────
send({ type: "rewind", projectId: CHANNEL, eventId: "u2" });
await rewound();

check(
  !find("error").some((m) => m.message.startsWith("rewind failed")),
  "the rewind was not refused",
  find("error"),
);
check(read("app.txt") === "v1\n", "the file is as the first turn left it", read("app.txt"));
check(!fs.existsSync(path.join(repo, "feature.txt")), "the second turn's new file is gone");
check(fs.existsSync(path.join(repo, "mine.txt")), "the file written by hand between turns is still there");
check(
  git("rev-parse", "HEAD") === afterFirst,
  "the second turn's commit is taken back",
  git("log", "--oneline"),
);
check(
  // the first turn's edit was never committed, and still is not; nothing
  // of the second turn's is staged
  git("status", "--porcelain") === "M app.txt\n?? mine.txt",
  "nothing is left staged or half-reverted",
  git("status", "--porcelain"),
);
const removed = find("events_removed")[0]?.eventIds ?? [];
check(
  removed.includes("u2") && removed.includes("u3") && !removed.includes("u1"),
  "the transcript truncated at the prompt",
  removed,
);
check(
  find("compose")[0]?.text === "second, which commits",
  "the prompt is back in the composer",
  find("compose")[0],
);
const gauge = find("context").findLast((m) => m.projectId === CHANNEL)?.context;
check(gauge?.tokens === 12_000, "the context gauge reads what the first exchange left", gauge);
const notice = find("error").find((m) => m.message.startsWith("rewound"))?.message ?? "";
check(notice.includes("master back 1 commit"), "the notice says the branch went back", notice);

// ── and then to the very first: nothing kept, a fresh start ────────────
seen.length = 0;
send({ type: "rewind", projectId: CHANNEL, eventId: "u1" });
await rewound();
check(read("app.txt") === "v0\n", "rewound to the start, the file is as it began", read("app.txt"));
const empty = find("context").findLast((m) => m.projectId === CHANNEL)?.context;
check(empty?.tokens === 0, "with nothing kept, the gauge is empty", empty);

if (bad === 0)
  console.log("PASS: a rewind puts back the files, the branch and the context, and nothing else");
done(bad === 0 ? 0 : 1);
