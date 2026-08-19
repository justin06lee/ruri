import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Project } from "../shared/protocol.js";

function configDir(): string {
  return process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri");
}

function projectsFile(): string {
  return path.join(configDir(), "projects.json");
}

export class ProjectStore {
  private projects: Project[] = [];

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(projectsFile(), "utf8")) as { projects?: Project[] };
      this.projects = (raw.projects ?? []).filter(
        (p) => typeof p?.id === "string" && typeof p?.name === "string" && typeof p?.path === "string",
      );
    } catch {
      // first run
    }
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
    };
    this.projects.push(project);
    this.save();
    return project;
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id);
    this.save();
  }

  private save(): void {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(projectsFile(), `${JSON.stringify({ projects: this.projects }, null, 2)}\n`);
  }
}
