import { useState } from "react";
import { HOME_ID, type Project } from "../../../shared/protocol";
import { Player } from "./Player";
import { send, useRuri } from "../store";
import { applyTheme, getTheme, type Theme } from "../theme";

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };
  return (
    <button
      className="icon-button"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      onClick={flip}
    >
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}

function HomeRow() {
  const activeId = useRuri((s) => s.activeId);
  const status = useRuri((s) => s.statuses[HOME_ID] ?? "idle");
  const unread = useRuri((s) => s.unread[HOME_ID] ?? false);
  const setActive = useRuri((s) => s.setActive);

  return (
    <div
      className={`project-row home-row ${activeId === HOME_ID ? "active" : ""}`}
      title="Home — the workspace agent"
      onClick={() => setActive(HOME_ID)}
    >
      <img className="home-face" src="/ruri-face.png" alt="" />
      <span className="project-name">Home</span>
      {unread && <span className="unread-pip" title="New activity" />}
      <span className={`dot ${status}`} title={status} />
    </div>
  );
}

const STAR_PATH = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9 2.9-6z";

function ProjectRow({ project, depth = 0 }: { project: Project; depth?: number }) {
  const activeId = useRuri((s) => s.activeId);
  const status = useRuri((s) => s.statuses[project.id] ?? "idle");
  const unread = useRuri((s) => s.unread[project.id] ?? false);
  const setActive = useRuri((s) => s.setActive);

  return (
    <div
      className={`project-row ${activeId === project.id ? "active" : ""}`}
      style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
      title={project.path}
      onClick={() => setActive(project.id)}
    >
      <span className={`dot ${status} ${unread ? "unread" : ""}`} title={status} />
      <span className="project-name">{project.name}</span>
      {unread && <span className="unread-pip" title="New activity" />}
      <button
        className={`star ${project.starred ? "on" : ""}`}
        title={project.starred ? "Unstar" : "Star"}
        onClick={(e) => {
          e.stopPropagation();
          send({ type: "toggle_star", projectId: project.id });
        }}
      >
        <svg viewBox="0 0 24 24" fill={project.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
          <path d={STAR_PATH} />
        </svg>
      </button>
      <button
        className="remove"
        title="Remove project"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Remove "${project.name}" from ruri? (files are untouched)`)) {
            send({ type: "remove_project", projectId: project.id });
          }
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

/* ── folder tree ─────────────────────────────────────────────────── */

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  projects: Project[];
}

/** Nest projects by their folder path ("a/b" → a → b). */
function buildTree(projects: Project[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: new Map(), projects: [] };
  for (const project of projects) {
    const parts = (project.folder ?? "").split("/").filter(Boolean);
    let node = root;
    for (const part of parts) {
      let child = node.folders.get(part);
      if (!child) {
        child = {
          name: part,
          path: node.path ? `${node.path}/${part}` : part,
          folders: new Map(),
          projects: [],
        };
        node.folders.set(part, child);
      }
      node = child;
    }
    node.projects.push(project);
  }
  return root;
}

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("ruri-collapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function FolderRow({
  node,
  depth,
  collapsed,
  onToggle,
}: {
  node: FolderNode;
  depth: number;
  collapsed: boolean;
  onToggle(): void;
}) {
  return (
    <button
      className="folder-row"
      style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
      onClick={onToggle}
    >
      <svg
        className={`folder-chevron ${collapsed ? "" : "open"}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      </svg>
      <span className="folder-name">{node.name}</span>
    </button>
  );
}

function Tree({
  node,
  depth,
  collapsedSet,
  onToggle,
}: {
  node: FolderNode;
  depth: number;
  collapsedSet: Set<string>;
  onToggle(path: string): void;
}) {
  const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {folders.map((folder) => {
        const collapsed = collapsedSet.has(folder.path);
        return (
          <div key={folder.path}>
            <FolderRow
              node={folder}
              depth={depth}
              collapsed={collapsed}
              onToggle={() => onToggle(folder.path)}
            />
            {!collapsed && (
              <Tree node={folder} depth={depth + 1} collapsedSet={collapsedSet} onToggle={onToggle} />
            )}
          </div>
        );
      })}
      {node.projects.map((p) => (
        <ProjectRow key={p.id} project={p} depth={depth} />
      ))}
    </>
  );
}

export function Sidebar() {
  const projects = useRuri((s) => s.projects);
  const connected = useRuri((s) => s.connected);
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(loadCollapsed);

  const toggleFolder = (path: string) => {
    const next = new Set(collapsedSet);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsedSet(next);
    try {
      localStorage.setItem("ruri-collapsed", JSON.stringify([...next]));
    } catch {
      // preference just won't persist
    }
  };

  const starred = projects.filter((p) => p.starred);
  const rest = projects.filter((p) => !p.starred);
  const tree = buildTree(rest);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">
          <img className="logo-face" src="/ruri-face.png" alt="" />
          <span className="logo-name">ruri</span>
        </span>
        <span className="sidebar-header-right">
          <ThemeToggle />
          <span
            className={`conn ${connected ? "on" : "off"}`}
            title={connected ? "Connected" : "Reconnecting…"}
          />
        </span>
      </div>

      <div className="project-list">
        <HomeRow />
        {projects.length === 0 && (
          <div className="sidebar-empty">
            No projects open.
            <br />
            Tell Home what to work on.
          </div>
        )}
        {starred.length > 0 && (
          <>
            <div className="group-label">Starred</div>
            {starred.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </>
        )}
        {rest.length > 0 && <div className="group-label">Projects</div>}
        <Tree node={tree} depth={0} collapsedSet={collapsedSet} onToggle={toggleFolder} />
      </div>

      <Player />
    </aside>
  );
}
