import { useEffect, useState } from "react";
import type { SkillInfo } from "../../../shared/protocol";
import { Markdown } from "../markdown";
import { send, useRuri } from "../store";

/**
 * Skills: the folders of instructions a harness reads before it works, in
 * their two scopes — everywhere on this machine (`~/.claude/skills`) and
 * this project only (`<project>/.claude/skills`).
 *
 * ruri is not the installer here; `bmo` is. This page is the view over what
 * bmo and the filesystem already hold: what's installed, where it came from,
 * which scope it's in, and the one thing neither of them has a word for —
 * off. A skill turned off moves to a sibling `skills-off/` folder, out of
 * the tree the harness scans, and comes straight back when it's turned on.
 */

function Row({ skill, projectId }: { skill: SkillInfo; projectId?: string }) {
  const busy = useRuri((s) => s.skillsBusy);
  return (
    <div className={`skill-row ${skill.enabled ? "" : "off"}`}>
      <button
        className={`skill-switch ${skill.enabled ? "on" : ""}`}
        disabled={busy}
        title={skill.enabled ? "Turn it off — parked, not deleted" : "Turn it back on"}
        onClick={() =>
          send({
            type: "skill_toggle",
            ...(projectId ? { projectId } : {}),
            scope: skill.scope,
            name: skill.name,
            on: !skill.enabled,
          })
        }
      >
        <span className="skill-knob" />
      </button>
      <button
        className="skill-body"
        title="Read it"
        onClick={() =>
          send({
            type: "skill_read",
            ...(projectId ? { projectId } : {}),
            scope: skill.scope,
            name: skill.name,
          })
        }
      >
        <div className="skill-line">
          <span className="skill-name">{skill.name}</span>
          {skill.source && <span className="skill-source">{skill.source}</span>}
        </div>
        <p className="skill-desc" title={skill.path}>
          {skill.description || "no description"}
        </p>
      </button>
      <button
        className="icon-button"
        disabled={busy}
        title="Uninstall (bmo remove)"
        onClick={() =>
          send({
            type: "skill_remove",
            ...(projectId ? { projectId } : {}),
            scope: skill.scope,
            name: skill.name,
          })
        }
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

/** A skill's own words, rendered — not the file, the instructions. */
function SkillReader() {
  const open = useRuri((s) => s.skillBody);
  const close = useRuri((s) => s.closeSkillBody);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  return (
    <div
      className="skill-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="skill-sheet">
        <div className="skill-sheet-head">
          <span className="skill-sheet-name">{open.name}</span>
          <button className="icon-button" title="Close" onClick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="skill-sheet-body">
          <Markdown text={open.body} />
        </div>
      </div>
    </div>
  );
}

export function Skills({ projectId }: { projectId?: string }) {
  const skills = useRuri((s) => s.skills);
  const busy = useRuri((s) => s.skillsBusy);
  const note = useRuri((s) => s.skillsNote);
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");

  // the filesystem is the truth, so it gets re-read every time this opens
  useEffect(() => {
    send({ type: "skills_refresh", ...(projectId ? { projectId } : {}) });
  }, [projectId]);

  const install = () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    send({
      type: "skill_install",
      ...(projectId ? { projectId } : {}),
      scope: projectId ? scope : "global",
      source: trimmed,
    });
    setSource("");
  };

  const global = skills.filter((s) => s.scope === "global");
  const local = skills.filter((s) => s.scope === "project");

  return (
    <section className="board-page">
      <div className="board-inner">
        <div className="board-head">
          <span className="board-title">Skills</span>
          <span className="board-sub">
            {skills.filter((s) => s.enabled).length} on · {skills.length} installed
          </span>
          <button
            className="ghost"
            disabled={busy}
            title="bmo update — pull whatever the sources changed"
            onClick={() => send({ type: "skill_update", ...(projectId ? { projectId } : {}) })}
          >
            Update all
          </button>
        </div>

        <div className="skill-install">
          <input
            placeholder="user/repo, a folder, a zip, a url…"
            value={source}
            disabled={busy}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") install();
            }}
          />
          {projectId && (
            <div className="seg">
              {(["project", "global"] as const).map((option) => (
                <button
                  key={option}
                  className={`seg-option ${scope === option ? "active" : ""}`}
                  onClick={() => setScope(option)}
                >
                  {option === "project" ? "This project" : "Everywhere"}
                </button>
              ))}
            </div>
          )}
          <button className="ghost" disabled={busy || !source.trim()} onClick={install}>
            {busy ? "Working…" : "Install"}
          </button>
        </div>
        {note && <div className="skill-note">{note}</div>}

        <div className="skill-group">
          <div className="skill-group-head">Everywhere</div>
          {global.length === 0 && <div className="board-empty">No global skills installed.</div>}
          {global.map((skill) => (
            <Row key={`g/${skill.name}`} skill={skill} {...(projectId ? { projectId } : {})} />
          ))}
        </div>

        <div className="skill-group">
          <div className="skill-group-head">Just this project</div>
          {local.length === 0 && (
            <div className="board-empty">
              None yet. A skill installed here lives in the repo at{" "}
              <code>.claude/skills/</code> and travels with it.
            </div>
          )}
          {local.map((skill) => (
            <Row key={`p/${skill.name}`} skill={skill} {...(projectId ? { projectId } : {})} />
          ))}
        </div>
      </div>
      <SkillReader />
    </section>
  );
}
