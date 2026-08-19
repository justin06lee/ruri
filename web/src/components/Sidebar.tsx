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
      onClick={() => setActive(project.id)}
    >
      <span className={`dot ${status} ${unread ? "unread" : ""}`} title={status} />
      <span className="project-name">{project.name}</span>
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
        ×
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

  return (
    <div className="add-form">
      <input placeholder="/path/to/project" value={path} onChange={(e) => setPath(e.target.value)} autoFocus />
      <input placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="folder (optional)" value={folder} onChange={(e) => setFolder(e.target.value)} />
      <div className="add-form-actions">
        <button className="primary" onClick={submit}>Add</button>
        <button onClick={onDone}>Cancel</button>
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
  const folderNames = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">瑠璃 ruri</span>
        <span className={`conn ${connected ? "on" : "off"}`} title={connected ? "connected" : "reconnecting…"} />
      </div>

      <div className="project-list">
        {projects.length === 0 && !adding && (
          <div className="hint">No projects yet.<br />Add one to get started.</div>
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
        <button className="add-button" onClick={() => setAdding(true)}>+ Add project</button>
      )}
    </aside>
  );
}
