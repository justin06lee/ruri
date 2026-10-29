/**
 * Notifications on a paired iPhone: a project finished, or a chat needs
 * the user (docs/mobile-app.md). Awareness only — nothing to act on in the
 * notification; tapping it opens the project in the app.
 *
 * The phone hands its APNs token to this Mac (POST /phone/push, through
 * sharing's door with a key scoped "phone"), and its settings
 * (POST /phone/push/settings): which kinds it wants, and its quiet hours —
 * the nights ahead as times, worked out on the phone (it ends them at Fajr
 * where it is), and a fallback for when it hasn't said lately. A token it
 * already gave is no news: nothing is written, nothing happens — so a phone
 * that registers again and again can't make the Mac do anything again and
 * again; and a key may change its token only so often.
 *
 * The events are the ones midna hears (server/projectWatch.ts
 * onProjectEvent). Each goes straight to APNs over HTTP/2 from here, the
 * Mac being awake when its sessions finish, signed with the team's APNs key
 * (ES256). The key is read from ~/.local/share/ruri/apns — never the config
 * folder, never the secrets vault (every vault secret is in every agent's
 * shell) — and never logged. During quiet hours a notification arrives
 * silently, or is held for one summary at their end, as the phone chose.
 */
import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";
import { leadOf, type Project } from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import type { ServerContext } from "./context.js";
import { errorMessage, isMissing, warn } from "./log.js";
import { lastSummary, trimSummary } from "./projectHooks.js";
import { onProjectEvent, type ProjectEvent } from "./projectWatch.js";
import { readBody } from "./sharing.js";

/* ── the settings a phone keeps here ───────────────────────────────── */

export type PushEnv = "production" | "sandbox";
export type QuietMode = "silent" | "batch";

/** One night's quiet, epoch ms. */
export interface QuietWindow {
  start: number;
  end: number;
}

export interface PushSettings {
  /** A project's work finished. */
  finished: boolean;
  /** A chat waits on the user: a question, a card, an error. */
  needsInput: boolean;
  quiet: {
    on: boolean;
    mode: QuietMode;
    /** The nights ahead, as the phone worked them out. */
    windows: QuietWindow[];
    /** For when they have all gone by: from this minute of the day to that
     *  one, in this Mac's time. */
    startMinute: number;
    endMinute: number;
  };
}

/** Quiet from 21:30 until 05:30 — the phone moves the end to Fajr. */
export const DEFAULT_SETTINGS: PushSettings = {
  finished: true,
  needsInput: true,
  quiet: { on: true, mode: "silent", windows: [], startMinute: 21 * 60 + 30, endMinute: 5 * 60 + 30 },
};

/** What a batched night held, to be told at its end. */
interface Held {
  until: number;
  finished: string[];
  needs: string[];
}

interface PushDevice {
  token?: string;
  env: PushEnv;
  settings: PushSettings;
  /** When the token last changed, newest last, for the cap. */
  changes: number[];
  held?: Held;
}

interface Stored {
  devices: Record<string, PushDevice>;
}

/** Token changes a phone may make an hour. */
export const TOKEN_CHANGES_PER_HOUR = 10;
/** Nights a phone may send at once. */
const WINDOWS_MAX = 14;
/** The longest a night may be. */
const NIGHT_MAX_MS = 16 * 60 * 60_000;
/** How long after its last night the phone's word still stands — past the
 *  morning, short of the next evening. */
const NIGHTS_HOLD_MS = 12 * 60 * 60_000;
/** How long a notice is worth delivering for. */
const EXPIRES_S = 24 * 60 * 60;
/** How long a notification's line is. */
export const LINE_CHARS = 120;
/** How often held nights are looked at, to be told once they end. */
const FLUSH_EVERY_MS = 60_000;

/* ── what a notification says ──────────────────────────────────────── */

