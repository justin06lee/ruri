import { afterEach, describe, expect, test } from "bun:test";
import { excerpt, handoffNote, type TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { contextBriefing } from "./selfCompaction.js";
import {
  contextLine,
  contextNotice,
  continuePrompt,
  parseCompactAt,
  requestCompaction,
  selfCompactAt,
  selfCompactDue,
  startedFresh,
} from "./selfCompaction.js";
import { TalkBook } from "./talk.js";

const NOTE =
  "Doing: the self-compaction job for the lead. Done: the module and its tests. Next: wire the hook, then prove it on real turns. Don't redo the research.";

/** A chat whose context holds `tokens` of a `window`, on `harness`. */
function chatAt(
  tokens: number,
  options: {
    window?: number;
    harness?: string;
    prefs?: Record<string, string>;
    agents?: number;
    events?: TranscriptEvent[];
  } = {},
): ServerContext {
  const session = { id: "c1", model: "m" };
  const project = { id: "p", name: "demo", path: "/tmp/demo", sessions: [session] };
  const window = options.window ?? 1_000_000;
  return {
    store: {
      findSession: (id: string) => (id === "c1" ? { project, session } : undefined),
      defaultModel: () => "m",
    },
    prefs: { all: () => options.prefs ?? {} },
    turns: { contexts: new Map([["c1", { tokens, window }]]) },
    archive: {
      contextTokens: () => tokens,
      contextWindowOf: () => window,
      events: () => options.events ?? [],
    },
    models: { windows: new Map() },
    manager: {
      harnessFor: () => options.harness ?? "claude",
      backgroundWork: () => ({ agents: options.agents ?? 0, scripts: 0 }),
    },
    talk: new TalkBook(),
  } as unknown as ServerContext;
}

const saved = process.env["RURI_SELF_COMPACT_AT"];
afterEach(() => {
  if (saved === undefined) delete process.env["RURI_SELF_COMPACT_AT"];
  else process.env["RURI_SELF_COMPACT_AT"] = saved;
});

describe("where an agent compacts itself", () => {
  test("half its window unless the user says otherwise — a share, a size, or off", () => {
    expect(parseCompactAt("0.5")).toEqual({ share: 0.5 });
    expect(parseCompactAt("40%")).toEqual({ share: 0.4 });
    expect(parseCompactAt("500k")).toEqual({ tokens: 500_000 });
    expect(parseCompactAt("1M")).toEqual({ tokens: 1_000_000 });
    expect(parseCompactAt("300000")).toEqual({ tokens: 300_000 });
    expect(parseCompactAt("off")).toBeUndefined();
    expect(parseCompactAt("soon")).toBeUndefined();
    expect(selfCompactAt(chatAt(0), "c1")).toBe(500_000);
    expect(selfCompactAt(chatAt(0, { window: 200_000 }), "c1")).toBe(100_000);
    expect(selfCompactAt(chatAt(0, { prefs: { "ruri-self-compact-at": "300k" } }), "c1")).toBe(300_000);
    expect(selfCompactAt(chatAt(0, { prefs: { "ruri-self-compact-at": "off" } }), "c1")).toBeUndefined();
    // the environment wins over the preference
    process.env["RURI_SELF_COMPACT_AT"] = "0.25";
    expect(selfCompactAt(chatAt(0, { prefs: { "ruri-self-compact-at": "300k" } }), "c1")).toBe(250_000);
    // and only a project's chats have one
    expect(selfCompactAt(chatAt(0), "nobody")).toBeUndefined();
  });
});

describe("an agent knows how full its context is", () => {
  test("with every prompt: tokens of the window, and how far from compacting itself", () => {
    expect(contextLine(chatAt(412_000), "c1")).toBe(
      "<ruri:context>412k of 1M tokens used (41%). You compact yourself at 500k, 88k from here.</ruri:context>\n",
    );
    const past = contextLine(chatAt(523_000), "c1");
    expect(past).toContain("past 500k, where you compact yourself");
    expect(past).toContain("call mcp__ruri__compact");
    expect(past).toContain("ruri compacts you at 800k");
    // a harness without ruri's tools is told the endpoint's call
    expect(contextLine(chatAt(523_000, { harness: "codex" }), "c1")).toContain('{"do": "compact"}');
    expect(contextLine(chatAt(0), "c1")).toContain("A fresh session");
    expect(contextLine(chatAt(100_000, { prefs: { "ruri-self-compact-at": "off" } }), "c1")).toBe(
      "<ruri:context>100k of 1M tokens used (10%). ruri compacts you at 800k.</ruri:context>\n",
    );
    expect(contextLine(chatAt(100_000), "nobody")).toBe("");
  });

  test("mid-turn, as it climbs: every twentieth of the window, every fortieth past its point", () => {
    const ctx = chatAt(300_000);
    const at = (tokens: number) => {
      (ctx.turns.contexts as Map<string, { tokens: number; window: number }>).set("c1", {
        tokens,
        window: 1_000_000,
      });
      return contextNotice(ctx, "c1");
    };
    contextLine(ctx, "c1"); // told at 300k with the prompt
    expect(at(320_000)).toBeUndefined();
    expect(at(352_000)).toContain("352k of 1M");
    expect(at(380_000)).toBeUndefined();
    // crossing the point is news at once
    expect(at(501_000)).toContain("past 500k");
    expect(at(515_000)).toBeUndefined();
    expect(at(527_000)).toContain("527k");
    // the step's tool results count before the next call reports them
    contextLine(ctx, "c1");
    (ctx.turns.contexts as Map<string, { tokens: number; window: number }>).set("c1", {
      tokens: 527_000,
      window: 1_000_000,
    });
    expect(contextNotice(ctx, "c1", 10_000)).toBeUndefined();
    expect(contextNotice(ctx, "c1", 30_000)).toContain("557k of 1M");
  });

  test("a fresh session gets room before it is held to its point, so it can't compact in a loop", () => {
    const ctx = chatAt(0, { prefs: { "ruri-self-compact-at": "50k" } });
    startedFresh(ctx, "c1");
    expect(contextLine(ctx, "c1")).toContain("A fresh session");
    // its first reading is already near the point: a brief and a system prompt
    (ctx.turns.contexts as Map<string, { tokens: number; window: number }>).set("c1", {
      tokens: 48_000,
      window: 1_000_000,
    });
    expect(contextNotice(ctx, "c1")).toBeUndefined();
    expect(contextLine(ctx, "c1")).toContain("You compact yourself at 61k");
    // with a reading well below it, the point stands
    const roomy = chatAt(0, { prefs: { "ruri-self-compact-at": "50k" } });
    startedFresh(roomy, "c1");
    (roomy.turns.contexts as Map<string, { tokens: number; window: number }>).set("c1", {
      tokens: 20_000,
      window: 1_000_000,
    });
    expect(contextLine(roomy, "c1")).toContain("You compact yourself at 50k");
  });

  test("the system prompt's words never carry a figure, so the cache holds", () => {
    expect(contextBriefing()).toBe(contextBriefing());
    expect(contextBriefing()).not.toMatch(/\d+k/);
    expect(contextBriefing()).toContain("mcp__ruri__compact");
    expect(contextBriefing("http://127.0.0.1:1/talk/c1")).toContain('{"do": "compact", "file"');
  });
});

describe("an agent compacts itself", () => {
  test("its note is kept for its turn's end — not too short, not before its time, not with work running", () => {
    expect(requestCompaction(chatAt(520_000), "c1", "too short")).toContain("too short");
    expect(requestCompaction(chatAt(200_000), "c1", NOTE)).toContain("Not yet");
    expect(requestCompaction(chatAt(520_000, { agents: 2 }), "c1", NOTE)).toContain("2 agents");
    const ctx = chatAt(520_000);
    expect(requestCompaction(ctx, "c1", NOTE)).toContain("End this turn now");
    expect(contextLine(ctx, "c1")).toContain("Your compaction is set");
    // nothing more mid-turn: it has been told to stop
    expect(contextNotice(ctx, "c1")).toBeUndefined();
    expect(requestCompaction(ctx, "c1", `${NOTE} And one more thing.`)).toContain("in place of the last");
    expect(selfCompactDue(ctx, "c1", { kind: "result", id: "r", ok: true, ts: 1 })).toBe(
      `${NOTE} And one more thing.`,
    );
    // spent
    expect(selfCompactDue(ctx, "c1", { kind: "result", id: "r", ok: true, ts: 1 })).toBeUndefined();
  });

  test("a stopped turn takes its note with it; a failed one keeps it for the next", () => {
    const ctx = chatAt(520_000);
    requestCompaction(ctx, "c1", NOTE);
    expect(selfCompactDue(ctx, "c1", { kind: "result", id: "r", ok: false, ts: 1 })).toBeUndefined();
    expect(selfCompactDue(ctx, "c1", { kind: "result", id: "r", ok: true, ts: 2 })).toBe(NOTE);
    requestCompaction(ctx, "c1", NOTE);
    expect(
      selfCompactDue(ctx, "c1", { kind: "result", id: "r", ok: false, stopped: true, ts: 3 }),
    ).toBeUndefined();
    expect(selfCompactDue(ctx, "c1", { kind: "result", id: "r", ok: true, ts: 4 })).toBeUndefined();
  });

  test("a compaction since — the user's, or ruri's own — leaves the note behind", () => {
    const events: TranscriptEvent[] = [];
    const ctx = chatAt(520_000, { events });
    requestCompaction(ctx, "c1", NOTE);
    events.push({ kind: "compaction", id: "m", text: "brief", entries: [], ts: Date.now() + 1 });
    expect(selfCompactDue(ctx, "c1", { kind: "result", id: "r", ok: true, ts: 1 })).toBeUndefined();
  });

  test("the fresh session is sent its note, and told who is owed the answer", () => {
    const plain = continuePrompt(NOTE);
    expect(plain).toContain(`<handoff-note>\n${NOTE}\n</handoff-note>`);
    expect(plain).toContain("Carry on from where it leaves off");
    expect(plain).not.toContain("message from");
    expect(continuePrompt(NOTE, { who: "ruri · Lead", reply: "wait" })).toContain(
      "The job is a message from ruri · Lead: when you finish it, your last message goes back to it as its answer",
    );
    expect(continuePrompt(NOTE, { who: "ruri · Lead", reply: "none" })).toContain("asked for no answer");
  });

  test("the chat knows the prompt for ruri's and finds the note in it — whole, or the history's cut", () => {
    expect(handoffNote(continuePrompt(NOTE))).toBe(NOTE);
    expect(handoffNote(continuePrompt(NOTE, { who: "ruri · Lead", reply: "wait" }))).toBe(NOTE);
    const cut = handoffNote(excerpt(continuePrompt(NOTE), 220));
    expect(cut && NOTE.startsWith(cut.replace(/…$/, ""))).toBe(true);
    expect(handoffNote(NOTE)).toBeUndefined();
  });
});
