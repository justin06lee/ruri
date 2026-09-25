import { afterEach, describe, expect, test } from "bun:test";
import {
  AuthRequiredError,
  type AgentEvent,
  type Provider,
  type ProviderSession,
  type ProviderSessionOptions,
} from "@justin06lee/yagami";
import type { Project, TranscriptEvent } from "../shared/protocol.js";
import { SessionManager, type LostPrompt } from "./sessions.js";

/**
 * A chat that moves between harnesses keeps a session on each: a switch
 * back resumes the one that harness had, a running turn is never retired
 * under it, what a session holds moves on only when a turn on it ends, and
 * a harness that has lost the session it was asked to resume hands the
 * prompt back to be sent to a fresh one — never an error, and never a
 * fresh session that quietly knows nothing.
 */

type Attempt = (options: ProviderSessionOptions) => AsyncGenerator<AgentEvent, void, undefined>;

interface Fake {
  opened: ProviderSessionOptions[];
  closed: number;
  attempts: Attempt[];
}

async function* answers(sessionId: string, text = "done"): AsyncGenerator<AgentEvent, void, undefined> {
  yield { type: "session", sessionId };
  yield { type: "text", text };
  yield { type: "done", usage: { input_tokens: 10, output_tokens: 5 }, stopReason: "end_turn" };
}

function fakeProvider(id: string, fake: Fake): Provider {
  return {
    id,
    label: id,
    capabilities: {},
    sessionCapabilities: { fork: true },
    openSession: (options: ProviderSessionOptions): ProviderSession => {
      fake.opened.push(options);
      const attempt = fake.attempts[Math.min(fake.opened.length - 1, fake.attempts.length - 1)]!;
      return {
        provider: id,
        id: undefined,
        send: () => attempt(options),
        interrupt: () => Promise.resolve(),
        close: () => {
          fake.closed += 1;
          return Promise.resolve();
        },
      } as unknown as ProviderSession;
    },
  } as unknown as Provider;
}

let manager: SessionManager | undefined;
afterEach(() => manager?.disposeAll());

interface World {
  alpha: Fake;
  beta: Fake;
  project: Project;
  events: TranscriptEvent[];
  /** The chat's session on each harness, as the archive would hold it. */
  sessions: Map<string, string>;
  seen: Array<[string, string]>;
  lost: Array<{ sessionId: string; lost: string; prompts: LostPrompt[] }>;
  send(text: string, eventId: string): void;
  settle(): Promise<void>;
}

function world(opts: { lostStart?: boolean; forkAt?: string } = {}): World {
  const w: World = {
    alpha: { opened: [], closed: 0, attempts: [(o) => answers(o.resume ?? "a-1")] },
    beta: { opened: [], closed: 0, attempts: [(o) => answers(o.resume ?? "b-1")] },
    project: { id: "chat", name: "demo", path: "/tmp", model: "alpha:m1", sessions: [{ id: "chat" }] },
    events: [],
    sessions: new Map(),
    seen: [],
    lost: [],
    send: (text, eventId) => manager!.send(w.project, text, undefined, undefined, true, eventId),
    settle: async () => {
      const results = () => w.events.filter((e) => e.kind === "result").length + w.lost.length;
      const before = results();
      for (let waited = 0; waited < 5_000 && results() === before; waited += 10) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // the session flips to idle just after its result
      await new Promise((r) => setTimeout(r, 20));
    },
  };
  const providers = { alpha: fakeProvider("alpha", w.alpha), beta: fakeProvider("beta", w.beta) };
  manager = new SessionManager(
    {
      onEvent: (_id, event) => w.events.push(event),
      onDelta: () => {},
      onStatus: () => {},
      onPermission: () => {},
      onPermissionResolved: () => {},
      onModels: () => {},
      onSessionId: (_id, sessionId) => w.sessions.set(sessionId.split(":")[0]!, sessionId),
      onSeen: (_id, sessionId, eventId) => w.seen.push([sessionId, eventId]),
      ...(opts.lostStart === false
        ? {}
        : {
            onLostStart: (_id: string, sessionId: string, lost: "session" | "point", prompts: LostPrompt[]) =>
              w.lost.push({ sessionId, lost, prompts }),
          }),
      onContext: () => {},
      onChain: () => {},
      onProgress: () => {},
      onQuestionLate: () => {},
    },
    (_id, harness) => w.sessions.get(harness),
    () => undefined,
    {
      parse: (model) => {
        const [providerId, native] = (model ?? "alpha:m1").split(":");
        return { providerId: providerId!, model: native! };
      },
      create: (id) => providers[id as "alpha" | "beta"],
      canFork: () => true,
    },
    () => opts.forkAt,
  );
  return w;
}

