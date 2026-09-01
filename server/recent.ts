import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { Project, RecentSession, TranscriptEvent } from "../shared/protocol.js";
import { readImage, toolSummary } from "./sessions.js";

/**
 * The chats that happened outside ruri.
 *
 * A project's sessions do not all start in the sidebar: a `claude` in a
 * terminal, a `codex` in another, and the work they did is sitting in the
 * harness's own session files — resumable, but invisible from here. This
 * reads those files: which sessions exist for a project (by working
 * directory), what each one was about, and — when one is picked — its
 * conversation as transcript events, so it opens in ruri looking like it
 * always lived here, and the next prompt resumes the real thing.
 *
 * Only what ruri did not make is offered: a session ruri itself started
 * is already a chat in the sidebar (or was, and was closed on purpose).
 */

const RECENT_DAYS = 45;
const LIST_LIMIT = 24;

/**
 * What the user actually said, with the harness's own wrapping taken off:
 * the leading <tag>…</tag> blocks a CLI puts in front of a prompt (a
 * compaction brief, a command echo, a system reminder). Empty when there
 * was nothing of the user's in it at all.
 */
function humanText(text: string): string {
  let t = text.trim();
  for (;;) {
    const block = /^<([a-z][\w:-]*)(?:\s[^>]*)?>[^]*?<\/\1>\s*/i.exec(t);
    if (!block) break;
    t = t.slice(block[0].length).trimStart();
  }
  return t;
}

