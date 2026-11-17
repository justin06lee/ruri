import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_ACCOUNTS, usageKey, type AccountInfo } from "../shared/protocol.js";
import { accountEnv, findAccount, listAccounts, shareDefaults, type Account } from "./accounts.js";
import { isMissing, warn } from "./log.js";
import { findCommand } from "./projectHooks.js";

/**
 * Who each account is signed in as, and signing in and out of one.
 *
 * Claude Code says for itself: `claude auth status --json`, run with the
 * account's CLAUDE_CONFIG_DIR, answers whether it is signed in, as whom
 * and on what plan. Codex keeps its sign-in in auth.json under its home,
 * the ChatGPT one with an id token that names the email and plan.
 *
 * Signing in is the harness's own login, typed into a shell under the
 * account's row on the Accounts page (Terminals.run) — the user sees the
 * link it prints, and answers whatever it asks — on whichever machine this
 * ruri runs, so the same button signs in tenet from a Mac's window.
 * Nothing here ever sees a password or a token's value: only what the
 * harness says of it.
 *
 * Statuses are asked at launch, when the Accounts page opens, and around a
 * sign-in or out — one account at a time, never per prompt.
 */

/** The channel a sign-in shell runs under: the page asks for its tabs by it. */
export const SIGN_IN_CHANNEL = "account:";

export function signInChannel(id: string): string {
  return `${SIGN_IN_CHANNEL}${id}`;
}

interface Status {
  signedIn: boolean;
  who?: string;
  plan?: string;
  org?: string;
}

const statuses = new Map<string, Status>();

/** Forget every status (tests). */
export function resetAccountStatuses(): void {
  statuses.clear();
}

/** Every account as the page and the chip show it. */
export function accountInfos(): AccountInfo[] {
  return listAccounts().map((a) => {
    const status = statuses.get(a.id);
    return {
      id: a.id,
      name: a.name,
      provider: a.provider,
      dir: a.dir,
      ...(a.builtIn ? { builtIn: true } : {}),
      ...(status
        ? {
            signedIn: status.signedIn,
            ...(status.who ? { who: status.who } : {}),
            ...(status.plan ? { plan: status.plan } : {}),
            ...(status.org ? { org: status.org } : {}),
          }
        : {}),
      usage: usageKey(a.provider, a.id),
    };
  });
}

function claudeCli(): string | null {
  return findCommand("claude", "RURI_CLAUDE_CLI");
}

function codexCli(): string | null {
  return findCommand("codex", "RURI_CODEX_CLI");
}

/** A command's output, whatever it exited with; null when it could not
 *  be run at all. */
function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          warn("accounts", err, `${path.basename(command)} ${args.join(" ")}`);
          resolve(null);
          return;
        }
        resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout: String(stdout) });
      },
    );
  });
}

/** A personal org is named after its owner; only a real one is worth saying. */
function orgName(name: unknown): string | undefined {
  return typeof name === "string" && name && !/'s Organization$/.test(name) ? name : undefined;
}

async function claudeStatus(account: Account): Promise<Status | undefined> {
  // an account whose folder isn't there has never been signed in to — and
  // asking would make the folder
  if (account.id !== DEFAULT_ACCOUNTS.claude && !fs.existsSync(account.dir)) return { signedIn: false };
  const cli = claudeCli();
  if (!cli) return undefined;
  // signed out, it says so in the same JSON and exits 1
  const result = await run(cli, ["auth", "status", "--json"], accountEnv(account.id));
  if (!result) return undefined;
  try {
    const data = JSON.parse(result.stdout) as {
      loggedIn?: boolean;
      email?: string;
      orgName?: string;
      subscriptionType?: string;
    };
    if (!data.loggedIn) return { signedIn: false };
    const org = orgName(data.orgName);
    return {
      signedIn: true,
      ...(data.email ? { who: data.email } : {}),
      ...(data.subscriptionType ? { plan: data.subscriptionType } : {}),
      ...(org ? { org } : {}),
    };
  } catch (err) {
    warn("accounts", err, "claude auth status");
    return undefined;
  }
}

/** The claims in a JWT, unverified — only ever read for display. */
function claims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** What Codex's auth.json says of a home's sign-in. */
export function readCodexAuth(home: string): Status | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, "auth.json"), "utf8");
  } catch (err) {
    if (!isMissing(err)) warn("accounts", err, "codex auth.json");
    return undefined;
  }
  try {
    const data = JSON.parse(raw) as {
      OPENAI_API_KEY?: string | null;
      tokens?: { id_token?: string; access_token?: string } | null;
    };
    if (data.tokens?.id_token || data.tokens?.access_token) {
      const said = claims(data.tokens.id_token) ?? {};
      const auth = said["https://api.openai.com/auth"] as { chatgpt_plan_type?: unknown } | undefined;
      const plan = auth?.chatgpt_plan_type;
      return {
        signedIn: true,
        ...(typeof said["email"] === "string" ? { who: said["email"] } : {}),
        ...(typeof plan === "string" && plan ? { plan } : {}),
      };
    }
    if (data.OPENAI_API_KEY) return { signedIn: true, who: "API key" };
    return { signedIn: false };
  } catch (err) {
    warn("accounts", err, "codex auth.json");
    return undefined;
  }
}

