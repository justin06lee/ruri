/**
 * Skills and slash commands: the skills page's list, toggles and bodies,
 * bmo's installs, and the composer's command menu (server/skills.ts and
 * server/commands.ts do the work).
 */
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { listCommands } from "../commands.js";
import type { ClientConn, ServerContext } from "../context.js";
import { installSkill, listSkills, readSkill, removeSkill, scanSkills, toggleSkill, updateSkills } from "../skills.js";
import type { Handlers } from "./types.js";

/** Re-scan skills for a project (or just the global ones) and push. */
export function pushSkills(ctx: ServerContext, projectId?: string, note?: string): void {
  const dir = projectId ? ctx.store.get(projectId)?.path : undefined;
  void scanSkills(dir).then((skills) =>
    ctx.clients.broadcast({
      type: "skills",
      ...(projectId ? { projectId } : {}),
      skills,
      ...(note ? { note } : {}),
    }),
  );
}

/** bmo's three: install, remove, update — the page says so while it works. */
function skillWork(
  ctx: ServerContext,
  _ws: ClientConn,
  msg: Extract<ClientMessage, { type: "skill_install" | "skill_remove" | "skill_update" }>,
): void {
  const dir = msg.projectId ? ctx.store.get(msg.projectId)?.path : undefined;
  // bmo clones and copies — long enough that the page says so (the
  // list as the filesystem has it; bmo's own notes come with the push
  // when the work is done)
  ctx.clients.broadcast({
    type: "skills",
    ...(msg.projectId ? { projectId: msg.projectId } : {}),
    skills: listSkills(dir),
    busy: true,
  });
  const work =
    msg.type === "skill_install"
      ? installSkill(msg.scope, dir, msg.source)
      : msg.type === "skill_remove"
        ? removeSkill(msg.scope, dir, msg.name)
        : updateSkills(dir);
  work
    .then((note) => pushSkills(ctx, msg.projectId, note.split("\n").slice(-3).join(" · ") || "done"))
    .catch((err: unknown) =>
      pushSkills(ctx, msg.projectId, String(err instanceof Error ? err.message : err).split("\n")[0]),
    );
}

export const skillHandlers = {
  skills_refresh: (ctx, _ws, msg) => {
    pushSkills(ctx, msg.projectId);
  },
  commands_refresh: (ctx, ws, msg) => {
    const dir = msg.projectId ? ctx.store.get(msg.projectId)?.path : undefined;
    // the asking socket only: this is a menu being opened, not news
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "commands",
          ...(msg.projectId ? { projectId: msg.projectId } : {}),
          commands: listCommands(dir),
        } satisfies ServerMessage),
      );
    }
  },
  skill_toggle: (ctx, _ws, msg) => {
    try {
      const note = toggleSkill(
        msg.scope,
        msg.projectId ? ctx.store.get(msg.projectId)?.path : undefined,
        msg.name,
        msg.on,
      );
      pushSkills(ctx, msg.projectId, note);
    } catch (err) {
      pushSkills(ctx, msg.projectId, String(err instanceof Error ? err.message : err));
    }
  },
  skill_read: (ctx, ws, msg) => {
    try {
      const body = readSkill(
        msg.scope,
        msg.projectId ? ctx.store.get(msg.projectId)?.path : undefined,
        msg.name,
      );
      ws.send(JSON.stringify({ type: "skill_body", name: msg.name, scope: msg.scope, body } satisfies ServerMessage));
    } catch (err) {
      ws.send(JSON.stringify({
        type: "skill_body",
        name: msg.name,
        scope: msg.scope,
        body: `_${String(err instanceof Error ? err.message : err)}_`,
      } satisfies ServerMessage));
    }
  },
  skill_install: skillWork,
  skill_remove: skillWork,
  skill_update: skillWork,
} satisfies Partial<Handlers>;