/** A title the way a person would want it: the first thing said, short. */
function titleOf(text: string): string {
  const flat = humanText(text).replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 89).trimEnd()}…` : flat;
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return fs.realpathSync(p).replace(/\/+$/, "");
    } catch {
      return path.resolve(p).replace(/\/+$/, "");
    }
  };
  return norm(a) === norm(b);
}

/* ── Claude ─────────────────────────────────────────────────────── */

async function listClaude(project: Project, taken: Set<string>): Promise<RecentSession[]> {
  try {
    const sessions = await listSessions({ dir: project.path, limit: 60 });
    return sessions
      .filter((s) => !taken.has(s.sessionId))
      .map((s) => ({
        id: s.sessionId,
        provider: "claude" as const,
        title: titleOf(s.customTitle ?? s.firstPrompt ?? s.summary ?? "") || "untitled",
        at: s.lastModified,
        ...(s.gitBranch ? { branch: s.gitBranch } : {}),
      }))
      ;
  } catch {
    return [];
  }
}

/** Where the CLI keeps a project's transcripts: the path, every
 *  non-alphanumeric turned to a dash. Falls back to a scan when the CLI's
 *  own encoding differs from this guess. */
function claudeSessionFile(project: Project, sessionId: string): string | undefined {
  const root = path.join(os.homedir(), ".claude", "projects");
  const guess = path.join(root, project.path.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (fs.existsSync(guess)) return guess;
  try {
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    // no projects dir
  }
  return undefined;
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

/** The conversation in a Claude session file, as ruri's transcript events. */
function readClaude(project: Project, file: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return events;
  }
  let inTurn = false;
  let lastTs = Date.now();
  const closeTurn = () => {
    if (!inTurn) return;
    events.push({ kind: "result", id: randomUUID(), ok: true, ts: lastTs });
    inTurn = false;
  };
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: ClaudeLine;
    try {
      entry = JSON.parse(line) as ClaudeLine;
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) continue;
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : lastTs;
    if (Number.isFinite(ts)) lastTs = ts;
    const content = entry.message?.content;
    if (entry.type === "user") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null)
                .filter((b) => b.type === "text" && typeof b.text === "string")
                .map((b) => b.text!)
                .join("\n")
            : "";
      const said = humanText(text);
      if (!said) continue;
      closeTurn();
      events.push({ kind: "user", id: randomUUID(), text: said, ts: lastTs });
      inTurn = true;
    } else if (entry.type === "assistant" && Array.isArray(content)) {
      const blocks = content.filter(
        (b): b is Record<string, unknown> & { type: string } => typeof b === "object" && b !== null,
      );
      const text = blocks
        .filter((b) => b.type === "text" && typeof b["text"] === "string")
        .map((b) => b["text"] as string)
        .join("");
      if (text.trim()) events.push({ kind: "assistant", id: randomUUID(), text, ts: lastTs });
      for (const block of blocks) {
        if (block.type !== "tool_use") continue;
        const name = typeof block["name"] === "string" ? (block["name"] as string) : "tool";
        const input = (block["input"] ?? {}) as Record<string, unknown>;
        const image = readImage(name, input);
        events.push({
          kind: "tool",
          id: randomUUID(),
          name,
          summary: toolSummary(name, input, project),
          ...(image ? { image } : {}),
          ts: lastTs,
        });
      }
    }
  }
  closeTurn();
  return events;
}

/* ── Codex ──────────────────────────────────────────────────────── */

function codexHome(): string {
  return process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
}

/** Every rollout written in the last while, newest first. */
function recentRollouts(): string[] {
  const root = path.join(codexHome(), "sessions");
  const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
  const files: Array<{ file: string; at: number }> = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        try {
          const at = fs.statSync(full).mtimeMs;
          if (at >= cutoff) files.push({ file: full, at });
        } catch {
          // unreadable — skip
        }
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.at - a.at).map((f) => f.file);
}

interface CodexMeta {
  id?: string;
  cwd?: string;
  source?: string;
  originator?: string;
}

/** The session_meta line at the top of a rollout. */
function rolloutMeta(file: string): CodexMeta | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.toString("utf8", 0, n);
      const line = head.split("\n").find((l) => l.includes('"session_meta"'));
      if (!line) return undefined;
      const entry = JSON.parse(line) as { payload?: CodexMeta & { session_id?: string } };
      const p = entry.payload ?? {};
      return { ...p, id: p.id ?? p.session_id };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown> & { type?: string };
}

function rolloutLines(file: string): RolloutLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines: RolloutLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      lines.push(JSON.parse(line) as RolloutLine);
    } catch {
      // a half-written last line
    }
  }
  return lines;
}

/** The text of a Codex message payload's content blocks. */
function codexText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null)
    .filter((b) => (b.type === "input_text" || b.type === "output_text") && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

/** What a Codex tool call did, in one line the chip can show. */
function codexTool(payload: Record<string, unknown>): { name: string; summary: string } {
  const name = typeof payload["name"] === "string" ? (payload["name"] as string) : "tool";
  const input = payload["input"] ?? payload["arguments"];
  let summary = "";
  if (typeof input === "string") {
    // the exec tool's script carries the command in a JSON string; anything
    // else is shown as its first line
    const cmd = /"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
    if (cmd?.[1]) {
      try {
        summary = JSON.parse(`"${cmd[1]}"`) as string;
      } catch {
        summary = cmd[1];
      }
    } else {
      try {
        const parsed = JSON.parse(input) as Record<string, unknown>;
        const command = parsed["command"] ?? parsed["cmd"];
        summary = Array.isArray(command) ? command.join(" ") : typeof command === "string" ? command : input;
      } catch {
        summary = input;
      }
    }
  }
  const flat = summary.replace(/\s+/g, " ").trim();
  return {
    name: name === "exec" || name === "shell" || name === "exec_command" ? "Bash" : name,
    summary: flat.length > 200 ? `${flat.slice(0, 199)}…` : flat,
  };
}

function listCodex(project: Project, taken: Set<string>): RecentSession[] {
  const out: RecentSession[] = [];
  for (const file of recentRollouts()) {
    const meta = rolloutMeta(file);
    if (!meta?.id || !meta.cwd || !sameDir(meta.cwd, project.path)) continue;
    // programmatic runs are somebody's app (ruri's own, through yagami)
    if (meta.source === "exec" || meta.originator?.includes("exec")) continue;
    if (taken.has(`codex:${meta.id}`)) continue;
    let title = "";
    for (const line of rolloutLines(file)) {
      const p = line.payload;
      if (!p) continue;
      if (line.type === "event_msg" && p.type === "user_message" && typeof p["message"] === "string") {
        title = p["message"];
        break;
      }
      if (line.type === "response_item" && p.type === "message" && p["role"] === "user") {
        const text = humanText(codexText(p["content"]));
        if (text) {
          title = text;
          break;
        }
      }
    }
    let at = Date.now();
    try {
      at = fs.statSync(file).mtimeMs;
    } catch {
      // keep now
    }
    out.push({ id: `codex:${meta.id}`, provider: "codex", title: titleOf(title) || "untitled", at });
    if (out.length >= LIST_LIMIT) break;
  }
  return out;
}

/** The rollout for one Codex session id, wherever it sits under sessions/. */
function codexFile(sessionId: string): string | undefined {
  return recentRollouts().find((f) => path.basename(f).includes(sessionId)) ?? scanFor(sessionId);
}

function scanFor(sessionId: string): string | undefined {
  const root = path.join(codexHome(), "sessions");
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) return full;
    }
  }
  return undefined;
}

function readCodex(file: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  let inTurn = false;
  let lastTs = Date.now();
  const seenCalls = new Set<string>();
  for (const line of rolloutLines(file)) {
    const p = line.payload;
    if (!p) continue;
    const ts = line.timestamp ? Date.parse(line.timestamp) : lastTs;
    if (Number.isFinite(ts)) lastTs = ts;
    if (line.type === "response_item") {
      if (p.type === "message") {
        const text = codexText(p["content"]);
        if (p["role"] === "user") {
          const said = humanText(text);
          if (!said) continue;
          if (inTurn) events.push({ kind: "result", id: randomUUID(), ok: true, ts: lastTs });
          events.push({ kind: "user", id: randomUUID(), text: said, ts: lastTs });
          inTurn = true;
        } else if (p["role"] === "assistant" && text.trim()) {
          events.push({ kind: "assistant", id: randomUUID(), text, ts: lastTs });
        }
      } else if (p.type === "custom_tool_call" || p.type === "function_call") {
        const callId = typeof p["call_id"] === "string" ? (p["call_id"] as string) : randomUUID();
        if (seenCalls.has(callId)) continue;
        seenCalls.add(callId);
        events.push({ kind: "tool", id: randomUUID(), ...codexTool(p), ts: lastTs });
      }
    } else if (line.type === "event_msg" && p.type === "task_complete" && inTurn) {
      events.push({ kind: "result", id: randomUUID(), ok: true, ts: lastTs });
      inTurn = false;
    }
  }
  if (inTurn) events.push({ kind: "result", id: randomUUID(), ok: true, ts: lastTs });
  return events;
}

/* ── the two doors ──────────────────────────────────────────────── */

/** Sessions on disk for this project that ruri did not make, newest first. */
export async function listRecent(project: Project, taken: Set<string>): Promise<RecentSession[]> {
  const [claude, codex] = await Promise.all([listClaude(project, taken), listCodex(project, taken)]);
  return [...claude, ...codex].sort((a, b) => b.at - a.at).slice(0, LIST_LIMIT);
}

/**
 * One session's conversation as transcript events, plus the id the next
 * prompt resumes it by (bare for Claude, "codex:…" for Codex). Null when
 * the file is gone.
 */
export function importRecent(
  project: Project,
  id: string,
): { events: TranscriptEvent[]; resume: string; provider: "claude" | "codex" } | null {
  if (id.startsWith("codex:")) {
    const file = codexFile(id.slice("codex:".length));
    if (!file) return null;
    return { events: readCodex(file), resume: id, provider: "codex" };
  }
  const file = claudeSessionFile(project, id);
  if (!file) return null;
  return { events: readClaude(project, file), resume: id, provider: "claude" };
}
