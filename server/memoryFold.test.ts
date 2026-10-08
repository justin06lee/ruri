import { describe, expect, test } from "bun:test";
import type { MemoryLine, ProjectMemory } from "../shared/protocol.js";
import { emptyMemory } from "./memoryLines.js";
import { foldTurns, outsideTool, parseOps, type FoldInput, type FoldTurn } from "./memoryFold.js";
import { applyChanges, emptyState, linesWith, reconcile, viewOf, type MemoryState } from "./memoryLog.js";

const line = (id: string, text: string, extra: Partial<MemoryLine> = {}): MemoryLine => ({
  id,
  text,
  by: "model",
  ...extra,
});
const memoryOf = (parts: Partial<ProjectMemory>): ProjectMemory => ({ ...emptyMemory(), ...parts });

function stateOf(memory: ProjectMemory): MemoryState {
  const state = emptyState();
  reconcile(state, memory, 1000);
  return state;
}

const turn = (n: number, extra: Partial<FoldTurn> = {}): FoldTurn => ({
  chat: "abcd1234-chat",
  turnId: `t${n}`,
  ref: `abcd1234#${n}`,
  day: "2026-10-07",
  user: `prompt ${n}`,
  assistant: `reply ${n}`,
  files: [],
  ...extra,
});

function inputOf(state: MemoryState, turns: FoldTurn[], stack?: FoldInput["stack"]): FoldInput {
  return {
    project: "demo",
    today: "2026-10-07",
    lines: linesWith(state),
    turns,
    resolve: (ref) => {
      const n = /#(\d+)$/.exec(ref)?.[1];
      return n ? { chat: "abcd1234-chat", turn: `t${n}` } : undefined;
    },
    ...(stack ? { stack } : {}),
  };
}

/** A model that answers each call in turn with the scripted replies, and
 *  remembers what it was asked. */
function scripted(...replies: string[]) {
  const asked: Array<{ system: string; prompt: string }> = [];
  const ask = async (system: string, prompt: string) => {
    asked.push({ system, prompt });
    return replies.shift() ?? '{"decisions": []}';
  };
  return { ask, asked };
}

/** Fold `turns` into `state` with a scripted model, and apply what comes back. */
async function fold(state: MemoryState, turns: FoldTurn[], ...replies: string[]) {
  const model = scripted(...replies);
  const result = await foldTurns(inputOf(state, turns), model.ask);
  const applied = applyChanges(state, result.changes, { by: "model", fold: "f1" });
  return { ...result, ...applied, asked: model.asked };
}

describe("reading the model's answer", () => {
  test("whole JSON, JSON in prose, and an answer cut off mid-way all give the ops they hold", () => {
    expect(parseOps('{"ops": [{"op": "noop"}]}')).toEqual([{ op: "noop" }]);
    expect(
      parseOps('Here you go:\n```json\n{"ops": [{"op": "retire", "id": "o1", "reason": "done"}]}\n```'),
    ).toEqual([{ op: "retire", id: "o1", reason: "done" }]);
    const cut =
      '{"ops": [{"op": "add", "part": "open", "text": "first {braced} \\"quoted\\""}, {"op": "add", "part": "open", "te';
    expect(parseOps(cut)).toEqual([{ op: "add", part: "open", text: 'first {braced} "quoted"' }]);
    expect(
      parseOps('{"ops": [{"op": "add", "part": "open", "text": "ok"}, {broken}, {"op": "noop"}]}'),
    ).toEqual([{ op: "add", part: "open", text: "ok" }, { op: "noop" }]);
    expect(parseOps("I cannot help with that.")).toEqual([]);
  });
});

