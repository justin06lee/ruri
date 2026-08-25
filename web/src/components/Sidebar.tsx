import { useState } from "react";
import type { Project } from "../../../shared/protocol";
import { send, useRuri } from "../store";

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

function AddProjectForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [folder, setFolder] = useState("");

  const submit = () => {
    if (!path.trim()) return;
    send({ type: "add_project", name, path, folder: folder || undefined });
    onDone();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
    if (e.key === "Escape") onDone();
  };

  return (
    <div className="add-form">
      <input
        placeholder="/path/to/project"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
      <input
        placeholder="Name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <input
        placeholder="Folder (optional)"
        value={folder}
        onChange={(e) => setFolder(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="add-form-actions">
        <button className="ghost" onClick={onDone}>
          Cancel
        </button>
        <button className="primary" onClick={submit} disabled={!path.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const projects = useRuri((s) => s.projects);
  const connected = useRuri((s) => s.connected);
  const [adding, setAdding] = useState(false);

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
        <span
          className={`conn ${connected ? "on" : "off"}`}
          title={connected ? "Connected" : "Reconnecting…"}
        />
      </div>

      <div className="project-list">
        {projects.length === 0 && !adding && (
          <div className="sidebar-empty">
            No projects yet.
            <br />
            Add one to get started.
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

      {adding ? (
        <AddProjectForm onDone={() => setAdding(false)} />
      ) : (
        <button className="add-button" onClick={() => setAdding(true)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add project
        </button>
      )}
    </aside>
  );
}
