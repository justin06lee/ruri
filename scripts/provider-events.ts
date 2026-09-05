/**
 * A harness turn, event by event, with no harness: a fake provider streams
 * exactly what one does — narration, a patch call, more narration — and the
 * transcript it produces is checked against what ruri promises for every
 * model. Costs nothing, so it runs with the rest: bun run provider-events
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import type {
  AgentEvent,
  Provider,
  ProviderSession,
  ProviderSessionOptions,
  SessionInputResponse,
} from "@justin06lee/yagami";
import type { AskQuestion, Project, TranscriptEvent } from "../shared/protocol.js";
import { questionError } from "../shared/questionInput.js";
import { SessionManager } from "../server/sessions.js";

// Both the card and provider adapter must reject invalid typed answers.
const workers: AskQuestion = {
  question: "Workers", header: "Workers", options: [], multiSelect: false,
  inputType: "integer", minimum: 1, maximum: 8,
};
assert.equal(questionError(workers, ["3"]), undefined);
assert.match(questionError(workers, ["2.5"])!, /whole number/);
assert.match(questionError(workers, ["0"])!, /Minimum/);
assert.match(questionError(workers, ["9"])!, /Maximum/);
assert.match(questionError(workers, ["NaN"])!, /number/);
assert.match(questionError(workers, [])!, /required/);
assert.equal(questionError({ ...workers, required: false }, []), undefined);
assert.match(questionError(workers, ["2", "3"])!, /one answer/);
const choice: AskQuestion = {
  question: "Enabled", header: "Enabled", multiSelect: false,
  inputType: "boolean", allowOther: false,
  options: [{ label: "No", value: "false", description: "" }],
};
assert.equal(questionError(choice, ["false"]), undefined);
assert.match(questionError(choice, ["No"])!, /yes or no/);
assert.match(questionError({ ...choice, inputType: "string" }, ["unknown"])!, /offered option/);
assert.match(questionError({ ...choice, inputType: "string", minLength: 3 }, ["ab"])!, /at least/);
assert.match(questionError({ ...choice, inputType: "string", maxLength: 3 }, ["abcd"])!, /at most/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-events-"));
const target = path.join(dir, "hello.txt");
fs.writeFileSync(target, "before\n");

/** What a harness streams for "narrate, patch a file, narrate" — including
 *  the two things that ran a turn's sentences together: a second message
 *  arriving as bare chunks with no boundary, and no space where the first
 *  one's full stop met it. */
let sessionOptions: ProviderSessionOptions | undefined;
let inputResponse: SessionInputResponse | undefined;
let editDecision: string | undefined;

async function* turn(): AsyncGenerator<AgentEvent, void, undefined> {
  yield { type: "session", sessionId: "fake-1" };
  yield { type: "turn", id: "turn-7" };
  editDecision = await sessionOptions!.permissions.decide({
    provider: "fake",
    sessionId: "fake-1",
    tool: "apply_patch",
    kind: "edit",
  });
  yield {
    type: "plan",
    plan: {
      id: "provider-owned-id",
      explanation: "A live plan from the harness",
      entries: [
        { content: "Ask for the workspace name", status: "in_progress" },
        { content: "Rewrite the file", status: "pending" },
      ],
    },
  };
  inputResponse = await sessionOptions!.input!.respond({
    provider: "fake",
    sessionId: "fake-1",
    kind: "form",
    message: "Name the workspace",
    fields: [
      { id: "name", label: "Workspace name", type: "string", required: true },
      { id: "workers", label: "Workers", type: "integer", required: true, minimum: 1, maximum: 8, default: 3 },
      { id: "enabled", label: "Enabled", type: "boolean", required: true },
      { id: "token", label: "Token", type: "string", required: true, secret: true },
      { id: "optional", label: "Optional", type: "string", required: false },
    ],
  });
  yield {
    type: "plan",
    plan: {
      id: "provider-owned-id",
      explanation: "The answer arrived",
      entries: [
        { content: "Ask for the workspace name", status: "completed" },
        { content: "Rewrite the file", status: "in_progress" },
      ],
    },
  };
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
  sessionCapabilities: { fork: true },
  listModels: () => Promise.resolve([]),
  version: () => Promise.resolve("0"),
  run: () => turn(),
  openSession: (options: ProviderSessionOptions) => {
    sessionOptions = options;
    return session;
  },
} as unknown as Provider;

