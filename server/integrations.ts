import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findExecutable } from "@justin06lee/yagami";
import type {
  IntegrationHarness,
  Integrations,
  McpAdd,
  McpServerRow,
  PluginRow,
} from "../shared/protocol.js";

/**
 * What the harnesses plug in: MCP servers, plugins, and the marketplaces
 * plugins come from — for Claude Code and Codex, as their own CLIs keep
 * them.
 *
 * Reading never starts anything. `claude mcp list` health-checks every
 * server by starting it, so Claude's servers are read from the files the
 * CLI writes (~/.claude.json for the user and local scopes, a project's
 * .mcp.json for the shared one, and each plugin's own list); everything
 * else comes from the CLIs' JSON listings, which read config and nothing
 * more. Every change goes through the CLI's own command — `claude mcp
 * add-json`, `codex plugin add`, … — so ruri never writes a harness's
 * config format by hand, and a change looks exactly like one made in a
 * terminal.
 *
 * What a server is given to run with (environment values, headers) is
 * kept to its names here: the values stay in the harness's config and
 * never cross into the window.
 */

const LIST_TIMEOUT_MS = 20_000;
const CHANGE_TIMEOUT_MS = 3 * 60_000;

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd ?? os.homedir(),
        timeout: opts.timeoutMs ?? LIST_TIMEOUT_MS,
        env: { ...process.env, NO_COLOR: "1", CI: "1" },
        maxBuffer: 32 * 1024 * 1024,
      },
      (error, stdout, stderr) => resolve({ ok: !error, out: String(stdout), err: String(stderr) }),
    );
  });
}

function cli(harness: IntegrationHarness): string {
  const found = findExecutable(harness);
  if (!found) throw new Error(`${harness === "claude" ? "Claude Code" : "Codex"} isn't installed`);
  return found;
}

/** A CLI's JSON answer, or null when it gave none. */
async function json<T>(harness: IntegrationHarness, args: string[]): Promise<T | null> {
  const { ok, out } = await run(cli(harness), args);
  if (!ok) return null;
  // anything a CLI prints before its JSON (a notice, a warning) is not it
  const start = out.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(out.slice(start)) as T;
  } catch {
    return null;
  }
}

/** The first line of what a failed command said, for a person to read. */
function said(result: { out: string; err: string }): string {
  const text = `${result.err}\n${result.out}`;
  return (text.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, 240) || "it failed";
}

/* ── reading ────────────────────────────────────────────────────────── */

type Spec = Record<string, unknown>;

/** A server's config, as a row: how it is reached, and the names (only)
 *  of what it is given. */
function row(
  harness: IntegrationHarness,
  name: string,
  spec: Spec,
  scope: McpServerRow["scope"],
  extra: Partial<McpServerRow> = {},
): McpServerRow {
  const command = typeof spec["command"] === "string" ? spec["command"] : undefined;
  const args = Array.isArray(spec["args"]) ? spec["args"].map(String) : [];
  const url = typeof spec["url"] === "string" ? spec["url"] : undefined;
  const type = typeof spec["type"] === "string" ? spec["type"] : command ? "stdio" : "http";
  const env = spec["env"] && typeof spec["env"] === "object" ? Object.keys(spec["env"] as object) : [];
  const headers =
    spec["headers"] && typeof spec["headers"] === "object" ? Object.keys(spec["headers"] as object) : [];
  return {
    harness,
    name,
    scope,
    transport: type === "sse" || type === "ws" ? type : url ? "http" : "stdio",
    // an argument with a space in it is shown quoted, as it is kept
    target:
      url ??
      [command, ...args]
        .filter((word) => word !== undefined)
        .map(shown)
        .join(" "),
    ...(env.length ? { env } : {}),
    ...(headers.length ? { headers } : {}),
    enabled: true,
    ...extra,
  };
}

/** A word of a command line as it would be typed. */
function shown(word: string | undefined): string {
  if (!word) return '""';
  return /[\s"'\\]/.test(word) ? JSON.stringify(word) : word;
}

function claudeConfigFile(): string {
  const dir = process.env["CLAUDE_CONFIG_DIR"];
  return dir ? path.join(dir, ".claude.json") : path.join(os.homedir(), ".claude.json");
}

function readJson(file: string): Spec | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Spec;
  } catch {
    return null;
  }
}

