/**
 * A chat's conversation for the phone, and the phone's prompts into it
 * (docs/mobile-app.md). Only a key scoped "phone" reaches these, through
 * sharing's door (server/sharing.ts), or the token on this port.
 *
 *   GET  /chat?id=<chat>        the chat's recent conversation, once
 *   GET  /chat/live?id=<chat>   the same as server-sent events: a whole
 *                               frame on connect, then what changed
 *   POST /chat/send             { id, text, clientId } → where it went
 *
 * What the phone is shown is what the user reads in the web app: their
 * prompts and the replies in full, tool calls folded into one line of
 * steps, and a note where a turn stopped. No costs, tokens or models.
 *
 * A reconnecting phone is sent the whole recent conversation again, so
 * nothing it missed while away is lost. A prompt is sent the way the web
 * app sends one (the `send` handler), under the phone's own id for it —
 * sent twice, after a dropped line, it is answered rather than run again.
 */
import type * as http from "node:http";
import { WebSocket } from "ws";
import {
  CARRY_ON,
  type PhoneChatFrame,
  type PhoneChatItem,
  type PhoneSent,
  type TranscriptEvent,
} from "../shared/protocol.js";
import { channelProject } from "./channel.js";
import type { ClientConn, ServerContext } from "./context.js";
import { promptHandlers } from "./handlers/prompts.js";
import { warn } from "./log.js";
import { readBody } from "./sharing.js";

/** How many things said the phone is given — the screen's worth and more. */
const ITEMS_MAX = 150;
/** A reply longer than this is cut, with a word that it was. */
const TEXT_MAX = 24_000;
/** A step's summary, on one line. */
const STEP_CHARS = 140;
/** How often a watched chat is read again — a reply being written shows
 *  at about this pace. */
export const CHAT_READ_MS = 700;
/** How often a quiet line is told it is still open. */
const PING_MS = 25_000;
/** The longest prompt the phone may send. */
const PROMPT_MAX = 100_000;

const CHAT_PATHS = new Set(["/chat", "/chat/live", "/chat/send"]);

/** Whether a request is for a chat, the phone's way. */
export function isPhoneChatPath(pathname: string): boolean {
  return CHAT_PATHS.has(pathname);
}

const iso = (ts: number) => new Date(ts).toISOString();

