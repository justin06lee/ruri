import { afterEach, describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App";
import { Ruri } from "./store";
import { ALPHA, BETA, FakeWire, said, snapshot, user } from "./test/fixtures";

const ENTER = "\r";
const ESC = "\u001B";
const UP = "\u001B[A";
const DOWN = "\u001B[B";
const CTRL_K = "\u000B";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const each of cleanup) each();
  cleanup = [];
});

/** The app on a wire the test holds, past its snapshot. */
async function up(over: Record<string, unknown> = {}) {
  const wire = new FakeWire();
  const store = new Ruri({ dial: () => wire, throttleMs: 0 });
  store.start();
  wire.open();
  wire.say(snapshot(over));
  const app = render(<App store={store} />);
  cleanup.push(() => {
    app.unmount();
    store.stop();
  });
  await wait();
  const keys = async (...each: string[]) => {
    for (const key of each) {
      app.stdin.write(key);
      await wait();
    }
  };
  return { wire, store, keys, frame: () => app.lastFrame() ?? "" };
}

describe("ruri in a terminal", () => {
  test("it draws the sidebar in the user's order, the chat, the prompt and the gauges", async () => {
    const { frame } = await up();
    const screen = frame();
    const lines = screen.split("\n");
    expect(lines[0]).toContain("ruri");
    expect(lines[0]).toContain("5h 12% · week 48%");
    const names = lines.slice(1, 6).map((l) => l.split("│")[0]!.trim());
    expect(names[0]).toContain("Home");
    expect(names[1]).toContain("★ beta 한국어");
    expect(names[2]).toContain("▾ work");
    expect(names[3]).toContain("alpha");
    expect(names[4]).toContain("gamma");
    expect(screen).toContain("Message Home…");
    expect(screen).toContain("Fable 5.2 · Work · XHigh · Bypass");
  });

  test("the switcher goes to a project by a few letters of its name", async () => {
    const { frame, keys, store, wire } = await up();
    await keys(CTRL_K, "a", "l");
    expect(frame()).toContain("❯ al");
    await keys(ENTER);
    expect(store.get().activeId).toBe(ALPHA);
    expect(wire.of("view").at(-1)).toMatchObject({ channels: [ALPHA] });
    const screen = frame();
    expect(screen).toContain("❯ hello alpha");
    expect(screen).toContain("hi there");
    expect(screen).toContain("ctx 25%");
  });

  test("typing and enter sends the prompt; alt+enter and a trailing backslash make a new line", async () => {
    const { keys, wire, store } = await up();
    await keys(CTRL_K, "a", "l", ENTER);
    await keys("f", "i", "x", " ", "i", "t", `${ESC}${ENTER}`, "n", "o", "w", "\\", ENTER, "!");
    expect(store.get().edits[ALPHA]!.text).toBe("fix it\nnow\n!");
    await keys(ENTER);
    expect(wire.of("send")).toHaveLength(1);
    expect(wire.of("send")[0]).toMatchObject({ projectId: ALPHA, text: "fix it\nnow\n!" });
    expect(store.get().edits[ALPHA]!.text).toBe("");
  });

  test("two keys between two draws both land", async () => {
    const { store, wire } = await up();
    const app = render(<App store={store} />);
    cleanup.push(() => app.unmount());
    app.stdin.write("a");
    app.stdin.write("b");
    await wait();
    expect(store.get().edits["home"]!.text).toBe("ab");
    expect(wire.closed).toBe(false);
  });

  test("the sidebar opens a chat and folds a folder", async () => {
    const { keys, store, wire, frame } = await up();
    // from the prompt, back round to the sidebar
    await keys(`${ESC}[Z`, `${ESC}[Z`);
    await keys(DOWN, ENTER);
    expect(store.get().activeId).toBe(BETA);
    await keys(`${ESC}[Z`, `${ESC}[Z`, DOWN, ENTER);
    expect(wire.of("folder_set")).toEqual([{ type: "folder_set", folderId: "f-1", collapsed: true }]);
    expect(frame()).toContain("▸ work (1)");
  });

  test("a reply streams into the chat, and escape stops the turn", async () => {
    const { keys, wire, frame } = await up();
    await keys(CTRL_K, "b", "e", ENTER);
    wire.say({ type: "delta", projectId: BETA, messageId: "m1", delta: "thinking **hard**" });
    await wait();
    expect(frame()).toContain("thinking hard▍");
    expect(frame()).toContain("working");
    await keys(ESC);
    expect(wire.of("interrupt")).toEqual([{ type: "interrupt", projectId: BETA }]);
  });

  test("a card takes the keys from an empty prompt, and enter allows", async () => {
    const { keys, wire, frame } = await up({
      permissions: [
        { requestId: "p1", projectId: ALPHA, toolName: "Bash", input: { command: "make deploy" }, ts: 1 },
      ],
    });
    await keys(CTRL_K, "a", "l", ENTER);
    expect(frame()).toContain("? Allow Bash");
    expect(frame()).toContain("make deploy");
    await keys(DOWN, ENTER);
    expect(wire.of("permission_response")).toEqual([
      { type: "permission_response", requestId: "p1", allow: false },
    ]);
    expect(frame()).not.toContain("? Allow Bash");
  });

  test("escape leaves a card for later, and the prompt can be typed in", async () => {
    const { keys, wire, store, frame } = await up({
      permissions: [{ requestId: "p1", projectId: ALPHA, toolName: "Bash", input: { command: "ls" }, ts: 1 }],
    });
    await keys(CTRL_K, "a", "l", ENTER, ESC, "o", "k");
    expect(store.get().edits[ALPHA]!.text).toBe("ok");
    expect(wire.of("permission_response")).toHaveLength(0);
    expect(frame()).toContain("tab to answer");
  });

  test("the queue: up from the prompt reaches it, enter sends that one now", async () => {
    const { keys, wire, frame } = await up({
      queued: {
        [BETA]: [
          { id: "k1", text: "first queued" },
          { id: "k2", text: "second queued" },
        ],
      },
    });
    await keys(CTRL_K, "b", "e", ENTER);
    expect(frame()).toContain("queued (2)");
    expect(frame()).toContain("2. second queued");
    await keys(UP, UP, ENTER);
    expect(wire.of("queue_now")).toEqual([{ type: "queue_now", projectId: BETA, itemId: "k1" }]);
    await keys("x");
    expect(wire.of("queue_remove")).toEqual([{ type: "queue_remove", projectId: BETA, itemId: "k1" }]);
  });

  test("the pickers under the prompt: down, enter, choose", async () => {
    const { keys, wire, frame } = await up();
    await keys(CTRL_K, "a", "l", ENTER, DOWN, ENTER);
    expect(frame()).toContain("Model for this chat");
    expect(frame()).toContain("✓ Fable 5.2");
    await keys(DOWN, ENTER);
    expect(wire.of("set_model")).toEqual([{ type: "set_model", projectId: ALPHA, model: "haiku" }]);
    expect(frame()).toContain("Haiku 5.5 · Work");
    // the account chip: the personal account is nearly full, and says so
    await keys(`${ESC}[C`, ENTER);
    expect(frame()).toContain("Account this chat spends from");
    expect(frame()).toContain("Personal");
    expect(frame()).toContain("Fable 97%");
    await keys(DOWN, ENTER);
    expect(wire.of("set_chat_account")).toEqual([
      { type: "set_chat_account", chatId: ALPHA, provider: "claude", account: "personal" },
    ]);
    expect(frame()).toContain("Personal · Fable 97%");
  });

  test("in the chat, a tool step opens and closes on enter", async () => {
    const { keys, frame } = await up({
      transcripts: {
        [ALPHA]: [
          user("u1", "change it"),
          {
            kind: "tool",
            id: "t1",
            name: "Edit",
            summary: "a.ts",
            diff: {
              path: "a.ts",
              added: 1,
              removed: 0,
              hunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: "add", text: "const added = true;" }] }],
            },
            ts: 2,
          },
          said("a1", "done", 3),
        ],
      },
    });
    await keys(CTRL_K, "a", "l", ENTER);
    expect(frame()).toContain("✎ Edit a.ts +1 -0");
    expect(frame()).not.toContain("const added = true;");
    // to the chat, up past the reply to the tool step, open it
    await keys(`${ESC}[Z`, UP, UP, ENTER);
    expect(frame()).toContain("+ const added = true;");
    await keys(ENTER);
    expect(frame()).not.toContain("const added = true;");
  });

  test("? on an empty prompt shows the keys, and any key puts them away", async () => {
    const { keys, frame, store } = await up();
    await keys("?");
    expect(frame()).toContain("ruri in a terminal");
    await keys("x");
    expect(frame()).not.toContain("ruri in a terminal");
    expect(store.get().edits["home"]?.text ?? "").toBe("");
  });

  test("with the line down it says so", async () => {
    const { wire, frame } = await up();
    wire.close();
    await wait();
    expect(frame()).toContain("reconnecting to ruri…");
  });
});
