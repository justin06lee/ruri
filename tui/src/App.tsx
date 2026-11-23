/**
 * ruri in a terminal: the desktop window's layout drawn in character cells.
 * A sidebar of projects down the left; the open chat on the right with its
 * transcript, the cards it waits on you with, its queue, the prompt box and
 * the pickers under it; the gauges on the top line. What each part says is
 * view.ts, rows.ts and cards.ts; this decides how big each is, which has
 * the keys, and what a key does.
 */
import { Box, Text, useAnimation, useApp, useCursor, useInput, usePaste, useWindowSize } from "ink";
import { useMemo, useState, useSyncExternalStore } from "react";
import { cardKey, cardLines, cardState, type CardKey, type CardState } from "./cards";
import * as editor from "./editor";
import { fit, pad, transcriptLines, type Line } from "./rows";
import { cardsOf, chatName, controlsOf, sidebarRows } from "./state";
import type { Ruri } from "./store";
import { paint } from "./theme";
import {
  chipsOf,
  controlsLine,
  headerLine,
  helpLines,
  menuLines,
  menuOf,
  places,
  queueLines,
  sidebarLines,
  switcherLines,
  workingLine,
  type Chip,
} from "./view";

type Focus = "sidebar" | "chat" | "card" | "queue" | "prompt" | "pickers";

type Overlay =
  | { kind: "switcher"; query: string; cursor: number }
  | { kind: "help" }
  | { kind: "menu"; chip: Chip; cursor: number };

/** Where a chat's pane stands: the line under its last visible one (none
 *  while it follows the newest), and the event the cursor is on. */
interface Scroll {
  bottom: number | null;
  selected?: string;
}

const FOLLOW: Scroll = { bottom: null };
/** The prompt box grows to this many lines, then scrolls. */
const PROMPT_ROWS = 6;
/** Keys are not a card's for this long after it comes up: the word being
 *  typed when it appeared is not its answer. */
const CARD_GUARD_MS = 600;
/** A second Ctrl+C within this long quits. */
const QUIT_MS = 2000;

/** The time, to the second: one clock for every line that counts. */
let clockAt = Date.now();
let clockTimer: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();
function watchClock(listener: () => void): () => void {
  clockListeners.add(listener);
  clockAt = Date.now();
  clockTimer ??= setInterval(() => {
    clockAt = Date.now();
    for (const each of clockListeners) each();
  }, 1000);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size > 0) return;
    clearInterval(clockTimer);
    clockTimer = undefined;
  };
}
/** The instant a key was pressed: for what a key decides, not what is drawn. */
const timeNow = () => Date.now();
const useNow = () => useSyncExternalStore(watchClock, () => clockAt);

