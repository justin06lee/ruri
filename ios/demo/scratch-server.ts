/**
 * A ruri for the iPhone app to talk to, end to end, without touching the
 * real one: a scratch server on a temp config (never a copy of
 * ~/.config/ruri), three temp projects with small teams, sharing on, and a
 * phone's pairing link — then, on cue, real turns (haiku) so the phone has
 * something to watch: one project at work, one asking a question, one
 * waiting on a card, one at rest.
 *
 *   bun ios/demo/scratch-server.ts          (from the repo root)
 *
 * It prints the pairing link and writes it to <dir>/link. Pair a simulator
 * with: xcrun simctl openurl booted "$(cat <dir>/link)". Touch <dir>/go to
 * start the turns; touch <dir>/link-again for a fresh link. Ctrl-C stops
 * the server and removes every temp folder.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClientMessage, Project, ServerMessage } from "../../shared/protocol.js";
import { bootServer, connect, TOKEN } from "../../scripts/lib/server.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7895);
const MODEL = process.env["DEMO_MODEL"] ?? "haiku";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-phone-"));
const configDir = path.join(dir, "config");
fs.mkdirSync(configDir);

/** A temp project, its stack in .ruri/architecture.json. */
function project(name: string, layers: Array<{ slug: string; name: string; what: string; file: string }>): string {
  const root = path.join(dir, name);
  fs.mkdirSync(path.join(root, ".ruri"), { recursive: true });
  for (const layer of layers) fs.writeFileSync(path.join(root, layer.file), `# ${layer.name}\n\n${layer.what}.\n`);
  const sheet = (summary: string) => ({ summary, map: [], flows: [], files: [], rules: [], edges: [] });
  fs.writeFileSync(
    path.join(root, ".ruri", "architecture.json"),
    JSON.stringify({
      description: `${name}, a small project for the phone to watch.`,
      features: layers.map((l) => l.what),
      layers: layers.map((l) => ({ name: l.name, what: l.what, slug: l.slug, paths: [l.file] })),
      layerSheets: Object.fromEntries(layers.map((l) => [l.slug, sheet(`${l.what}: ${l.file}.`)])),
    }),
  );
  return root;
}

const orchard = project("orchard", [
  { slug: "trees", name: "Trees", what: "Which tree grows where", file: "TREES.md" },
  { slug: "harvest", name: "Harvest", what: "What was picked and when", file: "HARVEST.md" },
]);
const lighthouse = project("lighthouse", [
  { slug: "lamp", name: "Lamp", what: "The lamp's log", file: "LAMP.md" },
]);
const atlas = project("atlas", [{ slug: "maps", name: "Maps", what: "The maps and their legends", file: "MAPS.md" }]);
const garden = project("garden", [{ slug: "beds", name: "Beds", what: "What is planted in each bed", file: "BEDS.md" }]);

const server = bootServer({
  port: PORT,
  configDir,
  stdio: ["ignore", "ignore", "inherit"],
  env: { RURI_NO_MEMORY: "1", RURI_MIDNA: "", RURI_IDLE_MS: "8000" },
});

function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

let projects: Project[] = [];
const statuses: Record<string, string> = {};
const ws = await connect(PORT, 60_000);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" || msg.type === "snapshot") projects = msg.projects;
  if (msg.type === "status") statuses[msg.projectId] = msg.status;
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, done: () => boolean, ms = 180_000): Promise<void> {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > ms) {
      console.log(`  (gave up waiting for ${what})`);
      return;
    }
    await settle(300);
  }
}
const real = (p: string) => fs.realpathSync(p);
const find = (root: string) => projects.find((p) => p.path === root || p.path === real(root));
const busy = (id: string) => statuses[id] === "working" || statuses[id] === "permission";

const talk = async (chat: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/talk/${chat}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status === 200 ? ((await res.json()) as { ok: boolean; text: string }) : null;
};

/* ── the projects and their teams ──────────────────────────────────── */

