import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Project, SessionInfo } from "../shared/protocol.js";

function configDir(): string {
  return process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri");
}

function projectsFile(): string {
  return path.join(configDir(), "projects.json");
}

export class ProjectStore {
  private projects: Project[] = [];
  private workspace: string | undefined;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(projectsFile(), "utf8")) as {
        projects?: Project[];
        workspaceDir?: string;
      };
      this.projects = (raw.projects ?? []).filter(
        (p) => typeof p?.id === "string" && typeof p?.name === "string" && typeof p?.path === "string",
      );
      // migration: pre-session projects get one session whose id equals the
      // project id, so their archives/transcripts keep working untouched
      for (const project of this.projects) {
        if (!Array.isArray(project.sessions) || project.sessions.length === 0) {
          project.sessions = [{ id: project.id }];
        }
      }
      if (typeof raw.workspaceDir === "string") this.workspace = raw.workspaceDir;
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

  /** Remove a session; removing the last one removes the project too. */
  removeSession(sessionId: string): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    found.project.sessions = found.project.sessions.filter((s) => s.id !== sessionId);
    if (found.project.sessions.length === 0) {
      this.projects = this.projects.filter((p) => p.id !== found.project.id);
    }
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
        { projects: this.projects, ...(this.workspace ? { workspaceDir: this.workspace } : {}) },
        null,
        2,
      )}\n`,
    );
  }
}
