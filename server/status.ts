/**
 * Every project's state at a glance, for the user's phone (docs/mobile-app.md):
 * which are at work, at rest, stopped, or waiting on them; what each is doing
 * now; each chat's last words; and what needs them, across every project.
 *
 * GET /status answers it once; GET /status/live keeps answering, as
 * server-sent events — a frame on connect, another whenever the picture
 * changes, a comment now and then to keep the line open. Both take the
 * token on this computer's own port, and come in through sharing's door
 * (server/sharing.ts) with a paired device's key — never anything else.
 *
 * What it says is what the user would ask, not how ruri works: no
 * transcripts, tool calls, costs, tokens or models, and no ids unless
 * asked for (?ids=1). At work is ProjectWatch's own reading
 * (server/projectWatch.ts); each chat's last words are the hooks' (the
 * card it waits at, else its last reply — server/projectHooks.ts).
 */
import type * as http from "node:http";
import {
  CARRY_ON,
  type Project,
  type StatusChat,
  type StatusNeed,
  type StatusProject,
  type StatusReport,
  type StatusState,
  type TranscriptEvent,
} from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { warn } from "./log.js";
import { buildPayload, trimSummary } from "./projectHooks.js";
import { projectWatch } from "./projectWatch.js";
import { computerName } from "./sharing.js";

/** How much of a chat's last words the phone is given. */
const WORDS_CHARS = 280;
/** How much of what a chat is on. */
const DOING_CHARS = 120;
/** How often the live picture is read again, while anyone watches it. */
export const LIVE_READ_MS = 2_000;
/** How often a quiet line is told it is still open — well under what a
 *  proxy or the phone's own network gives up on an idle connection. */
export const LIVE_PING_MS = 25_000;

const ORDER: Record<StatusState, number> = { "needs-you": 0, blocked: 1, working: 2, idle: 3 };

function iso(ts: number | undefined): string | undefined {
  return ts === undefined ? undefined : new Date(ts).toISOString();
}