for (const [root, name] of [
  [orchard, "orchard"],
  [lighthouse, "lighthouse"],
  [atlas, "atlas"],
  [garden, "garden"],
] as const) {
  send({ type: "add_project", name, path: root });
  await until(name, () => Boolean(find(root)));
}
const leadOf = (root: string) => find(root)!.sessions.find((s) => s.lead)!;
for (const root of [orchard, lighthouse, atlas, garden]) {
  send({ type: "set_model", projectId: leadOf(root).id, model: MODEL });
}
await talk(leadOf(orchard).id, { do: "add", layer: "trees" });
await talk(leadOf(orchard).id, { do: "add", layer: "harvest" });
await talk(leadOf(lighthouse).id, { do: "add", layer: "lamp" });
await talk(leadOf(atlas).id, { do: "add", layer: "maps" });
await settle(500);
const member = (root: string, slug: string) => find(root)!.sessions.find((s) => !s.lead && s.layers?.includes(slug));
for (const [root, slug] of [
  [orchard, "trees"],
  [orchard, "harvest"],
  [lighthouse, "lamp"],
  [atlas, "maps"],
] as const) {
  const chat = member(root, slug);
  if (chat) {
    send({ type: "set_model", projectId: chat.id, model: MODEL });
    send({ type: "set_permission_mode", projectId: chat.id, mode: "bypassPermissions" });
  }
}

/* ── last words for everyone, so no row is blank ───────────────────── */

const say = (id: string, text: string) => send({ type: "send", projectId: id, text });
const words: Array<[string | undefined, string]> = [
  [leadOf(orchard).id, "Reply with exactly this and nothing else: The orchard's trees are all accounted for."],
  [leadOf(lighthouse).id, "Reply with exactly this and nothing else: The lamp was lit at dusk."],
  [leadOf(atlas).id, "Reply with exactly this and nothing else: The maps are filed."],
  [leadOf(garden).id, "Reply with exactly this and nothing else: Tomatoes went in bed three today."],
  [member(orchard, "trees")?.id, "Reply with exactly this and nothing else: Twelve apple trees and four pears, all marked."],
  [member(orchard, "harvest")?.id, "Reply with exactly this and nothing else: Picked forty pounds of apples on Sunday."],
  [member(lighthouse, "lamp")?.id, "Reply with exactly this and nothing else: Wick trimmed, oil topped up."],
  [member(atlas, "maps")?.id, "Reply with exactly this and nothing else: Legends checked on all six maps."],
];
for (const [id, text] of words) if (id) say(id, text);
await settle(2_000);
await until("everyone's first words", () => words.every(([id]) => !id || !busy(id)));

/* ── the phone's code ──────────────────────────────────────────────── */

async function phoneLink(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/sharing/phone`, {
    method: "POST",
    headers: { "x-ruri-token": TOKEN, "content-type": "application/json" },
    body: "{}",
  });
  const code = (await res.json()) as { link: string; qr: string };
  fs.writeFileSync(path.join(dir, "link"), code.link);
  fs.writeFileSync(path.join(dir, "qr.svg"), code.qr);
  return code.link;
}
console.log(`\nscratch ruri on :${PORT}, config ${configDir}`);
console.log(`pairing link (also ${path.join(dir, "link")}):\n${await phoneLink()}\n`);
console.log(`touch ${path.join(dir, "go")} to start the turns`);

/* ── on cue: something to watch ────────────────────────────────────── */

const cue = (name: string) => fs.existsSync(path.join(dir, name));
setInterval(() => {
  if (!cue("link-again")) return;
  fs.rmSync(path.join(dir, "link-again"));
  void phoneLink().then((link) => console.log(`new link:\n${link}`));
}, 500);
await until("the cue", () => cue("go"), 24 * 3_600_000);
console.log("go");

// orchard: its lead hands harvest a slow job — the project at work
await talk(leadOf(orchard).id, {
  do: "send",
  to: "harvest",
  message:
    "A new job: run exactly this with your Bash tool, and nothing else: for i in $(seq 1 30); do sleep 1; done — then reply with just: Weighed the last crates, 52 pounds in all.",
  reply: "none",
});
await settle(4_000);
// lighthouse: its lead ends its turn on a question — it needs you
say(
  leadOf(lighthouse).id,
  "Ask me, in one short question, whether the lamp should switch to the red lens tonight, and end your turn on that question. Do nothing else.",
);
await settle(6_000);
// atlas: a card waits on you
say(
  leadOf(atlas).id,
  "Use your Write tool to create the file LEGEND.md containing the line 'North is up.' Do it yourself, now, without delegating, and then reply done.",
);
console.log("turns started — Ctrl-C to stop");
await new Promise(() => {});
