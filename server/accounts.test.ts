import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Project } from "../shared/protocol.js";
import { usageKey } from "../shared/protocol.js";
import {
  accountEnv,
  accountFor,
  accountKeychainService,
  carrySession,
  claudeHome,
  claudeProjectDirIn,
  claudeSessionEnv,
  keychainService,
} from "./accounts.js";
import { claudeSessionGone, claudeSessionHas } from "./recent.js";

/**
 * A project runs on one of two Claude sign-ins. Work is Claude Code's own
 * config, left as ruri has it; personal is its own CLAUDE_CONFIG_DIR. The
 * keychain item each is read from is named the way Claude Code names it,
 * and a session resumed on the other account is brought over first.
 */

let root: string;
let work: string;
let personal: string;
let project: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["CLAUDE_CONFIG_DIR", "RURI_PERSONAL_CLAUDE_DIR"];

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruri-accounts-")));
  work = path.join(root, "work");
  personal = path.join(root, "personal");
  project = path.join(root, "repo");
  fs.mkdirSync(project, { recursive: true });
  process.env["CLAUDE_CONFIG_DIR"] = work;
  process.env["RURI_PERSONAL_CLAUDE_DIR"] = personal;
});
afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A transcript under one home, as the CLI files it. */
function transcript(home: string, id: string, lines: string[], mtime?: number): string {
  const file = path.join(claudeProjectDirIn(home, project), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

describe("what a session on each account runs with", () => {
  test("work leaves CLAUDE_CONFIG_DIR as ruri has it; personal sets it", () => {
    expect(accountEnv("work")).toEqual({});
    expect(accountEnv("personal")).toEqual({ CLAUDE_CONFIG_DIR: personal });
  });

  test("personal defaults to ~/.claude-personal", () => {
    delete process.env["RURI_PERSONAL_CLAUDE_DIR"];
    expect(accountEnv("personal")).toEqual({
      CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude-personal"),
    });
  });

  test("the account goes over whatever the caller passed, and the rest stays", () => {
    const env = claudeSessionEnv({ account: "personal", path: project }, undefined, {
      RURI_CHANNEL: "chat",
      CLAUDE_CONFIG_DIR: "/somewhere/else",
    });
    expect(env).toEqual({ RURI_CHANNEL: "chat", CLAUDE_CONFIG_DIR: personal });
    expect(claudeSessionEnv({ path: project }, undefined, { RURI_CHANNEL: "chat" })).toEqual({
      RURI_CHANNEL: "chat",
    });
  });

  test("a project's account is found by its id or any of its chats'", () => {
    const projects: Project[] = [
      { id: "p", name: "p", path: project, account: "personal", sessions: [{ id: "lead" }] },
      { id: "q", name: "q", path: project, sessions: [{ id: "other" }] },
    ];
    const store = {
      get: (id: string) => projects.find((p) => p.id === id),
      findSession: (id: string) => {
        const found = projects.find((p) => p.sessions.some((s) => s.id === id));
        return found && { project: found };
      },
    };
    expect(accountFor(store, "p")).toBe("personal");
    expect(accountFor(store, "lead")).toBe("personal");
    expect(accountFor(store, "other")).toBe("work");
    expect(accountFor(store, "home")).toBe("work");
  });
});

describe("the keychain item, as Claude Code names it", () => {
  test("no CLAUDE_CONFIG_DIR: the plain name", () => {
    expect(keychainService(undefined)).toBe("Claude Code-credentials");
    expect(keychainService("")).toBe("Claude Code-credentials");
  });

  test("a config dir: the first eight hex digits of its SHA-256 on the end", () => {
    // sha256("/Users/me/.claude-personal") = ec5d0230…
    expect(keychainService("/Users/me/.claude-personal")).toBe("Claude Code-credentials-ec5d0230");
    // the CLI trims the variable before hashing it
    expect(keychainService(" /Users/me/.claude-personal ")).toBe("Claude Code-credentials-ec5d0230");
  });

  test("each account reads its own", () => {
    delete process.env["CLAUDE_CONFIG_DIR"];
    process.env["RURI_PERSONAL_CLAUDE_DIR"] = "/Users/me/.claude-personal";
    expect(accountKeychainService("work")).toBe("Claude Code-credentials");
    expect(accountKeychainService("personal")).toBe("Claude Code-credentials-ec5d0230");
    expect(claudeHome("work")).toBe(path.join(os.homedir(), ".claude"));
  });
});

describe("a session resumed on the other account", () => {
  test("its transcript, subagents and checkpoints are brought over", () => {
    transcript(work, "s1", ['{"uuid":"a"}']);
    const subagents = path.join(claudeProjectDirIn(work, project), "s1", "subagents");
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, "agent-1.jsonl"), "{}\n");
    fs.mkdirSync(path.join(work, "file-history", "s1"), { recursive: true });
    fs.writeFileSync(path.join(work, "file-history", "s1", "abc@v1"), "before");

    claudeSessionEnv({ account: "personal", path: project }, "s1", {});

    const moved = path.join(claudeProjectDirIn(personal, project), "s1.jsonl");
    expect(fs.readFileSync(moved, "utf8")).toBe('{"uuid":"a"}\n');
    expect(
      fs.existsSync(path.join(claudeProjectDirIn(personal, project), "s1", "subagents", "agent-1.jsonl")),
    ).toBe(true);
    expect(fs.readFileSync(path.join(personal, "file-history", "s1", "abc@v1"), "utf8")).toBe("before");
  });

  test("and back again: the newer copy wins over the one left behind", () => {
    const old = Date.now() - 60_000;
    transcript(work, "s1", ['{"uuid":"a"}'], old);
    transcript(personal, "s1", ['{"uuid":"a"}', '{"uuid":"b"}']);
    carrySession(project, "s1", undefined);
    expect(fs.readFileSync(path.join(claudeProjectDirIn(work, project), "s1.jsonl"), "utf8")).toContain(
      '"b"',
    );
  });

  test("nothing is copied when the account already holds the newest", () => {
    transcript(personal, "s1", ['{"uuid":"a"}'], Date.now() - 60_000);
    transcript(work, "s1", ['{"uuid":"a"}', '{"uuid":"b"}']);
    carrySession(project, "s1", undefined);
    carrySession(project, "s2", personal);
    expect(
      fs.readFileSync(path.join(claudeProjectDirIn(personal, project), "s1.jsonl"), "utf8"),
    ).not.toContain('"b"');
    expect(fs.existsSync(path.join(claudeProjectDirIn(personal, project), "s2.jsonl"))).toBe(false);
  });

  test("a session only the other account holds is not gone", () => {
    transcript(personal, "s1", ['{"uuid":"a"}']);
    expect(claudeSessionGone(project, "s1")).toBe(false);
    expect(claudeSessionHas(project, "s1", "a")).toBe(true);
    expect(claudeSessionGone(project, "missing")).toBe(true);
  });
});

test("the usage gauges keep the work account under claude", () => {
  expect(usageKey("claude", "work")).toBe("claude");
  expect(usageKey("claude")).toBe("claude");
  expect(usageKey("claude", "personal")).toBe("claude-personal");
  expect(usageKey("codex", "personal")).toBe("codex");
});