const cut = (text: string) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n\n… (cut short)` : text);

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > STEP_CHARS ? `${flat.slice(0, STEP_CHARS - 1)}…` : flat;
};

/** ruri's own prompts — carrying on after a compaction, back to work
 *  after a cut-in — are not the user's. */
const ruris = (text: string) => text.startsWith(CARRY_ON) || /^[↩↪↻]/.test(text);

/** A chat's transcript as the phone shows it: what was said, tool calls
 *  between two things said folded into one line of steps. */
export function phoneItems(events: TranscriptEvent[], draft?: { id: string; text: string }): PhoneChatItem[] {
  const items: PhoneChatItem[] = [];
  let steps: PhoneChatItem | undefined;
  const fold = () => {
    if (steps) steps.text = `${steps.steps!.length} ${steps.steps!.length === 1 ? "step" : "steps"}`;
    steps = undefined;
  };
  for (const event of events) {
    if (event.kind === "tool") {
      if (!steps) items.push((steps = { id: event.id, kind: "steps", text: "", steps: [], at: iso(event.ts) }));
      steps.steps!.push(oneLine(event.summary ? `${event.name}: ${event.summary}` : event.name));
      continue;
    }
    if (event.kind === "user") {
      if (ruris(event.text) || !event.text.trim()) continue;
      fold();
      items.push({
        id: event.id,
        kind: "user",
        text: cut(event.text),
        ...(event.from ? { from: event.from.title || event.from.project } : {}),
        at: iso(event.ts),
      });
    } else if (event.kind === "assistant") {
      if (!event.text.trim()) continue;
      fold();
      items.push({ id: event.id, kind: "assistant", text: cut(event.text), at: iso(event.ts) });
    } else if (event.kind === "result" && !event.ok) {
      fold();
      const text = event.stopped ? "Stopped" : `Stopped on an error: ${oneLine(event.error || "an error")}`;
      items.push({ id: event.id, kind: "note", text, at: iso(event.ts) });
    }
  }
  fold();
  if (draft?.text.trim()) {
    items.push({ id: `draft:${draft.id}`, kind: "assistant", text: cut(draft.text), at: iso(Date.now()), pending: true });
  }
  return items.slice(-ITEMS_MAX);
}

/** The chat, whole, as a frame — or undefined for a chat that is not one. */
export function phoneFrame(ctx: ServerContext, chatId: string): PhoneChatFrame | undefined {
  const found = ctx.store.findSession(chatId);
  if (!found || found.project.hidden) return undefined;
  const { project, session } = found;
  const held = ctx.turns.gates.get(chatId);
  const draft = held?.shown ? { id: held.messageId, text: held.shown } : undefined;
  const status = ctx.manager.statuses()[chatId];
  const waiting = [...ctx.permissions.values()].some(
    (request) => request.projectId === chatId && request.kind !== "component",
  );
  const queue = (ctx.queues.entries.get(chatId) ?? [])
    .filter((entry) => !entry.silent && !entry.from)
    .map((entry) => ({ id: entry.id, text: cut(entry.text) }));
  return {
    chat: chatId,
    name: session.title || project.name,
    project: project.name,
    state: waiting || status === "permission" ? "needs-you" : status === "working" ? "working" : "idle",
    queue,
    items: phoneItems(ctx.archive.events(chatId), draft),
  };
}

/* ── the live line ─────────────────────────────────────────────────── */

interface Watcher {
  res: http.ServerResponse;
  chat: string;
  /** What it holds: each item's id and how it read, in order. */
  held: Map<string, string>;
  /** The rest of the frame it was last sent. */
  head: string;
  wrote: number;
}

/** What a frame says to a watcher that holds `held`: the whole list when
 *  the order changed, else what is new or changed and what is gone. */
export function nextFrame(
  frame: PhoneChatFrame,
  held: Map<string, string>,
): { send: PhoneChatFrame | undefined; held: Map<string, string> } {
  const items = frame.items ?? [];
  const now = new Map(items.map((item) => [item.id, JSON.stringify(item)]));
  const kept = [...held.keys()].filter((id) => now.has(id));
  const remove = [...held.keys()].filter((id) => !now.has(id));
  const order = items.map((item) => item.id);
  // still in the order the phone has them, with anything new after
  const inOrder = kept.every((id, i) => order[i] === id);
  const { items: _all, ...head } = frame;
  if (!inOrder || held.size === 0) return { send: frame, held: now };
  const upsert = items.filter((item) => held.get(item.id) !== now.get(item.id));
  if (upsert.length === 0 && remove.length === 0) return { send: undefined, held: now };
  return {
    send: { ...head, ...(upsert.length ? { upsert } : {}), ...(remove.length ? { remove } : {}) },
    held: now,
  };
}

/** Every phone watching a chat, read for together while there are any. */
export class PhoneChatStream {
  private readonly watchers = new Set<Watcher>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: ServerContext) {}

  get size(): number {
    return this.watchers.size;
  }

  add(res: http.ServerResponse, chat: string): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const watcher: Watcher = { res, chat, held: new Map(), head: "", wrote: 0 };
    this.watchers.add(watcher);
    res.on("close", () => {
      this.watchers.delete(watcher);
      if (this.watchers.size > 0) return;
      clearInterval(this.timer);
      this.timer = undefined;
    });
    this.send(watcher, new Map());
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), CHAT_READ_MS);
      this.timer.unref?.();
    }
  }

  tick(): void {
    const frames = new Map<string, PhoneChatFrame | undefined>();
    for (const watcher of [...this.watchers]) this.send(watcher, frames);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers) watcher.res.end();
    this.watchers.clear();
  }

  private send(watcher: Watcher, frames: Map<string, PhoneChatFrame | undefined>): void {
    const now = Date.now();
    try {
      if (!frames.has(watcher.chat)) frames.set(watcher.chat, phoneFrame(this.ctx, watcher.chat));
      const frame = frames.get(watcher.chat);
      if (!frame) {
        watcher.res.write(`event: gone\ndata: {}\n\n`);
        watcher.res.end();
        return;
      }
      const { items: _items, ...rest } = frame;
      const head = JSON.stringify(rest);
      const next = nextFrame(frame, watcher.held);
      watcher.held = next.held;
      const out = next.send ?? (head !== watcher.head ? rest : undefined);
      watcher.head = head;
      if (out) {
        watcher.wrote = now;
        watcher.res.write(`event: chat\ndata: ${JSON.stringify(out)}\n\n`);
      } else if (now - watcher.wrote >= PING_MS) {
        watcher.wrote = now;
        watcher.res.write(": still here\n\n");
      }
    } catch (err) {
      warn("phone", err, "chat frame");
    }
  }
}

const streams = new WeakMap<ServerContext, PhoneChatStream>();

export function phoneChatStream(ctx: ServerContext): PhoneChatStream {
  let stream = streams.get(ctx);
  if (!stream) streams.set(ctx, (stream = new PhoneChatStream(ctx)));
  return stream;
}

/* ── sending ───────────────────────────────────────────────────────── */

/** A prompt into a chat, the way the web app sends one; where it went. */
export async function phoneSend(
  ctx: ServerContext,
  chat: string,
  text: string,
  clientId: string,
): Promise<PhoneSent> {
  let as: PhoneSent["as"] | undefined;
  // the handler answers a window over its socket: here, a stand-in that
  // keeps the answer
  const answer = {
    readyState: WebSocket.OPEN,
    send(data: string) {
      const message = JSON.parse(data) as { type?: string; as?: PhoneSent["as"] };
      if (message.type === "sent") as = message.as;
    },
  } as unknown as ClientConn;
  try {
    await promptHandlers.send(ctx, answer, { type: "send", projectId: chat, text, clientId });
  } catch (err) {
    warn("phone", err, "send");
    return { as: "failed" };
  }
  // the answer comes a microtask after the prompt is taken
  await new Promise((resolve) => setImmediate(resolve));
  return { as: as ?? "other" };
}

/* ── over HTTP ─────────────────────────────────────────────────────── */

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Answer /chat, /chat/live or /chat/send; the caller has checked who is
 *  asking. */
export async function servePhoneChat(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/chat/send") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    let body: { id?: unknown; text?: unknown; clientId?: unknown };
    try {
      body = JSON.parse(await readBody(req, PROMPT_MAX * 4)) as typeof body;
    } catch {
      json(res, 400, { error: "bad request" });
      return;
    }
    const { id, text, clientId } = body;
    if (
      typeof id !== "string" ||
      typeof text !== "string" ||
      typeof clientId !== "string" ||
      !text.trim() ||
      text.length > PROMPT_MAX ||
      clientId.length === 0 ||
      clientId.length > 100
    ) {
      json(res, 400, { error: "send { id, text, clientId }" });
      return;
    }
    const found = ctx.store.findSession(id);
    if (!found || found.project.hidden || !channelProject(ctx, id)) {
      json(res, 404, { error: "no such chat" });
      return;
    }
    json(res, 200, await phoneSend(ctx, id, text, clientId));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  const chat = url.searchParams.get("id") ?? "";
  const frame = phoneFrame(ctx, chat);
  if (!frame) {
    json(res, 404, { error: "no such chat" });
    return;
  }
  if (url.pathname === "/chat/live" && req.method === "GET") {
    phoneChatStream(ctx).add(res, chat);
    return;
  }
  json(res, 200, frame);
}
