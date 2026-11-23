/**
 * The screen's parts as lines: the sidebar, the top line with its gauges,
 * the working line, the queue, the pickers' line and their menus, the
 * switcher, the help. Pure — the app (App.tsx) decides what is focused and
 * how big each part is, and draws what these return.
 */
import stringWidth from "string-width";
import { HOME_ID, type QueuedPrompt } from "../../shared/protocol";
import { accountLine, NEARLY_FULL, usageWord, windowsOf } from "../../web/src/lib/accounts";
import { score } from "../../web/src/lib/fuzzy";
import { compact, fit, pad, span } from "./rows";
import { chatName, markOf, PERMISSION_MODES, type Controls, type Option, type Row } from "./state";
import type { Screen } from "./store";
import { paint, SPIN } from "./theme";

const percent = (label: string, value: number) => {
  const text = `${label} ${Math.round(value)}%`;
  return value >= NEARLY_FULL ? paint.red(text) : value >= 75 ? paint.amber(text) : paint.soft(text);
};

/** The gauges of the chat on screen, in a line: how full its context
 *  window is, and its account's 5-hour, weekly and premium windows. */
export function gauges(s: Screen, controls: Controls): string {
  const parts: string[] = [];
  const context = s.contexts[s.activeId];
  if (context && context.window > 0) parts.push(percent("ctx", (context.tokens / context.window) * 100));
  if (controls.local) parts.push(paint.soft(`local · ${controls.local}`));
  else if (controls.account) {
    for (const w of windowsOf(s.usage[controls.account.usage])) parts.push(percent(w.label, w.percent));
  }
  return parts.join(paint.soft(" · "));
}

/** The top line: where you are, and the gauges at its right edge. */
export function headerLine(s: Screen, controls: Controls, width: number): string {
  const right = gauges(s, controls);
  const name = chatName(s, s.activeId);
  const room = Math.max(0, width - 8 - stringWidth(right) - 2);
  const left = `${paint.inverse(paint.accent(" ruri "))} ${paint.bold(fit(name, room))}`;
  const gap = Math.max(1, width - stringWidth(left) - stringWidth(right));
  return fit(`${left}${" ".repeat(gap)}${right}`, width);
}

/** The sidebar, `height` lines of it around the cursor. `cursor` is shown
 *  only while the sidebar has the keys. */
export function sidebarLines(
  s: Screen,
  rows: Row[],
  cursor: number,
  focused: boolean,
  width: number,
  height: number,
  frame: number,
): string[] {
  const top = Math.max(0, Math.min(cursor - Math.floor(height / 2), rows.length - height));
  const lines = rows.slice(top, top + height).map((row, i) => {
    const on = focused && top + i === cursor;
    if (row.kind === "folder") {
      const text = pad(
        ` ${row.collapsed ? "▸" : "▾"} ${row.name}${row.collapsed ? ` (${row.count})` : ""}`,
        width,
      );
      return on ? paint.inverse(text) : paint.soft(text);
    }
    const chatId = row.kind === "home" ? HOME_ID : row.chatId;
    const active = chatId === s.activeId;
    const mark = markOf(s, chatId);
    const sign =
      mark === "working"
        ? paint.accent(SPIN[frame % SPIN.length]!)
        : mark === "needs-you"
          ? paint.amber("!")
          : mark === "error"
            ? paint.red("●")
            : mark === "unread"
              ? paint.accent("◆")
              : paint.soft("z");
    // a folder's projects stand in from its name, a star just before its own
    const star = row.kind === "project" && row.starred ? "★ " : "";
    const name = row.kind === "home" ? "Home" : `${row.inFolder ? "  " : ""}${star}${row.name}`;
    const body = pad(name, Math.max(1, width - 4));
    const text = `${active ? paint.accent("▌") : " "}${active ? paint.bold(body) : body} ${sign} `;
    return on ? paint.inverse(text) : text;
  });
  while (lines.length < height) lines.push("");
  return lines;
}

