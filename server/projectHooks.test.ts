import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { PermissionRequest, Project, ProjectEventPayload, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import {
  buildPayload,
  fireProjectEvent,
  HookCenter,
  MIDNA_COMMAND,
  projectBusy,
  realIo,
  sendTestEvent,
  trimSummary,
  useHooks,
  type Attempt,
  type HookIo,
} from "./projectHooks.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hooks-"));
});

const files = () => ({ config: path.join(dir, "hooks.json"), log: path.join(dir, "hook-deliveries.json") });

/** The world, faked: every command and post is written down and answered
 *  from `answers`, and nothing waits on a clock — a retry is a timer the
 *  test fires by hand. */
function fakeWorld(options: { midna?: string | null; answers?: Attempt[] } = {}) {
  const calls: Array<{
    kind: "command" | "webhook";
    to: string;
    input: string;
    token?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const answers = [...(options.answers ?? [])];
  const answer = (kind: "command" | "webhook"): Attempt =>
    answers.shift() ?? { ok: true, retry: false, result: kind === "command" ? "exit 0" : "HTTP 200" };
  let clock = 1_000_000;
  const io: HookIo = {
    runCommand: async (command, input, opts) => {
      calls.push({ kind: "command", to: command, input, env: opts.env });
      return answer("command");
    },
    post: async (url, body, token) => {
      calls.push({ kind: "webhook", to: url, input: body, ...(token ? { token } : {}) });
      return answer("webhook");
    },
    findMidna: () => (options.midna === undefined ? null : options.midna),
    now: () => clock,
    later: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => (timer.cancelled = true) };
    },
  };
  /** Fire the retries waiting (not the log's save), oldest first. */
  const retry = async (): Promise<number[]> => {
    const due = timers.filter((t) => !t.cancelled && t.ms !== 500);
    for (const t of due) t.cancelled = true;
    for (const t of due) t.fn();
    await settle();
    return due.map((t) => t.ms);
  };
  return { io, calls, timers, retry, tick: (ms: number) => (clock += ms) };
}