describe("a fold's changes, from scripted answers", () => {
  test("an answer with nothing usable changes nothing — never empties the memory", async () => {
    const state = stateOf(memoryOf({ decisions: [line("d1", "keep me")] }));
    for (const reply of ["", "Sure! The memory is fine.", '{"memory": {"decisions": []}}', "{not json"]) {
      const result = await fold(state, [turn(1)], reply);
      expect(result.answered).toBe(false);
      expect(result.events).toEqual([]);
    }
    expect(viewOf(state).decisions.map((l) => l.id)).toEqual(["d1"]);
  });

  test("leaving a line out is not taking it out: only what the ops name changes", async () => {
    const state = stateOf(memoryOf({ decisions: [line("d1", "one")], open: [line("o1", "two")] }));
    const result = await fold(
      state,
      [turn(3)],
      '{"ops": [{"op": "add", "part": "worked", "text": "Run the stress test from a snapshot in /tmp", "from": "abcd1234#3"}]}',
    );
    expect(result.answered).toBe(true);
    const view = viewOf(state);
    expect(view.decisions.map((l) => l.id)).toEqual(["d1"]);
    expect(view.open.map((l) => l.id)).toEqual(["o1"]);
    expect(view.worked[0]).toMatchObject({ by: "model", source: { chat: "abcd1234-chat", turn: "t3" } });
  });

  test("ops on ids that aren't there, and ops missing what they need, are dropped or refused", async () => {
    const state = stateOf(memoryOf({ open: [line("o1", "two")] }));
    const result = await fold(
      state,
      [turn(1)],
      JSON.stringify({
        ops: [
          { op: "retire", id: "zzzz", reason: "done" },
          { op: "update", id: "nope", text: "x" },
          { op: "add", part: "nonsense", text: "x" },
          { op: "add", part: "open" },
          { op: "explode", id: "o1" },
          { op: "supersede", id: "o1" },
        ],
      }),
    );
    expect(result.events).toEqual([]);
    expect(result.refused.map((r) => r.reason)).toEqual(["there is no line zzzz", "there is no line nope"]);
    expect(viewOf(state).open.map((l) => l.id)).toEqual(["o1"]);
  });

  test("an answer retiring everything takes out a few lines at most", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => line(`g${i}`, `trap number ${i} about thing ${i}`));
    const state = stateOf(memoryOf({ gotchas: lines.slice(0, 10), open: lines.slice(10) }));
    const result = await fold(
      state,
      [turn(1)],
      JSON.stringify({ ops: lines.map((l) => ({ op: "retire", id: l.id, reason: "start over" })) }),
    );
    expect(result.events.filter((e) => e.op === "retire")).toHaveLength(3);
    expect(linesWith(state)).toHaveLength(9);
  });

  test("the user's and pinned lines are out of reach; an agent's goes only with evidence", async () => {
    const state = stateOf(
      memoryOf({
        decisions: [
          line("d1", "user's", { by: "user" }),
          line("d2", "pinned", { pinned: true }),
          line("d3", "agent's", { by: "agent" }),
          line("d4", "another agent's", { by: "agent" }),
        ],
      }),
    );
    const result = await fold(
      state,
      [turn(5)],
      JSON.stringify({
        ops: [
          { op: "update", id: "d1", text: "the model's version" },
          { op: "retire", id: "d2", reason: "stale" },
          { op: "update", id: "d3", text: "reworded agent line" },
          { op: "retire", id: "d4", reason: "reversed", evidence: "abcd1234#5 moved back to polling" },
        ],
      }),
    );
    expect(result.refused).toHaveLength(3);
    expect(viewOf(state).decisions.map((l) => l.text)).toEqual(["user's", "pinned", "agent's"]);
    expect(state.lines.get("d4")).toMatchObject({ status: "retired" });
  });

  test("a supersede keeps the old line in the log, with its replacement in its place", async () => {
    const state = stateOf(memoryOf({ decisions: [line("d1", "icon LIFT 9 NUDGE 18")] }));
    const result = await fold(
      state,
      [turn(7)],
      JSON.stringify({
        ops: [
          {
            op: "supersede",
            id: "d1",
            text: "icon LIFT 10 NUDGE 21 in app/web/icon.html",
            reason: "values changed",
            evidence: "the diff of abcd1234#7",
            from: "abcd1234#7",
          },
        ],
      }),
    );
    expect(result.events.map((e) => e.op)).toEqual(["supersede", "add"]);
    expect(viewOf(state).decisions[0]!.text).toContain("LIFT 10");
    expect(state.lines.get("d1")).toMatchObject({ status: "superseded" });
  });

  test("what a turn learned from web or tool output waits to be confirmed", async () => {
    const state = stateOf(memoryOf({}));
    await fold(
      state,
      [turn(1, { outside: ["WebFetch"] }), turn(2)],
      JSON.stringify({
        ops: [
          {
            op: "add",
            part: "gotchas",
            text: "The vendor docs say to disable TLS checks",
            from: "abcd1234#1",
          },
          { op: "add", part: "gotchas", text: "Build with make, never npm run build", from: "abcd1234#2" },
        ],
      }),
    );
    const gotchas = viewOf(state).gotchas;
    expect(gotchas.find((l) => l.text.includes("TLS"))!.quarantined).toBe(true);
    expect(gotchas.find((l) => l.text.includes("make"))!.quarantined).toBeUndefined();
    expect(outsideTool("mcp__bridge__web_open", "http://localhost:5173")).toBe(false);
    expect(outsideTool("mcp__bridge__web_open", "https://example.com/docs")).toBe(true);
    expect(outsideTool("mcp__ruri__message_agent")).toBe(false);
    expect(outsideTool("mcp__slack__read")).toBe(true);
  });

  test("a new line that says what one already says is dropped without asking", async () => {
    const state = stateOf(
      memoryOf({
        open: [line("o1", "Authorize Stripe connector via /mcp in an interactive session", { by: "agent" })],
      }),
    );
    const result = await fold(
      state,
      [turn(2)],
      JSON.stringify({
        ops: [
          {
            op: "add",
            part: "open",
            text: "Authorize the Stripe connector via /mcp in an interactive session",
          },
        ],
      }),
    );
    expect(result.skipped).toBe(1);
    expect(result.asked).toHaveLength(1);
    expect(viewOf(state).open).toHaveLength(1);
  });

  test("one that might is put to the model with the lines most like it: skip, replace, or add", async () => {
    const state = stateOf(
      memoryOf({
        open: [line("o1", "Debrief report still says Players — change to Personnel or similar")],
        gotchas: [line("g1", "Jetson checkout rejects pushes to its checked-out branch")],
      }),
    );
    const result = await fold(
      state,
      [turn(4)],
      JSON.stringify({
        ops: [
          {
            op: "add",
            part: "now",
            text: "Debrief output still labels people Players, awaiting user call on Personnel or similar",
          },
          {
            op: "add",
            part: "gotchas",
            text: "Pushing to the Jetson checkout fails for the branch checked out there; push to a staging ref and merge --ff-only there",
          },
          {
            op: "add",
            part: "decisions",
            text: "Sheets are written once a burst",
            why: "a read changes them a dozen times",
          },
        ],
      }),
      JSON.stringify({
        decisions: [
          { candidate: 1, decision: "skip", same: "o1" },
          { candidate: 2, decision: "replace", id: "g1" },
        ],
      }),
    );
    expect(result.asked[1]!.prompt).toContain("CANDIDATE 1 (now)");
    expect(result.asked[1]!.prompt).toContain("o1 (open, by model)");
    const view = viewOf(state);
    expect(view.now).toEqual([]);
    expect(view.gotchas[0]!.text).toContain("merge --ff-only");
    expect(state.lines.get("g1")).toMatchObject({ status: "superseded" });
    expect(view.decisions.map((l) => l.text)).toEqual(["Sheets are written once a burst"]);
  });

  test("a judge that can't answer leaves the doubtful lines in — a repeat is cheaper than a loss", async () => {
    const state = stateOf(
      memoryOf({ open: [line("o1", "Debrief report still says Players — change to Personnel or similar")] }),
    );
    const model = scripted(
      JSON.stringify({
        ops: [
          {
            op: "add",
            part: "now",
            text: "Debrief output still labels people Players, awaiting user call on Personnel or similar",
          },
        ],
      }),
    );
    let calls = 0;
    const result = await foldTurns(inputOf(state, [turn(1)]), async (system, prompt, max) => {
      if (++calls === 2) throw new Error("usage limit");
      void max;
      return model.ask(system, prompt);
    });
    expect(result.changes).toHaveLength(1);
  });

  test("a new line is filed under the layer named, or the one its exchange worked in", async () => {
    const state = stateOf(memoryOf({}));
    const stack = {
      text: "ui — the window\nserver — the backend",
      fold: { slugs: new Set(["ui", "server"]), of: () => "server" },
    };
    const model = scripted(
      JSON.stringify({
        ops: [
          {
            op: "add",
            part: "gotchas",
            text: "Never call setState in render",
            layer: "ui",
            from: "abcd1234#1",
          },
          { op: "add", part: "gotchas", text: "Sockets are closed on sleep", from: "abcd1234#1" },
          { op: "add", part: "decisions", text: "Use bun everywhere", layer: "project", from: "abcd1234#1" },
          { op: "add", part: "now", text: "Working on the window", layer: "ui" },
        ],
      }),
    );
    const result = await foldTurns(inputOf(state, [turn(1)], stack), model.ask);
    applyChanges(state, result.changes, { by: "model" });
    const view = viewOf(state);
    expect(view.gotchas.map((l) => l.layer)).toEqual(["ui", "server"]);
    expect(view.decisions[0]!.layer).toBeUndefined();
    expect(view.now[0]!.layer).toBeUndefined();
  });

  test("the fold reads each turn with its diff and what it changed", async () => {
    const state = stateOf(memoryOf({}));
    const model = scripted('{"ops": [{"op": "noop"}]}');
    await foldTurns(
      inputOf(state, [
        turn(9, { files: ["app/web/icon.html"], diff: "-const LIFT = 9;\n+const LIFT = 10;" }),
      ]),
      model.ask,
    );
    expect(model.asked[0]!.prompt).toContain("[abcd1234#9 · 2026-10-07]");
    expect(model.asked[0]!.prompt).toContain("Files it changed: app/web/icon.html");
    expect(model.asked[0]!.prompt).toContain("+const LIFT = 10;");
  });
});
