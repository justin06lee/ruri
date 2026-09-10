/**
 * Hidden projects and the Home agent's plain tools.
 *
 * Three things, no harness needed:
 *   1. the drop file — every verb (path/kickoff, new, hide, unhide, close,
 *      and remove as a spelling of close) reaches the right host call, bad lines skipped.
 *   2. the store — findByQuery answers to an id, a path, a display name or
 *      the folder's own name; hidden survives a save and a reload.
 *   3. the finder — a repo's source tree is not walked, a monorepo's
 *      packages still are; the search stays under the one root it is given.
 *   4. the real server — add a project, toggle it hidden over the socket,
 *      the broadcast carries the flag, toggling again clears it.
 *
 * Run: bun run hidden-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { drainOpenRequests, type ManagerHost } from "../server/manager.js";
import { findProjects } from "../server/finder.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

/* ── 1. the drop file ─────────────────────────────────────────────── */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hidden-ws-"));
fs.mkdirSync(path.join(workspace, ".ruri"), { recursive: true });
const calls: string[] = [];
const host: ManagerHost = {
  openProject: (input) => {
    calls.push(`open:${input.path}${input.kickoffPrompt ? `:${input.kickoffPrompt}` : ""}`);
    return "opened";
  },
  newProject: (name) => {
    calls.push(`new:${name}`);
    return "created";
  },
  hideProject: (q) => {
    calls.push(`hide:${q}`);
    return "hidden";
  },
  unhideProject: (q) => {
    calls.push(`unhide:${q}`);
    return "unhidden";
  },
  closeProject: (q) => {
    calls.push(`close:${q}`);
    return "closed";
  },
  listProjects: () => [],
  findProjects: () => [],
};
fs.writeFileSync(
  path.join(workspace, ".ruri", "open.jsonl"),
  [
    JSON.stringify({ path: "/tmp/a", kickoff: "go" }),
    JSON.stringify({ new: "fresh" }),
    JSON.stringify({ hide: "hifz" }),
    "not json at all",
    JSON.stringify({ unhide: "hifz" }),
    JSON.stringify({ close: "old" }),
    JSON.stringify({ remove: "older" }),
    JSON.stringify({ name: "no path, no verb" }),
  ].join("\n") + "\n",
);
const results = drainOpenRequests(workspace, host);
check("drop file: every verb reaches its host call, in order", calls.join(" ") === "open:/tmp/a:go new:fresh hide:hifz unhide:hifz close:old close:older", calls);
check("drop file: one result per applied line", results.length === 6, results);
check("drop file: consumed after draining", !fs.existsSync(path.join(workspace, ".ruri", "open.jsonl")));

/* ── 2. the store ─────────────────────────────────────────────────── */

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hidden-config-"));
process.env["RURI_CONFIG_DIR"] = configDir;
const { ProjectStore } = await import("../server/projects.js");
const projectDir = path.join(workspace, "github.com", "someone", "Hifz-App");
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, "package.json"), "{}");
{
  const store = new ProjectStore();
  const project = store.add("My Hifz", projectDir);
  check("findByQuery: by display name, any case", store.findByQuery("my hifz")?.id === project.id);
  check("findByQuery: by the folder's own name", store.findByQuery("hifz-app")?.id === project.id);
  check("findByQuery: by path with a trailing slash", store.findByQuery(`${projectDir}/`)?.id === project.id);
  check("findByQuery: by id", store.findByQuery(project.id)?.id === project.id);
  check("findByQuery: nothing for a stranger", store.findByQuery("nope") === undefined);
  store.update(project.id, { hidden: true });
  const reloaded = new ProjectStore();
  check("hidden survives save and reload", reloaded.get(project.id)?.hidden === true);
  reloaded.update(project.id, { hidden: undefined });
  check("unhide clears the flag", new ProjectStore().get(project.id)?.hidden === undefined);
}

/* ── 3. the finder ────────────────────────────────────────────────── */

{
  // a repo with a source tree named like the query, a monorepo with a
  // package named like it, and a sibling root that must not be searched
  const repo = path.join(workspace, "github.com", "someone", "big-repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "lib", "deep", "hifz"), { recursive: true });
  const mono = path.join(workspace, "github.com", "someone", "mono");
  fs.mkdirSync(path.join(mono, ".git"), { recursive: true });
  fs.mkdirSync(path.join(mono, "packages", "hifz-core"), { recursive: true });
  fs.writeFileSync(path.join(mono, "packages", "hifz-core", "package.json"), "{}");
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hidden-elsewhere-"));
  fs.mkdirSync(path.join(elsewhere, "hifz-stray"), { recursive: true });

  const found = findProjects([workspace], "hifz").map((f) => f.path);
  check("finder: the project itself is found first", found[0] === projectDir, found);
  check("finder: a monorepo's package is found", found.includes(path.join(mono, "packages", "hifz-core")), found);
  check("finder: a repo's source tree is not walked", !found.some((p) => p.includes("/src/")), found);
  check("finder: only the given root is searched", !found.some((p) => p.startsWith(elsewhere)), found);
  fs.rmSync(elsewhere, { recursive: true, force: true });
}

/* ── 4. the real server ───────────────────────────────────────────── */

const PORT = Number(process.env["RURI_PORT"] ?? 7893);
const serverConfig = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hidden-server-"));
const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: { ...process.env, RURI_PORT: String(PORT), RURI_CONFIG_DIR: serverConfig },
  stdio: ["ignore", "ignore", "inherit"],
});

function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(serverConfig, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  process.exit(code);
}
const deadline = setTimeout(() => {
  console.error("HIDDEN FAIL: timed out");
  cleanup(1);
}, 90_000);
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
        console.error("HIDDEN FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const ws = await connect(`ws://127.0.0.1:${PORT}`);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
let latest: ServerMessage & { type: "projects" } | undefined;
const waiters = new Set<() => void>();
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects") latest = msg;
  for (const waiter of [...waiters]) waiter();
});
const until = (ok: () => boolean) =>
  new Promise<void>((resolve) => {
    if (ok()) return resolve();
    const waiter = () => {
      if (!ok()) return;
      waiters.delete(waiter);
      resolve();
    };
    waiters.add(waiter);
  });

send({ type: "add_project", name: "Hifz", path: projectDir });
await until(() => (latest?.projects.length ?? 0) > 0);
const id = latest!.projects[0]!.id;
check("server: project added unhidden", latest!.projects[0]!.hidden === undefined);
send({ type: "toggle_hidden", projectId: id });
await until(() => latest?.projects[0]?.hidden === true);
check("server: toggle_hidden broadcasts hidden", latest!.projects[0]!.hidden === true);
check("server: hidden keeps its sessions", latest!.projects[0]!.sessions.length === 1);
send({ type: "toggle_hidden", projectId: id });
await until(() => latest?.projects[0]?.hidden === undefined);
check("server: toggling again clears it", latest!.projects[0]!.hidden === undefined);
ws.close();

console.log(failed ? `\n${failed} failed` : "\nall passed");
cleanup(failed ? 1 : 0);
