import { useEffect, useRef, useState } from "react";
import type {
  HarnessInfo,
  ModelChoice,
  ModelRole,
  PermissionId,
  PermissionState,
} from "../../../shared/protocol";
import { HOME_ID } from "../../../shared/protocol";
import { send, useRuri } from "../store";
import { BandEditor } from "./BandEditor";
import { Capped } from "./Capped";
import { Icon } from "./chat/Icon";
import { Devices } from "./Devices";
import { GreetingEditor } from "./GreetingEditor";
import { Integrations } from "./Integrations";
import { PeekBand } from "./PeekBand";
import { AccountBar } from "./Sidebar";
import { STAR_PATH } from "../icons";
import { useNow } from "../lib/beat";
import { setSessionsMode, useSessionsMode } from "../lib/sessionsMode";
import { setDesignTaste, useDesignTaste } from "../lib/designTaste";
import { roughName } from "../lib/models";
import {
  applyTheme,
  currentTheme,
  getSchedule,
  saveSchedule,
  type Theme,
  type ThemeSchedule,
  themeAt,
  THEMES,
} from "../theme";

/** A row for a model no harness lists right now — a CLI that stopped
 *  offering it, or a catalog not probed yet — named from its id: a Claude
 *  "[1m]" id by the plain model the catalog does list ("Opus 5.5 1M"), since
 *  an id alone says "opus" and nothing of which one. */
function unlisted(value: string, models: ModelChoice[]): ModelChoice {
  const colon = value.indexOf(":");
  if (colon === -1) {
    const plain = value.replace(/\[1m\]$/, "");
    const name = models.find((m) => m.value === plain)?.displayName ?? roughName(plain);
    return { value, displayName: `${name}${plain === value ? "" : " 1M"}` };
  }
  const provider = value.slice(0, colon);
  return {
    value,
    displayName:
      value
        .slice(colon + 1)
        .split("/")
        .pop() || value,
    provider,
    providerLabel: provider,
  };
}

/**
 * The device-wide model catalog: every model every installed harness can
 * serve, searchable; starring pins a model into the composer's picker.
 */
