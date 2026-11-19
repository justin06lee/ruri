/**
 * `bun test`'s preload: a config folder of the run's own, made before any
 * test file is loaded, and gone when the run ends.
 *
 * Tests that touch the config set their own folder and put back whatever
 * was there before. Without this, what was there before is the user's own
 * ~/.config/ruri — so a store that wrote a moment after its test had ended
 * (or a test that set no folder at all) wrote into the user's live data:
 * a test's one-project briefs.json over every project's sheets.
 */
import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-test-config-"));
process.env["RURI_CONFIG_DIR"] = dir;
// …and no ghostly: a server made in a test must never ask the user's own
// vault what it holds (server/ghostly.ts), nor look at their tailnet for
// one (server/tailnet.ts). A test of either names a stand-in.
process.env["RURI_GHOSTLY"] = "";
process.env["RURI_TAILSCALE"] = "";
// …and no Ollama: a catalog probed in a test must not list the user's own
// local models, or make a copy of one (server/ollama.ts).
process.env["RURI_OLLAMA"] = "";
// …and none of the user's accounts: no account added in a test makes a
// folder in their home, no status is asked of their own Claude Code or
// Codex, and the personal and Codex homes are folders of the run's own
// (server/accounts.ts, accountStatus.ts). A test of either names its own.
process.env["RURI_ACCOUNT_HOMES"] = path.join(dir, "homes");
process.env["RURI_PERSONAL_CLAUDE_DIR"] = path.join(dir, "homes", ".claude-personal");
process.env["CODEX_HOME"] = path.join(dir, "homes", ".codex");
process.env["RURI_CLAUDE_CLI"] = "";
process.env["RURI_CODEX_CLI"] = "";
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
