import { useState } from "react";
import { HOME_ID, type Project } from "../../../shared/protocol";
import { Player } from "./Player";
import { Settings } from "./Settings";
import { send, useRuri } from "../store";

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

/* ── folder groups (single level, deliberately non-recursive) ────── */

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("ruri-collapsed") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function FolderRow({
  name,
  collapsed,
  onToggle,
}: {
  name: string;
  collapsed: boolean;
  onToggle(): void;
}) {
  return (
    <button className="folder-row" onClick={onToggle}>
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
      <span className="folder-name">{name}</span>
    </button>
  );
}

export function Sidebar() {
  const projects = useRuri((s) => s.projects);
  const connected = useRuri((s) => s.connected);
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(loadCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const toggleFolder = (name: string) => {
    const next = new Set(collapsedSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setCollapsedSet(next);
    try {
      localStorage.setItem("ruri-collapsed", JSON.stringify([...next]));
    } catch {
      // preference just won't persist
    }
  };

  const starred = projects.filter((p) => p.starred);
  const rest = projects.filter((p) => !p.starred);
  // One level of grouping only — the whole folder string is the group name.
  const groups = new Map<string, Project[]>();
  const ungrouped: Project[] = [];
  for (const p of rest) {
    if (p.folder) groups.set(p.folder, [...(groups.get(p.folder) ?? []), p]);
    else ungrouped.push(p);
  }
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">
          <img className="logo-face" src="/ruri-face.png" alt="" />
          <span className="logo-name">ruri</span>
        </span>
        <span className="sidebar-header-right">
          <button className="icon-button" title="Settings" onClick={() => setSettingsOpen(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
            </svg>
          </button>
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
        {groupNames.map((name) => {
          const collapsed = collapsedSet.has(name);
          return (
            <div key={name}>
              <FolderRow name={name} collapsed={collapsed} onToggle={() => toggleFolder(name)} />
              {!collapsed &&
                (groups.get(name) ?? []).map((p) => <ProjectRow key={p.id} project={p} depth={1} />)}
            </div>
          );
        })}
        {ungrouped.map((p) => (
          <ProjectRow key={p.id} project={p} />
        ))}
      </div>

      <Player />
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </aside>
  );
}
