/**
 * The projects and their sessions: opened, closed, renamed, starred and
 * hidden, a session added or removed, a terminal's chat brought in — and
 * the same moves as the Home agent makes them through its tools.
 */
import { removeLibrarySkill } from "../library.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocket } from "ws";
import { ideaDraftKey, type MemoryLine, type ServerMessage } from "../../shared/protocol.js";
import { briefless, pushSheet, rebuildCatchup, sheetMessage } from "../catchupBrief.js";
import { rebuildMemory } from "../memory.js";
import { addLine, dayOf, findLine, replaceLine } from "../memoryLines.js";
import { buildCompaction, removeTurnFiles } from "../compaction.js";
import type { ServerContext } from "../context.js";
import { titleSession } from "../dispatch.js";
import { findProjects } from "../finder.js";
import { errorMessage } from "../log.js";
import { HOME_ID, type ManagerHost } from "../manager.js";
import { expandPath } from "../projects.js";
import { importRecent, listRecent } from "../recent.js";
import { talkChatsClosed } from "./talk.js";
import type { Handlers } from "./types.js";

/** Tear down one project and everything its sessions accumulated. */
function closeProjectById(ctx: ServerContext, projectId: string): void {
  const closing = ctx.store.get(projectId);
  // messages between agents to and from its chats end with them
  talkChatsClosed(ctx, closing?.sessions.map((s) => s.id) ?? []);
  for (const sessionId of closing?.sessions.map((s) => s.id) ?? []) {
    if (closing?.path) void ctx.checkpoints.forgetChannel(closing, sessionId).catch(() => undefined);
    ctx.manager.dispose(sessionId);
    ctx.archive.remove(sessionId);
    ctx.clients.forgetChannel(sessionId);
    removeTurnFiles(sessionId);
    for (const key of ctx.crew.remove(sessionId)) ctx.crewManager.dispose(key);
    ctx.agentLogs.remove(sessionId);
    ctx.drafts.remove(sessionId);
    ctx.tracker.removeProject(sessionId);
    ctx.turns.contexts.delete(sessionId);
    ctx.turns.progress.delete(sessionId);
    ctx.turns.sent.delete(sessionId);
    ctx.retries.cancelRetry(sessionId);
    ctx.queues.entries.delete(sessionId);
    ctx.queues.held.delete(sessionId);
    ctx.terminals.closeChannel(sessionId);
    ctx.bridge.closeBridge(sessionId);
  }
  ctx.briefs.remove(projectId);
  ctx.ideas.removeProject(projectId);
  ctx.drafts.remove(ideaDraftKey(projectId));
  ctx.components.removeProject(projectId);
  removeLibrarySkill(projectId);
  ctx.ledger.removeProject(projectId);
  ctx.store.remove(projectId);
  ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
}

// What the Home agent's MCP tools may do to the app: open projects (and
// optionally kick their sessions off), close them again, and see what's open.
export function createManagerHost(ctx: ServerContext): ManagerHost {
  const host: ManagerHost = {
    openProject: ({ path: projectPath, name, folder, kickoffPrompt }) => {
      // a relative path is the workspace root's — Home's own working directory
      const dir = expandPath(projectPath, ctx.store.workspaceDir());
      // Home opens a project once. The same folder by another spelling of
      // its path (a symlink, another letter case) is the project already
      // open, and so is another folder answering to an open project's name —
      // a backup, a worktree, a second clone: the one open is the one meant.
      const atPath = ctx.store.findByPath(dir);
      const named = atPath ? undefined : ctx.store.findByName(name ?? "", path.basename(dir));
      let project = atPath ?? named;
      let opened = false;
      if (!project) {
        try {
          project = ctx.store.add(name ?? "", dir, folder);
          opened = true;
        } catch (err) {
          return `failed: ${errorMessage(err)}`;
        }
        ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
        // a project new to ruri gets told what it is before anyone asks
        if (briefless(ctx, project.id)) void rebuildCatchup(ctx, project.id);
      }
      let sessionId = project.sessions[0]?.id;
      // an emptied folder (all sessions closed) gets a fresh session on reopen
      if (!sessionId) {
        sessionId = ctx.store.newSession(project.id)?.id;
        ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      }
      if (kickoffPrompt && sessionId) {
        ctx.manager.send({ ...project, id: sessionId }, kickoffPrompt);
        // a session Home starts is named like one the user starts: from its
        // first prompt, now, not once the turn happens to finish
        titleSession(ctx, sessionId, kickoffPrompt);
      }
      return `${opened ? "opened" : "already open"}: ${project.name} (${project.path})${
        named ? ` — a project of that name is open, so ${dir} was not opened as another` : ""
      }${kickoffPrompt ? " — session started with the kickoff prompt" : ""}`;
    },
    newProject: (name) => {
      const clean = name.trim().replace(/\/+$/, "");
      if (!clean || clean.includes("/") || clean.startsWith(".")) return `not a folder name: "${name}"`;
      const dir = path.join(ctx.store.workspaceDir(), clean);
      const open = ctx.store.findByPath(dir) ?? ctx.store.findByName(clean);
      if (open) return `already open: ${open.name} (${open.path}) — nothing new made`;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return `failed: ${errorMessage(err)}`;
      }
      return host.openProject({ path: dir, name: clean }).replace(/^opened/, "created and opened");
    },
    hideProject: (query) => {
      const project = ctx.store.findByQuery(query);
      if (!project) return `no open project matches "${query}"`;
      if (project.hidden) return `already hidden: ${project.name}`;
      ctx.store.update(project.id, { hidden: true });
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      return `hidden: ${project.name} (${project.path}) — still open, tucked under "hidden" at the bottom of the sidebar`;
    },
    unhideProject: (query) => {
      const project = ctx.store.findByQuery(query);
      if (!project) return `no open project matches "${query}"`;
      if (!project.hidden) return `not hidden: ${project.name}`;
      ctx.store.update(project.id, { hidden: undefined });
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      return `unhidden: ${project.name} (${project.path})`;
    },
    closeProject: (query) => {
      const project = ctx.store.findByQuery(query);
      if (!project) return `no open project matches "${query}"`;
      closeProjectById(ctx, project.id);
      return `closed: ${project.name} (${project.path}) — files untouched`;
    },
    listProjects: () => ctx.store.list(),
    // only the workspace root from Settings — that is where projects live
    findProjects: (query) => findProjects([ctx.store.workspaceDir()], query),
  };
  return host;
}