/** Markdown taken out, one line. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence of a reply, plain, at most LINE_CHARS. */
export function oneLine(markdown: string, max = LINE_CHARS): string {
  const plain = plainText(markdown);
  // a sentence ends at . ! ? followed by a space and something that starts
  // one — not "e.g. this", not "v0.7"
  const end = plain.search(/[.!?…](?=\s+["'“(]?[A-Z0-9])/);
  const first = end >= 0 ? plain.slice(0, end + 1) : plain;
  return trimSummary(first, max);
}

/* ── quiet hours ───────────────────────────────────────────────────── */

/** The end of the quiet `now` falls in, if it falls in one. */
export function quietUntil(settings: PushSettings, now: number): number | undefined {
  const { quiet } = settings;
  if (!quiet.on) return undefined;
  // the phone's nights, while one is ahead or the last ended this morning
  if (quiet.windows.some((w) => w.end > now - NIGHTS_HOLD_MS))
    return quiet.windows.find((w) => w.start <= now && now < w.end)?.end;
  // the phone hasn't said for the night to come: the fallback, by this
  // Mac's clock
  const day = new Date(now);
  const minute = day.getHours() * 60 + day.getMinutes();
  const { startMinute: start, endMinute: end } = quiet;
  const inside = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return undefined;
  const until = new Date(now);
  until.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (until.getTime() <= now) until.setDate(until.getDate() + 1);
  return until.getTime();
}

/** Settings as a phone sent them, checked; undefined if they aren't. */
export function readSettings(raw: unknown): PushSettings | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const body = raw as Record<string, unknown>;
  const quiet = body["quiet"] as Record<string, unknown> | undefined;
  if (typeof body["finished"] !== "boolean" || typeof body["needsInput"] !== "boolean") return undefined;
  if (!quiet || typeof quiet !== "object" || typeof quiet["on"] !== "boolean") return undefined;
  const mode = quiet["mode"];
  if (mode !== "silent" && mode !== "batch") return undefined;
  const minute = (v: unknown) =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1440 ? (v as number) : undefined;
  const startMinute = minute(quiet["startMinute"]);
  const endMinute = minute(quiet["endMinute"]);
  if (startMinute === undefined || endMinute === undefined) return undefined;
  const rawWindows = quiet["windows"];
  if (!Array.isArray(rawWindows) || rawWindows.length > WINDOWS_MAX) return undefined;
  const windows: QuietWindow[] = [];
  for (const w of rawWindows as unknown[]) {
    const { start, end } = (w ?? {}) as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number" || !(end > start) || end - start > NIGHT_MAX_MS)
      return undefined;
    windows.push({ start, end });
  }
  return {
    finished: body["finished"],
    needsInput: body["needsInput"],
    quiet: { on: quiet["on"], mode, windows, startMinute, endMinute },
  };
}

/* ── APNs ──────────────────────────────────────────────────────────── */

export interface ApnsTarget {
  token: string;
  env: PushEnv;
}

export interface ApnsMessage {
  payload: Record<string, unknown>;
  collapseId?: string;
  /** 10 at once, 5 when it can wait (a passive one). */
  priority: 5 | 10;
}

export type ApnsResult = { ok: true } | { ok: false; status: number; reason?: string };

export type ApnsSend = (target: ApnsTarget, message: ApnsMessage) => Promise<ApnsResult>;

export interface ApnsConfig {
  keyFile: string;
  keyId: string;
  teamId: string;
  topic: string;
  hosts: Record<PushEnv, string>;
}

/** The team's APNs key, where midna put it; RURI_APNS_* for a test. */
export function apnsConfig(env = process.env): ApnsConfig {
  return {
    keyFile:
      env["RURI_APNS_KEY_FILE"] ??
      path.join(os.homedir(), ".local", "share", "ruri", "apns", "AuthKey_699PDG8BFP.p8"),
    keyId: env["RURI_APNS_KEY_ID"] ?? "699PDG8BFP",
    teamId: env["RURI_APNS_TEAM_ID"] ?? "65UN46K6FA",
    topic: env["RURI_APNS_TOPIC"] ?? "com.justin06lee.ruri.phone",
    hosts: {
      production: env["RURI_APNS_HOST"] ?? "https://api.push.apple.com",
      sandbox: env["RURI_APNS_SANDBOX_HOST"] ?? env["RURI_APNS_HOST"] ?? "https://api.sandbox.push.apple.com",
    },
  };
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** The provider token APNs asks for: ES256 over the team and the time. */
export function apnsJwt(key: KeyObject, keyId: string, teamId: string, now = Date.now()): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
  const signature = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(signature)}`;
}

/** Talks to APNs over one HTTP/2 connection per host, kept open. */
export class Apns {
  private key: KeyObject | undefined;
  private jwt: { token: string; made: number } | undefined;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  private saidNoKey = false;

  constructor(private readonly config: ApnsConfig = apnsConfig()) {}

  /** Whether the key is there to sign with. */
  ready(): boolean {
    return this.signingKey() !== undefined;
  }

  private signingKey(): KeyObject | undefined {
    if (this.key) return this.key;
    try {
      this.key = createPrivateKey(fs.readFileSync(this.config.keyFile, "utf8"));
      return this.key;
    } catch (err) {
      if (!this.saidNoKey) {
        // where it was looked for, never what it holds
        warn("push", isMissing(err) ? "no APNs key" : errorMessage(err), this.config.keyFile);
        this.saidNoKey = true;
      }
      return undefined;
    }
  }

  /** The provider token, made again after 40 minutes (APNs takes one
   *  between 20 and 60 minutes old). */
  private token(key: KeyObject, fresh = false): string {
    const now = Date.now();
    if (fresh || !this.jwt || now - this.jwt.made > 40 * 60_000) {
      this.jwt = { token: apnsJwt(key, this.config.keyId, this.config.teamId, now), made: now };
    }
    return this.jwt.token;
  }

  private session(host: string): http2.ClientHttp2Session {
    const open = this.sessions.get(host);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(host);
    session.on("error", () => this.sessions.delete(host));
    session.on("goaway", () => this.sessions.delete(host));
    session.on("close", () => this.sessions.delete(host));
    session.setTimeout(10 * 60_000, () => session.close());
    session.unref();
    this.sessions.set(host, session);
    return session;
  }

  send: ApnsSend = async (target, message) => {
    const key = this.signingKey();
    if (!key) return { ok: false, status: 0, reason: "NoKey" };
    let answer = await this.post(key, target, message, false);
    // a token APNs calls stale is made again, once
    if (!answer.ok && answer.status === 403 && answer.reason === "ExpiredProviderToken")
      answer = await this.post(key, target, message, true);
    return answer;
  };

  private post(
    key: KeyObject,
    target: ApnsTarget,
    message: ApnsMessage,
    fresh: boolean,
  ): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let session: http2.ClientHttp2Session;
      try {
        session = this.session(this.config.hosts[target.env]);
      } catch (err) {
        resolve({ ok: false, status: 0, reason: errorMessage(err) });
        return;
      }
      const body = JSON.stringify(message.payload);
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${target.token}`,
        authorization: `bearer ${this.token(key, fresh)}`,
        "apns-topic": this.config.topic,
        "apns-push-type": "alert",
        "apns-priority": String(message.priority),
        "apns-expiration": String(Math.floor(Date.now() / 1000) + EXPIRES_S),
        ...(message.collapseId ? { "apns-collapse-id": message.collapseId } : {}),
        "content-type": "application/json",
      });
      let status = 0;
      let text = "";
      req.setEncoding("utf8");
      req.setTimeout(15_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      req.on("data", (chunk: string) => {
        text += chunk;
      });
      req.on("end", () => {
        if (status === 200) return resolve({ ok: true });
        let reason: string | undefined;
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason;
        } catch {
          // no body
        }
        resolve({ ok: false, status, ...(reason ? { reason } : {}) });
      });
      req.on("error", (err) => resolve({ ok: false, status, reason: errorMessage(err) }));
      req.on("close", () => resolve({ ok: false, status, reason: "closed" }));
      req.end(body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/* ── the phones ────────────────────────────────────────────────────── */

/** What a phone is told of a project. */
export interface Notice {
  kind: "finished" | "needs";
  projectId: string;
  project: string;
  chatId?: string;
  line: string;
}

/** A collapse id under APNs' 64 bytes. */
function collapseId(kind: string, projectId: string): string {
  const id = `${kind}:${projectId}`;
  return Buffer.byteLength(id) <= 64
    ? id
    : `${kind}:${createHash("sha256").update(projectId).digest("hex").slice(0, 40)}`;
}

/** The payload for one notice, loud or quiet. */
export function noticePayload(notice: Notice, quiet: boolean): ApnsMessage {
  return {
    payload: {
      aps: {
        alert: {
          title: notice.project,
          body: notice.line || (notice.kind === "finished" ? "Finished." : "Needs you."),
        },
        "thread-id": notice.project,
        "interruption-level": quiet ? "passive" : "active",
        ...(quiet ? {} : { sound: "default" }),
      },
      project: notice.project,
      projectId: notice.projectId,
      ...(notice.chatId ? { chat: notice.chatId } : {}),
      kind: notice.kind,
    },
    collapseId: collapseId(notice.kind, notice.projectId),
    priority: quiet ? 5 : 10,
  };
}

/** The one notice a batched night ends with. */
export function heldPayload(held: Held): ApnsMessage {
  const said: string[] = [];
  if (held.finished.length) said.push(`${held.finished.length} finished`);
  if (held.needs.length) said.push(`${held.needs.length} ${held.needs.length === 1 ? "needs" : "need"} you`);
  const names = [...new Set([...held.needs, ...held.finished])];
  const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? `, +${names.length - 4}` : "");
  return {
    payload: {
      aps: {
        alert: { title: "While you slept", body: `${said.join(", ")} · ${shown}` },
        "thread-id": "ruri.night",
        "interruption-level": "active",
      },
      kind: "night",
    },
    collapseId: "night",
    priority: 10,
  };
}

