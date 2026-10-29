import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import * as fs from "node:fs";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Project, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import {
  Apns,
  type ApnsMessage,
  type ApnsResult,
  type ApnsTarget,
  DEFAULT_SETTINGS,
  noticeFor,
  oneLine,
  PhonePush,
  type PushSettings,
  quietUntil,
  readSettings,
  TOKEN_CHANGES_PER_HOUR,
} from "./phonePush.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-push-"));
});

const TOKEN = "a".repeat(64);
const OTHER = "b".repeat(64);

/** A phone center whose APNs is a list, and whose clock is the test's. */
function phones(options: { answer?: ApnsResult; phone?: (id: string) => boolean } = {}) {
  const sent: Array<{ target: ApnsTarget; message: ApnsMessage }> = [];
  const clock = { now: new Date(2026, 9, 28, 14, 0).getTime() };
  const file = path.join(dir, "phone-push.json");
  const center = new PhonePush(
    {
      send: async (target, message) => {
        sent.push({ target, message });
        return options.answer ?? { ok: true };
      },
      isPhone: options.phone ?? (() => true),
      now: () => clock.now,
    },
    file,
  );
  return { center, sent, clock, file };
}

const aps = (message: ApnsMessage) => message.payload["aps"] as Record<string, unknown>;

const notice = (kind: "finished" | "needs" = "finished", project = "orchard") => ({
  kind,
  projectId: `id-${project}`,
  project,
  line: "Shipped the fix.",
});

/** Quiet on, tonight from 21:30 to 05:12 — by the test clock's day. */
function nights(mode: "silent" | "batch"): PushSettings {
  const start = new Date(2026, 9, 28, 21, 30).getTime();
  const end = new Date(2026, 9, 29, 5, 12).getTime();
  return { ...DEFAULT_SETTINGS, quiet: { ...DEFAULT_SETTINGS.quiet, mode, windows: [{ start, end }] } };
}

