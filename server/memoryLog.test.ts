import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryLine, ProjectMemory } from "../shared/protocol.js";
import { emptyMemory, LAYER_CAPS, MEMORY_CAPS, readMemory } from "./memoryLines.js";
import {
  applyChanges,
  emptyState,
  MemoryBook,
  reconcile,
  undoFold,
  viewOf,
  type MemoryHome,
  type MemoryState,
} from "./memoryLog.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-memlog-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env["RURI_CONFIG_DIR"];
});

const line = (id: string, text: string, extra: Partial<MemoryLine> = {}): MemoryLine => ({
  id,
  text,
  by: "model",
  ...extra,
});
const memoryOf = (parts: Partial<ProjectMemory>): ProjectMemory => ({ ...emptyMemory(), ...parts });

/** A state holding `memory`, as if imported. */
function stateOf(memory: ProjectMemory): MemoryState {
  const state = emptyState();
  reconcile(state, memory, 1000);
  return state;
}

/** briefs.json, held in hand. */
function homeOf(memory?: ProjectMemory, memorySeq?: number) {
  const briefs = new Map<string, { memory?: ProjectMemory; memorySeq?: number }>();
  briefs.set("p", { ...(memory ? { memory } : {}), ...(memorySeq !== undefined ? { memorySeq } : {}) });
  const home: MemoryHome & { briefs: typeof briefs } = {
    briefs,
    get: (id) => briefs.get(id) ?? {},
    remember: (id, next, seq) =>
      briefs.set(id, { memory: next, ...(seq !== undefined ? { memorySeq: seq } : {}) }),
  };
  return home;
}