/** What the phones' side of things needs of the rest of the server. */
export interface PushDeps {
  send: ApnsSend;
  /** Whether a device is still paired with a key scoped "phone". */
  isPhone(deviceId: string): boolean;
  now?: () => number;
}

export class PhonePush {
  private readonly file: string;
  private stored: Stored;
  private readonly now: () => number;

  constructor(
    private readonly deps: PushDeps,
    // the folder is pinned when made: a put-off save can't land elsewhere
    file = configPath("phone-push.json"),
  ) {
    this.file = file;
    this.now = deps.now ?? Date.now;
    this.stored = this.read();
  }

  /** A phone's token. Answers whether it changed anything, or why not. */
  register(
    deviceId: string,
    token: unknown,
    env: unknown,
  ): { ok: true; changed: boolean } | { ok: false; status: number; error: string } {
    if (typeof token !== "string" || !/^[0-9a-f]{32,200}$/i.test(token))
      return { ok: false, status: 400, error: "send { token, env }" };
    if (env !== "production" && env !== "sandbox")
      return { ok: false, status: 400, error: "env is production or sandbox" };
    const device = this.stored.devices[deviceId];
    const clean = token.toLowerCase();
    // the token it already gave: nothing to do, nothing written
    if (device?.token === clean && device.env === env) return { ok: true, changed: false };
    const now = this.now();
    const changes = (device?.changes ?? []).filter((t) => now - t < 60 * 60_000);
    if (changes.length >= TOKEN_CHANGES_PER_HOUR)
      return {
        ok: false,
        status: 429,
        error: "This phone's token changed too often — try again in an hour.",
      };
    this.stored.devices[deviceId] = {
      ...(device ?? { settings: structuredClone(DEFAULT_SETTINGS) }),
      token: clean,
      env,
      changes: [...changes, now],
    };
    // one phone, one token: a phone paired again leaves its old pairing
    // here until it is removed, and it would hear everything twice
    for (const [id, other] of Object.entries(this.stored.devices)) {
      if (id !== deviceId && other.token === clean) delete other.token;
    }
    this.save();
    return { ok: true, changed: true };
  }