function ModelCatalog() {
  const models = useRuri((s) => s.models);
  const starredIds = useRuri((s) => s.starredModels);
  const smallModel = useRuri((s) => s.smallModel);
  const defaultModel = useRuri((s) => s.defaultModel);
  const memoryModel = useRuri((s) => s.memoryModel);
  const [query, setQuery] = useState("");
  // A role tag in flight: dragged off its row, on its way to another. The
  // row under it lights up; dropping hands the role over in one move
  // instead of three clicks round the cycle.
  const [dragging, setDragging] = useState<ModelRole | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Ask the harnesses for their current catalogs whenever the catalog is
  // looked at (the server throttles, so this is free on quick re-opens).
  useEffect(() => {
    send({ type: "refresh_models" });
  }, []);

  // A starred model or a role's holder keeps its row when the harnesses stop
  // listing it, so its star and tag stay within reach. (A Claude "[1m]" one
  // the CLI stopped listing moves to its plain id on the server instead.)
  const listed = new Set(models.map((m) => m.value));
  const kept = [...new Set([...starredIds, smallModel, defaultModel, memoryModel])]
    .filter((value) => value && !listed.has(value))
    .map((value) => unlisted(value, models));
  const q = query.trim().toLowerCase();
  const matches = [...models, ...kept].filter((m) =>
    `${m.displayName} ${m.value} ${m.providerLabel ?? "claude code"}`.toLowerCase().includes(q),
  );
  // starred float to the top, catalog order within each half
  const rows = [
    ...matches.filter((m) => starredIds.includes(m.value)),
    ...matches.filter((m) => !starredIds.includes(m.value)),
  ];

  return (
    <div className="settings-models">
      <input
        className="model-search"
        placeholder="Search models…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Capped max={8} className={`model-list ${dragging ? "carrying" : ""}`}>
        {rows.length === 0 && <div className="model-empty">Nothing matches.</div>}
        {rows.map((m) => {
          const starred = starredIds.includes(m.value);
          const small = smallModel === m.value;
          const isDefault = defaultModel === m.value;
          const keeper = memoryModel === m.value;
          const tag = (role: ModelRole, label: string, hint: string) => (
            <span
              className={`model-role-tag ${role} ${dragging === role ? "lifted" : ""}`}
              title={`${hint} — drag onto another model to hand it over`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/ruri-model-role", role);
                e.dataTransfer.effectAllowed = "move";
                setDragging(role);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
            >
              {label}
            </span>
          );
          return (
            <div
              key={m.value}
              className={`model-row ${dragging && over === m.value ? "drop" : ""}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== m.value) setOver(m.value);
              }}
              onDragLeave={(e) => {
                // into a child of the row is not out of the row
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                if (over === m.value) setOver(null);
              }}
              onDrop={(e) => {
                const role = (e.dataTransfer.getData("text/ruri-model-role") || dragging) as ModelRole | "";
                e.preventDefault();
                setDragging(null);
                setOver(null);
                if (!role) return;
                const holder = role === "small" ? smallModel : role === "memory" ? memoryModel : defaultModel;
                if (holder !== m.value) send({ type: "set_model_role", model: m.value, role });
              }}
            >
              <button
                className={`model-star ${starred ? "on" : ""}`}
                title={
                  starred && (small || isDefault || keeper)
                    ? `The ${small ? "small-tasks model" : keeper ? "memory's model" : "default"} stays starred — drag its tag to another model first`
                    : starred
                      ? "Starred — click to unstar"
                      : "Star — pin into the picker"
                }
                disabled={starred && (small || isDefault || keeper)}
                onClick={() => send({ type: "toggle_model_star", model: m.value })}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill={starred ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d={STAR_PATH} />
                </svg>
              </button>
              <span
                className="model-name"
                title={listed.has(m.value) ? m.value : `${m.value} — not in its harness's list right now`}
              >
                {m.displayName}
              </span>
              {small && tag("small", "small tasks", "Runs small background tasks such as notes and titles")}
              {isDefault && tag("default", "default", "What new chats and projects start on")}
              {keeper &&
                tag(
                  "memory",
                  "memory",
                  "Writes and checks each project's memory: folds finished turns in, and checks lines whose code moved",
                )}
              <span className="model-tag">{m.providerLabel ?? "Claude Code"}</span>
            </div>
          );
        })}
      </Capped>
      <details className="settings-help">
        <summary>About model roles</summary>
        <p>
          Star a model to include it in the composer. Drag a role label to another model to change the default
          for new conversations, the model for small tasks, or the model that maintains project memory.
          Existing conversations keep their current model.
        </p>
      </details>
    </div>
  );
}

/**
 * The vault: credentials ruri holds so the model can use them without ever
 * reading them.
 *
 * Values are one-way. They go in here and never come back out — not to this
 * page, not to the transcript, not to a model's context. What comes back is
 * the handle, which is all anything else needs to say.
 */
function Vault() {
  const secrets = useRuri((s) => s.secrets);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState("");

  const clear = () => {
    setEditing(null);
    setName("");
    setUsername("");
    setSecret("");
    setNote("");
  };

  const save = () => {
    if (!name.trim()) return;
    send({
      type: "secret_save",
      ...(editing ? { id: editing } : {}),
      name: name.trim(),
      username: username.trim(),
      note: note.trim(),
      // blank means "leave the stored value alone"
      ...(secret ? { secret } : {}),
    });
    clear();
  };

  return (
    <div className="vault">
      {secrets.length > 0 && (
        <Capped className="vault-rows">
          {secrets.map((entry) => (
            <div key={entry.id} className="vault-row">
              <span className="vault-handle">{`{{${entry.name}}}`}</span>
              {entry.username && <span className="vault-who">{entry.username}</span>}
              {!entry.hasValue && <span className="vault-who">no value yet</span>}
              <button
                className="ghost"
                title="Edit — the stored value stays unless you type a new one"
                onClick={() => {
                  setEditing(entry.id);
                  setName(entry.name);
                  setUsername(entry.username ?? "");
                  setNote(entry.note ?? "");
                  setSecret("");
                }}
              >
                Edit
              </button>
              <button className="ghost" onClick={() => send({ type: "secret_remove", id: entry.id })}>
                Forget
              </button>
            </div>
          ))}
        </Capped>
      )}

      <div className="vault-form">
        <input placeholder="name (deploy-box)" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="username (optional)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder={editing ? "new value (blank = keep)" : "password or token"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <input
          placeholder="what it's for (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="ghost" disabled={!name.trim()} onClick={save}>
          {editing ? "Save" : "Add"}
        </button>
        {editing && (
          <button className="ghost" onClick={clear}>
            Cancel
          </button>
        )}
      </div>

      <div className="vault-hint">
        Agents see the names, never the values.
      </div>
    </div>
  );
}

/**
 * A time of day, as its own little control — no native picker, no OS
 * chrome. Each part takes the arrows or the wheel; the hour rolls at 12,
 * the minutes step by five, and am/pm is a flip.
 */
function TimeField({ minutes, onChange }: { minutes: number; onChange(next: number): void }) {
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const pm = hour24 >= 12;
  const wrap = (value: number) => ((value % 1440) + 1440) % 1440;
  const step = (by: number) => onChange(wrap(minutes + by));

  const seg = (label: string, by: number, title: string) => (
    <span
      className="time-seg"
      tabIndex={0}
      role="spinbutton"
      title={title}
      onWheel={(e) => step(e.deltaY < 0 ? by : -by)}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") step(by);
        else if (e.key === "ArrowDown") step(-by);
        else return;
        e.preventDefault();
      }}
    >
      {label}
    </span>
  );

  return (
    <span className="time-field">
      {seg(String(hour12), 60, "Hour — arrows or scroll")}
      <span className="time-colon">:</span>
      {seg(String(minute).padStart(2, "0"), 5, "Minutes — arrows or scroll")}
      <span
        className="time-seg time-meridiem"
        tabIndex={0}
        role="button"
        title="Flip am/pm"
        onClick={() => step(pm ? -720 : 720)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          step(pm ? -720 : 720);
        }}
      >
        {pm ? "pm" : "am"}
      </span>
    </span>
  );
}

