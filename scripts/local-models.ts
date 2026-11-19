/**
 * A local model does a job in a ruri chat.
 *
 * Needs an Ollama running with a model that can call tools, and OpenCode
 * (the harness local models run on). A server of the run's own, one
 * project, then:
 *   - the catalog lists Ollama's models as local ones, with none of the
 *     copies ruri makes to give them room (server/ollama.ts);
 *   - a chat set to one has its copy made, sized as the catalog says;
 *   - a prompt that needs a tool is done with the tool — the file is on
 *     disk, the transcript has the chip — on the copy, loaded with that
 *     window, and the context gauge reads against it.
 *
 * Costs nothing but time: the turn runs on this machine, and a small model
 * on an ordinary one takes a minute or several. Run manually:
 *   bun run local-test            (LOCAL_MODEL=<name> picks one)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootServer, connect } from "./lib/server.js";
import type {
  ClientMessage,
  ContextUsage,
  ModelChoice,
  Project,
  ServerMessage,
  TranscriptEvent,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7894);
const OLLAMA = "http://127.0.0.1:11434";
const dirs = ["config", "work"].map((name) => fs.mkdtempSync(path.join(os.tmpdir(), `ruri-local-${name}-`)));
const [configDir, workDir] = dirs as [string, string];

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail)?.slice(0, 1500));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("LOCAL FAIL: timed out");
  cleanup(1);
}, 1_200_000);
deadline.unref();

let projects: Project[] = [];
let models: ModelChoice[] = [];
const events: Record<string, TranscriptEvent[]> = {};
const contexts: Record<string, ContextUsage> = {};
const waiters = new Set<() => void>();

console.log(`local-test: a server on ${PORT}, then the catalog`);
const ws = await connect(PORT);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects") projects = msg.projects;
  if (msg.type === "models") models = msg.models;
  if (msg.type === "event") {
    (events[msg.projectId] ??= []).push(msg.event);
    if (process.env["LOCAL_VERBOSE"]) console.log("    ·", JSON.stringify(msg.event).slice(0, 300));
  }
  if (msg.type === "context") contexts[msg.projectId] = msg.context;
  for (const waiter of [...waiters]) waiter();
});

function until(what: string, done: () => boolean, ms: number): Promise<void> {
  if (done()) return Promise.resolve();
  const began = Date.now();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!done()) return;
      clearTimeout(timer);
      clearInterval(beat);
      waiters.delete(look);
      resolve();
    };
    const beat = setInterval(
      () => console.log(`    still waiting for ${what}… ${Math.round((Date.now() - began) / 1000)}s`),
      15_000,
    );
    const timer = setTimeout(() => {
      waiters.delete(look);
      clearInterval(beat);
      console.log(`    (gave up waiting for ${what})`);
      resolve();
    }, ms);
    waiters.add(look);
  });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ollama = async <T>(route: string): Promise<T | undefined> => {
  try {
    return (await (await fetch(`${OLLAMA}${route}`, { signal: AbortSignal.timeout(5_000) })).json()) as T;
  } catch {
    return undefined;
  }
};

/* ── the catalog ──────────────────────────────────────────────────── */

await until("a local model in the catalog", () => models.some((m) => m.local), 60_000);
const local = models.filter((m) => m.local);
if (local.length === 0) {
  console.error(
    "LOCAL FAIL: the catalog lists no local model — is Ollama running with a model that can call tools, and is OpenCode installed?",
  );
  cleanup(1);
}
console.log(`    local models: ${local.map((m) => m.displayName).join(", ")}`);
check(
  "Ollama's models are in the catalog as local ones, on the OpenCode harness",
  local.every((m) => m.local === "Ollama" && m.provider === "opencode" && m.agentic === true),
  local,
);
check(
  "and none of the copies ruri makes is listed",
  !models.some((m) => m.value.endsWith("-ruri")),
  models.filter((m) => m.value.endsWith("-ruri")),
);
const wanted = process.env["LOCAL_MODEL"];
const model = (wanted && local.find((m) => m.displayName === wanted)) || local[0]!;
console.log(`    running on ${model.displayName}`);

/* ── one chat, set to it ──────────────────────────────────────────── */

send({ type: "add_project", name: "local", path: workDir });
const projectAt = () => projects.find((p) => p.path === fs.realpathSync(workDir) || p.path === workDir);
await until("the project", () => Boolean(projectAt()?.sessions[0]), 30_000);
const chat = projectAt()?.sessions[0]?.id;
if (!chat) {
  console.error("LOCAL FAIL: no project", projects);
  cleanup(1);
}
send({ type: "set_model", projectId: chat, model: model.value });
send({ type: "set_permission_mode", projectId: chat, mode: "bypassPermissions" });
await settle(1_500);

const copy = `${model.displayName}-ruri`;
const shown = await fetch(`${OLLAMA}/api/show`, { method: "POST", body: JSON.stringify({ model: copy }) })
  .then((res) => res.json() as Promise<{ parameters?: string }>)
  .catch(() => undefined);
const window = Number(/num_ctx\s+(\d+)/.exec(shown?.parameters ?? "")?.[1] ?? 0);
check(`setting the chat to it made its copy with room (${copy}, ${window} tokens)`, window >= 8_192, shown);

/* ── a job that needs a tool ──────────────────────────────────────── */

const target = path.join(workDir, "hello.txt");
console.log("    a turn on this machine: a minute or several");
const began = Date.now();
send({
  type: "send",
  projectId: chat,
  clientId: crypto.randomUUID(),
  text: "Create a file named hello.txt in this folder containing exactly the text hi — then tell me you did.",
});
await until("the turn to end", () => (events[chat] ?? []).some((e) => e.kind === "result"), 900_000);
console.log(`    the turn took ${Math.round((Date.now() - began) / 1000)}s`);

const mine = events[chat] ?? [];
const result = mine.findLast((e) => e.kind === "result");
check("the turn ended well", result?.kind === "result" && result.ok, result);
check(
  "the file is on disk, written by the model's tool",
  fs.existsSync(target) && fs.readFileSync(target, "utf8").trim() === "hi",
  fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "no file",
);
check(
  "and the transcript has the tool's chip",
  mine.some((e) => e.kind === "tool"),
  mine.map((e) => e.kind),
);
check(
  "it answered in words too",
  mine.some((e) => e.kind === "assistant" && e.text.trim() !== ""),
  mine.map((e) => e.kind),
);
const context = contexts[chat];
check(
  `the context gauge reads against the window it is served with (${context?.tokens} of ${context?.window})`,
  context !== undefined && context.window === window && context.tokens > 0,
  context,
);
const running = await ollama<{ models?: Array<{ name: string; context_length?: number }> }>("/api/ps");
const loaded = running?.models?.find((m) => m.name === copy);
check(
  `Ollama ran the copy, loaded with that window (${loaded?.context_length ?? "not loaded"})`,
  loaded !== undefined && (loaded.context_length === undefined || loaded.context_length === window),
  running,
);

console.log(failed === 0 ? "LOCAL PASS" : `LOCAL FAIL: ${failed} check${failed === 1 ? "" : "s"}`);
cleanup(failed === 0 ? 0 : 1);