  /** A phone's settings, set. */
  configure(deviceId: string, settings: PushSettings): void {
    const device = this.stored.devices[deviceId];
    this.stored.devices[deviceId] = { ...(device ?? { env: "production", changes: [] }), settings };
    this.save();
  }

  settings(deviceId: string): PushSettings {
    return this.stored.devices[deviceId]?.settings ?? DEFAULT_SETTINGS;
  }

  registered(deviceId: string): boolean {
    return Boolean(this.stored.devices[deviceId]?.token);
  }

  /** A phone unpaired: it hears nothing more. */
  forget(deviceId: string): void {
    if (!(deviceId in this.stored.devices)) return;
    delete this.stored.devices[deviceId];
    this.save();
  }

  /** Tell every phone that wants it. */
  async tell(notice: Notice): Promise<void> {
    const now = this.now();
    const sends: Promise<void>[] = [];
    let held = false;
    for (const [deviceId, device] of Object.entries(this.stored.devices)) {
      if (!device.token) continue;
      if (!this.deps.isPhone(deviceId)) {
        this.forget(deviceId);
        continue;
      }
      const wanted = notice.kind === "finished" ? device.settings.finished : device.settings.needsInput;
      if (!wanted) continue;
      const until = quietUntil(device.settings, now);
      if (until !== undefined && device.settings.quiet.mode === "batch") {
        const night =
          device.held && device.held.until > now ? device.held : { until, finished: [], needs: [] };
        const list = notice.kind === "finished" ? night.finished : night.needs;
        if (!list.includes(notice.project)) list.push(notice.project);
        device.held = night;
        held = true;
        continue;
      }
      sends.push(this.deliver(deviceId, device, noticePayload(notice, until !== undefined)));
    }
    if (held) this.save();
    if (sends.length) console.log(`ruri: telling ${sends.length} phone(s): ${notice.project} ${notice.kind}`);
    await Promise.all(sends);
  }

