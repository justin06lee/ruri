import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  accountPick,
  DEFAULT_ACCOUNTS,
  DEFAULT_CLAUDE_ACCOUNT,
  HOME_ID,
  isAccountProvider,
  type AccountProvider,
  type HomeSettings,
  type Project,
  type SessionInfo,
} from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/**
 * The accounts a harness can run on, and what a session on each runs with.
 *
 * Claude Code keeps everything of an account — its sign-in, its settings,
 * its transcripts — under one config dir: ~/.claude by default, or wherever
 * CLAUDE_CONFIG_DIR points. Codex does the same under CODEX_HOME (~/.codex).
 * So an account is a folder: "work" is Claude's default (whatever
 * CLAUDE_CONFIG_DIR ruri itself was started with, normally none — left
 * alone rather than unset), "personal" is ~/.claude-personal (or
 * RURI_PERSONAL_CLAUDE_DIR), "codex" is Codex's default, and every account
 * the user adds gets a folder of its own beside them (~/.claude-<id>,
 * ~/.codex-<id>), listed with the name they gave it in accounts.json.
 *
 * A project picks one per harness (Project.accounts); every process ruri
 * starts for it gets the matching folder, read at each spawn — so a change
 * reaches the next process and leaves a running one alone.
 */

export interface Account {
  id: string;
  name: string;
  provider: AccountProvider;
  /** The folder its sign-in lives in. */
  dir: string;
  /** What its harness is started with (CLAUDE_CONFIG_DIR, CODEX_HOME);
   *  unset for the defaults, which leave ruri's own as it is. */
  configDir?: string;
  builtIn: boolean;
}

/** An account as accounts.json keeps it: a built-in's only its name. */
interface Stored {
  id: string;
  name: string;
  provider: AccountProvider;
  dir?: string;
}

const BUILT_IN: ReadonlyArray<Omit<Stored, "dir">> = [
  { id: "work", name: "Work", provider: "claude" },
  { id: "personal", name: "Personal", provider: "claude" },
  { id: "codex", name: "Codex", provider: "codex" },
];

function accountsFile(): string {
  return configPath("accounts.json");
}

/** The file as last read or written — kept per config folder, so a test
 *  that points ruri at a folder of its own reads that folder's. */
let cache: { file: string; stored: Stored[] } | undefined;

function stored(): Stored[] {
  const file = accountsFile();
  if (cache?.file === file) return cache.stored;
  const list: Stored[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { accounts?: unknown };
    for (const entry of Array.isArray(raw.accounts) ? (raw.accounts as Array<Partial<Stored>>) : []) {
      if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      if (!isAccountProvider(entry.provider) || list.some((x) => x.id === entry.id)) continue;
      list.push({
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        ...(typeof entry.dir === "string" && entry.dir ? { dir: entry.dir } : {}),
      });
    }
  } catch (err) {
    if (!isMissing(err)) warn("accounts", err, "read accounts.json");
    // none added yet: the built-in three are all there is
  }
  cache = { file, stored: list };
  return list;
}

function save(list: Stored[]): void {
  cache = { file: accountsFile(), stored: list };
  writeJsonAtomic(accountsFile(), { accounts: list }, 2);
}

/** Forget what was read, so the next call reads the file again (tests). */
export function reloadAccounts(): void {
  cache = undefined;
}

/** The personal account's config dir. Read on every call, like
 *  configDir(), so a test can point it somewhere of its own. */
export function personalConfigDir(): string {
  return process.env["RURI_PERSONAL_CLAUDE_DIR"] || path.join(os.homedir(), ".claude-personal");
}

/** Where the folders of added accounts go: the home folder, or
 *  RURI_ACCOUNT_HOMES (tests). */
function accountHomesDir(): string {
  return process.env["RURI_ACCOUNT_HOMES"] || os.homedir();
}

function builtInConfigDir(id: string): string | undefined {
  return id === "personal" ? personalConfigDir() : undefined;
}

