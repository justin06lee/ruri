import { describe, expect, test } from "bun:test";
import { blockedBy, ConnectionWatch, limitResetsAt } from "./blocked.js";

describe("what a failed turn was up against", () => {
  test("the connection, in the words the harnesses use for it", () => {
    for (const text of [
      "API Error: Can’t reach the API server — check your internet or DNS (ENOTFOUND)",
      "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)",
      "API Error: Connection error.",
      "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
      "fetch failed",
      "read ECONNRESET",
    ]) {
      expect([text, blockedBy(text)]).toEqual([text, "network"]);
    }
  });

  test("the account's usage, whichever way it is put", () => {
    for (const text of [
      "Claude AI usage limit reached|1790000000",
      "You've hit your limit · resets 7pm (America/Los_Angeles)",
      "5-hour limit reached ∙ resets 3pm",
      "Weekly limit reached ∙ resets Oct 6, 3pm",
      "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 3 minutes.",
      "exceeded retry limit, last status: 429 Too Many Requests",
      "Credit balance is too low",
    ]) {
      expect([text, blockedBy(text)]).toEqual([text, "limit"]);
    }
    expect(blockedBy("API Error: Server is temporarily limiting requests", 429)).toBe("limit");
  });

  test("not the world: the API answered, or the conversation is what failed", () => {
    expect(blockedBy("API Error: 529 Overloaded", 529)).toBeUndefined();
    expect(blockedBy("API Error: network error on the way", 500)).toBeUndefined();
    expect(blockedBy("Prompt is too long: context limit reached")).toBeUndefined();
    expect(blockedBy("error_max_turns")).toBeUndefined();
    expect(blockedBy("Invalid API key")).toBeUndefined();
    expect(blockedBy(undefined)).toBeUndefined();
  });

  test("when a limit lifts, when the words say", () => {
    expect(limitResetsAt("Claude AI usage limit reached|1790000000")).toBe(1_790_000_000_000);
    expect(limitResetsAt("You've hit your limit · resets 7pm")).toBeUndefined();
  });
});

describe("waiting on the connection", () => {
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("everyone waiting hears at once when it answers — and not before", async () => {
    let up = false;
    let probes = 0;
    const watch = new ConnectionWatch(async () => {
      probes += 1;
      return up;
    }, 20);
    const heard: string[] = [];
    watch.whenBack("a", () => heard.push("a"));
    watch.whenBack("b", () => heard.push("b"));
    await settle(1_100);
    expect(heard).toEqual([]);
    up = true;
    await settle(60);
    expect(heard.sort()).toEqual(["a", "b"]);
    // nobody left waiting: nothing more is asked
    const asked = probes;
    await settle(80);
    expect(probes).toBe(asked);
  });

  test("a wait called off is not called", async () => {
    const watch = new ConnectionWatch(async () => true, 20);
    const heard: string[] = [];
    watch.whenBack("a", () => heard.push("a"));
    watch.cancel("a");
    await settle(1_100);
    expect(heard).toEqual([]);
  });
});
