import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { onTerminal, send } from "../store";

/**
 * The composer's other mode: a real shell in the project's directory, in the
 * box you'd otherwise type a prompt into. It's the same shell you'd get in
 * Terminal.app — your rc files, your prompt, your colors — and it keeps
 * running while you're away, so coming back finds it where you left it.
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

export function TerminalPanel({ channelId }: { channelId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

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
      send({ type: "terminal_resize", projectId: channelId, cols: term.cols, rows: term.rows });
    };
    // the first fit decides the size the shell starts at
    try {
      fit.fit();
    } catch {
      // fall through to the defaults
    }
    send({ type: "terminal_open", projectId: channelId, cols: term.cols, rows: term.rows });

    const stopData = onTerminal(channelId, (message) => {
      if (message.kind === "data") {
        if (message.replay) term.reset();
        term.write(message.data);
      } else {
        term.write(`\r\n\x1b[2m— ${message.note} —\x1b[0m\r\n`);
      }
    });
    const typing = term.onData((data) =>
      send({ type: "terminal_input", projectId: channelId, data }),
    );

    const observer = new ResizeObserver(() => measure());
    observer.observe(host);
    // the theme can change under a running shell
    const themes = new MutationObserver(() => {
      term.options.theme = themeColors();
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    term.focus();
    return () => {
      observer.disconnect();
      themes.disconnect();
      typing.dispose();
      stopData();
      term.dispose();
    };
  }, [channelId]);

  return <div className="terminal" ref={hostRef} />;
}