/** Let promises and immediates run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

function samplePayload(over: Partial<ProjectEventPayload> = {}): ProjectEventPayload {
  return {
    id: "e1",
    source: "ruri",
    kind: "project.idle",
    project: { id: "p1", name: "Una", path: "/tmp/una" },
    chats: [],
    costUsd: 0,
    at: new Date(1_000_000).toISOString(),
    ...over,
  };
}

describe("which hooks an event goes to", () => {
  test("with nothing set, midna's command when midna is here, and nothing when it isn't", () => {
    const here = new HookCenter(fakeWorld({ midna: "/u/.local/bin/midna" }).io, () => {}, files());
    expect(here.targets("p1")).toEqual([{ scope: "global", target: "command", to: MIDNA_COMMAND }]);
    expect(here.view().global).toEqual({ command: MIDNA_COMMAND, url: "", hasToken: false, custom: false });
    expect(here.view().midna).toBe("/u/.local/bin/midna");
    const away = new HookCenter(fakeWorld({ midna: null }).io, () => {}, files());
    expect(away.targets("p1")).toEqual([]);
    expect(away.view().midna).toBeNull();
  });

  test("the user's global hooks replace the default; a project adds its own or turns them off", () => {
    const center = new HookCenter(fakeWorld({ midna: "/m/midna" }).io, () => {}, files());
    center.set({ command: "", url: "https://hooks.example/ruri", token: "s3cret" });
    expect(center.targets()).toEqual([
      { scope: "global", target: "webhook", to: "https://hooks.example/ruri", token: "s3cret" },
    ]);
    center.set({ projectId: "p1", command: "notify-send done" });
    expect(center.targets("p1").map((t) => `${t.scope} ${t.target}`)).toEqual([
      "global webhook",
      "project command",
    ]);
    center.set({ projectId: "p1", useGlobal: false });
    expect(center.targets("p1")).toEqual([{ scope: "project", target: "command", to: "notify-send done" }]);
    // another project still gets the global ones
    expect(center.targets("p2").map((t) => t.scope)).toEqual(["global"]);
  });

  test("the same command in both goes once", () => {
    const center = new HookCenter(fakeWorld().io, () => {}, files());
    center.set({ command: "cat" });
    center.set({ projectId: "p1", command: "cat" });
    expect(center.targets("p1")).toEqual([{ scope: "global", target: "command", to: "cat" }]);
  });

  test("the first change to the default keeps what the default was", () => {
    const center = new HookCenter(fakeWorld({ midna: "/m/midna" }).io, () => {}, files());
    center.set({ url: "http://127.0.0.1:9/h" });
    expect(center.view().global).toMatchObject({
      command: MIDNA_COMMAND,
      url: "http://127.0.0.1:9/h",
      custom: true,
    });
    center.set({ reset: true });
    expect(center.view().global.custom).toBe(false);
    expect(center.view().global.url).toBe("");
  });
});

describe("changing the hooks", () => {
  test("a token is kept but never shown; '' clears it; a field left out stays", () => {
    const center = new HookCenter(fakeWorld().io, () => {}, files());
    center.set({ url: "http://127.0.0.1:9/h", token: "s3cret" });
    const shown = JSON.stringify(center.view());
    expect(shown).not.toContain("s3cret");
    expect(center.view().global.hasToken).toBe(true);
    center.set({ command: "cat" });
    expect(center.view().global).toEqual({
      command: "cat",
      url: "http://127.0.0.1:9/h",
      hasToken: true,
      custom: true,
    });
    center.set({ token: "" });
    expect(center.view().global.hasToken).toBe(false);
  });

  test("a URL that isn't http(s) is refused and nothing changes", () => {
    let heard = 0;
    const center = new HookCenter(fakeWorld().io, () => heard++, files());
    expect(center.set({ url: "file:///etc/passwd" })).toContain("Not a webhook URL");
    expect(center.set({ url: "not a url" })).toContain("Not a webhook URL");
    expect(center.view().global.custom).toBe(false);
    expect(heard).toBe(0);
  });

  test("a project back to nothing of its own is dropped; reset takes its own away", () => {
    const center = new HookCenter(fakeWorld().io, () => {}, files());
    center.set({ projectId: "p1", command: "cat", useGlobal: false });
    expect(center.view().projects["p1"]).toEqual({
      command: "cat",
      url: "",
      hasToken: false,
      useGlobal: false,
    });
    center.set({ projectId: "p1", command: "", useGlobal: true });
    expect(center.view().projects["p1"]).toBeUndefined();
    center.set({ projectId: "p1", url: "http://x.test/h" });
    center.set({ projectId: "p1", reset: true });
    expect(center.view().projects["p1"]).toBeUndefined();
  });

  test("the view leaves out projects no longer open", () => {
    const center = new HookCenter(fakeWorld().io, () => {}, files());
    center.set({ projectId: "gone", command: "cat" });
    center.set({ projectId: "p1", command: "cat" });
    expect(Object.keys(center.view(new Set(["p1"])).projects)).toEqual(["p1"]);
  });

  test("they outlive a restart, in a file only the user can read", () => {
    const first = new HookCenter(fakeWorld().io, () => {}, files());
    first.set({ url: "http://127.0.0.1:9/h", token: "s3cret" });
    first.set({ projectId: "p1", command: "cat", useGlobal: false });
    expect(fs.statSync(files().config).mode & 0o777).toBe(0o600);
    const again = new HookCenter(fakeWorld().io, () => {}, files());
    expect(again.targets("p1")).toEqual([{ scope: "project", target: "command", to: "cat" }]);
    expect(again.targets()[0]?.token).toBe("s3cret");
  });
});

describe("delivering", () => {
  test("a command gets the event as one line of JSON on stdin, and the title in its environment", async () => {
    const world = fakeWorld();
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ command: "cat" });
    const [delivery] = center.deliver(samplePayload(), center.targets(), dir);
    expect(delivery?.state).toBe("pending");
    await settle();
    expect(world.calls).toHaveLength(1);
    const call = world.calls[0]!;
    expect(call.input.endsWith("\n")).toBe(true);
    expect(JSON.parse(call.input)).toEqual(samplePayload());
    expect(call.env?.["RURI_EVENT_TITLE"]).toBe("Una is idle");
    expect(call.env?.["RURI_EVENT_KIND"]).toBe("project.idle");
    expect(call.env?.["RURI_PROJECT_PATH"]).toBe("/tmp/una");
    const [shown] = center.view().deliveries;
    expect(shown?.state).toBe("ok");
    expect(shown?.attempts).toBe(1);
    expect(shown?.result).toBe("exit 0");
  });

  test("midna's own folder is first on the command's PATH", async () => {
    const world = fakeWorld({ midna: "/opt/midna-here/midna" });
    const center = new HookCenter(world.io, () => {}, files());
    center.deliver(samplePayload(), center.targets(), dir);
    await settle();
    expect(world.calls[0]?.to).toBe(MIDNA_COMMAND);
    expect(world.calls[0]?.env?.["PATH"]?.split(path.delimiter)[0]).toBe("/opt/midna-here");
  });

  test("a webhook gets the same JSON and the bearer token", async () => {
    const world = fakeWorld();
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ url: "http://127.0.0.1:9/h", token: "s3cret" });
    center.deliver(samplePayload({ kind: "project.blocked" }), center.targets(), dir);
    await settle();
    expect(world.calls[0]).toMatchObject({ kind: "webhook", to: "http://127.0.0.1:9/h", token: "s3cret" });
    expect(JSON.parse(world.calls[0]!.input).kind).toBe("project.blocked");
  });

  test("a failing hook is tried again at 5s, 30s, 2m and 10m, then given up — and nothing waits on it", async () => {
    const fail: Attempt = { ok: false, retry: true, result: "exit 1: midna is not running" };
    const world = fakeWorld({ answers: [fail, fail, fail, fail, fail] });
    let heard = 0;
    const center = new HookCenter(world.io, () => heard++, files());
    center.set({ command: "midna-down" });
    // deliver returns before the first try has even run
    const [delivery] = center.deliver(samplePayload(), center.targets(), dir);
    expect(delivery?.attempts).toBe(0);
    await settle();
    expect(center.view().deliveries[0]).toMatchObject({
      state: "retrying",
      attempts: 1,
      result: fail.result,
    });
    expect(center.view().deliveries[0]?.nextAt).toBe(1_000_000 + 5_000);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) waits.push(...(await world.retry()));
    expect(waits).toEqual([5_000, 30_000, 120_000, 600_000]);
    expect(world.calls).toHaveLength(5);
    expect(center.view().deliveries[0]).toMatchObject({ state: "failed", attempts: 5 });
    expect(center.view().deliveries[0]?.nextAt).toBeUndefined();
    expect(heard).toBeGreaterThan(5);
  });

  test("one that comes good on a retry is ok", async () => {
    const world = fakeWorld({ answers: [{ ok: false, retry: true, result: "HTTP 503" }] });
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ url: "http://127.0.0.1:9/h" });
    center.deliver(samplePayload(), center.targets(), dir);
    await settle();
    await world.retry();
    expect(center.view().deliveries[0]).toMatchObject({ state: "ok", attempts: 2, result: "HTTP 200" });
  });

  test("a failure trying again won't fix is given up at once", async () => {
    const world = fakeWorld({ answers: [{ ok: false, retry: false, result: "HTTP 404" }] });
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ url: "http://127.0.0.1:9/h" });
    center.deliver(samplePayload(), center.targets(), dir);
    await settle();
    expect(center.view().deliveries[0]).toMatchObject({ state: "failed", attempts: 1 });
    expect(await world.retry()).toEqual([]);
  });

  test("each hook is delivered on its own: one failing doesn't hold the other", async () => {
    const world = fakeWorld({ answers: [{ ok: false, retry: true, result: "exit 1" }] });
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ command: "broken", url: "http://127.0.0.1:9/h" });
    center.deliver(samplePayload(), center.targets(), dir);
    await settle();
    const states = Object.fromEntries(center.view().deliveries.map((d) => [d.target, d.state]));
    expect(states).toEqual({ command: "retrying", webhook: "ok" });
  });

  test("closing stops the retries", async () => {
    const world = fakeWorld({ answers: [{ ok: false, retry: true, result: "exit 1" }] });
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ command: "broken" });
    center.deliver(samplePayload(), center.targets(), dir);
    await settle();
    center.close();
    await world.retry();
    expect(world.calls).toHaveLength(1);
  });

  test("the newest 50 are kept, and one still going when ruri closed reads as failed after", async () => {
    const world = fakeWorld({ answers: [{ ok: false, retry: true, result: "exit 1" }] });
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ command: "cat" });
    for (let i = 0; i < 60; i++) center.deliver(samplePayload({ id: `e${i}` }), center.targets(), dir);
    await settle();
    expect(center.view().deliveries).toHaveLength(50);
    expect(center.view().deliveries[0]?.eventId).toBe("e59");
    // the first one is still retrying: it is kept however old it is
    expect(center.view().deliveries.some((d) => d.eventId === "e0")).toBe(true);
    center.close();
    const again = new HookCenter(fakeWorld().io, () => {}, files());
    const first = again.view().deliveries.find((d) => d.eventId === "e0");
    expect(first).toMatchObject({ state: "failed", result: "ruri closed before it went" });
  });
});

describe("the real world", () => {
  test("a command reads stdin, sees the event's variables, and runs in the folder it is given", async () => {
    const out = path.join(dir, "got.txt");
    const attempt = await realIo.runCommand(
      `cat > "${out}"; printf '%s|%s' "$RURI_EVENT_TITLE" "$PWD" >> "${out}"`,
      '{"a":1}\n',
      { cwd: dir, env: { ...process.env, RURI_EVENT_TITLE: 'Una "is" idle; rm -rf /' }, timeoutMs: 5_000 },
    );
    expect(attempt).toEqual({ ok: true, retry: false, result: "exit 0" });
    expect(fs.readFileSync(out, "utf8")).toBe(`{"a":1}\nUna "is" idle; rm -rf /|${fs.realpathSync(dir)}`);
  });

  test("a command that hangs is stopped at its timeout, with what it started", async () => {
    const started = Date.now();
    const attempt = await realIo.runCommand("sleep 30 & sleep 30", "", {
      cwd: dir,
      env: process.env,
      timeoutMs: 300,
    });
    expect(attempt).toEqual({ ok: false, retry: true, result: "timed out after 0s" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a failing command says how, and one the shell can't find isn't retried", async () => {
    const failed = await realIo.runCommand("echo nope >&2; exit 3", "", {
      cwd: dir,
      env: process.env,
      timeoutMs: 5_000,
    });
    expect(failed).toEqual({ ok: false, retry: true, result: "exit 3: nope" });
    const missing = await realIo.runCommand("definitely-not-a-command-ruri", "", {
      cwd: dir,
      env: process.env,
      timeoutMs: 5_000,
    });
    expect(missing.retry).toBe(false);
    expect(missing.result).toStartWith("exit 127");
  });

  test("a command that ignores its stdin is fine", async () => {
    const attempt = await realIo.runCommand("true", "x".repeat(1_000_000), {
      cwd: dir,
      env: process.env,
      timeoutMs: 5_000,
    });
    expect(attempt.ok).toBe(true);
  });

  describe("webhooks", () => {
    let server: http.Server;
    let base: string;
    const got: Array<{ url: string; auth?: string; type?: string; body: string }> = [];
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          got.push({
            url: req.url ?? "",
            ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
            ...(req.headers["content-type"] ? { type: req.headers["content-type"] } : {}),
            body,
          });
          const status = Number((req.url ?? "").split("/").pop()) || 200;
          if (status === 999) return; // never answers
          res.writeHead(status).end(status >= 400 ? "down for a bit" : "ok");
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => {
      server.closeAllConnections();
      server.close();
    });

    test("POSTs the JSON with the bearer token", async () => {
      expect(await realIo.post(`${base}/hook/200`, '{"a":1}', "s3cret", 5_000)).toEqual({
        ok: true,
        retry: false,
        result: "HTTP 200",
      });
      expect(got.at(-1)).toEqual({
        url: "/hook/200",
        auth: "Bearer s3cret",
        type: "application/json",
        body: '{"a":1}',
      });
      await realIo.post(`${base}/hook/204`, "{}", undefined, 5_000);
      expect(got.at(-1)?.auth).toBeUndefined();
    });

    test("a 5xx or 429 is tried again, a 404 isn't, and a dead port or a silent one is", async () => {
      expect(await realIo.post(`${base}/hook/503`, "{}", undefined, 5_000)).toEqual({
        ok: false,
        retry: true,
        result: "HTTP 503: down for a bit",
      });
      expect((await realIo.post(`${base}/hook/429`, "{}", undefined, 5_000)).retry).toBe(true);
      expect((await realIo.post(`${base}/hook/404`, "{}", undefined, 5_000)).retry).toBe(false);
      const dead = await realIo.post("http://127.0.0.1:9/hook", "{}", undefined, 5_000);
      expect(dead.ok).toBe(false);
      expect(dead.retry).toBe(true);
      const silent = await realIo.post(`${base}/hook/999`, "{}", undefined, 300);
      expect(silent).toEqual({ ok: false, retry: true, result: "timed out after 0s" });
    });
  });
});

/* ── the payload, on a server made of just what it reads ───────────── */

