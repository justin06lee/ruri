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
  accountOf,
  addAccount,
  carryCodexSession,
  carrySession,
  channelAccounts,
  chatAccountOf,
  claudeHome,
  claudeHomes,
  claudeProjectDirIn,
  claudeSessionEnv,
  codexHome,
  codexHomes,
  keychainService,
  listAccounts,
  providerSessionEnv,
  removeAccount,
  renameAccount,
  shareDefaults,
} from "./accounts.js";
import { claudeSessionGone, claudeSessionHas } from "./recent.js";

/**
 * A project runs on any of the accounts ruri knows. Work is Claude Code's
 * own config, left as ruri has it; personal is its own CLAUDE_CONFIG_DIR;
 * Codex's default is its own CODEX_HOME; and every account the user adds
 * is a folder of its own. The keychain item each is read from is named the
 * way Claude Code names it, and a session resumed on another account is
 * brought over first.
 */

let root: string;
let work: string;
let personal: string;
let project: string;
const saved: Record<string, string | undefined> = {};
const VARS = [
  "CLAUDE_CONFIG_DIR",
  "RURI_PERSONAL_CLAUDE_DIR",
  "CODEX_HOME",
  "RURI_ACCOUNT_HOMES",
  "RURI_CONFIG_DIR",
];

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruri-accounts-")));
  work = path.join(root, "work");
  personal = path.join(root, "personal");
  project = path.join(root, "repo");
  fs.mkdirSync(project, { recursive: true });
  process.env["CLAUDE_CONFIG_DIR"] = work;
  process.env["RURI_PERSONAL_CLAUDE_DIR"] = personal;
  process.env["CODEX_HOME"] = path.join(root, "codex");
  process.env["RURI_ACCOUNT_HOMES"] = path.join(root, "homes");
  // accounts.json of this test's own
  process.env["RURI_CONFIG_DIR"] = path.join(root, "config");
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

test("the usage gauges keep each harness's default under its own id", () => {
  expect(usageKey("claude", "work")).toBe("claude");
  expect(usageKey("claude")).toBe("claude");
  expect(usageKey("claude", "personal")).toBe("claude-personal");
  expect(usageKey("claude", "side")).toBe("claude:side");
  expect(usageKey("codex", "codex")).toBe("codex");
  expect(usageKey("codex", "side")).toBe("codex:side");
  expect(usageKey("gemini", "side")).toBe("gemini");
});

