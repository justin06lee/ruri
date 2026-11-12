import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CLAUDE_ACCOUNT, type ClaudeAccount, type Project } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";

/**
 * The two Claude sign-ins, and what a session on each runs with.
 *
 * Claude Code keeps everything of an account — its sign-in, its settings,
 * its transcripts — under one config dir: ~/.claude by default, or
 * wherever CLAUDE_CONFIG_DIR points. "work" is the default (whatever
 * CLAUDE_CONFIG_DIR ruri itself was started with, which is normally none —
 * so it is left alone rather than unset), and "personal" is
 * ~/.claude-personal, or RURI_PERSONAL_CLAUDE_DIR. A project picks one
 * (Project.account); every Claude process ruri starts for it gets the
 * matching CLAUDE_CONFIG_DIR, read at each spawn — so a change reaches the
 * next process and leaves a running one alone.
 */

/** A project's account: personal only when it says so. */
export function accountOf(project?: Pick<Project, "account"> | null): ClaudeAccount {
  return project?.account === "personal" ? "personal" : DEFAULT_CLAUDE_ACCOUNT;
}

/** The account a project runs on — found by its id, or by any of its
 *  chats'. Home, and anything not found, runs on work. */
export function accountFor(
  store: {
    get(id: string): Project | undefined;
    findSession(id: string): { project: Project } | undefined;
  },
  id: string,
): ClaudeAccount {
  return accountOf(store.get(id) ?? store.findSession(id)?.project);
}

/** The personal account's config dir. Read on every call, like
 *  configDir(), so a test can point it somewhere of its own. */
export function personalConfigDir(): string {
  return process.env["RURI_PERSONAL_CLAUDE_DIR"] || path.join(os.homedir(), ".claude-personal");
}

/** The CLAUDE_CONFIG_DIR a session on this account is started with;
 *  undefined is "as ruri has it". */
export function claudeConfigDir(account: ClaudeAccount): string | undefined {
  return account === "personal" ? personalConfigDir() : undefined;
}

/** What a Claude process on this account adds to its environment. */
export function accountEnv(account: ClaudeAccount): Record<string, string> {
  const dir = claudeConfigDir(account);
  return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
}

/** The folder a CLAUDE_CONFIG_DIR value means, exactly as the CLI works it
 *  out — trimmed, ~/.claude when empty, NFC — since that string is also
 *  what its keychain entry is named by. */
export function claudeHomeFor(configDir: string | undefined): string {
  return (configDir?.trim() || path.join(os.homedir(), ".claude")).normalize("NFC");
}

/** Where an account's sign-in and transcripts live. */
export function claudeHome(account: ClaudeAccount): string {
  return claudeHomeFor(claudeConfigDir(account) ?? process.env["CLAUDE_CONFIG_DIR"]);
}

/** Both accounts' homes, the given one first — one, when they are the same
 *  folder (ruri started with CLAUDE_CONFIG_DIR at the personal one). */
export function claudeHomes(first: ClaudeAccount = DEFAULT_CLAUDE_ACCOUNT): string[] {
  const other: ClaudeAccount = first === "personal" ? "work" : "personal";
  return [...new Set([claudeHome(first), claudeHome(other)])];
}

/**
 * The macOS keychain item an account's sign-in is kept in. Claude Code
 * names it "Claude Code-credentials" when CLAUDE_CONFIG_DIR is unset, and
 * otherwise adds the first eight hex digits of the SHA-256 of the config
 * dir — so every config dir has a login of its own. (Read off Claude Code
 * 2.1.306; its OAuth file suffix is empty in a production build.)
 */
