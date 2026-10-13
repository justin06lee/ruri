import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeTextAtomic } from "./atomic.js";
import { configDir } from "./configDir.js";
import { isMissing, warn } from "./log.js";
import {
  DEFAULT_EFFORT,
  DEFAULT_MEMORY_MODEL,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  type HomeSettings,
  leadOf,
  type ModelRole,
  type Project,
  type SessionInfo,
} from "../shared/protocol.js";

/** Who holds each model role, and which models are starred. */
export interface ModelRoles {
  starred: string[];
  small: string | undefined;
  default: string | undefined;
  memory: string;
}

/** The settings a chat carries for itself: what SessionInfo holds beyond
 *  its id and title. */
export type SessionSettings = Pick<SessionInfo, "model" | "permissionMode" | "effort">;

const SETTING_KEYS = ["model", "permissionMode", "effort"] as const;

/** The built-in fallbacks. The model's is only the floor: the store's
 *  defaultModel() is what an unset model actually means. */
const DEFAULTS: Required<SessionSettings> = {
  model: DEFAULT_MODEL,
  permissionMode: DEFAULT_PERMISSION_MODE,
  effort: DEFAULT_EFFORT,
};

/** What a lead is called where other agents read it ("ruri · Lead"). */
export const LEAD_TITLE = "Lead";

function projectsFile(): string {
  return path.join(configDir(), "projects.json");
}

/** A folder path as typed: `~/` expanded, and taken from `base` when it is
 *  relative (from wherever the server was started, without one). */
export function expandPath(p: string, base?: string): string {
  const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  return base ? path.resolve(base, expanded) : path.resolve(expanded);
}

