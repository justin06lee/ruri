import { useState } from "react";
import type { VaultDevice, VaultJob, VaultState } from "../../../shared/protocol";
import { useNow } from "../lib/beat";
import { span } from "../lib/quiet";
import { send } from "../store";
import { FoldList, FoldRow } from "./FoldList";
import { InfoTip } from "./InfoTip";

/** The same vault, whatever the address says around its host. */
const hostOf = (server: string | undefined) => {
  try {
    return server ? new URL(server).host.toLowerCase() : "";
  } catch {
    return "";
  }
};

/**
 * The Passwords page's look at the tailnet (server/vaultFinder.ts): the
 * user's devices, which of them already serve a ghostly vault, and from
 * there one click to have ruri use one, or to set a vault up on a device
 * that has none. What a click starts is a card under that device's row
 * (JobCard): what it printed as it went, then the steps only a person can
 * do in the vault's own web app, one at a time.
 */
export function VaultDevices({ vault }: { vault: VaultState }) {
  const [open, setOpen] = useState<string | null>(null);
  const tailnet = vault.tailnet;
  const job = vault.job;
  const usable = vault.installed && vault.enrolled && vault.ok;
  const busy = job?.running === true;
  const devices = tailnet?.devices ?? [];
  const mine = hostOf(vault.server);
  /** The card goes under the row it is about, or under the list. */
  const cardAt = job ? devices.find((d) => d.name === job.device)?.host : undefined;

  const action = (d: VaultDevice) => {
    // with a vault that works, there is nothing here to do
    if (usable) return null;
    if (d.vault) {
      // its card is up, and says what to do next
      if (job?.kind === "enroll" && job.server === d.vault.server && job.stage !== "done") return null;
      const uses = mine !== "" && hostOf(d.vault.server) === mine;
      return (
        <button
          className="ghost"
          disabled={busy || !vault.installed}
          title={
            !vault.installed
              ? "Install ghostly on this machine first"
              : `Enroll ruri with this vault: it gets an account of its own there, and sees only what you share with it`
          }
          onClick={() => send({ type: "vault_enroll", server: d.vault!.server })}
        >
          {uses && vault.enrolled ? "Carry on" : "Use this vault"}
        </button>
      );
    }
    if (!d.online) return null;
    return (
      <button className="ghost" disabled={busy} onClick={() => setOpen(open === d.host ? null : d.host)}>
        {open === d.host ? "Close" : "Set up here"}
      </button>
    );
  };

  const enrolling = job?.kind === "enroll" && job.stage !== "done" ? hostOf(job.server) : "";
  const tag = (d: VaultDevice) => {
    if (d.vault && enrolling && hostOf(d.vault.server) === enrolling) return "vault · enrolling ruri";
    if (d.vault && mine && hostOf(d.vault.server) === mine)
      return vault.ok ? "ruri's vault" : "ruri's vault · not answering";
    if (d.vault) return `vault · ${d.vault.software}`;
    return d.online ? "no vault" : "offline";
  };

  return (
    <>
      <FoldList
        id="vault-devices"
        title="On your tailnet"
        count={tailnet?.state === "connected" ? devices.length : undefined}
        info="Your devices on Tailscale, and which of them run a ghostly vault. ruri asks each one only for the description every vault gives of itself."
        actions={
          <button className="ghost" disabled={tailnet?.looking} onClick={() => send({ type: "vault_look" })}>
            {tailnet?.looking ? "Looking…" : "Look again"}
          </button>
        }
      >
        {(!tailnet || (tailnet.looking && !tailnet.at)) && (
          <p className="fold-empty">Looking on your tailnet…</p>
        )}
        {tailnet?.at && tailnet.state === "none" && (
          <p className="fold-empty">
            Tailscale isn't on this machine. With it, ruri finds a vault on your other devices, or sets one up
            on one of them.
          </p>
        )}
        {tailnet?.at && tailnet.state === "off" && (
          <p className="fold-empty">Tailscale is off. Turn it on to find a vault on your other devices.</p>
        )}
        {tailnet?.at && tailnet.state === "connected" && devices.length === 0 && (
          <p className="fold-empty">No other devices on your tailnet.</p>
        )}
        {devices.map((d) => (
          <div key={d.host} className="devices-peer">
            <FoldRow
              name={d.self ? `${d.name} (this one)` : d.name}
              tag={tag(d)}
              faded={!d.online}
              title={[d.vault?.server ?? d.host, d.os, d.ssh ? "Tailscale SSH on" : ""]
                .filter(Boolean)
                .join(" — ")}
            >
              {action(d)}
            </FoldRow>
            {open === d.host && !d.vault && !usable && !(job && cardAt === d.host) && (
              <SetUpVault device={d} user={tailnet?.user ?? ""} busy={busy} />
            )}
            {job && cardAt === d.host && <JobCard job={job} device={d} user={tailnet?.user ?? ""} />}
          </div>
        ))}
      </FoldList>
      {job && !cardAt && <JobCard job={job} user={tailnet?.user ?? ""} />}
    </>
  );
}

