import { useEffect, useState } from "react";
import type { SharedDevice } from "../../../shared/protocol";
import { send, useRuri } from "../store";
import { useNow } from "../lib/beat";
import { ruriShell, type PairOutcome, type Peer, type ShellState } from "../lib/shell";

/** "just now", "3m ago", "2h ago", "4d ago". */
function ago(ts: number | undefined, now: number): string {
  if (!ts) return "never";
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Settings → Devices: ruri on one computer, used from the others.
 *
 * Two halves, because a window has two ends. The server's: whether other
 * devices may run their chats on the computer this window is onto, the
 * six words that pair one more, and who has been let in (server/sharing.ts).
 * And the window's own, which only the desktop app has: the user's other
 * computers as this device sees them (makima, Tailscale, the LAN) — one
 * click sets one up over SSH and pairs, no words to type — and which
 * computer this window is onto (desktop/remote.ts).
 */
export function Devices() {
  const sharing = useRuri((s) => s.sharing);
  const remoteDevice = useRuri((s) => s.remoteDevice);
  const invite = useRuri((s) => s.invite);
  const now = useNow(30_000);
  const [copied, setCopied] = useState(false);
  // the invite on hand when one was asked for: the asking is over once a
  // different one has come
  const [askedOver, setAskedOver] = useState<string | null | undefined>(undefined);
  const asked = askedOver !== undefined && (invite?.words.join(" ") ?? null) === askedOver;

  // an invite that has run out is put away, and the button comes back
  const liveInvite = invite && invite.expires > now ? invite : null;

  if (!sharing) return null;
  const { on, name } = sharing;

  const copy = () => {
    if (!liveInvite) return;
    void navigator.clipboard.writeText(liveInvite.words.join(" ")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="devices">
      <div className="settings-row">
        <span className="settings-label">Share</span>
        <div className="settings-value">
          <button
            className={`seg-option toggle ${on ? "active" : ""}`}
            disabled={on && remoteDevice !== null}
            title={
              on && remoteDevice !== null
                ? `This window reaches ${name} through sharing — turn it off there`
                : on
                  ? "Stop letting other devices in"
                  : `Let your other devices use ${name}`
            }
            onClick={() => send({ type: "sharing_set", on: !on })}
          >
            {on ? "On" : "Off"}
          </button>
          <span className="settings-note">
            {on
              ? `Your paired devices run their chats on ${name} — its processor, its memory.` +
                (remoteDevice === null && !/Mac/.test(navigator.userAgent)
                  ? " Closing this window leaves ruri running for them."
                  : "")
              : `Let your other devices run their chats on ${name}, over your network, Tailscale or makima.`}
          </span>
        </div>
      </div>

      {sharing.error && <p className="devices-error">{sharing.error}</p>}

      {on && sharing.addresses.length > 0 && (
        <div className="settings-row">
          <span className="settings-label">Reached at</span>
          <div className="settings-value">
            <span
              className="devices-where"
              title="Every address a device tries at once — it keeps whichever answers"
            >
              {sharing.addresses.join(" · ")}
              <span className="devices-port"> port {sharing.port}</span>
            </span>
          </div>
        </div>
      )}

      <div className="settings-row tall">
        <span className="settings-label">Invite</span>
        <div className="settings-value devices-invite">
          {liveInvite ? (
            <>
              <div className="devices-code-row">
                <ol className="devices-words" title="Click to copy" onClick={copy}>
                  {liveInvite.words.map((word, i) => (
                    <li key={i}>
                      <span className="devices-word-n">{i + 1}</span>
                      {word}
                    </li>
                  ))}
                </ol>
                <button className="ghost grant-ask" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <span className="settings-note">
                On the other device: Settings, Devices — pick {name} and type these. They pair one device,
                once, until {clock(liveInvite.expires)}.
              </span>
            </>
          ) : (
            <div className="devices-code-row">
              <button
                className="ghost grant-ask"
                disabled={asked}
                onClick={() => {
                  setAskedOver(invite?.words.join(" ") ?? null);
                  send({ type: "sharing_invite" });
                }}
              >
                {asked ? "making…" : "Invite a device"}
              </button>
              <span className="settings-note">
                Six words, for a device that can't sign in to {name} over SSH.
                {on ? "" : " Turns sharing on."}
              </span>
            </div>
          )}
        </div>
      </div>

      {sharing.devices.length > 0 && (
        <div className="devices-list">
          {sharing.devices.map((device) => (
            <DeviceRow key={device.id} device={device} here={device.id === remoteDevice?.id} now={now} />
          ))}
        </div>
      )}

      {ruriShell && <ThisDevice />}
    </div>
  );
}

function DeviceRow({ device, here, now }: { device: SharedDevice; here: boolean; now: number }) {
  const [sure, setSure] = useState(false);
  return (
    <div className="grant-row">
      <span className={`grant-status device-status ${device.online ? "online" : ""}`}>
        {device.online ? "online" : "away"}
      </span>
      <span className="grant-body">
        <span className="grant-name">
          {device.name}
          {here && <span className="harness-version">this window</span>}
        </span>
        <span className="grant-why">
          paired {ago(device.pairedAt, now)}
          {!device.online && device.lastSeen ? ` · last here ${ago(device.lastSeen, now)}` : ""}
        </span>
      </span>
      <button
        className="ghost grant-ask"
        title={
          here ? "Unpairing this device closes this window" : "Its key stops working and its windows close"
        }
        onClick={() => {
          if (!sure) {
            setSure(true);
            setTimeout(() => setSure(false), 3000);
            return;
          }
          send({ type: "sharing_forget", deviceId: device.id });
        }}
      >
        {sure ? "Unpair?" : "Unpair"}
      </button>
    </div>
  );
}

const VIA_WORD: Record<Peer["via"][number], string> = {
  makima: "makima",
  tailscale: "Tailscale",
  lan: "this network",
  paired: "paired",
};

/**
 * The window's own end: the user's other computers as this device finds
 * them, and which one the window is onto. Setting one up moves the window
 * there; this device's own chats stop, since nothing runs here while it is
 * a window onto another.
 */
function ThisDevice() {
  const [state, setState] = useState<ShellState | null>(null);
  const [peers, setPeers] = useState<Peer[] | null>(null);
  // looking from the start: the page opens asking
  const [looking, setLooking] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [byAddress, setByAddress] = useState("");

  const find = () =>
    ruriShell?.peers().then((found) => {
      setPeers(found);
      setLooking(false);
    });
  const look = () => {
    setLooking(true);
    void find();
  };
  useEffect(() => {
    void ruriShell?.state().then(setState);
    void find();
  }, []);
  if (!ruriShell || !state) return null;
  const shell = ruriShell;
  const { computer, using } = state;

  // a computer typed in by its address, for one no mesh or LAN shows
  const typed: Peer | null = byAddress.trim()
    ? { name: byAddress.trim(), addresses: [byAddress.trim()], via: [], online: true }
    : null;
  const list = [...(peers ?? []), ...(typed && open === `addr:${typed.name}` ? [typed] : [])];

  return (
    <>
      <div className="settings-row tall devices-this">
        <span className="settings-label">This device</span>
        <div className="settings-value devices-invite">
          {using ? (
            <div className="devices-code-row">
              <span className="settings-note">
                This window is onto <strong>{using.name}</strong>
                {using.address ? ` at ${using.address}` : ""}: chats run there, and nothing runs on {computer}
                .
              </span>
              <button className="ghost grant-ask" onClick={() => void shell.use(null)}>
                Use {computer} instead
              </button>
            </div>
          ) : (
            <span className="settings-note">
              Run your chats on a stronger computer and keep only the window here — pick one below. Chats
              running on {computer} stop when you switch.
            </span>
          )}
        </div>
      </div>

      <div className="settings-row">
        <span className="settings-label">Computers</span>
        <div className="settings-value">
          <button className="ghost grant-ask" disabled={looking} onClick={look}>
            {looking ? "looking…" : "Look again"}
          </button>
          <span className="settings-note">
            {peers === null
              ? "Looking on makima, Tailscale and this network…"
              : peers.length === 0
                ? "None found on makima, Tailscale or this network. Add one by its address."
                : "Your other computers, on makima, Tailscale and this network."}
          </span>
        </div>
      </div>

      <div className="devices-list">
        {list.map((peer) => {
          const id = peer.via.length ? `peer:${peer.name}` : `addr:${peer.name}`;
          const paired = peer.ruri?.hostId;
          const current = paired !== undefined && paired === using?.id;
          const status = paired ? "paired" : peer.ruri ? "ruri" : peer.online ? "online" : "offline";
          return (
            <div key={id} className="devices-peer">
              <div className="grant-row">
                <span className={`grant-status device-status ${status === "paired" ? "online" : ""}`}>
                  {status}
                </span>
                <span className="grant-body">
                  <span className="grant-name">
                    {peer.name}
                    {current && <span className="harness-version">this window</span>}
                  </span>
                  <span className="grant-why">
                    {[peer.via.map((v) => VIA_WORD[v]).join(", "), peer.addresses.join(" · "), peer.os]
                      .filter(Boolean)
                      .join(" — ")}
                  </span>
                </span>
                {paired && !current && (
                  <button className="ghost grant-ask" onClick={() => void shell.use(paired)}>
                    Use
                  </button>
                )}
                {paired && (
                  <button
                    className="ghost grant-ask"
                    title={`Forget ${peer.name} on this device`}
                    onClick={() =>
                      void shell.forget(paired).then((next) => {
                        if (next) setState(next);
                        look();
                      })
                    }
                  >
                    Forget
                  </button>
                )}
                {!paired && peer.online && (
                  <button className="ghost grant-ask" onClick={() => setOpen(open === id ? null : id)}>
                    {open === id ? "Close" : "Set up"}
                  </button>
                )}
              </div>
              {open === id && !paired && <SetUp peer={peer} user={state.user} />}
            </div>
          );
        })}
      </div>

      <div className="settings-row">
        <span className="settings-label">By address</span>
        <div className="settings-value vault-form devices-address">
          <input
            placeholder="A computer none of these found — its name or IP"
            value={byAddress}
            spellCheck={false}
            onChange={(e) => setByAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && byAddress.trim()) setOpen(`addr:${byAddress.trim()}`);
            }}
          />
          <button
            className="ghost grant-ask"
            disabled={!byAddress.trim()}
            onClick={() => setOpen(`addr:${byAddress.trim()}`)}
          >
            Add
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * One computer, set up from here: signed in to over SSH, ruri started
 * there for good and this device paired — or, for one that can't be signed
 * in to, the six words it shows.
 */
function SetUp({ peer, user }: { peer: Peer; user: string }) {
  const [account, setAccount] = useState(user);
  const [address, setAddress] = useState(peer.addresses[0] ?? "");
  const [password, setPassword] = useState("");
  const [needs, setNeeds] = useState<PairOutcome["needs"]>(undefined);
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PairOutcome | null>(null);
  const [words, setWords] = useState("");
  const shell = ruriShell!;

  const run = (install = false) => {
    if (busy || !account.trim() || !address.trim()) return;
    setBusy(true);
    setOutcome(null);
    setSteps([`Signing in to ${account.trim()}@${address.trim()}`]);
    const stop = shell.onSetupStep((step) => setSteps((all) => [...all, step]));
    void shell
      .setUp({
        user: account.trim(),
        address: address.trim(),
        install,
        ...(needs === "password" && password ? { password } : {}),
      })
      .then((done) => {
        stop();
        setBusy(false);
        setOutcome(done);
        if (!done.ok) setNeeds(done.needs ?? (needs === "password" ? "password" : undefined));
        else setPassword("");
      });
  };

  const pair = () => {
    if (busy || !words.trim()) return;
    setBusy(true);
    setOutcome(null);
    setSteps([]);
    void shell
      .pairWords({
        words,
        address: peer.ruri?.address ?? address.trim(),
        ...(peer.ruri ? { port: peer.ruri.port } : {}),
      })
      .then((done) => {
        setBusy(false);
        setOutcome(done);
      });
  };

  const missing = outcome?.ok
    ? ["claude", "codex"].filter((h) => !(outcome.harnesses ?? []).includes(h))
    : [];

  return (
    <div className="devices-setup">
      <p className="settings-note">
        ruri signs in to {peer.name} over SSH, starts ruri there to keep running in the background, and pairs
        this device — nothing to type but, if it asks, a password.
      </p>
      <div className="devices-code-row vault-form">
        <input
          className="devices-account"
          value={account}
          spellCheck={false}
          aria-label="Account"
          onChange={(e) => setAccount(e.target.value)}
        />
        <span className="devices-at">@</span>
        {peer.addresses.length > 1 ? (
          <select value={address} onChange={(e) => setAddress(e.target.value)} aria-label="Address">
            {peer.addresses.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={address}
            spellCheck={false}
            aria-label="Address"
            onChange={(e) => setAddress(e.target.value)}
          />
        )}
        {needs === "password" && (
          <input
            type="password"
            placeholder={`${account}'s password`}
            value={password}
            autoFocus
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
          />
        )}
        <button
          className="ghost grant-ask"
          disabled={busy || (needs === "password" && !password)}
          onClick={() => run()}
        >
          {busy ? "setting up…" : needs === "password" ? "Continue" : "Set up"}
        </button>
      </div>

      {steps.length > 0 && (
        <ol className="devices-steps">
          {steps.map((step, i) => (
            <li key={i} className={busy && i === steps.length - 1 ? "now" : ""}>
              {step}
            </li>
          ))}
        </ol>
      )}

      {outcome && !outcome.ok && <p className="devices-error">{outcome.error}</p>}
      {outcome && !outcome.ok && outcome.needs === "install" && (
        <div className="devices-code-row">
          <button className="ghost grant-ask" disabled={busy} onClick={() => run(true)}>
            Install ruri there
          </button>
          <span className="settings-note">
            Builds it from source on {peer.name} (git, bun and make needed there) — a few minutes.
          </span>
        </div>
      )}
      {outcome?.ok && (
        <p className="settings-note">
          Paired with {outcome.name} — moving this window there…
          {missing.length > 0 &&
            ` ${missing.map((h) => (h === "claude" ? "Claude Code" : "Codex")).join(" and ")} ${missing.length > 1 ? "aren't" : "isn't"} installed on ${outcome.name} yet: install and sign in from a terminal in ruri, which now runs there.`}
        </p>
      )}

      <div className="devices-code-row vault-form devices-words-in">
        <input
          placeholder={`Or the six words ${peer.name} shows (Settings, Devices, Invite a device)`}
          value={words}
          spellCheck={false}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") pair();
          }}
        />
        <button className="ghost grant-ask" disabled={busy || !words.trim()} onClick={pair}>
          Pair
        </button>
      </div>
    </div>
  );
}
