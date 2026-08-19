import { randomUUID } from "node:crypto";
import {
  claudeCodeSession,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "yagami";
import type {
  PermissionRequest,
  Project,
  ProjectStatus,
  TranscriptEvent,
} from "../shared/protocol.js";

type PermissionResult = Awaited<ReturnType<CanUseTool>>;

export interface SessionEvents {
  onEvent(projectId: string, event: TranscriptEvent): void;
  onDelta(projectId: string, messageId: string, delta: string): void;
  onStatus(projectId: string, status: ProjectStatus): void;
  onPermission(request: PermissionRequest): void;
  onPermissionResolved(requestId: string): void;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.buffer.push(item);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  let summary: string | undefined;
  switch (name) {
    case "Bash":
      summary = str("command");
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      summary = str("file_path");
      break;
    case "Glob":
    case "Grep":
      summary = [str("pattern"), str("path")].filter(Boolean).join(" in ");
      break;
    case "WebFetch":
      summary = str("url");
      break;
    case "WebSearch":
      summary = str("query");
      break;
    case "Agent":
    case "Task":
      summary = str("description") ?? str("prompt");
      break;
    case "Skill":
      summary = str("skill") ?? str("command");
      break;
  }
  summary ??= JSON.stringify(input);
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

class ProjectSession {
  readonly transcript: TranscriptEvent[];
  status: ProjectStatus = "idle";
  lastSessionId: string | undefined;
  dead = false;

  private readonly queue = new AsyncQueue<SDKUserMessage>();
  private readonly query: Query;
  private draftId: string | null = null;
  private readonly pending = new Map<string, (result: PermissionResult) => void>();

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    priorTranscript: TranscriptEvent[] = [],
    resume?: string,
  ) {
    this.transcript = priorTranscript;
    this.lastSessionId = resume;
    this.query = claudeCodeSession(this.queue, {
      options: {
        cwd: project.path,
        includePartialMessages: true,
        canUseTool: this.canUseTool,
        ...(resume ? { resume } : {}),
      },
    });
    void this.run();
  }

  send(text: string): void {
    this.pushEvent({ kind: "user", id: randomUUID(), text, ts: Date.now() });
    this.setStatus("working");
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  }

  interrupt(): void {
    void this.query.interrupt().catch(() => {});
  }

  dispose(): void {
    this.dead = true;
    this.queue.end();
    void this.query.interrupt().catch(() => {});
    this.rejectAllPending();
  }

  respondPermission(requestId: string, allow: boolean): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    this.pending.delete(requestId);
    resolve(
      allow
        ? { behavior: "allow" }
        : { behavior: "deny", message: "The user denied this tool use in ruri." },
    );
    this.events.onPermissionResolved(requestId);
    if (this.pending.size === 0 && this.status === "permission") this.setStatus("working");
    return true;
  }

  pendingRequests(): string[] {
    return [...this.pending.keys()];
  }

  private canUseTool: CanUseTool = (toolName, input, { signal }) =>
    new Promise<PermissionResult>((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, resolve);
      this.setStatus("permission");
      this.events.onPermission({
        requestId,
        projectId: this.project.id,
        toolName,
        input,
        ts: Date.now(),
      });
      signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(requestId)) return;
          this.pending.delete(requestId);
          resolve({ behavior: "deny", message: "aborted" });
          this.events.onPermissionResolved(requestId);
        },
        { once: true },
      );
    });

  private async run(): Promise<void> {
    try {
      for await (const msg of this.query) this.handle(msg);
    } catch (err) {
      this.pushEvent({
        kind: "info",
        id: randomUUID(),
        text: `session error: ${err instanceof Error ? err.message : String(err)}`,
        ts: Date.now(),
      });
      this.setStatus("error");
    } finally {
      this.dead = true;
      this.rejectAllPending();
    }
  }

  private handle(msg: SDKMessage): void {
    if (msg.type === "system" && msg.subtype === "init") {
      this.lastSessionId = msg.session_id;
    } else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
      const event = msg.event as { type: string; delta?: { type?: string; text?: string } };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        this.draftId ??= randomUUID();
        this.events.onDelta(this.project.id, this.draftId, event.delta.text);
      }
    } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      const blocks =
        (msg.message as unknown as { content?: Array<Record<string, unknown> & { type: string }> })
          .content ?? [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
        .join("");
      if (text) {
        this.pushEvent({ kind: "assistant", id: this.draftId ?? randomUUID(), text, ts: Date.now() });
      }
      this.draftId = null;
      for (const block of blocks) {
        if (block.type === "tool_use") {
          const name = typeof block["name"] === "string" ? (block["name"] as string) : "tool";
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          this.pushEvent({
            kind: "tool",
            id: randomUUID(),
            name,
            summary: toolSummary(name, input),
            ts: Date.now(),
          });
        }
      }
    } else if (msg.type === "result") {
      this.lastSessionId = msg.session_id;
      this.draftId = null;
      const ok = msg.subtype === "success";
      this.pushEvent({
        kind: "result",
        id: randomUUID(),
        ok,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        ...(ok ? {} : { error: "errors" in msg && msg.errors.length > 0 ? msg.errors.join("; ") : msg.subtype }),
        ts: Date.now(),
      });
      this.setStatus("idle");
    }
  }

  private pushEvent(event: TranscriptEvent): void {
    this.transcript.push(event);
    this.events.onEvent(this.project.id, event);
  }

  private setStatus(status: ProjectStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(this.project.id, status);
  }

  private rejectAllPending(): void {
    for (const [requestId, resolve] of this.pending) {
      resolve({ behavior: "deny", message: "session ended" });
      this.events.onPermissionResolved(requestId);
    }
    this.pending.clear();
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, ProjectSession>();

  constructor(private readonly events: SessionEvents) {}

  /** Send a message, starting (or restarting, resuming context) the session as needed. */
  send(project: Project, text: string): void {
    let session = this.sessions.get(project.id);
    if (!session || session.dead) {
      session = new ProjectSession(
        project,
        this.events,
        session?.transcript ?? [],
        session?.lastSessionId,
      );
      this.sessions.set(project.id, session);
    }
    session.send(text);
  }

  interrupt(projectId: string): void {
    this.sessions.get(projectId)?.interrupt();
  }

  respondPermission(requestId: string, allow: boolean): void {
    for (const session of this.sessions.values()) {
      if (session.respondPermission(requestId, allow)) return;
    }
  }

  dispose(projectId: string): void {
    this.sessions.get(projectId)?.dispose();
    this.sessions.delete(projectId);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  transcripts(): Record<string, TranscriptEvent[]> {
    return Object.fromEntries([...this.sessions].map(([id, s]) => [id, s.transcript]));
  }

  statuses(): Record<string, ProjectStatus> {
    return Object.fromEntries([...this.sessions].map(([id, s]) => [id, s.status]));
  }
}
