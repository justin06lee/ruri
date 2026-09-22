import { useEffect, useState } from "react";
import type { IntegrationHarness, McpAdd, McpServerRow, PluginRow } from "../../../shared/protocol";
import { splitCommand } from "../lib/commandLine";
import { send, useRuri } from "../store";

/**
 * Settings → Integrations: what Claude Code and Codex plug in — MCP
 * servers, plugins, the marketplaces plugins come from — as their own
 * CLIs keep them, with a way to add and take away each. Nothing here is
 * ruri's own config: every change is the harness's CLI doing it, the same
 * as in a terminal (server/integrations.ts).
 *
 * Servers are read for everywhere and, with a project picked, for that
 * project as well — Claude keeps servers per project (just you, or shared
 * through the project's .mcp.json). What a server is given to run with is
 * shown by name only; the values stay in the harness's config.
 */

const HARNESS: Record<IntegrationHarness, string> = { claude: "Claude Code", codex: "Codex" };

const SCOPE_WORD: Record<McpServerRow["scope"], string> = {
  user: "everywhere",
  local: "this project · you",
  project: "this project · shared",
  codex: "everywhere",
  plugin: "from a plugin",
};

/** KEY=value (or `Key: value`) lines as a map; lines that are neither
 *  are left out. */
function pairs(text: string, sep: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(sep);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
}

function Tag({ harness }: { harness: IntegrationHarness }) {
  return <span className={`int-tag ${harness}`}>{harness === "claude" ? "claude" : "codex"}</span>;
}