  /** Tell each phone whose quiet night has ended what it held. */
  async flush(): Promise<void> {
    const now = this.now();
    const sends: Promise<void>[] = [];
    for (const [deviceId, device] of Object.entries(this.stored.devices)) {
      const held = device.held;
      if (!held || held.until > now) continue;
      delete device.held;
      this.save();
      if (device.token && (held.finished.length || held.needs.length) && this.deps.isPhone(deviceId))
        sends.push(this.deliver(deviceId, device, heldPayload(held)));
    }
    await Promise.all(sends);
  }

  private async deliver(deviceId: string, device: PushDevice, message: ApnsMessage): Promise<void> {
    const token = device.token;
    if (!token) return;
    const answer = await this.deps.send({ token, env: device.env }, message);
    if (answer.ok) return;
    // a token APNs no longer knows: the app is gone, or it has a new one,
    // which it will send
    const gone =
      answer.status === 410 ||
      (answer.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(answer.reason ?? ""));
    if (gone && this.stored.devices[deviceId]?.token === token) {
      delete this.stored.devices[deviceId]!.token;
      this.save();
    }
    if (answer.reason !== "NoKey")
      warn("push", `${answer.status} ${answer.reason ?? ""}`.trim(), `to ${deviceId}`);
  }

  private read(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Stored>;
      const devices: Record<string, PushDevice> = {};
      for (const [id, d] of Object.entries(raw.devices ?? {})) {
        const settings = readSettings(d?.settings) ?? structuredClone(DEFAULT_SETTINGS);
        devices[id] = {
          ...(typeof d?.token === "string" ? { token: d.token } : {}),
          env: d?.env === "sandbox" ? "sandbox" : "production",
          settings,
          changes: Array.isArray(d?.changes) ? d.changes.filter((t) => typeof t === "number") : [],
          ...(d?.held && typeof d.held.until === "number" ? { held: d.held } : {}),
        };
      }
      return { devices };
    } catch (err) {
      if (!isMissing(err)) warn("push", err, "reading phone-push.json");
      return { devices: {} };
    }
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, this.stored, 2, 0o600);
    } catch (err) {
      warn("push", err, "writing phone-push.json");
    }
  }
}

