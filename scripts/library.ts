/**
 * The component library on real turns.
 *
 * What agents do with the library from their shell and what rides down with
 * a prompt, on Haiku against the real server, in a scratch git project:
 *
 *  1. `ruri register` from the agent's shell puts it in, under the name
 *     given (and the command refuses one with no name).
 *  2. A prompt that names it — hyphenated, without its article — carries
 *     its entry down to the model, which can read its file path off it.
 *  3. A turn that edits its code leaves its picture out of date, decided by
 *     what the code says now; `ruri edit --current` says it still holds.
 *  4. `.ruri/components.md` holds no picture paths and no out-of-date lines.
 *
 * Four small turns — run manually: bun run library-test
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import {
  componentStale,
  type ClientMessage,
  type NamedComponent,
  type ServerMessage,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7886);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-library-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-library-project-"));

// a git project with one component in it, committed
fs.mkdirSync(path.join(projectDir, "src", "components"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "package.json"), '{ "name": "scratch" }\n');
fs.writeFileSync(
  path.join(projectDir, "src", "components", "RapidBar.tsx"),
  '/** The bar of starred projects. */\nexport function RapidBar() { return <div className="rapid-bar" />; }\n',
);
const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: projectDir,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
git(["init", "-q", "-b", "master"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "first"]);

/** A tiny picture of it to file. */
const shot = path.join(projectDir, "..", `rapid-bar-${process.pid}.png`);
{
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(8 * 3, 200)]);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header.set([8, 2, 0, 0, 0], 8);
  fs.writeFileSync(
    shot,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: 8 }, () => row)))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(shot, { force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("LIBRARY FAIL: timed out");
  cleanup(1);
}, 600_000);
deadline.unref();

async function connect(url: string): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(url);
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - start > 60_000) {
        console.error("LIBRARY FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
let reply = "";
let result: { ok: boolean; error?: string } | undefined;
let library: NamedComponent[] = [];
const waiters = new Set<() => void>();
const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "components") library = msg.items;
  if (msg.type === "event" && msg.projectId === projectId) {
    if (msg.event.kind === "assistant") reply += msg.event.text;
    if (msg.event.kind === "result") result = msg.event;
  }
  for (const waiter of [...waiters]) waiter();
});
function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!ok()) return;
      clearTimeout(timer);
      waiters.delete(look);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve();
    }, ms);
    waiters.add(look);
  });
}

/** One turn: the prompt, and its reply once it has ended. */
async function turn(text: string): Promise<string> {
  reply = "";
  result = undefined;
  send({ type: "send", projectId: projectId!, text });
  await until("the reply", () => result !== undefined, 180_000);
  return reply;
}

const bar = () => library.find((item) => item.slug === "rapid-bar");

send({ type: "add_project", name: "library", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("LIBRARY FAIL: no project");
  cleanup(1);
}
send({ type: "set_model", projectId, model: "haiku" });
await new Promise((r) => setTimeout(r, 300));

// 1. register from the shell
const first = await turn(
  "Run these two shell commands exactly as written, one after the other, and then reply with only their output, nothing else:\n" +
    "ruri register rapid-bar --files src/components/RapidBar.tsx\n" +
    `ruri register rapid-bar --name "the rapid fire bar" --files src/components/RapidBar.tsx --note "the bar of starred projects" --shot ${shot}`,
);
check("the turn ends well", result?.ok === true, result);
check("a register with no name is refused, saying why", /--name/.test(first), first);
await until("the entry", () => Boolean(bar()), 10_000);
check("the second puts it in under the name given", bar()?.name === "the rapid fire bar", library);
check("with its picture", (bar()?.shots.length ?? 0) === 1, bar());

// 2. a prompt that names it carries its entry down
const named = await turn(
  "Don't use any tools. Is the rapid-fire bar too tall? Ignore the question itself: reply with only the repo-relative path of the file that the component library context attached to this prompt gives for it.",
);
check(
  "the model is handed the entry of what the prompt names",
  named.includes("src/components/RapidBar.tsx"),
  named,
);

// 3. a turn that edits its code leaves the picture behind
await turn(
  "Run exactly this shell command and reply with only the word done: printf '// taller now\\n' >> src/components/RapidBar.tsx",
);
await until("the out-of-date mark", () => Boolean(bar() && componentStale(bar()!).picture), 15_000);
check(
  "a turn's edit to its code leaves its picture out of date",
  Boolean(bar() && componentStale(bar()!).picture),
  bar(),
);
await turn("Run exactly this shell command and reply with only its output: ruri edit rapid-bar --current");
await until("the mark coming off", () => Boolean(bar() && !componentStale(bar()!).picture), 15_000);
check("ruri edit --current says it still holds", Boolean(bar() && !componentStale(bar()!).picture), bar());

// 4. what the project keeps
const file = fs.readFileSync(path.join(projectDir, ".ruri", "components.md"), "utf8");
check("components.md lists it", file.includes("## rapid-bar — the rapid fire bar"), file);
check(
  "with no picture paths or out-of-date lines",
  !file.includes("uploads") && !file.includes("changed since"),
  file,
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