function servers(block: unknown): Array<[string, Spec]> {
  if (!block || typeof block !== "object") return [];
  return Object.entries(block as Record<string, Spec>).filter(([, spec]) => spec && typeof spec === "object");
}

interface ClaudePlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  mcpServers?: Record<string, Spec>;
}

interface CodexPlugin {
  pluginId: string;
  name: string;
  marketplaceName: string;
  version?: string;
  installed?: boolean;
  enabled?: boolean;
}

interface CodexServer {
  name: string;
  enabled?: boolean;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  };
}

/**
 * Everything both harnesses have plugged in — for a project too, when one
 * is given: Claude's local and shared (.mcp.json) servers are per project.
 */
export async function readIntegrations(projectPath?: string): Promise<Integrations> {
  const errors: string[] = [];
  const found: Integrations = { servers: [], plugins: [], marketplaces: [], errors };
  const has = { claude: !!findExecutable("claude"), codex: !!findExecutable("codex") };

  if (has.claude) {
    const config = readJson(claudeConfigFile());
    for (const [name, spec] of servers(config?.["mcpServers"]))
      found.servers.push(row("claude", name, spec, "user"));
    if (projectPath) {
      // Claude files a project under its real path (/tmp is /private/tmp)
      let real = projectPath;
      try {
        real = fs.realpathSync(projectPath);
      } catch {
        // gone: its entry, if any, is under the path as given
      }
      const entries = config?.["projects"] as Record<string, Spec> | undefined;
      const local = (entries?.[real] ?? entries?.[projectPath])?.["mcpServers"];
      for (const [name, spec] of servers(local)) found.servers.push(row("claude", name, spec, "local"));
      const shared = readJson(path.join(projectPath, ".mcp.json"))?.["mcpServers"];
      for (const [name, spec] of servers(shared)) found.servers.push(row("claude", name, spec, "project"));
    }
  }

  const [claudePlugins, claudeMarkets, codexServers, codexPlugins, codexMarkets] = await Promise.all([
    has.claude
      ? json<ClaudePlugin[] | { installed?: ClaudePlugin[] }>("claude", ["plugin", "list", "--json"])
      : null,
    has.claude
      ? json<Array<{ name: string; source?: string; repo?: string; url?: string; path?: string }>>("claude", [
          "plugin",
          "marketplace",
          "list",
          "--json",
        ])
      : null,
    has.codex ? json<CodexServer[]>("codex", ["mcp", "list", "--json"]) : null,
    has.codex ? json<{ installed?: CodexPlugin[] }>("codex", ["plugin", "list", "--json"]) : null,
    has.codex
      ? json<{ marketplaces?: Array<{ name: string; marketplaceSource?: { source?: string } }> }>("codex", [
          "plugin",
          "marketplace",
          "list",
          "--json",
        ])
      : null,
  ]);

  if (has.claude && !claudePlugins) errors.push("Claude Code didn't list its plugins");
  // a bare list on its own, {installed, available} with --available
  const claudeInstalled = Array.isArray(claudePlugins) ? claudePlugins : (claudePlugins?.installed ?? []);
  for (const plugin of claudeInstalled) {
    const [name = plugin.id, marketplace = ""] = plugin.id.split("@");
    found.plugins.push({
      harness: "claude",
      id: plugin.id,
      name,
      marketplace,
      installed: true,
      enabled: plugin.enabled !== false,
      ...(plugin.version ? { version: plugin.version } : {}),
      ...(plugin.scope ? { scope: plugin.scope } : {}),
    });
    for (const [server, spec] of servers(plugin.mcpServers)) {
      found.servers.push(
        row("claude", server, spec, "plugin", { plugin: plugin.id, enabled: plugin.enabled !== false }),
      );
    }
  }
  for (const market of claudeMarkets ?? []) {
    found.marketplaces.push({
      harness: "claude",
      name: market.name,
      source: market.repo ?? market.url ?? market.path ?? market.source ?? "",
    });
  }

  if (has.codex && !codexServers) errors.push("Codex didn't list its MCP servers");
  for (const server of codexServers ?? []) {
    const t = server.transport ?? {};
    found.servers.push(
      row(
        "codex",
        server.name,
        {
          type: t.type === "streamable_http" ? "http" : t.type,
          command: t.command,
          args: t.args,
          env: t.env,
          url: t.url,
        },
        "codex",
        { enabled: server.enabled !== false },
      ),
    );
  }
  for (const plugin of codexPlugins?.installed ?? []) {
    found.plugins.push({
      harness: "codex",
      id: plugin.pluginId,
      name: plugin.name,
      marketplace: plugin.marketplaceName,
      installed: true,
      enabled: plugin.enabled !== false,
      ...(plugin.version ? { version: plugin.version } : {}),
    });
  }
  for (const market of codexMarkets?.marketplaces ?? []) {
    found.marketplaces.push({
      harness: "codex",
      name: market.name,
      source: market.marketplaceSource?.source ?? "",
    });
  }
  if (!has.claude && !has.codex) errors.push("neither Claude Code nor Codex is installed");
  return found;
}

