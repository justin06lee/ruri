import { describe, expect, test } from "bun:test";
import { HOME_ID } from "../../shared/protocol";
import { at } from "./editor";
import { Ruri } from "./store";
import { ALPHA, BETA, FakeWire, snapshot, user } from "./test/fixtures";

/** A store on a wire the test holds, already past its snapshot. */
function up(over: Record<string, unknown> = {}) {
  const wires: FakeWire[] = [];
  let time = 10_000;
  const store = new Ruri({
    dial: () => {
      const wire = new FakeWire();
      wires.push(wire);
      return wire;
    },
    throttleMs: 0,
    now: () => time,
  });
  store.start();
  const wire = wires[0]!;
  wire.open();
  wire.say(snapshot(over));
  return { store, wire, wires, tick: (ms: number) => (time += ms) };
}

describe("the terminal's store", () => {
  test("on connecting it says what is on screen and asks for it whole", () => {
    const { store, wire } = up();
    expect(store.get()).toMatchObject({ connected: true, ready: true, activeId: HOME_ID });
    expect(wire.of("view")).toEqual([{ type: "view", channels: [HOME_ID], live: true, awake: true }]);
    expect(wire.of("transcript_get")).toEqual([{ type: "transcript_get", projectId: HOME_ID }]);
    store.stop();
  });

  test("opening a chat watches it, asks for it once, and reads it", () => {
    const { store, wire } = up();
    wire.say({ type: "event", projectId: ALPHA, event: { kind: "result", id: "r", ok: true, ts: 9 } });
    expect(store.get().unread[ALPHA]).toBe(true);
    store.open(ALPHA);
    store.open(ALPHA);
    expect(store.get().unread[ALPHA]).toBeUndefined();
    expect(wire.of("view").at(-1)).toMatchObject({ channels: [ALPHA] });
    expect(wire.of("transcript_get").filter((m) => m.projectId === ALPHA)).toHaveLength(1);
    store.stop();
  });

  test("a prompt goes out under an id, and the draft goes with it everywhere", () => {
    const { store, wire } = up();
    store.open(ALPHA);
    store.edit(ALPHA, at("  do the thing  "));
    expect(store.prompt(ALPHA)).toBe(true);
    const [sent] = wire.of("send");
    expect(sent).toMatchObject({ projectId: ALPHA, text: "do the thing" });
    expect(sent!.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(wire.of("draft").at(-1)).toEqual({ type: "draft", projectId: ALPHA, text: "", attachments: [] });
    expect(store.get().edits[ALPHA]!.text).toBe("");
    // nothing to send is nothing sent
    expect(store.prompt(ALPHA)).toBe(false);
    store.stop();
  });

  test("a prompt that did not go through is back in the box", () => {
    const { store, wire } = up();
    store.edit(ALPHA, at("try this"));
    store.prompt(ALPHA);
    wire.say({ type: "sent", projectId: ALPHA, clientId: wire.of("send")[0]!.clientId!, as: "failed" });
    expect(store.get().edits[ALPHA]!.text).toBe("try this");
    expect(store.get().notice).toContain("did not go through");
    store.stop();
  });

  test("typing is saved as a draft after a pause, with no word of attachments", async () => {
    const { store, wire } = up();
    store.edit(ALPHA, at("half a tho"));
    store.edit(ALPHA, at("half a thought"));
    expect(wire.of("draft")).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 450));
    expect(wire.of("draft")).toEqual([{ type: "draft", projectId: ALPHA, text: "half a thought" }]);
    store.stop();
  });

  test("a draft typed on another device lands in the box, unless this one was typed in a moment ago", () => {
    const { store, wire, tick } = up({ composerDrafts: { [BETA]: { text: "from before" } } });
    expect(store.get().edits[BETA]!.text).toBe("from before");
    wire.say({ type: "composer_draft", projectId: ALPHA, text: "from the phone" });
    expect(store.get().edits[ALPHA]).toEqual(at("from the phone"));
    store.edit(ALPHA, at("mine"));
    wire.say({ type: "composer_draft", projectId: ALPHA, text: "theirs" });
    expect(store.get().edits[ALPHA]!.text).toBe("mine");
    tick(2500);
    wire.say({ type: "composer_draft", projectId: ALPHA, text: "theirs, later" });
    expect(store.get().edits[ALPHA]!.text).toBe("theirs, later");
    store.stop();
  });

  test("cards are answered and taken down", () => {
    const { store, wire } = up({
      permissions: [
        { requestId: "p1", projectId: ALPHA, toolName: "Bash", input: {}, ts: 1 },
        {
          requestId: "q1",
          projectId: ALPHA,
          toolName: "AskUserQuestion",
          kind: "question",
          input: { questions: [] },
          ts: 2,
        },
        { requestId: "c1", projectId: ALPHA, toolName: "name", kind: "component", input: {}, ts: 3 },
      ],
    });
    store.answerPermission("p1", true, true);
    store.answerQuestion("q1", { answers: { "A?": "yes" } });
    store.nameComponent("c1");
    expect(wire.of("permission_response")).toEqual([
      { type: "permission_response", requestId: "p1", allow: true, always: true },
    ]);
    expect(wire.of("question_response")).toEqual([
      { type: "question_response", requestId: "q1", answers: { answers: { "A?": "yes" } } },
    ]);
    expect(wire.of("component_named")).toEqual([{ type: "component_named", requestId: "c1", skip: true }]);
    expect(store.get().permissions).toEqual([]);
    store.stop();
  });

  test("a pick is the chat's own, shown at once", () => {
    const { store, wire } = up();
    store.pick(ALPHA, "model", "haiku");
    store.pick(ALPHA, "permissionMode", "plan");
    store.pick(HOME_ID, "effort", "high");
    expect(wire.of("set_model")).toEqual([{ type: "set_model", projectId: ALPHA, model: "haiku" }]);
    expect(wire.of("set_permission_mode")).toEqual([
      { type: "set_permission_mode", projectId: ALPHA, mode: "plan" },
    ]);
    const session = store.get().projects.find((p) => p.id === "p-alpha")!.sessions[0]!;
    expect(session).toMatchObject({ model: "haiku", permissionMode: "plan" });
    expect(store.get().home.effort).toBe("high");
    store.stop();
  });

  test("an account is the chat's own over its project's, and the project's again by picking it", () => {
    const { store, wire } = up();
    const [work, personal] = store.get().accounts;
    store.pickAccount(ALPHA, personal!);
    expect(wire.of("set_chat_account").at(-1)).toEqual({
      type: "set_chat_account",
      chatId: ALPHA,
      provider: "claude",
      account: "personal",
    });
    expect(store.get().projects.find((p) => p.id === "p-alpha")!.sessions[0]!.accounts).toEqual({
      claude: "personal",
    });
    store.pickAccount(ALPHA, work!);
    expect(wire.of("set_chat_account").at(-1)).toEqual({
      type: "set_chat_account",
      chatId: ALPHA,
      provider: "claude",
    });
    expect(store.get().projects.find((p) => p.id === "p-alpha")!.sessions[0]!.accounts).toBeUndefined();
    store.pickAccount(HOME_ID, personal!);
    expect(wire.of("set_account")).toEqual([
      { type: "set_account", projectId: HOME_ID, account: "personal" },
    ]);
    store.stop();
  });

  test("the queue: send one now, remove one, take one back to rewrite", () => {
    const { store, wire } = up({
      queued: {
        [ALPHA]: [
          { id: "k1", text: "first" },
          { id: "k2", text: "second" },
        ],
      },
    });
    store.queueNow(ALPHA, "k1");
    store.queueRemove(ALPHA, "k2");
    expect(wire.of("queue_now")).toEqual([{ type: "queue_now", projectId: ALPHA, itemId: "k1" }]);
    store.edit(ALPHA, at("already here"));
    store.queueEdit(ALPHA, "k2");
    expect(wire.of("queue_remove")).toHaveLength(2);
    expect(store.get().edits[ALPHA]!.text).toBe("already here\nsecond");
    store.stop();
  });

  test("a folder folds on every device", () => {
    const { store, wire } = up();
    store.fold("f-1", true);
    expect(wire.of("folder_set")).toEqual([{ type: "folder_set", folderId: "f-1", collapsed: true }]);
    expect(store.get().sidebar.folders[0]!.collapsed).toBe(true);
    store.stop();
  });

  test("with the line down nothing is lost: the prompt stays, and says why", () => {
    const { store, wire } = up();
    store.edit(ALPHA, at("keep me"));
    wire.close();
    expect(store.get().connected).toBe(false);
    expect(store.prompt(ALPHA)).toBe(false);
    expect(store.get().edits[ALPHA]!.text).toBe("keep me");
    expect(store.get().notice).toContain("Not connected");
    store.stop();
  });

  test("it dials again, and asks again for the chat on screen", async () => {
    const { store, wire, wires } = up();
    store.open(ALPHA);
    wire.say({
      type: "transcript",
      projectId: ALPHA,
      events: [user("u0", "old", 0), user("u1", "hello alpha")],
      summaries: {},
    });
    wire.close();
    await new Promise((r) => setTimeout(r, 600));
    expect(wires).toHaveLength(2);
    wires[1]!.open();
    wires[1]!.say(snapshot());
    expect(store.get().connected).toBe(true);
    // held whole before, kept on screen with the tail laid over it
    expect(store.get().transcripts[ALPHA]!.map((e) => e.id)).toEqual(["u0", "u1", "a1"]);
    expect(wires[1]!.of("transcript_get")).toEqual([{ type: "transcript_get", projectId: ALPHA }]);
    store.stop();
  });
});
