/**
 * The terminal window's store: the server's messages reduced into one
 * state (state.ts), and everything the keys can ask of the server. It is a
 * client like the desktop window and the phone — it runs no turns, holds
 * nothing the server doesn't, and can be closed at any moment.
 */
import { randomUUID } from "node:crypto";
import {
  HOME_ID,
  type AccountInfo,
  type AskAnswers,
  type ClientMessage,
  type PermissionMode,
  type ServerMessage,
} from "../../shared/protocol";
import { accountIn, picksOf, withPick } from "../../web/src/lib/accounts";
import { connect, type Dial, type Line } from "./client";
import { at, EMPTY, type Edit } from "./editor";
import { initial, projectOf, reduce, type State } from "./state";

/** How long after a key the prompt box is the user's alone: a draft typed
 *  on another device does not land under their fingers. */
const TYPING_MS = 2000;
/** A draft is saved this long after the last key. */
const DRAFT_MS = 400;

export interface Screen extends State {
  /** Each chat's prompt box. */
  edits: Record<string, Edit>;
}

export interface Options {
  dial: Dial;
  /** How often the screen is told of changes; 0 says every one at once
   *  (tests). A streaming reply is many small messages a second, and a
   *  terminal redraw per message is wasted work. */
  throttleMs?: number;
  now?: () => number;
}

export class Ruri {
  private state: Screen = { ...initial(), edits: {} };
  private readonly listeners = new Set<() => void>();
  private line: Line | undefined;
  private flush: ReturnType<typeof setTimeout> | undefined;
  /** A server message is being applied. */
  private receiving = false;
  private readonly throttleMs: number;
  private readonly now: () => number;
  /** When each chat's box was last typed in. */
  private readonly typedAt = new Map<string, number>();
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Drafts the line dropped: saved again when it is back. */
  private readonly unsaved = new Set<string>();
  /** Prompts on their way, by the id they were sent under. */
  private readonly outbox = new Map<string, { chatId: string; text: string }>();
  /** Chats asked for whole and not yet here. */
  private readonly asked = new Set<string>();

  constructor(private readonly options: Options) {
    this.throttleMs = options.throttleMs ?? 33;
    this.now = options.now ?? Date.now;
  }

