import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubagentState, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { scriptLog, stretches } from "./scripts.js";
import { lastLine, outputMarks, shown, watchScript } from "./scriptWatch.js";
import { AgentBook } from "./sessions.js";

type ToolEvent = Extract<TranscriptEvent, { kind: "tool" }>;

let dir: string;
let file: string;
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  // where the CLI keeps a background task's output: …/tasks/<id>.output
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-script-"));
  fs.mkdirSync(path.join(dir, "tasks"));
  file = path.join(dir, "tasks", "b1.output");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("output as a terminal would leave it", () => {
  test("colour codes go, and a bar redrawn in place is its last drawing", () => {
    expect(shown("\x1b[32mok\x1b[0m built\n")).toBe("ok built\n");
    expect(shown(" 10%\r 55%\r100%\ndone\r\n")).toBe("100%\ndone\n");
    expect(shown("\x1b]0;title\x07plain")).toBe("plain");
  });

  test("the newest line is the last with anything on it, cut to fit", () => {
    expect(lastLine("[1/3] a\n[2/3] b\n\n  \n")).toBe("[2/3] b");
    expect(lastLine("step 1\n 40%\r 80%")).toBe("80%");
    expect(lastLine("")).toBe("");
    expect(lastLine("x".repeat(300), 20)).toBe(`${"x".repeat(19)}…`);
  });
});

describe("watching a running script", () => {
  test("hears its newest line as it prints, and marks how much had come by when", async () => {
    const heard: string[] = [];
    const stop = watchScript(file, (line) => heard.push(line), { lookMs: 10, tellMs: 0 });
    // nothing written yet: nothing to say, and no harm
    await nap(30);
    expect(heard).toEqual([]);
    fs.appendFileSync(file, "[1/3] fetching\n");
    await nap(40);
    fs.appendFileSync(file, "[2/3] building\n");
    await nap(40);
    expect(heard).toEqual(["[1/3] fetching", "[2/3] building"]);
    const marks = outputMarks(file);
    expect(marks.map((mark) => mark.offset)).toEqual([15, 30]);
    expect(marks[1]!.ts).toBeGreaterThan(marks[0]!.ts);
    stop();
  });

  test("a mark ends on a whole line; the stop's last look takes what is left", async () => {
    const heard: string[] = [];
    const stop = watchScript(file, (line) => heard.push(line), { lookMs: 10, tellMs: 0 });
    fs.appendFileSync(file, "one\ntwo, still being wri");
    await nap(40);
    expect(outputMarks(file).map((mark) => mark.offset)).toEqual([4]);
    expect(heard).toEqual(["two, still being wri"]);
    fs.appendFileSync(file, "tten");
    stop();
    expect(outputMarks(file).map((mark) => mark.offset)).toEqual([4, 28]);
    expect(heard.at(-1)).toBe("two, still being written");
    // and stopped is stopped
    fs.appendFileSync(file, "\nlater\n");
    await nap(40);
    expect(heard.at(-1)).toBe("two, still being written");
  });

  test("a script that prints all day is told of at most so often — and its last line always", async () => {
    const heard: string[] = [];
    const stop = watchScript(file, (line) => heard.push(line), { lookMs: 10, tellMs: 10_000 });
    for (let i = 1; i <= 5; i++) {
      fs.appendFileSync(file, `line ${i}\n`);
      await nap(25);
    }
    expect(heard).toEqual(["line 1"]);
    stop();
    expect(heard).toEqual(["line 1", "line 5"]);
  });
});