describe("registering a token", () => {
  test("the same token again changes nothing and writes nothing", () => {
    const { center, file } = phones();
    expect(center.register("d1", TOKEN, "production")).toEqual({ ok: true, changed: true });
    fs.rmSync(file);
    expect(center.register("d1", TOKEN, "production")).toEqual({ ok: true, changed: false });
    expect(center.register("d1", TOKEN.toUpperCase(), "production")).toEqual({ ok: true, changed: false });
    expect(fs.existsSync(file)).toBe(false);
  });

  test("a new token is kept, in a file only its owner reads", () => {
    const { center, file } = phones();
    center.register("d1", TOKEN, "production");
    expect(center.register("d1", OTHER, "sandbox")).toEqual({ ok: true, changed: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = new PhonePush({ send: async () => ({ ok: true }), isPhone: () => true }, file);
    expect(again.registered("d1")).toBe(true);
  });

  test("a phone paired again takes its token from the old pairing: it hears each thing once", async () => {
    const { center, sent } = phones();
    center.register("old", TOKEN, "production");
    center.register("new", TOKEN, "production");
    expect(center.registered("old")).toBe(false);
    await center.tell(notice());
    expect(sent).toHaveLength(1);
  });

  test(`a phone may change its token ${TOKEN_CHANGES_PER_HOUR} times an hour`, () => {
    const { center, clock } = phones();
    for (let i = 0; i < TOKEN_CHANGES_PER_HOUR; i++) {
      expect(center.register("d1", i.toString(16).padStart(64, "c"), "production").ok).toBe(true);
    }
    const refused = center.register("d1", OTHER, "production");
    expect(refused).toMatchObject({ ok: false, status: 429 });
    clock.now += 61 * 60_000;
    expect(center.register("d1", OTHER, "production").ok).toBe(true);
  });

  test("refuses what isn't a token", () => {
    const { center } = phones();
    expect(center.register("d1", "not hex", "production")).toMatchObject({ ok: false, status: 400 });
    expect(center.register("d1", TOKEN, "staging")).toMatchObject({ ok: false, status: 400 });
    expect(center.registered("d1")).toBe(false);
  });
});

describe("telling the phones", () => {
  test("outside quiet hours: loud, at once, threaded and collapsed by project", async () => {
    const { center, sent } = phones();
    center.register("d1", TOKEN, "sandbox");
    await center.tell(notice());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toEqual({ token: TOKEN, env: "sandbox" });
    expect(sent[0]!.message.priority).toBe(10);
    expect(sent[0]!.message.collapseId).toBe("finished:id-orchard");
    expect(aps(sent[0]!.message)).toEqual({
      alert: { title: "orchard", body: "Shipped the fix." },
      "thread-id": "orchard",
      "interruption-level": "active",
      sound: "default",
    });
    expect(sent[0]!.message.payload["projectId"]).toBe("id-orchard");
  });

  test("each kind can be turned off", async () => {
    const { center, sent } = phones();
    center.register("d1", TOKEN, "production");
    center.configure("d1", { ...DEFAULT_SETTINGS, finished: false });
    await center.tell(notice("finished"));
    expect(sent).toHaveLength(0);
    await center.tell(notice("needs"));
    expect(sent).toHaveLength(1);
    center.configure("d1", { ...DEFAULT_SETTINGS, needsInput: false });
    await center.tell(notice("needs"));
    expect(sent).toHaveLength(1);
  });

  test("quiet hours, silent: delivered passive, without a sound", async () => {
    const { center, sent, clock } = phones();
    center.register("d1", TOKEN, "production");
    center.configure("d1", nights("silent"));
    clock.now = new Date(2026, 9, 28, 23, 0).getTime();
    await center.tell(notice("needs"));
    expect(sent).toHaveLength(1);
    expect(aps(sent[0]!.message)["interruption-level"]).toBe("passive");
    expect(aps(sent[0]!.message)["sound"]).toBeUndefined();
    expect(sent[0]!.message.priority).toBe(5);
    // and after Fajr, loud again
    clock.now = new Date(2026, 9, 29, 5, 13).getTime();
    await center.tell(notice("needs"));
    expect(aps(sent[1]!.message)["interruption-level"]).toBe("active");
  });

  test("quiet hours, batch: held, then one summary when they end", async () => {
    const { center, sent, clock } = phones();
    center.register("d1", TOKEN, "production");
    center.configure("d1", nights("batch"));
    clock.now = new Date(2026, 9, 28, 22, 0).getTime();
    await center.tell(notice("finished", "orchard"));
    await center.tell(notice("finished", "jamo"));
    await center.tell(notice("finished", "orchard"));
    await center.tell(notice("needs", "una"));
    await center.flush();
    expect(sent).toHaveLength(0);
    clock.now = new Date(2026, 9, 29, 5, 12).getTime();
    await center.flush();
    expect(sent).toHaveLength(1);
    expect(aps(sent[0]!.message)["alert"]).toEqual({
      title: "While you slept",
      body: "2 finished, 1 needs you · una, orchard, jamo",
    });
    await center.flush();
    expect(sent).toHaveLength(1);
  });

  test("a held night survives a relaunch", async () => {
    const { center, clock, file } = phones();
    center.register("d1", TOKEN, "production");
    center.configure("d1", nights("batch"));
    clock.now = new Date(2026, 9, 28, 22, 0).getTime();
    await center.tell(notice("finished"));
    const sent: ApnsMessage[] = [];
    const later = new PhonePush(
      {
        send: async (_t, m) => (sent.push(m), { ok: true }),
        isPhone: () => true,
        now: () => new Date(2026, 9, 29, 6, 0).getTime(),
      },
      file,
    );
    await later.flush();
    expect(sent.map((m) => (aps(m)["alert"] as { body: string }).body)).toEqual(["1 finished · orchard"]);
  });

  test("a token APNs no longer knows is let go; an unpaired phone is forgotten", async () => {
    const gone = phones({ answer: { ok: false, status: 410, reason: "Unregistered" } });
    gone.center.register("d1", TOKEN, "production");
    await gone.center.tell(notice());
    expect(gone.center.registered("d1")).toBe(false);

    const unpaired = phones({ phone: () => false });
    unpaired.center.register("d1", TOKEN, "production");
    await unpaired.center.tell(notice());
    expect(unpaired.sent).toHaveLength(0);
    expect(unpaired.center.registered("d1")).toBe(false);
  });
});

describe("quiet hours", () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

  test("the phone's nights, when it has sent some still ahead", () => {
    const settings = nights("silent");
    expect(quietUntil(settings, at(28, 21, 29))).toBeUndefined();
    expect(quietUntil(settings, at(28, 21, 30))).toBe(at(29, 5, 12));
    expect(quietUntil(settings, at(29, 3))).toBe(at(29, 5, 12));
    expect(quietUntil(settings, at(29, 5, 12))).toBeUndefined();
    expect(quietUntil({ ...settings, quiet: { ...settings.quiet, on: false } }, at(29, 3))).toBeUndefined();
  });

  test("the fallback, 21:30 to 05:30 by the Mac's clock, once they have all gone by", () => {
    const settings = { ...DEFAULT_SETTINGS };
    expect(quietUntil(settings, at(28, 12))).toBeUndefined();
    expect(quietUntil(settings, at(28, 22))).toBe(at(29, 5, 30));
    expect(quietUntil(settings, at(29, 1))).toBe(at(29, 5, 30));
    expect(quietUntil(settings, at(29, 5, 30))).toBeUndefined();
    const stale = nights("silent");
    expect(quietUntil(stale, at(30, 23))).toBe(at(31, 5, 30));
  });

  test("settings from a phone are checked", () => {
    expect(readSettings(nights("batch"))).toEqual(nights("batch"));
    expect(readSettings({ ...DEFAULT_SETTINGS, finished: "yes" })).toBeUndefined();
    expect(
      readSettings({ ...DEFAULT_SETTINGS, quiet: { ...DEFAULT_SETTINGS.quiet, mode: "loud" } }),
    ).toBeUndefined();
    expect(
      readSettings({
        ...DEFAULT_SETTINGS,
        quiet: { ...DEFAULT_SETTINGS.quiet, windows: [{ start: 5, end: 1 }] },
      }),
    ).toBeUndefined();
    expect(
      readSettings({ ...DEFAULT_SETTINGS, quiet: { ...DEFAULT_SETTINGS.quiet, startMinute: 1440 } }),
    ).toBeUndefined();
  });
});

describe("the line", () => {
  test("the first sentence, markdown taken out", () => {
    expect(oneLine("**Done.** I merged `feat/x` into [master](http://x). Next, tests.")).toBe("Done.");
    expect(oneLine("## Fixed the build\n\n- one\n- two")).toBe("Fixed the build one two");
    expect(oneLine("Bumped to v0.7.2 and shipped it, e.g. the login fix. Then more.")).toBe(
      "Bumped to v0.7.2 and shipped it, e.g. the login fix.",
    );
    expect(oneLine("```ts\nconst x = 1;\n```\nAll good")).toBe("All good");
  });

  test("at most 120 characters, cut at a word", () => {
    const line = oneLine(`${"word ".repeat(60)}end.`);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("wor…");
  });

  test("from a project's events: the lead's reply, or what the chat waits on", () => {
    const project: Project = {
      id: "p1",
      name: "Una",
      path: "/tmp/una",
      sessions: [
        { id: "lead", title: "Lead", lead: true },
        { id: "ui", title: "Interface" },
      ],
    };
    const events: Record<string, TranscriptEvent[]> = {
      lead: [{ kind: "assistant", id: "a", text: "All **done**. Tests pass.", ts: 1 }],
      ui: [{ kind: "assistant", id: "b", text: "Which colour?", ts: 1 }],
    };
    const ctx = {
      store: { get: (id: string) => (id === "p1" ? project : undefined) },
      archive: { events: (id: string) => events[id] ?? [] },
      permissions: new Map(),
    } as unknown as ServerContext;
    expect(noticeFor(ctx, { kind: "project.idle", projectId: "p1", busySince: 0, at: 1 })).toEqual({
      kind: "finished",
      projectId: "p1",
      project: "Una",
      line: "All done.",
    });
    expect(
      noticeFor(ctx, {
        kind: "project.blocked",
        projectId: "p1",
        chatId: "ui",
        reason: "question",
        text: "Which **colour**, red or blue?",
        at: 1,
      }),
    ).toMatchObject({ kind: "needs", chatId: "ui", line: "Which colour, red or blue?" });
    expect(
      noticeFor(ctx, {
        kind: "project.blocked",
        projectId: "p1",
        chatId: "ui",
        reason: "error",
        text: "crashed",
        at: 1,
      }),
    ).toMatchObject({ line: "Stopped on an error: crashed" });
    expect(noticeFor(ctx, { kind: "project.idle", projectId: "gone", busySince: 0, at: 1 })).toBeUndefined();
  });
});

/* ── the sender, against a stand-in for APNs ───────────────────────── */

describe("APNs over HTTP/2", () => {
  let server: http2.Http2Server;
  let host: string;
  let keyFile: string;
  let publicKey: ReturnType<typeof createPublicKey>;
  const heard: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = [];
  let answer: { status: number; reason?: string } = { status: 200 };

  beforeAll(async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    publicKey = pair.publicKey;
    const keys = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-apns-"));
    keyFile = path.join(keys, "AuthKey_TEST.p8");
    fs.writeFileSync(keyFile, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    server = http2.createServer();
    server.on("stream", (stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => (body += chunk));
      stream.on("end", () => {
        heard.push({ headers, body });
        stream.respond({ ":status": answer.status, "apns-id": "x" });
        stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const apns = () =>
    new Apns({
      keyFile,
      keyId: "KEYID12345",
      teamId: "TEAM123456",
      topic: "com.justin06lee.ruri.phone",
      hosts: { production: host, sandbox: host },
    });

  test("posts the alert with a signed provider token, the topic and the push type", async () => {
    heard.length = 0;
    answer = { status: 200 };
    const sender = apns();
    const message: ApnsMessage = {
      payload: { aps: { alert: { title: "orchard", body: "Done." }, "interruption-level": "passive" } },
      collapseId: "finished:p1",
      priority: 5,
    };
    expect(await sender.send({ token: TOKEN, env: "production" }, message)).toEqual({ ok: true });
    sender.close();
    const { headers, body } = heard[0]!;
    expect(headers[":method"]).toBe("POST");
    expect(headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(headers["apns-topic"]).toBe("com.justin06lee.ruri.phone");
    expect(headers["apns-push-type"]).toBe("alert");
    expect(headers["apns-priority"]).toBe("5");
    expect(headers["apns-collapse-id"]).toBe("finished:p1");
    expect(JSON.parse(body)).toEqual(message.payload);
    const jwt = String(headers["authorization"]).replace(/^bearer /, "");
    const [head, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEYID12345",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ iss: "TEAM123456" });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  test("says why APNs refused", async () => {
    answer = { status: 410, reason: "Unregistered" };
    const sender = apns();
    expect(await sender.send({ token: TOKEN, env: "sandbox" }, { payload: {}, priority: 10 })).toEqual({
      ok: false,
      status: 410,
      reason: "Unregistered",
    });
    sender.close();
  });

  test("with no key, sends nothing", async () => {
    heard.length = 0;
    const sender = new Apns({
      keyFile: path.join(dir, "missing.p8"),
      keyId: "K",
      teamId: "T",
      topic: "t",
      hosts: { production: host, sandbox: host },
    });
    expect(sender.ready()).toBe(false);
    expect(
      await sender.send({ token: TOKEN, env: "production" }, { payload: {}, priority: 10 }),
    ).toMatchObject({
      ok: false,
      reason: "NoKey",
    });
    expect(heard).toHaveLength(0);
  });
});