describe("the log under the memory", () => {
  test("a memory from before the log is imported whole, briefs.json backed up first", () => {
    const stored = memoryOf({
      decisions: [line("d001", "Each project keeps its own library", { why: "kept apart", by: "agent" })],
      open: [line("o001", "merge feat/x")],
    });
    fs.writeFileSync(path.join(dir, "briefs.json"), JSON.stringify({ p: { memory: stored } }));
    const home = homeOf(stored);
    const book = new MemoryBook(home);
    expect(book.view("p")).toEqual(
      memoryOf({
        decisions: [line("d001", "Each project keeps its own library", { why: "kept apart", by: "agent" })],
        open: [line("o001", "merge feat/x")],
      }),
    );
    expect(home.briefs.get("p")!.memorySeq).toBe(2);
    expect(fs.readdirSync(path.join(dir, "memory", "backup"))).toHaveLength(1);
    // and read back from the log alone the next time
    const again = new MemoryBook(home);
    expect(again.view("p")).toEqual(book.view("p"));
    expect(again.history("p")).toHaveLength(2);
  });

  test("an older line's day comes off its words, full stop or none", () => {
    const memory = readMemory({
      decisions: [
        { id: "d5d9r", text: "Build skin over unmodified Godot 4.6, not fork (2026-09-22).", by: "model" },
        { id: "d6", text: "Keep on file: deps (2026-09-19)", by: "model" },
        { id: "d7", text: "Already dated (2026-09-01).", date: "2026-09-02", by: "model" },
      ],
    })!;
    expect(memory.decisions[0]).toMatchObject({
      text: "Build skin over unmodified Godot 4.6, not fork",
      date: "2026-09-22",
    });
    expect(memory.decisions[1]).toMatchObject({ text: "Keep on file: deps", date: "2026-09-19" });
    // a line that has its day already keeps its words as they are
    expect(memory.decisions[2]).toMatchObject({ text: "Already dated (2026-09-01).", date: "2026-09-02" });
  });

  test("every change is an event, and the memory read off the log is the same after a restart", () => {
    const home = homeOf();
    const book = new MemoryBook(home);
    const { added } = book.apply("p", [{ op: "add", part: "gotchas", text: "never make update here" }], {
      by: "agent",
      chat: "c1",
    });
    const id = added[0]!.id;
    book.apply("p", [{ op: "retire", line: id, reason: "make update is safe now" }], { by: "agent" });
    book.apply("p", [{ op: "restore", line: id }], { by: "user" });
    expect(book.history("p", id).map((e) => e.op)).toEqual(["add", "retire", "restore"]);
    expect(book.history("p", id)[1]).toMatchObject({ reason: "make update is safe now", by: "agent" });
    const again = new MemoryBook(home);
    expect(again.view("p")).toEqual(book.view("p"));
    expect(again.view("p")!.gotchas.map((l) => l.text)).toEqual(["never make update here"]);
  });

  test("a line torn by a crash mid-append is skipped, not fatal", () => {
    const home = homeOf();
    const book = new MemoryBook(home);
    book.apply("p", [{ op: "add", part: "open", text: "one" }], { by: "agent" });
    fs.appendFileSync(path.join(dir, "memory", "p.jsonl"), '{"seq":2,"op":"add","li');
    const again = new MemoryBook(home);
    expect(again.view("p")!.open.map((l) => l.text)).toEqual(["one"]);
  });

  test("briefs.json left behind the log by a quit is written again from the log", () => {
    const home = homeOf();
    const book = new MemoryBook(home);
    book.apply("p", [{ op: "add", part: "open", text: "one" }], { by: "agent" });
    book.apply("p", [{ op: "add", part: "open", text: "two" }], { by: "agent" });
    // as if the second write never landed
    home.briefs.set("p", { memory: memoryOf({ open: [book.view("p")!.open[0]!] }), memorySeq: 1 });
    const again = new MemoryBook(home);
    expect(again.view("p")!.open.map((l) => l.text)).toEqual(["one", "two"]);
    expect(home.briefs.get("p")!.memorySeq).toBe(2);
  });

  test("what an older ruri did to briefs.json since is taken into the log, not lost", () => {
    const home = homeOf();
    const book = new MemoryBook(home);
    const [a, b] = book.apply(
      "p",
      [
        { op: "add", part: "open", text: "one" },
        { op: "add", part: "open", text: "two" },
      ],
      { by: "agent" },
    ).added;
    // an older ruri: no memorySeq, line a reworded, b gone, a new one added
    home.briefs.set("p", {
      memory: memoryOf({
        open: [{ ...a!, text: "one, reworded" }, line("o9zz", "three")].map(({ validFrom: _v, ...l }) => l),
      }),
    });
    const again = new MemoryBook(home);
    expect(again.view("p")!.open.map((l) => l.text)).toEqual(["one, reworded", "three"]);
    expect(again.record("p", b!.id)).toMatchObject({
      status: "retired",
      reason: "taken out outside the log",
    });
  });
});