describe("the output in the stretches it arrived in", () => {
  const bytes = Buffer.from("a1\na2\nb1\nc1\nc2 so far");
  const marks = [
    { offset: 3, ts: 1_000 },
    { offset: 6, ts: 3_000 },
    { offset: 9, ts: 60_000 },
    { offset: 12, ts: 200_000 },
  ];

  test("printing with no pause in it is one stretch; a pause begins another, with its time", () => {
    expect(stretches({ bytes, from: 0 }, marks)).toEqual([
      // began at its first line, and printed until its last
      { from: 0, text: "a1\na2\n", ts: 1_000, until: 3_000 },
      { from: 6, text: "b1\n", ts: 60_000, until: 60_000 },
      // the line still being written rides with the newest stretch
      { from: 9, text: "c1\nc2 so far", ts: 200_000, until: 200_000 },
    ]);
  });

  test("with no marks, nothing is known of when: the output is whole", () => {
    expect(stretches({ bytes, from: 0 }, [])).toEqual([{ from: 0, text: "a1\na2\nb1\nc1\nc2 so far" }]);
  });

  test("only the end of a long output is read: marks before it are let go", () => {
    expect(stretches({ bytes: bytes.subarray(6), from: 6 }, marks)).toEqual([
      { from: 6, text: "b1\n", ts: 60_000, until: 60_000 },
      { from: 9, text: "c1\nc2 so far", ts: 200_000, until: 200_000 },
    ]);
  });
});

/** A context holding one chat whose transcript has this script's card. */
function chatWith(agent: SubagentState): ServerContext {
  const event: ToolEvent = { kind: "tool", id: "t1", name: "Bash", summary: "train", agent, ts: 1 };
  return {
    archive: { events: () => [event] },
    agentLogs: { read: () => [] },
    secrets: { redact: (text: string) => text.replaceAll("hunter2hunter2", "{{deploy-box}}") },
  } as unknown as ServerContext;
}

describe("a script's page", () => {
  const script = (patch: Partial<SubagentState> = {}): SubagentState => ({
    key: "k1",
    script: true,
    description: "train the model",
    prompt: "python -u train.py",
    status: "running",
    startedAt: 5,
    ...patch,
  });

  test("its command, then each stretch of what it printed, timed — secrets as their handles", async () => {
    const stop = watchScript(file, () => undefined, { lookMs: 10, tellMs: 0 });
    fs.appendFileSync(file, "epoch 1/3\n\x1b[2mtoken hunter2hunter2\x1b[0m\n");
    await nap(40);
    stop();
    const log = scriptLog(chatWith(script({ output: file })), "c1", "k1")!;
    expect(log.map((event) => [event.kind, event.id])).toEqual([
      ["user", "k1:command"],
      ["assistant", "k1:out:0"],
    ]);
    expect(log[0]).toMatchObject({ text: "```sh\npython -u train.py\n```", ts: 5 });
    expect(log[1]).toMatchObject({ text: "```\nepoch 1/3\ntoken {{deploy-box}}\n```" });
    expect(log[1]!.ts).toBe(outputMarks(file)[0]!.ts);
  });

  test("where it printed nothing for a while, a line says for how long", async () => {
    const stop = watchScript(file, () => undefined, { lookMs: 10, tellMs: 0 });
    fs.appendFileSync(file, "[1/2] downloading\n");
    await nap(40);
    // as if the next line came eight seconds on
    const marks = outputMarks(file);
    marks[0]!.ts -= 8_000;
    fs.appendFileSync(file, "[2/2] unpacking\n");
    await nap(40);
    stop();
    const log = scriptLog(chatWith(script({ output: file })), "c1", "k1")!;
    expect(log.map((event) => event.kind)).toEqual(["user", "assistant", "info", "assistant"]);
    expect(log[2]).toMatchObject({ kind: "info", text: "printed nothing for 8s" });
    expect(log[3]).toMatchObject({ id: "k1:out:18", text: "```\n[2/2] unpacking\n```" });
  });

  test("nothing printed yet says so; output nobody watched arrive comes whole, untimed", () => {
    const quiet = scriptLog(chatWith(script({ output: file })), "c1", "k1")!;
    expect(quiet.at(-1)).toMatchObject({ id: "k1:output", text: "*nothing printed yet*" });
    const other = path.join(dir, "tasks", "b2.output");
    fs.writeFileSync(other, "all of it\nat once\n");
    const whole = scriptLog(chatWith(script({ output: other, status: "done", endedAt: 99 })), "c1", "k1")!;
    expect(whole.at(-1)).toMatchObject({ id: "k1:output", text: "```\nall of it\nat once\n```", ts: 99 });
  });

  test("a file that is not a task's output is never read", () => {
    const elsewhere = path.join(dir, "secrets.txt");
    fs.writeFileSync(elsewhere, "not for the page\n");
    const log = scriptLog(chatWith(script({ output: elsewhere })), "c1", "k1")!;
    expect(JSON.stringify(log)).not.toContain("not for the page");
  });

  test("a key that is no script's is not this page's to answer", () => {
    expect(scriptLog(chatWith(script()), "c1", "other")).toBeNull();
  });
});

