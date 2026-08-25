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

function ProjectRow({ project }: { project: Project }) {
  const activeId = useRuri((s) => s.activeId);
  const status = useRuri((s) => s.statuses[project.id] ?? "idle");
  const unread = useRuri((s) => s.unread[project.id] ?? false);
  const setActive = useRuri((s) => s.setActive);

  return (
    <div
      className={`project-row ${activeId === project.id ? "active" : ""}`}
      title={project.path}
      onClick={() => setActive(project.id)}
    >
      <span className={`dot ${status} ${unread ? "unread" : ""}`} title={status} />
      <span className="project-name">{project.name}</span>
      {unread && <span className="unread-pip" title="New activity" />}
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

export function Sidebar() {
  const projects = useRuri((s) => s.projects);
  const connected = useRuri((s) => s.connected);

  const groups = new Map<string, Project[]>();
  for (const p of projects) {
    const key = p.folder ?? "";
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const folderNames = [...groups.keys()].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
  );

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
        {folderNames.map((folder) => (
          <div key={folder || "(root)"} className="group">
            {folder && <div className="group-label">{folder}</div>}
            {(groups.get(folder) ?? []).map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </div>
        ))}
      </div>

      <Player />
    </aside>
  );
}
