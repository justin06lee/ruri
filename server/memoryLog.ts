import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  MemoryAnchors,
  MemoryLine,
  MemoryPart,
  MemorySource,
  ProjectMemory,
} from "../shared/protocol.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";
import { lineRefusal } from "./memoryQuality.js";
import { dayOf, emptyMemory, LAYER_CAPS, MEMORY_CAPS, MEMORY_PARTS, newLineId } from "./memoryLines.js";

/**
 * A project's working memory as a log of what happened to it, and the
 * memory as it stands read off the log.
 *
 * The memory used to be one list in briefs.json, rewritten in place: a
 * fold that left a line out deleted it, a full part dropped its oldest
 * line to make room, and nothing said what a line had said before, who
 * changed it, or why. Rewriting a memory whole is also how memories
 * collapse — the model shortens, merges and drops a little more each time
 * (ACE's "context collapse": 18,282 tokens to 122 in one rewrite). So now
 * nothing rewrites it. Every change is an event — added, reworded, moved,
 * superseded by a newer line, retired with a reason, archived past a cap,
 * restored, pinned, flagged as maybe stale, checked again — with who did
 * it (the user, an agent, the model, ruri itself), the exchange or fold it
 * came from, and the reason and evidence it gave; the events are appended
 * to ~/.config/ruri/memory/<project>.jsonl and never rewritten.
 *
 * The memory every session reads is the current lines, written into
 * briefs.json (`memory`, with the log's last event as `memorySeq`) and
 * from there into catchup.md and the layers' sheets, exactly as before. A
 * line that leaves it — superseded, retired, archived — stays in the log
 * with when it stopped holding and why: `ruri memory log` shows a line's
 * history, `ruri recall` searches it, `ruri memory restore` brings one
 * back, and a fold can be taken back whole.
 *
 * Who may do what is decided here, for every writer alike: the user
 * anything; an agent may add, and retire or supersede what isn't the
 * user's; the model may add, reword and retire its own lines, and an
 * agent's only with a reason and evidence — never the user's, never a
 * pinned one, and never many at once.
 */

export type MemoryStatus = "current" | "archived" | "retired" | "superseded";

/** Who changed the memory: the user, an agent (`ruri note`), the model
 *  (a fold, a check), or ruri itself (a cap, an import). */
export interface Actor {
  by: MemoryLine["by"] | "system";
  /** The chat whose agent or turn it was. */
  chat?: string;
  /** The fold or check it belongs to — undone together. */
  fold?: string;
}

/** A line with everything the log knows of it. */
export interface LineRecord extends MemoryLine {
  part: MemoryPart;
  status: MemoryStatus;
  /** Its place in its part: lower reads first. */
  rank: number;
  /** When it stopped holding (ms). */
  invalidAt?: number;
  /** The line that replaced it. */
  supersededBy?: string;
  /** Why it left the current memory. */
  reason?: string;
}

export type MemoryOp =
  | "import"
  | "add"
  | "edit"
  | "supersede"
  | "merge"
  | "retire"
  | "archive"
  | "restore"
  | "pin"
  | "unpin"
  | "flag"
  | "verify"
  | "confirm"
  | "undo";

/** One thing that happened to one line, and the line after it. */
export interface MemoryEvent {
  seq: number;
  at: number;
  op: MemoryOp;
  line: string;
  by: Actor["by"];
  chat?: string;
  fold?: string;
  reason?: string;
  evidence?: string;
  after: LineRecord;
}

/** A change asked of the memory. */
export type MemoryChange =
  | {
      op: "add";
      part: MemoryPart;
      text: string;
      why?: string;
      layer?: string;
      source?: MemorySource;
      anchors?: MemoryAnchors;
      quarantined?: boolean;
      pinned?: boolean;
    }
  | {
      op: "edit";
      line: string;
      text?: string;
      /** null takes the reason off. */
      why?: string | null;
      part?: MemoryPart;
      /** null files it across the project. */
      layer?: string | null;
      /** The line becomes the actor's own (the user correcting one). */
      claim?: boolean;
      pinned?: boolean;
      reason?: string;
    }
  | {
      op: "supersede";
      line: string;
      text: string;
      why?: string;
      part?: MemoryPart;
      layer?: string | null;
      source?: MemorySource;
      anchors?: MemoryAnchors;
      reason: string;
      evidence?: string;
    }
  | { op: "merge"; line: string; into: string; reason: string; evidence?: string }
  | { op: "retire"; line: string; reason: string; evidence?: string }
  | { op: "archive"; line: string; reason: string }
  | { op: "restore"; line: string; reason?: string }
  | { op: "pin"; line: string }
  | { op: "unpin"; line: string }
  | { op: "flag"; line: string; reason: string }
  | { op: "verify"; line: string; anchors?: MemoryAnchors; evidence?: string }
  | { op: "confirm"; line: string };

