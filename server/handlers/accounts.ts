/**
 * Accounts: which one each project runs on, and the Accounts page's add,
 * rename, remove, sign in and out (server/accounts.ts, accountStatus.ts).
 */
import {
  DEFAULT_ACCOUNTS,
  HOME_ID,
  type AccountProvider,
  type ServerMessage,
} from "../../shared/protocol.js";
import { accountOf, addAccount, findAccount, removeAccount, renameAccount } from "../accounts.js";
import {
  accountInfos,
  prepareSignIn,
  refreshAccount,
  refreshAccounts,
  signInChannel,
  signInCommand,
  signOut,
  stopWatching,
  watchSignIn,
} from "../accountStatus.js";
import type { ClientConn, ServerContext } from "../context.js";
import type { Handlers } from "./types.js";

export function broadcastAccounts(ctx: ServerContext): void {
  ctx.clients.broadcast({ type: "accounts", accounts: accountInfos() });
}

function tell(ws: ClientConn, message: string): void {
  ws.send(JSON.stringify({ type: "error", message } satisfies ServerMessage));
}

/** A pick per harness, with the default said by saying nothing. */
function withPick(
  picks: Partial<Record<AccountProvider, string>> | undefined,
  provider: AccountProvider,
  id: string,
): Partial<Record<AccountProvider, string>> | undefined {
  const next = { ...picks };
  if (id === DEFAULT_ACCOUNTS[provider]) delete next[provider];
  else next[provider] = id;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Put a project (or Home) on an account for that account's harness. */
export function setProjectAccount(ctx: ServerContext, projectId: string, id: string): boolean {
  const account = findAccount(id);
  if (!account) return false;
  const provider = account.provider;
  if (projectId === HOME_ID) {
    const home = ctx.store.homeSettings();
    if (accountOf(home, provider) === id) return true;
    // unset is every harness on its default
    ctx.store.setHomeSettings({ accounts: withPick(home.accounts, provider, id) });
    ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
    return true;
  }
  const project = ctx.store.get(projectId) ?? ctx.store.findSession(projectId)?.project;
  if (!project) return false;
  if (accountOf(project, provider) === id && project.account === undefined) return true;
  // the Claude pick from before there were others moves into accounts
  const legacy = project.account && !project.accounts?.claude ? project.account : undefined;
  const picks = legacy ? withPick(project.accounts, "claude", legacy) : project.accounts;
  ctx.store.update(project.id, { accounts: withPick(picks, provider, id), account: undefined });
  ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  return true;
}

/**
 * Put one chat on an account of its own, over its project's; with none,
 * back on its project's for that harness. Picking the account its project
 * is on is following the project, not pinning it. Whether it was done.
 */
export function setChatAccount(
  ctx: ServerContext,
  chatId: string,
  provider: AccountProvider,
  id: string | undefined,
): boolean {
  if (id !== undefined && findAccount(id)?.provider !== provider) return false;
  if (chatId === HOME_ID) return setProjectAccount(ctx, HOME_ID, id ?? DEFAULT_ACCOUNTS[provider]);
  const found = ctx.store.findSession(chatId);
  if (!found) return false;
  const own = id === undefined || accountOf(found.project, provider) === id ? undefined : id;
  if (ctx.store.setSessionAccount(chatId, provider, own)) {
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  }
  return true;
}

export const accountHandlers = {
  // which account the project runs on, for the harness the account is
  // for: a chat's id names its project. Nothing running is stopped — each
  // chat's next process starts on the new account, and resumes its
  // session there (accounts.ts)
  set_account: (ctx, ws, msg) => {
    if (!setProjectAccount(ctx, msg.projectId, msg.account)) tell(ws, "That account isn't here any more.");
  },
  // one chat on an account of its own, over its project's — or back on
  // its project's. Home is one chat, so its own is Home's
  set_chat_account: (ctx, ws, msg) => {
    if (!setChatAccount(ctx, msg.chatId, msg.provider, msg.account)) {
      tell(ws, "That account isn't here any more.");
    }
  },
  account_add: (ctx, ws, msg) => {
    let added;
    try {
      added = addAccount(msg.provider, msg.name);
    } catch (err) {
      tell(ws, `The account couldn't be added: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    broadcastAccounts(ctx);
    // a folder taken as it was may already be signed in to
    void refreshAccount(added.id).then((changed) => {
      if (changed) broadcastAccounts(ctx);
    });
  },
  account_rename: (ctx, _ws, msg) => {
    if (renameAccount(msg.id, msg.name)) broadcastAccounts(ctx);
  },
  account_remove: (ctx, _ws, msg) => {
    const gone = removeAccount(msg.id);
    if (!gone) return;
    stopWatching(gone.id);
    ctx.terminals.closeChannel(signInChannel(gone.id));
    // whatever ran on it runs on its harness's default from here
    let moved = false;
    for (const project of ctx.store.list()) {
      if (project.accounts?.[gone.provider] !== gone.id && project.account !== gone.id) continue;
      ctx.store.update(project.id, {
        accounts: withPick(project.accounts, gone.provider, DEFAULT_ACCOUNTS[gone.provider]),
        ...(project.account === gone.id ? { account: undefined } : {}),
      });
      moved = true;
    }
    // and a chat on it goes back on its project's
    for (const project of ctx.store.list()) {
      for (const session of project.sessions) {
        if (session.accounts?.[gone.provider] !== gone.id) continue;
        if (ctx.store.setSessionAccount(session.id, gone.provider, undefined)) moved = true;
      }
    }
    if (moved) ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    if (ctx.store.homeSettings().accounts?.[gone.provider] === gone.id) {
      setProjectAccount(ctx, HOME_ID, DEFAULT_ACCOUNTS[gone.provider]);
    }
    broadcastAccounts(ctx);
  },
  account_sign_in: (ctx, ws, msg) => {
    const said = signInCommand(msg.id);
    if ("error" in said) {
      tell(ws, said.error);
      return;
    }
    prepareSignIn(msg.id);
    const channel = signInChannel(msg.id);
    ctx.clients.broadcast({
      type: "terminal_tabs",
      projectId: channel,
      tabs: ctx.terminals.run(channel, said.command),
    });
    watchSignIn(msg.id, () => broadcastAccounts(ctx));
  },
  account_sign_out: (ctx, ws, msg) => {
    void signOut(msg.id).then((error) => {
      if (error) tell(ws, error);
      broadcastAccounts(ctx);
    });
  },
  account_refresh: (ctx) => {
    void refreshAccounts().then((changed) => {
      if (changed) broadcastAccounts(ctx);
    });
  },
} satisfies Partial<Handlers>;

/** A sign-in shell that ended: the account is looked at again at once. */
export function signInEnded(ctx: ServerContext, channelId: string): void {
  const id = channelId.slice("account:".length);
  stopWatching(id);
  void refreshAccount(id).then((changed) => {
    if (changed) broadcastAccounts(ctx);
  });
}
