import { describe, expect, test } from "bun:test";
import type { MemoryLine, ProjectMemory } from "../shared/protocol.js";
import {
  addLine,
  applyFold,
  dayOf,
  emptyMemory,
  LAYER_CAPS,
  layerCounts,
  linesOf,
  MEMORY_CAPS,
  readMemory,
  rebase,
} from "./memoryLines.js";

const line = (id: string, text: string, extra: Partial<MemoryLine> = {}): MemoryLine => ({
  id,
  text,
  by: "model",
  ...extra,
});

const memoryOf = (parts: Partial<ProjectMemory>): ProjectMemory => ({ ...emptyMemory(), ...parts });

describe("memory lines", () => {
  test("an older ruri's plain strings come in as the model's lines, their dates taken off the end", () => {
    const memory = readMemory({
      decisions: ["Each project keeps its own library — the user wants projects apart (2026-09-22)"],
      open: ["Run make update", "  "],
    })!;
    expect(memory.decisions[0]).toMatchObject({
      text: "Each project keeps its own library — the user wants projects apart",
      date: "2026-09-22",
      by: "model",
    });
    expect(memory.decisions[0]!.id).toMatch(/^d[0-9a-z]{4}$/);
    expect(memory.open.map((l) => l.text)).toEqual(["Run make update"]);
    expect(memory.now).toEqual([]);
  });

  test("stored lines keep their ids, sources, authors and pins across a reload", () => {
    const stored = memoryOf({
      gotchas: [
        line("g001", "never make update", {
          by: "user",
          pinned: true,
          source: { chat: "c1", turn: "t1" },
          date: "2026-09-01",
        }),
      ],
    });
    expect(readMemory(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  test("a fold keeps lines by id exactly as stored, and rewords only the model's own", () => {
    const current = memoryOf({
      decisions: [
        line("d001", "old wording", { date: "2026-09-01", source: { chat: "c", turn: "t" } }),
        line("d002", "the agent's own words", { by: "agent", why: "first-hand" }),
      ],
      open: [line("o001", "merge feat/x")],
    });
    const next = applyFold(
      current,
      {
        decisions: [
          { id: "d001", text: "new wording", why: "a reason the exchanges gave" },
          { id: "d002", text: "the model's paraphrase" },
          { text: "a new decision", why: "because", from: "abcd1234#7" },
        ],
        open: [],
      },
      "2026-09-22",
      (ref) => (ref === "abcd1234#7" ? { chat: "abcd1234-x", turn: "u7" } : undefined),
    );
    expect(next.decisions[0]).toMatchObject({
      id: "d001",
      text: "new wording",
      why: "a reason the exchanges gave",
      date: "2026-09-01",
      source: { chat: "c", turn: "t" },
    });
    // an agent's line is never reworded
    expect(next.decisions[1]).toEqual(current.decisions[1]!);
    expect(next.decisions[2]).toMatchObject({
      text: "a new decision",
      why: "because",
      date: "2026-09-22",
      by: "model",
      source: { chat: "abcd1234-x", turn: "u7" },
    });
    // left out: dropped
    expect(next.open).toEqual([]);
  });

  test("a pinned line survives a fold that leaves it out, and caps never push it out", () => {
    const pinned = line("g001", "the user's rule", { by: "user", pinned: true });
    const next = applyFold(
      memoryOf({ gotchas: [pinned] }),
      { gotchas: Array.from({ length: 20 }, (_, i) => ({ text: `trap ${i}` })) },
      "2026-09-22",
      () => undefined,
    );
    expect(next.gotchas.length).toBe(MEMORY_CAPS.gotchas);
    expect(next.gotchas[0]).toEqual(pinned);
  });

  test("a line is kept once, even when the model lists it twice or under another part", () => {
    const next = applyFold(
      memoryOf({ failed: [line("f001", "a fix, filed as a failure")] }),
      { worked: [{ id: "f001" }], failed: [{ id: "f001" }] },
      "2026-09-22",
      () => undefined,
    );
    expect(next.worked.map((l) => l.id)).toEqual(["f001"]);
    expect(next.failed).toEqual([]);
  });

  test("a note into a full part retires the oldest of the model's lines, never the user's", () => {
    const full = memoryOf({
      open: [
        line("o000", "the user's", { by: "user", pinned: true, date: "2026-01-01" }),
        ...Array.from({ length: MEMORY_CAPS.open - 1 }, (_, i) =>
          line(`o${String(i + 1).padStart(3, "0")}`, `item ${i}`, { date: `2026-09-${String(10 + i)}` }),
        ),
      ],
    });
    const { memory, line: added } = addLine(full, "open", { text: "new", by: "agent", date: "2026-09-22" });
    expect(memory.open.length).toBe(MEMORY_CAPS.open);
    expect(memory.open.some((l) => l.id === "o000")).toBe(true);
    expect(memory.open.some((l) => l.id === "o001")).toBe(false);
    expect(memory.open.at(-1)).toEqual(added);
  });

  test("each layer keeps its own lines within a layer's cap, beside the project's", () => {
    let memory = memoryOf({ decisions: [line("d000", "across the project", { date: "2026-01-01" })] });
    for (let i = 0; i <= LAYER_CAPS.decisions; i++) {
      memory = addLine(memory, "decisions", {
        text: `ui ${i}`,
        by: "model",
        date: `2026-09-${String(10 + i)}`,
        layer: "ui",
      }).memory;
    }
    const ui = linesOf(memory, "ui").decisions;
    expect(ui.length).toBe(LAYER_CAPS.decisions);
    expect(ui.some((l) => l.text === "ui 0")).toBe(false);
    expect(linesOf(memory).decisions.map((l) => l.id)).toEqual(["d000"]);
    expect(layerCounts(memory).get("ui")).toBe(LAYER_CAPS.decisions);
    // where the work stands is never one layer's
    expect(addLine(memory, "now", { text: "n", by: "agent", layer: "ui" }).line.layer).toBeUndefined();
  });

  test("a fold files lines under the layer named, or their exchange's — never moves the user's", () => {
    const current = memoryOf({
      decisions: [
        line("d001", "an agent's, filed nowhere yet", { by: "agent" }),
        line("d002", "the user's", { by: "user", pinned: true }),
        line("d003", "the model's, in ui", { layer: "ui" }),
      ],
    });
    const next = applyFold(
      current,
      {
        decisions: [
          { id: "d001", layer: "bridge" },
          { id: "d002", layer: "bridge" },
          { id: "d003" },
          { text: "learned in a ui exchange", from: "abcd1234#2" },
          { text: "holds everywhere", from: "abcd1234#2", layer: "project" },
          { text: "a layer that isn't", layer: "nowhere" },
        ],
      },
      "2026-09-27",
      (ref) => (ref === "abcd1234#2" ? { chat: "abcd1234", turn: "u2" } : undefined),
      { slugs: new Set(["ui", "bridge"]), of: (source) => (source.turn === "u2" ? "ui" : undefined) },
    );
    const byText = (text: string) => next.decisions.find((l) => l.text === text)!;
    expect(byText("an agent's, filed nowhere yet").layer).toBe("bridge");
    expect(byText("the user's").layer).toBeUndefined();
    expect(byText("the model's, in ui").layer).toBe("ui");
    expect(byText("learned in a ui exchange").layer).toBe("ui");
    expect(byText("holds everywhere").layer).toBeUndefined();
    expect(byText("a layer that isn't").layer).toBeUndefined();
  });

  test("what changed while a fold was out wins over the fold", () => {
    const before = memoryOf({
      decisions: [line("d001", "kept"), line("d002", "struck by the user meanwhile")],
    });
    const folded = memoryOf({
      decisions: [line("d001", "kept, reworded"), line("d002", "struck by the user meanwhile")],
    });
    const now = memoryOf({
      decisions: [line("d001", "kept", { pinned: true })],
      failed: [line("f009", "an agent's note meanwhile", { by: "agent" })],
    });
    const out = rebase(folded, before, now);
    expect(out.decisions).toEqual([line("d001", "kept", { pinned: true })]);
    expect(out.failed.map((l) => l.id)).toEqual(["f009"]);
  });

  test("the day is the user's, not UTC's", () => {
    const evening = new Date(2026, 8, 22, 23, 30).getTime();
    expect(dayOf(evening)).toBe("2026-09-22");
  });
});