/** Words on one line, cut to fit. */
function line(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** ruri's own prompts — carrying on after a compaction, back to work after
 *  a message cut in, a stop's note — are not what a turn is on. */
function ruris(text: string): boolean {
  return text.startsWith(CARRY_ON) || /^[↩↪↻]/.test(text);
}

/** What a chat's turn is on: the prompt it began with, the user's or
 *  another agent's message — the last one that wasn't ruri's own. */
function onWhat(events: TranscriptEvent[]): string | undefined {
  const prompt = events.findLast((event) => event.kind === "user" && !ruris(event.text));
  return prompt?.kind === "user" && prompt.text.trim() ? line(prompt.text, DOING_CHARS) : undefined;
}

/** How a chat's last turn ended on an error, when it did. */
function lastError(events: TranscriptEvent[]): string | undefined {
  const ended = events.findLast((event) => event.kind === "result");
  return ended?.kind === "result" && !ended.ok && !ended.stopped ? ended.error || "an error" : undefined;
}

/** One project, and what in it waits on the user. */
function readProject(
  ctx: ServerContext,
  project: Project,
  ids: boolean,
  now: number,
): { project: StatusProject; needs: StatusNeed[]; lastActive: number } {
  const statuses = ctx.manager.statuses();
  const standing = projectWatch(ctx).standing(project);
  const asks = new Map(standing.asks.map((ask) => [ask.chatId, ask]));
  const cards = new Map<string, number>();
  for (const request of ctx.permissions.values()) {
    // naming a component waits on no one: the model goes on
    if (request.kind === "component") continue;
    const since = Math.min(request.ts || now, now);
    cards.set(request.projectId, Math.min(cards.get(request.projectId) ?? since, since));
  }
  // the hooks' reading of each chat: its role, and the card it waits at
  // or else its last reply
  const said = new Map(
    buildPayload(ctx, "project.test", project, { costUsd: 0, at: now }).chats.map((chat) => [chat.id, chat]),
  );
  const needs: StatusNeed[] = [];
  let lastActive = 0;
  let lead: StatusChat | undefined;
  const team: StatusChat[] = [];
  const working: StatusChat[] = [];
  for (const session of project.sessions) {
    const hooks = said.get(session.id);
    const events = ctx.archive.events(session.id);
    const ended = events.findLast((event) => event.kind === "result")?.ts;
    lastActive = Math.max(lastActive, ended ?? 0);
    const status = statuses[session.id];
    const role = hooks?.role ?? (session.liaison ? "liaison" : "teammate");
    const name = hooks?.name ?? session.title ?? "";
    const need = (reason: StatusNeed["reason"], text: string, since: number) =>
      needs.push({
        project: project.name,
        who: name,
        reason,
        text,
        since: iso(since)!,
        ...(ids ? { projectId: project.id, chatId: session.id } : {}),
      });
    const card = cards.get(session.id);
    const ask = asks.get(session.id);
    const error = status === "error" && !ctx.retries.has(session.id) ? lastError(events) : undefined;
    let state: StatusState;
    if (card !== undefined || status === "permission") {
      state = "needs-you";
      need("card", hooks?.lastSummary || "A card is waiting on you", card ?? now);
    } else if (ask) {
      state = "needs-you";
      need("question", ask.text ?? "A question is waiting on you", ask.since);
    } else if (status === "working") state = "working";
    else if (error !== undefined) {
      state = "blocked";
      need("error", trimSummary(`Stopped on an error: ${error}`, WORDS_CHARS), ended ?? now);
    } else state = "idle";
    const doing = state === "working" ? onWhat(events) : undefined;
    const chat: StatusChat = {
      name,
      role,
      ...(session.duty ? { duty: session.duty } : {}),
      state,
      ...(doing ? { doing } : {}),
      lastWords: trimSummary(hooks?.lastSummary ?? "", WORDS_CHARS),
      ...(ended !== undefined ? { lastActive: iso(ended) } : {}),
      ...(ids ? { id: session.id } : {}),
    };
    if (state === "working") working.push(chat);
    if (role === "lead") lead = chat;
    else team.push(chat);
  }
  const blocked = needs.filter((need) => need.reason === "error");
  const waiting = needs.filter((need) => need.reason !== "error");
  let state: StatusState;
  let doingNow: string;
  let since: number | undefined;
  if (waiting.length) {
    state = "needs-you";
    const first = waiting.reduce((a, b) => (b.since < a.since ? b : a));
    doingNow = line(`${first.who}${first.reason === "question" ? " asks" : ""}: ${first.text}`, DOING_CHARS);
    since = Date.parse(first.since);
  } else if (standing.atWork || standing.busySince !== undefined) {
    // quiet but still in its stretch: a lead handing a job on, a chat
    // carrying on after compacting — not done until the watch says so
    state = "working";
    since = standing.busySince;
    const first = working[0];
    const others = working.length > 1 ? ` · ${working.length - 1} more at work` : "";
    doingNow = first
      ? line(`${first.name}${first.doing ? `: ${first.doing}` : " is at work"}`, DOING_CHARS) + others
      : standing.atWork
        ? "At work in the background"
        : "Finishing up";
  } else if (blocked.length) {
    state = "blocked";
    doingNow = line(`${blocked[0]!.who}: ${blocked[0]!.text}`, DOING_CHARS);
    since = lastActive || undefined;
  } else {
    state = "idle";
    doingNow = line(lead?.lastWords ?? "", DOING_CHARS);
    since = lastActive || undefined;
  }
  return {
    project: {
      name: project.name,
      state,
      doingNow,
      ...(since !== undefined ? { since: iso(since) } : {}),
      ...(lead ? { lead } : {}),
      team,
      ...(ids ? { id: project.id } : {}),
    },
    needs,
    lastActive,
  };
}

/** Every open project's state, and what needs the user. */
export function statusReport(ctx: ServerContext, opts: { ids?: boolean; now?: number } = {}): StatusReport {
  const now = opts.now ?? Date.now();
  const read = ctx.store
    .list()
    .filter((project) => !project.hidden)
    .map((project) => readProject(ctx, project, opts.ids === true, now));
  read.sort(
    (a, b) => ORDER[a.project.state] - ORDER[b.project.state] || b.lastActive - a.lastActive,
  );
  return {
    computer: computerName(),
    at: new Date(now).toISOString(),
    needsYou: read.flatMap((r) => r.needs).sort((a, b) => a.since.localeCompare(b.since)),
    projects: read.map((r) => r.project),
  };
}

/* ── over HTTP ─────────────────────────────────────────────────────── */

/** Whether a request is for the status. */
export function isStatusPath(pathname: string): boolean {
  return pathname === "/status" || pathname === "/status/live";
}

/** The report, without the moment it was read: what tells one frame from
 *  the next. */
function picture(report: StatusReport): string {
  return JSON.stringify({ ...report, at: "" });
}

interface Watcher {
  res: http.ServerResponse;
  ids: boolean;
  /** The picture it was last sent. */
  sent: string;
  /** When anything was last written to it. */
  wrote: number;
}

/** The live status's watchers, read for together while there are any. */
export class StatusStream {
  private readonly watchers = new Set<Watcher>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly ctx: ServerContext,
    private readonly now: () => number = Date.now,
  ) {}

  /** How many are watching. */
  get size(): number {
    return this.watchers.size;
  }

  /** A new watcher: its first frame now, the rest as the picture changes. */
  add(res: http.ServerResponse, ids: boolean): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      // a proxy in between must not hold frames back
      "x-accel-buffering": "no",
    });
    const watcher: Watcher = { res, ids, sent: "", wrote: 0 };
    this.watchers.add(watcher);
    res.on("close", () => {
      this.watchers.delete(watcher);
      if (this.watchers.size > 0) return;
      clearInterval(this.timer);
      this.timer = undefined;
    });
    this.send(watcher, new Map());
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), LIVE_READ_MS);
      this.timer.unref?.();
    }
  }

  /** Read the picture again — once for every watcher wanting it the same
   *  way — and send it to each one it changed for. */
  tick(): void {
    const reports = new Map<boolean, StatusReport>();
    for (const watcher of [...this.watchers]) this.send(watcher, reports);
  }

  /** Every watcher let go. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers) watcher.res.end();
    this.watchers.clear();
  }

  private send(watcher: Watcher, reports: Map<boolean, StatusReport>): void {
    const now = this.now();
    try {
      let report = reports.get(watcher.ids);
      if (!report) reports.set(watcher.ids, (report = statusReport(this.ctx, { ids: watcher.ids, now })));
      const seen = picture(report);
      if (seen !== watcher.sent) {
        watcher.sent = seen;
        watcher.wrote = now;
        watcher.res.write(`event: status\ndata: ${JSON.stringify(report)}\n\n`);
      } else if (now - watcher.wrote >= LIVE_PING_MS) {
        watcher.wrote = now;
        watcher.res.write(": still here\n\n");
      }
    } catch (err) {
      warn("status", err, "live frame");
    }
  }
}

const streams = new WeakMap<ServerContext, StatusStream>();

/** The server's live status, made the first time it is asked for. */
export function statusStream(ctx: ServerContext): StatusStream {
  let stream = streams.get(ctx);
  if (!stream) streams.set(ctx, (stream = new StatusStream(ctx)));
  return stream;
}

/** Answer GET /status or GET /status/live; the caller has checked who
 *  is asking. */
export function serveStatus(ctx: ServerContext, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const ids = url.searchParams.get("ids") === "1";
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (url.pathname === "/status/live" && req.method === "GET") {
    statusStream(ctx).add(res, ids);
    return;
  }
  const body = JSON.stringify(statusReport(ctx, { ids }));
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : body);
}
