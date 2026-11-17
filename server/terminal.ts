import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { StringDecoder } from "node:string_decoder";
import { isMissing, warn } from "./log.js";
import { Scrollback } from "./scrollback.js";

/**
 * Real shells behind the composer's terminal mode — as many per channel as
 * you open tabs for.
 *
 * Each one runs on a pty, so the shell prints its prompt, colors work, and
 * anything that asks whether it is talking to a terminal gets the right
 * answer. The pty comes from `expect`, which macOS ships (on Linux it is a
 * package, which `make` installs — the Makefile's linux-deps): it allocates one,
 * runs the login shell on it, and proxies bytes both ways — which is exactly
 * what a native pty binding would do, without a native binding to build,
 * rebuild per Electron ABI, and unpack from the asar. `script` can't stand
 * in for it (it wants its own stdin to be a terminal, which ours never is).
 *
 * Resizes ride in on a control sequence expect watches for on the input
 * side, so it can call stty on the pty without the shell ever seeing it.
 * Where there is no expect, the shell runs on plain pipes instead: commands
 * still run and output still streams, it just isn't a terminal.
 *
 * The tab list outlives the app. The shells cannot — they are children of
 * this process — but which tabs a project had open is worth keeping, so
 * reopening the panel finds the same row of tabs and each one starts a fresh
 * shell in the project's directory the moment it is looked at.
 *
 * A shell that is quit (`exit`, ^D) takes its tab with it, and so does a tab
 * closed by hand; a channel left with none has no shell pane, until it is
 * asked for again and gets a first tab.
 */

const EXPECT = "/usr/bin/expect";

/** How much output a shell keeps for a client that attaches later. */
const SCROLLBACK = 200_000;

/** More tabs than this on one channel is a mistake, not an intention. */
const MAX_TABS = 12;

/** A shell gone this soon, and unhappily, never started properly: its tab
 *  stays, with the note, rather than the pane blinking shut unexplained. */
const FALSE_START_MS = 1_500;

export interface TerminalEvents {
  onData(channelId: string, termId: string, data: string): void;
  onExit(channelId: string, termId: string, note: string): void;
  /** A channel's row of tabs changed with nobody closing one: a shell was
   *  quit, and its tab went with it. */
  onTabs(channelId: string, tabs: string[]): void;
}

function tabsFile(): string {
  return configPath("terminals.json");
}

/**
 * A size off the wire, made safe for the Tcl it lands in: a whole number
 * from 1 to 1000, or the default. Anything else — a fraction, a negative,
 * NaN, a string that got past the parser — would be spliced straight into
 * a script.
 */
export function dimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000
    ? value
    : fallback;
}

/** The control sequence expect intercepts: cols and rows, never forwarded. */
function resizeSequence(cols: number, rows: number): string {
  return `\x00R${cols}x${rows}\x00`;
}

function expectScript(shell: string, cols: number, rows: number): string {
  // Tcl, not shell: interact forwards both directions, and the -re pattern
  // pulls the resize sequence out of the input stream before the pty sees it.
  // The size is set before the spawn, so the shell draws its first prompt at
  // the panel's real size rather than at the top of a screen that isn't there.
  return [
    `set stty_init "rows ${rows} columns ${cols}"`,
    `spawn -noecho ${shell} -il`,
    `interact {`,
    `  -re "\\x00R(\\[0-9]+)x(\\[0-9]+)\\x00" {`,
    `    stty rows $interact_out(2,string) columns $interact_out(1,string) < $spawn_out(slave,name)`,
    `  }`,
    `}`,
  ].join("\n");
}

interface Shell {
  channelId: string;
  child: ChildProcess;
  decoder: StringDecoder;
  /** What it has printed, trimmed to the scrollback budget. */
  buffer: Scrollback;
  /** False when this one runs on pipes — no pty available. */
  pty: boolean;
}

export class Terminals {
  /** Every live shell, by tab id. */
  private readonly shells = new Map<string, Shell>();
  /** Which tabs each channel shows, in order — live or not yet started. */
  private tabs = new Map<string, string[]>();
  /** What a tab started by run() types into its shell once it is up. */
  private readonly commands = new Map<string, string>();
  /** Channels whose tabs were made by run(): there for the one command,
   *  so not remembered past this run of ruri. */
  private readonly passing = new Set<string>();
  private loaded = false;

