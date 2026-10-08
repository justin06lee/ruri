import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { SessionArchive } from "./archive.js";
import { BriefStore } from "./brief.js";
import type { ServerContext } from "./context.js";
import { MemoryBook } from "./memoryLog.js";
import { backfillFolds, enqueueFold, foldCoverage, FoldQueue, runFolds } from "./memoryQueue.js";

let dir: string;
let projectDir: string;
let ctx: ServerContext;
let archive: SessionArchive;
let briefs: BriefStore;
let asked: string[];
let answer: (prompt: string) => Promise<string>;

const CHATS = ["aaaa1111-chat", "bbbb2222-chat"];

function turnEvents(chat: string, n: number): TranscriptEvent[] {
  const ts = Date.UTC(2026, 9, 7, 12, n);
  return [
    { kind: "user", id: `${chat}-u${n}`, text: `prompt ${n} in ${chat}`, ts },
    { kind: "assistant", id: `${chat}-a${n}`, text: `did thing ${n} in ${chat}`, ts: ts + 1 },
    { kind: "result", id: `${chat}-r${n}`, ok: true, ts: ts + 2 } as TranscriptEvent,
  ];
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-folds-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-folds-project-"));
  process.env["RURI_CONFIG_DIR"] = dir;
  archive = new SessionArchive();
  briefs = new BriefStore();
  asked = [];
  answer = async () => '{"ops": [{"op": "noop"}]}';
  const sessions = CHATS.map((id) => ({ id, title: id.slice(0, 4) }));
  const project = { id: "p", name: "demo", path: projectDir, sessions };
  const folds = new FoldQueue();
  folds.ask = async (_system, prompt) => {
    asked.push(prompt);
    return answer(prompt);
  };
  ctx = {
    store: {
      get: (id: string) => (id === "p" ? project : undefined),
      list: () => [project],
      findSession: (id: string) => {
        const session = sessions.find((s) => s.id === id);
        return session ? { project, session } : undefined;
      },
    },
    archive,
    briefs,
    memory: new MemoryBook(briefs),
    folds,
    checkpoints: { turnDiff: async () => "+a changed line" },
    clients: { broadcast: () => {} },
    manager: { statuses: () => ({}) },
  } as unknown as ServerContext;
  // the project has a memory already, so new turns are folded one by one
  ctx.memory.apply("p", [{ op: "add", part: "decisions", text: "Use bun", why: "the repo's tool" }], {
    by: "user",
  });
});

afterEach(() => {
  for (const timer of ctx.folds.timers.values()) clearTimeout(timer);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  delete process.env["RURI_CONFIG_DIR"];
});

function finish(chat: string, n: number): void {
  for (const event of turnEvents(chat, n)) archive.append(chat, event);
  enqueueFold(ctx, "p", chat, `${chat}-u${n}`);
}

