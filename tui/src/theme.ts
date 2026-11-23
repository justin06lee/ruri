/**
 * ruri's colours, for a terminal. The desktop is ink on paper with one
 * accent (web/src/styles.css): here the terminal's own foreground and
 * background are the ink and the paper, so it follows a light or a dark
 * terminal by itself, and only what carries meaning is coloured: the
 * accent blue, red for what stopped or is nearly full, green and red for a
 * patch, amber for what waits on you.
 */
import chalk from "chalk";

export const ACCENT = "#0a84ff";
export const RED = "#ff453a";
export const GREEN = "#30d158";
export const AMBER = "#ff9f0a";

export const paint = {
  accent: chalk.hex(ACCENT),
  red: chalk.hex(RED),
  green: chalk.hex(GREEN),
  amber: chalk.hex(AMBER),
  /** The second voice: labels, hints, what a tool did. */
  soft: chalk.dim,
  bold: chalk.bold,
  italic: chalk.italic,
  underline: chalk.underline,
  strike: chalk.strikethrough,
  inverse: chalk.inverse,
  code: chalk.hex("#64d2ff"),
};

/** The frames of the working spinner, stepped by the app's one clock. */
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