/** Before a vault is set up on a device: what it needs, and who to sign in as. */
function SetUpVault({ device, user, busy }: { device: VaultDevice; user: string; busy: boolean }) {
  const [account, setAccount] = useState(user);
  const go = () => {
    if (busy || (!device.self && !account.trim())) return;
    send({ type: "vault_setup", host: device.host, ...(device.self ? {} : { user: account.trim() }) });
  };
  return (
    <div className="devices-setup">
      <p className="settings-note">
        Sets a ghostly vault up on {device.self ? "this machine" : device.name}, for your devices only.
        <InfoTip>
          ruri {device.self ? "runs" : "signs in over SSH and runs"} ghostly's installer there: Vaultwarden in
          Docker, served by Tailscale inside your tailnet with a real certificate, never on the internet. It
          needs Docker on {device.self ? "this machine" : device.name} and HTTPS switched on for your tailnet
          (Tailscale's admin page, DNS). If something is missing, it says what.
        </InfoTip>
      </p>
      <div className="devices-code-row vault-form">
        {!device.self && (
          <>
            <input
              className="devices-account"
              value={account}
              spellCheck={false}
              aria-label="Account"
              onChange={(e) => setAccount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") go();
              }}
            />
            <span className="devices-at">@{device.name}</span>
          </>
        )}
        <button className="ghost grant-ask" disabled={busy || (!device.self && !account.trim())} onClick={go}>
          Set up
        </button>
      </div>
    </div>
  );
}

const TITLE: Record<VaultJob["kind"], (job: VaultJob) => string> = {
  enroll: (job) => `ruri, with the vault on ${job.device ?? hostOf(job.server)}`,
  server: (job) => `A vault on ${job.device ?? "a device"}`,
  agent: () => "ghostly, on this machine",
};

