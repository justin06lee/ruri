import { useEffect, useState } from "react";
import type { HookDelivery, HookTargetView, ProjectEventKind } from "../../../shared/protocol";
import { useNow } from "../lib/beat";
import { send, useRuri } from "../store";
import { Capped } from "./Capped";

/**
 * Project hooks (server/projectHooks.ts): when a project's whole team goes
 * idle, or gets blocked waiting on the user, ruri tells a command or a URL
 * — midna, say, so it can step in. The global hooks reach every project; a
 * project can keep them off it, and add its own. They sit under the
 * Integrations page's "For" picker: everywhere is the global hooks, a
 * project its own. A webhook's token is write-only — the server says
 * whether there is one, never what it is.
 */

const KIND_WORD: Record<ProjectEventKind, string> = {
  "project.idle": "is idle",
  "project.blocked": "is blocked",
  "project.test": "test event",
};

const STATE_WORD: Record<HookDelivery["state"], string> = {
  pending: "sending",
  ok: "delivered",
  retrying: "retrying",
  failed: "failed",
};

/** "40s ago", "3m ago", "2h ago". */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return s < 5 ? "just now" : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

/** "in 25s", "in 2m". */
function until(ts: number, now: number): string {
  const s = Math.max(0, Math.round((ts - now) / 1000));
  return s < 60 ? `in ${s}s` : `in ${Math.round(s / 60)}m`;
}

/** What a hook_set changes: only what was edited goes, "" clears. */
type Changes = { command?: string; url?: string; token?: string };

/**
 * A hook's command, URL and token, edited in place. Nothing goes until
 * Save, and then only what changed — so saving the URL leaves the token
 * alone, and a global hook still on midna's default stays the default
 * until its command is actually changed.
 */