export const projectHandlers = {
  add_project: (ctx, _ws, msg) => {
    if (ctx.store.findByPath(msg.path)) return;
    const project = ctx.store.add(msg.name, msg.path, msg.folder);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    if (briefless(ctx, project.id)) void rebuildCatchup(ctx, project.id);
  },
  catchup_rebuild: (ctx, _ws, msg) => {
    void rebuildCatchup(ctx, msg.projectId);
  },
  memory_rebuild: (ctx, _ws, msg) => {
    void rebuildMemory(ctx, msg.projectId);
  },
  /** The architecture page opening on a project. */
  sheet_get: (ctx, ws, msg) => {
    if (!ctx.store.get(msg.projectId)) return;
    void sheetMessage(ctx, msg.projectId)
      .then((message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      })
      .catch(() => {});
  },
  /** The user pinning a memory line, unpinning it, or striking it. */
  memory_line: (ctx, _ws, msg) => {
    const memory = ctx.briefs.get(msg.projectId).memory;
    const found = findLine(memory, msg.lineId);
    if (!memory || !found) return;
    const { pinned: _pinned, ...line } = found.line;
    const next =
      msg.action === "remove" ? undefined : msg.action === "pin" ? { ...line, pinned: true } : line;
    ctx.briefs.remember(msg.projectId, replaceLine(memory, found.line.id, next));
    pushSheet(ctx, msg.projectId);
  },
  /** The user's own line, or their correction of one — theirs, and pinned. */
  memory_write: (ctx, _ws, msg) => {
    if (!ctx.store.get(msg.projectId)) return;
    const memory = ctx.briefs.get(msg.projectId).memory;
    const text = msg.text.trim();
    const why = msg.why?.trim();
    if (msg.lineId) {
      const found = findLine(memory, msg.lineId);
      if (!memory || !found) return;
      const { why: _why, ...rest } = found.line;
      const next: MemoryLine = {
        ...rest,
        text,
        ...(why ? { why } : {}),
        date: dayOf(),
        by: "user",
        pinned: true,
      };
      ctx.briefs.remember(msg.projectId, replaceLine(memory, found.line.id, next));
    } else {
      const added = addLine(memory, msg.part, {
        text,
        ...(why ? { why } : {}),
        date: dayOf(),
        by: "user",
        pinned: true,
      });
      ctx.briefs.remember(msg.projectId, added.memory);
    }
    pushSheet(ctx, msg.projectId);
  },
  /** The user correcting a line of the shape, or striking it. */
  sheet_line: (ctx, _ws, msg) => {
    if (ctx.briefs.correct(msg.projectId, msg.section, msg.index, msg.text)) pushSheet(ctx, msg.projectId);
  },
  layer_line: (ctx, _ws, msg) => {
    if (ctx.briefs.correctLayer(msg.projectId, msg.slug, msg.section, msg.index, msg.text)) {
      pushSheet(ctx, msg.projectId);
    }
  },
  remove_project: (ctx, _ws, msg) => {
    closeProjectById(ctx, msg.projectId);
  },
  new_session: (ctx, _ws, msg) => {
    ctx.store.newSession(msg.projectId);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  },
  remove_session: (ctx, _ws, msg) => {
    const owner = ctx.store.findSession(msg.sessionId)?.project;
    talkChatsClosed(ctx, [msg.sessionId]);
    if (owner?.path) void ctx.checkpoints.forgetChannel(owner, msg.sessionId).catch(() => undefined);
    ctx.manager.dispose(msg.sessionId);
    ctx.archive.remove(msg.sessionId);
    ctx.clients.forgetChannel(msg.sessionId);
    removeTurnFiles(msg.sessionId);
    for (const key of ctx.crew.remove(msg.sessionId)) ctx.crewManager.dispose(key);
    ctx.agentLogs.remove(msg.sessionId);
    ctx.drafts.remove(msg.sessionId);
    ctx.tracker.removeProject(msg.sessionId);
    ctx.turns.contexts.delete(msg.sessionId);
    ctx.turns.progress.delete(msg.sessionId);
    ctx.turns.sent.delete(msg.sessionId);
    ctx.retries.cancelRetry(msg.sessionId);
    ctx.bridge.closeBridge(msg.sessionId);
    ctx.store.removeSession(msg.sessionId);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  },
  toggle_star: (ctx, _ws, msg) => {
    const project = ctx.store.get(msg.projectId);
    if (project) {
      ctx.store.update(msg.projectId, { starred: project.starred ? undefined : true });
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    }
  },
  toggle_hidden: (ctx, _ws, msg) => {
    const project = ctx.store.get(msg.projectId);
    if (project) {
      ctx.store.update(msg.projectId, { hidden: project.hidden ? undefined : true });
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    }
  },
  rename_project: (ctx, _ws, msg) => {
    const name = msg.name.trim();
    if (name && ctx.store.update(msg.projectId, { name })) {
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    }
  },
  rename_session: (ctx, _ws, msg) => {
    const title = msg.title.trim();
    if (title && ctx.store.findSession(msg.sessionId)) {
      ctx.store.setSessionTitle(msg.sessionId, title);
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    }
  },
  recent_list: (ctx, ws, msg) => {
    // what the harnesses hold for this project that ruri did not make:
    // every id ruri's own chats have ever run on is left out
    const project = ctx.store.get(msg.projectId);
    if (!project) return;
    const taken = ctx.archive.ownedSessionIds([...ctx.store.sessionIds(), HOME_ID]);
    void listRecent(project, taken)
      .then((items) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "recent", projectId: project.id, items } satisfies ServerMessage));
        }
      })
      .catch(() => {});
  },
  recent_import: (ctx, ws, msg) => {
    // A chat that happened in a terminal becomes a chat here: a new
    // session holding its conversation. The next prompt resumes the
    // real thing when the project runs on the harness it ran on;
    // otherwise it continues from a brief of it, the way a rewind
    // across harnesses does.
    const project = ctx.store.get(msg.projectId);
    if (!project) throw new Error("unknown project");
    const imported = importRecent(project, msg.id);
    if (!imported) throw new Error("that session's file is gone");
    const fresh = ctx.store.newSession(project.id);
    if (!fresh) throw new Error("unknown project");
    ctx.archive.seed(fresh.id, { events: imported.events, summaries: {}, chain: {} });
    const providerId = ctx.models.registry.parse(project.model).providerId;
    const sameHarness =
      imported.provider === "claude" ? providerId === undefined : providerId === imported.provider;
    if (sameHarness) ctx.archive.setLastSessionId(fresh.id, imported.resume);
    else {
      const built = buildCompaction(fresh.id, imported.events, {});
      if (built) ctx.archive.setPendingBrief(fresh.id, built.brief);
    }
    const firstPrompt = imported.events.find((e) => e.kind === "user");
    if (firstPrompt && firstPrompt.kind === "user") titleSession(ctx, fresh.id, firstPrompt.text);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    ctx.clients.broadcast({
      type: "transcript",
      projectId: fresh.id,
      events: ctx.readable.allowArchived({ [fresh.id]: ctx.archive.events(fresh.id) })[fresh.id] ?? [],
      summaries: {},
    });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "open_session", projectId: fresh.id } satisfies ServerMessage));
      if (!sameHarness) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: `brought the ${imported.provider === "claude" ? "Claude" : "Codex"} chat in — this project runs on a different harness, so the next prompt continues from a brief of it rather than resuming it`,
          } satisfies ServerMessage),
        );
      }
    }
  },
} satisfies Partial<Handlers>;
