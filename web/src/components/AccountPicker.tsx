import { useEffect, useRef, useState } from "react";
import type { UsageLimits } from "../../../shared/protocol";
import { accountLine, channelAccount, fullest, NEARLY_FULL, windowsOf } from "../lib/accounts";
import { setProjectAccount, useRuri } from "../store";

/**
 * The account chip: beside the model picker in the prompt box, the account
 * this chat's harness spends from. One click lists that harness's accounts,
 * each with how much of its windows is gone, so the one with room is the one
 * you pick — for the whole project, from its next start on (server/accounts.ts).
 * "Accounts…" goes to Settings, where they are added and signed in to.
 */

const CHECK = (
  <svg
    className="dropdown-check"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/** An account's limit windows as small bars, the fullest turning red. */
export function AccountMeters({ limits }: { limits: UsageLimits | undefined }) {
  const windows = windowsOf(limits);
  if (windows.length === 0) return <span className="account-meters none">no reading yet</span>;
  return (
    <span className="account-meters">
      {windows.map((w) => (
        <span
          key={w.key}
          className={`account-meter ${w.percent >= NEARLY_FULL ? "full" : ""}`}
          title={`${w.label}: ${Math.round(w.percent)}% used`}
        >
          <span className="account-meter-name">{w.label}</span>
          <span className="account-meter-track">
            <span
              className="account-meter-fill"
              style={{ width: `${Math.min(100, Math.max(0, w.percent))}%` }}
            />
          </span>
          <span className="account-meter-percent">{Math.round(w.percent)}%</span>
        </span>
      ))}
    </span>
  );
}

function PersonIcon() {
  return (
    <svg
      className="account-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

export function AccountPicker({ channelId, provider }: { channelId: string; provider: string | undefined }) {
  const current = useRuri((s) => channelAccount(s, channelId, provider));
  const accounts = useRuri((s) => s.accounts);
  const usage = useRuri((s) => s.usage);
  const setSettingsOpen = useRuri((s) => s.setSettingsOpen);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!current) return null;
  const mine = accounts.filter((a) => a.provider === current.provider);
  const top = fullest(usage[current.usage]);
  const full = top !== undefined && top.percent >= NEARLY_FULL;
  const said = accountLine(current);
  return (
    <div className="dropdown account-picker" ref={ref}>
      <button
        className={`dropdown-trigger account-trigger ${open ? "open" : ""} ${full ? "full" : ""}`}
        title={[
          `Account: ${current.name}${said ? ` (${said})` : ""}`,
          ...(top ? [`${top.label} ${Math.round(top.percent)}% used`] : []),
          "Click for the others and how much room each has",
        ].join(" — ")}
        onClick={() => setOpen(!open)}
      >
        <PersonIcon />
        <span className="dropdown-label">{current.name}</span>
        <svg
          className="dropdown-chevron"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="dropdown-menu up account-menu" role="listbox">
          {mine.map((a) => {
            const off = a.signedIn === false;
            return (
              <button
                key={a.id}
                role="option"
                aria-selected={a.id === current.id}
                className={`dropdown-item account-item ${a.id === current.id ? "selected" : ""} ${off ? "off" : ""}`}
                title={off ? `${a.name} isn't signed in — sign in on the Accounts page` : undefined}
                onClick={() => {
                  setOpen(false);
                  if (off) setSettingsOpen(true, "accounts");
                  else if (a.id !== current.id) setProjectAccount(channelId, a);
                }}
              >
                {CHECK}
                <span className="account-item-words">
                  <span className="account-item-name">{a.name}</span>
                  {accountLine(a) && <span className="account-item-who">{accountLine(a)}</span>}
                </span>
                {!off && <AccountMeters limits={usage[a.usage]} />}
              </button>
            );
          })}
          <button
            className="dropdown-item account-manage"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true, "accounts");
            }}
          >
            {CHECK}
            Accounts…
          </button>
        </div>
      )}
    </div>
  );
}