describe("every finished turn, folded", () => {
  test("turns from parallel chats all fold, in chunks — none dropped past five", async () => {
    for (let n = 1; n <= 5; n++) for (const chat of CHATS) finish(chat, n);
    const words = [
      "gauge",
      "rewind",
      "sockets",
      "quota",
      "lockfile",
      "bridge",
      "drafts",
      "ledger",
      "sweep",
      "tray",
    ];
    let next = 0;
    answer = async (prompt) => {
      const refs = [...prompt.matchAll(/\[([0-9a-z]{8}#\d+) ·/g)].map((m) => m[1]);
      return JSON.stringify({
        ops: refs.map((ref) => ({
          op: "add",
          part: "worked",
          text: `the ${words[next++]} approach held`,
          from: ref,
        })),
      });
    };
    await runFolds(ctx, "p");
    const folds = asked.filter((prompt) => prompt.includes("WHAT HAPPENED:"));
    expect(folds).toHaveLength(2);
    expect(folds[0]!.match(/\[[0-9a-z]{8}#\d+ ·/g)).toHaveLength(6);
    expect(folds[0]).toContain("+a changed line");
    const coverage = foldCoverage(ctx, "p");
    expect(coverage).toMatchObject({ folded: 10, total: 10, waiting: 0, skipped: 0 });
    // the caps archive what doesn't fit, rather than losing it
    expect(ctx.memory.view("p")!.worked.length).toBe(8);
    expect(ctx.memory.past("p").filter((l) => l.status === "archived")).toHaveLength(2);
  });

  test("a model that can't be reached leaves every turn waiting, on disk, for the next try", async () => {
    finish(CHATS[0]!, 1);
    finish(CHATS[1]!, 1);
    answer = async () => {
      throw new Error("usage limit reached");
    };
    await runFolds(ctx, "p");
    for (const timer of ctx.folds.timers.values()) clearTimeout(timer);
    ctx.folds.timers.clear();
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "memory", "p.folds.json"), "utf8"));
    expect(kept.pending).toHaveLength(2);
    // a restart, and a model that answers
    const again = new FoldQueue();
    again.ask = async () =>
      '{"ops": [{"op": "add", "part": "open", "text": "check the gauge after a rewind"}]}';
    (ctx as unknown as { folds: FoldQueue }).folds = again;
    await runFolds(ctx, "p");
    expect(foldCoverage(ctx, "p")).toMatchObject({ folded: 2, waiting: 0 });
    expect(ctx.memory.view("p")!.open.map((l) => l.text)).toEqual(["check the gauge after a rewind"]);
  });

  test("a turn the model twice answers with nothing usable is given up on, and counted", async () => {
    finish(CHATS[0]!, 1);
    answer = async () => "I'm sorry, I can't do that.";
    await runFolds(ctx, "p");
    for (const timer of ctx.folds.timers.values()) clearTimeout(timer);
    ctx.folds.timers.clear();
    expect(foldCoverage(ctx, "p").waiting).toBe(1);
    await runFolds(ctx, "p");
    expect(foldCoverage(ctx, "p")).toMatchObject({ folded: 1, skipped: 1, waiting: 0 });
    expect(ctx.memory.view("p")!.decisions.map((l) => l.text)).toEqual(["Use bun"]);
  });

  test("a turn a rewind took before it was folded is let go", async () => {
    finish(CHATS[0]!, 1);
    finish(CHATS[0]!, 2);
    archive.truncateFrom(CHATS[0]!, `${CHATS[0]}-u2`);
    await runFolds(ctx, "p");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("#1 ·");
    expect(asked[0]).not.toContain("#2 ·");
    expect(foldCoverage(ctx, "p")).toMatchObject({ folded: 1, total: 1, waiting: 0 });
  });

  test("a fold's changes carry its id, and `ruri memory undo` can take it back", async () => {
    finish(CHATS[0]!, 1);
    answer = async () => '{"ops": [{"op": "add", "part": "gotchas", "text": "never force-push master"}]}';
    await runFolds(ctx, "p");
    const event = ctx.memory.history("p").at(-1)!;
    expect(event.fold).toBeDefined();
    expect(ctx.folds.turnsOf("p", event.fold!)).toEqual(["aaaa1111#1"]);
    ctx.memory.undo("p", { by: "user" });
    expect(ctx.memory.view("p")!.gotchas).toEqual([]);
  });

  test("Read the chats folds every turn not folded yet, oldest first", async () => {
    for (const event of [...turnEvents(CHATS[1]!, 1), ...turnEvents(CHATS[1]!, 2)])
      archive.append(CHATS[1]!, event);
    for (const event of turnEvents(CHATS[0]!, 3)) archive.append(CHATS[0]!, event);
    expect(backfillFolds(ctx, "p")).toBe(3);
    for (const timer of ctx.folds.timers.values()) clearTimeout(timer);
    ctx.folds.timers.clear();
    await runFolds(ctx, "p");
    const order = [...asked[0]!.matchAll(/\[([0-9a-z]{8}#\d+) ·/g)].map((m) => m[1]);
    expect(order).toEqual(["bbbb2222#1", "bbbb2222#2", "aaaa1111#1"]);
    expect(backfillFolds(ctx, "p")).toBe(0);
  });
});
