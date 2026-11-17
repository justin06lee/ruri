import {
  accountPick,
  DEFAULT_ACCOUNTS,
  HOME_ID,
  isAccountProvider,
  type AccountInfo,
  type AccountProvider,
  type HomeSettings,
  type Project,
  type UsageLimits,
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

/** Who an account is, in a few words: the email and plan, or that it
 *  isn't signed in. */
export function accountLine(account: AccountInfo): string {
  if (account.signedIn === false) return "not signed in";
  return [account.who, planName(account.plan), account.org].filter(Boolean).join(" · ");
}

/** One limit window of an account's, as the meters draw it. */
export interface Window {
  key: string;
  label: string;
  percent: number;
  resets?: number;
}

/** An account's windows that have a reading: 5 hours, the week, and the
 *  premium model's week when the harness has one. */
export function windowsOf(limits: UsageLimits | undefined): Window[] {
  if (!limits) return [];
  const out: Window[] = [];
  const add = (key: string, label: string, percent: number | undefined, resets: number | undefined) => {
    if (percent !== undefined) out.push({ key, label, percent, ...(resets !== undefined ? { resets } : {}) });
  };
  add("fiveHour", "5h", limits.fiveHour, limits.resets?.fiveHour);
  add("weekly", "week", limits.weekly, limits.resets?.weekly);
  if (limits.scoped) add("scoped", limits.scoped.label, limits.scoped.percent, limits.resets?.scoped);
  return out;
}

/** Past this a window is as good as gone, and says so in red. */
export const NEARLY_FULL = 90;

/** The fullest of an account's windows, for a word on how much room it has. */
export function fullest(limits: UsageLimits | undefined): Window | undefined {
  return windowsOf(limits).reduce<Window | undefined>(
    (top, w) => (!top || w.percent > top.percent ? w : top),
    undefined,
  );
}

/** What a usage key is called where every account's windows are listed:
 *  the harness, and the account when the harness has more than one read. */
export function usageName(accounts: AccountInfo[], usage: Record<string, UsageLimits>, key: string): string {
  const account = accounts.find((a) => a.usage === key);
  const provider = account?.provider ?? key.split(":")[0]!.replace(/-personal$/, "");
  const siblings = Object.keys(usage).filter(
    (k) =>
      (accounts.find((a) => a.usage === k)?.provider ?? k.split(":")[0]!.replace(/-personal$/, "")) ===
      provider,
  );
  if (siblings.length < 2) return provider;
  return `${provider} (${(account?.name ?? key.split(":")[1] ?? "personal").toLowerCase()})`;
}

/** How full an account's fullest window is, in a word for a menu: "Fable
 *  100%"; nothing when there is no reading. */
export function usageWord(limits: UsageLimits | undefined): string {
  const top = fullest(limits);
  return top ? `${top.label} ${Math.round(top.percent)}%` : "";
}