export function keychainService(configDir: string | undefined): string {
  if (!configDir) return "Claude Code-credentials";
  const hash = createHash("sha256").update(claudeHomeFor(configDir)).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** The keychain item for one of the two accounts. */
export function accountKeychainService(account: ClaudeAccount): string {
  return keychainService(claudeConfigDir(account) ?? process.env["CLAUDE_CONFIG_DIR"]);
}

/**
 * The environment a Claude session for this project starts with: `env`
 * (the vault, the chat's tags) with the project's account over it, so
 * nothing the caller passes can put it on another one. A session being
 * resumed has its transcript brought to that account's config dir first,
 * so the resume finds it whichever account it last ran on (carrySession).
 */
export function claudeSessionEnv(
  project: Pick<Project, "account" | "path">,
  resume: string | undefined,
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const account = accountOf(project);
  if (resume) carrySession(project.path, resume, claudeConfigDir(account));
  return { ...env, ...accountEnv(account) };
}

/* ── transcripts ─────────────────────────────────────────────────── */

/** The folder the CLI keeps a project's transcripts in under a home, by
 *  its guess: the real path, every non-alphanumeric turned to a dash. */
export function claudeProjectDirIn(home: string, projectPath: string): string {
  // the CLI files a project under its real path: one reached through a
  // symlink (~/Workspace → /Volumes/…, /tmp → /private/tmp) is kept under
  // where the link leads, and the path as written finds nothing there
  let real = projectPath;
  try {
    real = fs.realpathSync(projectPath);
  } catch (err) {
    if (!isMissing(err)) warn("accounts", err, "claudeProjectDirIn");
  }
  return path.join(home, "projects", real.replace(/[^A-Za-z0-9]/g, "-"));
}

/** A session's transcript under one home: the guessed folder first, then
 *  a scan, for when the CLI's own encoding differs from the guess. */
export function claudeSessionFileIn(
  home: string,
  projectPath: string,
  sessionId: string,
): string | undefined {
  const guess = path.join(claudeProjectDirIn(home, projectPath), `${sessionId}.jsonl`);
  if (fs.existsSync(guess)) return guess;
  const root = path.join(home, "projects");
  try {
    for (const dir of fs.readdirSync(root)) {
      const file = path.join(root, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch (err) {
    if (!isMissing(err)) warn("accounts", err, "claudeSessionFileIn");
    // no projects dir
  }
  return undefined;
}

/** Every copy of a session's transcript across both homes, newest first. */
export function claudeSessionCopies(
  projectPath: string,
  sessionId: string,
): Array<{ home: string; file: string; at: number }> {
  const copies: Array<{ home: string; file: string; at: number }> = [];
  for (const home of claudeHomes()) {
    const file = claudeSessionFileIn(home, projectPath, sessionId);
    if (!file) continue;
    try {
      copies.push({ home, file, at: fs.statSync(file).mtimeMs });
    } catch (err) {
      if (!isMissing(err)) warn("accounts", err, "claudeSessionCopies");
    }
  }
  return copies.sort((a, b) => b.at - a.at);
}

/**
 * Bring a session's transcript to the home it is about to be resumed from.
 *
 * Claude Code resumes a session by finding its file under its own config
 * dir, and has no notion of another — so a chat whose project moved to the
 * other account would resume nothing, and start over. The newest copy is
 * copied across instead (the transcript, its subagents' beside it, and the
 * file checkpoints a rewind restores), and the CLI resumes it as its own.
 * Nothing happens when the target already holds the newest copy, so a
 * session that never changed account never pays for this. Best-effort: a
 * copy that fails leaves the CLI to say the session is gone, which the
 * chat already survives (handoff.ts).
 */
export function carrySession(projectPath: string, sessionId: string, toConfigDir: string | undefined): void {
  const target = claudeHomeFor(toConfigDir ?? process.env["CLAUDE_CONFIG_DIR"]);
  const newest = claudeSessionCopies(projectPath, sessionId)[0];
  if (!newest || newest.home === target) return;
  try {
    const dest = path.join(
      target,
      "projects",
      path.relative(path.join(newest.home, "projects"), newest.file),
    );
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(newest.file, dest);
    const subagents = newest.file.replace(/\.jsonl$/, "");
    if (fs.existsSync(subagents)) {
      fs.cpSync(subagents, dest.replace(/\.jsonl$/, ""), { recursive: true, force: true });
    }
    const checkpoints = path.join(newest.home, "file-history", sessionId);
    if (fs.existsSync(checkpoints)) {
      fs.cpSync(checkpoints, path.join(target, "file-history", sessionId), { recursive: true, force: true });
    }
  } catch (err) {
    warn("accounts", err, "carrySession");
  }
}