describe("a running script's card", () => {
  const saved = { look: process.env["RURI_SCRIPT_LOOK_MS"], tell: process.env["RURI_SCRIPT_TELL_MS"] };
  beforeEach(() => {
    process.env["RURI_SCRIPT_LOOK_MS"] = "10";
    process.env["RURI_SCRIPT_TELL_MS"] = "1";
  });
  afterEach(() => {
    for (const [key, value] of [
      ["RURI_SCRIPT_LOOK_MS", saved.look],
      ["RURI_SCRIPT_TELL_MS", saved.tell],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function opened(): { book: AgentBook; cards: () => SubagentState[] } {
    const sent: TranscriptEvent[] = [];
    const events = {
      onEvent: (_: string, event: TranscriptEvent) => sent.push(event),
      onEventUpdate: (_: string, event: TranscriptEvent) => sent.push(event),
    };
    return {
      book: new AgentBook("p", events as never),
      cards: () => sent.flatMap((event) => (event.kind === "tool" && event.agent ? [event.agent] : [])),
    };
  }

  const shell = (output?: string): ToolEvent => ({
    kind: "tool",
    id: "t1",
    name: "Bash",
    summary: "train",
    agent: {
      key: "k1",
      script: true,
      description: "train the model",
      prompt: "python -u train.py",
      status: "running",
      background: true,
      startedAt: Date.now(),
      ...(output ? { output } : {}),
    },
    ts: 1,
  });

  test("carries the newest line it printed and when — from the moment its file is known, until it ends", async () => {
    const { book, cards } = opened();
    // the card comes first; where its output goes is learned a moment later
    book.attach(shell());
    fs.appendFileSync(file, "epoch 1/3 loss 0.9\n");
    await nap(40);
    expect(cards().at(-1)?.activity).toBeUndefined();
    book.update("k1", { output: file });
    // a card goes out at most twice a second
    await nap(700);
    expect(cards().at(-1)).toMatchObject({ activity: "epoch 1/3 loss 0.9", status: "running" });
    const first = cards().at(-1)!.printedAt!;
    expect(first).toBeGreaterThan(0);

    fs.appendFileSync(file, "epoch 2/3 loss 0.5\n");
    await nap(700);
    expect(cards().at(-1)).toMatchObject({ activity: "epoch 2/3 loss 0.5" });
    expect(cards().at(-1)!.printedAt!).toBeGreaterThan(first);

    // its end: the last thing it printed is on the card that says how it went
    fs.appendFileSync(file, "epoch 3/3 loss 0.2\nsaved model.pt\n");
    book.update("k1", { status: "done", result: "completed (exit code 0)" });
    await nap(700);
    expect(cards().at(-1)).toMatchObject({ status: "done", activity: "saved model.pt" });
    const sentSoFar = cards().length;
    fs.appendFileSync(file, "written after the end\n");
    await nap(60);
    expect(cards()).toHaveLength(sentSoFar);
  });

  test("a script cut short with its session is no longer watched", async () => {
    const { book, cards } = opened();
    book.attach(shell(file));
    book.settle();
    expect(cards().at(-1)?.status).toBe("stopped");
    const sentSoFar = cards().length;
    fs.appendFileSync(file, "nobody is listening\n");
    await nap(60);
    expect(cards()).toHaveLength(sentSoFar);
  });
});
