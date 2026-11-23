/**
 * A chat's transcript as the lines of its pane: every event laid out to the
 * pane's width, each line knowing which event it belongs to — so the pane
 * can scroll by line and select by event. A tool step is one line until it
 * is opened; a reply is its markdown; a turn's end is a quiet rule.
 */
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { FileDiff, SubagentState, TranscriptEvent } from "../../shared/protocol";
import { roughName } from "../../web/src/lib/models";
import { markdownLines, wrap } from "./markdown";
import { paint } from "./theme";

export interface Line {
  text: string;
  /** The event it is part of; none for the space between two. */
  eventId?: string;
}

/** A count as a person reads it: 1234 → "1.2k". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A stretch of time in a word: "8s", "3m 05s", "1h 12m". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** A line cut to `width` columns, with an ellipsis when it ran over. Its
 *  colours survive the cut, and end with it. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const line = text.replace(/\s*\n\s*/g, " ");
  if (stringWidth(line) <= width) return line;
  if (width === 1) return "…";
  const cut = wrapAnsi(line, width - 1, { hard: true, trim: false, wordWrap: false }).split("\n")[0] ?? "";
  return `${cut}…`;
}

/** A line filled out to exactly `width` columns. */
export function pad(text: string, width: number): string {
  const line = fit(text, width);
  return line + " ".repeat(Math.max(0, width - stringWidth(line)));
}

const clock = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function diffLines(diff: FileDiff, width: number): string[] {
  const out: string[] = [];
  for (const hunk of diff.hunks) {
    out.push(paint.soft(`    @@ -${hunk.oldStart} +${hunk.newStart} @@`));
    for (const line of hunk.lines) {
      const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
      const text = fit(`    ${mark} ${line.text.replace(/\t/g, "  ")}`, width);
      out.push(
        line.kind === "add" ? paint.green(text) : line.kind === "del" ? paint.red(text) : paint.soft(text),
      );
    }
  }
  if (diff.truncated) out.push(paint.soft("    … more of this patch was left out"));
  return out;
}

function agentLine(agent: SubagentState): string {
  const state =
    agent.status === "running"
      ? paint.accent("working")
      : agent.status === "failed"
        ? paint.red("failed")
        : agent.status;
  const spent = [
    agent.tools ? `${agent.tools} tools` : "",
    agent.tokens ? `${compact(agent.tokens)} tokens` : "",
  ].filter(Boolean);
  return [`${agent.script ? "script" : "agent"}: ${agent.description}`, state, ...spent].join(" · ");
}

/** One event as lines `width` wide. `open` shows what a folded one hides:
 *  a patch, an agent's last words, a compaction's brief. */