function TargetForm({
  target,
  commandHint,
  busy,
  onSave,
}: {
  target: HookTargetView;
  /** Said beside the command when it is the default, not the user's. */
  commandHint?: string;
  busy: boolean;
  onSave(changes: Changes): void;
}) {
  const [command, setCommand] = useState(target.command);
  const [url, setUrl] = useState(target.url);
  // the token is never sent back: keep it, type a new one, or clear it
  const [token, setToken] = useState<{ mode: "keep" } | { mode: "new"; text: string } | { mode: "clear" }>({
    mode: "keep",
  });
  // what the server says changes under an untouched form
  const [seen, setSeen] = useState(target);
  if (seen !== target) {
    setSeen(target);
    if (command === seen.command) setCommand(target.command);
    if (url === seen.url) setUrl(target.url);
    setToken({ mode: "keep" });
  }
  const changes: Changes = {
    ...(command.trim() !== target.command ? { command: command.trim() } : {}),
    ...(url.trim() !== target.url ? { url: url.trim() } : {}),
    ...(token.mode === "new" && token.text ? { token: token.text } : {}),
    ...(token.mode === "clear" ? { token: "" } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  return (
    <div className="hooks-form">
      <label className="hooks-field">
        <span className="hooks-label">
          command{commandHint && <span className="hooks-hint"> · {commandHint}</span>}
        </span>
        <input
          className="int-line"
          placeholder="run with the event's JSON on stdin (optional)"
          value={command}
          spellCheck={false}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <label className="hooks-field">
        <span className="hooks-label">webhook</span>
        <input
          className="int-line"
          placeholder="https://… — POSTed the event's JSON (optional)"
          value={url}
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <div className="hooks-field">
        <span className="hooks-label">bearer token</span>
        {token.mode === "new" || (!target.hasToken && token.mode === "keep") ? (
          <input
            type="password"
            className="int-line"
            placeholder={target.hasToken ? "the new token" : "sent as Authorization: Bearer … (optional)"}
            value={token.mode === "new" ? token.text : ""}
            autoComplete="off"
            onChange={(e) => setToken({ mode: "new", text: e.target.value })}
          />
        ) : (
          <span className="hooks-token">
            {token.mode === "clear" ? "cleared when you save" : "••••••• set"}
            <button className="ghost" onClick={() => setToken({ mode: "new", text: "" })}>
              Replace
            </button>
            {token.mode === "clear" ? (
              <button className="ghost" onClick={() => setToken({ mode: "keep" })}>
                Keep it
              </button>
            ) : (
              <button className="ghost" onClick={() => setToken({ mode: "clear" })}>
                Clear
              </button>
            )}
          </span>
        )}
      </div>
      <div className="int-form-row">
        <button className="ghost" disabled={busy || !dirty} onClick={() => onSave(changes)}>
          Save
        </button>
        {dirty && (
          <button
            className="ghost"
            onClick={() => {
              setCommand(target.command);
              setUrl(target.url);
              setToken({ mode: "keep" });
            }}
          >
            Undo
          </button>
        )}
      </div>
    </div>
  );
}

/** A scope's hooks switched on or off: off keeps the command, URL and
 *  token as they are, and sends nothing. */
function OnOff({
  label,
  on,
  busy,
  title,
  onFlip,
}: {
  label: string;
  on: boolean;
  busy: boolean;
  title: string;
  onFlip(on: boolean): void;
}) {
  return (
    <div className="hooks-global-here">
      <span className="hooks-label">{label}</span>
      <button
        className={`seg-option toggle ${on ? "active" : ""}`}
        disabled={busy}
        title={title}
        onClick={() => onFlip(!on)}
      >
        {on ? "On" : "Off"}
      </button>
    </div>
  );
}

/** One event on its way to one hook: how it went, where, and when. */
function DeliveryRow({ delivery, now }: { delivery: HookDelivery; now: number }) {
  const tries =
    delivery.attempts > 1 || delivery.state === "failed"
      ? `${delivery.attempts} ${delivery.attempts === 1 ? "try" : "tries"}`
      : "";
  return (
    <div className={`hooks-row state-${delivery.state}`}>
      <span className={`hooks-state ${delivery.state}`}>{STATE_WORD[delivery.state]}</span>
      <span className="hooks-what">
        <b>{delivery.projectName}</b> {KIND_WORD[delivery.kind]}
      </span>
      <span className="hooks-to" title={delivery.to}>
        {delivery.target === "command" ? "$ " : ""}
        {delivery.to}
      </span>
      <span className="hooks-result" title={delivery.result}>
        {[
          delivery.result,
          tries,
          delivery.state === "retrying" && delivery.nextAt ? `next ${until(delivery.nextAt, now)}` : "",
          delivery.scope === "project" ? "its own hook" : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <span className="hooks-when" title={new Date(delivery.at).toLocaleString()}>
        {ago(delivery.at, now)}
      </span>
    </div>
  );
}

export function Hooks({ projectId, projectName }: { projectId: string; projectName?: string }) {
  const hooks = useRuri((s) => s.hooks);
  const connected = useRuri((s) => s.connected);
  // asked again after a reconnect, like the integrations themselves
  useEffect(() => {
    if (connected) send({ type: "hooks_get" });
  }, [connected]);
  // a change answered is a change done: every one comes back as `hooks`
  const [sentAt, setSentAt] = useState(0);
  const busy = sentAt > 0 && (hooks?.at ?? 0) < sentAt;
  const act = (message: Parameters<typeof send>[0]) => {
    setSentAt(Date.now());
    send(message);
  };
  const deliveries = (hooks?.view.deliveries ?? []).filter((d) => !projectId || d.projectId === projectId);
  const live = deliveries.some((d) => d.state === "pending" || d.state === "retrying");
  const now = useNow(live ? 1_000 : 30_000);
  if (!hooks) return <p className="settings-note">reading the hooks…</p>;
  const view = hooks.view;
  const global = view.global;
  const own = projectId ? view.projects[projectId] : undefined;
  const scope = projectId ? { projectId } : {};
  const globalSays = !global.enabled
    ? "switched off for every project"
    : global.command
      ? `$ ${global.command}`
      : global.url
        ? global.url
        : "nothing — no global hook is set";
  const ownSet = !!own && (own.command !== "" || own.url !== "" || own.hasToken);
  return (
    <div className="hooks">
      <p className="settings-note grants-note">
        When a project’s whole team goes idle, or gets blocked waiting on you, ruri tells a command or a URL —
        so midna, or anything else, can step in.{" "}
        {projectId
          ? `${projectName ?? "This project"} gets the global hooks unless it keeps them off, and can have its own as well.`
          : "These reach every project; pick one above to give it its own."}
      </p>

      {!projectId ? (
        <>
          <p className={`settings-note hooks-midna ${view.midna ? "found" : ""}`}>
            {view.midna ? (
              <>
                midna found at <code>{view.midna}</code>
                {global.custom
                  ? " — your own hook below is used instead"
                  : " — every event goes to it by default"}
              </>
            ) : (
              "midna isn’t on this machine’s PATH — set a command or a URL for events to go to"
            )}
          </p>
          <OnOff
            label="global hooks"
            on={global.enabled}
            busy={busy}
            title="Off keeps the command, URL and token, and no project gets the global hooks; a project's own still go"
            onFlip={(enabled) => act({ type: "hooks_set", enabled })}
          />
          <TargetForm
            target={global}
            {...(!global.custom && global.command ? { commandHint: "midna’s, the default" } : {})}
            busy={busy}
            onSave={(changes) => act({ type: "hooks_set", ...changes })}
          />
          {global.custom && (
            <div className="int-form-row">
              <button
                className="ghost"
                disabled={busy}
                title={view.midna ? `Back to ${view.midnaCommand}` : "Clear the global hook"}
                onClick={() => act({ type: "hooks_set", reset: true })}
              >
                {view.midna ? "Back to midna’s default" : "Clear the global hook"}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="hooks-global-here">
            <span className="hooks-label">global hooks</span>
            <div className="seg">
              <button
                className={`seg-option ${own?.useGlobal !== false ? "active" : ""}`}
                disabled={busy}
                onClick={() => act({ type: "hooks_set", projectId, useGlobal: true })}
              >
                used here
              </button>
              <button
                className={`seg-option ${own?.useGlobal === false ? "active" : ""}`}
                disabled={busy}
                onClick={() => act({ type: "hooks_set", projectId, useGlobal: false })}
              >
                kept off
              </button>
            </div>
            <span className="hooks-hint hooks-global-says" title={globalSays}>
              {globalSays}
            </span>
          </div>
          <p className="settings-note hooks-sub">Its own, as well:</p>
          {ownSet && (
            <OnOff
              label="its own"
              on={own.enabled}
              busy={busy}
              title="Off keeps its command, URL and token, and sends it nothing of its own; the global hooks still reach it unless kept off"
              onFlip={(enabled) => act({ type: "hooks_set", projectId, enabled })}
            />
          )}
          <TargetForm
            target={own ?? { command: "", url: "", hasToken: false, enabled: true }}
            busy={busy}
            onSave={(changes) => act({ type: "hooks_set", projectId, ...changes })}
          />
          {own && (ownSet || own.useGlobal === false) && (
            <div className="int-form-row">
              <button
                className="ghost"
                disabled={busy}
                title="Take its own hooks away, and give it the global ones again"
                onClick={() => act({ type: "hooks_set", projectId, reset: true })}
              >
                Back to just the global hooks
              </button>
            </div>
          )}
        </>
      )}

      <div className="int-form-row hooks-test">
        <button className="ghost" disabled={busy} onClick={() => act({ type: "hooks_test", ...scope })}>
          Send test event
        </button>
        <span className="settings-note">
          {projectId
            ? `a project.test event for ${projectName ?? "this project"}, to every hook its events go to`
            : "a project.test event, to the global hooks"}
        </span>
      </div>
      {hooks.error && <p className="settings-note int-note failed">{hooks.error}</p>}

      <details className="hooks-what-it-gets">
        <summary>what a hook is given</summary>
        <p>
          A command runs through <code>/bin/sh</code> in the project’s folder with the event’s JSON on its
          stdin, and <code>RURI_EVENT_KIND</code>, <code>RURI_EVENT_TITLE</code> (“orchard is idle”),{" "}
          <code>RURI_PROJECT_ID</code>, <code>RURI_PROJECT_NAME</code> and <code>RURI_PROJECT_PATH</code> set.
          It has 30 seconds. A webhook gets the JSON as a POST, with <code>Authorization: Bearer …</code> when
          a token is set.
        </p>
        <p>
          The JSON:{" "}
          <code>{`{"id", "source": "ruri", "kind", "project": {"id", "name", "path"}, "chats": [{"id", "name", "role", "lastSummary"}], "costUsd", "at"}`}</code>
          . <code>kind</code> is <code>project.idle</code>, <code>project.blocked</code> or{" "}
          <code>project.test</code>; <code>chats</code> are the ones that worked since the team went busy —
          the lead always, and on a blocked event the chat that is waiting first — each with its last reply
          (or what its card asks) in about 600 characters; <code>costUsd</code> is what was spent since then.
        </p>
        <p>
          One that fails is tried again after 5s, 30s, 2m and 10m — five tries in all — unless it can’t get
          better: an HTTP 4xx other than 408 or 429, or a command that exits 126 or 127.
        </p>
      </details>

      <h4 className="hooks-head">Recent deliveries</h4>
      {deliveries.length === 0 ? (
        <p className="settings-note">none yet{projectId ? ` for ${projectName ?? "this project"}` : ""}</p>
      ) : (
        <Capped>
          {deliveries.map((delivery) => (
            <DeliveryRow key={delivery.id} delivery={delivery} now={now} />
          ))}
        </Capped>
      )}
    </div>
  );
}