const events: TranscriptEvent[] = [];
let context: { tokens: number; window?: number } | undefined;
let questionShown = false;
let constraintsKept = false;
const progress: Array<{ chars?: number; tokens?: number }> = [];
let editPermissionShown = false;
const chains: Array<{ eventId: string; kind: "user" | "last"; id: string }> = [];
const manager = new SessionManager(
  {
    onEvent: (_id, event) => {
      const existing = events.findIndex((candidate) => candidate.id === event.id);
      if (existing === -1) events.push(event);
      else events[existing] = event;
    },
    onDelta: () => {},
    onStatus: () => {},
    onPermission: (request) => {
      if (request.kind !== "question") {
        editPermissionShown = true;
        setTimeout(() => manager.respondPermission(request.requestId, true), 0);
        return;
      }
      questionShown = true;
      const fields = (request.input as { questions: Array<{ id?: string; minimum?: number; maximum?: number; default?: unknown }> }).questions;
      const workers = fields.find((field) => field.id === "workers");
      constraintsKept = workers?.minimum === 1 && workers.maximum === 8 && workers.default === 3;
      setTimeout(() => {
        manager.respondQuestion(request.requestId, {
          answers: { "Workspace name": "Ruri" },
          values: { name: ["Ruri"], workers: ["3"], enabled: ["false"], token: [" fixture-only-secret "], optional: [] },
        });
      }, 0);
    },
    onPermissionResolved: () => {},
    onModels: () => {},
    onSessionId: () => {},
    onContext: (_id, tokens, window) => {
      context = { tokens, ...(window ? { window } : {}) };
    },
    onChain: (_projectId, eventId, kind, id) => chains.push({ eventId, kind, id }),
    onProgress: (_id, value) => progress.push(value),
    onQuestionLate: () => {},
  },
  () => "fake:source-thread",
  () => undefined,
  {
    parse: () => ({ providerId: "fake", model: "fake-1" }),
    create: () => provider,
    canFork: () => true,
  },
  () => "turn-3",
);

const project: Project = {
  id: "p1",
  name: "fake",
  path: dir,
  permissionMode: "acceptEdits",
  sessions: [{ id: "p1" }],
};
// The server owns the visible prompt; the model payload is sent silently.
events.push({ kind: "user", id: "visible-prompt", text: "Rewrite hello.txt so it says after.", ts: Date.now() });
manager.send(project, "Rewrite hello.txt so it says after.", undefined, undefined, true, "visible-prompt");
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

const interleaved = order === "user → plan → assistant → tool → assistant → assistant → result";
const banked =
  texts[0] === "I'll rewrite the file. Reading it first." &&
  texts[1] === "Done — it says after now." &&
  texts[2] === "Nothing else to do. Version 3.14 ships.";
const named = chips[0]?.name === "Edit";
const patched = chips[0]?.diff?.added === 1 && chips[0]?.diff?.removed === 1;
const lines = chips[0]?.diff?.hunks[0]?.lines.map((l) => `${l.kind}:${l.text}`).join(",");
const patchBody = lines === "del:before,add:after";
const gauged = context?.tokens === 1234;
const plans = events.filter((event) => event.kind === "plan");
const planned = plans.length === 1 && plans[0]?.id !== "provider-owned-id" &&
  plans[0]?.entries?.[0]?.status === "completed";
const thinkingProgress = progress.some((value) => value.chars === "checking the result".length);
const answered =
  questionShown && constraintsKept && inputResponse?.action === "accept" &&
  inputResponse.values?.["name"] === "Ruri" && inputResponse.values["workers"] === 3 &&
  inputResponse.values["enabled"] === false && inputResponse.values["token"] === " fixture-only-secret " &&
  !("optional" in inputResponse.values) && !JSON.stringify(events).includes("fixture-only-secret");
const chained =
  chains.length === 2 &&
  chains[0]?.eventId === "visible-prompt" && chains[1]?.eventId === "visible-prompt" &&
  chains[0]?.kind === "user" &&
  chains[0]?.id === "turn-7" &&
  chains[1]?.kind === "last" &&
  chains[1]?.id === "turn-7";
const forked = sessionOptions?.resume === "source-thread" && sessionOptions.forkAt === "turn-3";
const editsAutoAllowed = editDecision === "allow" && !editPermissionShown;

console.log(`patch body: ${lines}`);
console.log(`context: ${JSON.stringify(context)}`);
console.log(
  `checks: interleaved=${interleaved} bankedText=${banked} ruriName=${named} patchCounts=${patched} patchBody=${patchBody} contextGauge=${gauged} plan=${planned} input=${answered} turnChain=${chained} nativeFork=${forked} acceptEdits=${editsAutoAllowed}`,
);
const ok = thinkingProgress && interleaved && banked && named && patched && patchBody && gauged && planned && answered && chained && forked && editsAutoAllowed;
console.log(ok ? "\nPROVIDER EVENTS PASS" : "\nPROVIDER EVENTS FAIL");
process.exit(ok ? 0 : 1);
