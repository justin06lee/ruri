import { describe, expect, test } from "bun:test";
import { ShellLink, type ShellStart, type ToShell } from "./hostLink.js";

const START: ShellStart = {
  port: 7776,
  token: "t",
  staticDir: "/x",
  reclaimPort: true,
  appPid: 1,
  permissions: false,
  bridges: {},
};

/** A link whose messages to the shell are kept, to be answered by hand. */
function linked(start: Partial<ShellStart> = {}) {
  const sent: ToShell[] = [];
  const link = new ShellLink((message) => sent.push(message), { ...START, ...start });
  return { link, sent, hooks: link.hooks() };
}

describe("the server's end of the shell", () => {
  test("a call goes out with an id and comes back as its answer", async () => {
    const { link, sent, hooks } = linked();
    const picked = hooks.pickFolder!();
    expect(sent).toEqual([{ type: "call", id: 1, method: "pickFolder", args: [] }]);
    link.receive({ type: "reply", id: 1, ok: true, value: "/home/me/project" });
    expect(await picked).toBe("/home/me/project");
  });

  test("answers find their own calls, in whatever order they come", async () => {
    const { link, hooks } = linked();
    const first = hooks.bridge!.takeover("a");
    const second = hooks.capture!("http://x", []);
    link.receive({ type: "reply", id: 2, ok: true, value: { "#x": "/shot.png" } });
    link.receive({ type: "reply", id: 1, ok: true, value: undefined });
    expect(await second).toEqual({ "#x": "/shot.png" });
    expect(await first).toBeUndefined();
  });

  test("what went wrong in the shell is an error here, in its words", async () => {
    const { link, hooks } = linked();
    const run = hooks.bridge!.run({ channelId: "c", projectId: "p" }, { tool: "web_close", args: {} });
    link.receive({ type: "reply", id: 1, ok: false, error: "no window is open" });
    expect(run).rejects.toThrow("no window is open");
  });

  test("a picture crosses as bytes and arrives as a Buffer", async () => {
    const { link, hooks } = linked();
    const run = hooks.bridge!.run({ channelId: "c", projectId: "p" }, { tool: "web_screenshot", args: {} });
    const bytes = new Uint8Array([137, 80, 78, 71]);
    link.receive({
      type: "reply",
      id: 1,
      ok: true,
      value: { text: "shot", image: { png: bytes, path: "/p.png" } },
    });
    const result = await run;
    expect(Buffer.isBuffer(result.image?.png)).toBe(true);
    expect(result.image?.png.toString("base64")).toBe(Buffer.from(bytes).toString("base64"));
    expect(result.image?.path).toBe("/p.png");
  });

  test("the bridge's state is kept here as the shell reports it", () => {
    const state = { kind: "web", url: "http://x", title: "x", takenOver: false } as never;
    const { link, hooks } = linked({ bridges: { a: state } });
    const heard: Array<[string, unknown]> = [];
    hooks.bridge!.onState((channelId, next) => heard.push([channelId, next]));
    expect(hooks.bridge!.states()).toEqual({ a: state });
    link.receive({ type: "bridgeState", channelId: "b", state });
    link.receive({ type: "bridgeState", channelId: "a", state: null });
    expect(hooks.bridge!.states()).toEqual({ b: state });
    expect(heard).toEqual([
      ["b", state],
      ["a", null],
    ]);
  });

  test("macOS's grants are offered only where the shell has them", () => {
    expect(linked().hooks.permissions).toBeUndefined();
    expect(linked({ permissions: true }).hooks.permissions).toBeDefined();
  });

  test("carrying the window asks for nothing back", () => {
    const { sent, hooks } = linked();
    hooks.windowDrag!("move");
    expect(sent).toEqual([{ type: "windowDrag", phase: "move" }]);
  });
});
