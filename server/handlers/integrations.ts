/**
 * Settings → Integrations: the harnesses' MCP servers, plugins and
 * marketplaces (server/integrations.ts), read for the window that asks
 * and changed through each CLI's own commands.
 *
 * A change reaches a chat when its harness next starts — MCP servers and
 * plugins are read once, at launch — so the warm sessions on the harness
 * that changed are retired as each goes idle, and the next prompt resumes
 * the conversation on a process that has the change.
 */
import type { IntegrationHarness, ServerMessage } from "../../shared/protocol.js";
import type { ClientConn, ServerContext } from "../context.js";
import {
  addMarketplace,
  addServer,
  installPlugin,
  readIntegrations,
  removeMarketplace,
  removeServer,
  searchPlugins,
  setPluginEnabled,
  uninstallPlugin,
  type ChangeResult,
} from "../integrations.js";
import { errorMessage } from "../log.js";
import type { Handlers } from "./types.js";

function reply(ws: ClientConn, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

/** The folder of the project a message names, for Claude's per-project
 *  scopes — any chat's id is taken for its project's too. */
function projectPath(ctx: ServerContext, projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  return ctx.store.get(projectId)?.path ?? ctx.store.findSession(projectId)?.project.path;
}

async function answer(ctx: ServerContext, ws: ClientConn, projectId: string | undefined): Promise<void> {
  const integrations = await readIntegrations(projectPath(ctx, projectId));
  reply(ws, { type: "integrations", ...(projectId ? { projectId } : {}), integrations });
}

/** A change, run; how it went said to the window that asked; the list
 *  read again for it; the harness's warm sessions retired when it took. */
function changed(
  ctx: ServerContext,
  ws: ClientConn,
  harness: IntegrationHarness,
  projectId: string | undefined,
  work: () => Promise<ChangeResult>,
): void {
  void (async () => {
    let result: ChangeResult;
    try {
      result = await work();
    } catch (err) {
      result = { ok: false, message: errorMessage(err) };
    }
    if (result.ok) {
      ctx.manager.retireHarness(harness);
      ctx.crewManager.retireHarness(harness);
    }
    reply(ws, { type: "integration_done", ok: result.ok, message: result.message });
    await answer(ctx, ws, projectId);
  })();
}

export const integrationHandlers = {
  integrations_get: (ctx, ws, msg) => {
    void answer(ctx, ws, msg.projectId).catch((err: unknown) =>
      reply(ws, { type: "integration_done", ok: false, message: errorMessage(err) }),
    );
  },
  plugins_search: (_ctx, ws, msg) => {
    void searchPlugins(msg.harness, msg.query)
      .then(({ plugins, total }) =>
        reply(ws, { type: "plugins_found", harness: msg.harness, query: msg.query, plugins, total }),
      )
      .catch((err: unknown) =>
        reply(ws, { type: "integration_done", ok: false, message: errorMessage(err) }),
      );
  },
  mcp_add: (ctx, ws, msg) => {
    changed(ctx, ws, msg.add.harness, msg.projectId, () =>
      addServer(msg.add, projectPath(ctx, msg.projectId)),
    );
  },
  mcp_remove: (ctx, ws, msg) => {
    changed(ctx, ws, msg.harness, msg.projectId, () =>
      removeServer(msg.harness, msg.name, msg.scope, projectPath(ctx, msg.projectId)),
    );
  },
  plugin_install: (ctx, ws, msg) => {
    changed(ctx, ws, msg.harness, msg.projectId, () =>
      installPlugin(msg.harness, msg.id, msg.scope, projectPath(ctx, msg.projectId)),
    );
  },
  plugin_uninstall: (ctx, ws, msg) => {
    changed(ctx, ws, msg.harness, undefined, () => uninstallPlugin(msg.harness, msg.id));
  },
  plugin_enable: (ctx, ws, msg) => {
    changed(ctx, ws, "claude", undefined, () => setPluginEnabled(msg.id, msg.enabled));
  },
  marketplace_add: (ctx, ws, msg) => {
    changed(ctx, ws, msg.harness, undefined, () => addMarketplace(msg.harness, msg.source));
  },
  marketplace_remove: (ctx, ws, msg) => {
    changed(ctx, ws, msg.harness, undefined, () => removeMarketplace(msg.harness, msg.name));
  },
} satisfies Partial<Handlers>;
