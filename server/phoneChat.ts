/**
 * A chat's conversation for the phone, and the phone's prompts into it
 * (docs/mobile-app.md). Only a key scoped "phone" reaches these, through
 * sharing's door (server/sharing.ts), or the token on this port.
 *
 *   GET  /chat?id=<chat>        the chat's recent conversation, once
 *   GET  /chat/live?id=<chat>   the same as server-sent events: a whole
 *                               frame on connect, then what changed
 *   POST /chat/send             { id, text, clientId, attachments?, now? } →
 *                               where it went; attachments are { id, kind,
 *                               mediaType, name, n, data } in base64 — or
 *                               without `data`, a file already in the
 *                               chat's prompt box (the frame's
 *                               draftAttachments), by its id; `now` cuts
 *                               in on the turn that is running
 *   POST /chat/queue            { id, do, itemId? } — a queued prompt sent
 *                               now ("now") or taken out ("remove"), or a
 *                               queue that is standing by sent on ("send")
 *   POST /chat/stop             { id } — the running turn stopped
 *   POST /chat/draft            { id, text?, add?, remove? } — the chat's
 *                               unsent prompt, written here: its words,
 *                               files clipped to it (`add`, as /chat/send
 *                               takes them, with `data`) and files taken
 *                               off (`remove`, their ids); every window's
 *                               box takes it
 *   GET  /chat/earlier?id=<chat>&before=<item>&limit=<n>
 *                               the things said before one the phone
 *                               holds: the rest of the conversation, a
 *                               page at a time, back past compactions to
 *                               its start
 *   GET  /chat/running?id=<chat>&key=<key>
 *                               one thing the frame's `running` lists,
 *                               opened: a script's command and what it
 *                               has printed, or an agent's own side
 *   POST /chat/answer           { id, ask, allow } — a card allowed or
 *                               refused; { id, ask, answers } — a question
 *                               answered, one { picked, other? } each;
 *                               { id, ask, dismiss: true } — one waved away
 *   POST /sidebar               { do: "move", id, folderId?, beforeId? } or
 *                               { do: "fold", folderId, collapsed } — the
 *                               sidebar arranged, as the window's drag does
 *   POST /project/account       { id, account } — the project put on an
 *                               account, for that account's harness, as
 *                               the row menu does
 *   POST /chat/account          { id, provider, account? } — one chat on an
 *                               account of its own, or (no account) back
 *                               on its project's, as the account chip does
 *   POST /chat/model            { id, model?, effort? } — one chat put on a
 *                               model from the status report's `models`,
 *                               and/or a reasoning level that model takes,
 *                               as the prompt box's pickers do
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
import * as fs from "node:fs";
import type * as http from "node:http";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  CARRY_ON,
  isAccountProvider,
  type AskAnswers,
  type AskQuestion,
  type AskQuestions,
  type Attachment,
  type AttachmentUpload,
  type DraftAttachment,
  type PermissionRequest,
  type PhoneAnswered,
  type PhoneAsk,
  type PhoneAttachment,
  type PhoneChatFrame,
  type PhoneChatItem,
  type PhoneEarlier,
  type PhoneQueued,
  type PhoneRunning,
  type PhoneRunningPage,
  type PhoneSent,
  type SubagentState,
  type TalkAsk,
  type TranscriptEvent,
} from "../shared/protocol.js";
import { plainMarkers } from "../shared/markerText.js";
import { questionError } from "../shared/questionInput.js";
import { channelProject } from "./channel.js";
import type { ClientConn, ServerContext } from "./context.js";
import { freshFiles, sameFiles } from "./drafts.js";
import { setChatAccount, setProjectAccount } from "./handlers/accounts.js";
import { projectHandlers } from "./handlers/projects.js";
import { promptHandlers } from "./handlers/prompts.js";
import { settingHandlers } from "./handlers/settings.js";
import { warn } from "./log.js";
import type { QueueEntry } from "./queue.js";
import { scriptLog } from "./scripts.js";
import { readBody } from "./sharing.js";
import { storedFilePath, storeUpload } from "./uploads.js";

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
/** The most a send may be as JSON: about 140 MB of files, in base64. */
const SEND_MAX = 190_000_000;
const ATTACHMENTS_MAX = 20;

/** What a phone may attach. The id names a file on this Mac's disk
 *  (uploads.ts), so only what cannot walk out of the uploads folder. */
const phoneUploads = z
  .array(
    z.object({
      id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
      kind: z.enum(["image", "video", "file"]),
      mediaType: z.string().max(200),
      name: z.string().max(1_000),
      n: z.number().int().min(1),
      // none: a file the chat's prompt box already holds, named by its id
      data: z.string().min(1).max(SEND_MAX).optional(),
    }),
  )
  .max(ATTACHMENTS_MAX);

/** A file as the phone sends it: with its bytes, or (a file added to the
 *  prompt box on another device) by its id alone. */
export type PhoneUpload = Omit<AttachmentUpload, "data"> & { data?: string | undefined };

export interface PhoneSendBody {
  id: string;
  text: string;
  clientId: string;
  uploads: PhoneUpload[];
  /** Sent to cut in: the running turn stops and this goes in its place. */
  now: boolean;
}