function fakeCtx(
  projects: Project[],
  events: Record<string, TranscriptEvent[]>,
  options: { ledger?: () => number; cards?: PermissionRequest[] } = {},
) {
  const broadcasts: unknown[] = [];
  const ctx = {
    store: {
      get: (id: string) => projects.find((p) => p.id === id),
      list: () => projects,
      findSession: (id: string) => {
        for (const project of projects) {
          const session = project.sessions.find((s) => s.id === id);
          if (session) return { project, session };
        }
        return undefined;
      },
    },
    archive: {
      events: (id: string) => events[id] ?? [],
      hasHistory: () => false,
      allEvents: (id: string) => events[id] ?? [],
    },
    ledger: { stats: () => ({ total: { costUsd: options.ledger?.() ?? 0 } }) },
    permissions: new Map((options.cards ?? []).map((card) => [card.requestId, card])),
    clients: { broadcast: (message: unknown) => broadcasts.push(message) },
  } as unknown as ServerContext;
  return { ctx, broadcasts };
}

const team: Project = {
  id: "p1",
  name: "Una",
  path: "/tmp/una",
  sessions: [
    { id: "lead", title: "Lead", lead: true },
    { id: "liaison", title: "Liaison", liaison: true },
    { id: "ui", title: "Interface", duty: "the UI" },
    { id: "db", title: "Database", duty: "the schema" },
  ],
};

