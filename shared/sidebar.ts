/**
 * The sidebar's own arrangement of the projects: the order they stand in,
 * and the folders some of them are kept in.
 *
 * One value, kept by the server (ProjectStore, in projects.json) and sent
 * whole. Everything that changes it is a pure function here, so the window
 * that made a change shows exactly what the server will keep — the same
 * function, run on both sides — and a change is known to have landed when
 * running it again on the server's copy changes nothing (sameLayout).
 *
 * Folders hold projects and nothing else: no folder sits inside another.
 * A project is in the top level or in one folder, never both; one the
 * layout has never heard of joins the end of the top level (tidyLayout),
 * so a layout can never lose a project.
 */

export interface ProjectFolder {
  id: string;
  /** What the user called it. */
  name: string;
  /** Folded shut: its projects are out of sight until it is opened. */
  collapsed?: boolean;
  /** Its projects' ids, in the order they stand in it. */
  projects: string[];
}

export interface SidebarLayout {
  /** The top level, in order: folders' ids, and the ids of the projects
   *  that are in no folder. */
  order: string[];
  /** The folders, in the order they stand in `order`. */
  folders: ProjectFolder[];
}

/** Where something is put: in a folder (else the top level), before
 *  another (else at the end). */
export interface SidebarPlace {
  folderId?: string;
  beforeId?: string;
}

/** A folder's name never runs past this. */
export const FOLDER_NAME_MAX = 60;

export const NEW_FOLDER_NAME = "New folder";

function cleanName(name: unknown): string {
  const text = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, FOLDER_NAME_MAX) : "";
  return text || NEW_FOLDER_NAME;
}

/** One spelling of a folder, keys in one order, so two layouts that say
 *  the same thing are the same text (sameLayout). */
function folder(id: string, name: string, collapsed: boolean, projects: string[]): ProjectFolder {
  return { id, name, ...(collapsed ? { collapsed: true } : {}), projects };
}

/** The folders in the order they stand in the top level. */
function inOrder(order: string[], folders: ProjectFolder[]): SidebarLayout {
  const at = new Map(order.map((id, i) => [id, i]));
  return {
    order,
    folders: [...folders].sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0)),
  };
}

function insert(list: string[], id: string, beforeId: string | undefined): string[] {
  const at = beforeId === undefined ? -1 : list.indexOf(beforeId);
  return at === -1 ? [...list, id] : [...list.slice(0, at), id, ...list.slice(at)];
}

/**
 * A layout that holds for these projects: ids it names that are no longer
 * projects go, nothing stands in two places, and a project it doesn't
 * name joins the end of the top level. Whatever is read from disk or sent
 * by a window goes through here before it is believed.
 */
export function tidyLayout(layout: SidebarLayout | undefined, projectIds: readonly string[]): SidebarLayout {
  const known = new Set(projectIds);
  const placed = new Set<string>();
  const folderIds = new Set<string>();
  const folders: ProjectFolder[] = [];
  for (const f of Array.isArray(layout?.folders) ? layout.folders : []) {
    if (!f || typeof f.id !== "string" || !f.id || folderIds.has(f.id) || known.has(f.id)) continue;
    folderIds.add(f.id);
    const members: string[] = [];
    for (const id of Array.isArray(f.projects) ? f.projects : []) {
      if (!known.has(id) || placed.has(id)) continue;
      placed.add(id);
      members.push(id);
    }
    folders.push(folder(f.id, cleanName(f.name), f.collapsed === true, members));
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const stand = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };
  for (const id of Array.isArray(layout?.order) ? layout.order : []) {
    if (folderIds.has(id) || (known.has(id) && !placed.has(id))) stand(id);
  }
  for (const f of folders) stand(f.id);
  for (const id of projectIds) if (!placed.has(id)) stand(id);
  return inOrder(order, folders);
}

