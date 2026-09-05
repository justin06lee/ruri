import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  type HomeSettings,
  type Project,
  type SessionInfo,
} from "../shared/protocol.js";

/** The settings a chat carries for itself: what SessionInfo holds beyond
 *  its id and title. */
export type SessionSettings = Pick<SessionInfo, "model" | "permissionMode" | "effort">;

const SETTING_KEYS = ["model", "permissionMode", "effort"] as const;

const DEFAULTS: Required<SessionSettings> = {
  model: DEFAULT_MODEL,
  permissionMode: DEFAULT_PERMISSION_MODE,
  effort: DEFAULT_EFFORT,
};

function configDir(): string {
  return process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri");
}

function projectsFile(): string {
  return path.join(configDir(), "projects.json");
}

export class ProjectStore {
  private projects: Project[] = [];
  private workspace: string | undefined;
  private music: string | undefined;
  private home: HomeSettings = {};
  // The out-of-the-box favourites; a saved list (even an empty one) wins.
  private starredModelIds: string[] = ["claude-fable-5[1m]", "codex:gpt-5.6-sol"];
  /** The double-starred small-tasks model; undefined = built-in default. */
  private smallModelId: string | undefined;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(projectsFile(), "utf8")) as {
        projects?: Project[];
        workspaceDir?: string;
        musicDir?: string;
        home?: HomeSettings;
        starredModels?: string[];
        smallModel?: string;
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
    } catch {
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

  /**
   * The star's three-state cycle: none → starred → small-tasks → none.
   * Only one model holds the small role; a newcomer demotes the old holder
   * back to plain starred.
   */
  cycleModelStar(model: string): { starred: string[]; small: string | undefined } {
    if (this.smallModelId === model) {
      this.smallModelId = undefined;
      this.starredModelIds = this.starredModelIds.filter((m) => m !== model);
    } else if (this.starredModelIds.includes(model)) {
      this.smallModelId = model;
    } else {
      this.starredModelIds = [...this.starredModelIds, model];
    }
    this.save();
    return { starred: this.starredModels(), small: this.smallModelId };
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

  findByPath(projectPath: string): Project | undefined {
    const resolved = path.resolve(
      projectPath.startsWith("~/") ? path.join(os.homedir(), projectPath.slice(2)) : projectPath,
    );
    return this.projects.find((p) => p.path === resolved);
  }

  list(): Project[] {
    return [...this.projects];
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  add(name: string, projectPath: string, folder?: string): Project {
    const resolved = path.resolve(
      projectPath.startsWith("~/") ? path.join(os.homedir(), projectPath.slice(2)) : projectPath,
    );
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`not a directory: ${resolved}`);
    }
    const project: Project = {
      id: randomUUID(),
      name: name.trim() || path.basename(resolved),
      path: resolved,
      ...(folder?.trim() ? { folder: folder.trim() } : {}),
      sessions: [{ id: randomUUID() }],
    };
    this.projects.push(project);
    this.save();
    return project;
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

  newSession(projectId: string): SessionInfo | undefined {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const session: SessionInfo = { id: randomUUID() };
    project.sessions.push(session);
    this.save();
    return session;
  }

  /** Remove a session; the project stays (an empty folder), even when it
   *  was the last one — only removing the project itself closes the folder. */
  removeSession(sessionId: string): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    found.project.sessions = found.project.sessions.filter((s) => s.id !== sessionId);
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
      const was = project[key] ?? DEFAULTS[key];
      for (const sibling of project.sessions) {
        if (sibling.id === sessionId || sibling[key] !== undefined) continue;
        (sibling as unknown as Record<string, unknown>)[key] = was;
      }
      (session as unknown as Record<string, unknown>)[key] = value || DEFAULTS[key];
      const record = project as unknown as Record<string, unknown>;
      if (value === undefined || value === "") delete record[key];
      else record[key] = value;
    }
    this.save();
  }

  /** What a chat runs on: its own picks over the project's defaults. */
  effectiveSettings(sessionId: string): Required<SessionSettings> | undefined {
    const found = this.findSession(sessionId);
    if (!found) return undefined;
    return {
      model: found.session.model || found.project.model || DEFAULTS.model,
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
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(
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
        },
        null,
        2,
      )}\n`,
    );
  }
}