/** A /chat/send body, checked — or undefined. A prompt may be files alone. */
export function readSendBody(body: Record<string, unknown>): PhoneSendBody | undefined {
  const { id, text, clientId, attachments, now } = body;
  if (typeof id !== "string" || typeof text !== "string" || typeof clientId !== "string") return undefined;
  if (text.length > PROMPT_MAX || clientId.length === 0 || clientId.length > 100) return undefined;
  const uploads = phoneUploads.safeParse(attachments ?? []);
  if (!uploads.success || (!text.trim() && uploads.data.length === 0)) return undefined;
  return { id, text, clientId, uploads: uploads.data, now: now === true };
}

/** What a phone may do to a chat's queue: send one prompt now, take one
 *  out, or send on a queue that is standing by. */
export type PhoneQueueBody =
  { id: string; do: "now" | "remove"; itemId: string } | { id: string; do: "send" };

/** A /chat/queue body, checked — or undefined. */
export function readQueueBody(body: Record<string, unknown>): PhoneQueueBody | undefined {
  const { id, itemId } = body;
  const what = body["do"];
  if (typeof id !== "string" || id.length === 0 || id.length > 200) return undefined;
  if (what === "send") return { id, do: "send" };
  if (what !== "now" && what !== "remove") return undefined;
  if (typeof itemId !== "string" || itemId.length === 0 || itemId.length > 200) return undefined;
  return { id, do: what, itemId };
}

/** A socket nobody reads: these handlers answer through what the phone
 *  watches — the chat's live line, or the status. */
const nobody = { readyState: WebSocket.CLOSED, send() {} } as unknown as ClientConn;

/** What a phone may do to the sidebar: put a project or a folder somewhere
 *  (`moveInLayout`'s place), or fold or open a folder. */
export type PhoneSidebarBody =
  | { do: "move"; id: string; folderId?: string; beforeId?: string }
  | { do: "fold"; folderId: string; collapsed: boolean };

const sidebarId = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? raw : undefined;

/** A /sidebar body, checked — or undefined. */
export function readSidebarBody(body: Record<string, unknown>): PhoneSidebarBody | undefined {
  const id = sidebarId(body["id"]);
  const folderId = sidebarId(body["folderId"]);
  const beforeId = sidebarId(body["beforeId"]);
  if (body["do"] === "move" && id) {
    return { do: "move", id, ...(folderId ? { folderId } : {}), ...(beforeId ? { beforeId } : {}) };
  }
  if (body["do"] === "fold" && folderId && typeof body["collapsed"] === "boolean") {
    return { do: "fold", folderId, collapsed: body["collapsed"] };
  }
  return undefined;
}

/**
 * The phone's hand on the sidebar, the way the window's drag has one: the
 * same handlers, so every window sees the change at once and the phone with
 * its next status. Only what the phone is shown can be named — a hidden
 * project is the Mac's own business. Answers whether it was done.
 */
export function phoneSidebar(ctx: ServerContext, body: PhoneSidebarBody): boolean {
  const layout = ctx.store.sidebar();
  const folders = new Set(layout.folders.map((f) => f.id));
  const shown = (id: string) => folders.has(id) || ctx.store.list().some((p) => p.id === id && !p.hidden);
  if (body.do === "fold") {
    if (!folders.has(body.folderId)) return false;
    void projectHandlers.folder_set(ctx, nobody, {
      type: "folder_set",
      folderId: body.folderId,
      collapsed: body.collapsed,
    });
    return true;
  }
  if (!shown(body.id) || (body.folderId && !folders.has(body.folderId))) return false;
  if (body.beforeId && !shown(body.beforeId)) return false;
  void projectHandlers.sidebar_move(ctx, nobody, {
    type: "sidebar_move",
    id: body.id,
    ...(body.folderId ? { folderId: body.folderId } : {}),
    ...(body.beforeId ? { beforeId: body.beforeId } : {}),
  });
  return true;
}

/** The phone's account menu: a project it is shown put on an account, the
 *  way the account chip does it — every window sees it at once, and the
 *  phone with its next status. Answers whether it was done. */
export function phoneAccount(ctx: ServerContext, projectId: string, account: string): boolean {
  const project = ctx.store.get(projectId);
  if (!project || project.hidden) return false;
  return setProjectAccount(ctx, project.id, account);
}

/**
 * The phone's model menu: one chat put on a model the catalog lists, or
 * told a reasoning level, the way the prompt box's pickers do it — the
 * chat's own pick, every window seeing it at once, a running turn left to
 * finish on what it started with.
 *
 * A level is only one the model takes. And a chat moved onto a model that
 * does not take the level it was on goes to that model's own: the window
 * does the same the moment it shows the chat, and a chat the phone moved
 * may run before any window has.
 */
export function phoneModel(
  ctx: ServerContext,
  chat: string,
  pick: { model?: string; effort?: string },
): { ok: true } | { ok: false; error: string } {
  const catalog = ctx.models.allModels();
  const settings = ctx.store.effectiveSettings(chat);
  if (!settings) return { ok: false, error: "That chat is gone." };
  const model = catalog.find((m) => m.value === (pick.model ?? settings.model));
  if (pick.model !== undefined && !model)
    return { ok: false, error: "This computer doesn't list that model." };
  const levels = model?.reasoningEfforts?.map((effort) => effort.value) ?? [];
  if (pick.effort !== undefined && !levels.includes(pick.effort)) {
    return {
      ok: false,
      error: levels.length ? "That model doesn't take that level." : "That model has no reasoning levels.",
    };
  }
  if (pick.model !== undefined) {
    void settingHandlers.set_model(ctx, nobody, { type: "set_model", projectId: chat, model: pick.model });
  }
  const effort =
    pick.effort ??
    (pick.model !== undefined && levels.length > 0 && !levels.includes(settings.effort)
      ? (model?.defaultEffort ?? levels[0])
      : undefined);
  if (effort !== undefined) {
    void settingHandlers.set_effort(ctx, nobody, { type: "set_effort", projectId: chat, effort });
  }
  return { ok: true };
}

