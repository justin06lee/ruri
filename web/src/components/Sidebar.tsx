import { memo, useEffect, useRef, useState } from "react";
import { HOME_ID, leadOf, type Project } from "../../../shared/protocol";
import { useConfirm } from "./Confirm";
import { PeekBand } from "./PeekBand";
import { Player } from "./Player";
import { getPref, setPref } from "../prefs";
import { STAR_PATH } from "../icons";
import { isBusy, prefetchTranscript, renameProject, send, toggleProject, useRuri } from "../store";
import { DragonHead } from "./Thinking";

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

/**
 * How many of a project's team are at work: every session but its lead —
 * the liaison too — with a turn running, whoever started it (the lead, the
 * user, another project's agent), a card waiting on the user, or agents
 * and scripts it left going (isBusy). The lead hands every job to its team
 * and is free most of the time, so what a row's dragon and its count say
 * is the team's work, never the lead's own.
 */
function teamAtWork(s: Parameters<typeof isBusy>[0], project: Project): number {
  const leadId = leadOf(project)?.id;
  return project.sessions.reduce((n, x) => (x.id !== leadId && isBusy(s, x.id) ? n + 1 : n), 0);
}

/**
 * The projects page: every open project at once, in the pane.
 *
 * It used to be the other half of Home's strip, which made Home the place
 * you went to look at everything — a page about the projects, reached
 * through the agent that opens them. It is its own row now, under Home,
 * and the strip kept the statistics instead (components/HomeBoard.tsx).
 * While any project is at work, the row wears the same dragon the
 * sidebar's own rows do, and beside it how many projects are — the ones
 * open are counted on the page itself.
 */
function ProjectsRow() {
  const open = useRuri((s) => s.projectsOpen);
  const setOpen = useRuri((s) => s.setProjectsOpen);

  // How many projects have their team at work right now, counted the way
  // the row dragons are lit (teamAtWork). One number, so the row repaints
  // when it changes, not on every status of every session in the app. With
  // the rows scrolled away, this is the one place left that says how much
  // is still running; how many are open is the projects page's.
  const active = useRuri((s) =>
    s.projects.reduce((n, project) => (!project.hidden && teamAtWork(s, project) > 0 ? n + 1 : n), 0),
  );

  return (
    <div
      className={`project-row ${open ? "active" : ""}`}
      title="Every open project at a glance"
      onClick={() => setOpen(!open)}
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
        <path d="M4 5h5l2 2.5h9V19H4V5z" />
      </svg>
      <span className="project-name">Projects</span>
      {active > 0 && (
        <>
          <span className="row-count-dragon" title="Something is working">
            <DragonHead />
          </span>
          <span className="row-count" title={`${active} ${active === 1 ? "project" : "projects"} at work`}>
            {active}
          </span>
        </>
      )}
    </div>
  );
}

