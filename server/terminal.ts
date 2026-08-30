import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * Real shells behind the composer's terminal mode — as many per channel as
 * you open tabs for.
 *
 * Each one runs on a pty, so the shell prints its prompt, colors work, and
 * anything that asks whether it is talking to a terminal gets the right
 * answer. The pty comes from `expect`, which macOS ships: it allocates one,
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
 */

const EXPECT = "/usr/bin/expect";

/** How much output a shell keeps for a client that attaches later. */
const SCROLLBACK = 200_000;

/** More tabs than this on one channel is a mistake, not an intention. */
const MAX_TABS = 12;

export interface TerminalEvents {
  onData(channelId: string, termId: string, data: string): void;
  onExit(channelId: string, termId: string, note: string): void;
}

function tabsFile(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "terminals.json",
  );
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
  buffer: string;
  /** False when this one runs on pipes — no pty available. */
  pty: boolean;
}

export class Terminals {
  /** Every live shell, by tab id. */
  private readonly shells = new Map<string, Shell>();
  /** Which tabs each channel shows, in order — live or not yet started. */
  private tabs = new Map<string, string[]>();
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
    } catch {
      // no tabs remembered yet, which is the same as none open
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(tabsFile()), { recursive: true });
      fs.writeFileSync(tabsFile(), JSON.stringify(Object.fromEntries(this.tabs), null, 2));
    } catch {
      // best-effort persistence
    }
  }

  /**
   * This channel's tabs. A channel that has never had one gets its first
   * here, so opening the panel always has something to attach to.
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
    const open = this.list(channelId);
    if (open.length >= MAX_TABS) return open;
    const next = [...open, this.mint(channelId)];
    this.tabs.set(channelId, next);
    this.save();
    return next;
  }

  /** Whether this tab already has a shell running. */
  has(termId: string): boolean {
    return this.shells.has(termId);
  }

  /** Everything this tab's shell has printed so far. */
  scrollback(termId: string): string {
    return this.shells.get(termId)?.buffer ?? "";
  }

  /* ── the shells ──────────────────────────────────────────────────── */

  /**
   * Start this tab's shell, or leave the running one alone. Returns whether
   * a shell is there to talk to.
   */
  open(channelId: string, termId: string, cwd: string, cols: number, rows: number): boolean {
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
    } catch {
      return false;
    }
    const entry: Shell = {
      channelId,
      child,
      decoder: new StringDecoder("utf8"),
      buffer: "",
      pty,
    };
    this.shells.set(termId, entry);

    const push = (chunk: Buffer) => {
      const text = entry.decoder.write(chunk);
      if (!text) return;
      entry.buffer = (entry.buffer + text).slice(-SCROLLBACK);
      this.events.onData(channelId, termId, text);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", () => {
      this.shells.delete(termId);
      this.events.onExit(channelId, termId, "this shell could not start");
    });
    child.on("exit", () => {
      this.shells.delete(termId);
      this.events.onExit(channelId, termId, "shell exited");
    });
    // A login shell's startup banner is written for a full-height window and
    // leaves this panel opening on the tail of someone's ASCII art. ^L is a
    // keystroke, not a command: zsh clears and redraws the prompt at the top
    // without a line of it appearing in the scrollback.
    if (pty) setTimeout(() => this.write(termId, "\x0c"), 700);
    return true;
  }

  write(termId: string, data: string): void {
    this.shells.get(termId)?.child.stdin?.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    const shell = this.shells.get(termId);
    if (!shell?.pty) return;
    shell.child.stdin?.write(resizeSequence(cols, rows));
  }

  /**
   * Close one tab: its shell dies and the tab goes with it. A channel is
   * never left with none — closing the last one leaves a fresh, unstarted
   * tab in its place, which is what "the panel is still here" looks like.
   */
  close(channelId: string, termId: string): string[] {
    this.kill(termId);
    const open = this.list(channelId).filter((id) => id !== termId);
    const next = open.length > 0 ? open : [this.mint(channelId)];
    this.tabs.set(channelId, next);
    this.save();
    return next;
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
