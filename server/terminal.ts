import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * A real shell per channel, behind the composer's terminal mode.
 *
 * It runs on a pty, so the shell prints its prompt, colors work, and
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
 */

const EXPECT = "/usr/bin/expect";

/** How much output a shell keeps for a client that attaches later. */
const SCROLLBACK = 200_000;

export interface TerminalEvents {
  onData(channelId: string, data: string): void;
  onExit(channelId: string, note: string): void;
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
  child: ChildProcess;
  decoder: StringDecoder;
  /** What it has printed, trimmed to the scrollback budget. */
  buffer: string;
  /** False when this one runs on pipes — no pty available. */
  pty: boolean;
}

export class Terminals {
  private readonly shells = new Map<string, Shell>();

  constructor(private readonly events: TerminalEvents) {}

  /** Whether this channel already has a shell running. */
  has(channelId: string): boolean {
    return this.shells.has(channelId);
  }

  /** Everything this channel's shell has printed so far. */
  scrollback(channelId: string): string {
    return this.shells.get(channelId)?.buffer ?? "";
  }

  /**
   * Start this channel's shell, or leave the running one alone. Returns
   * whether a shell is there to talk to.
   */
  open(channelId: string, cwd: string, cols: number, rows: number): boolean {
    const running = this.shells.get(channelId);
    if (running) {
      this.resize(channelId, cols, rows);
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
    const entry: Shell = { child, decoder: new StringDecoder("utf8"), buffer: "", pty };
    this.shells.set(channelId, entry);

    const push = (chunk: Buffer) => {
      const text = entry.decoder.write(chunk);
      if (!text) return;
      entry.buffer = (entry.buffer + text).slice(-SCROLLBACK);
      this.events.onData(channelId, text);
    };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", () => {
      this.shells.delete(channelId);
      this.events.onExit(channelId, "this shell could not start");
    });
    child.on("exit", () => {
      this.shells.delete(channelId);
      this.events.onExit(channelId, "shell exited");
    });
    // A login shell's startup banner is written for a full-height window and
    // leaves this panel opening on the tail of someone's ASCII art. ^L is a
    // keystroke, not a command: zsh clears and redraws the prompt at the top
    // without a line of it appearing in the scrollback.
    if (pty) setTimeout(() => this.write(channelId, "\x0c"), 700);
    return true;
  }

  write(channelId: string, data: string): void {
    this.shells.get(channelId)?.child.stdin?.write(data);
  }

  resize(channelId: string, cols: number, rows: number): void {
    const shell = this.shells.get(channelId);
    if (!shell?.pty) return;
    shell.child.stdin?.write(resizeSequence(cols, rows));
  }

  /** Close one channel's shell (its project closed, or the user asked). */
  close(channelId: string): void {
    const shell = this.shells.get(channelId);
    if (!shell) return;
    this.shells.delete(channelId);
    shell.child.kill();
  }

  closeAll(): void {
    for (const channelId of [...this.shells.keys()]) this.close(channelId);
  }
}