export interface ApplyResult {
  events: MemoryEvent[];
  refused: Array<{ change: MemoryChange; reason: string }>;
  /** Lines the changes added, the replacements included. */
  added: LineRecord[];
}

/** Everything the log holds for one project. */
export interface MemoryState {
  lines: Map<string, LineRecord>;
  seq: number;
  events: MemoryEvent[];
}

export function emptyState(): MemoryState {
  return { lines: new Map(), seq: 0, events: [] };
}

/* ── reading the state ─────────────────────────────────────────────── */

/** A record as a plain memory line: what the sheets and the page see. */
export function asLine(record: LineRecord): MemoryLine {
  const {
    part: _part,
    status: _status,
    rank: _rank,
    invalidAt: _invalid,
    supersededBy: _by,
    reason: _reason,
    ...line
  } = record;
  return line;
}

/** The lines in their parts, in reading order — current ones, or those
 *  with `status`. */
export function linesWith(state: MemoryState, status: MemoryStatus = "current"): LineRecord[] {
  return [...state.lines.values()]
    .filter((line) => line.status === status)
    .sort((a, b) => MEMORY_PARTS.indexOf(a.part) - MEMORY_PARTS.indexOf(b.part) || a.rank - b.rank);
}

/** The memory as it stands: every current line, by part. */
export function viewOf(state: MemoryState): ProjectMemory {
  const memory = emptyMemory();
  for (const record of linesWith(state)) memory[record.part].push(asLine(record));
  return memory;
}

/** Every line that ever was, past ones included. */
export function allRecords(state: MemoryState): LineRecord[] {
  return [...state.lines.values()];
}

/* ── the rules ─────────────────────────────────────────────────────── */

/** How many a part keeps across the project, or within one layer. */
function capOf(part: MemoryPart, layer: string | undefined): number {
  return layer ? LAYER_CAPS[part] : MEMORY_CAPS[part];
}

/** At most this many lines may leave the memory in one fold or check, or
 *  this share of it, whichever is more — a model that answers "retire
 *  everything" takes out a few lines, not the memory. */
const MASS_LEAVE_MIN = 3;
const MASS_LEAVE_SHARE = 0.2;

/** The user's line, or one the user pinned: nobody but the user changes it. */
function usersOwn(line: LineRecord): boolean {
  return line.by === "user" || line.pinned === true;
}

const isLeave = (change: MemoryChange) =>
  change.op === "retire" || change.op === "supersede" || change.op === "merge";

/** Why `actor` may not make `change` to `line` — undefined when it may. */
function refusal(change: MemoryChange, actor: Actor, line: LineRecord | undefined): string | undefined {
  if (change.op === "add") return undefined;
  if (!line) return `there is no line ${change.line}`;
  const by = actor.by;
  const current = line.status === "current";
  if (change.op === "restore") {
    if (current) return `${line.id} is already in the memory`;
    if (by === "model") return "only the user, an agent or ruri brings a line back";
    if (by === "agent" && line.by === "user") return `${line.id} is the user's — they bring it back`;
    return undefined;
  }
  if (!current) return `${line.id} is no longer in the memory (${line.status})`;
  if (by === "user") return undefined;
  switch (change.op) {
    case "pin":
    case "unpin":
      return "only the user pins a line";
    case "flag":
    case "verify":
      // whether a line still holds is anyone's to look into
      return undefined;
    case "confirm":
      return by === "model" ? "a line from outside is confirmed by the user or an agent" : undefined;
    case "archive":
      return by !== "system"
        ? "only ruri archives a line"
        : usersOwn(line)
          ? `${line.id} is the user's`
          : undefined;
    case "edit":
      if (usersOwn(line)) return `${line.id} is the user's — only they change it`;
      if (by === "model" && line.by !== "model")
        return `${line.id} is an agent's — the model never rewords it`;
      if (by === "agent" && line.by !== "agent") {
        return `${line.id} was gathered by the model — supersede it with your own line instead`;
      }
      return undefined;
    case "supersede":
    case "retire":
    case "merge": {
      if (usersOwn(line)) return `${line.id} is the user's — only they take it out`;
      if (!change.reason?.trim()) return "taking a line out needs a reason";
      if (by === "model" && line.by === "agent" && !change.evidence?.trim()) {
        return `${line.id} is an agent's first-hand line — the model takes it out only with evidence`;
      }
      return undefined;
    }
  }
  return undefined;
}

