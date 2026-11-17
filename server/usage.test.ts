import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addAccount } from "./accounts.js";
import { fetchAllUsageLimits, resetUsageBackoff } from "./usage.js";

/**
 * Every Claude sign-in is read, each with its own token: the work one
 * under "claude", as it always was, and every other beside it. Each Codex
 * account's windows come from the rollouts under its own home.
 */

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = [
  "CLAUDE_CONFIG_DIR",
  "RURI_PERSONAL_CLAUDE_DIR",
  "CODEX_HOME",
  "RURI_ACCOUNT_HOMES",
  "RURI_CONFIG_DIR",
];
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
  process.env["RURI_ACCOUNT_HOMES"] = path.join(root, "homes");
  process.env["RURI_CONFIG_DIR"] = path.join(root, "config");
  resetUsageBackoff();
  asked = [];
  // each account's own numbers: 10% used for work, 70% for personal, 100
  // for any other
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const token = String((init?.headers as Record<string, string>)["authorization"]).replace("Bearer ", "");
    asked.push(token);
    const percent = token === "work-token" ? 10 : token === "personal-token" ? 70 : 100;
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

test("an added account is read with its own sign-in, under its own key", async () => {
  signIn(path.join(root, "work"), "work-token");
  const side = addAccount("claude", "Side");
  signIn(side.dir, "side-token");
  const limits = await fetchAllUsageLimits();
  expect(asked.sort()).toEqual(["side-token", "work-token"]);
  expect(limits["claude:side"]?.weekly).toBe(100);
});

test("each Codex account's windows come from its own rollouts", async () => {
  const rollout = (home: string, percent: number) => {
    const day = path.join(home, "sessions", "2026", "11", "17");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, "rollout-a.jsonl"),
      `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: percent }, secondary: { used_percent: percent } } } })}\n`,
    );
  };
  const side = addAccount("codex", "Side");
  rollout(path.join(root, "codex"), 20);
  rollout(side.dir, 90);
  const limits = await fetchAllUsageLimits();
  expect(limits["codex"]?.fiveHour).toBe(20);
  expect(limits["codex:side"]?.weekly).toBe(90);
});
