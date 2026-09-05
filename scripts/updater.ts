/**
 * Where a harness came from is read off its real path — and that decides
 * how it is updated. Pure checks, no package manager touched.
 * Run manually: bun run updater-test
 */
import { channelOf } from "../server/updater.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

const home = "/Users/someone";
const claude = channelOf("claude", `${home}/.local/share/claude/versions/2.1.261`);
check("claude's native install updates itself", claude.channel === "self", claude);
check("claude by any path updates itself", channelOf("claude", "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js").channel === "self");
check("opencode's own install updates itself", channelOf("opencode", `${home}/.opencode/bin/opencode`).channel === "self");

const codex = channelOf("codex", "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js");
check("a global npm package is npm's, by its scoped name", codex.channel === "npm" && codex.pkg === "@openai/codex", codex);
const gemini = channelOf("gemini", "/opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js");
check("the package is the two segments after node_modules", gemini.pkg === "@google/gemini-cli", gemini);
const plain = channelOf("thing", "/usr/local/lib/node_modules/thing-cli/bin/run");
check("an unscoped package is one segment", plain.channel === "npm" && plain.pkg === "thing-cli", plain);
const bun = channelOf("codex", `${home}/.bun/install/global/node_modules/@openai/codex/bin/codex.js`);
check("bun's global dir is bun's", bun.channel === "bun" && bun.pkg === "@openai/codex", bun);

const goose = channelOf("goose", "/opt/homebrew/Cellar/goose/3.27.3/bin/goose");
check("a brew cellar path is brew's formula", goose.channel === "brew" && goose.pkg === "goose", goose);
check("a bare binary somewhere else is left alone", channelOf("mystery", "/usr/local/bin/mystery").channel === "other");
check("a cargo install is left alone", channelOf("acp-thing", `${home}/.cargo/bin/acp-thing`).channel === "other");

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