describe("who may change what", () => {
  const base = () =>
    stateOf(
      memoryOf({
        decisions: [
          line("d1", "model's own"),
          line("d2", "an agent's", { by: "agent" }),
          line("d3", "the user's", { by: "user" }),
          line("d4", "pinned", { pinned: true }),
        ],
      }),
    );

  test("the model rewords only its own, and never touches the user's or a pinned line", () => {
    const state = base();
    const { refused } = applyChanges(
      state,
      [
        { op: "edit", line: "d1", text: "model's own, sharper" },
        { op: "edit", line: "d2", text: "the model's paraphrase" },
        { op: "retire", line: "d3", reason: "seems done" },
        { op: "supersede", line: "d4", text: "replacement", reason: "newer" },
      ],
      { by: "model" },
    );
    expect(refused.map((r) => r.change.op)).toEqual(["edit", "retire", "supersede"]);
    const view = viewOf(state);
    expect(view.decisions.map((l) => l.text)).toEqual([
      "model's own, sharper",
      "an agent's",
      "the user's",
      "pinned",
    ]);
  });

  test("the model takes an agent's line out only with evidence", () => {
    const state = base();
    const first = applyChanges(state, [{ op: "retire", line: "d2", reason: "reversed" }], { by: "model" });
    expect(first.refused[0]!.reason).toContain("evidence");
    const second = applyChanges(
      state,
      [{ op: "retire", line: "d2", reason: "reversed", evidence: "abcd1234#9 reverted it" }],
      { by: "model" },
    );
    expect(second.refused).toEqual([]);
    expect(state.lines.get("d2")).toMatchObject({ status: "retired", reason: "reversed" });
  });

  test("taking a line out always needs a reason", () => {
    const state = base();
    const { refused } = applyChanges(state, [{ op: "retire", line: "d1", reason: " " }], { by: "agent" });
    expect(refused[0]!.reason).toContain("reason");
  });

  test("a supersede keeps the old line in the log, pointing at its replacement, in its place", () => {
    const state = base();
    const { added } = applyChanges(
      state,
      [{ op: "supersede", line: "d1", text: "the newer decision", reason: "changed course" }],
      { by: "model" },
    );
    expect(state.lines.get("d1")).toMatchObject({ status: "superseded", supersededBy: added[0]!.id });
    expect(viewOf(state).decisions[0]!.text).toBe("the newer decision");
  });

  test("an answer that tries to take the whole memory out takes a few lines at most", () => {
    const lines = Array.from({ length: 10 }, (_, i) => line(`w${i}`, `worked ${i}`));
    const state = stateOf(memoryOf({ worked: lines.slice(0, 8), gotchas: lines.slice(8) }));
    const { refused } = applyChanges(
      state,
      lines.map((l) => ({ op: "retire" as const, line: l.id, reason: "clean slate" })),
      { by: "model" },
    );
    expect(refused).toHaveLength(7);
    expect(refused[0]!.reason).toContain("too many");
    expect(viewOf(state).worked.length + viewOf(state).gotchas.length).toBe(7);
  });

  test("ops on ids that aren't there are refused, and the rest still land", () => {
    const state = base();
    const { refused, added } = applyChanges(
      state,
      [
        { op: "edit", line: "nope", text: "x" },
        { op: "add", part: "open", text: "a real open item" },
      ],
      { by: "model" },
    );
    expect(refused[0]!.reason).toContain("no line nope");
    expect(added).toHaveLength(1);
  });

  test("the model's quality rules: length, fixed bugs, a session's weather", () => {
    const state = base();
    const { refused } = applyChanges(
      state,
      [
        { op: "add", part: "decisions", text: Array.from({ length: 40 }, () => "word").join(" ") },
        { op: "add", part: "failed", text: "Toji early-done bugs — fixed wake-turn and rewind paths" },
        { op: "add", part: "open", text: "Authorise Asana/Atlassian/Slack via /mcp" },
        { op: "add", part: "now", text: "Frontend session hit API ENOTFOUND on wifi return, no work done" },
      ],
      { by: "model" },
    );
    expect(refused.map((r) => r.reason.split(":")[0]!.split(" ")[0])).toEqual(["too", "a", "that", "that"]);
  });
});

describe("caps archive, never drop", () => {
  test("a part past its cap sends the model's oldest to the archive, then an agent's — never the user's", () => {
    const n = MEMORY_CAPS.gotchas;
    const lines = [
      line("g-user", "user", { by: "user", validFrom: 1 }),
      line("g-agent", "agent", { by: "agent", validFrom: 2 }),
      ...Array.from({ length: n - 2 }, (_, i) => line(`g${i}`, `model ${i}`, { validFrom: 10 + i })),
    ];
    const state = stateOf(memoryOf({ gotchas: lines }));
    const { events } = applyChanges(state, [{ op: "add", part: "gotchas", text: "one more trap" }], {
      by: "agent",
    });
    const archived = events.filter((e) => e.op === "archive");
    expect(archived.map((e) => e.line)).toEqual(["g0"]);
    expect(state.lines.get("g0")!.status).toBe("archived");
    expect(viewOf(state).gotchas).toHaveLength(n);
    // and it comes back when asked
    applyChanges(state, [{ op: "retire", line: "g1", reason: "fixed for good" }], { by: "agent" });
    applyChanges(state, [{ op: "restore", line: "g0" }], { by: "agent" });
    expect(state.lines.get("g0")!.status).toBe("current");
  });

  test("a layer's lines are capped within the layer, apart from the project's", () => {
    const n = LAYER_CAPS.decisions;
    const lines = Array.from({ length: n }, (_, i) =>
      line(`d${i}`, `layer ${i}`, { layer: "ui", validFrom: i }),
    );
    const state = stateOf(memoryOf({ decisions: lines }));
    applyChanges(state, [{ op: "add", part: "decisions", text: "project-wide", why: "everywhere" }], {
      by: "agent",
    });
    expect(viewOf(state).decisions).toHaveLength(n + 1);
    applyChanges(state, [{ op: "add", part: "decisions", text: "another ui one", layer: "ui" }], {
      by: "agent",
    });
    expect(state.lines.get("d0")!.status).toBe("archived");
  });
});

