/**
 * Slash commands inside prompts: what gets lifted out and run first, and
 * what stays in the prompt as words. Pure — no server, no tokens:
 *   bun run commands-test
 */
import { splitCommands } from "../server/commands.js";

const known = new Set(["compact", "clear", "simplify", "code-review"]);
let failed = 0;
function check(name: string, text: string, commands: string[], rest: string): void {
  const got = splitCommands(text, known);
  const ok = JSON.stringify(got.commands) === JSON.stringify(commands) && got.rest === rest;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    console.log("  expected", JSON.stringify({ commands, rest }));
    console.log("  got     ", JSON.stringify(got));
  }
}

check("plain prompt", "fix the header\nand the footer", [], "fix the header\nand the footer");
check("command on its own line", "/compact\nnow fix the header", ["/compact"], "now fix the header");
check("command at the end", "fix the header\n\n/compact", ["/compact"], "fix the header");
check("command with arguments", "/simplify web/src\nthen commit", ["/simplify web/src"], "then commit");
check("two commands, in order", "/compact\n/code-review high\nlook at this", ["/compact", "/code-review high"], "look at this");
check("inline compact as a word", "fix the header and /compact before you start on the footer", ["/compact"], "fix the header and before you start on the footer");
check("inline compact at line end", "long prompt here /compact\nmore", ["/compact"], "long prompt here\nmore");
check("single-quoted is words", "the '/compact' command is ruri's own", [], "the '/compact' command is ruri's own");
check("double-quoted is words", "type \"/compact\" to compact", [], "type \"/compact\" to compact");
check("backticked is words", "run `/compact` first", [], "run `/compact` first");
check("quoted whole line is words", "\"/compact\"", [], "\"/compact\"");
check("unknown command stays", "/tmp\nis a path", [], "/tmp\nis a path");
check("path stays", "/Users/me/file.txt has it", [], "/Users/me/file.txt has it");
check("skill with args needs its own line", "run /simplify now", [], "run /simplify now");
check("only a command", "/compact", ["/compact"], "");
check("indentation kept on untouched lines", "code:\n    indented\n/compact", ["/compact"], "code:\n    indented");
// ruri's own name comes back in ruri's own spelling, because the server
// matches it exactly to decide the command is its own — lifted as typed,
// "/Compact" went to the harness, which has a /compact of its own
check("case-insensitive name, normalised", "/Compact\nthen", ["/compact"], "then");

// ruri's commands take no arguments, so what follows one on its line is the
// prompt, not the command's business. Typing "/compact" at the head of a
// prompt is the ordinary way to ask for one, and it used to hand the whole
// line to the harness — whose own /compact then ran instead of ruri's.
check(
  "compact at the head of a prompt",
  "/compact Ok analyze this codebase and do all 7 of those things.",
  ["/compact"],
  "Ok analyze this codebase and do all 7 of those things.",
);
check(
  "compact at the head of a several-line prompt",
  "/compact read the provider layer\nthen fix the header",
  ["/compact"],
  "read the provider layer\nthen fix the header",
);
check(
  "a harness command at the head keeps its arguments",
  "/code-review high\nthen commit",
  ["/code-review high"],
  "then commit",
);

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all good");