describe("a chat that moves between harnesses", () => {
  test("a switch back resumes the session that harness had", async () => {
    const w = world();
    w.send("plant the codeword", "p1");
    await w.settle();
    expect(w.sessions.get("alpha")).toBe("alpha:a-1");
    w.project.model = "beta:m2";
    w.send("what is it?", "p2");
    await w.settle();
    expect(w.beta.opened[0]!.resume).toBeUndefined();
    expect(w.sessions.get("beta")).toBe("beta:b-1");
    w.project.model = "alpha:m1";
    w.send("and now?", "p3");
    await w.settle();
    // the alpha session it had, not a fresh one — and not beta's
    expect(w.alpha.opened).toHaveLength(2);
    expect(w.alpha.opened[1]!.resume).toBe("a-1");
    expect(w.events.filter((e) => e.kind === "result").every((e) => e.kind === "result" && e.ok)).toBe(true);
  });

  test("a running turn is never retired by a prompt meant for another harness", async () => {
    const w = world();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    w.alpha.attempts = [
      async function* (o) {
        yield { type: "session", sessionId: o.resume ?? "a-1" };
        await held;
        yield { type: "text", text: "counted to eighty" };
        yield { type: "done", stopReason: "end_turn" };
      },
    ];
    w.send("count to eighty", "p1");
    await new Promise((r) => setTimeout(r, 30));
    // the chat switched under the turn, and a prompt reached the manager
    w.project.model = "beta:m2";
    expect(manager!.harnessFor(w.project)).toBe("alpha");
    w.send("and then?", "p2");
    expect(w.alpha.closed).toBe(0);
    expect(w.beta.opened).toHaveLength(0);
    release();
    const results = () => w.events.filter((e) => e.kind === "result").length;
    for (let waited = 0; waited < 3_000 && results() < 2; waited += 10) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 20));
    // both prompts ran on alpha, the turn untouched; the switch comes next
    expect(results()).toBe(2);
    expect(w.alpha.closed).toBe(0);
    expect(manager!.harnessFor(w.project)).toBe("beta");
  });

  test("a turn that ends says what its session now holds", async () => {
    const w = world();
    w.send("plant the codeword", "p1");
    await w.settle();
    expect(w.seen).toEqual([["alpha:a-1", "p1"]]);
  });

  test("a start that failed before any turn says nothing of what it holds", async () => {
    const w = world();
    w.alpha.attempts = [
      // eslint-disable-next-line require-yield
      async function* () {
        throw new AuthRequiredError("alpha", "alpha login", "not signed in");
      },
    ];
    w.send("plant the codeword", "p1");
    await w.settle();
    expect(w.events.find((e) => e.kind === "result")).toMatchObject({ ok: false });
    expect(w.seen).toEqual([]);
  });
});

describe("a harness that has lost the session it was asked to resume", () => {
  const refuses = (message: string): Attempt =>
    // eslint-disable-next-line require-yield
    async function* () {
      throw new Error(message);
    };

  test("Codex's 'no rollout found' hands the prompt back for a fresh session", async () => {
    const w = world();
    w.sessions.set("alpha", "alpha:gone");
    w.alpha.attempts = [refuses("codex: no rollout found for thread id gone")];
    w.send("what is the codeword?", "p1");
    await w.settle();
    expect(w.lost).toEqual([
      {
        sessionId: "alpha:gone",
        lost: "session",
        prompts: [{ text: "what is the codeword?", eventId: "p1" }],
      },
    ]);
    // no error for the chat to show, and no second try against nothing
    expect(w.events.some((e) => e.kind === "result")).toBe(false);
    expect(w.alpha.opened).toHaveLength(1);
    expect(w.alpha.closed).toBeGreaterThan(0);
  });

  test("a vaguer refusal is tried once more, then believed", async () => {
    const w = world();
    w.sessions.set("alpha", "alpha:gone");
    w.alpha.attempts = [refuses("opencode: Internal error: OpenCode service failure")];
    w.send("what is the codeword?", "p1");
    await w.settle();
    expect(w.alpha.opened).toHaveLength(2);
    expect(w.lost).toHaveLength(1);
    expect(w.events.some((e) => e.kind === "result")).toBe(false);
  });

  test("a vague refusal that clears on the second try was a hiccup: the session stays", async () => {
    const w = world();
    w.sessions.set("alpha", "alpha:a-7");
    w.alpha.attempts = [
      refuses("opencode: Internal error: OpenCode service failure"),
      (o) => answers(o.resume!),
    ];
    w.send("what is the codeword?", "p1");
    await w.settle();
    expect(w.lost).toEqual([]);
    expect(w.alpha.opened[1]!.resume).toBe("a-7");
    expect(w.events.find((e) => e.kind === "result")).toMatchObject({ ok: true });
  });

  test("an agent that answers a resume with a new session of its own has lost it", async () => {
    const w = world();
    w.sessions.set("alpha", "alpha:a-1");
    w.alpha.attempts = [() => answers("a-fresh", "I have no idea what codeword you mean")];
    w.send("what is the codeword?", "p1");
    await w.settle();
    expect(w.lost).toMatchObject([{ sessionId: "alpha:a-1", lost: "session" }]);
    // the answer from a model that never heard the conversation goes nowhere
    expect(w.events.some((e) => e.kind === "assistant")).toBe(false);
    expect(w.sessions.get("alpha")).toBe("alpha:a-1");
  });

  test("a fork answers with a new session by design", async () => {
    const w = world({ forkAt: "turn-3" });
    w.sessions.set("alpha", "alpha:a-1");
    w.alpha.attempts = [() => answers("a-forked")];
    w.send("go on from there", "p1");
    await w.settle();
    expect(w.alpha.opened[0]).toMatchObject({ resume: "a-1", forkAt: "turn-3" });
    expect(w.lost).toEqual([]);
    expect(w.sessions.get("alpha")).toBe("alpha:a-forked");
  });

  test("a fork point the harness can't find is a lost point", async () => {
    const w = world({ forkAt: "turn-3" });
    w.sessions.set("alpha", "alpha:a-1");
    w.alpha.attempts = [refuses("codex: no rollout found for thread id a-1")];
    w.send("go on from there", "p1");
    await w.settle();
    expect(w.lost).toMatchObject([{ sessionId: "alpha:a-1", lost: "point" }]);
  });

  test("with nobody to hand it to, it is the turn's error, as it always was", async () => {
    const w = world({ lostStart: false });
    w.sessions.set("alpha", "alpha:gone");
    w.alpha.attempts = [refuses("codex: no rollout found for thread id gone")];
    w.send("what is the codeword?", "p1");
    await w.settle();
    expect(w.events.find((e) => e.kind === "result")).toMatchObject({
      ok: false,
      error: "codex: no rollout found for thread id gone",
    });
  });
});