function resolve(entry: Stored, builtIn: boolean): Account {
  const configDir = builtIn ? builtInConfigDir(entry.id) : entry.dir;
  const dir =
    entry.provider === "claude"
      ? claudeHomeFor(configDir ?? process.env["CLAUDE_CONFIG_DIR"])
      : (configDir ?? defaultCodexHome());
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    dir,
    ...(configDir ? { configDir } : {}),
    builtIn,
  };
}

/** Every account, Claude's first then Codex's, built-ins ahead of the
 *  user's own in the order they were added. */
export function listAccounts(): Account[] {
  const own = stored();
  const all: Account[] = [];
  for (const provider of ["claude", "codex"] as const) {
    for (const base of BUILT_IN.filter((b) => b.provider === provider)) {
      const renamed = own.find((x) => x.id === base.id)?.name;
      all.push(resolve({ ...base, ...(renamed ? { name: renamed } : {}) }, true));
    }
    for (const entry of own) {
      if (entry.provider !== provider || BUILT_IN.some((b) => b.id === entry.id) || !entry.dir) continue;
      all.push(resolve(entry, false));
    }
  }
  return all;
}

export function findAccount(id: string | undefined): Account | undefined {
  return id ? listAccounts().find((a) => a.id === id) : undefined;
}

/**
 * The account a project (or Home's settings) runs a harness on: its pick,
 * while that is still an account for that harness — one since removed, or
 * a pick for the other harness, is the default.
 */
export function accountOf(
  project: Pick<Project, "account" | "accounts"> | HomeSettings | null | undefined,
  provider: AccountProvider = "claude",
): string {
  const pick = accountPick(project, provider);
  return findAccount(pick)?.provider === provider ? pick : DEFAULT_ACCOUNTS[provider];
}

/** The account a chat runs a harness on: its own pick while that is an
 *  account for the harness, else its project's (accountOf). */
export function chatAccountOf(
  project: Pick<Project, "account" | "accounts"> | null | undefined,
  session: Pick<SessionInfo, "accounts"> | null | undefined,
  provider: AccountProvider = "claude",
): string {
  const own = session?.accounts?.[provider];
  return own && findAccount(own)?.provider === provider ? own : accountOf(project, provider);
}

/** Every harness's account for a chat, worked out — what a chat's process
 *  is started with (channelProject carries it as its accounts). */
export function channelAccounts(
  project: Pick<Project, "account" | "accounts"> | null | undefined,
  session?: Pick<SessionInfo, "accounts"> | null,
): Record<AccountProvider, string> {
  return {
    claude: chatAccountOf(project, session, "claude"),
    codex: chatAccountOf(project, session, "codex"),
  };
}

/** The account a chat runs on, by its id — or a project, by its own. Home
 *  runs on its own pick; anything not found on the default. */
export function accountFor(
  store: {
    get(id: string): Project | undefined;
    findSession(id: string): { project: Project; session?: SessionInfo } | undefined;
    homeSettings?(): HomeSettings;
  },
  id: string,
  provider: AccountProvider = "claude",
): string {
  if (id === HOME_ID) return accountOf(store.homeSettings?.(), provider);
  const project = store.get(id);
  if (project) return accountOf(project, provider);
  const found = store.findSession(id);
  return chatAccountOf(found?.project, found?.session, provider);
}

/** The folder name an added account gets: its name, plain. */
function slug(name: string): string {
  const plain = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  // a name with no Latin in it (한국어, say) still gets a folder
  return plain || `account-${randomBytes(2).toString("hex")}`;
}

/**
 * A new account for a harness, under the name the user gave it: an id from
 * that name, unlike any other, and a folder of its own beside the harness's
 * default — ~/.claude-<id>, ~/.codex-<id>. A folder already there (one the
 * user signed in to by hand) is taken as it is.
 */
