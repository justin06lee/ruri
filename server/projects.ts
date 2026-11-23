import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeTextAtomic } from "./atomic.js";
import { configDir } from "./configDir.js";
import { foldName } from "./finder.js";
import { isMissing, warn } from "./log.js";
import { catalogDefault, newestInLine, relisted, supersededBy } from "../shared/modelLine.js";
import {
  addFolder,
  firstLayout,
  flatOrder,
  folderOf,
  moveInLayout,
  removeFolder,
  sameLayout,
  setFolder,
  type SidebarLayout,
  type SidebarPlace,
  tidyLayout,
} from "../shared/sidebar.js";
import {
  DEFAULT_EFFORT,
  HOME_ID,
  DEFAULT_MEMORY_MODEL,
  DEFAULT_PERMISSION_MODE,
  HARNESS_DEFAULT_MODEL,
  type AccountProvider,
  type HomeSettings,
  isEffort,
  leadOf,
  liaisonOf,
  type ModelChoice,
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

/** The built-in fallbacks. The model's and the effort's are only floors:
 *  the store's defaultModel() and defaultEffort() are what an unset one
 *  actually means. */
const DEFAULTS: Required<SessionSettings> = {
  model: HARNESS_DEFAULT_MODEL,
  permissionMode: DEFAULT_PERMISSION_MODE,
  effort: DEFAULT_EFFORT,
};

/** What a lead is called where other agents read it ("ruri · Lead"). */
export const LEAD_TITLE = "Lead";

/** And the liaison, the lead other projects' agents reach ("ruri · Liaison"). */
export const LIAISON_TITLE = "Liaison";

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
  /** Kept in the order the sidebar stands them (arrange), so everything
   *  that lists the projects — the board, the switcher, rapid fire, the
   *  phone — follows the sidebar without knowing of it. */
  private projects: Project[] = [];
  /** The sidebar's order and folders (shared/sidebar.ts). */
  private layout: SidebarLayout = { order: [], folders: [] };
  private workspace: string | undefined;
  private music: string | undefined;
  private home: HomeSettings = {};
  /** The user's favourites. None out of the box: no model is named here,
   *  and a picker with nothing starred shows the whole catalog. */
  private starredModelIds: string[] = [];
  /** The small-tasks model, when the user has handed the role to one. */
  private smallModelId: string | undefined;
  /** The crowned model new chats start on; undefined = the catalog's own
   *  default (defaultModel). */
  private defaultModelId: string | undefined;
  /** The model that keeps the memory; undefined = DEFAULT_MEMORY_MODEL. */
  private memoryModelId: string | undefined;
  /** The effort new chats start at; undefined = DEFAULT_EFFORT. */
  private defaultEffortLevel: string | undefined;
  /** The catalog as the harnesses last reported it (setCatalog). */
  private catalog: ModelChoice[] = [];
  /** Every model id a catalog has ever listed here — how a model listed
   *  for the first time is told from one that was always there. Undefined
   *  until the first catalog is read. */
  private knownModels: string[] | undefined;
  /** The catalog's own default as last read, for the launches before the
   *  catalog is in. */
  private catalogModel: string | undefined;

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
        defaultEffort?: string;
        knownModels?: string[];
        catalogModel?: string;
        sidebar?: SidebarLayout;
      };
      this.projects = (raw.projects ?? []).filter(
        (p) => typeof p?.id === "string" && typeof p?.name === "string" && typeof p?.path === "string",
      );
      // migration: pre-session projects get one session whose id equals the
      // project id, so their archives/transcripts keep working untouched.
      // One left with none gets a lead at launch (formTeams).
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
      if (isEffort(raw.defaultEffort)) this.defaultEffortLevel = raw.defaultEffort;
      // A change of default used to pin every project riding the old one
      // to it (and Home): the built-in xhigh, on the project alone — a pick
      // in the composer lands on a chat as well. Those were never picks,
      // and go back to riding the default.
      for (const project of this.projects) {
        if (project.effort === DEFAULT_EFFORT && project.sessions.every((s) => !s.effort)) {
          delete project.effort;
        }
      }
      if (this.home.effort === DEFAULT_EFFORT && this.defaultEffortLevel) delete this.home.effort;
      if (Array.isArray(raw.knownModels))
        this.knownModels = raw.knownModels.filter((m) => typeof m === "string");
      if (typeof raw.catalogModel === "string" && raw.catalogModel) this.catalogModel = raw.catalogModel;
      // The sidebar's arrangement — or, the first time, the one it used to
      // draw: starred first, and a folder for each group label a project
      // was opened under, which was kept on the project and never shown.
      const labelled = this.projects as Array<Project & { folder?: string }>;
      this.layout =
        raw.sidebar && typeof raw.sidebar === "object"
          ? tidyLayout(
              raw.sidebar,
              this.projects.map((p) => p.id),
            )
          : firstLayout(labelled, randomUUID);
      for (const project of labelled) delete project.folder;
      this.arrange();
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

  /**
   * What an unset model means: the crowned default, else the one the
   * catalog itself starts a chat on (shared/modelLine.ts catalogDefault) —
   * as it stands now, as it stood at the last launch, or, on a first
   * launch with no catalog read yet, the harness's own alias for it.
   */
  defaultModel(): string {
    return this.defaultModelId ?? catalogDefault(this.catalog) ?? this.catalogModel ?? HARNESS_DEFAULT_MODEL;
  }

  /** What an unset effort means: the default chosen in Settings, else the
   *  built-in. */
  defaultEffort(): string {
    return this.defaultEffortLevel ?? DEFAULT_EFFORT;
  }

  /**
   * Choose the effort a chat runs at when nobody picked one for it. Every
   * chat riding the default rides it to the new one; a chat that picked
   * its effort keeps its pick. (Projects riding the old default used to be
   * pinned to it here, so a default of high left every project that
   * existed at xhigh, and each new chat in one started there.)
   */
  setDefaultEffort(effort: string): void {
    if (!isEffort(effort)) return;
    this.defaultEffortLevel = effort === DEFAULT_EFFORT ? undefined : effort;
    this.save();
  }

  /** The chats riding the default effort: no pick of their own, none on
   *  their project — Home among them, by its id. */
  ridingDefaultEffort(): string[] {
    return [
      ...(this.home.effort ? [] : [HOME_ID]),
      ...this.projects.flatMap((project) =>
        project.effort ? [] : project.sessions.filter((s) => !s.effort).map((s) => s.id),
      ),
    ];
  }

  /**
   * The harnesses' catalog, as it lands and each time it changes.
   *
   * A model listed for the first time that is the newest of its line — a
   * new Fable, a new GPT — takes over whatever stood on the one it
   * supersedes: its star, and the default, small-tasks and memory roles.
   * So the picker and the defaults keep to the newest version without
   * anyone retyping one. Only what stood on the line's newest moves: a
   * star left on an older model on purpose stays where it was put. Chats
   * riding the default ride it to the new one; a chat that picked its
   * model keeps its pick. True when a star or a role moved.
   */
  setCatalog(models: ModelChoice[]): boolean {
    this.catalog = models;
    if (models.length === 0) return false;
    const listed = models.map((m) => m.value);
    const own = catalogDefault(models);
    let dirty = own !== undefined && own !== this.catalogModel;
    if (own) this.catalogModel = own;
    let moved = false;
    if (this.knownModels === undefined) {
      // the first catalog this store has seen: all of it was always there
      this.knownModels = listed;
      dirty = true;
    } else {
      const known = new Set(this.knownModels);
      for (const arrival of listed) {
        if (known.has(arrival)) continue;
        dirty = true;
        const old = supersededBy(models, this.knownModels, arrival);
        if (!old) continue;
        if (this.starredModelIds.includes(old)) {
          this.starredModelIds = [...new Set(this.starredModelIds.map((id) => (id === old ? arrival : id)))];
          moved = true;
        }
        if (this.smallModelId === old) this.smallModelId = arrival;
        if (this.defaultModelId === old) this.defaultModelId = arrival;
        if (this.memoryModelId === old) this.memoryModelId = arrival;
        moved ||= [this.smallModelId, this.defaultModelId, this.memoryModelId].includes(arrival);
      }
      if (dirty) this.knownModels = [...new Set([...this.knownModels, ...listed])];
    }
    // a star or a role on an id the catalog has stopped listing follows the
    // same model to the id it is listed under now (shared/modelLine.ts
    // relisted): otherwise the catalog page shows it twice, one of them
    // offered nowhere
    const now = (id: string | undefined) => (id ? relisted(models, id) : undefined);
    if (this.starredModelIds.some((id) => now(id))) {
      this.starredModelIds = [...new Set(this.starredModelIds.map((id) => now(id) ?? id))];
      moved = true;
    }
    const small = now(this.smallModelId);
    const crowned = now(this.defaultModelId);
    const memory = now(this.memoryModelId);
    if (small) this.smallModelId = small;
    if (crowned) this.defaultModelId = crowned;
    if (memory) this.memoryModelId = memory;
    moved ||= Boolean(small || crowned || memory);
    if (dirty || moved) this.save();
    return moved;
  }

  /** The newest model the catalog lists in `id`'s line (`id` itself until
   *  a catalog is in). */
  latest(id: string): string {
    return newestInLine(this.catalog, id);
  }

  /**
   * Crown a model the default. Nothing that exists moves: every project
   * (and Home) that was riding the old default is pinned to it first, so
   * only chats and projects made from here on start on the new one.
   */
  setDefaultModel(model: string | undefined): void {
    const was = this.defaultModel();
    const next = model || undefined;
    this.defaultModelId = next;
    if (this.defaultModel() === was) {
      this.save();
      return;
    }
    for (const project of this.projects) if (!project.model) project.model = was;
    if (!this.home.model) this.home.model = was;
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
   *  display name or its folder's, whatever the case and however the
   *  characters are composed (foldName). */
  findByName(...names: string[]): Project | undefined {
    const wanted = new Set(names.map((n) => foldName(n.trim())).filter(Boolean));
    return this.projects.find(
      (p) => wanted.has(foldName(p.name)) || wanted.has(foldName(path.basename(p.path))),
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
    const folded = foldName(q);
    const resolved = path.resolve(q.startsWith("~/") ? path.join(os.homedir(), q.slice(2)) : q);
    return (
      this.projects.find((p) => p.id === q || p.path.replace(/\/+$/, "") === q || p.path === resolved) ??
      this.projects.find((p) => foldName(p.name) === folded) ??
      this.projects.find((p) => foldName(path.basename(p.path)) === folded)
    );
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** The sidebar's arrangement, as it stands. */
  sidebar(): SidebarLayout {
    return structuredClone(this.layout);
  }

  /** The name of the sidebar folder a project is in, if it is in one. */
  folderName(projectId: string): string | undefined {
    return folderOf(this.layout, projectId)?.name;
  }

  /** A project or a folder carried to another place in the sidebar. */
  moveInSidebar(id: string, place: SidebarPlace): void {
    this.lay(moveInLayout(this.layout, id, place));
  }

  /** A new sidebar folder — around a project, when one is named. */
  addFolder(folderId: string, name: string, projectId?: string): void {
    this.lay(addFolder(this.layout, { id: folderId, name }, projectId));
  }

  /** A folder renamed, or folded shut or opened. */
  setFolder(folderId: string, patch: { name?: string; collapsed?: boolean }): void {
    this.lay(setFolder(this.layout, folderId, patch));
  }

  /** A folder taken away; its projects stay where it stood. */
  removeFolder(folderId: string): void {
    this.lay(removeFolder(this.layout, folderId));
  }

  /** Take a new arrangement: tidied against the projects there are, and
   *  the projects stood in its order. */
  private lay(next: SidebarLayout): void {
    const tidy = tidyLayout(
      next,
      this.projects.map((p) => p.id),
    );
    if (sameLayout(tidy, this.layout)) return;
    this.layout = tidy;
    this.arrange();
    this.save();
  }

  /** The projects, stood in the sidebar's order. */
  private arrange(): void {
    const at = new Map(flatOrder(this.layout).map((id, i) => [id, i]));
    const last = this.projects.length;
    this.projects.sort((a, b) => (at.get(a.id) ?? last) - (at.get(b.id) ?? last));
  }

  /**
   * Open a folder on disk as a project. It joins the end of the sidebar —
   * or, given a group label (`folder`: Home's open_project can pass one),
   * the sidebar folder of that name, made when there is none yet.
   */
  add(name: string, projectPath: string, folder?: string): Project {
    const resolved = expandPath(projectPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`not a directory: ${resolved}`);
    }
    const project: Project = {
      id: randomUUID(),
      name: name.trim() || path.basename(resolved),
      path: resolved,
      sessions: [{ id: randomUUID(), title: LEAD_TITLE, lead: true }],
      // a new project's teammates are workers from the start
      workers: true,
    };
    this.projects.push(project);
    let layout = tidyLayout(
      this.layout,
      this.projects.map((p) => p.id),
    );
    const label = folder?.trim();
    if (label) {
      const held = layout.folders.find((f) => foldName(f.name) === foldName(label));
      layout = held
        ? moveInLayout(layout, project.id, { folderId: held.id })
        : addFolder(layout, { id: randomUUID(), name: label }, project.id);
    }
    this.layout = layout;
    this.arrange();
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
      const marked = project.sessions.find((session) => session.lead && !session.liaison);
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

  /** Whether a chat is a member of its project's team, not its lead or
   *  its liaison. */
  isMember(sessionId: string): boolean {
    const found = this.findSession(sessionId);
    return (
      !!found && leadOf(found.project)?.id !== sessionId && !found.session.liaison && !found.session.side
    );
  }

  /** Whether a chat is its project's liaison. */
  isLiaison(sessionId: string): boolean {
    return this.findSession(sessionId)?.session.liaison === true;
  }

  /** A project's liaison: the one it has, or — the first time an agent
   *  from another project writes — a new one, after its lead. */
  liaison(projectId: string): SessionInfo | undefined {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const had = liaisonOf(project);
    if (had) return had;
    // never lead: true, and never first — the user's lead stays first
    const made: SessionInfo = { id: randomUUID(), title: LIAISON_TITLE, liaison: true };
    const at = project.sessions.findIndex((session) => session.id === leadOf(project)?.id);
    project.sessions.splice(at + 1 || project.sessions.length, 0, made);
    this.save();
    return made;
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

  /** Sessions mode: a plain chat, added after the project's others. */
  newSession(projectId: string): SessionInfo | undefined {
    const project = this.projects.find((p) => p.id === projectId);
    if (!project) return undefined;
    const session: SessionInfo = { id: randomUUID() };
    project.sessions.push(session);
    this.save();
    return session;
  }

  /** Sessions mode: a chat's name, or put away / brought back. */
  setSessionTitle(sessionId: string, title: string): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    found.session.title = title;
    this.save();
  }

  setSessionArchived(sessionId: string, archived: boolean): void {
    const found = this.findSession(sessionId);
    if (!found) return;
    if (archived) found.session.archived = true;
    else delete found.session.archived;
    this.save();
  }

  /** midna watching a chat, or no longer (SessionInfo.watched). */
  setSessionWatched(sessionId: string, watched: boolean): void {
    const found = this.findSession(sessionId);
    if (!found || (found.session.watched === true) === watched) return;
    if (watched) found.session.watched = true;
    else delete found.session.watched;
    this.save();
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

  /** A chat's own account for a harness, over its project's; none puts
   *  it back on its project's. Whether it changed anything. */
  setSessionAccount(sessionId: string, provider: AccountProvider, account: string | undefined): boolean {
    const session = this.findSession(sessionId)?.session;
    if (!session || session.accounts?.[provider] === account) return false;
    const next = { ...session.accounts };
    if (account) next[provider] = account;
    else delete next[provider];
    if (Object.keys(next).length > 0) session.accounts = next;
    else delete session.accounts;
    this.save();
    return true;
  }

  /** The project that owns a session id, plus the session itself. */
  findSession(sessionId: string): { project: Project; session: SessionInfo } | undefined {
    for (const project of this.projects) {
      const session = project.sessions.find((s) => s.id === sessionId);
      if (session) return { project, session };
    }
    return undefined;
  }

  /** A member leaves its project's team. A lead never does: it is the
   *  project's one chat, and goes only with the project. */
  removeMember(sessionId: string): void {
    const found = this.findSession(sessionId);
    if (!found || leadOf(found.project)?.id === sessionId) return;
    found.project.sessions = found.project.sessions.filter((s) => s.id !== sessionId);
    this.save();
  }

  /**
   * A chat picks its own model, effort or mode — the lead's, in the
   * composer, or a member's.
   *
   * The pick lands on the session, and becomes the project's default so the
   * next member starts on it — but a teammate that was riding the old
   * default must not move with it: any teammate without its own value is
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
      const was = project[key] ?? this.unset(key);
      for (const sibling of project.sessions) {
        if (sibling.id === sessionId || sibling[key] !== undefined) continue;
        (sibling as unknown as Record<string, unknown>)[key] = was;
      }
      (session as unknown as Record<string, unknown>)[key] = value || this.unset(key);
      const record = project as unknown as Record<string, unknown>;
      if (value === undefined || value === "") delete record[key];
      else record[key] = value;
    }
    this.save();
  }

  /** A worker starting a task runs on the task's model: its own setting,
   *  and nothing else's — not the project's default, as a pick in the
   *  composer would be (setSessionSettings). */
  setWorkerModel(sessionId: string, model: string): void {
    const session = this.findSession(sessionId)?.session;
    if (!session || session.model === model) return;
    session.model = model;
    this.save();
  }

  /** What a setting nobody picked means: the default model, the default
   *  effort, the built-in permission mode. */
  private unset<K extends (typeof SETTING_KEYS)[number]>(key: K): Required<SessionSettings>[K] {
    const value: Required<SessionSettings> = {
      model: this.defaultModel(),
      permissionMode: DEFAULTS.permissionMode,
      effort: this.defaultEffort(),
    };
    return value[key];
  }

  /** What a chat runs on: its own picks over the project's defaults. */
  effectiveSettings(sessionId: string): Required<SessionSettings> | undefined {
    const found = this.findSession(sessionId);
    if (!found) return undefined;
    return {
      model: found.session.model || found.project.model || this.defaultModel(),
      permissionMode: found.session.permissionMode ?? found.project.permissionMode ?? DEFAULTS.permissionMode,
      effort: found.session.effort || found.project.effort || this.defaultEffort(),
    };
  }

  /** Copy one chat's effective settings onto another — a cleared member
   *  starts again on what it ran on, whatever the project's default has
   *  become since. */
  copySessionSettings(fromId: string, toId: string): void {
    const settings = this.effectiveSettings(fromId);
    const target = this.findSession(toId)?.session;
    if (!settings || !target) return;
    Object.assign(target, settings);
    this.save();
  }

  /** Every project's lead: the chats a window can show, besides Home. */
  leadIds(): string[] {
    return this.projects.flatMap((p) => leadOf(p)?.id ?? []);
  }

  /** Every session id across every project. */
  sessionIds(): string[] {
    return this.projects.flatMap((p) => p.sessions.map((s) => s.id));
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id);
    this.layout = tidyLayout(
      this.layout,
      this.projects.map((p) => p.id),
    );
    this.save();
  }

  private save(): void {
    writeTextAtomic(
      projectsFile(),
      `${JSON.stringify(
        {
          projects: this.projects,
          sidebar: this.layout,
          ...(this.workspace ? { workspaceDir: this.workspace } : {}),
          ...(this.music ? { musicDir: this.music } : {}),
          ...(Object.keys(this.home).length ? { home: this.home } : {}),
          // always written, so "deliberately none" survives restarts
          starredModels: this.starredModelIds,
          ...(this.smallModelId ? { smallModel: this.smallModelId } : {}),
          ...(this.defaultModelId ? { defaultModel: this.defaultModelId } : {}),
          ...(this.memoryModelId ? { memoryModel: this.memoryModelId } : {}),
          ...(this.defaultEffortLevel ? { defaultEffort: this.defaultEffortLevel } : {}),
          ...(this.knownModels ? { knownModels: this.knownModels } : {}),
          ...(this.catalogModel ? { catalogModel: this.catalogModel } : {}),
        },
        null,
        2,
      )}\n`,
    );
  }
}
