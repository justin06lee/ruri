import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "./configDir.js";
import type { SubagentState, TranscriptEvent } from "../shared/protocol.js";

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
  return configPath("agents");
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

  /** Add an event to an agent's log, or replace the one with its id —
   *  true when it was new. */
  append(channelId: string, key: string, event: TranscriptEvent): boolean {
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
    if (!this.timers.has(id)) {
      const timer = setTimeout(() => this.write(channelId, key), WRITE_DELAY_MS);
      timer.unref?.();
      this.timers.set(id, timer);
    }
    return at === -1;
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

/** The crew's file in a chat's directory. No agent's log can have this
 *  name: `safe` turns every "@" in a key into "_". */
const CREW_FILE = "@crew.json";

/** One of the user's own agents: its card, and what resumes it. */
interface CrewMember {
  agent: SubagentState;
  /** The harness session a follow-up picks up. */
  sessionId?: string;
}

/**
 * The agents the user starts themselves, from a chat's agents page — its
 * crew. Each is a conversation of its own that logs here the way a
 * harness's agents do (AgentLogs, under its card's key); what this keeps is
 * its card and the session id a follow-up resumes, one file per chat beside
 * the logs, so a deleted chat takes its crew with it. A chat's crew is read
 * the first time it is wanted — and a card still running then is from a run
 * that is over: it was stopped.
 */
export class Crew {
  private readonly chats = new Map<string, CrewMember[]>();
  /** Which chat each agent belongs to (every chat read so far). */
  private readonly owners = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private file(chatId: string): string {
    return path.join(agentsDir(), safe(chatId), CREW_FILE);
  }

  private load(chatId: string): CrewMember[] {
    let members = this.chats.get(chatId);
    if (members) return members;
    members = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(chatId), "utf8")) as unknown;
      if (Array.isArray(raw)) {
        members = (raw as CrewMember[]).map(
          (member): CrewMember =>
            member.agent.status === "running"
              ? { ...member, agent: { ...member.agent, status: "stopped", endedAt: member.agent.endedAt ?? Date.now() } }
              : member,
        );
      }
    } catch {
      // no crew yet
    }
    this.chats.set(chatId, members);
    for (const member of members) this.owners.set(member.agent.key, chatId);
    return members;
  }

  /** A chat's crew, oldest first. */
  list(chatId: string): SubagentState[] {
    return this.load(chatId).map((member) => member.agent);
  }

  /** Every chat's crew, for the chats that have one. */
  all(chatIds: string[]): Record<string, SubagentState[]> {
    const out: Record<string, SubagentState[]> = {};
    for (const chatId of chatIds) {
      const agents = this.list(chatId);
      if (agents.length > 0) out[chatId] = agents;
    }
    return out;
  }

  /** The chat an agent belongs to. */
  owner(key: string): string | undefined {
    return this.owners.get(key);
  }

  member(key: string): CrewMember | undefined {
    const chatId = this.owners.get(key);
    return chatId === undefined ? undefined : this.load(chatId).find((member) => member.agent.key === key);
  }

  add(chatId: string, agent: SubagentState): void {
    this.load(chatId).push({ agent });
    this.owners.set(agent.key, chatId);
    this.save(chatId);
  }

  /** Move a card along; false when there is no such agent. */
  update(key: string, patch: Partial<SubagentState>): boolean {
    const member = this.member(key);
    if (!member) return false;
    member.agent = { ...member.agent, ...patch };
    this.save(this.owners.get(key)!);
    return true;
  }

  sessionId(key: string): string | undefined {
    return this.member(key)?.sessionId;
  }

  setSessionId(key: string, sessionId: string): void {
    const member = this.member(key);
    if (!member || member.sessionId === sessionId) return;
    member.sessionId = sessionId;
    this.save(this.owners.get(key)!);
  }

  /** A deleted chat's crew: forgotten here, with its keys handed back so
   *  their sessions can be closed. The file goes with the chat's directory
   *  (AgentLogs.remove), which is why this goes first. */
  remove(chatId: string): string[] {
    clearTimeout(this.timers.get(chatId));
    this.timers.delete(chatId);
    const keys = this.list(chatId).map((agent) => agent.key);
    for (const key of keys) this.owners.delete(key);
    this.chats.delete(chatId);
    return keys;
  }

  private save(chatId: string): void {
    if (this.timers.has(chatId)) return;
    const timer = setTimeout(() => this.write(chatId), WRITE_DELAY_MS);
    timer.unref?.();
    this.timers.set(chatId, timer);
  }

  private write(chatId: string): void {
    clearTimeout(this.timers.get(chatId));
    this.timers.delete(chatId);
    const members = this.chats.get(chatId);
    if (!members) return;
    const file = this.file(chatId);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(members));
      fs.renameSync(tmp, file);
    } catch {
      // the cards are a view onto the work: a lost write costs a stale card
    }
  }

  /** Write everything pending now (shutdown). */
  flushAll(): void {
    for (const chatId of [...this.timers.keys()]) this.write(chatId);
  }
}
