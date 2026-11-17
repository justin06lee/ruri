import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addAccount } from "./accounts.js";
import {
  accountInfos,
  readCodexAuth,
  refreshAccount,
  refreshAccounts,
  resetAccountStatuses,
  signInCommand,
} from "./accountStatus.js";
import { Terminals } from "./terminal.js";

/**
 * Who each account is signed in as comes from the harness itself — a
 * stand-in `claude` here, answering by the CLAUDE_CONFIG_DIR it is run
 * with, and Codex's auth.json — and a sign-in is the harness's own login
 * typed into a shell of its own.
 */

let root: string;
const saved: Record<string, string | undefined> = {};
const VARS = [
  "CLAUDE_CONFIG_DIR",
  "RURI_PERSONAL_CLAUDE_DIR",
  "CODEX_HOME",
  "RURI_ACCOUNT_HOMES",
  "RURI_CONFIG_DIR",
  "RURI_CLAUDE_CLI",
  "RURI_CODEX_CLI",
];

/** A stand-in Claude Code: signed in wherever a `signed-in` file says so. */
function standInClaude(): string {
  const file = path.join(root, "bin", "claude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ "$1 $2" = "auth status" ]; then
  if [ -f "$dir/signed-in" ]; then
    echo '{"loggedIn":true,"email":'"$(cat "$dir/signed-in")"',"orgName":"x'"'"'s Organization","subscriptionType":"max"}'
    exit 0
  fi
  echo '{"loggedIn":false,"authMethod":"none"}'
  exit 1
fi
exit 2
`,
    { mode: 0o755 },
  );
  return file;
}

function jwt(claims: object): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruri-account-status-")));
  process.env["CLAUDE_CONFIG_DIR"] = path.join(root, "work");
  process.env["RURI_PERSONAL_CLAUDE_DIR"] = path.join(root, "personal");
  process.env["CODEX_HOME"] = path.join(root, "codex");
  process.env["RURI_ACCOUNT_HOMES"] = path.join(root, "homes");
  process.env["RURI_CONFIG_DIR"] = path.join(root, "config");
  process.env["RURI_CLAUDE_CLI"] = standInClaude();
  process.env["RURI_CODEX_CLI"] = "";
  resetAccountStatuses();
});
afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("who each account is signed in as", () => {
  test("Claude says for itself, per config dir; a personal org isn't worth naming", async () => {
    fs.mkdirSync(path.join(root, "work"), { recursive: true });
    fs.writeFileSync(path.join(root, "work", "signed-in"), '"me@work.com"');
    fs.mkdirSync(path.join(root, "personal"), { recursive: true });
    await refreshAccounts(true);
    const work = accountInfos().find((a) => a.id === "work");
    expect(work).toMatchObject({ signedIn: true, who: "me@work.com", plan: "max", usage: "claude" });
    expect(work).not.toHaveProperty("org");
    expect(accountInfos().find((a) => a.id === "personal")).toMatchObject({
      signedIn: false,
      usage: "claude-personal",
    });
  });

  test("an account whose folder isn't there is signed out, and isn't asked — asking makes the folder", async () => {
    await refreshAccount("personal");
    expect(accountInfos().find((a) => a.id === "personal")?.signedIn).toBe(false);
    expect(fs.existsSync(path.join(root, "personal"))).toBe(false);
  });

  test("with no Claude Code on the machine, nothing is said rather than something wrong", async () => {
    process.env["RURI_CLAUDE_CLI"] = "";
    fs.mkdirSync(path.join(root, "work"), { recursive: true });
    await refreshAccount("work");
    expect(accountInfos().find((a) => a.id === "work")).not.toHaveProperty("signedIn");
  });

  test("Codex's auth.json names the email and plan in its id token", () => {
    const home = path.join(root, "codex");
    fs.mkdirSync(home, { recursive: true });
    expect(readCodexAuth(home)).toBeUndefined();
    fs.writeFileSync(
      path.join(home, "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt({ email: "me@x.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }),
          access_token: "a",
        },
      }),
    );
    expect(readCodexAuth(home)).toEqual({ signedIn: true, who: "me@x.com", plan: "plus" });
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-1" }));
    expect(readCodexAuth(home)).toEqual({ signedIn: true, who: "API key" });
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: null }));
    expect(readCodexAuth(home)).toEqual({ signedIn: false });
  });

  test("an added Codex account is read from its own home", async () => {
    const side = addAccount("codex", "Side");
    fs.writeFileSync(path.join(side.dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-1" }));
    await refreshAccounts(true);
    expect(accountInfos().find((a) => a.id === side.id)).toMatchObject({
      signedIn: true,
      usage: `codex:${side.id}`,
    });
    // the default's home has no sign-in, and no Codex to ask
    expect(accountInfos().find((a) => a.id === "codex")?.signedIn).toBe(false);
  });
});

describe("signing in", () => {
  test("the harness's own login on the account's folder, gone when it succeeds", () => {
    const cli = process.env["RURI_CLAUDE_CLI"]!;
    expect(signInCommand("work")).toEqual({ command: `'${cli}' auth login && exit` });
    expect(signInCommand("personal")).toEqual({
      command: `CLAUDE_CONFIG_DIR='${path.join(root, "personal")}' '${cli}' auth login && exit`,
    });
    // a folder with a quote in it is still one word
    process.env["RURI_PERSONAL_CLAUDE_DIR"] = path.join(root, "it's");
    expect(signInCommand("personal")).toEqual({
      command: `CLAUDE_CONFIG_DIR='${path.join(root, "it'\\''s")}' '${cli}' auth login && exit`,
    });
  });

  test("a harness that isn't installed is said so", () => {
    expect(signInCommand("codex")).toEqual({ error: "Codex isn't installed on this machine." });
    expect(signInCommand("nobody")).toEqual({ error: "No such account." });
  });

  test("the shell runs the one command, and isn't remembered past this run", () => {
    process.env["RURI_CONFIG_DIR"] = path.join(root, "config");
    const terminals = new Terminals({ onData() {}, onExit() {}, onTabs() {} });
    terminals.list("chat");
    const tabs = terminals.run("account:personal", "true");
    expect(tabs).toHaveLength(1);
    // asked again, the tab is the one made for the command
    expect(terminals.list("account:personal")).toEqual(tabs);
    const remembered = JSON.parse(fs.readFileSync(path.join(root, "config", "terminals.json"), "utf8"));
    expect(Object.keys(remembered)).toEqual(["chat"]);
  });
});