const said = (id: string, text: string, ts: number): TranscriptEvent => ({ kind: "assistant", id, text, ts });
const spent = (id: string, costUsd: number, ts: number): TranscriptEvent => ({
  kind: "result",
  id,
  ok: true,
  costUsd,
  ts,
});

describe("the payload", () => {
  test("has exactly the fields midna reads, and no others", () => {
    const { ctx } = fakeCtx([team], { lead: [said("a", "Done.", 200)] });
    const payload = buildPayload(ctx, "project.idle", team, {
      busySince: 100,
      costUsd: 1.25,
      at: Date.UTC(2026, 9, 19),
    });
    expect(Object.keys(payload).sort()).toEqual([
      "at",
      "chats",
      "costUsd",
      "id",
      "kind",
      "project",
      "source",
    ]);
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.source).toBe("ruri");
    expect(payload.kind).toBe("project.idle");
    expect(payload.project).toEqual({ id: "p1", name: "Una", path: "/tmp/una" });
    expect(payload.at).toBe("2026-10-19T00:00:00.000Z");
    expect(payload.costUsd).toBe(1.25);
    for (const chat of payload.chats)
      expect(Object.keys(chat).sort()).toEqual(["id", "lastSummary", "name", "role"]);
  });

  test("names the lead always, and the others only if they worked since the team went busy", () => {
    const { ctx } = fakeCtx([team], {
      lead: [said("a", "Handed the UI to Interface.", 50)],
      ui: [said("b", "Old news.", 10), said("c", "The panel is built.", 150)],
      db: [said("d", "Last week's schema change.", 20)],
      liaison: [said("e", "Passed midna's job on.", 120)],
    });
    const payload = buildPayload(ctx, "project.idle", team, { busySince: 100, costUsd: 0 });
    expect(payload.chats).toEqual([
      { id: "lead", name: "Lead", role: "lead", lastSummary: "Handed the UI to Interface." },
      { id: "liaison", name: "Liaison", role: "liaison", lastSummary: "Passed midna's job on." },
      { id: "ui", name: "Interface", role: "teammate", lastSummary: "The panel is built." },
    ]);
  });

  test("a blocked event's waiting chat comes first, saying what its card asks", () => {
    const card: PermissionRequest = {
      requestId: "r1",
      projectId: "db",
      toolName: "AskUserQuestion",
      kind: "question",
      input: {
        questions: [{ question: "Drop the old table?", header: "Schema", options: [], multiSelect: false }],
      },
      ts: 300,
    };
    const { ctx } = fakeCtx(
      [team],
      { lead: [said("a", "On it.", 150)], db: [said("d", "Before I go on:", 250)] },
      { cards: [card] },
    );
    const payload = buildPayload(ctx, "project.blocked", team, { busySince: 100, costUsd: 0, chatId: "db" });
    expect(payload.chats.map((c) => c.id)).toEqual(["db", "lead"]);
    expect(payload.chats[0]?.lastSummary).toBe("Asks: Drop the old table?");
  });

  test("an approval card says the tool and what it would run", () => {
    const card: PermissionRequest = {
      requestId: "r2",
      projectId: "ui",
      toolName: "Bash",
      input: { command: "rm -rf dist" },
      ts: 300,
    };
    const { ctx } = fakeCtx([team], {}, { cards: [card] });
    const payload = buildPayload(ctx, "project.blocked", team, { busySince: 100, costUsd: 0, chatId: "ui" });
    expect(payload.chats[0]).toEqual({
      id: "ui",
      name: "Interface",
      role: "teammate",
      lastSummary: "Waiting on approval: Bash rm -rf dist",
    });
  });

  test("a test event names every chat", () => {
    const { ctx } = fakeCtx([team], {});
    expect(buildPayload(ctx, "project.test", team, { costUsd: 0 }).chats.map((c) => c.role)).toEqual([
      "lead",
      "liaison",
      "teammate",
      "teammate",
    ]);
  });

  test("lastSummary is trimmed to about 600 characters, at a word", () => {
    const long = `${"word ".repeat(200)}end`;
    const trimmed = trimSummary(long);
    expect(trimmed.length).toBeLessThanOrEqual(601);
    expect(trimmed.length).toBeGreaterThan(480);
    expect(trimmed.endsWith("word…")).toBe(true);
    expect(trimSummary("  short  ")).toBe("short");
    expect(trimSummary("x".repeat(700))).toBe(`${"x".repeat(600)}…`);
  });
});