export function addAccount(provider: AccountProvider, name: string): Account {
  const taken = new Set(listAccounts().map((a) => a.id));
  const base = slug(name);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const dir = path.join(accountHomesDir(), `.${provider}-${id}`);
  // Codex refuses a CODEX_HOME that isn't there; Claude makes its own,
  // but one made now is one the page can show as this account's
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  save([...stored(), { id, name: name.trim(), provider, dir }]);
  return findAccount(id)!;
}

export function renameAccount(id: string, name: string): boolean {
  const account = findAccount(id);
  const trimmed = name.trim();
  if (!account || !trimmed) return false;
  const own = stored();
  save(
    own.some((x) => x.id === id)
      ? own.map((x) => (x.id === id ? { ...x, name: trimmed } : x))
      : [...own, { id, name: trimmed, provider: account.provider }],
  );
  return true;
}

/** Forget one of the user's own accounts. Its folder — sign-in and
 *  transcripts — stays on disk; the built-in three are never removed. */
export function removeAccount(id: string): Account | undefined {
  const account = findAccount(id);
  if (!account || account.builtIn) return undefined;
  save(stored().filter((x) => x.id !== id));
  return account;
}

/** The CLAUDE_CONFIG_DIR a session on this account is started with;
 *  undefined is "as ruri has it". */
export function claudeConfigDir(account: string): string | undefined {
  const found = findAccount(account);
  return found?.provider === "claude" ? found.configDir : undefined;
}

/** What a process on this account adds to its environment: CLAUDE_CONFIG_DIR
 *  or CODEX_HOME, or nothing for a harness's default. */
export function accountEnv(account: string): Record<string, string> {
  const found = findAccount(account);
  if (!found?.configDir) return {};
  return found.provider === "claude"
    ? { CLAUDE_CONFIG_DIR: found.configDir }
    : { CODEX_HOME: found.configDir };
}

/** The folder a CLAUDE_CONFIG_DIR value means, exactly as the CLI works it
 *  out — trimmed, ~/.claude when empty, NFC — since that string is also
 *  what its keychain entry is named by. */
export function claudeHomeFor(configDir: string | undefined): string {
  return (configDir?.trim() || path.join(os.homedir(), ".claude")).normalize("NFC");
}

/** Where a Claude account's sign-in and transcripts live. */
export function claudeHome(account: string): string {
  return claudeHomeFor(claudeConfigDir(account) ?? process.env["CLAUDE_CONFIG_DIR"]);
}

/** Every Claude account's home, the given one first — each once, however
 *  many accounts share a folder. */
export function claudeHomes(first: string = DEFAULT_CLAUDE_ACCOUNT): string[] {
  const others = listAccounts()
    .filter((a) => a.provider === "claude")
    .map((a) => claudeHome(a.id));
  return [...new Set([claudeHome(first), ...others])];
}

/** Codex's own default home: CODEX_HOME as ruri has it, else ~/.codex. */
function defaultCodexHome(): string {
  return process.env["CODEX_HOME"] || path.join(os.homedir(), ".codex");
}

/** Where a Codex account keeps its sign-in and rollouts. */
export function codexHome(account: string = DEFAULT_ACCOUNTS.codex): string {
  const found = findAccount(account);
  return (found?.provider === "codex" ? found.configDir : undefined) ?? defaultCodexHome();
}