/* ── the schedule, as a clock ─────────────────────────────────────── */

/** The dial's geometry, in its own 200×200 space. */
const DIAL = { c: 100, ring: 69, band: 21, tick: 54, label: 35, hand: 28 };

/** Where a minute of the day sits on the dial. Midnight at the top, noon at
 *  the bottom, clockwise — a whole day to one turn. */
function atMinute(radius: number, minutes: number): [number, number] {
  const angle = (minutes / 1440) * 2 * Math.PI - Math.PI / 2;
  return [DIAL.c + radius * Math.cos(angle), DIAL.c + radius * Math.sin(angle)];
}

/** The arc a theme owns, from when it takes over until the next one does. */
function arcPath(radius: number, from: number, to: number): string {
  const span = (((to - from) % 1440) + 1440) % 1440;
  const [x1, y1] = atMinute(radius, from);
  const [x2, y2] = atMinute(radius, to);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${span > 720 ? 1 : 0} 1 ${x2} ${y2}`;
}

/** Minutes past midnight, from a point on the dial. */
function minuteAt(box: DOMRect, clientX: number, clientY: number): number {
  const x = ((clientX - box.left) / box.width) * 200 - DIAL.c;
  const y = ((clientY - box.top) / box.height) * 200 - DIAL.c;
  const turn = (Math.atan2(y, x) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
  // to the nearest five minutes, the same step the fields nudge by
  return (Math.round((turn / (2 * Math.PI)) * 288) * 5) % 1440;
}

/**
 * The schedule as a clock: one turn of the dial is one day, and the ring
 * around it is painted in the three themes — each stretch in that theme's own
 * paper, edged in its own ink, so a run of the evening looks like the evening
 * even while you are reading it in daylight.
 *
 * Twenty-four hours to the turn, not twelve. The thing being set is a whole
 * day, and on a twelve-hour face half of it is always hidden behind an am/pm
 * switch — two dials would show it all but ask you to read the day across a
 * seam. One turn, one day: the three stretches are on screen together and
 * obviously add up to everything.
 *
 * Drag a boundary to move it. The fields underneath still take arrows and the
 * wheel, which is how it gets exact.
 */
function ScheduleClock({
  schedule,
  onChange,
}: {
  schedule: ThemeSchedule;
  onChange(next: ThemeSchedule): void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const held = useRef<Theme | null>(null);
  // the hand keeps up with the clock it is drawing — while ruri is awake to
  // show it; asleep it holds, and catches up on waking (lib/beat.ts)
  const at = new Date(useNow(30_000));
  const now = at.getHours() * 60 + at.getMinutes();

  // in the order the day runs, so each one ends where the next begins
  const order = [...THEMES].sort((a, b) => schedule[a] - schedule[b]);
  const onlyOne = new Set(THEMES.map((t) => schedule[t])).size === 1;

  const drag = (e: React.PointerEvent) => {
    const theme = held.current;
    const svg = svgRef.current;
    if (!theme || !svg) return;
    onChange({ ...schedule, [theme]: minuteAt(svg.getBoundingClientRect(), e.clientX, e.clientY) });
  };

  return (
    <svg
      className="dial"
      ref={svgRef}
      viewBox="0 0 200 200"
      onPointerMove={drag}
      onPointerUp={() => {
        held.current = null;
      }}
    >
      {/* The day, in three stretches of theme. Every edge is laid down first
          and the papers over them, so what is left showing is a hairline of
          each theme's ink around its own stretch — which is the only thing
          telling dark from ember, both of them being very nearly black. */}
      {onlyOne ? (
        <>
          <circle
            className={`dial-edge ${order[0]}`}
            cx={DIAL.c}
            cy={DIAL.c}
            r={DIAL.ring}
            fill="none"
            strokeWidth={DIAL.band + 4}
          />
          <circle
            className={`dial-band ${order[0]}`}
            cx={DIAL.c}
            cy={DIAL.c}
            r={DIAL.ring}
            fill="none"
            strokeWidth={DIAL.band}
          />
        </>
      ) : (
        (["dial-edge", "dial-band"] as const).map((layer) =>
          order.map((theme, i) => (
            <path
              key={`${layer}-${theme}`}
              className={`${layer} ${theme}`}
              d={arcPath(DIAL.ring, schedule[theme], schedule[order[(i + 1) % order.length]!]!)}
              fill="none"
              strokeWidth={layer === "dial-edge" ? DIAL.band + 4 : DIAL.band}
            />
          )),
        )
      )}

      {/* an hour each, longer on the quarters */}
      {Array.from({ length: 24 }, (_, hour) => {
        const quarter = hour % 6 === 0;
        const [x1, y1] = atMinute(DIAL.tick, hour * 60);
        const [x2, y2] = atMinute(DIAL.tick - (quarter ? 7 : 3.5), hour * 60);
        return (
          <line
            key={hour}
            className={`dial-tick ${quarter ? "quarter" : ""}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
          />
        );
      })}

      {[
        [0, "12am"],
        [360, "6am"],
        [720, "12pm"],
        [1080, "6pm"],
      ].map(([minutes, label]) => {
        const [x, y] = atMinute(DIAL.label, minutes as number);
        return (
          <text key={label} className="dial-hour" x={x} y={y} dominantBaseline="middle">
            {label}
          </text>
        );
      })}

      {/* where the day is right now */}
      <line
        className="dial-now"
        x1={DIAL.c}
        y1={DIAL.c}
        x2={atMinute(DIAL.hand, now)[0]}
        y2={atMinute(DIAL.hand, now)[1]}
      />
      <circle className="dial-pin" cx={DIAL.c} cy={DIAL.c} r={3.4} />

      {/* one handle per boundary — drag it round to move that theme's start */}
      {THEMES.map((theme) => {
        const [x, y] = atMinute(DIAL.ring, schedule[theme]);
        return (
          <circle
            key={theme}
            className={`dial-grip ${theme}`}
            cx={x}
            cy={y}
            r={9}
            onPointerDown={(e) => {
              held.current = theme;
              e.currentTarget.releasePointerCapture?.(e.pointerId);
              svgRef.current?.setPointerCapture(e.pointerId);
            }}
          >
            <title>{`when ${theme} takes over — drag to move it`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

/**
 * Settings: theme, workspace root, the vault, model catalog.
 *
 * It is a page, not a dialog. It was a dialog, and it kept growing — a card
 * centred in the window has a ceiling, and past it the thing you came for is
 * simply off screen. A page has the whole pane and scrolls, which is what a
 * list of settings has always wanted.
 */
const SETTINGS_SECTIONS = [
  {
    id: "general",
    name: "General",
    icon: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z",
  },
  { id: "appearance", name: "Appearance", icon: "M12 3a9 9 0 1 0 0 18V3zM12 3a9 9 0 0 1 0 18" },
  { id: "peek-band", name: "Peek band", icon: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M16 8h.01" },
  { id: "greeting", name: "Greeting", icon: "M21 11a8 8 0 0 1-8 8H7l-4 3V11a9 9 0 0 1 18 0zM8 10h8M8 14h5" },
  { id: "folders", name: "Folders", icon: "M3 5h6l2 2h10v12H3z" },
  { id: "devices", name: "Devices", icon: "M3 4h15v11H3zM7 19h7M10 15v4M18 9h4v12h-6v-6" },
  { id: "vault", name: "Passwords", icon: "M14 8a5 5 0 1 0 0 .1M14 8h8M18 8v4M21 8v3" },
  { id: "models", name: "Models", icon: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6" },
  { id: "harnesses", name: "Harnesses", icon: "M4 5h16v14H4zM7 9l3 3-3 3M13 15h4" },
  {
    id: "integrations",
    name: "Integrations",
    icon: "M8 3v5M16 3v5M5 8h14v4a7 7 0 0 1-7 7v3M12 19a7 7 0 0 1-7-7",
  },
  {
    id: "permissions",
    name: "Privacy & Security",
    icon: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3zM9 12l2 2 4-4",
  },
] as const;

/** Settings → General → Design taste (server/gusteau.ts): the switch,
 *  whether gusteau is on this machine, and "Learn from project" for the
 *  project that's open. */
function DesignTaste() {
  const designTaste = useDesignTaste();
  const taste = useRuri((s) => s.taste);
  const connected = useRuri((s) => s.connected);
  const activeId = useRuri((s) => s.activeId);
  useEffect(() => {
    if (connected) send({ type: "taste_get" });
  }, [connected]);
  // a learn answered comes back as `taste`, newer than the ask
  const [sentAt, setSentAt] = useState(0);
  const learning = sentAt > 0 && (taste?.at ?? 0) < sentAt;
  const learned = sentAt > 0 && !learning ? taste?.learned : undefined;
  const project = activeId && activeId !== HOME_ID ? activeId : null;
  return (
    <div className="settings-row">
      <span className="settings-label">Design taste</span>
      <div className="settings-value">
        <div className="seg">
          {([false, true] as const).map((on) => (
            <button
              key={String(on)}
              className={`seg-option ${designTaste === on ? "active" : ""}`}
              onClick={() => setDesignTaste(on)}
            >
              {on ? "On" : "Off"}
            </button>
          ))}
        </div>
        {designTaste && taste?.found && project && (
          <button
            className="ghost"
            disabled={learning}
            title="Learn the design choices recorded in this project's review notes and decisions"
            onClick={() => {
              setSentAt(Date.now());
              send({ type: "taste_learn", projectId: project });
            }}
          >
            {learning ? "Learning…" : "Learn from project"}
          </button>
        )}
      </div>
      <p className="settings-note">
        Agents follow your gusteau taste on interface work.{" "}
        {taste === null ? "" : taste.found ? `Found at ${taste.found}.` : "gusteau isn't installed."}
      </p>
      {learned && <p className="settings-note">{learned.output}</p>}
    </div>
  );
}

export function Settings({ onClose }: { onClose(): void }) {
  const [section, setSection] = useState<string>("general");
  const sessionsMode = useSessionsMode();
  const workspaceDir = useRuri((s) => s.workspaceDir);
  const canPickFolder = useRuri((s) => s.canPickFolder);
  const remoteDevice = useRuri((s) => s.remoteDevice);
  const computer = useRuri((s) => s.sharing?.name);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [schedule, setSchedule] = useState<ThemeSchedule>(getSchedule);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Picking one by hand is you overruling the clock, so the clock stands down.
  const pickTheme = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
    if (schedule.on) keepSchedule({ ...schedule, on: false });
  };

  const keepSchedule = (next: ThemeSchedule) => {
    setSchedule(next);
    saveSchedule(next);
    if (next.on) {
      const now = new Date();
      const due = themeAt(now.getHours() * 60 + now.getMinutes(), next);
      applyTheme(due, false);
      setTheme(due);
      return;
    }
    // the clock stands down, and whatever it left on screen becomes the pick
    const shown = (document.documentElement.dataset["theme"] as Theme | undefined) ?? theme;
    applyTheme(shown);
    setTheme(shown);
  };

  return (
    <main className="chat settings-page">
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings categories">
          {/* the sidebar's own top: the same width, the same band over it */}
          <div className="sidebar-header">
            <PeekBand />
          </div>
          <div className="settings-categories">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`settings-category ${section === item.id ? "selected" : ""}`}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <Icon d={item.icon} />
              {item.name}
            </button>
          ))}
          </div>
          <AccountBar />
        </nav>
        <div className="settings-main">
        <header className="chat-header settings-toolbar">
          <span className="chat-title">{SETTINGS_SECTIONS.find((item) => item.id === section)?.name ?? "Settings"}</span>
          <span className="settings-location">{remoteDevice !== null && computer ? `on ${computer}` : ""}</span>
          <button className="icon-button" onClick={onClose} aria-label="Close Settings" title="Close Settings">
            <Icon d="M6 6l12 12M18 6L6 18" />
          </button>
        </header>
        <div className="settings-scroll">
          <div className="board-inner settings-inner">
            {/* Grouped, the way a settings page is: a heading, then the handful
            of rows it covers, then air. The two that are more than a row —
            the vault and the catalog — take the whole width under their
            heading instead of being squeezed into the value column. */}
            <section className="settings-group" hidden={section !== "general"}>
              <h2 className="settings-group-name">General</h2>

              <div className="settings-row">
                <span className="settings-label">Projects run as</span>
                <div className="settings-value">
                  <div className="seg">
                    {([true, false] as const).map((on) => (
                      <button
                        key={String(on)}
                        className={`seg-option ${sessionsMode === on ? "active" : ""}`}
                        title={
                          on
                            ? "Each project is one chat that does its own work; nothing spawns unless you ask"
                            : "Each project is its lead with a team behind it, handing jobs to teammates"
                        }
                        onClick={() => setSessionsMode(on)}
                      >
                        {on ? "One chat" : "Team"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <DesignTaste />
            </section>

            <section className="settings-group" hidden={section !== "appearance"}>
              <h2 className="settings-group-name">Appearance</h2>

              <div className="settings-row">
                <span className="settings-label">Theme</span>
                <div className="settings-value">
                  <div className="seg">
                    {THEMES.map((option) => (
                      <button
                        key={option}
                        className={`seg-option ${theme === option ? "active" : ""}`}
                        title={option === "ember" ? "Warm brown-black surfaces for late sessions" : undefined}
                        onClick={() => pickTheme(option)}
                      >
                        {option[0]!.toUpperCase() + option.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className={`settings-row ${schedule.on ? "tall" : ""}`}>
                <span className="settings-label">By the clock</span>
                <div className="settings-value schedule">
                  <button
                    className={`skill-switch ${schedule.on ? "on" : ""}`}
                    role="switch"
                    aria-checked={schedule.on}
                    aria-label="Change appearance on a schedule"
                    title="Turn the theme over at set times — picking one by hand turns this off"
                    onClick={() => keepSchedule({ ...schedule, on: !schedule.on })}
                  >
                    <span className="skill-knob" />
                  </button>
                  {schedule.on && (
                    <div className="schedule-face">
                      <ScheduleClock schedule={schedule} onChange={keepSchedule} />
                      <div className="schedule-times">
                        {THEMES.map((option) => (
                          <div className="schedule-slot" key={option}>
                            <span className={`schedule-swatch ${option}`} aria-hidden />
                            <span className="schedule-name">{option}</span>
                            <span className="schedule-from">from</span>
                            <TimeField
                              minutes={schedule[option]}
                              onChange={(next) => keepSchedule({ ...schedule, [option]: next })}
                            />
                          </div>
                        ))}
                        <p className="schedule-hint">
                          One turn is one day. Drag a mark round the dial, or nudge a time here.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="settings-group" hidden={section !== "peek-band"}>
              <h2 className="settings-group-name">Peek band</h2>
              <BandEditor />
            </section>

            <section className="settings-group" hidden={section !== "greeting"}>
              <h2 className="settings-group-name">Greeting</h2>
              <GreetingEditor />
            </section>

            <section className="settings-group" hidden={section !== "folders"}>
              <h2 className="settings-group-name">Folders</h2>

              <div className="settings-row">
                <span className="settings-label">Workspace</span>
                <div className="settings-value">
                  {/* LRM anchors keep the leading slash in place inside the rtl-ellipsis trick */}
                  <span className="settings-path" title={workspaceDir}>
                    {workspaceDir ? `‎${workspaceDir}‎` : "—"}
                  </span>
                  <button
                    className="ghost"
                    disabled={!canPickFolder}
                    title={
                      canPickFolder
                        ? "Pick the folder your projects live in"
                        : remoteDevice !== null
                          ? `Change it on ${computer ?? "that computer"} itself`
                          : "Available in the desktop app"
                    }
                    onClick={() => send({ type: "pick_folder", target: "workspace" })}
                  >
                    Change
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-group" hidden={section !== "devices"}>
              <h2 className="settings-group-name">Devices</h2>
              <Devices />
            </section>

            <section className="settings-group" hidden={section !== "vault"}>
              <h2 className="settings-group-name">Passwords</h2>
              <Vault />
            </section>

            <section className="settings-group" hidden={section !== "models"}>
              <h2 className="settings-group-name">Models</h2>
              <ModelCatalog />
            </section>

            <section className="settings-group" hidden={section !== "harnesses"}>
              <h2 className="settings-group-name">Harnesses</h2>
              <Harnesses />
            </section>

            <section className="settings-group" hidden={section !== "integrations"}>
              <h2 className="settings-group-name">Integrations</h2>
              <Integrations />
            </section>

            <section className="settings-group" hidden={section !== "permissions"}>
              <h2 className="settings-group-name">Privacy & Security</h2>
              <Grants />
            </section>
          </div>
        </div>
        </div>
      </div>
    </main>
  );
}

/* ── the harnesses ────────────────────────────────────────────────── */

/** "3m ago", "just now", "2h ago" — when the updater last looked. */
function ago(ts: number | undefined): string {
  if (!ts) return "not yet";
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const CHANNEL_WORD: Record<HarnessInfo["channel"], string> = {
  self: "its own updater",
  npm: "npm",
  bun: "bun",
  brew: "brew",
  other: "installed some other way",
};

/** Whether `a` is an older version than `b` (server/updater.ts `older`). */
function behind(h: HarnessInfo): boolean {
  if (!h.version || !h.latest) return false;
  const nums = (v: string) =>
    v
      .split("-")[0]!
      .split(".")
      .map((n) => Number(n) || 0);
  const [a, b] = [nums(h.version), nums(h.latest)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return h.version.includes("-") && !h.latest.includes("-");
}

/**
 * Every coding CLI on this machine: what version it is, what the newest
 * is, and whether it keeps itself current — which it does, on the hour,
 * the way it was installed, never under a running turn, unless you switch
 * it to updating by hand. Update runs one now either way.
 */
function Harnesses() {
  const harnesses = useRuri((s) => s.harnesses);
  const looking = useRuri((s) => s.harnessesChecking);
  const checked = harnesses.reduce((latest, h) => Math.max(latest, h.checkedAt ?? 0), 0);
  return (
    <div className="grants harnesses">
      <div className="grants-head">
        <button className="ghost" disabled={looking} onClick={() => send({ type: "check_harnesses" })}>
          {looking ? "looking…" : "Check now"}
        </button>
        <span className="settings-note">last looked {ago(checked || undefined)}</span>
      </div>
      {harnesses.length === 0 && (
        <p className="settings-note">The first look is a minute and a half after launch — or Check now.</p>
      )}
      <Capped>
        {harnesses.map((h) => {
          const late = behind(h);
          const status = h.updating
            ? "updating"
            : h.channel === "other"
              ? "not ours"
              : late
                ? "behind"
                : h.latest
                  ? "current"
                  : "unknown";
          return (
            <div key={h.id} className="grant-row harness-row">
              <span className={`grant-status harness-status ${status.replace(" ", "-")}`}>
                {status === "behind" ? `v${h.latest} out` : status}
              </span>
              <span className="grant-body">
                <span className="grant-name">
                  {h.label} <span className="harness-version">{h.version ? `v${h.version}` : "?"}</span>
                </span>
                <span className="grant-why" title={h.path}>
                  {[
                    h.updatedAt ? `updated from v${h.from} ${ago(h.updatedAt)}` : undefined,
                    late || h.channel === "other" ? h.note : undefined,
                    `${CHANNEL_WORD[h.channel]}${h.pkg && h.channel !== "self" ? ` · ${h.pkg}` : ""}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {h.channel !== "other" && (
                <label className="harness-auto" title="Keep it current by itself, on the hour">
                  <input
                    type="checkbox"
                    checked={h.auto !== false}
                    onChange={(e) => send({ type: "set_harness_auto", id: h.id, auto: e.target.checked })}
                  />
                  by itself
                </label>
              )}
              {h.channel !== "other" && (
                <button
                  className="ghost grant-ask"
                  disabled={h.updating || !late}
                  title={late ? `Update to v${h.latest} now` : "Already the newest"}
                  onClick={() => send({ type: "check_harnesses", id: h.id })}
                >
                  {h.updating ? "updating…" : "Update"}
                </button>
              )}
            </div>
          );
        })}
      </Capped>
    </div>
  );
}

/* ── macOS grants ─────────────────────────────────────────────────── */

const STATUS_WORD: Record<PermissionState["status"], string> = {
  granted: "granted",
  denied: "not granted",
  unasked: "never asked",
  unknown: "can't tell",
};

/**
 * What macOS has let ruri do, as macOS holds it — not as the switches in
 * System Settings look, which go stale with every rebuild of an ad-hoc
 * signed app. Each grant can be asked for by hand, so a thing that broke can
 * be told apart from a grant that lapsed; and under them, the privacy
 * database's own rows for ruri and the CLIs its sessions run, since each of
 * those is a client of its own to macOS.
 */
function Grants() {
  const can = useRuri((s) => s.canPermissions);
  const platform = useRuri((s) => s.platform);
  const grants = useRuri((s) => s.grants);
  const [asking, setAsking] = useState<PermissionId | "all" | null>(null);
  useEffect(() => {
    if (can) send({ type: "permissions_check" });
  }, [can]);
  // fresh grants from macOS are the answer to whatever was being asked
  const [grantsSeen, setGrantsSeen] = useState(grants);
  if (grants !== grantsSeen) {
    setGrantsSeen(grants);
    if (grants) setAsking(null);
  }
  const ask = (id?: PermissionId) => {
    setAsking(id ?? "all");
    send({ type: "permissions_request", ...(id ? { id } : {}) });
  };
  if (platform === "linux")
    return (
      <p className="settings-note">
        Linux keeps no per-app privacy grants: ruri and its sessions can reach whatever your account can, and
        there is nothing here to ask for. The bridge reads native apps' controls over the desktop's
        accessibility bus (AT-SPI) and photographs their windows off the X server — on a Wayland session it
        can drive web pages and Electron apps, not native windows.
      </p>
    );
  if (!can) return <p className="settings-note">Available in the desktop app.</p>;
  return (
    <div className="grants">
      <p className="settings-note grants-note">
        Allow ruri to control apps and access files on this Mac. Manage access in System Settings.
      </p>
      <details className="settings-help">
        <summary>About these permissions</summary>
        <p>
          macOS associates access with the app's signature. After a rebuild, a permission can need approval
          again even if its switch is still on in System Settings. Use Ask to request access again, or Re-read
          to check the current status.
        </p>
      </details>
      <div className="grants-head">
        <button className="ghost" disabled={asking !== null} onClick={() => ask()}>
          {asking === "all" ? "asking…" : "Ask for everything"}
        </button>
        <button
          className="ghost"
          disabled={asking !== null}
          onClick={() => send({ type: "permissions_check" })}
        >
          Re-read
        </button>
      </div>
      {!grants && <p className="settings-note">reading…</p>}
      {grants?.items.map((item) => (
        <div key={item.id} className="grant-row">
          <span className={`grant-status ${item.status}`}>{STATUS_WORD[item.status]}</span>
          <span className="grant-body">
            <span className="grant-name">{item.name}</span>
            <span className="grant-why">
              {item.why}
              {item.detail ? ` — ${item.detail}` : ""}
            </span>
          </span>
          <button
            className="ghost grant-ask"
            disabled={asking !== null}
            title={
              item.status === "granted"
                ? "Granted — ask again anyway"
                : "Put up the dialog, or open the pane where the switch is"
            }
            onClick={() => ask(item.id)}
          >
            {asking === item.id ? "asking…" : "Ask"}
          </button>
        </div>
      ))}
      {grants && grants.rows.length > 0 && (
        <details className="grants-rows">
          <summary>What macOS remembers — ruri, the CLIs, the shell ({grants.rows.length} rows)</summary>
          <div className="grants-scroll">
            <table>
              <tbody>
                {grants.rows.map((row) => (
                  <tr key={`${row.service}|${row.client}|${row.at}`} className={row.allowed ? "" : "refused"}>
                    <td className="grants-service">{row.service}</td>
                    <td className="grants-client" title={row.client}>
                      {row.client.replace(/^\/Users\/[^/]+/, "~")}
                    </td>
                    <td className="grants-verdict">{row.allowed ? "allowed" : "refused"}</td>
                    <td className="grants-when">{new Date(row.at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {grants && grants.rows.length === 0 && (
        <p className="settings-note">
          The privacy database itself can't be read — that is what Full Disk Access is for.
        </p>
      )}
    </div>
  );
}