/* ── applying changes ──────────────────────────────────────────────── */

/** A copy of a record with keys set or (given undefined) taken off. */
function withKeys(record: LineRecord, keys: Partial<Record<keyof LineRecord, unknown>>): LineRecord {
  const out: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(keys)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as unknown as LineRecord;
}

function nextRank(state: MemoryState, part: MemoryPart): number {
  let top = -1;
  for (const line of state.lines.values()) if (line.part === part && line.rank > top) top = line.rank;
  return top + 1;
}

/** The layer a line keeps: never one for "now", which is the project's. */
function layerFor(part: MemoryPart, layer: string | undefined | null): string | undefined {
  return part === "now" || !layer ? undefined : layer;
}

/**
 * Apply `changes` as `actor`, in order, to `state` — refusing what the
 * actor may not do — then archive whatever a part holds past its cap.
 * Returns the events (to be appended to the log) and what was refused.
 * Pure: the caller persists.
 */
export function applyChanges(
  state: MemoryState,
  changes: MemoryChange[],
  actor: Actor,
  now = Date.now(),
): ApplyResult {
  const events: MemoryEvent[] = [];
  const refused: ApplyResult["refused"] = [];
  const added: LineRecord[] = [];
  const taken = new Set(state.lines.keys());
  const fold = actor.fold;
  const emit = (op: MemoryOp, after: LineRecord, extra: { reason?: string; evidence?: string } = {}) => {
    state.seq += 1;
    const event: MemoryEvent = {
      seq: state.seq,
      at: now,
      op,
      line: after.id,
      by: actor.by,
      ...(actor.chat ? { chat: actor.chat } : {}),
      ...(fold ? { fold } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.evidence ? { evidence: extra.evidence } : {}),
      after,
    };
    state.lines.set(after.id, after);
    state.events.push(event);
    events.push(event);
  };
  const author: MemoryLine["by"] = actor.by === "system" ? "model" : actor.by;
  const newLine = (
    part: MemoryPart,
    fields: {
      text: string;
      why?: string | undefined;
      layer?: string | null | undefined;
      source?: MemorySource | undefined;
      anchors?: MemoryAnchors | undefined;
      quarantined?: boolean | undefined;
      pinned?: boolean | undefined;
    },
    rank: number,
  ): LineRecord => {
    const layer = layerFor(part, fields.layer);
    return {
      id: newLineId(part, taken),
      text: fields.text.trim(),
      ...(fields.why?.trim() ? { why: fields.why.trim() } : {}),
      date: dayOf(now),
      by: author,
      ...(fields.source ? { source: fields.source } : {}),
      ...(fields.pinned ? { pinned: true } : {}),
      ...(layer ? { layer } : {}),
      validFrom: now,
      ...(fields.anchors ? { anchors: fields.anchors } : {}),
      ...(fields.quarantined ? { quarantined: true } : {}),
      part,
      status: "current",
      rank,
    };
  };

  // a model asking to take many lines out at once is cut off after a few
  const leaving = actor.by === "model" ? changes.filter(isLeave).length : 0;
  const allowedLeaves = Math.max(MASS_LEAVE_MIN, Math.ceil(linesWith(state).length * MASS_LEAVE_SHARE));
  let left = 0;

  for (const change of changes) {
    const line = change.op === "add" ? undefined : state.lines.get(change.line);
    const no = refusal(change, actor, line);
    if (no) {
      refused.push({ change, reason: no });
      continue;
    }
    if (leaving > allowedLeaves && isLeave(change) && ++left > allowedLeaves) {
      refused.push({
        change,
        reason: `too many lines taken out at once (${leaving}); at most ${allowedLeaves} in one go`,
      });
      continue;
    }
    switch (change.op) {
      case "add": {
        const text = change.text?.trim();
        if (!text) {
          refused.push({ change, reason: "a line needs words" });
          break;
        }
        const quality = lineRefusal(change.part, text, change.why, actor.by);
        if (quality) {
          refused.push({ change, reason: quality });
          break;
        }
        const record = newLine(change.part, change, nextRank(state, change.part));
        emit("add", record);
        added.push(record);
        break;
      }
      case "edit": {
        const was = line!;
        const part = change.part ?? was.part;
        const text = change.text?.trim() || was.text;
        const why = change.why === null ? undefined : (change.why?.trim() ?? was.why);
        const quality =
          change.text !== undefined || change.why !== undefined
            ? lineRefusal(part, text, why, actor.by)
            : undefined;
        if (quality) {
          refused.push({ change, reason: quality });
          break;
        }
        const layer = change.layer === undefined ? was.layer : layerFor(part, change.layer);
        const after = withKeys(was, {
          text,
          why: why || undefined,
          part,
          rank: part === was.part ? was.rank : nextRank(state, part),
          layer: part === "now" ? undefined : layer,
          ...(change.claim && actor.by !== "system" ? { by: actor.by, date: dayOf(now) } : {}),
          ...(change.pinned !== undefined ? { pinned: change.pinned || undefined } : {}),
        });
        emit("edit", after, { ...(change.reason ? { reason: change.reason } : {}) });
        break;
      }
      case "supersede": {
        const was = line!;
        const part = change.part ?? was.part;
        const text = change.text?.trim();
        if (!text) {
          refused.push({ change, reason: "a replacement needs words" });
          break;
        }
        const quality = lineRefusal(part, text, change.why, actor.by);
        if (quality) {
          refused.push({ change, reason: quality });
          break;
        }
        const layer = change.layer === undefined ? was.layer : change.layer;
        const replacement = newLine(
          part,
          {
            text,
            why: change.why,
            layer,
            source: change.source,
            anchors: change.anchors,
          },
          part === was.part ? was.rank : nextRank(state, part),
        );
        emit(
          "supersede",
          withKeys(was, {
            status: "superseded",
            invalidAt: now,
            supersededBy: replacement.id,
            reason: change.reason,
            check: undefined,
          }),
          { reason: change.reason, ...(change.evidence ? { evidence: change.evidence } : {}) },
        );
        emit("add", replacement, { reason: `supersedes ${was.id}` });
        added.push(replacement);
        break;
      }
      case "merge": {
        const into = state.lines.get(change.into);
        if (!into || into.status !== "current" || into.id === line!.id) {
          refused.push({ change, reason: `there is no current line ${change.into} to merge into` });
          break;
        }
        emit(
          "merge",
          withKeys(line!, {
            status: "superseded",
            invalidAt: now,
            supersededBy: into.id,
            reason: change.reason,
            check: undefined,
          }),
          { reason: change.reason, ...(change.evidence ? { evidence: change.evidence } : {}) },
        );
        break;
      }
      case "retire":
        emit(
          "retire",
          withKeys(line!, { status: "retired", invalidAt: now, reason: change.reason, check: undefined }),
          { reason: change.reason, ...(change.evidence ? { evidence: change.evidence } : {}) },
        );
        break;
      case "archive":
        emit("archive", withKeys(line!, { status: "archived", invalidAt: now, reason: change.reason }), {
          reason: change.reason,
        });
        break;
      case "restore":
        emit(
          "restore",
          withKeys(line!, {
            status: "current",
            invalidAt: undefined,
            supersededBy: undefined,
            reason: undefined,
            rank: nextRank(state, line!.part),
          }),
          { ...(change.reason ? { reason: change.reason } : {}) },
        );
        break;
      case "pin":
        emit("pin", withKeys(line!, { pinned: true }));
        break;
      case "unpin":
        emit("unpin", withKeys(line!, { pinned: undefined }));
        break;
      case "flag":
        emit("flag", withKeys(line!, { check: { reason: change.reason, since: now } }), {
          reason: change.reason,
        });
        break;
      case "verify":
        emit(
          "verify",
          withKeys(line!, { check: undefined, ...(change.anchors ? { anchors: change.anchors } : {}) }),
          { ...(change.evidence ? { evidence: change.evidence } : {}) },
        );
        break;
      case "confirm":
        emit("confirm", withKeys(line!, { quarantined: undefined }));
        break;
    }
  }
  capOverflow(state, now, emit);
  return { events, refused, added };
}

