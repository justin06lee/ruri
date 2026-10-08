import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { BriefStore } from "./brief.js";
import { MemoryBook } from "./memoryLog.js";
import type { ServerContext } from "./context.js";
import { runMemoryCommand } from "./memoryCli.js";

let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

const CHAT = "c0ffee11-2222-3333-4444-555566667777";
let n = 0;
const user = (text: string): TranscriptEvent =>
  ({ kind: "user", id: `u${++n}`, text, ts: Date.now() }) as TranscriptEvent;
const reply = (text: string): TranscriptEvent =>
  ({ kind: "assistant", id: `a${++n}`, text, ts: Date.now() }) as TranscriptEvent;

/** Each prompt's number, by its place — as the archive numbers a chat. */
const numbersOf = (events: TranscriptEvent[]) =>
  new Map(events.filter((e) => e.kind === "user").map((e, i) => [e.id, i + 1]));

let ctx: ServerContext;
let briefs: BriefStore;
beforeEach(() => {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-memcli-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-memcli-project-"));
  const events: TranscriptEvent[] = [
    user("why does the rewind gauge fail after compaction"),
    reply("The snapshot kept the old context; it now carries the gauge."),
    user("now write down what we learned"),
  ];
  const session = { id: CHAT, title: "Rewind work" };
  const project = { id: "p", name: "demo", path: dir, sessions: [session] };
  briefs = new BriefStore();
  ctx = {
    store: {
      findSession: (id: string) => (id === CHAT ? { project, session } : undefined),
      get: (id: string) => (id === "p" ? project : undefined),
    },
    archive: {
      events: () => events,
      allEvents: () => events,
      summaries: () => ({}),
      turnIds: () => events.filter((e) => e.kind === "user").map((e) => e.id),
      exchangeNumbers: () => numbersOf(events),
      exchangeNo: (_chat: string, turn: string) => numbersOf(events).get(turn),
      turnOfExchange: (_chat: string, n: number) => [...numbersOf(events)].find(([, at]) => at === n)?.[0],
    },
    briefs,
    memory: new MemoryBook(briefs),
    clients: { broadcast: () => {} },
  } as unknown as ServerContext;
});

const run = (...argv: string[]) => runMemoryCommand(ctx, CHAT, argv);

describe("ruri's memory commands", () => {
  test("a note lands under its part as the agent's, traced to the exchange at hand", async () => {
    const answer = (await run(
      "note",
      "decision",
      "Snapshots",
      "carry",
      "the",
      "gauge",
      "--why",
      "rewind read a stale one",
    ))!;
    expect(answer.ok).toBe(true);
    const line = briefs.get("p").memory!.decisions[0]!;
    expect(line).toMatchObject({
      text: "Snapshots carry the gauge",
      why: "rewind read a stale one",
      by: "agent",
      source: { chat: CHAT, turn: "u3" },
    });
    expect(answer.text).toContain(`as ${line.id}`);
    // a decision without its reason is taken, with a nudge
    expect((await run("note", "decision", "no reason given"))!.text).toContain("--why");
    expect((await run("note", "idea", "x"))!.ok).toBe(false);
    expect((await run("note", "trap"))!.ok).toBe(false);
  });

  test("memory lists each line with its id and where it came from; forget takes an agent's out, never the user's", async () => {
    await run("note", "failed", "Polling the cursor", "--why", "cost battery");
    const memory = briefs.get("p").memory!;
    const listed = (await run("memory"))!.text;
    const id = memory.failed[0]!.id;
    expect(listed).toContain(`${id}  Polling the cursor — cost battery (`);
    expect(listed).toContain("c0ffee11#2");
    const users = ctx.memory.apply(
      "p",
      [{ op: "add", part: "gotchas", text: "never make update", pinned: true }],
      {
        by: "user",
      },
    ).added[0]!.id;
    const refused = (await run("forget", users))!;
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("the user's");
    expect((await run("forget", id, "--why", "battery is fine now"))!.ok).toBe(true);
    expect(briefs.get("p").memory!.failed).toEqual([]);
    expect((await run("forget", "nope"))!.ok).toBe(false);
  });

  test("the log: a line's history, what left, and putting a line or a fold back", async () => {
    await run("note", "trap", "Never run make update from a session");
    const id = briefs.get("p").memory!.gotchas[0]!.id;
    await run("forget", id, "--why", "make update keeps the session now");
    const past = (await run("memory", "past"))!.text;
    expect(past).toContain(`${id}  retired`);
    expect(past).toContain("make update keeps the session now");
    expect((await run("memory", "restore", id))!.ok).toBe(true);
    expect(briefs.get("p").memory!.gotchas.map((l) => l.id)).toEqual([id]);
    const log = (await run("memory", "log", id))!.text;
    expect(log).toContain("added by an agent");
    expect(log).toContain("retired by an agent — make update keeps the session now");
    expect(log).toContain("restored by an agent");
    // a fold is taken back whole
    ctx.memory.apply("p", [{ op: "add", part: "open", text: "folded in" }], { by: "model", fold: "f123" });
    const undone = (await run("memory", "undo"))!;
    expect(undone.text).toContain("took fold f123 back: 1 line");
    expect(briefs.get("p").memory!.open).toEqual([]);
    expect((await run("memory", "nonsense"))!.ok).toBe(false);
  });

  test("recall finds an exchange by its words and prints it whole by its ref", async () => {
    const found = (await run("recall", "rewind", "gauge"))!.text;
    expect(found).toContain("c0ffee11#1");
    expect(found).toContain('"Rewind work"');
    const shown = (await run("recall", "show", "c0ffee11#1"))!.text;
    expect(shown).toContain("## The user\n\nwhy does the rewind gauge fail after compaction");
    expect(shown).toContain("## The agent\n\nThe snapshot kept the old context");
    expect((await run("recall", "show", "#1"))!.ok).toBe(true);
    expect((await run("recall", "show", "c0ffee11#9"))!.ok).toBe(false);
    expect((await run("recall", "haiku", "autumn"))!.text).toContain(
      "nothing in demo's chats or memory matches",
    );
  });

  test("state answers outside a repo too, and the library's commands pass through", async () => {
    expect((await run("state"))!.text).toContain("not a git repository");
    expect(await run("search", "button")).toBeUndefined();
  });
});