async function codexStatus(account: Account): Promise<Status | undefined> {
  const said = readCodexAuth(account.dir);
  if (said) return said;
  // no auth.json: signed out — or signed in with the sign-in kept in the
  // system keyring, which only Codex itself can say
  if (!fs.existsSync(account.dir)) return { signedIn: false };
  const cli = codexCli();
  if (!cli) return undefined;
  const result = await run(cli, ["login", "status"], accountEnv(account.id));
  return result ? { signedIn: result.code === 0 } : undefined;
}

function same(a: Status | undefined, b: Status | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Look again at one account; whether what it says changed. */
export async function refreshAccount(id: string): Promise<boolean> {
  const account = findAccount(id);
  if (!account) return statuses.delete(id);
  const status = account.provider === "claude" ? await claudeStatus(account) : await codexStatus(account);
  const before = statuses.get(id);
  if (status) statuses.set(id, status);
  else statuses.delete(id);
  return !same(before, status);
}

let asking: Promise<boolean> | undefined;
let askedAt = 0;

/** Look again at every account, one at a time — at most once in a while,
 *  unless `force`d; whether anything changed. */
export function refreshAccounts(force = false): Promise<boolean> {
  if (asking) return asking;
  if (!force && Date.now() - askedAt < 15_000) return Promise.resolve(false);
  askedAt = Date.now();
  asking = (async () => {
    let changed = false;
    for (const account of listAccounts()) {
      if (await refreshAccount(account.id)) changed = true;
    }
    for (const id of [...statuses.keys()]) if (!findAccount(id)) changed = statuses.delete(id) || changed;
    return changed;
  })().finally(() => {
    asking = undefined;
  });
  return asking;
}

/** A path as a shell word. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Whether a browser can open here to finish a sign-in: a Mac, or a
 *  Linux desktop. A machine with no screen — tenet, reached over the
 *  tailnet — signs in with a code instead. */
function hasScreen(): boolean {
  return process.platform !== "linux" || !!(process.env["DISPLAY"] || process.env["WAYLAND_DISPLAY"]);
}

/**
 * The command a sign-in shell types: the harness's own login, on the
 * account's folder, and `exit` when it succeeds — so the shell goes once
 * it is done. A string to show when it can't be done here instead.
 */
export function signInCommand(id: string): { command: string } | { error: string } {
  const account = findAccount(id);
  if (!account) return { error: "No such account." };
  const env = Object.entries(accountEnv(account.id))
    .map(([name, value]) => `${name}=${quoted(value)} `)
    .join("");
  if (account.provider === "claude") {
    const cli = claudeCli();
    if (!cli) return { error: "Claude Code isn't installed on this machine." };
    return { command: `${env}${quoted(cli)} auth login && exit` };
  }
  const cli = codexCli();
  if (!cli) return { error: "Codex isn't installed on this machine." };
  return { command: `${env}${quoted(cli)} login${hasScreen() ? "" : " --device-auth"} && exit` };
}

/** Ready an account's folder for a sign-in: there, and sharing the
 *  user's own settings with the default account's (shareDefaults). */
export function prepareSignIn(id: string): void {
  shareDefaults(id);
}

/** Sign out: the harness's own logout, on the account's folder. */
export async function signOut(id: string): Promise<string | undefined> {
  const account = findAccount(id);
  if (!account) return "No such account.";
  const cli = account.provider === "claude" ? claudeCli() : codexCli();
  if (!cli) {
    return account.provider === "claude"
      ? "Claude Code isn't installed on this machine."
      : "Codex isn't installed on this machine.";
  }
  const result = await run(
    cli,
    account.provider === "claude" ? ["auth", "logout"] : ["logout"],
    accountEnv(id),
  );
  await refreshAccount(id);
  return result ? undefined : "The sign-out didn't run.";
}

/**
 * Watch an account while its sign-in shell is open, so the page turns to
 * "signed in" when it is — whether or not the shell is ever closed. Every
 * few seconds for a while, and no longer once it says so.
 */
const watching = new Map<string, NodeJS.Timeout>();

export function watchSignIn(id: string, changed: () => void, everyMs = 4_000, forMs = 10 * 60_000): void {
  stopWatching(id);
  const until = Date.now() + forMs;
  const tick = async () => {
    watching.delete(id);
    if (await refreshAccount(id)) changed();
    if (statuses.get(id)?.signedIn || Date.now() > until) return;
    watching.set(
      id,
      setTimeout(() => void tick(), everyMs),
    );
  };
  watching.set(
    id,
    setTimeout(() => void tick(), everyMs),
  );
}

export function stopWatching(id?: string): void {
  for (const [key, timer] of watching) {
    if (id !== undefined && key !== id) continue;
    clearTimeout(timer);
    watching.delete(key);
  }
}