/**
 * Whatever a part holds past its cap goes to the archive — still in the
 * log, found by `ruri recall`, brought back by `ruri memory restore` —
 * rather than being dropped. The model's oldest lines go first, then an
 * agent's; the user's and pinned ones never do, and a line waiting to be
 * confirmed isn't counted, since nobody reads it yet.
 */
function capOverflow(
  state: MemoryState,
  now: number,
  emit: (op: MemoryOp, after: LineRecord, extra?: { reason?: string }) => void,
): void {
  const scopes = new Map<string, LineRecord[]>();
  for (const line of linesWith(state)) {
    if (line.quarantined) continue;
    const key = `${line.part}\u0000${line.layer ?? ""}`;
    scopes.set(key, [...(scopes.get(key) ?? []), line]);
  }
  for (const lines of scopes.values()) {
    const { part, layer } = lines[0]!;
    let over = lines.length - capOf(part, layer);
    if (over <= 0) continue;
    const age = (line: LineRecord) => line.validFrom ?? (Date.parse(line.date ?? "") || 0);
    const order = (by: MemoryLine["by"]) =>
      lines.filter((l) => l.by === by && !l.pinned).sort((a, b) => age(a) - age(b));
    for (const victim of [...order("model"), ...order("agent")]) {
      if (over <= 0) break;
      emit(
        "archive",
        withKeys(victim, {
          status: "archived",
          invalidAt: now,
          reason: `archived to keep ${part}${layer ? ` in ${layer}` : ""} within ${capOf(part, layer)} lines`,
        }),
        { reason: "past the part's cap" },
      );
      over -= 1;
    }
  }
}