export function Integrations() {
  const projects = useRuri((s) => s.projects);
  const found = useRuri((s) => s.integrations);
  const note = useRuri((s) => s.integrationNote);
  const connected = useRuri((s) => s.connected);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  // asked again after a reconnect: an ask the server never got is not
  // one it will answer
  useEffect(() => {
    if (connected) send({ type: "integrations_get", ...(projectId ? { projectId } : {}) });
  }, [projectId, connected]);
  // a change answered is a change done
  const [noteSeen, setNoteSeen] = useState(note);
  if (note !== noteSeen) {
    setNoteSeen(note);
    setBusy(false);
  }
  const act = (message: Parameters<typeof send>[0]) => {
    setBusy(true);
    send(message);
  };
  const data = found && (found.projectId ?? "") === projectId ? found.data : null;
  const project = projects.find((p) => p.id === projectId);

  return (
    <div className="integrations">
      <p className="settings-note grants-note">
        The MCP servers and plugins Claude Code and Codex start with, as their own CLIs keep them — changing
        one here is the CLI changing it. A chat picks a change up the next time its harness starts: the warm
        ones are restarted as each goes idle, and carry on where they were.
      </p>
      <div className="int-for">
        <span className="settings-label">For</span>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">everywhere</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              everywhere + {p.name}
            </option>
          ))}
        </select>
        {busy && <span className="settings-note">working…</span>}
        {!busy && note && (
          <span className={`settings-note int-note ${note.ok ? "" : "failed"}`}>{note.message}</span>
        )}
      </div>

      {!data && <p className="settings-note">reading…</p>}
      {data?.errors?.map((error) => (
        <p key={error} className="settings-note int-note failed">
          {error}
        </p>
      ))}

      {data && (
        <>
          <h3 className="int-head">MCP servers</h3>
          {data.servers.length === 0 && <p className="settings-note">none yet</p>}
          {data.servers.map((server) => (
            <div key={`${server.harness}:${server.scope}:${server.name}`} className="int-row">
              <Tag harness={server.harness} />
              <span className="int-body">
                <span className="int-name">
                  {server.name}
                  {!server.enabled && <span className="int-off"> · off</span>}
                </span>
                <span className="int-target" title={server.target}>
                  {server.target}
                </span>
                {(server.env || server.headers) && (
                  <span className="int-given">
                    given {[...(server.env ?? []), ...(server.headers ?? [])].join(", ")}
                  </span>
                )}
              </span>
              <span className="int-scope">
                {server.scope === "plugin"
                  ? `from ${server.plugin?.split("@")[0]}`
                  : SCOPE_WORD[server.scope]}
              </span>
              {server.scope !== "plugin" ? (
                <button
                  className="ghost grant-ask"
                  disabled={busy}
                  title={`Take ${server.name} out of ${HARNESS[server.harness]}'s config`}
                  onClick={() =>
                    act({
                      type: "mcp_remove",
                      harness: server.harness,
                      name: server.name,
                      scope: server.scope,
                      ...(projectId ? { projectId } : {}),
                    })
                  }
                >
                  Remove
                </button>
              ) : (
                <span className="int-spacer" />
              )}
            </div>
          ))}
          <AddServer projectId={projectId} projectName={project?.name} busy={busy} onAdd={act} />

          <h3 className="int-head">Plugins</h3>
          {data.plugins.length === 0 && <p className="settings-note">none installed</p>}
          {data.plugins.map((plugin) => (
            <PluginLine key={`${plugin.harness}:${plugin.id}`} plugin={plugin} busy={busy} onAct={act} />
          ))}
          <BrowsePlugins busy={busy} onAct={act} projectId={projectId} />

          <h3 className="int-head">Marketplaces</h3>
          {data.marketplaces.map((market) => (
            <div key={`${market.harness}:${market.name}`} className="int-row">
              <Tag harness={market.harness} />
              <span className="int-body">
                <span className="int-name">{market.name}</span>
                <span className="int-target" title={market.source}>
                  {market.source || "built in"}
                </span>
              </span>
              <button
                className="ghost grant-ask"
                disabled={busy}
                onClick={() =>
                  act({ type: "marketplace_remove", harness: market.harness, name: market.name })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <AddMarketplace busy={busy} onAct={act} />
        </>
      )}
    </div>
  );
}

function PluginLine({
  plugin,
  busy,
  onAct,
}: {
  plugin: PluginRow;
  busy: boolean;
  onAct(message: Parameters<typeof send>[0]): void;
}) {
  return (
    <div className="int-row">
      <Tag harness={plugin.harness} />
      <span className="int-body">
        <span className="int-name">
          {plugin.name}
          {plugin.version && <span className="harness-version">v{plugin.version}</span>}
        </span>
        <span className="int-target">
          {plugin.marketplace}
          {plugin.scope && plugin.scope !== "user" ? ` · ${plugin.scope}` : ""}
        </span>
      </span>
      {plugin.harness === "claude" && (
        <label className="harness-auto" title="Load it in new Claude sessions">
          <input
            type="checkbox"
            checked={plugin.enabled !== false}
            disabled={busy}
            onChange={(e) => onAct({ type: "plugin_enable", id: plugin.id, enabled: e.target.checked })}
          />
          on
        </label>
      )}
      <button
        className="ghost grant-ask"
        disabled={busy}
        onClick={() => onAct({ type: "plugin_uninstall", harness: plugin.harness, id: plugin.id })}
      >
        Remove
      </button>
    </div>
  );
}

/** A server to put in: which harness, how it is reached, and — for
 *  Claude — where it applies. */
function AddServer({
  projectId,
  projectName,
  busy,
  onAdd,
}: {
  projectId: string;
  projectName: string | undefined;
  busy: boolean;
  onAdd(message: Parameters<typeof send>[0]): void;
}) {
  const [open, setOpen] = useState(false);
  const [harness, setHarness] = useState<IntegrationHarness>("claude");
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [given, setGiven] = useState("");
  const [scope, setScope] = useState<McpAdd["scope"]>("user");
  if (!open) {
    return (
      <button className="ghost int-add" onClick={() => setOpen(true)}>
        + Add a server
      </button>
    );
  }
  const words = splitCommand(line.trim());
  const add = () => {
    const server: McpAdd = {
      harness,
      name: name.trim(),
      scope: harness === "claude" && projectId ? scope : "user",
      transport: kind,
      ...(kind === "stdio"
        ? { command: words[0] ?? "", args: words.slice(1), env: pairs(given, "=") }
        : { url: line.trim(), ...(harness === "claude" ? { headers: pairs(given, ":") } : {}) }),
    };
    onAdd({ type: "mcp_add", add: server, ...(projectId ? { projectId } : {}) });
    setName("");
    setLine("");
    setGiven("");
  };
  return (
    <div className="int-form">
      <div className="int-form-row">
        <div className="seg">
          {(["claude", "codex"] as const).map((h) => (
            <button
              key={h}
              className={`seg-option ${harness === h ? "active" : ""}`}
              onClick={() => setHarness(h)}
            >
              {HARNESS[h]}
            </button>
          ))}
        </div>
        <div className="seg">
          <button
            className={`seg-option ${kind === "stdio" ? "active" : ""}`}
            onClick={() => setKind("stdio")}
          >
            a command
          </button>
          <button className={`seg-option ${kind === "http" ? "active" : ""}`} onClick={() => setKind("http")}>
            a URL
          </button>
        </div>
        {harness === "claude" && projectId && (
          <select value={scope} onChange={(e) => setScope(e.target.value as McpAdd["scope"])}>
            <option value="user">everywhere</option>
            <option value="local">in {projectName} — just you</option>
            <option value="project">in {projectName} — shared (.mcp.json)</option>
          </select>
        )}
      </div>
      <div className="vault-form">
        <input placeholder="name (sentry)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="int-line"
          placeholder={
            kind === "stdio" ? "command (npx -y @sentry/mcp-server)" : "https://mcp.example.com/mcp"
          }
          value={line}
          onChange={(e) => setLine(e.target.value)}
        />
      </div>
      {(kind === "stdio" || harness === "claude") && (
        <textarea
          className="int-given-box"
          rows={2}
          placeholder={
            kind === "stdio"
              ? "environment, one KEY=value a line (optional)"
              : "headers, one Name: value a line (optional)"
          }
          value={given}
          onChange={(e) => setGiven(e.target.value)}
        />
      )}
      <div className="int-form-row">
        <button className="ghost" disabled={busy || !name.trim() || !line.trim()} onClick={add}>
          Add
        </button>
        <button className="ghost" onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
    </div>
  );
}

/** What the marketplaces offer, searched — install from the list. */
function BrowsePlugins({
  busy,
  onAct,
  projectId,
}: {
  busy: boolean;
  onAct(message: Parameters<typeof send>[0]): void;
  projectId: string;
}) {
  const results = useRuri((s) => s.pluginsFound);
  const [open, setOpen] = useState(false);
  const [harness, setHarness] = useState<IntegrationHarness>("claude");
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => send({ type: "plugins_search", harness, query }), 220);
    return () => clearTimeout(timer);
  }, [open, harness, query]);
  if (!open) {
    return (
      <button className="ghost int-add" onClick={() => setOpen(true)}>
        + Browse plugins
      </button>
    );
  }
  const shown = results && results.harness === harness && results.query === query ? results : null;
  return (
    <div className="int-form">
      <div className="int-form-row">
        <div className="seg">
          {(["claude", "codex"] as const).map((h) => (
            <button
              key={h}
              className={`seg-option ${harness === h ? "active" : ""}`}
              onClick={() => setHarness(h)}
            >
              {HARNESS[h]}
            </button>
          ))}
        </div>
        <input
          className="int-search"
          autoFocus
          placeholder="search the marketplaces"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="ghost" onClick={() => setOpen(false)}>
          Done
        </button>
      </div>
      {!shown && <p className="settings-note">looking…</p>}
      {shown && (
        <p className="settings-note">
          {shown.total === 0
            ? "nothing matches"
            : shown.total > shown.plugins.length
              ? `${shown.plugins.length} of ${shown.total} — search to narrow it`
              : `${shown.total} to install`}
        </p>
      )}
      <div className="int-results">
        {shown?.plugins.map((plugin) => (
          <div key={plugin.id} className="int-row">
            <span className="int-body">
              <span className="int-name">
                {plugin.name}
                <span className="int-market"> · {plugin.marketplace}</span>
                {plugin.installCount ? (
                  <span className="int-market"> · {plugin.installCount.toLocaleString()} installs</span>
                ) : null}
              </span>
              {plugin.description && <span className="int-desc">{plugin.description}</span>}
            </span>
            <button
              className="ghost grant-ask"
              disabled={busy}
              onClick={() =>
                onAct({
                  type: "plugin_install",
                  harness: plugin.harness,
                  id: plugin.id,
                  ...(projectId ? { projectId } : {}),
                })
              }
            >
              Install
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddMarketplace({
  busy,
  onAct,
}: {
  busy: boolean;
  onAct(message: Parameters<typeof send>[0]): void;
}) {
  const [harness, setHarness] = useState<IntegrationHarness>("claude");
  const [source, setSource] = useState("");
  return (
    <div className="int-form-row int-market-add">
      <div className="seg">
        {(["claude", "codex"] as const).map((h) => (
          <button
            key={h}
            className={`seg-option ${harness === h ? "active" : ""}`}
            onClick={() => setHarness(h)}
          >
            {HARNESS[h]}
          </button>
        ))}
      </div>
      <input
        className="int-search"
        placeholder="owner/repo, a git URL, or a path"
        value={source}
        onChange={(e) => setSource(e.target.value)}
      />
      <button
        className="ghost"
        disabled={busy || !source.trim()}
        onClick={() => {
          onAct({ type: "marketplace_add", harness, source: source.trim() });
          setSource("");
        }}
      >
        Add
      </button>
    </div>
  );
}