/** Whether two layouts say the same thing. */
export function sameLayout(a: SidebarLayout, b: SidebarLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every project's id, in the order the sidebar stands them: a folder's
 *  projects where the folder is. */
export function flatOrder(layout: SidebarLayout): string[] {
  const members = new Map(layout.folders.map((f) => [f.id, f.projects]));
  return layout.order.flatMap((id) => members.get(id) ?? [id]);
}

/** The folder a project is in, if it is in one. */
export function folderOf(layout: SidebarLayout, projectId: string): ProjectFolder | undefined {
  return layout.folders.find((f) => f.projects.includes(projectId));
}

/**
 * Carry a project or a folder somewhere else.
 *
 * A project goes into `folderId` (or the top level, without one), before
 * `beforeId` there or at the end. A folder only ever moves along the top
 * level. Something that isn't in the layout, a folder that is gone, or a
 * place before itself changes nothing.
 */
export function moveInLayout(layout: SidebarLayout, id: string, to: SidebarPlace = {}): SidebarLayout {
  const isFolder = layout.folders.some((f) => f.id === id);
  if (!isFolder && !layout.order.includes(id) && !folderOf(layout, id)) return layout;
  if (to.beforeId === id) return layout;
  const into = isFolder || to.folderId === undefined ? undefined : to.folderId;
  if (into !== undefined && !layout.folders.some((f) => f.id === into)) return layout;
  const order = layout.order.filter((x) => x !== id);
  const folders = layout.folders.map((f) =>
    f.projects.includes(id)
      ? folder(
          f.id,
          f.name,
          f.collapsed === true,
          f.projects.filter((x) => x !== id),
        )
      : f,
  );
  if (into === undefined) return inOrder(insert(order, id, to.beforeId), folders);
  return inOrder(
    order,
    folders.map((f) =>
      f.id === into ? folder(f.id, f.name, f.collapsed === true, insert(f.projects, id, to.beforeId)) : f,
    ),
  );
}

/**
 * A new folder. Around `projectId` it takes that project's place — or, for
 * a project already in a folder, stands right after that folder — with the
 * project in it; otherwise it is empty, at the top of the list. A folder
 * of that id already there changes nothing, so making one twice is making
 * it once.
 */
export function addFolder(
  layout: SidebarLayout,
  made: { id: string; name: string },
  projectId?: string,
): SidebarLayout {
  if (!made.id || layout.order.includes(made.id) || layout.folders.some((f) => f.id === made.id)) {
    return layout;
  }
  if (folderOf(layout, made.id)) return layout;
  const top = projectId === undefined ? -1 : layout.order.indexOf(projectId);
  const holder = projectId === undefined ? undefined : folderOf(layout, projectId);
  if (projectId === undefined || (top === -1 && !holder)) {
    return inOrder(
      [made.id, ...layout.order],
      [folder(made.id, cleanName(made.name), false, []), ...layout.folders],
    );
  }
  const at = top !== -1 ? top : layout.order.indexOf(holder!.id) + 1;
  const order = [...layout.order.slice(0, at), made.id, ...layout.order.slice(at)].filter(
    (id) => id !== projectId,
  );
  const folders = layout.folders.map((f) =>
    f === holder
      ? folder(
          f.id,
          f.name,
          f.collapsed === true,
          f.projects.filter((id) => id !== projectId),
        )
      : f,
  );
  return inOrder(order, [...folders, folder(made.id, cleanName(made.name), false, [projectId])]);
}

/** Rename a folder, or fold it shut or open. */
export function setFolder(
  layout: SidebarLayout,
  folderId: string,
  patch: { name?: string; collapsed?: boolean },
): SidebarLayout {
  if (!layout.folders.some((f) => f.id === folderId)) return layout;
  return {
    order: layout.order,
    folders: layout.folders.map((f) =>
      f.id === folderId
        ? folder(
            f.id,
            patch.name?.trim() ? cleanName(patch.name) : f.name,
            patch.collapsed ?? f.collapsed === true,
            f.projects,
          )
        : f,
    ),
  };
}

/** Take a folder away. Its projects stay, where the folder stood. */
export function removeFolder(layout: SidebarLayout, folderId: string): SidebarLayout {
  const gone = layout.folders.find((f) => f.id === folderId);
  if (!gone) return layout;
  return {
    order: layout.order.flatMap((id) => (id === folderId ? gone.projects : [id])),
    folders: layout.folders.filter((f) => f !== gone),
  };
}

/**
 * The layout a list of projects starts with, the first time there is one:
 * the order the sidebar used to show them in — starred first, then the
 * rest as they were opened — and a folder for each group label a project
 * was opened under (the `folder` Home's open_project could pass, which
 * nothing drew until now).
 */
export function firstLayout(
  projects: ReadonlyArray<{ id: string; starred?: boolean; folder?: string }>,
  newId: () => string,
): SidebarLayout {
  const order: string[] = [];
  const folders = new Map<string, ProjectFolder>();
  for (const p of [...projects.filter((x) => x.starred), ...projects.filter((x) => !x.starred)]) {
    const label = typeof p.folder === "string" ? p.folder.trim() : "";
    if (!label) {
      order.push(p.id);
      continue;
    }
    const key = label.toLowerCase();
    let group = folders.get(key);
    if (!group) {
      group = folder(newId(), cleanName(label), false, []);
      folders.set(key, group);
      order.push(group.id);
    }
    group.projects.push(p.id);
  }
  return tidyLayout(
    { order, folders: [...folders.values()] },
    projects.map((p) => p.id),
  );
}
