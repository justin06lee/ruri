import { describe, expect, test } from "bun:test";
import { SESSIONS_MODE_PREF } from "../shared/protocol.js";
import { sessionsMode } from "./sessionsMode.js";
import { sweepTalk } from "./handlers/talk.js";

const withPref = (value?: string) => ({
  prefs: { all: () => (value === undefined ? {} : { [SESSIONS_MODE_PREF]: value }) },
});

describe("sessionsMode", () => {
  test("Sessions is the default; only 'team' turns the team on", () => {
    expect(sessionsMode(withPref())).toBe(true);
    expect(sessionsMode(withPref("sessions"))).toBe(true);
    expect(sessionsMode(withPref("team"))).toBe(false);
  });

  test("Sessions mode: the talk sweep touches nothing (no held reports, no failed tasks)", () => {
    const touched: string[] = [];
    const trap = new Proxy({}, { get: (_t, key) => touched.push(String(key)) });
    const ctx = { ...withPref(), talk: trap, store: trap, tasks: trap } as never;
    sweepTalk(ctx);
    expect(touched).toEqual([]);
  });

  test("Team mode: the sweep reads the book again", () => {
    const touched: string[] = [];
    const trap = new Proxy(
      { held: new Map(), pending: new Map() },
      { get: (t, key) => (touched.push(String(key)), (t as never)[key]) },
    );
    const ctx = { ...withPref("team"), talk: trap } as never;
    try {
      sweepTalk(ctx);
    } catch {
      // the stub is thin; reaching the book is the point
    }
    expect(touched.length).toBeGreaterThan(0);
  });
});