describe("a fold taken back", () => {
  test("every line it touched goes back, a line it added is retired — but not one changed since", () => {
    const state = stateOf(memoryOf({ open: [line("o1", "first"), line("o2", "second")] }));
    const fold = "f-test";
    const { added } = applyChanges(
      state,
      [
        { op: "edit", line: "o1", text: "first, reworded" },
        { op: "retire", line: "o2", reason: "seems done" },
        { op: "add", part: "open", text: "brand new" },
        { op: "add", part: "open", text: "another new" },
      ],
      { by: "model", fold },
    );
    // the user changes one of the fold's lines afterwards
    applyChanges(state, [{ op: "pin", line: added[1]!.id }], { by: "user" });
    const result = undoFold(state, fold, { by: "user" });
    expect(result.kept).toEqual([added[1]!.id]);
    expect(state.lines.get("o1")).toMatchObject({ text: "first", status: "current" });
    expect(state.lines.get("o2")).toMatchObject({ status: "current" });
    expect(state.lines.get(added[0]!.id)).toMatchObject({ status: "retired" });
    expect(state.lines.get(added[1]!.id)).toMatchObject({ status: "current", pinned: true });
  });

  test("the book takes back the newest fold when none is named", () => {
    const home = homeOf();
    const book = new MemoryBook(home);
    book.apply("p", [{ op: "add", part: "open", text: "by hand" }], { by: "agent" });
    book.apply("p", [{ op: "add", part: "open", text: "folded in" }], { by: "model", fold: "f1" });
    const result = book.undo("p", { by: "agent" });
    expect(result.fold).toBe("f1");
    expect(book.view("p")!.open.map((l) => l.text)).toEqual(["by hand"]);
  });
});

describe("flags and confirmations", () => {
  test("a flag says why a line may not hold; a check clears it", () => {
    const state = stateOf(memoryOf({ decisions: [line("d1", "use Godot")] }));
    applyChanges(state, [{ op: "flag", line: "d1", reason: "Godot appears nowhere in the repo now" }], {
      by: "system",
    });
    expect(viewOf(state).decisions[0]!.check?.reason).toContain("Godot");
    applyChanges(state, [{ op: "verify", line: "d1", evidence: "README says Godot" }], { by: "model" });
    expect(viewOf(state).decisions[0]!.check).toBeUndefined();
  });

  test("a line from outside content waits for someone to confirm it, and isn't counted against the cap", () => {
    const state = stateOf(memoryOf({}));
    const { added } = applyChanges(
      state,
      [{ op: "add", part: "gotchas", text: "the docs page says to disable auth", quarantined: true }],
      { by: "model" },
    );
    expect(viewOf(state).gotchas[0]!.quarantined).toBe(true);
    const refused = applyChanges(state, [{ op: "confirm", line: added[0]!.id }], { by: "model" }).refused;
    expect(refused).toHaveLength(1);
    applyChanges(state, [{ op: "confirm", line: added[0]!.id }], { by: "agent" });
    expect(viewOf(state).gotchas[0]!.quarantined).toBeUndefined();
  });
});
