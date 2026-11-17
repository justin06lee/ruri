import { describe, expect, test } from "bun:test";
import type { AccountInfo, Project } from "../../../shared/protocol";
import { channelAccount, usageName, usageWord, withPick } from "./accounts";

/**
 * The window works out which account a chat runs on the way the server
 * does: the project's pick for the chat's harness while it is still one of
 * that harness's accounts, Home's own for Home, else the default.
 */

const accounts: AccountInfo[] = [
  { id: "work", name: "Work", provider: "claude", dir: "/w", builtIn: true, usage: "claude" },
  {
    id: "personal",
    name: "Personal",
    provider: "claude",
    dir: "/p",
    builtIn: true,
    usage: "claude-personal",
  },
  { id: "side", name: "Side", provider: "claude", dir: "/s", usage: "claude:side" },
  { id: "codex", name: "Codex", provider: "codex", dir: "/c", builtIn: true, usage: "codex" },
];
const projects: Project[] = [
  { id: "p", name: "p", path: "/p", accounts: { claude: "side" }, sessions: [{ id: "chat" }] },
  { id: "q", name: "q", path: "/q", account: "personal", sessions: [{ id: "old" }] },
  { id: "r", name: "r", path: "/r", accounts: { claude: "gone" }, sessions: [{ id: "lost" }] },
];
const state = { projects, home: { accounts: { claude: "personal" } }, accounts };

describe("which account a chat runs on", () => {
  test("its project's pick for its harness, by the project's id or a chat's", () => {
    expect(channelAccount(state, "chat", "claude")?.id).toBe("side");
    expect(channelAccount(state, "p", undefined)?.id).toBe("side");
    expect(channelAccount(state, "chat", "codex")?.id).toBe("codex");
  });

  test("the pick from before there were others, Home's own, and one since removed", () => {
    expect(channelAccount(state, "old", "claude")?.id).toBe("personal");
    expect(channelAccount(state, "home", "claude")?.id).toBe("personal");
    expect(channelAccount(state, "lost", "claude")?.id).toBe("work");
  });

  test("a harness ruri has no accounts for has none", () => {
    expect(channelAccount(state, "chat", "gemini")).toBeUndefined();
  });

  test("the default is said by saying nothing", () => {
    expect(withPick({ claude: "side" }, accounts[0]!)).toBeUndefined();
    expect(withPick({ claude: "side" }, accounts[3]!)).toEqual({ claude: "side" });
    expect(withPick(undefined, accounts[1]!)).toEqual({ claude: "personal" });
  });
});

test("each account's limits are named by the account once a harness has more than one", () => {
  const usage = { claude: {}, "claude:side": {}, codex: {} };
  expect(usageName(accounts, usage, "claude")).toBe("claude (work)");
  expect(usageName(accounts, usage, "claude:side")).toBe("claude (side)");
  expect(usageName(accounts, usage, "codex")).toBe("codex");
  expect(usageWord({ weekly: 66, scoped: { label: "Fable", percent: 100 } })).toBe("Fable 100%");
  expect(usageWord(undefined)).toBe("");
});