/** A link to the vault's own web app, opened in the browser. */
function VaultLink({ server, path = "", children }: { server: string; path?: string; children: string }) {
  return (
    <a href={`${server}${path}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/**
 * One job's card: what it printed as it went, why it stopped if it did,
 * and where it stands — for an enrollment, the step the owner is to do
 * next in the vault's web app, with "Check again" to see that it is done.
 */
function JobCard({ job, device, user }: { job: VaultJob; device?: VaultDevice; user: string }) {
  const now = useNow(1_000, job.running);
  const [password, setPassword] = useState("");
  const [account, setAccount] = useState(job.user ?? user);
  const server = job.server ?? "";
  const email = job.email ?? "";
  const check = () => send({ type: "vault_enroll", server });
  const copiedNow = job.copied !== undefined && now - job.copied < 30_000;
  /** Sign in again with a password, to go on where SSH stopped. */
  const retry = () => {
    if (!password || !device) return;
    send(
      job.stage === "signups"
        ? { type: "vault_signups_off", password }
        : { type: "vault_setup", host: device.host, user: account.trim(), password },
    );
    setPassword("");
  };

  return (
    <div className="devices-setup vault-job">
      <div className="vault-job-head">
        <span className="vault-job-title">{TITLE[job.kind](job)}</span>
        <span className="vault-read">{job.running ? span(now - job.since) : ""}</span>
        {!job.running && (
          <button className="ghost" onClick={() => send({ type: "vault_job_close" })}>
            Close
          </button>
        )}
      </div>

      {job.lines.length > 0 && (
        <ol className="devices-steps vault-job-lines">
          {job.lines.map((line, i) => (
            <li key={i} className={job.running && i === job.lines.length - 1 ? "now" : ""}>
              {line}
            </li>
          ))}
        </ol>
      )}

      {job.error && <p className="devices-error">{job.error}</p>}

      {job.needsPassword && device && !device.self && (
        <div className="devices-code-row vault-form">
          <input
            className="devices-account"
            value={account}
            spellCheck={false}
            aria-label="Account"
            onChange={(e) => setAccount(e.target.value)}
          />
          <span className="devices-at">@{device.name}</span>
          <input
            type="password"
            placeholder={`${account}'s password`}
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") retry();
            }}
          />
          <button className="ghost grant-ask" disabled={!password || job.running} onClick={retry}>
            Continue
          </button>
        </div>
      )}

      {!job.running && job.kind === "enroll" && job.stage === "account" && (
        <>
          <ol className="vault-job-todo">
            <li>
              In <VaultLink server={server}>the vault</VaultLink>, signed in as you: Admin Console → Members →
              Invite member. Invite <code>{email}</code> as a User who can edit items, with the one collection
              ruri may use.
              <InfoTip>
                No organization yet? Make one first with New organization: it comes with a collection. No mail
                is sent; the address is only a name.
              </InfoTip>
            </li>
            <li>
              In a private window, make its account at{" "}
              <VaultLink server={server} path="/#/signup">
                the signup page
              </VaultLink>{" "}
              with the email <code>{email}</code> and the password ruri was given.
            </li>
          </ol>
          <div className="vault-job-actions">
            <button
              className="ghost"
              title="It goes on this machine's clipboard for 30 seconds, never to this page"
              onClick={() => send({ type: "vault_copy_password" })}
            >
              {copiedNow ? "Copied, for 30s" : "Copy its password"}
            </button>
            <button className="ghost grant-ask" onClick={check}>
              Check again
            </button>
          </div>
        </>
      )}

      {!job.running && job.kind === "enroll" && job.stage === "confirm" && (
        <>
          <p className="settings-note">
            Last, confirm it: in <VaultLink server={server}>the vault</VaultLink>, Admin Console → Members →{" "}
            <code>{email}</code> → ⋮ → Confirm.
            {job.fingerprint && (
              <>
                {" "}
                The phrase it shows must read <strong>{job.fingerprint}</strong>.
              </>
            )}
          </p>
          <div className="vault-job-actions">
            <button className="ghost grant-ask" onClick={check}>
              Check again
            </button>
          </div>
        </>
      )}

      {!job.running && job.kind === "enroll" && job.stage === "collection" && (
        <>
          <p className="settings-note">
            One thing left: share a collection with it. In <VaultLink server={server}>the vault</VaultLink>,
            Admin Console → Members → <code>{email}</code> → Collections.
          </p>
          <div className="vault-job-actions">
            <button className="ghost grant-ask" onClick={check}>
              Check again
            </button>
          </div>
        </>
      )}

      {!job.running && job.kind === "enroll" && job.stage === "done" && (
        <p className="settings-note">
          ruri is enrolled as <code>{email}</code>. Share a login with it by putting it in that collection,
          from any Bitwarden app, and it shows up here.
        </p>
      )}

      {!job.running && job.kind === "server" && job.stage === "signups" && (
        <>
          <p className="settings-note">
            Open <VaultLink server={server}>{server.replace(/^https:\/\//, "")}</VaultLink> and make your own
            account there: this is your vault, so pick a strong master password. Then close signups, so nobody
            else can make one.
          </p>
          <div className="vault-job-actions">
            <button className="ghost grant-ask" onClick={() => send({ type: "vault_signups_off" })}>
              Close signups
            </button>
          </div>
        </>
      )}

      {!job.running && job.kind === "server" && job.stage === "done" && (
        <>
          <p className="settings-note">Your vault is ready. Next, ruri gets an account of its own on it.</p>
          <div className="vault-job-actions">
            <button className="ghost grant-ask" onClick={() => send({ type: "vault_enroll", server })}>
              Use this vault
            </button>
          </div>
        </>
      )}

      {!job.running && job.kind === "agent" && job.stage === "done" && (
        <p className="settings-note">ghostly is installed. Pick the vault it should use above.</p>
      )}
    </div>
  );
}