export function eventLines(event: TranscriptEvent, width: number, open: boolean): string[] {
  switch (event.kind) {
    case "user": {
      const who = event.from ? [paint.soft(`from ${event.from.project} · ${event.from.title}`)] : [];
      const text = wrap(event.text, width - 2).map((line, i) =>
        i === 0 ? `${paint.accent("❯")} ${paint.bold(line)}` : `  ${paint.bold(line)}`,
      );
      const files = (event.attachments ?? []).map((a) => paint.soft(`  [${a.kind}: ${a.name}]`));
      return [...who, ...text, ...files];
    }
    case "assistant":
      return markdownLines(event.text, width);
    case "tool": {
      if (event.diff) {
        const d = event.diff;
        const head = `${paint.soft("  ✎")} ${event.name} ${d.path}${d.created ? " (new)" : ""} ${paint.green(`+${d.added}`)} ${paint.red(`-${d.removed}`)}`;
        return open ? [head, ...diffLines(d, width)] : [head];
      }
      if (event.agent) {
        const head = `${paint.soft("  ◈")} ${fit(agentLine(event.agent), width - 4)}`;
        const more = event.agent.status === "running" ? event.agent.activity : event.agent.result;
        return open && more
          ? [head, ...wrap(more, width - 4).map((line) => paint.soft(`    ${line}`))]
          : [head];
      }
      const line = `${event.name} ${event.summary}`.trim();
      if (!open) return [paint.soft(`  ⏺ ${fit(line.replace(/\s+/g, " "), width - 4)}`)];
      return wrap(line, width - 4).map((text, i) => paint.soft(`${i === 0 ? "  ⏺ " : "    "}${text}`));
    }
    case "result": {
      if (event.stopped) return [paint.soft("■ stopped")];
      if (!event.ok) {
        const why =
          event.blocked === "limit"
            ? `out of usage${event.resetsAt ? ` — back at ${clock(event.resetsAt)}` : ""}`
            : event.blocked === "network"
              ? "nothing reached the API — the queue waits for the network"
              : (event.error ?? "the turn failed");
        return wrap(`✗ ${why}`, width).map((line) => (event.blocked ? paint.amber(line) : paint.red(line)));
      }
      const parts = [
        event.durationMs !== undefined ? span(event.durationMs) : "",
        event.tokens !== undefined ? `${compact(event.tokens)} tokens` : "",
        event.costUsd ? `$${event.costUsd.toFixed(2)}` : "",
        ...(event.models ?? []).map(roughName),
      ].filter(Boolean);
      return [paint.soft(fit(`── ${parts.join(" · ") || "done"} ──`, width))];
    }
    case "info":
      return wrap(event.text, width - 2).map((line) => paint.soft(paint.italic(`· ${line}`)));
    case "plan": {
      if (event.removed) return [];
      const entries = (event.entries ?? []).map((entry) => {
        const box = entry.status === "completed" ? "☑" : entry.status === "in_progress" ? "◐" : "☐";
        return `  ${entry.status === "in_progress" ? paint.accent(box) : paint.soft(box)} ${fit(entry.content, width - 4)}`;
      });
      const body =
        event.markdown && (open || entries.length === 0) ? markdownLines(event.markdown, width - 2) : [];
      return [
        paint.bold("Plan"),
        ...(event.explanation ? wrap(event.explanation, width - 2).map((l) => `  ${l}`) : []),
        ...entries,
        ...body.map((l) => `  ${l}`),
      ];
    }
    case "compaction": {
      const rule = paint.soft(fit(`∿∿∿ compacted here — ${clock(event.ts)} ∿∿∿`, width));
      if (!open) return [rule];
      const brief = markdownLines(event.text, width - 2);
      const shown = brief.slice(0, 60).map((line) => paint.soft(`  ${line}`));
      return [
        rule,
        ...shown,
        ...(brief.length > 60 ? [paint.soft(`  … ${brief.length - 60} more lines`)] : []),
      ];
    }
  }
}

/** Whether an event has more to show when opened. */
export function opens(event: TranscriptEvent): boolean {
  if (event.kind === "tool") return true;
  if (event.kind === "compaction") return true;
  return event.kind === "plan" && Boolean(event.markdown) && (event.entries?.length ?? 0) > 0;
}

/** Events laid out before, by the object they were: a transcript's events
 *  are replaced when they change and kept when they don't, so a redraw
 *  lays out only what moved. */
const laid = new WeakMap<TranscriptEvent, { width: number; open: boolean; lines: string[] }>();

function linesOf(event: TranscriptEvent, width: number, open: boolean): string[] {
  const held = laid.get(event);
  if (held && held.width === width && held.open === open) return held.lines;
  const lines = eventLines(event, width, open);
  laid.set(event, { width, open, lines });
  return lines;
}

/** The whole pane: each event's lines, a blank between a prompt or a reply
 *  and what came before it, tool steps standing together. */
export function transcriptLines(
  events: TranscriptEvent[],
  width: number,
  opened: ReadonlySet<string>,
  reply?: { messageId: string; text: string },
): Line[] {
  const out: Line[] = [];
  let before: TranscriptEvent["kind"] | undefined;
  for (const event of events) {
    const lines = linesOf(event, width, opened.has(event.id));
    if (lines.length === 0) continue;
    if (before && !(before === "tool" && event.kind === "tool")) out.push({ text: "" });
    for (const text of lines) out.push({ text, eventId: event.id });
    before = event.kind;
  }
  // the reply being written, unless its finished message has landed
  if (reply && reply.text.trim() && !events.some((e) => e.id === reply.messageId)) {
    if (before) out.push({ text: "" });
    const lines = markdownLines(reply.text, width);
    lines.forEach((text, i) =>
      out.push({
        text: i === lines.length - 1 ? `${text}${paint.accent("▍")}` : text,
        eventId: reply.messageId,
      }),
    );
  }
  return out;
}
