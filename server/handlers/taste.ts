/**
 * Settings → Design taste (server/gusteau.ts): whether gusteau is on this
 * machine, and the "Learn from project" button, answered to the window
 * that asked.
 */
import type { ServerMessage } from "../../shared/protocol.js";
import type { ClientConn } from "../context.js";
import { findGusteau, learnFromProject } from "../gusteau.js";
import type { Handlers } from "./types.js";

function reply(ws: ClientConn, learned?: { ok: boolean; output: string }): void {
  const message: ServerMessage = { type: "taste", found: findGusteau(), ...(learned ? { learned } : {}) };
  ws.send(JSON.stringify(message));
}

export const tasteHandlers = {
  taste_get: (_ctx, ws) => reply(ws),
  taste_learn: (ctx, ws, msg) => {
    // a chat's id is taken for its project's
    const project = ctx.store.get(msg.projectId) ?? ctx.store.findSession(msg.projectId)?.project;
    if (!project?.path) return reply(ws, { ok: false, output: "That project isn't open." });
    void learnFromProject(project.path).then((learned) => reply(ws, learned));
  },
} satisfies Partial<Handlers>;