describe("firing", () => {
  test("costUsd is what the ledger grew by since the team went busy — busy again in the same period changes nothing", async () => {
    let ledger = 10;
    const { ctx } = fakeCtx([team], { lead: [said("a", "Done.", 200)] }, { ledger: () => ledger });
    const world = fakeWorld();
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ command: "cat" });
    useHooks(ctx, center);
    projectBusy(ctx, "p1", 100);
    ledger = 12.5;
    projectBusy(ctx, "p1", 100);
    ledger = 13.75;
    fireProjectEvent(ctx, { kind: "project.idle", projectId: "p1", busySince: 100 });
    await settle();
    expect(world.calls).toHaveLength(1);
    const payload = JSON.parse(world.calls[0]!.input) as ProjectEventPayload;
    expect(payload.costUsd).toBe(3.75);
    expect(payload.kind).toBe("project.idle");
  });

  test("without having seen the team go busy, costUsd adds up its chats' turns since", async () => {
    const { ctx } = fakeCtx([team], {
      lead: [spent("r0", 9, 50), said("a", "Done.", 200), spent("r1", 0.5, 210)],
      ui: [spent("r2", 0.25, 180)],
    });
    const world = fakeWorld();
    const center = new HookCenter(world.io, () => {}, files());
    center.set({ command: "cat" });
    useHooks(ctx, center);
    fireProjectEvent(ctx, { kind: "project.idle", projectId: "p1", busySince: 100 });
    await settle();
    expect((JSON.parse(world.calls[0]!.input) as ProjectEventPayload).costUsd).toBe(0.75);
  });

  test("a project with no hooks, an unknown one, or Home sends nothing", async () => {
    const { ctx } = fakeCtx([team], {});
    const world = fakeWorld({ midna: null });
    useHooks(ctx, new HookCenter(world.io, () => {}, files()));
    fireProjectEvent(ctx, { kind: "project.idle", projectId: "p1", busySince: 100 });
    fireProjectEvent(ctx, { kind: "project.idle", projectId: "home", busySince: 100 });
    await settle();
    expect(world.calls).toHaveLength(0);
  });

  test("every window hears the deliveries as they go", async () => {
    const { ctx, broadcasts } = fakeCtx([team], {});
    const world = fakeWorld();
    const center = new HookCenter(world.io, () => ctx.clients.broadcast({ type: "hooks" } as never), files());
    center.set({ command: "cat" });
    useHooks(ctx, center);
    broadcasts.length = 0;
    fireProjectEvent(ctx, { kind: "project.blocked", projectId: "p1", busySince: 100, chatId: "ui" });
    await settle();
    expect(broadcasts.length).toBeGreaterThanOrEqual(2);
  });

  test("the test button sends project.test to the project's hooks, or says why it can't", async () => {
    const { ctx } = fakeCtx([team], {});
    const world = fakeWorld({ midna: null });
    const center = new HookCenter(world.io, () => {}, files());
    useHooks(ctx, center);
    expect(sendTestEvent(ctx)).toContain("no global hooks");
    expect(sendTestEvent(ctx, "p1")).toContain("Una's events go nowhere");
    expect(sendTestEvent(ctx, "nope")).toContain("isn't open");
    center.set({ projectId: "p1", url: "http://127.0.0.1:9/h" });
    // a chat's id stands for its project
    expect(sendTestEvent(ctx, "ui")).toBeUndefined();
    await settle();
    const payload = JSON.parse(world.calls[0]!.input) as ProjectEventPayload;
    expect(payload.kind).toBe("project.test");
    expect(payload.project.id).toBe("p1");
    expect(payload.costUsd).toBe(0);
  });
});
