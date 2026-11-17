import { useEffect, useState } from "react";
import { ACCOUNT_PROVIDERS, type AccountInfo, type AccountProvider } from "../../../shared/protocol";
import { accountIn, accountLine } from "../lib/accounts";
import { send, useRuri } from "../store";
import { AccountMeters } from "./AccountPicker";
import { FoldList, FoldRow } from "./FoldList";
import { LoneShell } from "./Terminal";

/**
 * Settings → Accounts: every sign-in a harness can run on, by harness —
 * who each is signed in as, how much of its windows is gone, how many
 * projects run on it — and adding, renaming, removing, signing in and out
 * (server/accounts.ts, accountStatus.ts). Signing in opens a shell under
 * the row with the harness's own login typed into it; it closes by itself
 * once the login is done. Which account a project runs on is picked from
 * the chip in its prompt box (AccountPicker), not here.
 */

const HARNESS: Record<AccountProvider, string> = { claude: "Claude", codex: "Codex" };

const ABOUT: Record<AccountProvider, string> = {
  claude:
    "Each is a Claude Code sign-in kept in a folder of its own (its CLAUDE_CONFIG_DIR). Work is Claude Code's own; one you add shares your instructions, settings and skills with it, never the sign-in.",
  codex:
    "Each is a Codex sign-in kept in a folder of its own (its CODEX_HOME). The first is Codex's own; one you add shares your config and instructions with it, never the sign-in.",
};

export function Accounts({ shown }: { shown: boolean }) {
  const accounts = useRuri((s) => s.accounts);
  // who each is signed in as can change outside ruri, so it is looked at
  // again whenever the page comes up (the server asks at most every 15s)
  useEffect(() => {
    if (shown) send({ type: "account_refresh" });
  }, [shown]);
  return (
    <>
      <p className="settings-note">
        A project picks the account it runs on from the chip beside the model in its prompt box.
      </p>
      {ACCOUNT_PROVIDERS.map((provider) => (
        <ProviderAccounts
          key={provider}
          provider={provider}
          accounts={accounts.filter((a) => a.provider === provider)}
        />
      ))}
    </>
  );
}

function ProviderAccounts({ provider, accounts }: { provider: AccountProvider; accounts: AccountInfo[] }) {
  const [name, setName] = useState("");
  const add = () => {
    const given = name.trim();
    if (!given) return;
    send({ type: "account_add", provider, name: given });
    setName("");
  };
  return (
    <FoldList
      id={`accounts-${provider}`}
      title={HARNESS[provider]}
      count={accounts.length}
      info={ABOUT[provider]}
    >
      {accounts.map((a) => (
        <AccountRow key={a.id} account={a} />
      ))}
      <div className="vault-form account-add">
        <input
          placeholder={`Another ${HARNESS[provider]} account — what will you call it?`}
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button className="ghost" disabled={!name.trim()} onClick={add}>
          Add
        </button>
      </div>
    </FoldList>
  );
}

function AccountRow({ account }: { account: AccountInfo }) {
  const limits = useRuri((s) => s.usage[account.usage]);
  const using = useRuri(
    (s) =>
      s.projects.filter((p) => !p.hidden && accountIn(s.accounts, p, account.provider) === account.id).length,
  );
  const channel = `account:${account.id}`;
  const shell = useRuri((s) => s.terminals[channel]?.[0]);
  const [naming, setNaming] = useState<string | null>(null);
  /** Which of the two that can't be taken back is waiting on a second click. */
  const [sure, setSure] = useState<"out" | "remove" | null>(null);

  // a second click is wanted soon, or not at all
  useEffect(() => {
    if (!sure) return;
    const timer = setTimeout(() => setSure(null), 4_000);
    return () => clearTimeout(timer);
  }, [sure]);

  const rename = () => {
    const given = naming?.trim();
    if (given && given !== account.name) send({ type: "account_rename", id: account.id, name: given });
    setNaming(null);
  };
  const line = account.signedIn === undefined ? "" : accountLine(account);

  return (
    <div className="devices-peer account-row">
      <FoldRow
        name={
          naming !== null ? (
            <input
              className="account-name-input"
              value={naming}
              maxLength={64}
              autoFocus
              aria-label="Account name"
              onChange={(e) => setNaming(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => {
                if (e.key === "Enter") rename();
                if (e.key === "Escape") setNaming(null);
              }}
            />
          ) : (
            <span onDoubleClick={() => setNaming(account.name)} title="Double-click to rename">
              {account.name}
            </span>
          )
        }
        tag={line}
        faded={account.signedIn === false}
        title={account.dir}
      >
        {account.signedIn ? (
          <button
            className="ghost"
            title={sure === "out" ? undefined : "Sign this account out of its harness"}
            onClick={() => {
              if (sure !== "out") return setSure("out");
              setSure(null);
              send({ type: "account_sign_out", id: account.id });
            }}
          >
            {sure === "out" ? "Sign out?" : "Sign out"}
          </button>
        ) : (
          <button
            className="ghost"
            disabled={shell !== undefined}
            title="Sign in with the harness's own login, in a shell under this row"
            onClick={() => send({ type: "account_sign_in", id: account.id })}
          >
            Sign in
          </button>
        )}
        <button className="ghost" onClick={() => setNaming(account.name)}>
          Rename
        </button>
        {!account.builtIn && (
          <button
            className="ghost"
            title={
              sure === "remove"
                ? undefined
                : "Take it off the list — its folder, sign-in and chats stay on this machine; projects on it go back to the default"
            }
            onClick={() => {
              if (sure !== "remove") return setSure("remove");
              setSure(null);
              send({ type: "account_remove", id: account.id });
            }}
          >
            {sure === "remove" ? "Remove?" : "Remove"}
          </button>
        )}
      </FoldRow>
      {account.signedIn && (
        <div className="account-row-room">
          <AccountMeters limits={limits} />
          <span className="account-row-using">
            {using === 0 ? "no projects" : using === 1 ? "1 project" : `${using} projects`}
          </span>
        </div>
      )}
      {shell && (
        <div className="account-sign-in">
          <div className="account-sign-in-head">
            <span>
              Signing in to {account.name}. Open the link it prints if no browser opens; it closes by itself
              once you're in.
            </span>
            <button
              className="ghost"
              onClick={() => send({ type: "terminal_close", projectId: channel, termId: shell })}
            >
              Close
            </button>
          </div>
          <LoneShell channelId={channel} termId={shell} />
        </div>
      )}
    </div>
  );
}
