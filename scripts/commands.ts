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
check("case-insensitive name", "/Compact\nthen", ["/Compact"], "then");

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all good");