/** Rapid fire: the pane that always shows whichever project's lead is ready. */
function RapidRow() {
  const rapid = useRuri((s) => s.rapid);
  const setRapid = useRuri((s) => s.setRapid);

  return (
    <div
      className={`project-row rapid-row ${rapid ? "active" : ""}`}
      title="Rapid fire — prompt whichever project is ready, one after another"
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

/**
 * A name being rewritten in place: the row's own text, as a box, with the
 * old name selected so typing replaces it. Enter keeps it, Escape drops it,
 * and clicking away keeps it too — the same as renaming a file in Finder.
 * Nothing that happens inside reaches the row underneath: a click here is
 * not a click on the session, and Enter is not a prompt going out.
 */
function NameEditor({
  value,
  className,
  onDone,
}: {
  value: string;
  className: string;
  /** The new name, or nothing if it is unchanged or blank. */
  onDone(next: string | null): void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const settle = (keep: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = draft.trim();
    onDone(keep && next && next !== value ? next : null);
  };
  return (
    <input
      ref={ref}
      className={`rename-box ${className}`}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") settle(true);
        else if (e.key === "Escape") settle(false);
      }}
      onBlur={() => settle(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** The X — or, while the thing it removes is at work, a dragon's head in
 *  its place. The head still removes it, asked first like the X is. */
function RemoveIcon({ busy }: { busy: boolean }) {
  return busy ? (
    <DragonHead />
  ) : (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** How long the pointer rests on a project's row before its lead's history
 *  is asked for: long enough that sweeping across the sidebar asks for
 *  nothing. */
const HOVER_MS = 90;

/**
 * A project: one row, and the one chat behind it — its lead (server/team.ts).
 *
 * The project used to be a folder of chats, one for each thing the user
 * had going in it, and the sidebar filled with them. Now the lead is the
 * project's only chat the user sees; the rest are its team, which it hands
 * work to and which the team page (in the chat's header) shows. The row
 * says when anyone on the team is at work — the dragon where the X goes,
 * as a chat's row always had — and how many, beside it. The lead's own
 * turn lights neither: it delegates, and its work is the team's.
 */
function ProjectRow({ project }: { project: Project }) {
  const lead = leadOf(project);
  const leadId = lead?.id;
  const active = useRuri((s) => leadId !== undefined && s.activeId === leadId);
  const unread = useRuri((s) => (leadId ? (s.unread[leadId] ?? false) : false));
  const setActive = useRuri((s) => s.setActive);
  // how many teammates are at work — one number, so the row repaints when
  // it changes rather than on every status in the app; any at all puts
  // the head where the X goes
  const atWork = useRuri((s) => teamAtWork(s, project));
  const busy = atWork > 0;
  // what removing it would stop: the lead's own turn counts here
  const anyBusy = useRuri((s) => project.sessions.some((x) => isBusy(s, x.id)));
  const [renaming, setRenaming] = useState(false);
  const { confirm: ask, card } = useConfirm();
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(hover.current), []);
  const rename = (name: string | null) => {
    setRenaming(false);
    if (name) renameProject(project.id, name);
  };
  const open = () => {
    if (leadId) setActive(leadId);
  };
  return (
    <div
      className={`project-row team-row ${active ? "active" : ""} ${project.starred ? "starred" : ""} ${renaming ? "renaming" : ""} ${project.hidden ? "is-hidden" : ""} ${busy ? "busy" : ""}`}
      title={renaming ? undefined : `${project.path} — double-click to rename`}
      onClick={open}
      // the lead's history asked for while the pointer rests on the row, or
      // the moment it goes down on it — over a network that is most of the
      // round trip done before the click lands (store.ts, prefetchTranscript)
      onPointerEnter={() => {
        if (!leadId) return;
        clearTimeout(hover.current);
        hover.current = setTimeout(() => prefetchTranscript(leadId), HOVER_MS);
      }}
      onPointerLeave={() => clearTimeout(hover.current)}
      onPointerDown={() => {
        if (leadId) prefetchTranscript(leadId);
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        setRenaming(true);
      }}
    >
      <svg
        className="team-row-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
      </svg>
      {renaming ? (
        <NameEditor value={project.name} className="project-name" onDone={rename} />
      ) : (
        <span className="project-name">{project.name}</span>
      )}
      {unread && <span className="unread-pip" title="Turn finished" />}
      {busy && (
        <span
          className="row-count team-count"
          title={`${atWork} ${atWork === 1 ? "teammate" : "teammates"} at work`}
        >
          {atWork}
        </span>
      )}
      {card}
      <span className="row-actions">
        <button
          className={`star ${project.starred ? "on" : ""}`}
          title={project.starred ? "Unstar" : "Star"}
          onClick={(e) => {
            e.stopPropagation();
            toggleProject(project.id, "starred");
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill={project.starred ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d={STAR_PATH} />
          </svg>
        </button>
        <button
          className="hide"
          title={project.hidden ? "Unhide project" : "Hide project (stays open)"}
          onClick={(e) => {
            e.stopPropagation();
            toggleProject(project.id, "hidden");
          }}
        >
          {project.hidden ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 3l18 18" />
              <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
              <path d="M9.9 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1" />
              <path d="M6.6 6.6A16.6 16.6 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.4-1" />
            </svg>
          )}
        </button>
        <button
          className={`remove ${busy ? "busy" : ""}`}
          title={anyBusy ? "Working — click to remove this project anyway" : "Remove project"}
          onClick={(e) => {
            e.stopPropagation();
            void ask({
              title: `Remove "${project.name}"?`,
              body: anyBusy
                ? "Its lead and its team go with it, the working ones stopped; files are untouched."
                : "Its lead and its team go with it; files are untouched.",
              ok: "Remove",
            }).then((yes) => {
              if (yes) send({ type: "remove_project", projectId: project.id });
            });
          }}
        >
          <RemoveIcon busy={busy} />
        </button>
      </span>
    </div>
  );
}

/** Memoised: it takes no props, and everything it needs it selects for
 *  itself — so a re-render of the app around it is never a reason to run. */
export const Sidebar = memo(function Sidebar() {
  const projects = useRuri((s) => s.projects);
  const connected = useRuri((s) => s.connected);
  const user = useRuri((s) => s.user);
  // a window onto another computer says which, beside whose account it is
  const onto = useRuri((s) => (s.remoteDevice !== null ? s.sharing?.name : undefined));
  // The fold at the bottom: hidden projects stay out of sight until it is
  // opened, and whether it is open is remembered.
  const [showHidden, setShowHidden] = useState<boolean>(() => {
    try {
      return getPref("ruri-show-hidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleHidden = () => {
    const next = !showHidden;
    setShowHidden(next);
    try {
      setPref("ruri-show-hidden", next ? "1" : "0");
    } catch {
      // preference just won't persist
    }
  };
  const settingsOpen = useRuri((s) => s.settingsOpen);
  const setSettingsOpen = useRuri((s) => s.setSettingsOpen);

  // A chat inside a hidden project being looked at — reached by the
  // switcher, or the Home agent — opens the fold, so the row that is
  // active is actually on screen. Noticed while rendering (the way React
  // has state follow the store), and on the first render too.
  const activeId = useRuri((s) => s.activeId);
  const ownerHidden = useRuri(
    (s) => s.projects.find((p) => p.sessions.some((x) => x.id === activeId))?.hidden === true,
  );
  const [hiddenSeen, setHiddenSeen] = useState<boolean | null>(null);
  if (hiddenSeen !== ownerHidden) {
    setHiddenSeen(ownerHidden);
    if (ownerHidden) setShowHidden(true);
  }

  // Starred projects pin to the top of the one Projects list — no separate
  // section, the filled star on the row is the marker.
  const shown = projects.filter((p) => !p.hidden);
  const hidden = projects.filter((p) => p.hidden);
  const ordered = [...shown.filter((p) => p.starred), ...shown.filter((p) => !p.starred)];

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        {/* the pictures across the top, as Settings has them (band.ts) */}
        <PeekBand />
      </div>

      <div className="project-list">
        <HomeRow />
        <ProjectsRow />
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
          <ProjectRow key={p.id} project={p} />
        ))}
        {hidden.length > 0 && (
          <>
            <button
              className={`hidden-fold ${showHidden ? "open" : ""}`}
              title={showHidden ? "Tuck the hidden projects away again" : "Show the hidden projects"}
              onClick={toggleHidden}
            >
              <svg
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
              {showHidden ? "hide" : "show"} {hidden.length} hidden
            </button>
            {showHidden && hidden.map((p) => <ProjectRow key={p.id} project={p} />)}
          </>
        )}
      </div>

      <Player />

      {/* the account bar — a stub for real accounts later; for now it names
          the local user and houses the settings gear */}
      <div className="account-bar">
        <svg
          className="account-avatar"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c1.5-4 4.4-6 8-6s6.5 2 8 6" />
        </svg>
        <span className="account-name" title={onto ? `Chats run on ${onto} — Settings, Devices` : undefined}>
          {user || "account"}
          {onto && <span className="account-where"> on {onto}</span>}
        </span>
        {!connected && <span className="conn off" title="Reconnecting…" />}
        <button
          className={`icon-button ${settingsOpen ? "active" : ""}`}
          title="Settings"
          onClick={() => setSettingsOpen(!settingsOpen)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        </button>
      </div>
    </aside>
  );
});
