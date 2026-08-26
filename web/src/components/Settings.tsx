import { useEffect, useState } from "react";
import { send, useRuri } from "../store";
import { applyTheme, getTheme, type Theme } from "../theme";

const STAR_PATH = "M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9 2.9-6z";

/**
 * The device-wide model catalog: every model every installed harness can
 * serve, searchable; starring pins a model into the composer's picker.
 */
function ModelCatalog() {
  const models = useRuri((s) => s.models);
  const starredIds = useRuri((s) => s.starredModels);
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
          return (
            <div key={m.value} className="model-row">
              <button
                className={`model-star ${starred ? "on" : ""}`}
                title={starred ? "Unstar — remove from the picker" : "Star — pin into the picker"}
                onClick={() => send({ type: "toggle_model_star", model: m.value })}
              >
                <svg viewBox="0 0 24 24" fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
                  <path d={STAR_PATH} />
                </svg>
              </button>
              <span className="model-name" title={m.value}>{m.displayName}</span>
              <span className="model-tag">{m.providerLabel ?? "Claude Code"}</span>
            </div>
          );
        })}
      </div>
      <div className="model-hint">Starred models are what the composer's model picker offers.</div>
    </div>
  );
}

/** The settings panel: theme, workspace root — the little options live here. */
export function Settings({ onClose }: { onClose(): void }) {
  const workspaceDir = useRuri((s) => s.workspaceDir);
  const musicDir = useRuri((s) => s.musicDir);
  const canPickFolder = useRuri((s) => s.canPickFolder);
  const [theme, setTheme] = useState<Theme>(getTheme);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickTheme = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };

  return (
    <div
      className="settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-card">
        <div className="settings-head">
          <span className="settings-title">Settings</span>
          <button className="icon-button" title="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">Theme</span>
          <div className="seg">
            <button
              className={`seg-option ${theme === "light" ? "active" : ""}`}
              onClick={() => pickTheme("light")}
            >
              Light
            </button>
            <button
              className={`seg-option ${theme === "dark" ? "active" : ""}`}
              onClick={() => pickTheme("dark")}
            >
              Dark
            </button>
          </div>
        </div>

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

        <div className="settings-row models-row">
          <span className="settings-label">Models</span>
          <ModelCatalog />
        </div>
      </div>
    </div>
  );
}