const CHAT_PATHS = new Set([
  "/chat",
  "/chat/live",
  "/chat/send",
  "/chat/queue",
  "/chat/stop",
  "/chat/draft",
  "/chat/earlier",
  "/chat/running",
  "/chat/answer",
  "/sidebar",
  "/project/account",
  "/chat/account",
  "/chat/model",
]);

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

/** What the phone is told of a prompt's attachments: only what is on file. */
function phoneAttachments(attachments: Attachment[] | undefined): { attachments?: PhoneAttachment[] } {
  const stored = (attachments ?? []).flatMap((att) =>
    att.url
      ? [{ id: att.id, kind: att.kind, mediaType: att.mediaType, name: att.name, n: att.n, url: att.url }]
      : [],
  );
  return stored.length ? { attachments: stored } : {};
}

/** A chat's transcript as the phone shows it, the newest ITEMS_MAX of it:
 *  what a frame carries. The rest is paged for (phoneEarlier). */
export function phoneItems(events: TranscriptEvent[], draft?: { id: string; text: string }): PhoneChatItem[] {
  return everyItem(events, draft).slice(-ITEMS_MAX);
}

/** A transcript as the phone shows it, whole: what was said, tool calls
 *  between two things said folded into one line of steps. */
function everyItem(events: TranscriptEvent[], draft?: { id: string; text: string }): PhoneChatItem[] {
  const items: PhoneChatItem[] = [];
  let steps: PhoneChatItem | undefined;
  const fold = () => {
    if (steps) steps.text = `${steps.steps!.length} ${steps.steps!.length === 1 ? "step" : "steps"}`;
    steps = undefined;
  };
  for (const event of events) {
    if (event.kind === "tool") {
      if (!steps)
        items.push((steps = { id: event.id, kind: "steps", text: "", steps: [], at: iso(event.ts) }));
      steps.steps!.push(oneLine(event.summary ? `${event.name}: ${event.summary}` : event.name));
      continue;
    }
    if (event.kind === "user") {
      if (ruris(event.text) || (!event.text.trim() && !event.attachments?.length)) continue;
      fold();
      items.push({
        id: event.id,
        kind: "user",
        text: cut(event.text),
        ...(event.from ? { from: event.from.title || event.from.project } : {}),
        ...phoneAttachments(event.attachments),
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
    } else if (event.kind === "compaction" && event.cleared) {
      fold();
      items.push({ id: event.id, kind: "note", text: "Cleared: a fresh start from here", at: iso(event.ts) });
    }
  }
  fold();
  if (draft?.text.trim()) {
    items.push({
      id: `draft:${draft.id}`,
      kind: "assistant",
      text: cut(draft.text),
      at: iso(Date.now()),
      pending: true,
    });
  }
  return items;
}

/* ── the rest of the conversation, a page at a time ────────────────── */

/** How many things said one page holds, and the most that may be asked for. */
const PAGE = 80;
const PAGE_MAX = 200;
/** How long a chat's history is kept once read: it changes only when the
 *  chat compacts, and a reader going back through it asks page after page. */
const HISTORY_KEPT_MS = 10_000;
const histories = new Map<string, { at: number; items: PhoneChatItem[] }>();

/** What was said before the chat's last compaction (the archive's history,
 *  read from disk), as the phone shows it. */
function historyItems(ctx: ServerContext, chatId: string): PhoneChatItem[] {
  const now = Date.now();
  for (const [chat, kept] of histories) if (now - kept.at > HISTORY_KEPT_MS) histories.delete(chat);
  const kept = histories.get(chatId);
  if (kept) return kept.items;
  const items = everyItem(ctx.archive.history(chatId));
  histories.set(chatId, { at: now, items });
  return items;
}

/**
 * The things said just before `before` (the id of an item the phone
 * holds), oldest first: the conversation back past what a frame carries
 * and past its compactions, so the phone can be scrolled up through all of
 * it as the window can. With no `before` (a chat that has said nothing
 * since it compacted leaves the phone holding nothing to name) it is the
 * newest of everything. No items, and no more, for an id the conversation
 * does not hold — it was rewound, or cleared away.
 */
export function phoneEarlier(ctx: ServerContext, chatId: string, before: string, limit = PAGE): PhoneEarlier {
  // the live part is read on its own, as a frame reads it: a run of steps
  // is folded under the same id either way
  const all = [...historyItems(ctx, chatId), ...everyItem(ctx.archive.events(chatId))];
  const at = before ? all.findIndex((item) => item.id === before) : all.length;
  if (at < 0) return { items: [], more: false };
  const from = Math.max(0, at - Math.min(Math.max(1, Math.floor(limit)), PAGE_MAX));
  return { items: all.slice(from, at), more: from > 0 };
}

/* ── what a chat has running beside its conversation ───────────────── */

/** A card's one line, as long as a step's. */
const runningLine = (ctx: ServerContext, text: string | undefined) => {
  const line = oneLine(ctx.secrets.redact(text ?? ""));
  return line || undefined;
};

/** Every card of a chat that says it is running: the model's own agents
 *  and scripts, in the chat's transcript, and the user's own agents. */
function runningCards(ctx: ServerContext, chatId: string): SubagentState[] {
  // (a stand-in context, in a test, may keep no sessions and no crew: a
  // frame is read for many things besides what is running)
  const sessions = ctx.manager as Partial<Pick<ServerContext["manager"], "backgroundWork">> | undefined;
  const live = sessions?.backgroundWork?.(chatId) ?? { agents: 0, scripts: 0 };
  const crew = (ctx.crew as ServerContext["crew"] | undefined)?.list(chatId) ?? [];
  if (live.agents === 0 && live.scripts === 0 && crew.length === 0) return [];
  const cards = ctx.archive
    .events(chatId)
    .flatMap((event) => (event.kind === "tool" && event.agent?.status === "running" ? [event.agent] : []));
  // only as many as the session says are alive, the newest: a card a
  // process that is gone left "running" is not
  const newest = (of: SubagentState[], n: number) => (n > 0 ? of.slice(-n) : []);
  const mine = crew.filter((agent) => agent.status === "running");
  return [
    ...newest(
      cards.filter((card) => card.script),
      live.scripts,
    ),
    ...newest(
      cards.filter((card) => !card.script),
      live.agents,
    ),
    ...mine,
  ].sort((a, b) => a.startedAt - b.startedAt);
}

/** What a chat has running, as the phone lists it. */
export function phoneRunning(ctx: ServerContext, chatId: string): PhoneRunning[] {
  return runningCards(ctx, chatId).map((card) => {
    const doing = runningLine(ctx, card.activity);
    return {
      key: card.key,
      kind: card.script ? ("script" as const) : ("agent" as const),
      title: runningLine(ctx, card.description) ?? (card.script ? "A script" : "An agent"),
      ...(doing ? { doing } : {}),
      since: iso(card.startedAt),
      ...(card.printedAt !== undefined ? { printed: iso(card.printedAt) } : {}),
    };
  });
}

/**
 * One of them opened: a script's page as the window's agents page shows it
 * (server/scripts.ts — its command, then what it printed, in the stretches
 * it arrived in, with a line where it printed nothing for a while), or an
 * agent's own side of the conversation. Undefined for a key that is none
 * of this chat's cards.
 */
export function phoneRunningPage(
  ctx: ServerContext,
  chatId: string,
  key: string,
): PhoneRunningPage | undefined {
  const card =
    ctx.archive
      .events(chatId)
      .flatMap((event) => (event.kind === "tool" && event.agent ? [event.agent] : []))
      .findLast((agent) => agent.key === key) ?? ctx.crew.list(chatId).find((agent) => agent.key === key);
  if (!card) return undefined;
  const running = runningCards(ctx, chatId).some((live) => live.key === key);
  const page = scriptLog(ctx, chatId, key);
  if (!page) return { running, items: phoneItems(ctx.agentLogs.read(chatId, key)) };
  // a script's page is a conversation nobody can answer: its command, what
  // it printed, and ruri's own line where it went quiet
  const items = page.flatMap((event): PhoneChatItem[] =>
    event.kind === "user" || event.kind === "assistant"
      ? [{ id: event.id, kind: event.kind, text: cut(event.text), at: iso(event.ts) }]
      : event.kind === "info"
        ? [{ id: event.id, kind: "note", text: event.text, at: iso(event.ts) }]
        : [],
  );
  return { running, items: items.slice(-ITEMS_MAX) };
}

/** The chat, whole, as a frame — or undefined for a chat that is not one. */
export function phoneFrame(ctx: ServerContext, chatId: string): PhoneChatFrame | undefined {
  const found = ctx.store.findSession(chatId);
  if (!found || found.project.hidden) return undefined;
  const { project, session } = found;
  const held = ctx.turns.gates.get(chatId);
  const draft = held?.shown ? { id: held.messageId, text: held.shown } : undefined;
  const status = ctx.manager.statuses()[chatId];
  // a card handed to an agent the user trusts waits on it, not on them:
  // the chat is at work until the card becomes theirs
  const cards = [...ctx.permissions.values()].filter(
    (request) => request.projectId === chatId && request.kind !== "component",
  );
  const waiting = cards.some((request) => !request.asked) || (status === "permission" && cards.length === 0);
  const queue = phoneQueue(ctx.queues.entries.get(chatId) ?? []);
  const asks = phoneAsks(ctx, chatId);
  const boxed = phoneAttachments(ctx.drafts.get(chatId)?.attachments);
  const running = phoneRunning(ctx, chatId);
  const events = ctx.archive.events(chatId);
  const items = everyItem(events, draft);
  // (a stand-in archive, in a test, may know nothing of a history)
  const past = (ctx.archive as Partial<Pick<ServerContext["archive"], "hasHistory">>).hasHistory?.(chatId);
  return {
    chat: chatId,
    name: session.title || project.name,
    project: project.name,
    state: waiting ? "needs-you" : status === "working" || status === "permission" ? "working" : "idle",
    queue,
    ...(queue.length && ctx.queues.held.has(chatId) ? { held: true as const } : {}),
    // markers as the phone reads them: a window saves its own unbreakable
    ...(ctx.drafts.get(chatId)?.text.trim() ? { draft: plainMarkers(ctx.drafts.get(chatId)!.text) } : {}),
    ...(boxed.attachments ? { draftAttachments: boxed.attachments } : {}),
    ...(running.length ? { running } : {}),
    ...(items.length > ITEMS_MAX || past ? { earlier: true as const } : {}),
    ...(asks.length ? { asks } : {}),
    items: items.slice(-ITEMS_MAX),
  };
}

/* ── the cards a chat waits at ─────────────────────────────────────── */

/** What a card would do, in full, is shown up to this much. */
const ASK_CHARS = 4_000;
/** The most a phone may type as one answer. */
const ANSWER_MAX = 10_000;

/** Whether a question's own words may be typed, as the window's card has it. */
const typed = (q: AskQuestion) => q.allowOther !== false || q.options.length === 0;

/** A card of the chat's the phone is shown — not a component to name,
 *  which waits on no one. */
function cardOf(ctx: ServerContext, chatId: string, id: string): PermissionRequest | undefined {
  const request = ctx.permissions.get(id);
  return request && request.projectId === chatId && request.kind !== "component" ? request : undefined;
}

/** One card as the phone shows it. */
export function phoneAsk(request: PermissionRequest): PhoneAsk {
  const base = { id: request.requestId, ...(request.agent ? { byAgent: true as const } : {}) };
  const clip = (text: string) =>
    text.length > ASK_CHARS ? `${text.slice(0, ASK_CHARS)}\n… (cut short)` : text;
  if (request.kind === "question") {
    const asked = ((request.input ?? {}) as Partial<AskQuestions>).questions ?? [];
    // a page to open and confirm, or a secret kept out of the transcript,
    // is answered at the Mac
    const onMac = asked.some((q) => q.secret || q.url);
    return {
      ...base,
      kind: "question",
      title: asked[0]?.question ?? "A question",
      questions: asked.map((q) => ({
        question: q.question,
        header: q.header ?? "",
        options: q.options.map((o) => ({
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
        multi: q.multiSelect === true,
        other: typed(q),
        ...(q.required === false ? { optional: true as const } : {}),
        ...(q.inputType === "number" || q.inputType === "integer" ? { number: true as const } : {}),
        ...(q.hint ? { hint: q.hint } : {}),
      })),
      ...(onMac ? { onMac: true as const } : {}),
    };
  }
  if (request.kind === "message") {
    const ask = request.input as TalkAsk;
    const whom = `${ask.project}${ask.title ? ` · ${ask.title}` : ""}`;
    return {
      ...base,
      kind: "message",
      title: ask.opening ? `Open ${ask.project} and message it` : `Message ${whom}`,
      detail: clip(ask.text),
    };
  }
  const input = (request.input ?? {}) as Record<string, unknown>;
  const said =
    typeof input["plan"] === "string"
      ? input["plan"]
      : typeof input["command"] === "string"
        ? input["command"]
        : typeof input["file_path"] === "string"
          ? input["file_path"]
          : JSON.stringify(request.input ?? {}, null, 2);
  return {
    ...base,
    kind: "permission",
    title: request.toolName === "ExitPlanMode" ? "Start building from this plan" : request.toolName,
    ...(said && said !== "{}" ? { detail: clip(said) } : {}),
  };
}

/** The cards a chat waits at, oldest first, as the phone is shown them. */
export function phoneAsks(ctx: ServerContext, chatId: string): PhoneAsk[] {
  return [...ctx.permissions.values()]
    .filter((request) => request.projectId === chatId && request.kind !== "component")
    .sort((a, b) => a.ts - b.ts)
    .map(phoneAsk);
}

/** What a phone may say to a card. */
export type PhoneAnswerBody = { id: string; ask: string } & (
  { allow: boolean } | { answers: PhoneAnswered[] } | { dismiss: true }
);

/** A /chat/answer body, checked — or undefined. */
export function readAnswerBody(body: Record<string, unknown>): PhoneAnswerBody | undefined {
  const id = sidebarId(body["id"]);
  const ask = sidebarId(body["ask"]);
  if (!id || !ask) return undefined;
  if (typeof body["allow"] === "boolean") return { id, ask, allow: body["allow"] };
  if (body["dismiss"] === true) return { id, ask, dismiss: true };
  const raw = body["answers"];
  if (!Array.isArray(raw) || raw.length > 50) return undefined;
  const answers: PhoneAnswered[] = [];
  for (const one of raw as unknown[]) {
    const { picked, other } = (one ?? {}) as Record<string, unknown>;
    if (!Array.isArray(picked) || picked.length > 100 || picked.some((p) => typeof p !== "string"))
      return undefined;
    if (other !== undefined && (typeof other !== "string" || other.length > ANSWER_MAX)) return undefined;
    answers.push({ picked: picked as string[], ...(typeof other === "string" ? { other } : {}) });
  }
  return { id, ask, answers };
}

/**
 * The phone's answer to a card, given the way the window's card gives it
 * (the same handlers): a tool or a message allowed or refused, a question
 * answered or waved away. The answers are put together and checked here,
 * as the window's card does it, so the phone only says what was picked
 * and typed. Answers whether it was done, and if not, why in a line the
 * phone can show.
 *
 * `always` is not the phone's to say: it is how an agent the user trusts
 * allows a tool for good, as the window's Always allow does
 * (server/handlers/trusted.ts).
 */
export function phoneAnswer(
  ctx: ServerContext,
  body: PhoneAnswerBody,
  always = false,
): { ok: true } | { ok: false; error: string } {
  const request = cardOf(ctx, body.id, body.ask);
  // answered at the Mac meanwhile, or the turn moved on: the phone's
  // picture was a beat behind
  if (!request) return { ok: false, error: "That card is gone — it was answered or its turn moved on." };
  if (request.kind !== "question") {
    if (!("allow" in body)) return { ok: false, error: "This card is allowed or refused." };
    void promptHandlers.permission_response(ctx, nobody, {
      type: "permission_response",
      requestId: request.requestId,
      allow: body.allow,
      always: always && body.allow,
    });
    return { ok: true };
  }
  if ("allow" in body) return { ok: false, error: "This card asks a question." };
  if ("dismiss" in body) {
    void promptHandlers.question_response(ctx, nobody, {
      type: "question_response",
      requestId: request.requestId,
    });
    return { ok: true };
  }
  const asked = ((request.input ?? {}) as Partial<AskQuestions>).questions ?? [];
  if (asked.some((q) => q.secret || q.url)) return { ok: false, error: "Answer this one on your Mac." };
  if (body.answers.length !== asked.length) return { ok: false, error: "Answer each question." };
  const answers: AskAnswers["answers"] = {};
  const values: NonNullable<AskAnswers["values"]> = {};
  const annotations: NonNullable<AskAnswers["annotations"]> = {};
  for (const [i, q] of asked.entries()) {
    const given = body.answers[i]!;
    const words = typed(q) && given.other?.trim() ? given.other : "";
    // only what was offered counts as picked; words of one's own stand in
    // for the options of a question that takes one answer
    const offered = [...new Set(given.picked)].filter((label) => q.options.some((o) => o.label === label));
    const picked = words && !q.multiSelect ? [] : offered;
    const chosen = [
      ...picked.map((label) => q.options.find((o) => o.label === label)?.value ?? label),
      ...(words ? [words] : []),
    ];
    const wrong = questionError(q, chosen);
    if (wrong) return { ok: false, error: `${q.header || q.question}: ${wrong}` };
    answers[q.question] = [...picked, ...(words ? [words] : [])].join(", ");
    values[q.id ?? q.question] = chosen;
    const preview = q.options.find((o) => o.label === picked[picked.length - 1])?.preview;
    if (preview) annotations[q.question] = { preview };
  }
  void promptHandlers.question_response(ctx, nobody, {
    type: "question_response",
    requestId: request.requestId,
    answers: { answers, values, ...(Object.keys(annotations).length ? { annotations } : {}) },
  });
  return { ok: true };
}

/** The user's own prompts waiting in a chat's queue, as the phone shows
 *  them: not ruri's silent ones, nor another agent's messages. One that
 *  cut in is marked — it goes the moment the stopped turn is over. */
export function phoneQueue(entries: QueueEntry[]): PhoneQueued[] {
  return entries
    .filter((entry) => !entry.silent && !entry.from)
    .map((entry) => ({
      id: entry.id,
      text: cut(entry.text),
      ...phoneAttachments(entry.attachments),
      ...(entry.cut ? { now: true as const } : {}),
    }));
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

/**
 * The files of a prompt from the phone, each with its bytes: one named by
 * its id alone is a file the chat's prompt box holds, added on another
 * device, so its bytes are on this disk already — sent as the box has it,
 * whatever the phone said of it. One the box no longer holds is left out.
 */
export function boxedUploads(ctx: ServerContext, chat: string, sent: PhoneUpload[]): AttachmentUpload[] {
  const held = ctx.drafts.get(chat)?.attachments ?? [];
  return sent.flatMap((upload): AttachmentUpload[] => {
    if (upload.data) return [{ ...upload, data: upload.data }];
    const boxed = held.find((att) => att.id === upload.id);
    if (!boxed?.url) return [];
    try {
      const data = fs.readFileSync(storedFilePath(boxed.url)).toString("base64");
      return [
        { id: boxed.id, kind: boxed.kind, mediaType: boxed.mediaType, name: boxed.name, n: boxed.n, data },
      ];
    } catch (err) {
      warn("phone", err, "a boxed file to send");
      return [];
    }
  });
}

/** A prompt into a chat, the way the web app sends one; where it went. */
export async function phoneSend(
  ctx: ServerContext,
  chat: string,
  text: string,
  clientId: string,
  sent: PhoneUpload[] = [],
  now = false,
): Promise<PhoneSent> {
  let as: PhoneSent["as"] | undefined;
  const uploads = boxedUploads(ctx, chat, sent);
  // every file named was gone, and there were no words: nothing to send
  if (!text.trim() && uploads.length === 0) return { as: "failed" };
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
    await promptHandlers.send(ctx, answer, {
      type: "send",
      projectId: chat,
      text,
      clientId,
      ...(uploads.length ? { attachments: uploads } : {}),
      ...(now ? { now: true } : {}),
    });
  } catch (err) {
    warn("phone", err, "send");
    return { as: "failed" };
  }
  // the answer comes a microtask after the prompt is taken
  await new Promise((resolve) => setImmediate(resolve));
  // what was written went out: the prompt box is empty everywhere now,
  // of its words and of the files that went with them
  if (as !== "failed") phoneDraft(ctx, chat, "", { remove: sent.map((upload) => upload.id) });
  return { as: as ?? "other" };
}

/**
 * The phone's hand on a chat's queue, the way the web app's cards have
 * one: a prompt held down goes now (it cuts in on a running turn), one is
 * taken out, or a queue standing by since a stop is sent on. Only the
 * prompts the phone is shown can be named. Answers whether it was done.
 */
export function phoneQueueDo(ctx: ServerContext, body: PhoneQueueBody): boolean {
  const chat = body.id;
  if (body.do === "send") {
    if (!ctx.queues.held.has(chat)) return false;
    void promptHandlers.queue_send(ctx, nobody, { type: "queue_send", projectId: chat });
    return true;
  }
  const shown = phoneQueue(ctx.queues.entries.get(chat) ?? []).some((entry) => entry.id === body.itemId);
  if (!shown) return false;
  if (body.do === "now") {
    void promptHandlers.queue_now(ctx, nobody, { type: "queue_now", projectId: chat, itemId: body.itemId });
  } else {
    void promptHandlers.queue_remove(ctx, nobody, {
      type: "queue_remove",
      projectId: chat,
      itemId: body.itemId,
    });
  }
  return true;
}

/** Who added a file, for the phone: it has no socket to be known by. */
const PHONE = "phone";

/**
 * The chat's unsent prompt, written on the phone: kept as a window's is,
 * and every window's composer takes it. Its words when the phone says
 * them; its files one at a time — `add` clips some to it (stored like any
 * upload), `remove` takes some off by id — so a file another device added
 * meanwhile is never lost to a list that had not heard of it. The files
 * the box holds afterwards come back.
 */
export function phoneDraft(
  ctx: ServerContext,
  chat: string,
  text: string | undefined,
  files: { add?: AttachmentUpload[]; remove?: string[] } = {},
): DraftAttachment[] {
  const held = ctx.drafts.get(chat);
  const before = held?.attachments ?? [];
  // the same words with the markers written the phone's way are the same
  // words: the window's own stand, and no window is told
  const same = text === undefined || plainMarkers(held?.text ?? "") === plainMarkers(text);
  const words = same ? (held?.text ?? "") : text;
  const gone = new Set(files.remove ?? []);
  const attachments = before.filter((att) => !gone.has(att.id));
  for (const upload of files.add ?? []) {
    if (attachments.some((att) => att.id === upload.id)) continue;
    // its marker's number is its own: one already taken (a picture added
    // in a window at the same moment) and it takes the next
    const taken = attachments.filter((att) => att.kind === upload.kind).map((att) => att.n);
    const n = taken.includes(upload.n) ? Math.max(...taken) + 1 : upload.n;
    const { data: _data, picture: _picture, regions: _regions, ...meta } = upload;
    attachments.push({ ...meta, n, url: storeUpload({ ...upload, n }).url });
    freshFiles.note(upload.id, PHONE);
  }
  const filed = !sameFiles(before, attachments);
  if ((held?.text ?? "") === words && !filed) return attachments;
  ctx.drafts.set(chat, words, filed ? attachments : held?.attachments);
  ctx.clients.broadcast({
    type: "composer_draft",
    projectId: chat,
    text: words,
    ...(filed ? { attachments } : {}),
  });
  return attachments;
}

/** A /chat/draft body, checked — or undefined. */
export function readDraftBody(
  body: Record<string, unknown>,
): { id: string; text?: string; add: AttachmentUpload[]; remove: string[] } | undefined {
  const { id, text, add, remove } = body;
  if (typeof id !== "string" || !id) return undefined;
  if (text !== undefined && (typeof text !== "string" || text.length > PROMPT_MAX)) return undefined;
  const added = phoneUploads.safeParse(add ?? []);
  const removed = z
    .array(z.string().max(100))
    .max(ATTACHMENTS_MAX)
    .safeParse(remove ?? []);
  if (!added.success || !removed.success) return undefined;
  // a file added has its bytes with it
  const uploads = added.data.flatMap((upload): AttachmentUpload[] =>
    upload.data ? [{ ...upload, data: upload.data }] : [],
  );
  if (uploads.length !== added.data.length) return undefined;
  if (text === undefined && uploads.length === 0 && removed.data.length === 0) return undefined;
  return { id, ...(text !== undefined ? { text } : {}), add: uploads, remove: removed.data };
}

/** The running turn stopped, as the web app's stop button stops it: the
 *  queue stands by rather than being thrown away. */
export function phoneStop(ctx: ServerContext, chat: string): void {
  void promptHandlers.interrupt(ctx, nobody, { type: "interrupt", projectId: chat });
}

/* ── over HTTP ─────────────────────────────────────────────────────── */

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** A POST's body as an object, or undefined for what isn't one. */
async function readJson(
  req: http.IncomingMessage,
  max: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readBody(req, max)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the phone may act on this chat: one that is open, and not hidden. */
function reachable(ctx: ServerContext, chat: string): boolean {
  const found = ctx.store.findSession(chat);
  return Boolean(found && !found.project.hidden && channelProject(ctx, chat));
}

/** Answer /chat, /chat/live, /chat/send, /chat/queue or /chat/stop; the
 *  caller has checked who is asking. */
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
    const parsed = await readJson(req, SEND_MAX);
    if (!parsed) {
      json(res, 400, { error: "bad request" });
      return;
    }
    const body = readSendBody(parsed);
    if (!body) {
      json(res, 400, { error: "send { id, text, clientId, attachments?, now? }" });
      return;
    }
    const { id, text, clientId, uploads, now } = body;
    if (!reachable(ctx, id)) {
      json(res, 404, { error: "no such chat" });
      return;
    }
    json(res, 200, await phoneSend(ctx, id, text, clientId, uploads, now));
    return;
  }
  if (url.pathname === "/sidebar") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const parsed = await readJson(req, 4096);
    const body = parsed ? readSidebarBody(parsed) : undefined;
    if (!body) {
      json(res, 400, {
        error: 'send { do: "move", id, folderId?, beforeId? } or { do: "fold", folderId, collapsed }',
      });
      return;
    }
    json(res, 200, { ok: phoneSidebar(ctx, body) });
    return;
  }
  if (url.pathname === "/project/account") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const parsed = await readJson(req, 4096);
    const project = sidebarId(parsed?.["id"]);
    const account = sidebarId(parsed?.["account"]);
    if (!project || !account) {
      json(res, 400, { error: "send { id, account }" });
      return;
    }
    json(res, 200, { ok: phoneAccount(ctx, project, account) });
    return;
  }
  if (url.pathname === "/chat/account") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const parsed = await readJson(req, 4096);
    const chat = sidebarId(parsed?.["id"]);
    const provider = parsed?.["provider"];
    const account = parsed?.["account"];
    const named = typeof account === "string" ? sidebarId(account) : undefined;
    if (
      !chat ||
      typeof provider !== "string" ||
      !isAccountProvider(provider) ||
      (account !== undefined && account !== null && !named)
    ) {
      json(res, 400, { error: "send { id, provider, account? }" });
      return;
    }
    if (!reachable(ctx, chat)) {
      json(res, 404, { error: "no such chat" });
      return;
    }
    json(res, 200, { ok: setChatAccount(ctx, chat, provider, named) });
    return;
  }
  if (url.pathname === "/chat/model") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const parsed = await readJson(req, 4096);
    const chat = sidebarId(parsed?.["id"]);
    const model = parsed?.["model"];
    const effort = parsed?.["effort"];
    const named = (value: unknown): value is string | undefined =>
      value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 200);
    if (!chat || !named(model) || !named(effort) || (model === undefined && effort === undefined)) {
      json(res, 400, { error: "send { id, model?, effort? }" });
      return;
    }
    if (!reachable(ctx, chat)) {
      json(res, 404, { error: "no such chat" });
      return;
    }
    json(res, 200, phoneModel(ctx, chat, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
    return;
  }
  if (url.pathname === "/chat/draft") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    // files come with their bytes: as much room as a send has
    const parsed = await readJson(req, SEND_MAX);
    const body = parsed ? readDraftBody(parsed) : undefined;
    if (!body) {
      json(res, 400, { error: "send { id, text?, add?, remove? }" });
      return;
    }
    if (!reachable(ctx, body.id)) {
      json(res, 404, { error: "no such chat" });
      return;
    }
    const held = ctx.drafts.get(body.id)?.attachments?.length ?? 0;
    if (held - body.remove.length + body.add.length > ATTACHMENTS_MAX) {
      json(res, 400, { error: `a prompt takes ${ATTACHMENTS_MAX} attachments` });
      return;
    }
    phoneDraft(ctx, body.id, body.text, { add: body.add, remove: body.remove });
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/chat/answer") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const parsed = await readJson(req, ANSWER_MAX * 60);
    const body = parsed ? readAnswerBody(parsed) : undefined;
    if (!body) {
      json(res, 400, {
        error: "send { id, ask, allow } or { id, ask, answers } or { id, ask, dismiss: true }",
      });
      return;
    }
    if (!reachable(ctx, body.id)) {
      json(res, 404, { error: "no such chat" });
      return;
    }
    // a card already gone is no error of the request's: the phone is told
    // why in words
    json(res, 200, phoneAnswer(ctx, body));
    return;
  }
  if (url.pathname === "/chat/queue" || url.pathname === "/chat/stop") {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    const parsed = await readJson(req, 4096);
    const queue = parsed && url.pathname === "/chat/queue" ? readQueueBody(parsed) : undefined;
    const chat = url.pathname === "/chat/queue" ? queue?.id : parsed?.["id"];
    if (typeof chat !== "string" || !chat) {
      json(res, 400, {
        error:
          url.pathname === "/chat/queue"
            ? 'send { id, do: "now" | "remove" | "send", itemId? }'
            : "send { id }",
      });
      return;
    }
    if (!reachable(ctx, chat)) {
      json(res, 404, { error: "no such chat" });
      return;
    }
    if (queue) {
      // a prompt that already went, or a queue already moving, is no error:
      // the phone's picture was a beat behind
      json(res, 200, { ok: phoneQueueDo(ctx, queue) });
      return;
    }
    phoneStop(ctx, chat);
    json(res, 200, { ok: true });
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
  if (url.pathname === "/chat/earlier") {
    const limit = Number(url.searchParams.get("limit") ?? PAGE);
    json(
      res,
      200,
      phoneEarlier(ctx, chat, url.searchParams.get("before") ?? "", Number.isFinite(limit) ? limit : PAGE),
    );
    return;
  }
  if (url.pathname === "/chat/running") {
    const page = phoneRunningPage(ctx, chat, url.searchParams.get("key") ?? "");
    if (page) json(res, 200, page);
    // its card is gone: the chat was cleared, or rewound past it
    else json(res, 404, { error: "no such card" });
    return;
  }
  if (url.pathname === "/chat/live" && req.method === "GET") {
    phoneChatStream(ctx).add(res, chat);
    return;
  }
  json(res, 200, frame);
}
