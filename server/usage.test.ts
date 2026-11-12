import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchAllUsageLimits, resetUsageBackoff } from "./usage.js";

/**
 * Both Claude sign-ins are read, each with its own token: the work one
 * under "claude", as it always was, and the personal one beside it.
 */

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["CLAUDE_CONFIG_DIR", "RURI_PERSONAL_CLAUDE_DIR", "CODEX_HOME"];
const realFetch = globalThis.fetch;
/** The bearer tokens the endpoint was asked with. */
let asked: string[];

function signIn(home: string, token: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: token } }),
  );
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-usage-"));
  process.env["CLAUDE_CONFIG_DIR"] = path.join(root, "work");
  process.env["RURI_PERSONAL_CLAUDE_DIR"] = path.join(root, "personal");
  // no Codex rollouts to find
  process.env["CODEX_HOME"] = path.join(root, "codex");
  resetUsageBackoff();
  asked = [];
  // each account's own numbers: 10% used for work, 70% for personal
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>)["authorization"]).replace("Bearer ", "");
    asked.push(token);
    const percent = token === "work-token" ? 10 : 70;
    return new Response(JSON.stringify({ limits: [{ kind: "weekly_all", percent, resets_at: null }] }));
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("each account's windows are read with its own sign-in, side by side", async () => {
  signIn(path.join(root, "work"), "work-token");
  signIn(path.join(root, "personal"), "personal-token");
  const limits = await fetchAllUsageLimits();
  expect(asked.sort()).toEqual(["personal-token", "work-token"]);
  expect(limits["claude"]?.weekly).toBe(10);
  expect(limits["claude-personal"]?.weekly).toBe(70);
});

test("with no personal sign-in on the machine, only work is asked — under claude, as before", async () => {
  signIn(path.join(root, "work"), "work-token");
  const limits = await fetchAllUsageLimits();
  expect(asked).toEqual(["work-token"]);
  expect(Object.keys(limits)).toEqual(["claude"]);
});