  constructor(private readonly events: TerminalEvents) {}

  /* ── the tab row ─────────────────────────────────────────────────── */

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(tabsFile(), "utf8")) as Record<string, unknown>;
      for (const [channelId, ids] of Object.entries(raw)) {
        if (!Array.isArray(ids)) continue;
        const clean = ids.filter((id): id is string => typeof id === "string").slice(0, MAX_TABS);
        if (clean.length > 0) this.tabs.set(channelId, clean);
      }
    } catch (err) {
      if (!isMissing(err)) warn("terminal", err, "load");
      // no tabs remembered yet, which is the same as none open
    }
  }

  private save(): void {
    try {
      const kept = [...this.tabs].filter(([channelId]) => !this.passing.has(channelId));
      writeJsonAtomic(tabsFile(), Object.fromEntries(kept), 2);
    } catch (err) {
      warn("terminal", err, "save");
      // best-effort persistence
    }
  }

  /**
   * This channel's tabs. A channel that has none — it never had one, or its
   * last was closed — gets its first here, so opening the pane always has
   * something to attach to.
   */
  list(channelId: string): string[] {
    this.load();
    const open = this.tabs.get(channelId);
    if (open && open.length > 0) return open;
    const first = [this.mint(channelId)];
    this.tabs.set(channelId, first);
    this.save();
    return first;
  }

  /** A tab id nothing else is using — readable, and stable across restarts. */
  private mint(channelId: string): string {
    const used = new Set(this.tabs.get(channelId) ?? []);
    for (let n = 1; ; n += 1) {
      const id = `${channelId}#${n}`;
      if (!used.has(id)) return id;
    }
  }

  /** One more tab on this channel — its shell starts when it is looked at. */
  add(channelId: string): string[] {
    this.load();
    const open = this.tabs.get(channelId) ?? [];
    if (open.length >= MAX_TABS) return open;
    const next = [...open, this.mint(channelId)];
    this.tabs.set(channelId, next);
    this.save();
    return next;
  }

  /**
   * A shell for one command: whatever this channel had goes, and its one
   * tab types `command` into its shell once the shell is up — where the
   * user sees it run, and can answer it. A command that ends `&& exit`
   * takes the tab with it when it succeeds, and leaves its words on screen
   * when it fails.
   */
  run(channelId: string, command: string): string[] {
    this.load();
    for (const termId of this.tabs.get(channelId) ?? []) this.kill(termId);
    const termId = `${channelId}#run-${Date.now().toString(36)}`;
    this.tabs.set(channelId, [termId]);
    this.commands.set(termId, command);
    this.passing.add(channelId);
    return [termId];
  }

  /** Whether this tab already has a shell running. */
  has(termId: string): boolean {
    return this.shells.has(termId);
  }

  /** Every running shell's process id. A shell is ruri's own machinery,
   *  not an agent, and the meters need to tell them apart
   *  (server/resources.ts). */
  pids(): number[] {
    const out: number[] = [];
    for (const shell of this.shells.values()) if (shell.child.pid !== undefined) out.push(shell.child.pid);
    return out;
  }

  /** Everything this tab's shell has printed so far. */
  scrollback(termId: string): string {
    return this.shells.get(termId)?.buffer.read() ?? "";
  }

  /* ── the shells ──────────────────────────────────────────────────── */

  /**
   * Start this tab's shell, or leave the running one alone. Returns whether
   * a shell is there to talk to.
   */
  open(channelId: string, termId: string, cwd: string, cols: number, rows: number): boolean {
    cols = dimension(cols, 80);
    rows = dimension(rows, 24);
    const running = this.shells.get(termId);
    if (running) {
      this.resize(termId, cols, rows);
      return true;
    }
    const shell = process.env["SHELL"] ?? "/bin/zsh";
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
      // a pager that takes over the screen inside a panel this small is a
      // trap — git and friends print and get out of the way instead
      GIT_PAGER: "cat",
      PAGER: "cat",
    };
    const pty = fs.existsSync(EXPECT);
    let child: ChildProcess;
    try {
      child = pty
        ? spawn(EXPECT, ["-c", expectScript(shell, cols, rows)], { cwd, env })
        : spawn(shell, ["-i"], { cwd, env });
    } catch (err) {
      warn("terminal", err, "open");
      return false;
    }
    const entry: Shell = {
      channelId,
      child,
      decoder: new StringDecoder("utf8"),
      buffer: new Scrollback(SCROLLBACK),
      pty,
    };
    this.shells.set(termId, entry);

    const push = (chunk: Buffer) => {
      const text = entry.decoder.write(chunk);
      if (!text) return;
      entry.buffer.push(text);
      this.events.onData(channelId, termId, text);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    const started = Date.now();
    child.on("error", () => {
      if (this.shells.get(termId) === entry) this.shells.delete(termId);
      this.events.onExit(channelId, termId, "this shell could not start");
    });
    child.on("exit", (code) => {
      // still the tab's shell: it ended itself, rather than being killed
      // with its tab (kill takes it off the books first) — and a shell
      // started since on the same tab is not this one's to take down
      const quit = this.shells.get(termId) === entry;
      if (quit) this.shells.delete(termId);
      this.events.onExit(channelId, termId, "shell exited");
      if (!quit || (code !== 0 && Date.now() - started < FALSE_START_MS)) return;
      // quit from inside: the tab is done with, and goes
      const open = this.tabs.get(channelId) ?? [];
      if (!open.includes(termId)) return;
      const left = open.filter((id) => id !== termId);
      if (left.length > 0) this.tabs.set(channelId, left);
      else this.tabs.delete(channelId);
      this.save();
      this.events.onTabs(channelId, left);
    });
    // A login shell's startup banner is written for a full-height window and
    // leaves this panel opening on the tail of someone's ASCII art. ^L is a
    // keystroke, not a command: zsh clears and redraws the prompt at the top
    // without a line of it appearing in the scrollback.
    if (pty) setTimeout(() => this.write(termId, "\x0c"), 700);
    // after that, so the clear doesn't land on the command's own screen
    const command = this.commands.get(termId);
    if (command !== undefined) {
      this.commands.delete(termId);
      setTimeout(() => this.write(termId, `${command}\n`), pty ? 900 : 50);
    }
    return true;
  }

  write(termId: string, data: string): void {
    this.shells.get(termId)?.child.stdin?.write(data);
  }

  /**
   * Stop or restart reading this tab's shell.
   *
   * Held, the pty is not read; the program writing to it fills the pty's
   * own buffer and then blocks on its next write, which is what a terminal
   * emulator nobody is reading does. The relay holds a tab only while every
   * window is behind on it, and lets go the moment one catches up
   * (server/relay.ts).
   */
  hold(termId: string, held: boolean): void {
    const shell = this.shells.get(termId);
    if (!shell) return;
    if (held) {
      shell.child.stdout?.pause();
      shell.child.stderr?.pause();
    } else {
      shell.child.stdout?.resume();
      shell.child.stderr?.resume();
    }
  }

  resize(termId: string, cols: number, rows: number): void {
    const shell = this.shells.get(termId);
    if (!shell?.pty) return;
    shell.child.stdin?.write(resizeSequence(dimension(cols, 80), dimension(rows, 24)));
  }

  /**
   * Close one tab: its shell dies and the tab goes with it. Closing the
   * last one leaves the channel with none — the pane goes with it, and the
   * next time it is asked for (list) it starts on a fresh tab.
   */
  close(channelId: string, termId: string): string[] {
    this.load();
    this.kill(termId);
    const left = (this.tabs.get(channelId) ?? []).filter((id) => id !== termId);
    if (left.length > 0) this.tabs.set(channelId, left);
    else this.tabs.delete(channelId);
    this.save();
    return left;
  }

  /** Everything this channel had: its shells die and its tabs are forgotten
   *  (the session itself is going away). */
  closeChannel(channelId: string): void {
    this.load();
    for (const termId of this.tabs.get(channelId) ?? []) this.kill(termId);
    this.tabs.delete(channelId);
    this.save();
  }

  /** Kill every running shell, leaving the tab rows to be found again. */
  closeAll(): void {
    for (const termId of [...this.shells.keys()]) this.kill(termId);
  }

  private kill(termId: string): void {
    const shell = this.shells.get(termId);
    if (!shell) return;
    this.shells.delete(termId);
    shell.child.kill();
  }
}