/** Every Codex account's home, the given one first, each once. */
export function codexHomes(first: string = DEFAULT_ACCOUNTS.codex): string[] {
  const others = listAccounts()
    .filter((a) => a.provider === "codex")
    .map((a) => codexHome(a.id));
  return [...new Set([codexHome(first), ...others])];
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

/** The keychain item for one Claude account. */
export function accountKeychainService(account: string): string {
  return keychainService(claudeConfigDir(account) ?? process.env["CLAUDE_CONFIG_DIR"]);
}

/**
 * What an account shares with its harness's default one: the user's own
 * instructions, settings, skills and commands. A sign-in is the account's
 * own; how the user likes to work is not, and an account that started
 * without them would quietly be a different agent. Each is linked, not
 * copied, so a change to one is a change to all — and anything the folder
 * already has of its own is left alone.
 */
const SHARED: Record<AccountProvider, readonly string[]> = {
  claude: ["CLAUDE.md", "settings.json", "skills", "agents", "commands", "keybindings.json"],
  codex: ["config.toml", "AGENTS.md", "prompts", "skills"],
};

export function shareDefaults(account: string): void {
  const found = findAccount(account);
  if (!found?.configDir) return;
  const from =
    found.provider === "claude" ? claudeHome(DEFAULT_ACCOUNTS.claude) : codexHome(DEFAULT_ACCOUNTS.codex);
  if (path.resolve(from) === path.resolve(found.dir)) return;
  try {
    fs.mkdirSync(found.dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    warn("accounts", err, "shareDefaults");
    return;
  }
  for (const name of SHARED[found.provider]) {
    const source = path.join(from, name);
    const target = path.join(found.dir, name);
    try {
      if (!fs.existsSync(source) || fs.lstatSync(target, { throwIfNoEntry: false })) continue;
      fs.symlinkSync(source, target);
    } catch (err) {
      warn("accounts", err, `shareDefaults ${name}`);
    }
  }
}

/**
 * The environment a Claude session for this project starts with: `env`
 * (the vault, the chat's tags) with the project's account over it, so
 * nothing the caller passes can put it on another one. A session being
 * resumed has its transcript brought to that account's config dir first,
 * so the resume finds it whichever account it last ran on (carrySession).
 */
export function claudeSessionEnv(
  project: Pick<Project, "account" | "accounts" | "path">,
  resume: string | undefined,
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const account = accountOf(project, "claude");
  if (resume) carrySession(project.path, resume, claudeConfigDir(account));
  return { ...env, ...accountEnv(account) };
}

/**
 * The same for a Codex session: its account's CODEX_HOME, and a thread
 * being resumed brought there first (carryCodexSession). Codex keeps one
 * home per process, so this is all there is to it.
 */
export function codexSessionEnv(
  project: Pick<Project, "account" | "accounts"> | HomeSettings | null | undefined,
  resume: string | undefined,
): Record<string, string> {
  const account = accountOf(project, "codex");
  if (resume) carryCodexSession(resume, codexHome(account));
  return accountEnv(account);
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

/** Every copy of a session's transcript across every Claude home, newest first. */
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

/** What a session on another harness adds for the project's account:
 *  Codex its CODEX_HOME; the rest have no accounts of ruri's to pick. */
export function providerSessionEnv(
  providerId: string,
  project: Pick<Project, "account" | "accounts"> | HomeSettings | null | undefined,
  resume: string | undefined,
): Record<string, string> {
  return providerId === "codex" ? codexSessionEnv(project, resume?.replace(/^codex:/, "")) : {};
}

/** A Codex thread's rollout under one home, wherever its day put it. */
export function codexRolloutIn(home: string, sessionId: string): string | undefined {
  const stack = [path.join(home, "sessions")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (!isMissing(err)) warn("accounts", err, "codexRolloutIn");
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) return full;
    }
  }
  return undefined;
}

/**
 * Bring a Codex thread's rollout to the home it is about to be resumed
 * from — Codex, like Claude Code, finds a thread only under its own home.
 * The newest copy is copied to the same place under the target; nothing
 * happens when the target already has the newest.
 */
export function carryCodexSession(sessionId: string, toHome: string): void {
  let newest: { home: string; file: string; at: number } | undefined;
  for (const home of codexHomes()) {
    const file = codexRolloutIn(home, sessionId);
    if (!file) continue;
    try {
      const at = fs.statSync(file).mtimeMs;
      if (!newest || at > newest.at) newest = { home, file, at };
    } catch (err) {
      if (!isMissing(err)) warn("accounts", err, "carryCodexSession");
    }
  }
  if (!newest || path.resolve(newest.home) === path.resolve(toHome)) return;
  try {
    const dest = path.join(toHome, path.relative(newest.home, newest.file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(newest.file, dest);
  } catch (err) {
    warn("accounts", err, "carryCodexSession");
  }
}
