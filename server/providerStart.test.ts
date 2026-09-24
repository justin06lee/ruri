import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthRequiredError,
  type AgentEvent,
  type Provider,
  type ProviderSession,
  type ProviderSessionOptions,
} from "@justin06lee/yagami";
import type { Project, TranscriptEvent } from "../shared/protocol.js";
import { SessionManager } from "./sessions.js";

/**
 * A harness process that dies as it starts — OpenCode's "database is
 * locked" when another OpenCode opens in the same moment, surfacing as "ACP
 * connection closed" — is opened again and the prompt goes to it; one that
 * has started saying something, or was refused for a reason a second try
 * won't change, is left to fail.
 */

type Attempt = (options: ProviderSessionOptions) => AsyncGenerator<AgentEvent, void, undefined>;

const closed = () => new Error("ACP connection closed");

async function* answers(sessionId = "s-new"): AsyncGenerator<AgentEvent, void, undefined> {
  yield { type: "session", sessionId };
  yield { type: "text", text: "ruri.codes is queued." };
  yield { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, stopReason: "end_turn" };
}

let manager: SessionManager | undefined;
afterEach(() => manager?.disposeAll());

/** Run one prompt through a fake harness whose opens go as `attempts` say. */
async function prompt(
  attempts: Attempt[],
  opts: { resume?: string; forkAt?: string; stopAfter?: number } = {},
): Promise<{ events: TranscriptEvent[]; opened: ProviderSessionOptions[] }> {
  const events: TranscriptEvent[] = [];
  const opened: ProviderSessionOptions[] = [];
  const provider = {
    id: "fake",
    label: "Fake harness",
    capabilities: {},
    sessionCapabilities: { fork: true },
    openSession: (options: ProviderSessionOptions): ProviderSession => {
      opened.push(options);
      const attempt = attempts[Math.min(opened.length - 1, attempts.length - 1)]!;
      return {
        provider: "fake",
        id: undefined,
        send: () => attempt(options),
        interrupt: () => Promise.resolve(),
        close: () => Promise.resolve(),
      } as unknown as ProviderSession;
    },
  } as unknown as Provider;
  manager = new SessionManager(
    {
      onEvent: (_id, event) => events.push(event),
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
    () => (opts.resume ? `fake:${opts.resume}` : undefined),
    () => undefined,
    { parse: () => ({ providerId: "fake", model: "fake-1" }), create: () => provider, canFork: () => true },
    () => opts.forkAt,
  );
  const project: Project = { id: "home", name: "Home", path: "/tmp", sessions: [{ id: "home" }] };
  manager.send(project, "create and open a new project: ruri.codes", undefined, undefined, true, "p1");
  if (opts.stopAfter !== undefined) {
    await new Promise((r) => setTimeout(r, opts.stopAfter));
    manager.interrupt("home");
  }
  for (let waited = 0; waited < 5_000 && !events.some((e) => e.kind === "result"); waited += 25) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return { events, opened };
}

const result = (events: TranscriptEvent[]) =>
  events.find((e): e is Extract<TranscriptEvent, { kind: "result" }> => e.kind === "result");

describe("a harness that dies as it starts", () => {
  test("is opened again, and the prompt is answered", async () => {
    // eslint-disable-next-line require-yield
    const dies: Attempt = async function* () {
      throw closed();
    };
    const { events, opened } = await prompt([dies, () => answers()]);
    expect(result(events)).toMatchObject({ ok: true });
    expect(events.some((e) => e.kind === "assistant" && e.text === "ruri.codes is queued.")).toBe(true);
    expect(opened).toHaveLength(2);
  });

  test("so is one kept warm that died while idle — on the session it had", async () => {
    const warmDead: Attempt = async function* () {
      yield { type: "session", sessionId: "s-forked" };
      throw closed();
    };
    const { events, opened } = await prompt([warmDead, (o) => answers(o.resume)], {
      resume: "s-old",
      forkAt: "turn-3",
    });
    expect(result(events)).toMatchObject({ ok: true });
    // the first open forked; the second goes back to the fork, and makes no other
    expect(opened[0]).toMatchObject({ resume: "s-old", forkAt: "turn-3" });
    expect(opened[1]!.resume).toBe("s-forked");
    expect(opened[1]!.forkAt).toBeUndefined();
    expect(opened[1]!.fork).toBeUndefined();
  });

  test("a start that dies before any session keeps the fork it was asked for", async () => {
    // eslint-disable-next-line require-yield
    const dies: Attempt = async function* () {
      throw new Error("/opt/bin/opencode exited with code 1: database is locked");
    };
    const { opened } = await prompt([dies, (o) => answers(o.resume)], { resume: "s-old", forkAt: "turn-3" });
    expect(opened[1]).toMatchObject({ resume: "s-old", forkAt: "turn-3" });
  });

  test("gives up after two more tries", async () => {
    // eslint-disable-next-line require-yield
    const dies: Attempt = async function* () {
      throw closed();
    };
    const { events, opened } = await prompt([dies]);
    expect(result(events)).toMatchObject({ ok: false, error: "ACP connection closed" });
    expect(opened).toHaveLength(3);
  });
});

describe("what is not tried again", () => {
  test("a turn the harness had started saying something in", async () => {
    const midTurn: Attempt = async function* () {
      yield { type: "session", sessionId: "s-1" };
      yield { type: "text", text: "Creating the folder" };
      throw closed();
    };
    const { events, opened } = await prompt([midTurn, () => answers()]);
    expect(result(events)).toMatchObject({ ok: false });
    expect(opened).toHaveLength(1);
  });

  test("a harness that isn't signed in", async () => {
    // eslint-disable-next-line require-yield
    const signedOut: Attempt = async function* () {
      throw new AuthRequiredError("fake", "fake login", "not signed in");
    };
    const { events, opened } = await prompt([signedOut, () => answers()]);
    expect(result(events)).toMatchObject({ ok: false });
    expect(opened).toHaveLength(1);
  });

  test("a turn the user stopped while it waited to go again", async () => {
    // eslint-disable-next-line require-yield
    const dies: Attempt = async function* () {
      throw closed();
    };
    const { events, opened } = await prompt([dies, () => answers()], { stopAfter: 100 });
    expect(result(events)).toMatchObject({ ok: false });
    expect(opened).toHaveLength(1);
  });
});
