import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMember, leadOf, SESSIONS_MODE_PREF, type Project } from "../shared/protocol.js";
import { ProjectStore } from "./projects.js";
import { projectChatBriefing, sessionsMode } from "./sessionsMode.js";
import { sweepTalk } from "./handlers/talk.js";

const withPref = (value?: string) => ({
  prefs: { all: (): Record<string, string> => (value === undefined ? {} : { [SESSIONS_MODE_PREF]: value }) },
});

let dir: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-btw-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the project chat", () => {
  test("an old /btw side chat is never the lead, never a member", () => {
    const project: Project = {
      id: "p",
      name: "p",
      path: "/tmp",
      sessions: [
        { id: "side", title: "btw", side: true },
        { id: "chat", title: "Lead" },
      ],
    };
    expect(leadOf(project)!.id).toBe("chat");
    expect(isMember(project, "side")).toBe(false);
  });

  test("the brief: the project chat works alone", () => {
    expect(projectChatBriefing("cobalt")).toContain("Do the work yourself");
    expect(projectChatBriefing("cobalt")).toContain("only when the user asks");
  });
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
