/**
 * The resource meters, against a real server and a real harness process.
 *
 * The statistics page asks the server what the agents are costing this
 * machine (server/resources.ts). Everything about that is testable in
 * pieces except the one link the whole thing hangs on: that a running
 * harness puts a session id on its own command line, and that the id is
 * one the archive recorded for that chat. So this runs a real turn and
 * checks ruri can point at the process and say whose it is.
 *
 *   1. nothing is sampled until a window asks (the `view` message)
 *   2. once it does, readings arrive, and ruri's own weight is in them
 *   3. a chat that has been prompted has an agent, named as that chat
 *   4. the agent weighs what a harness weighs, not what a stray tool does
 *   5. the sampling stops when the window stops looking
 *
 * Costs one very short turn, on Haiku. Run manually:
 *   bun run meters-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootServer, connect } from "./lib/server.js";
import type { ClientMessage, Resources, ServerMessage } from "../shared/protocol.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 400));
  }
}

const PORT = 7813;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-meters-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-meters-ws-"));
fs.writeFileSync(path.join(workspace, "README.md"), "# a project\n");

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

function bye(): never {
  server.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

try {
  const ws = await connect(PORT);
  const seen: ServerMessage[] = [];
  ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as ServerMessage));
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const until = async (want: () => boolean, ms = 60_000) => {
    const start = Date.now();
    while (!want()) {
      if (Date.now() - start > ms) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  };
  const readings = () => seen.flatMap((m) => (m.type === "resources" ? [m.resources] : [])) as Resources[];

  send({ type: "add_project", name: "Meters", path: workspace });
  await until(() => seen.some((m) => m.type === "projects" && m.projects.length > 0));
  const project = seen.flatMap((m) => (m.type === "projects" ? m.projects : [])).at(-1);
  const channelId = project?.sessions[0]?.id;
  if (!channelId) {
    check("the project has a session", false, seen.slice(-2));
    bye();
  }

  /* ── 1. nothing until a window asks ───────────────────────────────── */

  send({ type: "view", channels: [channelId], live: true });
  await new Promise((r) => setTimeout(r, 3_000));
  check("no reading until a window asks for one", readings().length === 0, {
    readings: readings().length,
  });

  /* ── 2. a window asks ─────────────────────────────────────────────── */

  send({ type: "view", channels: [channelId], live: true, meters: true });
  const arrived = await until(() => readings().length > 0, 15_000);
  check("a window asking gets readings", arrived);
  const first = readings().at(-1);
  check("ruri's own weight is in them", (first?.app.rss ?? 0) > 0, { app: first?.app });
  check("and the machine's size", (first?.host.totalBytes ?? 0) > 0, { host: first?.host });

  /* ── 3. a chat with a harness running ─────────────────────────────── */

  // the cheapest model there is: this test wants a harness process to
  // exist, not an answer, and it must never spend a premium window
  send({ type: "set_model", projectId: channelId, model: "haiku" });
  await new Promise((r) => setTimeout(r, 300));
  send({ type: "send", projectId: channelId, text: "Reply with the single word: ok" });
  const worked = await until(
    () => seen.some((m) => m.type === "status" && m.projectId === channelId && m.status === "working"),
    30_000,
  );
  check("the turn starts", worked);

  const placed = await until(
    () => readings().some((r) => r.agents.some((a) => a.channelId === channelId)),
    90_000,
  );
  const withAgent = readings().findLast((r) => r.agents.some((a) => a.channelId === channelId));
  const agent = withAgent?.agents.find((a) => a.channelId === channelId);
  check("the chat's own agent is found, and named as that chat", placed, {
    agents: readings().at(-1)?.agents,
  });
  if (agent) {
    console.log(
      `     ${agent.name} · ${mb(agent.rss)} · ${agent.cpu}% cpu · ${agent.helpers} helpers · pid ${agent.pid}`,
    );
    /* ── 4. it weighs what a harness weighs ─────────────────────────── */
    check("it weighs what a harness weighs", agent.rss > 40 * 1024 * 1024, { rss: mb(agent.rss) });
    check("it is a real process", Number.isInteger(agent.pid) && agent.pid > 1, { pid: agent.pid });
    check(
      "and nothing of ruri's own is listed beside it",
      !withAgent!.agents.some((a) => a.name === "ps" || a.name === "esbuild"),
      { agents: withAgent!.agents.map((a) => a.name) },
    );
  }

  /* ── 5. and it stops when nobody is looking ───────────────────────── */

  await until(() => seen.some((m) => m.type === "status" && m.status === "idle"), 90_000);
  send({ type: "view", channels: [channelId], live: true });
  await new Promise((r) => setTimeout(r, 500));
  const before = readings().length;
  await new Promise((r) => setTimeout(r, 5_000));
  check("the sampling stops when the window stops looking", readings().length === before, {
    before,
    after: readings().length,
  });

  ws.close();
} catch (err) {
  check("the script ran", false, String(err));
}

bye();
