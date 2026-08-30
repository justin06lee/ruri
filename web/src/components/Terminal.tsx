import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onTerminal, send, useRuri } from "../store";

/**
 * The composer's other mode: real shells in the project's directory, in the
 * box you'd otherwise type a prompt into. They're the same shell you'd get in
 * Terminal.app — your rc files, your prompt, your colors — and they keep
 * running while you're away, so coming back finds them where you left them.
 *
 * A channel can have as many as you open tabs for. The tab row is the
 * server's: it outlives the window, so reopening the panel finds the same
 * row, each tab starting a fresh shell the first time it's looked at.
 *
 * The type is the app's mono face and the colors come from the theme
 * tokens, read off the document so light, dark and ember all just work.
 */

/** Read a CSS variable off the root, since xterm wants concrete colors. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function themeColors(): Record<string, string> {
  const ink = token("--ink", "#191510");
  const faint = token("--ink-faint", "#8b8271");
  return {
    background: "rgba(0, 0, 0, 0)",
    foreground: ink,
    cursor: ink,
    cursorAccent: token("--paper", "#f6f1e6"),
    selectionBackground: token("--line-faint", "rgba(0,0,0,0.14)"),
    black: faint,
    red: token("--diff-del-ink", "#8f3f34"),
    green: token("--diff-add-ink", "#3f6b4b"),
    yellow: ink,
    blue: token("--ink-soft", "#464035"),
    magenta: ink,
    cyan: token("--ink-soft", "#464035"),
    white: ink,
    brightBlack: faint,
    brightRed: token("--diff-del-ink", "#8f3f34"),
    brightGreen: token("--diff-add-ink", "#3f6b4b"),
    brightYellow: ink,
    brightBlue: token("--ink-soft", "#464035"),
    brightMagenta: ink,
    brightCyan: token("--ink-soft", "#464035"),
    brightWhite: ink,
  };
}

/** Which tab each channel was last looking at — the panel unmounts every
 *  time you switch back to writing a prompt, and coming back should land on
 *  the shell you were using, not the first one. */
const lastTab = new Map<string, string>();

/**
 * One tab's shell. Hidden tabs stay mounted at the same size, so switching
 * back is instantaneous and a long-running command keeps drawing while you
 * are looking at another one.
 */
function TerminalView({
  channelId,
  termId,
  shown,
}: {
  channelId: string;
  termId: string;
  shown: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Xterm({
      allowProposedApi: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
      fontSize: 12,
      lineHeight: 1.25,
      theme: themeColors(),
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    /** Fit to the panel and tell the shell its new size. */
    const measure = () => {
      try {
        fit.fit();
      } catch {
        // the panel is mid-layout — the next observation gets it
        return;
      }
      send({ type: "terminal_resize", projectId: channelId, termId, cols: term.cols, rows: term.rows });
    };
    // the first fit decides the size the shell starts at
    try {
      fit.fit();
    } catch {
      // fall through to the defaults
    }
    send({ type: "terminal_open", projectId: channelId, termId, cols: term.cols, rows: term.rows });

    const stopData = onTerminal(termId, (message) => {
      if (message.kind === "data") {
        if (message.replay) term.reset();
        term.write(message.data);
      } else {
        term.write(`\r\n\x1b[2m— ${message.note} —\x1b[0m\r\n`);
      }
    });
    const typing = term.onData((data) =>
      send({ type: "terminal_input", projectId: channelId, termId, data }),
    );

    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    // the theme can change under a running shell
    const themes = new MutationObserver(() => {
      term.options.theme = themeColors();
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      observer.disconnect();
      themes.disconnect();
      typing.dispose();
      stopData();
      termRef.current = null;
      term.dispose();
    };
  }, [channelId, termId]);

  // Typing goes to whichever tab is on top.
  useEffect(() => {
    if (shown) termRef.current?.focus();
  }, [shown]);

  return <div className={`terminal-view ${shown ? "" : "hidden"}`} ref={hostRef} />;
}

export function TerminalPanel({ channelId }: { channelId: string }) {
  const tabs = useRuri((s) => s.terminals[channelId]);
  const [active, setActive] = useState<string | null>(() => lastTab.get(channelId) ?? null);

  // The tab row belongs to the server — ask for it, and it answers with at
  // least one tab, always.
  useEffect(() => {
    send({ type: "terminal_list", projectId: channelId });
  }, [channelId]);

  // Follow the row: a tab closing (or a first row arriving) has to land the
  // selection somewhere real, and a tab *added* is one you want to be in.
  const known = useRef<string[]>([]);
  useEffect(() => {
    if (!tabs || tabs.length === 0) return;
    const added = tabs.find((id) => !known.current.includes(id));
    known.current = tabs;
    setActive((current) => {
      if (added && current !== null) return added;
      if (current && tabs.includes(current)) return current;
      const remembered = lastTab.get(channelId);
      return remembered && tabs.includes(remembered) ? remembered : (tabs[0] ?? null);
    });
  }, [tabs, channelId]);

  useEffect(() => {
    if (active) lastTab.set(channelId, active);
  }, [channelId, active]);

  const open = tabs ?? [];

  // The shortcuts a terminal is expected to have. Capture phase, because
  // xterm has the keyboard while a shell is focused and would otherwise
  // swallow them on their way past.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "t") {
        e.preventDefault();
        send({ type: "terminal_new", projectId: channelId });
        return;
      }
      const nth = Number(e.key);
      if (!Number.isInteger(nth) || nth < 1 || nth > 9) return;
      const target = open[nth - 1];
      if (!target) return;
      e.preventDefault();
      setActive(target);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [channelId, open]);

  return (
    <div className="terminal">
      <div className="term-tabs">
        {open.map((id, index) => (
          <span key={id} className={`term-tab ${id === active ? "on" : ""}`}>
            <button
              className="term-tab-name"
              title={`Shell ${index + 1}`}
              onClick={() => setActive(id)}
            >
              {index + 1}
            </button>
            <button
              className="term-tab-close"
              title="Close this shell"
              onClick={() => send({ type: "terminal_close", projectId: channelId, termId: id })}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
            </button>
          </span>
        ))}
        <button
          className="term-add"
          title="A new shell in this project"
          onClick={() => send({ type: "terminal_new", projectId: channelId })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="term-stack">
        {open.map((id) => (
          <TerminalView key={id} channelId={channelId} termId={id} shown={id === active} />
        ))}
      </div>
    </div>
  );
}
