/**
 * Subagents, seen from the chat, with no harness: a fake provider streams
 * what Codex does when it spawns an agent — the spawn call, the agent's own
 * work on its own thread (some of it before the spawn has said which thread
 * that is), a wait that reports the agent done — and a second agent that is
 * still running when the session goes away.
 *
 * Checks the promise: the chat gets one card per agent and never the
 * agent's words; the card moves along in place and ends with the agent's
 * report; the agent's log opens on its brief and holds what it did, in
 * order; and an agent whose process is gone is stopped, not left working.
 *
 * Costs nothing: bun run subagents-test
 */
import type { AgentEvent, Provider, ProviderSession } from "@justin06lee/yagami";
import type { Project, SubagentState, TranscriptEvent } from "../shared/protocol.js";
import { SessionManager } from "../server/sessions.js";

async function* turn(): AsyncGenerator<AgentEvent, void, undefined> {
  yield { type: "session", sessionId: "fake-1" };
  yield { type: "turn", id: "turn-1" };
  yield { type: "text", text: "Sending an agent to check the tests." };
  yield {
    type: "tool_call",
    id: "spawn-1",
    name: "spawn_agent",
    status: "started",
    title: "Check the tests\nand report what fails.",
    input: { prompt: "Check the tests\nand report what fails.", model: "gpt-test" },
  };
  // the agent is at work before its spawn call has finished saying which
  // thread it runs on — this has to wait for that, not vanish
  yield {
    type: "tool_call",
    id: "sub-exec-1",
    name: "shell",
    status: "started",
    title: "bun test",
    input: { command: "bun test" },
    thread: "sub-1",
  } as AgentEvent;
  yield {
    type: "tool_call",
    id: "spawn-1",
    name: "spawn_agent",
    status: "completed",
    input: {
      prompt: "Check the tests\nand report what fails.",
      model: "gpt-test",
      receiverThreadIds: ["sub-1"],
    },
    output: { "sub-1": { status: "running" } },
  };
  yield { type: "text", text: "All tests pass.", thread: "sub-1" } as AgentEvent;
  // a second agent, spawned and never heard from again
  yield {
    type: "tool_call",
    id: "spawn-2",
    name: "spawn_agent",
    status: "started",
    title: "Watch the build",
    input: { prompt: "Watch the build", receiverThreadIds: ["sub-2"] },
  };
  yield {
    type: "tool_call",
    id: "wait-1",
    name: "wait",
    status: "started",
    input: { receiverThreadIds: ["sub-1"] },
  };
  yield {
    type: "tool_call",
    id: "wait-1",
    name: "wait",
    status: "completed",
    input: { receiverThreadIds: ["sub-1"] },
    output: { "sub-1": { status: "completed", message: "All 12 tests pass." } },
  };
  yield { type: "text", text: "The agent says they all pass." };
  yield { type: "done", usage: { input_tokens: 100, output_tokens: 20 }, stopReason: "end_turn" };
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
  sessionCapabilities: { fork: false },
  listModels: () => Promise.resolve([]),
  version: () => Promise.resolve("0"),
  run: () => turn(),
  openSession: () => session,
} as unknown as Provider;

const chat: TranscriptEvent[] = [];
const logs = new Map<string, TranscriptEvent[]>();
let fresh = 0;
let updates = 0;
const upsert = (list: TranscriptEvent[], event: TranscriptEvent) => {
  const at = list.findIndex((candidate) => candidate.id === event.id);
  if (at === -1) list.push(event);
  else list[at] = event;
};

const manager = new SessionManager(
  {
    onEvent: (_id, event) => {
      if (event.kind === "tool" && event.agent) fresh += 1;
      upsert(chat, event);
    },
    onEventUpdate: (_id, event) => {
      updates += 1;
      const at = chat.findIndex((candidate) => candidate.id === event.id);
      if (at !== -1) chat[at] = event;
    },
    onAgentEvent: (_id, key, event) => {
      const log = logs.get(key) ?? [];
      upsert(log, event);
      logs.set(key, log);
    },
    onDelta: () => {},
    onStatus: () => {},
    onPermission: () => {},
    onPermissionResolved: () => {},
    onModels: () => {},
    onSessionId: () => {},
    onContext: () => {},
    onChain: () => {},
    onProgress: () => {},
    onQuestionLate: () => {},
  },
  () => undefined,
  () => undefined,
  {
    parse: () => ({ providerId: "fake", model: "fake-1" }),
    create: () => provider,
  },
);

const project: Project = { id: "p1", name: "fake", path: "/tmp", sessions: [{ id: "p1" }] };
manager.send(project, "Check the tests with an agent.");
await new Promise((r) => setTimeout(r, 400));
const card = (key: string): SubagentState | undefined =>
  chat.flatMap((e) => (e.kind === "tool" && e.agent?.key === key ? [e.agent] : []))[0];
const beforeDispose = card("spawn-2")?.status;
manager.disposeAll();

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("    ", JSON.stringify(detail));
  }
}

const cards = chat.filter((e) => e.kind === "tool" && e.agent);
const said = chat.filter((e) => e.kind === "assistant").map((e) => (e.kind === "assistant" ? e.text : ""));
check(
  "the chat gets one card per agent, and nothing else of theirs",
  cards.length === 2 && fresh === 2,
  chat,
);
check(
  "the agent's words stay out of the reply",
  !said.some((text) => text.includes("All tests pass")) &&
    said.join(" ").includes("The agent says they all pass."),
  said,
);
check(
  "Codex's wait stays an ordinary chip",
  chat.some((e) => e.kind === "tool" && !e.agent && e.name !== "Agent"),
  chat,
);
const first = card("spawn-1");
check(
  "the card is titled by its brief's first line and names its model",
  first?.description === "Check the tests" && first.model === "gpt-test",
  first,
);
check("the card moved along in place", updates > 0 && first?.status === "done", { updates, first });
check("and ends with the agent's report", first?.result === "All 12 tests pass.", first);
const log = logs.get("spawn-1") ?? [];
check(
  "its log opens on the brief, then what it did — the early tool included — in order",
  log.map((e) => e.kind).join(",") === "user,tool,assistant" &&
    log[0]?.kind === "user" &&
    log[0].text === "Check the tests\nand report what fails." &&
    log[1]?.kind === "tool" &&
    log[1].summary.includes("bun test") &&
    log[2]?.kind === "assistant" &&
    log[2].text === "All tests pass.",
  log,
);
check(
  "the card's line is the last thing it did — here, what it said after its tool",
  first?.activity === "All tests pass.",
  first,
);
check(
  "an agent still working stays working while its session lives",
  beforeDispose === "running",
  beforeDispose,
);
check("and is stopped when the session goes", card("spawn-2")?.status === "stopped", card("spawn-2"));

console.log(failed === 0 ? "\nSUBAGENTS PASS" : `\nSUBAGENTS FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
