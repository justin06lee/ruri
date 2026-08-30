import { useEffect, useState } from "react";
import { send, useRuri } from "../store";
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

const STAR_PATH = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9 2.9-6z";

/**
 * The device-wide model catalog: every model every installed harness can
 * serve, searchable; starring pins a model into the composer's picker.
 */
function ModelCatalog() {
  const models = useRuri((s) => s.models);
  const starredIds = useRuri((s) => s.starredModels);
  const smallModel = useRuri((s) => s.smallModel);
  const [query, setQuery] = useState("");

  // Ask the harnesses for their current catalogs whenever the catalog is
  // looked at (the server throttles, so this is free on quick re-opens).
  useEffect(() => {
    send({ type: "refresh_models" });
  }, []);

  const q = query.trim().toLowerCase();
  const matches = models.filter((m) =>
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
      <div className="model-list">
        {rows.length === 0 && <div className="model-empty">Nothing matches.</div>}
        {rows.map((m) => {
          const starred = starredIds.includes(m.value);
          const small = smallModel === m.value;
          return (
            <div key={m.value} className="model-row">
              <button
                className={`model-star ${starred ? "on" : ""}`}
                title={
                  small
                    ? "Small-tasks model — click to clear"
                    : starred
                      ? "Starred — click again to make this the small-tasks model"
                      : "Star — pin into the picker"
                }
                onClick={() => send({ type: "toggle_model_star", model: m.value })}
              >
                <svg viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                  <path d={STAR_PATH} />
                </svg>
              </button>
              <span className="model-name" title={m.value}>{m.displayName}</span>
              {small && <span className="model-small-tag">small tasks</span>}
              <span className="model-tag">{m.providerLabel ?? "Claude Code"}</span>
            </div>
          );
        })}
      </div>
      <div className="model-hint">
        Starred models are what the composer's model picker offers. Star one twice to make it the
        small-tasks model — session titles, turn summaries, prompt splitting, the tracker.
      </div>
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

      <div className="vault-form">
        <input placeholder="name (deploy-box)" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="username (optional)" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input
          type="password"
          placeholder={editing ? "new value (blank = keep)" : "password or token"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <input placeholder="what it's for (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
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
        The model is told the names, never the values. It writes{" "}
        <code>{"{{name}}"}</code> into a command or a file and ruri swaps the real value in after
        it has finished writing — or it uses <code>$RURI_SECRET_NAME</code>, which is already set
        in its shell on every harness. Anything a value leaks back into is redacted to its handle.
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

/**
 * Settings: theme, workspace root, music folder, the vault, model catalog.
 *
 * It is a page, not a dialog. It was a dialog, and it kept growing — a card
 * centred in the window has a ceiling, and past it the thing you came for is
 * simply off screen. A page has the whole pane and scrolls, which is what a
 * list of settings has always wanted.
 */
export function Settings({ onClose }: { onClose(): void }) {
  const workspaceDir = useRuri((s) => s.workspaceDir);
  const musicDir = useRuri((s) => s.musicDir);
  const canPickFolder = useRuri((s) => s.canPickFolder);
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
      {/* every other page has a header bar to drag the window by; this one
          has open air instead, so the air does the job */}
      <div className="settings-drag" aria-hidden />
      <div className="board-inner settings-inner">
        <div className="board-head">
          <span className="board-title">Settings</span>
          <span className="board-sub">this machine</span>
          <button className="ghost" onClick={onClose}>
            Done
          </button>
        </div>

        {/* Grouped, the way a settings page is: a heading, then the handful
            of rows it covers, then air. The two that are more than a row —
            the vault and the catalog — take the whole width under their
            heading instead of being squeezed into the value column. */}
        <section className="settings-group">
          <h2 className="settings-group-name">Appearance</h2>

          <div className="settings-row">
            <span className="settings-label">Theme</span>
            <div className="settings-value">
              <div className="seg">
                {THEMES.map((option) => (
                  <button
                    key={option}
                    className={`seg-option ${theme === option ? "active" : ""}`}
                    title={
                      option === "ember"
                        ? "Warm through and through — no blue light, for late sessions"
                        : undefined
                    }
                    onClick={() => pickTheme(option)}
                  >
                    {option[0]!.toUpperCase() + option.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">By the clock</span>
            <div className="settings-value schedule">
              <button
                className={`seg-option toggle ${schedule.on ? "active" : ""}`}
                title="Turn the theme over at set times — picking one by hand turns this off"
                onClick={() => keepSchedule({ ...schedule, on: !schedule.on })}
              >
                {schedule.on ? "On" : "Off"}
              </button>
              {schedule.on && (
                <div className="schedule-times">
                  {THEMES.map((option) => (
                    <div className="schedule-slot" key={option}>
                      <span className="schedule-name">{option}</span>
                      <span className="schedule-from">from</span>
                      <TimeField
                        minutes={schedule[option]}
                        onChange={(next) => keepSchedule({ ...schedule, [option]: next })}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="settings-group">
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
                title={canPickFolder ? "Pick the folder your projects live in" : "Available in the desktop app"}
                onClick={() => send({ type: "pick_folder", target: "workspace" })}
              >
                Change
              </button>
            </div>
          </div>

          <div className="settings-row">
            <span className="settings-label">Music</span>
            <div className="settings-value">
              <span className="settings-path" title={musicDir}>
                {musicDir ? `‎${musicDir}‎` : "—"}
              </span>
              <button
                className="ghost"
                disabled={!canPickFolder}
                title={canPickFolder ? "Pick the folder your music lives in (each subfolder is a playlist)" : "Available in the desktop app"}
                onClick={() => send({ type: "pick_folder", target: "music" })}
              >
                Change
              </button>
            </div>
          </div>
        </section>

        <section className="settings-group">
          <h2 className="settings-group-name">Vault</h2>
          <Vault />
        </section>

        <section className="settings-group">
          <h2 className="settings-group-name">Models</h2>
          <ModelCatalog />
        </section>
      </div>
    </main>
  );
}
