import { describe, expect, test } from "bun:test";
import { channelOf, elapsedMs, parsePs, partition, processName, rollUp } from "./resources.js";

describe("reading ps", () => {
  test("a line becomes its numbers, with the command kept whole", () => {
    const rows = parsePs("  501   1  239776   7.6 05-08:43:55 /usr/bin/claude --resume=abc --model opus\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      pid: 501,
      ppid: 1,
      rss: 239776 * 1024,
      cpu: 7.6,
      uptimeMs: elapsedMs("05-08:43:55"),
      args: "/usr/bin/claude --resume=abc --model opus",
    });
  });

  test("the header and anything unreadable are skipped", () => {
    const rows = parsePs("  PID  PPID   RSS %CPU ELAPSED COMMAND\n\n   7 1 100 0.0 01:00 /bin/sh\ngarbage\n");
    expect(rows.map((r) => r.pid)).toEqual([7]);
  });

  test("elapsed time reads in every shape ps writes it", () => {
    expect(elapsedMs("00:05")).toBe(5_000);
    expect(elapsedMs("01:30")).toBe(90_000);
    expect(elapsedMs("02:00:00")).toBe(2 * 3_600_000);
    expect(elapsedMs("3-00:00:00")).toBe(3 * 24 * 3_600_000);
    expect(elapsedMs("05-08:43:55")).toBe(((5 * 24 + 8) * 3_600 + 43 * 60 + 55) * 1_000);
    expect(elapsedMs("nonsense")).toBe(0);
  });
});

describe("naming a process", () => {
  test("the program at the front of the line", () => {
    expect(processName("/Users/me/.local/bin/claude --output-format stream-json")).toBe("claude");
    expect(processName("/opt/homebrew/bin/codex app-server")).toBe("codex");
  });

  test("a runtime is named by what it was pointed at", () => {
    expect(processName("/usr/bin/node /opt/mcp/server.js --port 3")).toBe("server");
    expect(processName("bun /Users/me/thing/cli.ts")).toBe("cli");
    expect(processName("node --enable-source-maps /x/opencode.mjs")).toBe("opencode");
  });

  test("something it cannot read is not a crash", () => {
    expect(processName("")).toBe("unknown");
  });
});

describe("whose an agent is", () => {
  const owners = new Map([["4c686435-2213-4f59-92ab-83e163488bfd", "chat-1"]]);
  const ownerOf = (id: string) => owners.get(id);

  test("a session id on the command line names the chat", () => {
    expect(channelOf("/bin/claude --resume=4C686435-2213-4F59-92AB-83E163488BFD --model opus", ownerOf)).toBe(
      "chat-1",
    );
  });

  test("a session id ruri does not know names nobody", () => {
    expect(channelOf("/bin/claude --resume=11111111-2222-4333-8444-555555555555", ownerOf)).toBeUndefined();
  });

  test("no session id at all names nobody", () => {
    expect(channelOf("/bin/claude --model opus", ownerOf)).toBeUndefined();
  });
});

/** What the sampler does: roll the tree up, then keep the chats. */
function sorted(
  rows: Parameters<typeof rollUp>[0],
  rootPid: number,
  ownerOf: (sessionId: string) => string | undefined,
  placed: Record<number, string> = {},
) {
  const { candidates, app } = rollUp(rows, rootPid, ownerOf);
  for (const candidate of candidates) {
    const found = placed[candidate.pid];
    if (found !== undefined) candidate.channelId = found;
  }
  return partition(candidates, app);
}

