import { memo, useEffect, useState } from "react";
import { PEEKS } from "../peek";
import { HOME_ID, type Project, type SessionInfo } from "../../../shared/protocol";
import { Player } from "./Player";
import { getPref, setPref } from "../prefs";
import { send, useRuri } from "../store";

function HomeRow() {
  const activeId = useRuri((s) => s.activeId);
  const unread = useRuri((s) => s.unread[HOME_ID] ?? false);
  const setActive = useRuri((s) => s.setActive);

  return (
    <div
      className={`project-row home-row ${activeId === HOME_ID ? "active" : ""}`}
      title="Home — the workspace agent"
      onClick={() => setActive(HOME_ID)}
    >
      <svg
        className="home-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 10.5L12 3l9 7.5M5 9.5V21h14V9.5M9 21v-6h6v6" />
      </svg>
      <span className="project-name">Home</span>
      {unread && <span className="unread-pip" title="Turn finished" />}
    </div>
  );
}

/** Rapid fire: the pane that always shows whichever session is ready. */
function RapidRow() {
  const rapid = useRuri((s) => s.rapid);
  const setRapid = useRuri((s) => s.setRapid);

  return (
    <div
      className={`project-row rapid-row ${rapid ? "active" : ""}`}
      title="Rapid fire — prompt whichever session is ready, one after another"
      onClick={() => setRapid(!rapid)}
    >
      <svg
        className="home-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M13 2L4.5 13h6L9.5 22 19.5 10h-6L13 2z" />
      </svg>
      <span className="project-name">Rapid fire</span>
    </div>
  );
}

const STAR_PATH = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9 2.9-6z";

function SessionRow({ session }: { session: SessionInfo }) {
  const activeId = useRuri((s) => s.activeId);
  const unread = useRuri((s) => s.unread[session.id] ?? false);
  const setActive = useRuri((s) => s.setActive);

  return (
    <div
      className={`project-row session-row ${activeId === session.id ? "active" : ""}`}
      title={session.title ?? "New session"}
      onClick={() => setActive(session.id)}
    >
      <span className="project-name">{session.title ?? "new session"}</span>
      {unread && <span className="unread-pip" title="Turn finished" />}
      <button
        className="remove"
        title="Remove session"
        onClick={(e) => {
          e.stopPropagation();
          if (confirm("Remove this session? Its transcript is deleted; files are untouched.")) {
            send({ type: "remove_session", sessionId: session.id });
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

/** Folders are folded by default — only ones the user opened are stored. */
function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(getPref("ruri-expanded") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** A project folder: name, star, add-session, remove — sessions as leaves. */
function ProjectFolder({
  project,
  collapsed,
  onToggle,
}: {
  project: Project;
  collapsed: boolean;
  onToggle(): void;
}) {
  return (
    <div>
      <div className="folder-row project-folder" onClick={onToggle}>
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
        <span className="folder-name" title={project.path}>{project.name}</span>
        <span className="folder-actions">
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
            className="add-session"
            title="New session in this project"
            onClick={(e) => {
              e.stopPropagation();
              send({ type: "new_session", projectId: project.id });
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            className="remove"
            title="Remove project"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Remove "${project.name}" and all its sessions? (files are untouched)`)) {
                send({ type: "remove_project", projectId: project.id });
              }
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="folder-children">
          {project.sessions.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Memoised: it takes no props, and everything it needs it selects for
 *  itself — so a re-render of the app around it is never a reason to run. */
export const Sidebar = memo(function Sidebar() {
  const projects = useRuri((s) => s.projects);
  const connected = useRuri((s) => s.connected);
  const user = useRuri((s) => s.user);
  const [expandedSet, setExpandedSet] = useState<Set<string>>(loadExpanded);
  const settingsOpen = useRuri((s) => s.settingsOpen);
  const setSettingsOpen = useRuri((s) => s.setSettingsOpen);

  // Desktop hover-over-drag: the titlebar drag region never delivers mouse
  // events to the page, so Electron's main process polls the cursor and
  // calls this hook — we lift whichever head sits under it. (:hover still
  // covers browser dev, where there are no drag regions.)
  useEffect(() => {
    let lifted: Element | null = null;
    (window as unknown as Record<string, unknown>)["__ruriPeekCursor"] = (
      x: number,
      y: number,
      inBand: boolean,
    ) => {
      const el = inBand ? document.elementFromPoint(x, y) : null;
      const head = el?.classList.contains("peek-head") ? el : null;
      if (head === lifted) return;
      lifted?.classList.remove("lift");
      head?.classList.add("lift");
      lifted = head;
    };
    return () => {
      delete (window as unknown as Record<string, unknown>)["__ruriPeekCursor"];
    };
  }, []);

  const toggleFolder = (name: string) => {
    const next = new Set(expandedSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setExpandedSet(next);
    try {
      setPref("ruri-expanded", JSON.stringify([...next]));
    } catch {
      // preference just won't persist
    }
  };

  // Starred projects pin to the top of the one Projects list — no separate
  // section, the filled star on the row is the marker.
  const ordered = [...projects.filter((p) => p.starred), ...projects.filter((p) => !p.starred)];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo-peeks" aria-hidden>
          {/* hand-placed in the tuner (`make tuner`), which writes peek.ts —
              x/w/drop position each head, lift is the hover rise */}
          {PEEKS.map((p) => (
            <img
              key={p.n}
              className="peek-head"
              src={`/peek/u${p.n}.png`}
              alt=""
              style={{
                left: p.x,
                width: p.w,
                "--drop": `${p.drop}px`,
                "--lift": `${p.lift}px`,
              } as React.CSSProperties}
            />
          ))}
        </span>
      </div>

      <div className="project-list">
        <HomeRow />
        <RapidRow />
        {projects.length === 0 && (
          <div className="sidebar-empty">
            No projects open.
            <br />
            Tell Home what to work on.
          </div>
        )}
        {ordered.length > 0 && <div className="group-label">Projects</div>}
        {ordered.map((p) => (
          <ProjectFolder
            key={p.id}
            project={p}
            collapsed={!expandedSet.has(p.id)}
            onToggle={() => toggleFolder(p.id)}
          />
        ))}
      </div>

      <Player />

      {/* the account bar — a stub for real accounts later; for now it names
          the local user and houses the settings gear */}
      <div className="account-bar">
        <svg className="account-avatar" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c1.5-4 4.4-6 8-6s6.5 2 8 6" />
        </svg>
        <span className="account-name">{user || "account"}</span>
        {!connected && <span className="conn off" title="Reconnecting…" />}
        <button
          className={`icon-button ${settingsOpen ? "active" : ""}`}
          title="Settings"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        </button>
      </div>

    </aside>
  );
});