/* ── taking a fold back ────────────────────────────────────────────── */

/** The newest fold or check in the log, by its id. */
export function lastFold(state: MemoryState): string | undefined {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i]!;
    if (event.fold && event.op !== "undo") return event.fold;
  }
  return undefined;
}

/**
 * Take a fold back: every line it touched goes back to how it was before
 * it, a line it added is retired — unless someone changed the line since,
 * which is theirs to keep. Returns what was undone and what was left.
 */
export function undoFold(
  state: MemoryState,
  fold: string,
  actor: Actor,
  now = Date.now(),
): { events: MemoryEvent[]; undone: string[]; kept: string[] } {
  const ofFold = state.events.filter((e) => e.fold === fold && e.op !== "undo");
  if (ofFold.length === 0) return { events: [], undone: [], kept: [] };
  const firstSeq = ofFold[0]!.seq;
  const touched = [...new Set(ofFold.map((e) => e.line))];
  const events: MemoryEvent[] = [];
  const undone: string[] = [];
  const kept: string[] = [];
  for (const id of touched) {
    const lastOfFold = ofFold.filter((e) => e.line === id).at(-1)!;
    const latest = state.events.filter((e) => e.line === id).at(-1)!;
    if (latest.seq !== lastOfFold.seq) {
      kept.push(id);
      continue;
    }
    const before = state.events.filter((e) => e.line === id && e.seq < firstSeq).at(-1)?.after;
    const after: LineRecord = before
      ? before
      : withKeys(lastOfFold.after, { status: "retired", invalidAt: now, reason: `fold ${fold} undone` });
    state.seq += 1;
    const event: MemoryEvent = {
      seq: state.seq,
      at: now,
      op: "undo",
      line: id,
      by: actor.by,
      ...(actor.chat ? { chat: actor.chat } : {}),
      reason: `undid fold ${fold}`,
      after,
    };
    state.lines.set(id, after);
    state.events.push(event);
    events.push(event);
    undone.push(id);
  }
  return { events, undone, kept };
}