/** Everything each harness's marketplaces offer, read once in a while —
 *  Codex's run to thousands, so a search reads this, not the CLI. */
const catalogs = new Map<IntegrationHarness, { at: number; plugins: PluginRow[] }>();
const CATALOG_FRESH_MS = 5 * 60_000;
const SHOWN = 60;

async function catalog(harness: IntegrationHarness): Promise<PluginRow[]> {
  const cached = catalogs.get(harness);
  if (cached && Date.now() - cached.at < CATALOG_FRESH_MS) return cached.plugins;
  let plugins: PluginRow[];
  if (harness === "claude") {
    const listed = await json<{
      available?: Array<{
        pluginId: string;
        name: string;
        description?: string;
        marketplaceName: string;
        installCount?: number;
      }>;
    }>("claude", ["plugin", "list", "--json", "--available"]);
    plugins = (listed?.available ?? []).map((p) => ({
      harness,
      id: p.pluginId,
      name: p.name,
      marketplace: p.marketplaceName,
      installed: false,
      ...(p.description ? { description: p.description } : {}),
      ...(p.installCount ? { installCount: p.installCount } : {}),
    }));
  } else {
    const listed = await json<{ available?: CodexPlugin[] }>("codex", [
      "plugin",
      "list",
      "--available",
      "--json",
    ]);
    plugins = (listed?.available ?? [])
      .filter((p) => !p.installed)
      .map((p) => ({
        harness,
        id: p.pluginId,
        name: p.name,
        marketplace: p.marketplaceName,
        installed: false,
        ...(p.version ? { version: p.version } : {}),
      }));
  }
  catalogs.set(harness, { at: Date.now(), plugins });
  return plugins;
}

/**
 * Plugins that could be installed, best match first: a name that starts
 * with the words, then one that has them, then a description that does;
 * the most installed first among equals. At most SHOWN of them.
 */
