import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ACCOUNT_PROVIDERS, HOME_ID, leadOf, type Project } from "../../../shared/protocol";
import { flatOrder, type ProjectFolder, type SidebarPlace, tidyLayout } from "../../../shared/sidebar";
import { useConfirm } from "./Confirm";
import { getPref, setPref, watchPref } from "../prefs";
import { accountIn, usageWord } from "../lib/accounts";
import { liveChoice, useLiveComponents } from "../lib/liveComponents";
import { defaultProjectIcon, PROJECT_ICON_NAMES } from "../lib/marks";
import { ProjectIcon } from "./Marks";
import { STAR_PATH } from "../icons";
import {
  changeFolder,
  dropFolder,
  isBusy,
  moveInSidebar,
  newFolder,
  prefetchTranscript,
  renameProject,
  send,
  setProjectAccount,
  setProjectLive,
  toggleProject,
  useRuri,
} from "../store";
import { PeekBand } from "./PeekBand";
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
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 10.5L12 3l9 7.5M5 9.5V21h14V9.5M9 21v-6h6v6" />
      </svg>
      <span className={`project-name${unread ? " unread" : ""}`}>Home</span>
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
        strokeWidth="1.75"
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
        strokeWidth="1.75"
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
      strokeWidth="1.75"
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
 * says when any of its chats is at work, the lead's own turn included —
 * the dragon where the X goes — and how many teammates, beside it.
 */