/* ── an older memory, brought in ───────────────────────────────────── */

/** A day as ms, at noon local — what a line dated only by its day began. */
function dayStart(date: string | undefined): number | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).getTime();
}

/** A stored memory's lines as records, in the order they were kept. */
export function recordsOf(memory: ProjectMemory): LineRecord[] {
  return MEMORY_PARTS.flatMap((part) =>
    memory[part].map((line, rank) => {
      const from = line.validFrom ?? dayStart(line.date);
      return {
        ...line,
        ...(from !== undefined ? { validFrom: from } : {}),
        part,
        status: "current" as const,
        rank,
      };
    }),
  );
}

/** What of a line a reconciliation compares — not where it sits. */
function substance(line: MemoryLine, part: MemoryPart): string {
  return JSON.stringify([part, line.text, line.why ?? "", line.by, !!line.pinned, line.layer ?? ""]);
}

/**
 * The events that bring a log's memory to what briefs.json holds, when
 * something other than this log wrote it — the briefs from before there was
 * a log (everything is new), or an older ruri run since, which rewrites
 * briefs.json without the log's number. Lines it added come in; lines it
 * changed take its words; lines it no longer has are retired, kept in the
 * log with the reason.
 */
export function reconcile(state: MemoryState, stored: ProjectMemory, now = Date.now()): MemoryEvent[] {
  const events: MemoryEvent[] = [];
  const emit = (op: MemoryOp, after: LineRecord, reason: string) => {
    state.seq += 1;
    const event: MemoryEvent = { seq: state.seq, at: now, op, line: after.id, by: "system", reason, after };
    state.lines.set(after.id, after);
    state.events.push(event);
    events.push(event);
  };
  const there = new Set<string>();
  const fresh = state.lines.size === 0;
  for (const record of recordsOf(stored)) {
    there.add(record.id);
    const known = state.lines.get(record.id);
    if (!known) {
      emit("import", record, fresh ? "brought in from briefs.json" : "added outside the log");
      continue;
    }
    if (known.status !== "current" || substance(known, known.part) !== substance(record, record.part)) {
      emit("import", { ...known, ...record, status: "current" }, "changed outside the log");
    }
  }
  for (const line of linesWith(state)) {
    if (there.has(line.id)) continue;
    emit(
      "retire",
      withKeys(line, { status: "retired", invalidAt: now, reason: "taken out outside the log" }),
      "taken out outside the log",
    );
  }
  return events;
}

/* ── on disk ───────────────────────────────────────────────────────── */

function memoryDir(): string {
  return configPath("memory");
}

function logFile(projectId: string): string {
  return path.join(memoryDir(), `${projectId}.jsonl`);
}

/** A project's log, replayed. A line torn by a crash mid-append is
 *  skipped. Empty when there is none. */
export function readLog(projectId: string): MemoryState {
  const state = emptyState();
  let text: string;
  try {
    text = fs.readFileSync(logFile(projectId), "utf8");
  } catch (err) {
    if (!isMissing(err)) warn("memory", err, "readLog");
    return state;
  }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let event: MemoryEvent;
    try {
      event = JSON.parse(raw) as MemoryEvent;
    } catch {
      continue;
    }
    if (!event || typeof event.seq !== "number" || !event.after?.id) continue;
    state.events.push(event);
    state.lines.set(event.after.id, event.after);
    state.seq = Math.max(state.seq, event.seq);
  }
  return state;
}