  /* ── for React ──────────────────────────────────────────────────── */

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): Screen => this.state;

  /** What the server says is drawn at the screen's own pace; what a key
   *  did is drawn now, so the next key lands on what the last one made. */
  private set(next: Partial<Screen>): void {
    this.state = { ...this.state, ...next };
    if (this.throttleMs === 0 || !this.receiving) {
      clearTimeout(this.flush);
      this.flush = undefined;
      for (const listener of this.listeners) listener();
      return;
    }
    this.flush ??= setTimeout(() => {
      this.flush = undefined;
      for (const listener of this.listeners) listener();
    }, this.throttleMs);
  }

  /* ── the line ───────────────────────────────────────────────────── */

  start(): void {
    this.line = connect(this.options.dial, {
      open: () => this.set({ connected: true }),
      message: (message) => {
        this.receiving = true;
        try {
          this.receive(message);
        } finally {
          this.receiving = false;
        }
      },
      close: () => {
        this.asked.clear();
        this.set({ connected: false });
      },
    });
  }

  stop(): void {
    this.line?.close();
    clearTimeout(this.flush);
    for (const timer of this.draftTimers.values()) clearTimeout(timer);
  }

  private send(message: ClientMessage): boolean {
    return this.line?.send(message) ?? false;
  }

  /** Say it and mean it: what did not go is said at the foot. */
  private ask(message: ClientMessage): boolean {
    if (this.send(message)) return true;
    this.set({ notice: "Not connected — that did not go through; try again once ruri is back." });
    return false;
  }

  private receive(message: ServerMessage): void {
    const before = this.state;
    const next = reduce(before, message);
    let edits = before.edits;
    switch (message.type) {
      case "snapshot": {
        // unsent prompts come back where they were left; a box already
        // holding words wins over the stored copy
        edits = { ...edits };
        for (const [chatId, text] of Object.entries(next.drafts)) {
          if (!edits[chatId]?.text) edits[chatId] = at(text);
        }
        this.set({ ...next, edits });
        this.asked.clear();
        this.watch();
        for (const chatId of [...this.unsaved]) this.saveDraft(chatId);
        return;
      }
      case "composer_draft": {
        // typed on another device: taken, unless this box was typed in a
        // moment ago
        const typed = this.now() - (this.typedAt.get(message.projectId) ?? 0) < TYPING_MS;
        if (!typed && (edits[message.projectId]?.text ?? "") !== message.text) {
          edits = { ...edits, [message.projectId]: at(message.text) };
        }
        break;
      }
      case "compose":
      case "review_prompt":
        edits = { ...edits, [message.projectId]: this.appended(message.projectId, message.text) };
        break;
      case "transcript":
        this.asked.delete(message.projectId);
        break;
      case "sent": {
        const out = this.outbox.get(message.clientId);
        this.outbox.delete(message.clientId);
        // it never went: the words go back where they were written
        if (out && message.as === "failed") {
          this.set({
            ...next,
            edits: { ...edits, [out.chatId]: this.appended(out.chatId, out.text) },
            notice: "That prompt did not go through — it is back in the prompt box.",
          });
          return;
        }
        break;
      }
      case "projects":
        // sent Home because its project closed: Home's chat is asked for
        if (next.activeId !== before.activeId) {
          this.set({ ...next, edits });
          this.watch();
          return;
        }
        break;
      default:
        break;
    }
    if (next !== before || edits !== before.edits) this.set({ ...next, edits });
  }

  /** Words handed to a box, after whatever it already holds. */
  private appended(chatId: string, text: string): Edit {
    const held = this.state.edits[chatId]?.text ?? "";
    return at(held.trim() ? `${held}\n${text}` : text);
  }

  /** Tell the server what is on screen, and ask for it whole. */
  private watch(): void {
    const chatId = this.state.activeId;
    this.send({ type: "view", channels: [chatId], live: true, awake: true });
    if (!this.state.loaded[chatId] && !this.asked.has(chatId)) {
      if (this.send({ type: "transcript_get", projectId: chatId })) this.asked.add(chatId);
    }
  }

  /* ── what the keys ask ──────────────────────────────────────────── */

  /** Put a chat on screen. */
  open(chatId: string): void {
    const { [chatId]: _read, ...unread } = this.state.unread;
    this.set({ activeId: chatId, unread });
    this.watch();
  }

  dismissNotice(): void {
    if (this.state.notice !== undefined) this.set({ notice: undefined });
  }

  /** The prompt box changed under the user's keys. */
  edit(chatId: string, edit: Edit): void {
    const before = this.state.edits[chatId] ?? EMPTY;
    this.set({ edits: { ...this.state.edits, [chatId]: edit } });
    if (edit.text === before.text) return;
    this.typedAt.set(chatId, this.now());
    clearTimeout(this.draftTimers.get(chatId));
    this.draftTimers.set(
      chatId,
      setTimeout(() => this.saveDraft(chatId), DRAFT_MS),
    );
  }

  private saveDraft(chatId: string): void {
    this.draftTimers.delete(chatId);
    const text = this.state.edits[chatId]?.text ?? "";
    // no word of attachments: the files a desktop draft holds stay on it
    if (this.send({ type: "draft", projectId: chatId, text })) this.unsaved.delete(chatId);
    else this.unsaved.add(chatId);
  }

  /** Send what is in a chat's box: it starts a turn, or joins the queue
   *  behind the one running. `now` cuts in on the running turn. */
  prompt(chatId: string, now = false): boolean {
    const text = (this.state.edits[chatId]?.text ?? "").trim();
    if (!text) return false;
    const clientId = randomUUID();
    if (
      !this.ask({ type: "send", projectId: chatId, text, clientId, ...(now ? { now: true as const } : {}) })
    ) {
      return false;
    }
    this.outbox.set(clientId, { chatId, text });
    clearTimeout(this.draftTimers.get(chatId));
    this.draftTimers.delete(chatId);
    this.typedAt.delete(chatId);
    // the draft goes with it, on every device, at once
    if (!this.send({ type: "draft", projectId: chatId, text: "", attachments: [] })) this.unsaved.add(chatId);
    this.set({ edits: { ...this.state.edits, [chatId]: EMPTY } });
    return true;
  }

  interrupt(chatId: string): void {
    this.ask({ type: "interrupt", projectId: chatId });
  }

  private cardGone(requestId: string): void {
    this.set({ permissions: this.state.permissions.filter((p) => p.requestId !== requestId) });
  }

  answerPermission(requestId: string, allow: boolean, always = false): void {
    if (this.ask({ type: "permission_response", requestId, allow, ...(always ? { always } : {}) })) {
      this.cardGone(requestId);
    }
  }

  answerQuestion(requestId: string, answers?: AskAnswers): void {
    if (this.ask({ type: "question_response", requestId, ...(answers ? { answers } : {}) })) {
      this.cardGone(requestId);
    }
  }

  nameComponent(requestId: string, name?: string): void {
    if (this.ask({ type: "component_named", requestId, ...(name ? { name } : { skip: true }) })) {
      this.cardGone(requestId);
    }
  }

  /** A chat's own model, effort or permission mode. */
  pick(chatId: string, setting: "model" | "effort" | "permissionMode", value: string): void {
    const message: ClientMessage =
      setting === "model"
        ? { type: "set_model", projectId: chatId, model: value }
        : setting === "effort"
          ? { type: "set_effort", projectId: chatId, effort: value }
          : { type: "set_permission_mode", projectId: chatId, mode: value as PermissionMode };
    if (!this.ask(message)) return;
    // shown at once; the server's own word follows and stands
    if (chatId === HOME_ID) {
      this.set({ home: { ...this.state.home, [setting]: value } });
      return;
    }
    this.set({
      projects: this.state.projects.map((p) =>
        p.sessions.some((x) => x.id === chatId)
          ? { ...p, sessions: p.sessions.map((x) => (x.id === chatId ? { ...x, [setting]: value } : x)) }
          : p,
      ),
    });
  }

  /** The account a chat spends from: its own over its project's, and the
   *  project's again by picking the project's. Home's is Home's. */
  pickAccount(chatId: string, account: AccountInfo): void {
    const provider = account.provider;
    if (chatId === HOME_ID) {
      if (!this.ask({ type: "set_account", projectId: HOME_ID, account: account.id })) return;
      const { accounts: picks, ...rest } = this.state.home;
      const next = withPick(picks, account);
      this.set({ home: { ...rest, ...(next ? { accounts: next } : {}) } });
      return;
    }
    const project = projectOf(this.state, chatId);
    if (!project) return;
    const theirs = accountIn(this.state.accounts, picksOf(this.state, chatId), provider);
    const own = account.id !== theirs ? account.id : undefined;
    if (!this.ask({ type: "set_chat_account", chatId, provider, ...(own ? { account: own } : {}) })) return;
    this.set({
      projects: this.state.projects.map((p) =>
        p.id !== project.id
          ? p
          : {
              ...p,
              sessions: p.sessions.map((x) => {
                if (x.id !== chatId) return x;
                const { accounts: picks, ...rest } = x;
                const next = { ...picks };
                if (own) next[provider] = own;
                else delete next[provider];
                return { ...rest, ...(Object.keys(next).length > 0 ? { accounts: next } : {}) };
              }),
            },
      ),
    });
  }

  /** Send a queued prompt now, in place of the running turn. */
  queueNow(chatId: string, itemId: string): void {
    this.ask({ type: "queue_now", projectId: chatId, itemId });
  }

  queueRemove(chatId: string, itemId: string): void {
    this.ask({ type: "queue_remove", projectId: chatId, itemId });
  }

  /** Take a queued prompt back into the box to rewrite it. */
  queueEdit(chatId: string, itemId: string): void {
    const item = this.state.queued[chatId]?.find((q) => q.id === itemId);
    if (!item || !this.ask({ type: "queue_remove", projectId: chatId, itemId })) return;
    this.edit(chatId, this.appended(chatId, item.text));
  }

  /** Let a held queue go on. */
  queueResume(chatId: string): void {
    this.ask({ type: "queue_send", projectId: chatId });
  }

  /** Fold a sidebar folder shut, or open: on every device, as the desktop's. */
  fold(folderId: string, collapsed: boolean): void {
    if (!this.ask({ type: "folder_set", folderId, collapsed })) return;
    this.set({
      sidebar: {
        ...this.state.sidebar,
        folders: this.state.sidebar.folders.map((f) => {
          if (f.id !== folderId) return f;
          const { collapsed: _was, ...rest } = f;
          return collapsed ? { ...rest, collapsed: true } : rest;
        }),
      },
    });
  }
}
