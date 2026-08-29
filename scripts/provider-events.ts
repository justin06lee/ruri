/**
 * A harness turn, event by event, with no harness: a fake provider streams
 * exactly what one does — narration, a patch call, more narration — and the
 * transcript it produces is checked against what ruri promises for every
 * model. Costs nothing, so it runs with the rest: bun run provider-events
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, Provider, ProviderSession } from "@justin06lee/yagami";
import type { Project, TranscriptEvent } from "../shared/protocol.js";
import { SessionManager } from "../server/sessions.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-events-"));
const target = path.join(dir, "hello.txt");
fs.writeFileSync(target, "before\n");

/** What a harness streams for "narrate, patch a file, narrate" — including
 *  the two things that ran a turn's sentences together: a second message
 *  arriving as bare chunks with no boundary, and no space where the first
 *  one's full stop met it. */
async function* turn(): AsyncGenerator<AgentEvent, void, undefined> {
  yield { type: "session", sessionId: "fake-1" };
  for (const text of ["I'll ", "rewrite ", "the file."]) yield { type: "text", text };
  // a new message, mid-stream, with nothing to mark it but the missing space
  for (const text of ["Reading ", "it first."]) yield { type: "text", text };
  yield {
    type: "tool_call",
    id: "call-1",
    name: "apply_patch",
    status: "started",
    title: target,
    kind: "edit",
    input: {
      changes: [
        { path: target, kind: { type: "update" }, diff: "@@ -1 +1 @@\n-before\n+after\n" },
      ],
    },
  };
  yield { type: "tool_call", id: "call-1", name: "apply_patch", status: "completed" };
  for (const text of ["Done", " — it says after now."]) yield { type: "text", text };
  // reasoning between messages is a boundary too: what came before it is said
  yield { type: "thinking", text: "checking the result" };
  // a decimal is not a sentence boundary, however it is chunked
  for (const text of ["Nothing ", "else to do. Version 3", ".", "14 ships."]) {
    yield { type: "text", text };
  }
  yield {
    type: "done",
    usage: { input_tokens: 1200, output_tokens: 34 },
    costUsd: 0.002,
    stopReason: "end_turn",
  };
}

const session: ProviderSession = {
  provider: "fake",
  id: "fake-1",
  send: () => turn(),
  interrupt: () => Promise.resolve(),
  close: () => Promise.resolve(),
};

const provider = {
  id: "fake",
  label: "Fake harness",
  executable: "fake",
  loginCommand: "fake login",
  capabilities: {},
  listModels: () => Promise.resolve([]),
  version: () => Promise.resolve("0"),
  run: () => turn(),
  openSession: () => session,
} as unknown as Provider;

const events: TranscriptEvent[] = [];
let context: { tokens: number; window?: number } | undefined;
const manager = new SessionManager(
  {
    onEvent: (_id, event) => events.push(event),
    onDelta: () => {},
    onStatus: () => {},
    onPermission: () => {},
    onPermissionResolved: () => {},
    onModels: () => {},
    onSessionId: () => {},
    onContext: (_id, tokens, window) => {
      context = { tokens, ...(window ? { window } : {}) };
    },
    onChain: () => {},
  },
  () => undefined,
  () => undefined,
  { parse: () => ({ providerId: "fake", model: "fake-1" }), create: () => provider },
);

const project: Project = { id: "p1", name: "fake", path: dir, sessions: [{ id: "p1" }] };
manager.send(project, "Rewrite hello.txt so it says after.");
await new Promise((r) => setTimeout(r, 500));
manager.disposeAll();
fs.rmSync(dir, { recursive: true, force: true });

const order = events.map((e) => e.kind).join(" → ");
const texts = events.filter((e) => e.kind === "assistant").map((e) => e.text);
const chips = events.filter((e): e is Extract<TranscriptEvent, { kind: "tool" }> => e.kind === "tool");
console.log(`order: ${order}`);
console.log(`assistant blocks: ${JSON.stringify(texts)}`);
for (const chip of chips) {
  console.log(`chip ${chip.name} — ${chip.summary}${chip.diff ? ` (+${chip.diff.added} −${chip.diff.removed})` : " (no patch)"}`);
}

const interleaved = order === "user → assistant → tool → assistant → assistant → result";
const banked =
  texts[0] === "I'll rewrite the file. Reading it first." &&
  texts[1] === "Done — it says after now." &&
  texts[2] === "Nothing else to do. Version 3.14 ships.";
const named = chips[0]?.name === "Edit";
const patched = chips[0]?.diff?.added === 1 && chips[0]?.diff?.removed === 1;
const lines = chips[0]?.diff?.hunks[0]?.lines.map((l) => `${l.kind}:${l.text}`).join(",");
const patchBody = lines === "del:before,add:after";
const gauged = context?.tokens === 1234;

console.log(`patch body: ${lines}`);
console.log(`context: ${JSON.stringify(context)}`);
console.log(
  `checks: interleaved=${interleaved} bankedText=${banked} ruriName=${named} patchCounts=${patched} patchBody=${patchBody} contextGauge=${gauged}`,
);
const ok = interleaved && banked && named && patched && patchBody && gauged;
console.log(ok ? "\nPROVIDER EVENTS PASS" : "\nPROVIDER EVENTS FAIL");
process.exit(ok ? 0 : 1);
