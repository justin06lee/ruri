/**
 * mycelium under the component library, on the real `myc`.
 *
 * A scratch React project, the real server with Live components on, and
 * what the `ruri` command and the Components page do — no model turns:
 *
 *  1. `ruri register --root <file>` ties the entry to its declaration, and
 *     its files come back traced from the code (the stylesheet it imports
 *     with it).
 *  2. The entry is mirrored into `.mycelium/components/`, under ruri's id.
 *  3. `ruri show` answers with mycelium's reading: root, files, the code.
 *  4. `ruri edit --example` gives it props, and the playground the page
 *     asks for serves it, bundled.
 *  5. The component renamed and moved: the entry follows it.
 *  6. The component deleted: the entry is marked lost.
 *  7. The setting off: no playground.
 *
 * Needs myc on this machine (github.com/justin06lee/mycelium) — run
 * manually: bun run mycelium-test
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import {
  MYCELIUM_PREF,
  type ClientMessage,
  type NamedComponent,
  type ServerMessage,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7887);
const repo = path.join(import.meta.dirname, "..");
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-mycelium-config-"));
const projectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruri-mycelium-project-")));

const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(projectDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(projectDir, rel), text);
};
write("package.json", '{ "name": "scratch", "type": "module" }\n');
write(
  "tsconfig.json",
  JSON.stringify({ compilerOptions: { jsx: "react-jsx", module: "esnext", moduleResolution: "bundler" }, include: ["src"] }),
);
const CARD = (name: string) =>
  `import "./card.css";\n\n/** A price, on a card. */\nexport function ${name}({ title }: { title?: string }) {\n  return <div className="card">{title ?? "nothing"}</div>;\n}\n`;
write("src/Card.tsx", CARD("Card"));
write("src/card.css", ".card { padding: 12px; }\n");
write("src/App.tsx", 'import { Card } from "./Card";\n\nexport function App() {\n  return <Card title="one" />;\n}\n');
// React, for the playground's bundle, from ruri's own
fs.symlinkSync(path.join(repo, "node_modules"), path.join(projectDir, "node_modules"));
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
fs.writeFileSync(path.join(projectDir, ".gitignore"), "node_modules\n");
git(["init", "-q", "-b", "master"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "first"]);

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail)?.slice(0, 1200));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("MYCELIUM FAIL: timed out");
  cleanup(1);
}, 300_000);
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
        console.error("MYCELIUM FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
let chatId: string | undefined;
let library: NamedComponent[] = [];
let found: string | null | undefined;
let unnamed: number | undefined;
let played: { url?: string; error?: string } | undefined;
const play = () => played;
const waiters = new Set<() => void>();
const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    const project = msg.projects[msg.projects.length - 1]!;
    projectId = project.id;
    chatId = project.sessions[0]!.id;
  }
  if (msg.type === "components") library = msg.items;
  if (msg.type === "mycelium") {
    found = msg.found;
    if (msg.unnamed !== undefined) unnamed = msg.unnamed;
  }
  if (msg.type === "component_play") played = msg;
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

/** The `ruri` command, the way a session's shell posts it. */
async function ruri(...argv: string[]): Promise<{ ok: boolean; text: string }> {
  const form = new URLSearchParams([["cwd", projectDir], ...argv.map((a) => ["a", a] as [string, string])]);
  const res = await fetch(`http://127.0.0.1:${PORT}/library/${chatId}`, { method: "POST", body: form });
  return { ok: res.status === 200, text: await res.text() };
}

const card = () => library.find((item) => item.slug === "price-card");
const mirror = () => {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectDir, ".mycelium", "components", "price-card.json"), "utf8"),
    ) as { ruri?: string; root?: { file: string; symbol: string }; examples?: unknown[] };
  } catch {
    return undefined;
  }
};