describe("rolling a process tree up into agents", () => {
  const row = (pid: number, ppid: number, rssMb: number, cpu: number, args: string) => ({
    pid,
    ppid,
    rss: rssMb * 1024 * 1024,
    cpu,
    uptimeMs: 60_000,
    args,
  });
  const ownerOf = (id: string) => (id === "4c686435-2213-4f59-92ab-83e163488bfd" ? "chat-1" : undefined);

  test("a harness and its MCP servers are one agent", () => {
    const { agents } = sorted(
      [
        row(1, 0, 10, 0, "/sbin/launchd"),
        row(100, 1, 80, 1, "/Applications/ruri.app/Contents/MacOS/ruri"),
        row(200, 100, 240, 7.5, "/bin/claude --resume=4c686435-2213-4f59-92ab-83e163488bfd"),
        row(201, 200, 30, 0.5, "/usr/bin/node /opt/mcp/one.js"),
        row(202, 201, 20, 0.2, "/usr/bin/node /opt/mcp/deep.js"),
      ],
      100,
      ownerOf,
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("claude");
    expect(agents[0]!.channelId).toBe("chat-1");
    expect(agents[0]!.rss).toBe(290 * 1024 * 1024);
    expect(agents[0]!.cpu).toBe(8.2);
    expect(agents[0]!.helpers).toBe(2);
  });

  test("the window's own helpers are the app, not agents", () => {
    const { agents, app } = sorted(
      [
        row(100, 1, 80, 1, "/Applications/ruri.app/Contents/MacOS/ruri"),
        row(300, 100, 150, 3, "/Applications/ruri.app/.../Helper --type=renderer --x"),
        row(301, 100, 60, 1, "/Applications/ruri.app/.../Helper --type=gpu-process"),
        row(200, 100, 240, 7, "/bin/claude --model opus"),
      ],
      100,
      ownerOf,
      { 200: "chat-1" },
    );
    expect(agents.map((a) => a.name)).toEqual(["claude"]);
    expect(app.rss).toBe((80 + 150 + 60) * 1024 * 1024);
    expect(app.cpu).toBe(5);
    expect(app.processes).toBe(3);
  });

  test("agents come back heaviest first", () => {
    const { agents } = sorted(
      [
        row(100, 1, 10, 0, "/ruri"),
        row(200, 100, 100, 0, "/bin/claude a"),
        row(300, 100, 400, 0, "/bin/codex b"),
        row(400, 100, 250, 0, "/bin/cursor-agent c"),
      ],
      100,
      ownerOf,
      { 200: "chat-a", 300: "chat-b", 400: "chat-c" },
    );
    expect(agents.map((a) => a.name)).toEqual(["codex", "cursor-agent", "claude"]);
  });

  test("a chat placed by its environment rather than its command line", () => {
    const { agents } = sorted(
      [row(100, 1, 10, 0, "/ruri"), row(200, 100, 300, 2, "/bin/claude --model opus")],
      100,
      ownerOf,
      { 200: "chat-9" },
    );
    expect(agents[0]!.channelId).toBe("chat-9");
    expect(agents[0]!.rss).toBe(300 * 1024 * 1024);
  });

  test("ruri's own machinery is the app, not an agent", () => {
    // the probes that ask each harness what models it has, a build step,
    // a one-shot tool: none is a conversation, and none belongs in a list
    // of them — they are counted in ruri's own figure instead
    const { agents, app } = sorted(
      [
        row(100, 1, 10, 0, "/ruri"),
        row(200, 100, 7, 0, "/opt/bin/esbuild --service=0.28"),
        row(201, 100, 2, 0, "/bin/ps -Ao pid="),
        row(203, 100, 115, 4, "/opt/homebrew/bin/codex app-server"),
        row(202, 100, 300, 4, "/bin/claude --resume=4c686435-2213-4f59-92ab-83e163488bfd"),
      ],
      100,
      ownerOf,
    );
    expect(agents.map((a) => a.name)).toEqual(["claude"]);
    // the probe and the odd tool are counted, just not called chats
    expect(app.rss).toBe((10 + 7 + 2 + 115) * 1024 * 1024);
    expect(app.processes).toBe(4);
  });

  test("the shells behind the terminal tabs are ruri's own", () => {
    // a shell can be as heavy as anything it is running; it is not a chat,
    // so it is ruri's weight, not an agent's
    const { agents, app } = sorted(
      [
        row(100, 1, 10, 0, "/ruri"),
        row(300, 100, 400, 90, "/usr/bin/expect -c spawn /bin/zsh -il"),
        row(301, 300, 200, 80, "/bin/zsh -il"),
      ],
      100,
      ownerOf,
    );
    expect(agents).toEqual([]);
    expect(app.processes).toBe(3);
    expect(app.rss).toBe(610 * 1024 * 1024);
  });

  test("a chat is an agent however small it is", () => {
    const { agents } = sorted(
      [
        row(100, 1, 10, 0, "/ruri"),
        row(200, 100, 3, 0, "/bin/claude --resume=4c686435-2213-4f59-92ab-83e163488bfd"),
      ],
      100,
      ownerOf,
    );
    expect(agents).toHaveLength(1);
    expect(agents[0]!.channelId).toBe("chat-1");
  });

  test("a harness ruri cannot place is counted but not listed", () => {
    // nothing said whose it was: it is real weight, and it goes into
    // ruri's figure rather than being guessed at
    const { agents, app } = sorted(
      [row(100, 1, 10, 0, "/ruri"), row(200, 100, 300, 2, "/bin/claude --model opus")],
      100,
      ownerOf,
    );
    expect(agents).toEqual([]);
    expect(app.rss).toBe(310 * 1024 * 1024);
  });

  test("nothing running is no agents, not a throw", () => {
    const { agents, app } = sorted([{ ...row(100, 1, 80, 1, "/ruri") }], 100, ownerOf);
    expect(agents).toEqual([]);
    expect(app.processes).toBe(1);
  });
});