/* ── from a project's events ───────────────────────────────────────── */

/** What a phone is told of a project event; nothing for a hidden one. */
export function noticeFor(ctx: ServerContext, event: ProjectEvent): Notice | undefined {
  const project: Project | undefined = ctx.store.get(event.projectId);
  if (!project || project.hidden) return undefined;
  if (event.kind === "project.idle") {
    const lead = leadOf(project);
    const line = lead ? oneLine(lastSummary(ctx, lead.id, ctx.archive.events(lead.id))) : "";
    return { kind: "finished", projectId: project.id, project: project.name, line };
  }
  const said = lastSummary(ctx, event.chatId, ctx.archive.events(event.chatId), {
    reason: event.reason,
    ...(event.text ? { text: event.text } : {}),
  });
  // a question is the question; anything else, its first sentence
  const line =
    event.reason === "question" && event.text
      ? trimSummary(plainText(event.text), LINE_CHARS)
      : oneLine(said);
  return { kind: "needs", projectId: project.id, project: project.name, chatId: event.chatId, line };
}

const centers = new WeakMap<ServerContext, PhonePush>();

/** The server's phones, made the first time they are wanted. */
export function phonePushOf(ctx: ServerContext): PhonePush {
  let center = centers.get(ctx);
  if (!center) {
    const apns = new Apns();
    center = new PhonePush({
      send: apns.send,
      isPhone: (deviceId) => ctx.sharing.scopeOf(deviceId) === "phone",
    });
    centers.set(ctx, center);
  }
  return center;
}

/** For a test: the phones this server should use instead. */
export function usePhonePush(ctx: ServerContext, center: PhonePush): void {
  centers.set(ctx, center);
}

/** Tell the phones of every project event, and each held night at its
 *  end. The answer stops it. */
export function startPhonePush(ctx: ServerContext): () => void {
  const stop = onProjectEvent((event) => {
    if (!ctx.store.get(event.projectId)) return;
    // after the turn's last words are in the transcript
    setImmediate(() => {
      try {
        const notice = noticeFor(ctx, event);
        if (notice)
          void phonePushOf(ctx)
            .tell(notice)
            .catch((err: unknown) => warn("push", err, event.kind));
      } catch (err) {
        warn("push", err, event.kind);
      }
    });
  });
  const flushing = setInterval(() => {
    void phonePushOf(ctx)
      .flush()
      .catch((err: unknown) => warn("push", err, "a held night"));
  }, FLUSH_EVERY_MS);
  flushing.unref();
  return () => {
    stop();
    clearInterval(flushing);
  };
}

/* ── over HTTP, a phone's key only ─────────────────────────────────── */

const PUSH_PATHS = new Set(["/phone/push", "/phone/push/settings"]);

export function isPhonePushPath(pathname: string): boolean {
  return PUSH_PATHS.has(pathname);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 *   GET  /phone/push            { registered, settings }
 *   POST /phone/push            { token, env } → { ok, changed }
 *   POST /phone/push/settings   PushSettings → { ok }
 *
 * The caller has checked the key is a phone's, and says whose.
 */
export async function servePhonePush(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deviceId: string,
): Promise<void> {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const push = phonePushOf(ctx);
  if (req.method === "GET" && pathname === "/phone/push") {
    json(res, 200, { registered: push.registered(deviceId), settings: push.settings(deviceId) });
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { allow: pathname === "/phone/push" ? "GET, POST" : "POST" });
    res.end();
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, 8192));
  } catch {
    json(res, 400, { ok: false, error: "bad request" });
    return;
  }
  if (pathname === "/phone/push") {
    const { token, env } = (body ?? {}) as { token?: unknown; env?: unknown };
    const answer = push.register(deviceId, token, env);
    if (answer.ok) json(res, 200, answer);
    else json(res, answer.status, { ok: false, error: answer.error });
    return;
  }
  const settings = readSettings(body);
  if (!settings) {
    json(res, 400, { ok: false, error: "bad settings" });
    return;
  }
  push.configure(deviceId, settings);
  json(res, 200, { ok: true });
}
