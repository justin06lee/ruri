import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * Subagent logs: everything an agent a harness started did — its brief,
 * what it said, every tool it ran — kept apart from the chat that started
 * it, one file per agent: ~/.config/ruri/agents/<channel>/<key>.json. The
 * chat holds only the agent's card (the spawning tool call's event, carrying
 * its SubagentState); the card opens this.
 *
 * Written on a debounce, like the archive. A log is held in memory only
 * while it has writes pending — a finished agent's is read back from disk
 * when someone opens it — and capped, so an agent that runs a thousand tools
 * keeps its newest AGENT_LOG_MAX events.
 */

const AGENT_LOG_MAX = 1500;
const WRITE_DELAY_MS = 800;

/** When this server started: a log last written before it is from a run
 *  whose processes are gone, so an agent it still calls running isn't. */
const STARTED = Date.now();

function agentsDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "agents",
  );
}

/** Ids come from harnesses; nothing in one is allowed to walk the tree. */
function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160) || "_";
}

/** An agent card left running by a run that is over: it was stopped. */
export function settleAgent(event: TranscriptEvent): TranscriptEvent {
  if (event.kind !== "tool" || event.agent?.status !== "running") return event;
  return { ...event, agent: { ...event.agent, status: "stopped" } };
}

export class AgentLogs {
  private readonly live = new Map<string, TranscriptEvent[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private file(channelId: string, key: string): string {
    return path.join(agentsDir(), safe(channelId), `${safe(key)}.json`);
  }

  private id(channelId: string, key: string): string {
    return `${channelId}\u0000${key}`;
  }

  /** The agent's log so far — empty for one nothing was kept for. */
  read(channelId: string, key: string): TranscriptEvent[] {
    const held = this.live.get(this.id(channelId, key));
    if (held) return held;
    const file = this.file(channelId, key);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      const events = raw as TranscriptEvent[];
      return fs.statSync(file).mtimeMs < STARTED ? events.map(settleAgent) : events;
    } catch {
      return [];
    }
  }

  /** Add an event to an agent's log, or replace the one with its id. */
  append(channelId: string, key: string, event: TranscriptEvent): void {
    const id = this.id(channelId, key);
    let log = this.live.get(id);
    if (!log) {
      log = [...this.read(channelId, key)];
      this.live.set(id, log);
    }
    const at = log.findIndex((candidate) => candidate.id === event.id);
    if (at === -1) log.push(event);
    else log[at] = event;
    if (log.length > AGENT_LOG_MAX) log.splice(0, log.length - AGENT_LOG_MAX);
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => this.write(channelId, key), WRITE_DELAY_MS);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private write(channelId: string, key: string): void {
    const id = this.id(channelId, key);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const log = this.live.get(id);
    this.live.delete(id);
    if (!log) return;
    const file = this.file(channelId, key);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(log));
      fs.renameSync(tmp, file);
    } catch {
      // a log is a window onto the work, not the work: losing a write
      // costs a view of it, never the conversation
    }
  }

  /** Write everything pending now (shutdown). */
  flushAll(): void {
    for (const id of [...this.timers.keys()]) {
      const [channelId, key] = id.split("\u0000") as [string, string];
      this.write(channelId, key);
    }
  }

  /** A deleted chat takes its agents' logs with it. */
  remove(channelId: string): void {
    for (const id of [...this.timers.keys()]) {
      if (!id.startsWith(`${channelId}\u0000`)) continue;
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.live.delete(id);
    }
    fs.rmSync(path.join(agentsDir(), safe(channelId)), { recursive: true, force: true });
  }
}
