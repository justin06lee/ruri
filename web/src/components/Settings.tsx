import { useEffect, useState } from "react";
import { send, useRuri } from "../store";
import { applyTheme, getTheme, type Theme } from "../theme";

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
      </div>
    </div>
  );
}