export async function searchPlugins(
  harness: IntegrationHarness,
  query: string,
): Promise<{ plugins: PluginRow[]; total: number }> {
  const all = await catalog(harness);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (p: PluginRow): number => {
    if (words.length === 0) return 1;
    const name = p.name.toLowerCase();
    const text = `${name} ${p.marketplace} ${p.description ?? ""}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) return 0;
    if (name.startsWith(words[0]!)) return 3;
    return words.every((w) => name.includes(w)) ? 2 : 1;
  };
  const matched = all
    .map((plugin) => ({ plugin, score: score(plugin) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || (b.plugin.installCount ?? 0) - (a.plugin.installCount ?? 0));
  return { plugins: matched.slice(0, SHOWN).map((m) => m.plugin), total: matched.length };
}

/* ── changing ───────────────────────────────────────────────────────── */

export interface ChangeResult {
  ok: boolean;
  message: string;
}

async function change(
  harness: IntegrationHarness,
  args: string[],
  done: string,
  cwd?: string,
): Promise<ChangeResult> {
  const result = await run(cli(harness), args, { timeoutMs: CHANGE_TIMEOUT_MS, ...(cwd ? { cwd } : {}) });
  catalogs.delete(harness);
  return result.ok ? { ok: true, message: done } : { ok: false, message: said(result) };
}

/** A valid server name, the way both CLIs take one. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Put a server in: for Claude in a scope (a project's for local and
 *  project), for Codex in its config. */
export async function addServer(add: McpAdd, projectPath?: string): Promise<ChangeResult> {
  if (!NAME.test(add.name))
    return { ok: false, message: "a name is letters, digits, dots, dashes and underscores" };
  const scoped = add.harness === "claude" && add.scope !== "user";
  if (scoped && !projectPath) return { ok: false, message: "pick the project it belongs to" };
  if (add.transport === "stdio" && !add.command?.trim())
    return { ok: false, message: "a command to run is needed" };
  if (add.transport !== "stdio" && !/^https?:\/\//.test(add.url ?? "")) {
    return { ok: false, message: "a server over HTTP needs its URL" };
  }
  const env = add.env ?? {};
  if (add.harness === "claude") {
    const spec =
      add.transport === "stdio"
        ? {
            type: "stdio",
            command: add.command!.trim(),
            args: add.args ?? [],
            ...(Object.keys(env).length ? { env } : {}),
          }
        : {
            type: add.transport,
            url: add.url!,
            ...(add.headers && Object.keys(add.headers).length ? { headers: add.headers } : {}),
          };
    return change(
      "claude",
      ["mcp", "add-json", add.name, JSON.stringify(spec), "-s", add.scope],
      `${add.name} added`,
      scoped ? projectPath : undefined,
    );
  }
  const args = ["mcp", "add", add.name];
  if (add.transport === "stdio") {
    for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
    args.push("--", add.command!.trim(), ...(add.args ?? []));
  } else {
    args.push("--url", add.url!);
  }
  return change("codex", args, `${add.name} added`);
}

export function removeServer(
  harness: IntegrationHarness,
  name: string,
  scope: McpServerRow["scope"],
  projectPath?: string,
): Promise<ChangeResult> {
  if (harness === "codex") return change("codex", ["mcp", "remove", name], `${name} removed`);
  const scoped = scope === "local" || scope === "project";
  return change(
    "claude",
    ["mcp", "remove", name, "-s", scope === "plugin" || scope === "codex" ? "user" : scope],
    `${name} removed`,
    scoped ? projectPath : undefined,
  );
}

/**
 * Install a plugin. Claude asks, as JSON, before running a command a
 * marketplace declares for the install; that is a thing to decide in a
 * terminal, where the command is shown in full, and it is said so here.
 */
export async function installPlugin(
  harness: IntegrationHarness,
  id: string,
  scope: "user" | "project" | "local" = "user",
  projectPath?: string,
): Promise<ChangeResult> {
  if (harness === "codex") return change("codex", ["plugin", "add", id], `${id} installed`);
  const scoped = scope !== "user";
  const result = await run(cli("claude"), ["plugin", "install", id, "-s", scope, "--json"], {
    timeoutMs: CHANGE_TIMEOUT_MS,
    ...(scoped && projectPath ? { cwd: projectPath } : {}),
  });
  catalogs.delete("claude");
  if (result.ok) return { ok: true, message: `${id} installed` };
  if (/shownCommand|accept-command/.test(result.out)) {
    return {
      ok: false,
      message: `${id} runs a command of its marketplace's to install — install it from a terminal, where the command is shown: claude plugin install ${id}`,
    };
  }
  return { ok: false, message: said(result) };
}

export function uninstallPlugin(harness: IntegrationHarness, id: string): Promise<ChangeResult> {
  return change(
    harness,
    harness === "claude" ? ["plugin", "uninstall", id] : ["plugin", "remove", id],
    `${id} removed`,
  );
}

export function setPluginEnabled(id: string, enabled: boolean): Promise<ChangeResult> {
  return change("claude", ["plugin", enabled ? "enable" : "disable", id], `${id} ${enabled ? "on" : "off"}`);
}

export function addMarketplace(harness: IntegrationHarness, source: string): Promise<ChangeResult> {
  return change(harness, ["plugin", "marketplace", "add", source.trim()], `marketplace added`);
}

export function removeMarketplace(harness: IntegrationHarness, name: string): Promise<ChangeResult> {
  return change(harness, ["plugin", "marketplace", "remove", name], `${name} removed`);
}
