/**
 * A harness turn, event by event, with no harness: a fake provider streams
 * exactly what one does — narration, a patch call, more narration — and the
 * transcript it produces is checked against what ruri promises for every
 * model. Costs nothing, so it runs with the rest: bun run provider-events
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentEvent,
  Provider,
  ProviderSession,
  ProviderSessionOptions,
  SessionInputResponse,
} from "@justin06lee/yagami";
import type { Project, TranscriptEvent } from "../shared/protocol.js";
import { SessionManager } from "../server/sessions.js";

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
    fields: [{ id: "name", label: "Workspace name", type: "string", required: true }],
  });
  yield {
    type: "plan",
    plan: {
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
      setTimeout(() => {
        manager.respondQuestion(request.requestId, {
          answers: { "Workspace name": "Ruri" },
          values: { name: ["Ruri"] },
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
const planned = events.some(
  (event) => event.kind === "plan" && event.entries?.[0]?.status === "completed",
);
const answered =
  questionShown && inputResponse?.action === "accept" && inputResponse.values?.["name"] === "Ruri";
const chained =
  chains.length === 2 &&
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
const ok = interleaved && banked && named && patched && patchBody && gauged && planned && answered && chained && forked && editsAutoAllowed;
console.log(ok ? "\nPROVIDER EVENTS PASS" : "\nPROVIDER EVENTS FAIL");
process.exit(ok ? 0 : 1);