export function App({ store }: { store: Ruri }) {
  const s = useSyncExternalStore(store.subscribe, store.get);
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const { setCursorPosition } = useCursor();

  const [focusAsked, setFocus] = useState<Focus>("prompt");
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [sideCursor, setSideCursor] = useState(0);
  const [queueCursor, setQueueCursor] = useState(0);
  const [chipAt, setChipAt] = useState(0);
  const [scrolls, setScrolls] = useState<Record<string, Scroll>>({});
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [cardHeld, setCardHeld] = useState<CardState | undefined>();
  /** The card the user stepped away from: it does not take the keys again. */
  const [cardLeft, setCardLeft] = useState<string | undefined>();
  const [quitAt, setQuitAt] = useState(0);

  const chatId = s.activeId;
  const edit = s.edits[chatId] ?? editor.EMPTY;
  const controls = useMemo(() => controlsOf(s, chatId), [s, chatId]);
  const sideRows = useMemo(() => sidebarRows(s), [s]);
  const queue = s.queued[chatId] ?? [];
  const card = cardsOf(s, chatId)[0];
  const cardNow = card ? (cardHeld?.requestId === card.requestId ? cardHeld : cardState(card)) : undefined;
  const chips = chipsOf(controls);
  const chip = chips[Math.min(chipAt, chips.length - 1)];

  const now = useNow();
  const anyWorking = Object.values(s.statuses).some((status) => status === "working");
  const { frame } = useAnimation({ interval: 120, isActive: anyWorking });

  /* ── sizes ──────────────────────────────────────────────────────── */

  const sideW = columns >= 84 ? 28 : columns >= 60 ? 22 : 0;
  const left = sideW > 0 ? sideW + 1 : 0;
  const mainW = Math.max(20, columns - left);
  const textW = mainW - 2;
  const bodyH = Math.max(8, rows - 1);

  // which part has the keys: what was asked for, while that part is there
  let focus: Focus = focusAsked;
  if (focus === "sidebar" && sideW === 0) focus = "prompt";
  if (focus === "queue" && queue.length === 0) focus = "prompt";
  if (focus === "card" && !card) focus = "prompt";
  if (focus === "pickers" && chips.length === 0) focus = "prompt";
  // a card takes the keys from an empty prompt box, once
  if (focus === "prompt" && card && !edit.text && cardLeft !== card.requestId) focus = "card";

  const prompt = editor.layout(edit, Math.max(4, textW - 2));
  const promptRows = Math.min(PROMPT_ROWS, prompt.lines.length);
  const promptTop = Math.max(0, Math.min(prompt.row - promptRows + 1, prompt.lines.length - promptRows));

  const menu = overlay?.kind === "menu" ? menuOf(s, controls, overlay.chip) : undefined;
  const roomAbove = bodyH - promptRows - 3;
  const queueH = Math.min(queue.length > 0 ? queue.length + 1 : 0, 5, Math.max(0, roomAbove - 6));
  const midMax = Math.max(3, Math.min(roomAbove - queueH - 3, Math.floor(bodyH * 0.5)));
  const mid =
    menu && overlay?.kind === "menu"
      ? menuLines(menu, overlay.cursor, mainW, midMax)
      : card && cardNow
        ? cardLines(card, cardNow, mainW, midMax, focus === "card")
        : [];
  const chatH = Math.max(1, roomAbove - queueH - mid.length);

  /* ── the chat pane ──────────────────────────────────────────────── */

  const events = s.transcripts[chatId];
  const reply = s.replies[chatId];
  const lines: Line[] = useMemo(
    () => transcriptLines(events ?? [], textW, opened, reply),
    [events, textW, opened, reply],
  );
  const scroll = scrolls[chatId] ?? FOLLOW;
  const bottom = Math.max(
    Math.min(chatH, lines.length),
    Math.min(scroll.bottom ?? lines.length, lines.length),
  );
  const below = lines.length - bottom;

  const setScroll = (next: Scroll) => setScrolls((all) => ({ ...all, [chatId]: next }));
  const scrollBy = (by: number) => {
    const to = Math.max(Math.min(chatH, lines.length), Math.min(lines.length, bottom + by));
    setScroll({ ...scroll, bottom: to >= lines.length ? null : to });
  };
  /** Step the cursor to the event before or after, and bring it into view. */
  const select = (by: -1 | 1) => {
    const ids: string[] = [];
    for (const line of lines)
      if (line.eventId && ids[ids.length - 1] !== line.eventId) ids.push(line.eventId);
    if (ids.length === 0) return;
    const at = scroll.selected ? ids.indexOf(scroll.selected) : -1;
    const next = ids[at === -1 ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, at + by))]!;
    const first = lines.findIndex((line) => line.eventId === next);
    let last = first;
    while (lines[last + 1]?.eventId === next) last += 1;
    let to = bottom;
    if (first < bottom - chatH) to = first + chatH;
    else if (last >= bottom) to = Math.min(last + 1, first + chatH);
    to = Math.min(lines.length, to);
    setScroll({ selected: next, bottom: to >= lines.length ? null : to });
  };

  /* ── keys ───────────────────────────────────────────────────────── */

  const order: Focus[] = [
    ...(sideW > 0 ? (["sidebar"] as const) : []),
    "chat",
    ...(card ? (["card"] as const) : []),
    ...(queue.length > 0 ? (["queue"] as const) : []),
    "prompt",
    ...(chips.length > 0 ? (["pickers"] as const) : []),
  ];
  const go = (to: Focus) => {
    // stepping off a card leaves it for later: it does not pull the keys back
    if (focus === "card" && to !== "card" && card) setCardLeft(card.requestId);
    if (to === "card") setCardLeft(undefined);
    // the pickers are entered at the first: the model
    if (to === "pickers" && focus !== "pickers") setChipAt(0);
    if (to === "sidebar") {
      const at = sideRows.findIndex((row) => (row.kind === "project" ? row.chatId : row.id) === chatId);
      if (at !== -1) setSideCursor(at);
    }
    setFocus(to);
  };
  const openChat = (id: string) => {
    store.open(id);
    setCardLeft(undefined);
    setFocus("prompt");
  };
  const type = (next: editor.Edit) => store.edit(chatId, next);

  const cardInput = (input: CardKey) => {
    if (!card || !cardNow) return;
    if (timeNow() - card.ts < CARD_GUARD_MS) return;
    const { state, verdict } = cardKey(card, cardNow, input);
    setCardHeld(state);
    if (!verdict) return;
    if (verdict.type === "permission") store.answerPermission(card.requestId, verdict.allow, verdict.always);
    else if (verdict.type === "question") store.answerQuestion(card.requestId, verdict.answers);
    else store.nameComponent(card.requestId, verdict.name);
  };

  /** The prompt box as it stands this instant: two keys can land between
   *  two draws, and the second must see what the first did. */
  const held = () => store.get().edits[chatId] ?? editor.EMPTY;

  usePaste((text) => {
    const edit = held();
    if (overlay?.kind === "switcher") {
      setOverlay({ ...overlay, query: overlay.query + text.replace(/\s+/g, " "), cursor: 0 });
      return;
    }
    if (focus === "card" && cardNow?.typing) {
      cardInput({ key: "text", text: text.replace(/\s+/g, " ") });
      return;
    }
    type(editor.insert(edit, text));
    if (focus !== "prompt") go("prompt");
  });

  useInput((input, key) => {
    const ctrl = (letter: string) => key.ctrl && input === letter;
    const edit = held();

    if (ctrl("c")) {
      if (overlay) return setOverlay(null);
      if (edit.text && focus === "prompt") return type(editor.EMPTY);
      if (timeNow() - quitAt < QUIT_MS) return exit();
      return setQuitAt(timeNow());
    }
    if (ctrl("d") && !edit.text && !overlay) return exit();

    /* the switcher, the help, a picker's menu: theirs until they close */
    if (overlay?.kind === "help") return setOverlay(null);
    if (overlay?.kind === "switcher") {
      const found = places(s, sideRows, overlay.query);
      if (key.escape) return setOverlay(null);
      if (key.return) {
        const place = found[overlay.cursor];
        setOverlay(null);
        if (place) openChat(place.chatId);
        return;
      }
      if (key.upArrow || ctrl("p"))
        return setOverlay({ ...overlay, cursor: Math.max(0, overlay.cursor - 1) });
      if (key.downArrow || ctrl("n") || key.tab) {
        return setOverlay({ ...overlay, cursor: Math.min(found.length - 1, overlay.cursor + 1) });
      }
      if (key.backspace || key.delete)
        return setOverlay({ ...overlay, query: overlay.query.slice(0, -1), cursor: 0 });
      if (input && !key.ctrl && !key.meta)
        return setOverlay({ ...overlay, query: overlay.query + input, cursor: 0 });
      return;
    }
    if (overlay?.kind === "menu" && menu) {
      if (key.escape || key.leftArrow) return setOverlay(null);
      if (key.upArrow || input === "k")
        return setOverlay({ ...overlay, cursor: Math.max(0, overlay.cursor - 1) });
      if (key.downArrow || input === "j") {
        return setOverlay({ ...overlay, cursor: Math.min(menu.options.length - 1, overlay.cursor + 1) });
      }
      if (key.return || input === " ") {
        const option = menu.options[overlay.cursor];
        setOverlay(null);
        if (!option) return;
        if (overlay.chip === "account") {
          const account = controls.accounts.find((a) => a.id === option.value);
          if (account) store.pickAccount(chatId, account);
        } else {
          store.pick(chatId, overlay.chip === "mode" ? "permissionMode" : overlay.chip, option.value);
        }
      }
      return;
    }

    if (ctrl("k")) return setOverlay({ kind: "switcher", query: "", cursor: 0 });
    if (key.tab) {
      const at = order.indexOf(focus);
      return go(order[(at + (key.shift ? order.length - 1 : 1)) % order.length]!);
    }
    if (key.pageUp) return scrollBy(-Math.max(1, chatH - 2));
    if (key.pageDown) return scrollBy(Math.max(1, chatH - 2));
    if (key.escape) {
      if (s.notice) return store.dismissNotice();
      if (focus !== "prompt") {
        if (focus === "card" && cardNow?.typing) return setCardHeld({ ...cardNow, typing: undefined });
        return go("prompt");
      }
      if (s.statuses[chatId] === "working") store.interrupt(chatId);
      return;
    }

    switch (focus) {
      case "sidebar": {
        const row = sideRows[sideCursor];
        if (key.upArrow || input === "k") return setSideCursor(Math.max(0, sideCursor - 1));
        if (key.downArrow || input === "j")
          return setSideCursor(Math.min(sideRows.length - 1, sideCursor + 1));
        if (input === "?") return setOverlay({ kind: "help" });
        if (!row) return;
        if (row.kind === "folder") {
          if (key.return || input === " " || key.leftArrow || key.rightArrow)
            store.fold(row.id, !row.collapsed);
          return;
        }
        if (key.return || key.rightArrow || input === " ")
          openChat(row.kind === "home" ? row.id : row.chatId);
        return;
      }
      case "chat": {
        if (key.upArrow || input === "k") return select(-1);
        if (key.downArrow || input === "j") return select(1);
        if (input === "g" || key.home) return setScroll({ ...scroll, bottom: Math.min(chatH, lines.length) });
        if (input === "G" || key.end) return setScroll(FOLLOW);
        if (input === "?") return setOverlay({ kind: "help" });
        if ((key.return || input === " ") && scroll.selected) {
          const id = scroll.selected;
          setOpened((was) => {
            const next = new Set(was);
            if (!next.delete(id)) next.add(id);
            return next;
          });
        }
        return;
      }
      case "card": {
        if (key.upArrow) return cardInput({ key: "up" });
        if (key.downArrow) return cardInput({ key: "down" });
        if (key.return) return cardInput({ key: "enter" });
        if (key.backspace || key.delete) return cardInput({ key: "backspace" });
        if (input === " ") return cardInput({ key: "space" });
        if (input && !key.ctrl && !key.meta) return cardInput({ key: "text", text: input });
        return;
      }
      case "queue": {
        const at = Math.min(queueCursor, queue.length - 1);
        const item = queue[at];
        if (key.upArrow || input === "k") return setQueueCursor(Math.max(0, at - 1));
        if (key.downArrow || input === "j") {
          if (at >= queue.length - 1) return go("prompt");
          return setQueueCursor(at + 1);
        }
        if (input === "r") return store.queueResume(chatId);
        if (!item) return;
        if (key.return) return store.queueNow(chatId, item.id);
        if (input === "e") {
          store.queueEdit(chatId, item.id);
          return go("prompt");
        }
        if (input === "x" || key.backspace || key.delete) return store.queueRemove(chatId, item.id);
        return;
      }
      case "pickers": {
        const at = Math.min(chipAt, chips.length - 1);
        if (key.leftArrow || input === "h") return setChipAt(Math.max(0, at - 1));
        if (key.rightArrow || input === "l") return setChipAt(Math.min(chips.length - 1, at + 1));
        if (key.upArrow) return go("prompt");
        if ((key.return || input === " " || key.downArrow) && chip) {
          return setOverlay({ kind: "menu", chip, cursor: Math.max(0, menuOf(s, controls, chip).current) });
        }
        return;
      }
      case "prompt": {
        const width = Math.max(4, textW - 2);
        if (key.return) {
          // a new line: alt+enter, shift+enter where the terminal says so,
          // or a backslash left at the end of the line
          if (key.meta || key.shift) return type(editor.insert(edit, "\n"));
          if (edit.text.slice(0, edit.caret).endsWith("\\")) {
            return type(editor.insert(editor.backspace(edit), "\n"));
          }
          if (store.prompt(chatId)) setScroll(FOLLOW);
          return;
        }
        if (input === "\n" || ctrl("j")) return type(editor.insert(edit, "\n"));
        if (input === "?" && !edit.text) return setOverlay({ kind: "help" });
        if (key.upArrow) {
          const up = editor.vertical(edit, width, -1);
          if (up) return type(up);
          if (queue.length > 0) {
            setQueueCursor(queue.length - 1);
            return go("queue");
          }
          return;
        }
        if (key.downArrow) {
          const down = editor.vertical(edit, width, 1);
          if (down) return type(down);
          return chips.length > 0 ? go("pickers") : undefined;
        }
        if (key.leftArrow) return type(key.meta || key.ctrl ? editor.wordLeft(edit) : editor.left(edit));
        if (key.rightArrow) return type(key.meta || key.ctrl ? editor.wordRight(edit) : editor.right(edit));
        if (key.home || ctrl("a")) return type(editor.home(edit));
        if (key.end || ctrl("e")) return type(editor.end(edit));
        if (key.backspace) return type(key.meta ? editor.deleteWord(edit) : editor.backspace(edit));
        if (key.delete) return type(editor.del(edit));
        if (ctrl("w")) return type(editor.deleteWord(edit));
        if (ctrl("u")) return type(editor.killToStart(edit));
        if (key.meta && input === "b") return type(editor.wordLeft(edit));
        if (key.meta && input === "f") return type(editor.wordRight(edit));
        if (input && !key.ctrl && !key.meta) return type(editor.insert(edit, input));
        return;
      }
    }
  });

  /* ── the screen ─────────────────────────────────────────────────── */

  const main: string[] = [];

  if (overlay?.kind === "help") {
    main.push(...helpLines(mainW).slice(0, chatH));
  } else if (overlay?.kind === "switcher") {
    const found = places(s, sideRows, overlay.query);
    main.push(...switcherLines(s, found, overlay.query, overlay.cursor, frame, mainW, chatH).slice(0, chatH));
  } else if (!s.ready) {
    main.push(paint.soft(s.connected ? "  reading what ruri has…" : "  looking for ruri on this computer…"));
  } else if (lines.length === 0) {
    main.push(
      paint.soft(
        s.loaded[chatId] || events?.length === 0
          ? `  Nothing here yet. Say something to ${chatName(s, chatId)}.`
          : "  opening…",
      ),
    );
  } else {
    for (const line of lines.slice(Math.max(0, bottom - chatH), bottom)) {
      const on = focus === "chat" && line.eventId !== undefined && line.eventId === scroll.selected;
      main.push(`${on ? paint.accent("▎") : " "} ${line.text}`);
    }
  }
  while (main.length < chatH) main.push("");

  main.push(...mid);
  if (queueH > 0) {
    main.push(
      ...queueLines(queue, Math.min(queueCursor, queue.length - 1), focus === "queue", mainW, queueH),
    );
  }
  main.push(` ${workingLine(s, frame, now, mainW - 2)}`);

  const quitting = now - quitAt < QUIT_MS;
  const tail = quitting ? " ctrl+c again quits " : below > 0 ? ` ↓ ${below} more · G for the newest ` : "";
  const rule = `${"─".repeat(Math.max(0, mainW - tail.length - 2))}${tail}──`;
  main.push(focus === "prompt" ? paint.accent(fit(rule, mainW)) : paint.soft(fit(rule, mainW)));

  if (!edit.text) {
    main.push(`${paint.accent("❯")} ${paint.soft(fit(`Message ${chatName(s, chatId)}…`, textW - 2))}`);
  } else {
    prompt.lines.slice(promptTop, promptTop + promptRows).forEach((line, i) => {
      main.push(`${promptTop + i === 0 ? paint.accent("❯") : " "} ${line}`);
    });
  }

  const hint =
    focus === "pickers"
      ? "←→ choose · enter open · esc back"
      : focus === "prompt"
        ? "enter send · tab move · ? help"
        : "tab move · esc to the prompt · ? help";
  main.push(controlsLine(s, controls, focus === "pickers" ? chip : undefined, hint, mainW));

  const side =
    sideW > 0 ? sidebarLines(s, sideRows, sideCursor, focus === "sidebar", sideW, bodyH, frame) : [];
  const screen = [
    headerLine(s, controls, columns),
    ...main
      .slice(0, bodyH)
      .map((line, i) => (sideW > 0 ? `${pad(side[i] ?? "", sideW)}${paint.soft("│")}${line}` : line)),
  ];

  // the real cursor stands in the prompt box, so an input method composes
  // where the words will go; anywhere else it is hidden
  setCursorPosition(
    focus === "prompt" && !overlay
      ? {
          x: left + 2 + (edit.text ? prompt.col : 0),
          y: 1 + chatH + mid.length + queueH + 2 + (prompt.row - promptTop),
        }
      : undefined,
  );

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {screen.map((line, i) => (
        <Text key={i} wrap="truncate-end">
          {line || " "}
        </Text>
      ))}
    </Box>
  );
}