describe("the accounts ruri knows", () => {
  test("the built-in three are always there, each in its own folder", () => {
    expect(listAccounts().map((a) => [a.id, a.provider, a.dir, a.builtIn])).toEqual([
      ["work", "claude", work, true],
      ["personal", "claude", personal, true],
      ["codex", "codex", path.join(root, "codex"), true],
    ]);
  });

  test("an added account gets an id from its name, a folder of its own, and outlives a restart", () => {
    const side = addAccount("claude", "Side Gig");
    expect(side).toMatchObject({ id: "side-gig", name: "Side Gig", provider: "claude", builtIn: false });
    expect(side.dir).toBe(path.join(root, "homes", ".claude-side-gig"));
    expect(fs.existsSync(side.dir)).toBe(true);
    // the same name again is another account, not the same one
    expect(addAccount("claude", "Side Gig").id).toBe("side-gig-2");
    // a name with no Latin in it still gets a folder
    expect(addAccount("codex", "회사").id).toMatch(/^account-[0-9a-f]{4}$/);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "config", "accounts.json"), "utf8"));
    expect(saved.accounts.map((a: { id: string }) => a.id).slice(0, 2)).toEqual(["side-gig", "side-gig-2"]);
    expect(
      listAccounts()
        .map((a) => a.id)
        .slice(0, 4),
    ).toEqual(["work", "personal", "side-gig", "side-gig-2"]);
  });

  test("renamed — the built-ins too — and removed, the built-ins never", () => {
    const side = addAccount("codex", "Side");
    expect(renameAccount("work", "Company")).toBe(true);
    expect(renameAccount(side.id, "Spare")).toBe(true);
    expect(renameAccount("nobody", "x")).toBe(false);
    expect(listAccounts().find((a) => a.id === "work")?.name).toBe("Company");
    expect(listAccounts().find((a) => a.id === side.id)?.name).toBe("Spare");
    expect(removeAccount("work")).toBeUndefined();
    expect(removeAccount(side.id)?.id).toBe(side.id);
    expect(listAccounts().map((a) => a.id)).toEqual(["work", "personal", "codex"]);
    // its folder, sign-in and all, stays where it was
    expect(fs.existsSync(side.dir)).toBe(true);
  });

  test("a project's pick holds while it is an account for that harness; otherwise the default", () => {
    const side = addAccount("codex", "Side");
    expect(accountOf({ accounts: { codex: side.id } }, "codex")).toBe(side.id);
    expect(accountOf({ accounts: { codex: side.id } }, "claude")).toBe("work");
    // a Claude account named for Codex, or one since removed
    expect(accountOf({ accounts: { codex: "personal" } }, "codex")).toBe("codex");
    removeAccount(side.id);
    expect(accountOf({ accounts: { codex: side.id } }, "codex")).toBe("codex");
    // the pick from before there were providers is Claude's
    expect(accountOf({ account: "personal" }, "claude")).toBe("personal");
    expect(accountOf({ account: "personal", accounts: { claude: "work" } }, "claude")).toBe("work");
  });

  test("a chat's own pick goes over its project's; one since removed is the project's again", () => {
    const side = addAccount("claude", "Side");
    const project = { accounts: { claude: "personal" } };
    expect(chatAccountOf(project, { accounts: { claude: side.id } }, "claude")).toBe(side.id);
    expect(chatAccountOf(project, {}, "claude")).toBe("personal");
    expect(chatAccountOf(project, { accounts: { claude: "codex" } }, "claude")).toBe("personal");
    expect(channelAccounts(project, { accounts: { claude: side.id } })).toEqual({
      claude: side.id,
      codex: "codex",
    });
    removeAccount(side.id);
    expect(chatAccountOf(project, { accounts: { claude: side.id } }, "claude")).toBe("personal");
    // by a chat's id, the chat's own; by the project's, the project's
    const projects: Project[] = [
      {
        id: "p",
        name: "p",
        path: "/p",
        accounts: { claude: "personal" },
        sessions: [{ id: "lead" }, { id: "other", accounts: { claude: "work" } }],
      },
    ];
    const store = {
      get: (id: string) => projects.find((p) => p.id === id),
      findSession: (id: string) => {
        const found = projects.find((p) => p.sessions.some((s) => s.id === id));
        return found && { project: found, session: found.sessions.find((s) => s.id === id)! };
      },
    };
    expect(accountFor(store, "p")).toBe("personal");
    expect(accountFor(store, "lead")).toBe("personal");
    expect(accountFor(store, "other")).toBe("work");
  });

  test("Home runs on its own pick", () => {
    const store = {
      get: () => undefined,
      findSession: () => undefined,
      homeSettings: () => ({ accounts: { claude: "personal" } }),
    };
    expect(accountFor(store, "home")).toBe("personal");
    expect(accountFor(store, "home", "codex")).toBe("codex");
  });

  test("a Codex account runs with its CODEX_HOME; the default as ruri has it", () => {
    const side = addAccount("codex", "Side");
    expect(accountEnv("codex")).toEqual({});
    expect(accountEnv(side.id)).toEqual({ CODEX_HOME: side.dir });
    expect(codexHome(side.id)).toBe(side.dir);
    expect(codexHomes()).toEqual([path.join(root, "codex"), side.dir]);
    expect(providerSessionEnv("codex", { accounts: { codex: side.id } }, undefined)).toEqual({
      CODEX_HOME: side.dir,
    });
    expect(providerSessionEnv("gemini", { accounts: { codex: side.id } }, undefined)).toEqual({});
  });

  test("every Claude account's home is looked in for a transcript", () => {
    const side = addAccount("claude", "Side");
    expect(claudeHomes()).toEqual([work, personal, side.dir]);
    expect(claudeHomes(side.id)[0]).toBe(side.dir);
    expect(claudeSessionEnv({ accounts: { claude: side.id }, path: project }, undefined, {})).toEqual({
      CLAUDE_CONFIG_DIR: side.dir,
    });
  });

  test("a Codex thread resumed on another account has its rollout brought there", () => {
    const side = addAccount("codex", "Side");
    const day = path.join(root, "codex", "sessions", "2026", "11", "17");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "rollout-2026-11-17T10-00-00-thread-1.jsonl"), "{}\n");
    providerSessionEnv("codex", { accounts: { codex: side.id } }, "codex:thread-1");
    expect(
      fs.readFileSync(
        path.join(side.dir, "sessions", "2026", "11", "17", "rollout-2026-11-17T10-00-00-thread-1.jsonl"),
        "utf8",
      ),
    ).toBe("{}\n");
    // already there: nothing to do, and nothing breaks
    carryCodexSession("thread-1", side.dir);
    carryCodexSession("missing", side.dir);
  });

  test("an account shares the user's own settings with the default one, and keeps its own", () => {
    fs.mkdirSync(path.join(work, "skills"), { recursive: true });
    fs.writeFileSync(path.join(work, "CLAUDE.md"), "be brief");
    fs.writeFileSync(path.join(work, "settings.json"), "{}");
    const side = addAccount("claude", "Side");
    fs.writeFileSync(path.join(side.dir, "settings.json"), '{"own":true}');
    shareDefaults(side.id);
    expect(fs.readFileSync(path.join(side.dir, "CLAUDE.md"), "utf8")).toBe("be brief");
    expect(fs.lstatSync(path.join(side.dir, "skills")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(side.dir, "settings.json"), "utf8")).toBe('{"own":true}');
    // never the sign-in, and never into the default itself
    expect(fs.existsSync(path.join(side.dir, ".credentials.json"))).toBe(false);
    shareDefaults("work");
    expect(fs.lstatSync(path.join(work, "CLAUDE.md")).isSymbolicLink()).toBe(false);
  });
});
