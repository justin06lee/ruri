import { describe, expect, test } from "bun:test";
import type { MemoryLine, ProjectMemory } from "../shared/protocol.js";
import { dayOf, emptyMemory, layerCounts, linesOf, readMemory } from "./memoryLines.js";

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

  test("a layer's lines are read apart from the project's, and counted per layer", () => {
    const memory = memoryOf({
      decisions: [line("d1", "everywhere"), line("d2", "ui only", { layer: "ui" })],
      gotchas: [line("g1", "ui trap", { layer: "ui" }), line("g2", "bridge trap", { layer: "bridge" })],
    });
    expect(linesOf(memory).decisions.map((l) => l.id)).toEqual(["d1"]);
    expect(linesOf(memory, "ui").gotchas.map((l) => l.id)).toEqual(["g1"]);
    expect([...layerCounts(memory)]).toEqual([
      ["ui", 2],
      ["bridge", 1],
    ]);
  });

  test("the day is the user's, not UTC's", () => {
    const evening = new Date(2026, 8, 22, 23, 30).getTime();
    expect(dayOf(evening)).toBe("2026-09-22");
  });
});