/** The one spelling of a folder: symlinks followed, and the letter case the
 *  disk has — `~/Workspace/ruri` and `/Volumes/…/Workspace/RURI` are the
 *  same folder. A path that isn't there is its own spelling. */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export class ProjectStore {
  private projects: Project[] = [];
  private workspace: string | undefined;
  private music: string | undefined;
  private home: HomeSettings = {};
  // The out-of-the-box favourites; a saved list (even an empty one) wins.
  private starredModelIds: string[] = [DEFAULT_MODEL, "codex:gpt-5.6-luna"];
  /** The small-tasks model; fresh installs start on GPT Luna. */
  private smallModelId: string | undefined = "codex:gpt-5.6-luna";
  /** The triple-starred model new chats start on; undefined = DEFAULT_MODEL. */
  private defaultModelId: string | undefined;
  /** The model that keeps the memory; undefined = DEFAULT_MEMORY_MODEL. */
  private memoryModelId: string | undefined;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(projectsFile(), "utf8")) as {
        projects?: Project[];
        workspaceDir?: string;
        musicDir?: string;
        home?: HomeSettings;
        starredModels?: string[];
        smallModel?: string;
        defaultModel?: string;
        memoryModel?: string;
      };
      this.projects = (raw.projects ?? []).filter(
        (p) => typeof p?.id === "string" && typeof p?.name === "string" && typeof p?.path === "string",
      );
      // migration: pre-session projects get one session whose id equals the
      // project id, so their archives/transcripts keep working untouched.
      // An empty array is NOT migrated — that's a deliberately empty folder.
      for (const project of this.projects) {
        if (!Array.isArray(project.sessions)) {
          project.sessions = [{ id: project.id }];
        }
      }
      if (typeof raw.workspaceDir === "string") this.workspace = raw.workspaceDir;
      if (typeof raw.musicDir === "string") this.music = raw.musicDir;
      if (raw.home && typeof raw.home === "object") this.home = raw.home;
      if (Array.isArray(raw.starredModels)) {
        this.starredModelIds = raw.starredModels.filter((m) => typeof m === "string");
      }
      if (typeof raw.smallModel === "string" && raw.smallModel) this.smallModelId = raw.smallModel;
      if (typeof raw.defaultModel === "string" && raw.defaultModel) this.defaultModelId = raw.defaultModel;
      if (typeof raw.memoryModel === "string" && raw.memoryModel) this.memoryModelId = raw.memoryModel;
    } catch (err) {
      if (!isMissing(err)) warn("projects", err, "new ProjectStore");
      // first run
    }
  }

  /** The workspace root the Home agent manages. Defaults to ~/Workspace when it exists. */
  workspaceDir(): string {
    if (this.workspace) return this.workspace;
    const conventional = path.join(os.homedir(), "Workspace");
    return fs.existsSync(conventional) ? conventional : os.homedir();
  }

  setWorkspaceDir(dir: string): void {
    const resolved = path.resolve(dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`not a directory: ${resolved}`);
    }
    this.workspace = resolved;
    this.save();
  }

  /** The user's chosen music library root; undefined = the built-in default. */
  customMusicDir(): string | undefined {
    return this.music;
  }

  setMusicDir(dir: string): void {
    const resolved = path.resolve(dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(2)) : dir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`not a directory: ${resolved}`);
    }
    this.music = resolved;
    this.save();
  }

  /** Starred model ids — the composer picker shows only these. */
  starredModels(): string[] {
    return [...this.starredModelIds];
  }

  /** The model the small-tasks layer runs on, when the user picked one. */
  smallModel(): string | undefined {
    return this.smallModelId;
  }

  /** The model that keeps the memory: the user's pick, else Sonnet. */
  memoryModel(): string {
    return this.memoryModelId ?? DEFAULT_MEMORY_MODEL;
  }

  /** What an unset model means: the crowned default, else the built-in. */
  defaultModel(): string {
    return this.defaultModelId ?? DEFAULT_MODEL;
  }

  /**
   * Crown a model the default. Nothing that exists moves: every project
   * (and Home) that was riding the old default is pinned to it first, so
   * only chats and projects made from here on start on the new one.
   */
  setDefaultModel(model: string | undefined): void {
    const was = this.defaultModel();
    const next = model || undefined;
    if ((next ?? DEFAULT_MODEL) === was) {
      this.defaultModelId = next;
      this.save();
      return;
    }
    for (const project of this.projects) if (!project.model) project.model = was;
    if (!this.home.model) this.home.model = was;
    this.defaultModelId = next;
    this.save();
  }

  /** The roles as they stand. */
  modelRoles(): ModelRoles {
    return {
      starred: this.starredModels(),
      small: this.smallModelId,
      default: this.defaultModelId,
      memory: this.memoryModel(),
    };
  }

  /**
   * The star is a favourite, nothing more: starred or not. Roles (small-tasks,
   * default) are handed over by dragging their tags onto another model — and
   * a model holding one keeps its star. Unstarring it used to release the
   * role, which took the tag off the page with nowhere left to drag it back
   * from; the tag goes to another model first.
   */
  cycleModelStar(model: string): ModelRoles {
    if (this.starredModelIds.includes(model)) {
      if (this.smallModelId === model || this.defaultModel() === model || this.memoryModel() === model) {
        return this.modelRoles();
      }
      this.starredModelIds = this.starredModelIds.filter((m) => m !== model);
    } else {
      this.starredModelIds = [...this.starredModelIds, model];
    }
    this.save();
    return this.modelRoles();
  }

  /**
   * Stars and roles on a Claude model's "[1m]" id, moved to the plain id the
   * CLI lists instead. The CLI stopped listing the "[1m]" ones when the plain
   * models got the million-token window themselves (`opus` reports
   * 1,000,000, as `opus[1m]` does), and a star or a tag left on the old id
   * sat on a row of its own under a name worked out from the id. Chats on
   * one are left as they are: the CLI still takes it. True when anything
   * moved.
   */
  foldListedModels(listed: ReadonlySet<string>): boolean {
    const fold = (id: string): string => {
      if (id.includes(":") || !id.endsWith("[1m]") || listed.has(id)) return id;
      const plain = id.slice(0, -"[1m]".length);
      return listed.has(plain) ? plain : id;
    };
    const starred = [...new Set(this.starredModelIds.map(fold))];
    const small = this.smallModelId && fold(this.smallModelId);
    const crowned = this.defaultModelId && fold(this.defaultModelId);
    const keeper = this.memoryModelId && fold(this.memoryModelId);
    if (
      starred.join("\n") === this.starredModelIds.join("\n") &&
      small === this.smallModelId &&
      crowned === this.defaultModelId &&
      keeper === this.memoryModelId
    ) {
      return false;
    }
    this.starredModelIds = starred;
    this.smallModelId = small;
    this.memoryModelId = keeper;
    // not setDefaultModel: nothing riding the default needs pinning to the
    // old id, which is the same model
    this.defaultModelId = crowned;
    this.save();
    return true;
  }

  /** Hand a role to a model outright: starred if it wasn't, and the role's
   *  previous holder simply stops holding it. */
  assignModelRole(model: string, role: ModelRole): ModelRoles {
    if (!this.starredModelIds.includes(model)) this.starredModelIds = [...this.starredModelIds, model];
    if (role === "small") this.smallModelId = model;
    else if (role === "memory") this.memoryModelId = model;
    else this.setDefaultModel(model);
    this.save();
    return this.modelRoles();
  }

  homeSettings(): HomeSettings {
    return { ...this.home };
  }

  /** Patch the Home agent's settings; "" clears a field back to the default. */
  setHomeSettings(patch: HomeSettings): void {
    const record = this.home as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") delete record[key];
      else record[key] = value;
    }
    this.save();
  }

  /** The open project in that folder, however its path is spelled. */
  findByPath(projectPath: string): Project | undefined {
    const resolved = expandPath(projectPath);
    const real = canonical(resolved);
    return this.projects.find((p) => p.path === resolved || canonical(p.path) === real);
  }

  /** The open project that already answers to any of these names — as its
   *  display name or its folder's, case-insensitive. */
  findByName(...names: string[]): Project | undefined {
    const wanted = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
    return this.projects.find(
      (p) => wanted.has(p.name.toLowerCase()) || wanted.has(path.basename(p.path).toLowerCase()),
    );
  }

  list(): Project[] {
    return [...this.projects];
  }

  /** The open project a person (or the Home agent) means by a name: an id,
   *  a path, the display name, or the folder's own name — case-insensitive. */
  findByQuery(query: string): Project | undefined {
    const q = query.trim().replace(/\/+$/, "");
    if (!q) return undefined;
    const lower = q.toLowerCase();
    const resolved = path.resolve(q.startsWith("~/") ? path.join(os.homedir(), q.slice(2)) : q);
    return (
      this.projects.find((p) => p.id === q || p.path.replace(/\/+$/, "") === q || p.path === resolved) ??
      this.projects.find((p) => p.name.toLowerCase() === lower) ??
      this.projects.find((p) => path.basename(p.path).toLowerCase() === lower)
    );
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  add(name: string, projectPath: string, folder?: string): Project {
    const resolved = expandPath(projectPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`not a directory: ${resolved}`);
    }
    const project: Project = {
      id: randomUUID(),
      name: name.trim() || path.basename(resolved),
      path: resolved,
      ...(folder?.trim() ? { folder: folder.trim() } : {}),
      sessions: [{ id: randomUUID(), title: LEAD_TITLE, lead: true }],
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  /**
   * Every project as a team (server/team.ts): one lead, first, that the
   * user talks to, and every other chat a member of its team. Run once at
   * launch; a project already a team only has its lead put back first.
   *
   * A project with one chat makes that chat its lead, history and all. One
   * with several gets a new lead, and the chats it had become its members —
   * each keeping its conversation, named what it was called, with that
   * name as its duty until the lead says otherwise. A chat with no name
   * and nothing in it (`empty`) was never used, and goes. True when
   * anything changed.
   */
  formTeams(empty: (sessionId: string) => boolean): boolean {
    let changed = false;
    for (const project of this.projects) {
      const marked = project.sessions.find((session) => session.lead);
      if (marked) {
        if (project.sessions[0] !== marked) {
          project.sessions = [marked, ...project.sessions.filter((session) => session !== marked)];
          changed = true;
        }
        continue;
      }
      changed = true;
      const used = project.sessions.filter((session) => session.title || !empty(session.id));
      if (used.length <= 1) {
        const lead = used[0] ?? project.sessions[0] ?? { id: randomUUID() };
        lead.lead = true;
        lead.title = LEAD_TITLE;
        project.sessions = [lead];
        continue;
      }
      for (const member of used) member.duty ??= member.title ?? "general work in this project";
      project.sessions = [{ id: randomUUID(), title: LEAD_TITLE, lead: true }, ...used];
    }
    if (changed) this.save();
    return changed;
  }

  /** A project's lead, the session marked so (else its first). */
  lead(projectId: string): SessionInfo | undefined {
    const project = this.get(projectId);
    return project ? leadOf(project) : undefined;
  }

  /** Whether a chat is a member of its project's team, not its lead. */
  isMember(sessionId: string): boolean {
    const found = this.findSession(sessionId);
    return !!found && leadOf(found.project)?.id !== sessionId;
  }

  /** A new member of a project's team, named and given its duty. */
  addMember(
    projectId: string,
    member: { name: string; duty: string; layers?: string[]; model?: string },
  ): SessionInfo | undefined {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const session: SessionInfo = {
      id: randomUUID(),
      title: member.name,
      duty: member.duty,
      ...(member.layers?.length ? { layers: member.layers } : {}),
      ...(member.model ? { model: member.model } : {}),
    };
    project.sessions.push(session);
    this.save();
    return session;
  }

  /** A member's name, duty or layers changed. "" layers clears them. */
  setMember(sessionId: string, patch: { name?: string; duty?: string; layers?: string[] }): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    if (patch.name) found.session.title = patch.name;
    if (patch.duty) found.session.duty = patch.duty;
    if (patch.layers) {
      if (patch.layers.length) found.session.layers = patch.layers;
      else delete found.session.layers;
    }
    this.save();
  }

  /** Patch a project's settings (model, permission mode, …) and persist. */
  update(id: string, patch: Partial<Omit<Project, "id" | "path">>): Project | undefined {
    const project = this.projects.find((p) => p.id === id);
    if (!project) return undefined;
    const record = project as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === "") delete record[key];
      else record[key] = value;
    }
    this.save();
    return project;
  }

  /** The project that owns a session id, plus the session itself. */
  findSession(sessionId: string): { project: Project; session: SessionInfo } | undefined {
    for (const project of this.projects) {
      const session = project.sessions.find((s) => s.id === sessionId);
      if (session) return { project, session };
    }
    return undefined;
  }

  /** A new chat in a project: its lead when it has none (an emptied
   *  folder), else a member of its team — the sidebar shows only the lead. */
  newSession(projectId: string, duty?: string): SessionInfo | undefined {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const session: SessionInfo =
      project.sessions.length === 0
        ? { id: randomUUID(), title: LEAD_TITLE, lead: true }
        : { id: randomUUID(), ...(duty ? { duty } : {}) };
    project.sessions.push(session);
    this.save();
    return session;
  }

  /** Remove a session; the project stays (an empty folder), even when it
   *  was the last one — only removing the project itself closes the folder.
   *  A lead removed hands the lead to the first member left. */
  removeSession(sessionId: string): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    found.project.sessions = found.project.sessions.filter((s) => s.id !== sessionId);
    const next = found.project.sessions[0];
    if (found.session.lead && next) {
      next.lead = true;
      next.title = LEAD_TITLE;
      delete next.duty;
      delete next.layers;
    }
    this.save();
  }

  /**
   * A chat picks its own model, effort or mode.
   *
   * The pick lands on the session, and becomes the project's default so the
   * next new chat starts on it — but a sibling that was riding the old
   * default must not move with it: any sibling without its own value is
   * first pinned to what it was effectively running on. "" clears a field
   * back to the built-in default (pinned, not inherited, for the same reason).
   */
  setSessionSettings(sessionId: string, patch: SessionSettings): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    const { project, session } = found;
    for (const key of SETTING_KEYS) {
      if (!(key in patch)) continue;
      const value = patch[key];
      const was = project[key] ?? (key === "model" ? this.defaultModel() : DEFAULTS[key]);
      for (const sibling of project.sessions) {
        if (sibling.id === sessionId || sibling[key] !== undefined) continue;
        (sibling as unknown as Record<string, unknown>)[key] = was;
      }
      (session as unknown as Record<string, unknown>)[key] =
        value || (key === "model" ? this.defaultModel() : DEFAULTS[key]);
      const record = project as unknown as Record<string, unknown>;
      if (value === undefined || value === "") delete record[key];
      else record[key] = value;
    }
    this.save();
  }

  /** One chat's own model, and nothing else: the project's default and its
   *  other chats stay as they are — for a chat another agent started on a
   *  model of its choosing (server/handlers/talk.ts startChat). */
  setSessionModel(sessionId: string, model: string): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    found.session.model = model;
    this.save();
  }

  /** What a chat runs on: its own picks over the project's defaults. */
  effectiveSettings(sessionId: string): Required<SessionSettings> | undefined {
    const found = this.findSession(sessionId);
    if (!found) return undefined;
    return {
      model: found.session.model || found.project.model || this.defaultModel(),
      permissionMode: found.session.permissionMode ?? found.project.permissionMode ?? DEFAULTS.permissionMode,
      effort: found.session.effort || found.project.effort || DEFAULTS.effort,
    };
  }

  /** Copy one chat's effective settings onto another — a fork keeps what it
   *  forked from, whatever the project's default has become since. */
  copySessionSettings(fromId: string, toId: string): void {
    const settings = this.effectiveSettings(fromId);
    const target = this.findSession(toId)?.session;
    if (!settings || !target) return;
    Object.assign(target, settings);
    this.save();
  }

  setSessionTitle(sessionId: string, title: string): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    found.session.title = title;
    this.save();
  }

  /** Every session id across every project. */
  sessionIds(): string[] {
    return this.projects.flatMap((p) => p.sessions.map((s) => s.id));
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id);
    this.save();
  }

  private save(): void {
    writeTextAtomic(
      projectsFile(),
      `${JSON.stringify(
        {
          projects: this.projects,
          ...(this.workspace ? { workspaceDir: this.workspace } : {}),
          ...(this.music ? { musicDir: this.music } : {}),
          ...(Object.keys(this.home).length ? { home: this.home } : {}),
          // always written, so "deliberately none" survives restarts
          starredModels: this.starredModelIds,
          ...(this.smallModelId ? { smallModel: this.smallModelId } : {}),
          ...(this.defaultModelId ? { defaultModel: this.defaultModelId } : {}),
          ...(this.memoryModelId ? { memoryModel: this.memoryModelId } : {}),
        },
        null,
        2,
      )}\n`,
    );
  }
}
