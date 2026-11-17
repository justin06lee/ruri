import {
  accountPick,
  DEFAULT_ACCOUNTS,
  HOME_ID,
  isAccountProvider,
  type AccountInfo,
  type AccountProvider,
  type HomeSettings,
  type Project,
} from "../../../shared/protocol";

/**
 * Which account a chat runs on, worked out the way the server does it
 * (server/accounts.ts accountOf): its project's pick for the harness —
 * Home's own for Home — while that is still an account for it, else the
 * harness's default.
 */

type Picks = Pick<Project, "account" | "accounts"> | HomeSettings | undefined;

/** The project a channel belongs to — a project's id or any chat's. */
export function projectOfChannel(projects: Project[], channelId: string): Project | undefined {
  return projects.find((p) => p.id === channelId || p.sessions.some((x) => x.id === channelId));
}

export function accountIn(accounts: AccountInfo[], picks: Picks, provider: AccountProvider): string {
  const pick = accountPick(picks, provider);
  return accounts.some((a) => a.id === pick && a.provider === provider) ? pick : DEFAULT_ACCOUNTS[provider];
}

/** The picks a channel goes by: Home's settings, or its project's. */
export function picksOf(s: { projects: Project[]; home: HomeSettings }, channelId: string): Picks {
  return channelId === HOME_ID ? s.home : projectOfChannel(s.projects, channelId);
}

/** The account a channel runs `provider` on; undefined for a harness ruri
 *  has no accounts for. */
export function channelAccount(
  s: { projects: Project[]; home: HomeSettings; accounts: AccountInfo[] },
  channelId: string,
  provider: string | undefined,
): AccountInfo | undefined {
  const harness = provider ?? "claude";
  if (!isAccountProvider(harness)) return undefined;
  const id = accountIn(s.accounts, picksOf(s, channelId), harness);
  return s.accounts.find((a) => a.id === id);
}

/** Picks with this account's said — and the default said by saying nothing. */
export function withPick(
  picks: Partial<Record<AccountProvider, string>> | undefined,
  account: Pick<AccountInfo, "id" | "provider">,
): Partial<Record<AccountProvider, string>> | undefined {
  const next = { ...picks };
  if (account.id === DEFAULT_ACCOUNTS[account.provider]) delete next[account.provider];
  else next[account.provider] = account.id;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A plan as people say it: "max" → "Max". */
export function planName(plan: string | undefined): string | undefined {
  return plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;
}