function appendLog(projectId: string, events: MemoryEvent[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(memoryDir(), { recursive: true });
  fs.appendFileSync(logFile(projectId), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Where briefs.json is copied before a log first takes it over. */
function backupBriefs(): void {
  const from = configPath("briefs.json");
  const to = path.join(
    memoryDir(),
    "backup",
    `briefs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  } catch (err) {
    if (!isMissing(err)) warn("memory", err, "backupBriefs");
  }
}

/** What a log needs of the sheets: the memory in briefs.json, read and
 *  written (server/brief.ts BriefStore). */
export interface MemoryHome {
  get(projectId: string): { memory?: ProjectMemory; memorySeq?: number };
  remember(projectId: string, memory: ProjectMemory, seq?: number): unknown;
}

/**
 * Every project's memory log, loaded when it is first asked for. Loading
 * brings the log and briefs.json into line: a project with no log yet has
 * its memory imported (briefs.json backed up first, once a run); one whose
 * briefs.json an older ruri rewrote has those changes taken in; one whose
 * briefs.json a crash left behind the log gets the log's memory written
 * back. From then on every change goes through `apply`.
 */
export class MemoryBook {
  private readonly states = new Map<string, MemoryState>();
  private backedUp = false;
  private readonly listeners: Array<(projectId: string, events: MemoryEvent[]) => void> = [];

  constructor(private readonly home: MemoryHome) {}

  /** Told of every change, after it is on disk. */
  onChange(listener: (projectId: string, events: MemoryEvent[]) => void): void {
    this.listeners.push(listener);
  }

  state(projectId: string): MemoryState {
    let state = this.states.get(projectId);
    if (state) return state;
    state = readLog(projectId);
    this.states.set(projectId, state);
    const brief = this.home.get(projectId);
    const stored = brief.memory;
    if (stored && (brief.memorySeq === undefined || brief.memorySeq > state.seq)) {
      // no log yet, or briefs.json written by something that doesn't keep one
      if (!this.backedUp) {
        backupBriefs();
        this.backedUp = true;
      }
      const events = reconcile(state, stored);
      this.persist(projectId, state, events);
    } else if (state.seq > 0 && brief.memorySeq !== state.seq) {
      // briefs.json is behind the log (a quit before it was written)
      this.home.remember(projectId, viewOf(state), state.seq);
    }
    return state;
  }

  /** The memory as it stands. Undefined for a project that has none. */
  view(projectId: string): ProjectMemory | undefined {
    const state = this.state(projectId);
    return state.lines.size ? viewOf(state) : this.home.get(projectId).memory;
  }

  record(projectId: string, id: string): LineRecord | undefined {
    const state = this.state(projectId);
    return (
      state.lines.get(id) ?? [...state.lines.values()].find((l) => l.id.toLowerCase() === id.toLowerCase())
    );
  }

  /** Lines that left the memory, the latest to leave first. */
  past(projectId: string): LineRecord[] {
    return allRecords(this.state(projectId))
      .filter((line) => line.status !== "current")
      .sort((a, b) => (b.invalidAt ?? 0) - (a.invalidAt ?? 0));
  }

  /** What happened to the memory, oldest first — or to one line. */
  history(projectId: string, lineId?: string): MemoryEvent[] {
    const events = this.state(projectId).events;
    if (!lineId) return events;
    const wanted = lineId.toLowerCase();
    return events.filter((event) => event.line.toLowerCase() === wanted);
  }

  /** Make changes as `actor`; what was refused comes back with why. */
  apply(projectId: string, changes: MemoryChange[], actor: Actor): ApplyResult {
    const state = this.state(projectId);
    const result = applyChanges(state, changes, actor);
    this.persist(projectId, state, result.events);
    return result;
  }

  /** Take a fold back — the newest, unless one is named. */
  undo(projectId: string, actor: Actor, fold?: string): { fold?: string; undone: string[]; kept: string[] } {
    const state = this.state(projectId);
    const which = fold ?? lastFold(state);
    if (!which) return { undone: [], kept: [] };
    const result = undoFold(state, which, actor);
    this.persist(projectId, state, result.events);
    return { fold: which, undone: result.undone, kept: result.kept };
  }

  /** A fresh id for a fold or a check, which its events carry. */
  static foldId(): string {
    return `f${randomUUID().slice(0, 8)}`;
  }

  /** A project removed: its log goes too. */
  remove(projectId: string): void {
    this.states.delete(projectId);
    try {
      fs.rmSync(logFile(projectId), { force: true });
    } catch (err) {
      warn("memory", err, "remove");
    }
  }

  private persist(projectId: string, state: MemoryState, events: MemoryEvent[]): void {
    if (events.length === 0) return;
    try {
      appendLog(projectId, events);
    } catch (err) {
      warn("memory", err, "appendLog");
    }
    this.home.remember(projectId, viewOf(state), state.seq);
    for (const listener of this.listeners) {
      try {
        listener(projectId, events);
      } catch (err) {
        warn("memory", err, "listener");
      }
    }
  }
}