const CHECK = (
  <svg
    className="dropdown-check"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/**
 * A row's right-click, at the pointer: every project drawing, to pick its
 * own; the sidebar folder it is kept in; and live components for this
 * project, over the setting. On the body, so the sidebar's scrolling can't
 * clip it, and moved back inside the window once it knows how big it is.
 */
function RowMenu({
  at,
  project,
  icon,
  onIcon,
  onNewFolder,
  onClose,
}: {
  at: { x: number; y: number };
  project: Project;
  icon: string;
  onIcon: (name: string) => void;
  /** A new folder around this project, its name open for typing. */
  onNewFolder: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const folders = useRuri((s) => s.sidebar.folders);
  const within = folders.find((f) => f.projects.includes(project.id))?.id;
  const setting = useLiveComponents();
  const live = liveChoice(project);
  const accounts = useRuri((s) => s.accounts);
  const usage = useRuri((s) => s.usage);
  const [spot, setSpot] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setSpot({
      left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)),
    });
  }, [at.x, at.y, folders.length]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const put = (place: SidebarPlace) => {
    moveInSidebar(project.id, place);
    onClose();
  };
  return createPortal(
    <div
      ref={box}
      className="row-menu"
      role="menu"
      style={spot}
      // nothing in here is the row's: not a click on it, not the start of a carry
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="icon-picker">
        {PROJECT_ICON_NAMES.map((name) => (
          <button
            key={name}
            role="menuitemradio"
            aria-checked={name === icon}
            className={name === icon ? "on" : ""}
            title={name}
            onClick={() => onIcon(name)}
          >
            <ProjectIcon name={name} />
          </button>
        ))}
      </div>
      <div className="row-menu-label">Folder</div>
      {folders.map((f) => (
        <button
          key={f.id}
          role="menuitemradio"
          aria-checked={f.id === within}
          className={`dropdown-item ${f.id === within ? "selected" : ""}`}
          onClick={() => (f.id === within ? onClose() : put({ folderId: f.id }))}
        >
          {CHECK}
          <span className="row-menu-name">{f.name}</span>
        </button>
      ))}
      {within && (
        <button role="menuitem" className="dropdown-item" onClick={() => put({})}>
          {CHECK}
          No folder
        </button>
      )}
      <button
        role="menuitem"
        className="dropdown-item"
        onClick={() => {
          onNewFolder();
          onClose();
        }}
      >
        {CHECK}
        New folder
      </button>
      {ACCOUNT_PROVIDERS.map((provider) => {
        const theirs = accounts.filter((a) => a.provider === provider);
        // a harness with one account has nothing to pick between
        if (theirs.length < 2) return null;
        const on = accountIn(accounts, project, provider);
        return (
          <div key={provider} role="group">
            <div className="row-menu-label">{provider === "claude" ? "Claude account" : "Codex account"}</div>
            {theirs.map((a) => (
              <button
                key={a.id}
                role="menuitemradio"
                aria-checked={a.id === on}
                className={`dropdown-item ${a.id === on ? "selected" : ""}`}
                title={
                  a.signedIn === false
                    ? `${a.name} isn't signed in — sign in in Settings, Accounts`
                    : undefined
                }
                disabled={a.signedIn === false}
                onClick={() => {
                  if (a.id !== on) setProjectAccount(project.id, a);
                  onClose();
                }}
              >
                {CHECK}
                <span className="row-menu-name">{a.name}</span>
                {usageWord(usage[a.usage]) && (
                  <span className="row-menu-room">{usageWord(usage[a.usage])}</span>
                )}
              </button>
            ))}
          </div>
        );
      })}
      <div className="row-menu-label">Live components</div>
      <div className="seg row-menu-seg">
        {(["default", "on", "off"] as const).map((option) => (
          <button
            key={option}
            className={`seg-option ${live === option ? "active" : ""}`}
            title={
              option === "default"
                ? `Follow the setting in Settings — ${setting ? "on" : "off"} now`
                : `Live components ${option} for ${project.name}, whatever the setting says`
            }
            onClick={() => setProjectLive(project.id, option)}
          >
            {option === "default" ? `Default (${setting ? "on" : "off"})` : option === "on" ? "On" : "Off"}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** Where something being carried would land if let go now: the row or
 *  folder that wears the mark, on which edge (or the folder itself, to go
 *  into it), and the place that is in the layout. */
interface Drop {
  markId: string;
  edge: "before" | "after" | "into";
  place: SidebarPlace;
}

/** A project or a folder lifted off the sidebar and being carried. */
interface Lift {
  id: string;
  kind: "project" | "folder";
  /** How far it has been carried from where it sits. */
  dy: number;
  over: Drop | null;
}

/** The sidebar's pointer handlers, on every row that can be carried: a
 *  press that moves lifts it, one that doesn't is still a click. */
interface Carry {
  down(e: React.PointerEvent<HTMLDivElement>, id: string, kind: Lift["kind"]): void;
  move(e: React.PointerEvent<HTMLDivElement>): void;
  up(e: React.PointerEvent<HTMLDivElement>): void;
  cancel(): void;
}

/** What a row or a folder's block wears while something is carried: lifted
 *  itself, or marked on the edge the carried one would land at. */
function carryClass(lift: Lift | null | undefined, id: string): string {
  if (!lift) return "";
  if (lift.id === id) return "lifting";
  if (lift.over?.markId !== id) return "";
  return lift.over.edge === "into" ? "drop-into" : `drop-${lift.over.edge}`;
}

function ProjectRow({
  project,
  folderId,
  carry,
  lift,
  onNewFolder,
}: {
  project: Project;
  /** The sidebar folder it stands in, when it stands in one. */
  folderId?: string;
  /** Set on the rows that can be carried: every one but the hidden. */
  carry?: Carry;
  lift?: Lift | null;
  /** A new folder around this project. */
  onNewFolder(projectId: string): void;
}) {
  const lead = leadOf(project);
  const leadId = lead?.id;
  // lit while any of its chats is open: the lead, or a teammate or the
  // liaison opened from the team page
  const active = useRuri((s) => project.sessions.some((x) => x.id === s.activeId));
  const unread = useRuri((s) => (leadId ? (s.unread[leadId] ?? false) : false));
  const setActive = useRuri((s) => s.setActive);
  // how many teammates are at work — one number, so the row repaints when
  // it changes rather than on every status in the app
  const atWork = useRuri((s) => teamAtWork(s, project));
  // any chat of it at work, the lead's own turn included (in One chat mode
  // that is all there is), puts the head where the X goes
  const anyBusy = useRuri((s) => project.sessions.some((x) => isBusy(s, x.id)));
  const [renaming, setRenaming] = useState(false);
  // its drawing: the one the user picked, or one from its id
  const iconKey = `ruri-project-icon:${project.id}`;
  const [icon, setIcon] = useState(() => getPref(iconKey) ?? defaultProjectIcon(project.id));
  useEffect(() => watchPref(iconKey, (v) => v && setIcon(v)), [iconKey]);
  const [picking, setPicking] = useState<{ x: number; y: number } | null>(null);
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
  const lifted = lift?.id === project.id;
  return (
    <div
      className={`project-row team-row ${active ? "active" : ""} ${project.starred ? "starred" : ""} ${renaming ? "renaming" : ""} ${project.hidden ? "is-hidden" : ""} ${anyBusy ? "busy" : ""} ${folderId ? "nested" : ""} ${carry ? carryClass(lift, project.id) : ""}`}
      title={
        renaming ? undefined : `${project.path} — double-click to rename${carry ? ", drag to move" : ""}`
      }
      // how the carrying finds it: the row, the folder it is in, and — in
      // no folder — its place in the top level
      data-row={carry ? project.id : undefined}
      data-in={carry ? (folderId ?? "") : undefined}
      data-top={carry && !folderId ? project.id : undefined}
      style={lifted ? { transform: `translateY(${lift!.dy}px)` } : undefined}
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
      onPointerDown={(e) => {
        if (leadId) prefetchTranscript(leadId);
        if (!renaming) carry?.down(e, project.id, "project");
      }}
      onPointerMove={carry?.move}
      onPointerUp={carry?.up}
      onPointerCancel={carry?.cancel}
      onDoubleClick={(e) => {
        e.preventDefault();
        setRenaming(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setPicking({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* a small drawing: rows tell apart at a glance; right-click picks another */}
      <span className="team-row-icon" aria-hidden>
        <ProjectIcon name={icon} />
      </span>
      {picking && (
        <RowMenu
          at={picking}
          project={project}
          icon={icon}
          onIcon={(name) => {
            setIcon(name);
            setPref(iconKey, name);
            setPicking(null);
          }}
          onNewFolder={() => onNewFolder(project.id)}
          onClose={() => setPicking(null)}
        />
      )}
      {renaming ? (
        <NameEditor value={project.name} className="project-name" onDone={rename} />
      ) : (
        <span className={`project-name${unread ? " unread" : ""}`}>{project.name}</span>
      )}
      {atWork > 0 && (
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
              strokeWidth="1.75"
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
              strokeWidth="1.75"
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
          className={`remove ${anyBusy ? "busy" : ""}`}
          title={anyBusy ? "Working — click to remove this project anyway" : "Remove project"}
          onClick={(e) => {
            e.stopPropagation();
            void ask({
              title: `Remove "${project.name}"?`,
              body: anyBusy
                ? "Its lead and its team go with it, the working ones stopped; files are untouched."
                : "Its lead and its team go with it; files are untouched.",
              ok: "Remove",
              destructive: true,
            }).then((yes) => {
              if (yes) send({ type: "remove_project", projectId: project.id });
            });
          }}
        >
          <RemoveIcon busy={anyBusy} />
        </button>
      </span>
    </div>
  );
}

/**
 * A sidebar folder: a row of its own over the projects kept in it. A click
 * folds it shut or opens it; shut, it says what its projects would have —
 * a dragon and how many of them are at work, and its name bold while one
 * of their leads has a reply unread. Double-click renames it, the X takes
 * it away (its projects stay), and it is carried like a row, its projects
 * with it.
 */
function FolderRow({
  folder,
  members,
  fresh,
  onNamed,
  carry,
  lift,
}: {
  folder: ProjectFolder;
  /** Its projects that are not hidden. */
  members: Project[];
  /** Made a moment ago, here: its name is open for typing. */
  fresh: boolean;
  onNamed(): void;
  carry: Carry;
  lift: Lift | null;
}) {
  const shut = folder.collapsed === true;
  const atWork = useRuri((s) => members.reduce((n, p) => (teamAtWork(s, p) > 0 ? n + 1 : n), 0));
  const unread = useRuri((s) =>
    members.some((p) => {
      const lead = leadOf(p)?.id;
      return lead ? (s.unread[lead] ?? false) : false;
    }),
  );
  const [renaming, setRenaming] = useState(fresh);
  const into = lift?.over?.edge === "into" && lift.over.markId === folder.id;
  return (
    <div
      className={`project-row folder-row ${shut ? "" : "open"} ${renaming ? "renaming" : ""} ${into ? "drop-into" : ""}`}
      title={renaming ? undefined : "Click to fold or open — double-click to rename, drag to move"}
      data-folder={folder.id}
      onClick={() => changeFolder(folder.id, { collapsed: !shut })}
      onDoubleClick={(e) => {
        e.preventDefault();
        setRenaming(true);
      }}
      onPointerDown={(e) => {
        if (!renaming) carry.down(e, folder.id, "folder");
      }}
      onPointerMove={carry.move}
      onPointerUp={carry.up}
      onPointerCancel={carry.cancel}
    >
      <span className="team-row-icon folder-chevron" aria-hidden>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </span>
      {renaming ? (
        <NameEditor
          value={folder.name}
          className="project-name"
          onDone={(name) => {
            setRenaming(false);
            onNamed();
            if (name) changeFolder(folder.id, { name });
          }}
        />
      ) : (
        <span className={`project-name${shut && unread ? " unread" : ""}`}>{folder.name}</span>
      )}
      {shut && atWork > 0 ? (
        <>
          <span className="row-count-dragon" title="Something in it is working">
            <DragonHead />
          </span>
          <span className="row-count" title={`${atWork} ${atWork === 1 ? "project" : "projects"} at work`}>
            {atWork}
          </span>
        </>
      ) : (
        <span
          className="row-count folder-count"
          title={`${members.length} ${members.length === 1 ? "project" : "projects"}`}
        >
          {members.length}
        </span>
      )}
      <span className="row-actions">
        <button
          className="remove"
          title="Remove the folder — its projects stay"
          onClick={(e) => {
            e.stopPropagation();
            dropFolder(folder.id);
          }}
        >
          <RemoveIcon busy={false} />
        </button>
      </span>
    </div>
  );
}

/** How near the list's top or bottom edge a carry starts it scrolling,
 *  and how far each move of the pointer scrolls it. */
const EDGE_PX = 28;
const EDGE_STEP = 12;

/** Memoised: it takes no props, and everything it needs it selects for
 *  itself — so a re-render of the app around it is never a reason to run. */
/** The foot of the source list: who is signed in here, and Settings. Settings
 *  shows it too, at the foot of its own categories, so it never goes away. */
export function AccountBar() {
  const connected = useRuri((s) => s.connected);
  const user = useRuri((s) => s.user);
  // a window onto another computer says which, beside whose account it is
  const onto = useRuri((s) => (s.remoteDevice !== null ? s.sharing?.name : undefined));
  const settingsOpen = useRuri((s) => s.settingsOpen);
  const setSettingsOpen = useRuri((s) => s.setSettingsOpen);
  return (
    <div className="account-bar">
      <span className="account-name" title={onto ? `Chats run on ${onto} — Settings, Devices` : undefined}>
        {user || "account"}
        {onto && <span className="account-where"> on {onto}</span>}
      </span>
      {!connected && <span className="conn-text">reconnecting…</span>}
      <button
        className={`icon-button ${settingsOpen ? "active" : ""}`}
        title="Settings"
        onClick={() => setSettingsOpen(!settingsOpen)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
        </svg>
      </button>
    </div>
  );
}

export const Sidebar = memo(function Sidebar() {
  const projects = useRuri((s) => s.projects);
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

  // The order and the folders are the sidebar's own (shared/sidebar.ts):
  // dragged into place, and kept by the server. A star marks a row and
  // moves nothing. Tidied against the projects there are, so a project the
  // layout has not heard of yet still has a row, at the end.
  const saved = useRuri((s) => s.sidebar);
  const layout = useMemo(
    () =>
      tidyLayout(
        saved,
        projects.map((p) => p.id),
      ),
    [saved, projects],
  );
  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const folders = useMemo(() => new Map(layout.folders.map((f) => [f.id, f])), [layout]);
  const shown = (id: string): Project[] => {
    const project = byId.get(id);
    return project && !project.hidden ? [project] : [];
  };
  const hidden = flatOrder(layout).flatMap((id) => {
    const project = byId.get(id);
    return project?.hidden ? [project] : [];
  });
  const anyShown = projects.some((p) => !p.hidden) || layout.folders.length > 0;

  /** The folder made here a moment ago, its name still open for typing. */
  const [fresh, setFresh] = useState<string | null>(null);
  const makeFolder = (projectId?: string) => setFresh(newFolder(projectId));

  // ── carrying ──────────────────────────────────────────────────────
  // Press a row and move, and it lifts: let go between two rows and it
  // stands there, on a folder and it goes into it. A folder is carried
  // the same way, its projects with it, along the top level only. The
  // idiom is the queue's (Queue.tsx): the lifted one rides the pointer,
  // the rest stay put, and a line marks where it would land.
  const listRef = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState<Lift | null>(null);
  /** A press that may become a carry — it does once it has moved a little,
   *  so a click on the row is still a click. */
  const press = useRef<{
    id: string;
    kind: Lift["kind"];
    x: number;
    y: number;
    /** Where the list was scrolled to when the press landed. */
    scroll: number;
    live: boolean;
  } | null>(null);
  /** A carry ended on this very click: it is not one. */
  const carried = useRef(false);
  const scroller = () => listRef.current?.closest<HTMLElement>(".project-list") ?? null;

  /** The place beside something standing in a line of siblings. */
  const beside = (line: string[], id: string, edge: "before" | "after", carriedId: string): SidebarPlace => {
    const rest = line.filter((x) => x !== carriedId);
    const beforeId = edge === "before" ? id : rest[rest.indexOf(id) + 1];
    return beforeId ? { beforeId } : {};
  };
  const besideTop = (id: string, edge: "before" | "after", carriedId: string): Drop => ({
    markId: id,
    edge,
    place: beside(layout.order, id, edge, carriedId),
  });

  /** Where the carried one would land, with the pointer at this height. */
  const dropAt = (carriedId: string, kind: Lift["kind"], y: number): Drop | null => {
    const list = listRef.current;
    if (!list) return null;
    const tops = [...list.querySelectorAll<HTMLElement>("[data-top]")].filter(
      (el) => el.dataset["top"] !== carriedId,
    );
    const last = tops.at(-1)?.dataset["top"];
    if (kind === "folder") {
      // a folder stands between the top level's blocks, by their halves
      for (const el of tops) {
        const r = el.getBoundingClientRect();
        if (y < r.top + r.height / 2) return besideTop(el.dataset["top"]!, "before", carriedId);
      }
      return last ? besideTop(last, "after", carriedId) : null;
    }
    const targets = [...list.querySelectorAll<HTMLElement>("[data-row], [data-folder]")].filter(
      (el) => el.dataset["row"] !== carriedId,
    );
    // the first one the pointer has not passed: the one it is on, or the
    // one below the gap it is in
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      if (y > r.bottom) continue;
      const folderId = el.dataset["folder"];
      if (folderId) {
        // a folder's own row: its top edge is the place before the folder,
        // the rest of it is the folder
        if (y < r.top + r.height * 0.25) return besideTop(folderId, "before", carriedId);
        return { markId: folderId, edge: "into", place: { folderId } };
      }
      const rowId = el.dataset["row"]!;
      const within = el.dataset["in"] || undefined;
      const edge = y < r.top + r.height / 2 ? "before" : "after";
      const line = within ? (folders.get(within)?.projects ?? []) : layout.order;
      return {
        markId: rowId,
        edge,
        place: { ...(within ? { folderId: within } : {}), ...beside(line, rowId, edge, carriedId) },
      };
    }
    // below everything: the end of the top level, out of any folder
    return last ? besideTop(last, "after", carriedId) : null;
  };

  const carry: Carry = {
    down(e, id, kind) {
      if (e.button !== 0) return;
      if ((e.target as Element).closest("button, a, input, textarea")) return;
      press.current = {
        id,
        kind,
        x: e.clientX,
        y: e.clientY,
        scroll: scroller()?.scrollTop ?? 0,
        live: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    move(e) {
      const p = press.current;
      if (!p) return;
      if (!p.live) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
        p.live = true;
        window.getSelection()?.removeAllRanges();
      }
      // near the list's top or bottom edge, the list scrolls under it
      const box = scroller();
      if (box) {
        const r = box.getBoundingClientRect();
        if (e.clientY < r.top + EDGE_PX) box.scrollTop -= EDGE_STEP;
        else if (e.clientY > r.bottom - EDGE_PX) box.scrollTop += EDGE_STEP;
      }
      const dy = e.clientY - p.y + ((box?.scrollTop ?? 0) - p.scroll);
      setLift({ id: p.id, kind: p.kind, dy, over: dropAt(p.id, p.kind, e.clientY) });
    },
    up(e) {
      const p = press.current;
      press.current = null;
      if (!p?.live) return;
      const over = dropAt(p.id, p.kind, e.clientY);
      setLift(null);
      // the click this release is about to be is the end of a carry
      carried.current = true;
      setTimeout(() => {
        carried.current = false;
      }, 0);
      if (over) moveInSidebar(p.id, over.place);
    },
    cancel() {
      press.current = null;
      setLift(null);
    },
  };

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
        {projects.length === 0 && layout.folders.length === 0 && (
          <div className="sidebar-empty">
            No projects open.
            <br />
            Tell Home what to work on.
          </div>
        )}
        {anyShown && (
          <div className="group-label">
            Projects
            <button
              className="group-add"
              title="New folder — drag projects into it, or right-click a project"
              onClick={() => makeFolder()}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 5h5l2 2.5h9V19H4V5z" />
                <path d="M12 10.5v5M9.5 13h5" />
              </svg>
            </button>
          </div>
        )}
        <div
          className={`side-list ${lift ? "lifting" : ""}`}
          ref={listRef}
          onClickCapture={(e) => {
            if (!carried.current) return;
            carried.current = false;
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          {layout.order.map((id) => {
            const folder = folders.get(id);
            if (!folder) {
              return shown(id).map((p) => (
                <ProjectRow key={p.id} project={p} carry={carry} lift={lift} onNewFolder={makeFolder} />
              ));
            }
            const members = folder.projects.flatMap(shown);
            // shut, it still shows the project being looked at: the row
            // that is open never leaves the sidebar
            const rows = folder.collapsed
              ? members.filter((p) => p.sessions.some((x) => x.id === activeId))
              : members;
            const lifted = lift?.id === id;
            return (
              <div
                key={id}
                className={`folder-block ${lift?.over?.edge === "into" ? "" : carryClass(lift, id)}`}
                data-top={id}
                style={lifted ? { transform: `translateY(${lift.dy}px)` } : undefined}
              >
                <FolderRow
                  folder={folder}
                  members={members}
                  fresh={fresh === id}
                  onNamed={() => setFresh(null)}
                  carry={carry}
                  lift={lift}
                />
                {rows.map((p) => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    folderId={id}
                    carry={carry}
                    lift={lift}
                    onNewFolder={makeFolder}
                  />
                ))}
              </div>
            );
          })}
        </div>
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
              Hidden
              <span className="hidden-count">{hidden.length}</span>
            </button>
            {showHidden && hidden.map((p) => <ProjectRow key={p.id} project={p} onNewFolder={makeFolder} />)}
          </>
        )}
      </div>

      <AccountBar />
    </aside>
  );
});
