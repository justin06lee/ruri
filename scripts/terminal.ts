/**
 * A shell's output on the way to a window, against a real server.
 *
 * A program that prints faster than a window can take it is the case the
 * scrollback (server/scrollback.ts) and the relay (server/relay.ts) exist
 * for, and neither may lose a character doing its job:
 *
 *   1. a tab opens, and what its shell prints arrives
 *   2. a noisy command's output arrives whole, in order, however it was
 *      broken into messages on the way
 *   3. a window attaching later is given the scrollback, capped, ending on
 *      what the shell said last
 *   4. a second window gets the same output as the first
 *
 * Run: bun run terminal-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type WebSocket from "ws";
import { bootServer, connect } from "./lib/server.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 400));
  }
}

const PORT = 7811;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-terminal-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-terminal-ws-"));

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

/** Everything a socket has been told, and a way to wait for more. */
function listen(ws: WebSocket) {
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw)) as ServerMessage));
  return {
    messages,
    send: (message: ClientMessage) => ws.send(JSON.stringify(message)),
    /** The terminal text this socket has been given for `termId`, joined. */
    text: (termId: string) =>
      messages
        .filter(
          (m): m is Extract<ServerMessage, { type: "terminal_data" }> =>
            m.type === "terminal_data" && m.termId === termId,
        )
        .map((m) => m.data)
        .join(""),
    frames: (termId: string) =>
      messages.filter((m) => m.type === "terminal_data" && m.termId === termId).length,
    /** Wait until `want` is true of what has arrived, or give up. */
    until: async (want: () => boolean, ms = 30_000) => {
      const start = Date.now();
      while (!want()) {
        if (Date.now() - start > ms) return false;
        await new Promise((r) => setTimeout(r, 50));
      }
      return true;
    },
  };
}

/** What a terminal actually said, with the escape sequences a shell paints
 *  its prompt and its colours with taken off. */
function plainLines(text: string): string[] {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
  );
}

/** The longest run of numbers each one more than the last. */
function longestRun(numbers: number[]): number[] {
  let best: number[] = [];
  let run: number[] = [];
  for (const n of numbers) {
    if (run.length > 0 && n === run[run.length - 1]! + 1) run.push(n);
    else run = [n];
    if (run.length > best.length) best = run;
  }
  return best;
}

function bye(): never {
  server.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

try {
  const ws = await connect(PORT);
  const one = listen(ws);

  // a project to hang the shell off, and the id the server gave it
  one.send({ type: "add_project", name: "Terminal Test", path: workspace });
  const gotProject = await one.until(() =>
    one.messages.some((m) => m.type === "projects" && m.projects.some((p) => p.path === workspace)),
  );
  check("the project is added", gotProject);
  const project = one.messages
    .flatMap((m) => (m.type === "projects" ? m.projects : []))
    .find((p) => p.path === workspace);
  const channelId = project?.sessions[0]?.id;
  if (!channelId) {
    check("the project has a session", false, one.messages.slice(-2));
    bye();
  }

  one.send({ type: "terminal_list", projectId: channelId });
  await one.until(() => one.messages.some((m) => m.type === "terminal_tabs"));
  const termId = one.messages.flatMap((m) => (m.type === "terminal_tabs" ? m.tabs : []))[0]!;
  check("the channel has a tab", typeof termId === "string");

  one.send({ type: "terminal_open", projectId: channelId, termId, cols: 80, rows: 24 });
  const printed = await one.until(() => one.text(termId).length > 0);
  check("the shell prints something", printed, one.text(termId).slice(0, 80));

  /* ── 2. a noisy command, whole and in order ───────────────────────── */

  const LINES = 40_000;
  one.send({ type: "terminal_input", projectId: channelId, termId, data: `seq 1 ${LINES}\r` });
  const ran = await one.until(() => one.text(termId).includes(`\n${LINES}\r`), 60_000);
  check(`all ${LINES} lines arrive`, ran);

  // every number, in order, whatever the message boundaries were. A real
  // shell paints its prompt with escape sequences around the output, so
  // those come off before the lines are read.
  const numbers = plainLines(one.text(termId))
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
  // The shell echoes the command, and its first line of output can share
  // that physical line, so the run is allowed to start at 1 or at 2 — what
  // matters is that nothing between there and the end went missing.
  const run = longestRun(numbers);
  check(`the numbers come back unbroken, to ${LINES}`, run.length >= LINES - 1 && run.at(-1) === LINES, {
    length: run.length,
    from: run[0],
    to: run.at(-1),
  });
  check("and in fewer messages than lines", one.frames(termId) < LINES, {
    frames: one.frames(termId),
  });

  /* ── 3. a window attaching later ──────────────────────────────────── */

  const later = await connect(PORT);
  const two = listen(later);
  two.send({ type: "terminal_open", projectId: channelId, termId, cols: 80, rows: 24 });
  const replayed = await two.until(() =>
    two.messages.some((m) => m.type === "terminal_data" && m.replay === true),
  );
  check("a window attaching later is given the scrollback", replayed);
  const replay = two.messages.find((m) => m.type === "terminal_data" && m.replay === true);
  const scrollback = replay?.type === "terminal_data" ? replay.data : "";
  check("the scrollback is capped", scrollback.length <= 200_000, { length: scrollback.length });
  // the first line is whatever the cap cut through, so the run starts after it
  const kept = longestRun(
    plainLines(scrollback)
      .slice(1)
      .filter((line) => /^\d+$/.test(line))
      .map(Number),
  );
  check("it holds what the shell said last", kept.at(-1) === LINES, { tail: kept.slice(-3) });
  // a run this long does not fit the cap, so its front is gone: what a
  // window attaching late is given is a tail, not the whole of it
  check("and not what it said first", kept[0]! > 1, { from: kept[0] });
  check("and what it holds is unbroken", kept.length > 10_000, { count: kept.length });

  /* ── 4. both windows hear the same thing ──────────────────────────── */

  const beforeOne = one.text(termId).length;
  const beforeTwo = two.text(termId).length;
  one.send({ type: "terminal_input", projectId: channelId, termId, data: `echo marker-9f3\r` });
  const said = (text: string) => plainLines(text).filter((line) => line.includes("marker-9f3")).length >= 1;
  const bothHeard =
    (await one.until(() => said(one.text(termId).slice(beforeOne)))) &&
    (await two.until(() => said(two.text(termId).slice(beforeTwo))));
  check("both windows hear what the shell says next", bothHeard);

  ws.close();
  later.close();
} catch (err) {
  check("the script ran", false, String(err));
}

bye();