/** The line over the prompt box: what the chat is doing, or what is wrong. */
export function workingLine(s: Screen, frame: number, now: number, width: number): string {
  if (!s.connected) return paint.red(fit(s.ready ? "reconnecting to ruri…" : "connecting to ruri…", width));
  if (s.notice) return paint.amber(fit(`${s.notice}  (esc)`, width));
  const chatId = s.activeId;
  const held = s.queueHeld[chatId];
  if (held && (s.queued[chatId]?.length ?? 0) > 0) {
    const why =
      held.by === "limit"
        ? `out of usage${held.resetsAt ? `, back in ${span(Math.max(0, held.resetsAt - now))}` : ""}`
        : held.by === "network"
          ? "nothing reaches the API"
          : "you stopped the turn";
    return paint.amber(fit(`the queue is held: ${why} · r in the queue lets it go on`, width));
  }
  const status = s.statuses[chatId];
  if (status === "working") {
    const turn = s.turns[chatId];
    const quiet = turn ? now - turn.at : 0;
    const parts = [
      "working",
      ...(turn ? [span(now - turn.startedAt)] : []),
      ...(turn && turn.tokens > 0 ? [`${compact(turn.tokens)} tokens`] : []),
      ...(quiet > 60_000 ? [`quiet for ${span(quiet)}`] : []),
      "esc stops it",
    ];
    const work = s.work[chatId];
    const behind = work
      ? [
          work.agents ? `${work.agents} agent${work.agents > 1 ? "s" : ""}` : "",
          work.scripts ? `${work.scripts} script${work.scripts > 1 ? "s" : ""}` : "",
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    return `${paint.accent(SPIN[frame % SPIN.length]!)} ${paint.soft(fit([...parts, ...(behind ? [`${behind} at work`] : [])].join(" · "), width - 2))}`;
  }
  if (status === "permission") return paint.amber(fit("waiting on you", width));
  if (status === "error") return paint.red(fit("the last turn failed", width));
  return "";
}

/** The prompts waiting behind the running turn, newest last. */
export function queueLines(
  items: QueuedPrompt[],
  cursor: number,
  focused: boolean,
  width: number,
  max: number,
): string[] {
  if (items.length === 0) return [];
  const room = Math.max(1, max - 1);
  const top = Math.max(0, Math.min(cursor - room + 1, items.length - room));
  const lines = items.slice(top, top + room).map((item, i) => {
    const n = top + i;
    const from = item.from ? paint.soft(` ← ${item.from}`) : "";
    const state = item.editing
      ? paint.soft(" (being rewritten)")
      : item.splitting
        ? paint.soft(" (being split)")
        : "";
    const text = pad(` ${n + 1}. ${item.text.replace(/\s+/g, " ")}${from}${state}`, width);
    return focused && n === cursor ? paint.inverse(text) : text;
  });
  const more = items.length > room ? ` · ${items.length - room} more` : "";
  const keys = focused ? " · enter sends it now · e rewrite · x remove" : " · ↑ from the prompt to reach it";
  return [paint.soft(fit(`queued (${items.length})${more}${keys}`, width)), ...lines];
}

export const CHIPS = ["model", "account", "effort", "mode"] as const;
export type Chip = (typeof CHIPS)[number];

/** The chips a chat has: a local model spends from no account, a model
 *  with no reasoning levels has no effort, a harness with no approval flow
 *  no mode. */
export function chipsOf(controls: Controls): Chip[] {
  return CHIPS.filter((chip) =>
    chip === "account"
      ? controls.account !== undefined
      : chip === "effort"
        ? controls.efforts.length > 0
        : chip === "mode"
          ? controls.canSetMode
          : true,
  );
}

/** The pickers under the prompt box: model, account, effort, permissions. */
export function controlsLine(
  s: Screen,
  controls: Controls,
  chip: Chip | undefined,
  hint: string,
  width: number,
): string {
  const said: Record<Chip, string> = {
    model: controls.modelLabel,
    account: (() => {
      const account = controls.account;
      if (!account) return "";
      const limits = s.usage[account.usage];
      const full = windowsOf(limits).some((w) => w.percent >= NEARLY_FULL);
      const text = full ? `${account.name} · ${usageWord(limits)}` : account.name;
      return full ? paint.red(text) : text;
    })(),
    effort: controls.efforts.find((e) => e.value === controls.effort)?.label ?? controls.effort,
    mode: PERMISSION_MODES.find((m) => m.value === controls.mode)?.label ?? controls.mode,
  };
  const chips = chipsOf(controls)
    .map((name) => (name === chip ? paint.inverse(` ${said[name]} `) : ` ${said[name]} `))
    .join(paint.soft("·"));
  // as much of the hint as there is room for: all of it, or its last word
  for (const words of [hint, hint.split(" · ").at(-1) ?? ""]) {
    const gap = width - stringWidth(chips) - stringWidth(words);
    if (words && gap >= 1) return `${chips}${" ".repeat(gap)}${paint.soft(words)}`;
  }
  return fit(chips, width);
}

/** What a chip's menu offers, and which row is the chat's own now. */
export function menuOf(
  s: Screen,
  controls: Controls,
  chip: Chip,
): { title: string; options: Option[]; current: number } {
  if (chip === "model") {
    return {
      title: "Model for this chat",
      options: controls.models,
      current: controls.models.findIndex((m) => m.value === controls.model),
    };
  }
  if (chip === "effort") {
    return {
      title: "Reasoning effort",
      options: controls.efforts,
      current: controls.efforts.findIndex((e) => e.value === controls.effort),
    };
  }
  if (chip === "mode") {
    return {
      title: "Permission mode",
      options: PERMISSION_MODES,
      current: PERMISSION_MODES.findIndex((m) => m.value === controls.mode),
    };
  }
  return {
    title: "Account this chat spends from",
    options: controls.accounts.map((a) => ({
      value: a.id,
      label: a.name,
      hint: [accountLine(a), usageWord(s.usage[a.usage])].filter(Boolean).join(" · "),
    })),
    current: controls.accounts.findIndex((a) => a.id === controls.account?.id),
  };
}

/** A menu's rows, the cursor's inverted and the current pick ticked. */
export function menuLines(
  menu: { title: string; options: Option[]; current: number },
  cursor: number,
  width: number,
  max: number,
): string[] {
  const room = Math.max(1, max - 2);
  const top = Math.max(0, Math.min(cursor - Math.floor(room / 2), menu.options.length - room));
  const rows = menu.options.slice(top, top + room).map((option, i) => {
    const n = top + i;
    const hint = option.hint ? paint.soft(`  ${option.hint}`) : "";
    const text = pad(` ${n === menu.current ? "✓" : " "} ${option.label}${hint}`, width);
    return n === cursor ? paint.inverse(text) : text;
  });
  return [
    paint.bold(fit(menu.title, width)),
    ...rows,
    paint.soft(fit("↑↓ choose · enter pick · esc close", width)),
  ];
}

/** Where the switcher can go. */
export interface Place {
  chatId: string;
  name: string;
}

/** The switcher's matches for what was typed, best first: Home and every
 *  project that isn't tucked away — folded folders included. */
export function places(s: Screen, rows: Row[], query: string): Place[] {
  const listed = new Set<string>();
  const all: Place[] = [{ chatId: HOME_ID, name: "Home" }];
  for (const row of rows) {
    if (row.kind !== "project") continue;
    listed.add(row.id);
    all.push({ chatId: row.chatId, name: row.name });
  }
  // the ones a folded folder keeps out of the rows
  for (const p of s.projects) {
    const lead = p.sessions.find((x) => x.lead) ?? p.sessions.find((x) => !x.liaison);
    if (!listed.has(p.id) && !p.hidden && lead) all.push({ chatId: lead.id, name: p.name });
  }
  if (!query.trim()) return all;
  return all
    .map((place) => ({ place, rank: score(query.trim(), place.name) }))
    .filter((x): x is { place: Place; rank: number } => x.rank !== null)
    .sort((a, b) => b.rank - a.rank)
    .map((x) => x.place);
}

export function switcherLines(
  s: Screen,
  found: Place[],
  query: string,
  cursor: number,
  frame: number,
  width: number,
  height: number,
): string[] {
  const room = Math.max(1, height - 3);
  const top = Math.max(0, Math.min(cursor - Math.floor(room / 2), found.length - room));
  const rows = found.slice(top, top + room).map((place, i) => {
    const n = top + i;
    const mark = markOf(s, place.chatId);
    const sign =
      mark === "working"
        ? SPIN[frame % SPIN.length]!
        : mark === "needs-you"
          ? "!"
          : mark === "unread"
            ? "◆"
            : " ";
    const text = pad(` ${sign} ${place.name}`, width);
    return n === cursor ? paint.inverse(text) : text;
  });
  return [
    `${paint.accent("❯")} ${query}${paint.inverse(" ")}`,
    paint.soft("─".repeat(Math.max(1, width))),
    ...(rows.length > 0 ? rows : [paint.soft("  nothing by that name")]),
    paint.soft(fit("type to search · ↑↓ choose · enter go · esc close", width)),
  ];
}

export const HELP: Array<[string, string]> = [
  ["tab / shift+tab", "move between the sidebar, the chat, the queue, the prompt and its pickers"],
  ["ctrl+k", "the switcher: type a project's name, enter goes there"],
  ["enter", "send the prompt — it queues while a turn runs"],
  ["alt+enter · ctrl+j · \\ then enter", "a new line in the prompt"],
  ["esc", "back to the prompt; from the prompt, stop the running turn"],
  ["pgup / pgdn", "scroll the chat from anywhere"],
  ["in the chat: ↑↓", "step through it; enter opens a tool step, a patch, a compaction"],
  ["in the chat: g / G", "the top, and back to the newest line"],
  ["in the queue: enter", "send that prompt now, in place of the running turn"],
  ["in the queue: e / x / r", "rewrite it, remove it, let a held queue go on"],
  ["on a card", "↑↓ and enter, or its number; esc leaves it for later"],
  ["under the prompt", "←→ between model, account, effort and permissions; enter opens one"],
  ["in the sidebar", "↑↓ and enter; enter on a folder folds it"],
  ["ctrl+c", "clear the prompt; twice on an empty one quits (ruri itself keeps running)"],
];

export function helpLines(width: number): string[] {
  const keyWidth = Math.min(34, Math.max(...HELP.map(([key]) => stringWidth(key))));
  return [
    paint.bold("ruri in a terminal"),
    paint.soft(fit("the same projects, chats and queue as the desktop window, on the same server", width)),
    "",
    ...HELP.map(([key, what]) => fit(`${paint.accent(pad(key, keyWidth))}  ${what}`, width)),
    "",
    paint.soft("any key closes this"),
  ];
}