send({ type: "set_pref", key: MYCELIUM_PREF, value: "on" });
send({ type: "add_project", name: "shop", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId || !chatId) {
  console.error("MYCELIUM FAIL: no project");
  cleanup(1);
}
send({ type: "mycelium_get" });
await until("where myc is", () => found !== undefined, 10_000);
if (!found) {
  console.error("MYCELIUM FAIL: myc isn't on this machine");
  cleanup(1);
}

// 1. register by root
const registered = await ruri(
  "register",
  "price-card",
  "--name",
  "the price card",
  "--root",
  "src/Card.tsx",
  "--note",
  "a price, on a card",
);
check("register --root ties it to the file's one component", registered.ok && registered.text.includes("starts at src/Card.tsx#Card"), registered);
await until("its files traced", () => card()?.files.includes("src/card.css") === true, 60_000);
check("the root is kept with the entry", card()?.root === "src/Card.tsx#Card", card());
check("its files are traced from the code, the stylesheet it imports with them", card()?.files.join() === "src/Card.tsx,src/card.css", card()?.files);

// 2. the mirror
check("it is mirrored into .mycelium, under ruri's id", mirror()?.ruri === card()?.id && mirror()?.root?.symbol === "Card", mirror());

// 3. show
const shown = await ruri("show", "price-card");
check("ruri show leads with the entry", shown.ok && shown.text.includes("## price-card — the price card"), shown.text.slice(0, 300));
check("and answers with mycelium's reading of it", /root\s+src\/Card\.tsx#Card/.test(shown.text) && shown.text.includes("className=\"card\""), shown.text);
check("what uses it is named", /used by\s+src\/App\.tsx/.test(shown.text), shown.text);

// 4. an example, and the live render
const example = await ruri("edit", "price-card", "--example", 'basic={"title":"Nine dollars"}');
check("an example is kept with it", example.ok && (mirror()?.examples?.length ?? 0) === 1, { example, mirror: mirror() });
send({ type: "component_play", projectId });
await until("the playground", () => play() !== undefined, 90_000);
const url = play()?.url;
check("the page is told where it renders", Boolean(url), play());
if (url) {
  const page = await fetch(`${url}c/price-card`);
  const html = await page.text();
  check("the playground serves its page", page.status === 200 && html.includes('id="root"') && !html.includes('class="myc-error"'), html.slice(-500));
  const bundle = await fetch(`${url}out/price-card/price-card.js`);
  const js = await bundle.text();
  check("bundled from its code, with its example", bundle.status === 200 && js.includes("Nine dollars"), js.length);
}
send({ type: "mycelium_get", projectId, link: true });
await until("the count of the unnamed", () => unnamed !== undefined, 60_000);
check("what the code holds that nobody named is counted", unnamed === 1, unnamed);

// 5. renamed and moved
fs.rmSync(path.join(projectDir, "src", "Card.tsx"));
fs.renameSync(path.join(projectDir, "src", "card.css"), path.join(projectDir, "src", "cards.css"));
write("src/cards/PriceCard.tsx", CARD("PriceCard").replace("./card.css", "../cards.css"));
write("src/App.tsx", 'import { PriceCard } from "./cards/PriceCard";\n\nexport function App() {\n  return <PriceCard title="one" />;\n}\n');
// the Components page, opened: code that changed with no turn is seen
send({ type: "mycelium_get", projectId, link: true });
await until("the entry following it", () => card()?.root === "src/cards/PriceCard.tsx#PriceCard", 60_000);
check("renamed and moved, the entry follows", card()?.root === "src/cards/PriceCard.tsx#PriceCard", card());
check("with its files", card()?.files.join() === "src/cards/PriceCard.tsx,src/cards.css", card()?.files);

// 6. gone
fs.rmSync(path.join(projectDir, "src", "cards"), { recursive: true });
write("src/App.tsx", "export function App() {\n  return <main />;\n}\n");
send({ type: "mycelium_get", projectId, link: true });
await until("the entry marked lost", () => card()?.orphaned === true, 60_000);
check("deleted, the entry is marked lost", card()?.orphaned === true, card());
const lost = await ruri("show", "price-card", "--no-code");
check("and ruri show says so", lost.text.includes("Its root is gone from the code"), lost.text);

// 7. off
send({ type: "set_pref", key: MYCELIUM_PREF, value: "off" });
await new Promise((r) => setTimeout(r, 300));
played = undefined;
send({ type: "component_play", projectId });
await until("the refusal", () => play() !== undefined, 10_000);
check("with the setting off, nothing renders", Boolean(play()?.error) && !play()?.url, play());
const off = await ruri("edit", "price-card", "--root", "src/App.tsx#App");
check("and --root says how to get it", !off.ok && off.text.includes("Live components"), off);

console.log(failed === 0 ? "MYCELIUM OK" : `MYCELIUM FAIL: ${failed} check${failed === 1 ? "" : "s"}`);
cleanup(failed === 0 ? 0 : 1);
