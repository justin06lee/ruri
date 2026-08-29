import { useEffect, useRef, useState } from "react";
import type { ProjectBrief } from "../../../shared/protocol";
import { fileKind } from "./Attachments";
import { fileToBase64 } from "../lib/files";
import { HTTP_BASE, send, useRuri } from "../store";

/**
 * The catch-up page: this project in as few lines as it can be said, plus
 * screenshots of what it looks like.
 *
 * It's for the model that has never seen the project — a fresh session, a
 * harness you just switched to. "Catch a model up" drops the whole thing
 * into the composer with the screenshots attached, so the first prompt of a
 * new session costs a paragraph instead of a transcript.
 *
 * The small model keeps the words current as turns finish, merging what
 * belongs together; every line here is editable by hand, and a hand edit is
 * just as authoritative.
 */

const EMPTY: ProjectBrief = { description: "", features: [], shots: [] };

export function Brief({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const stored = useRuri((s) => s.briefs[projectId]) ?? EMPTY;
  const projectName = useRuri(
    (s) => s.projects.find((p) => p.sessions.some((x) => x.id === projectId))?.name ?? "this project",
  );

  // Edits live here while you type and go to the server on the next beat —
  // the same treatment the composer's draft gets.
  const [description, setDescription] = useState(stored.description);
  const [features, setFeatures] = useState<string[]>(stored.features);
  const dirty = useRef(false);
  const [dragOver, setDragOver] = useState(false);

  // A brief the small model rewrote under you wins, unless you're mid-edit.
  useEffect(() => {
    if (dirty.current) return;
    setDescription(stored.description);
    setFeatures(stored.features);
  }, [stored]);

  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => {
      dirty.current = false;
      send({
        type: "brief_write",
        projectId,
        description: description.trim(),
        features: features.map((line) => line.trim()).filter(Boolean),
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [description, features, projectId]);

  const edit = (next: () => void) => {
    dirty.current = true;
    next();
  };

  const setFeature = (index: number, text: string) =>
    edit(() => setFeatures(features.map((line, i) => (i === index ? text : line))));

  const addFeature = () => edit(() => setFeatures([...features, ""]));

  const removeFeature = (index: number) =>
    edit(() => setFeatures(features.filter((_, i) => i !== index)));

  const pin = async (files: FileList | File[]) => {
    for (const file of [...files]) {
      if (fileKind(file) !== "image") continue;
      send({
        type: "brief_pin",
        projectId,
        upload: {
          id: `${Date.now()}-${file.name}`,
          kind: "image",
          mediaType: file.type,
          name: file.name,
          n: stored.shots.length + 1,
          data: await fileToBase64(file),
        },
      });
    }
  };

  return (
    <section className="tracker-page brief-page">
      <div className="tracker-inner">
        <div className="tracker-head">
          <span className="tracker-title">Catch up</span>
          <span className="tracker-sub">{projectName}</span>
          <button className="icon-button" title="Back to the chat" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <p className="brief-note">
          What this project is, in as few lines as it can be said. The small model keeps it current;
          edit any line and it stays edited.
        </p>

        <textarea
          className="brief-description"
          rows={2}
          placeholder="One sentence: what this project is."
          value={description}
          onChange={(e) => edit(() => setDescription(e.target.value))}
        />

        <div className="brief-features">
          {features.map((line, index) => (
            <div className="brief-feature" key={index}>
              <span className="brief-bullet">—</span>
              <input
                value={line}
                placeholder="One capability, in a handful of words"
                onChange={(e) => setFeature(index, e.target.value)}
              />
              <button
                className="icon-button"
                title="Drop this line"
                onClick={() => removeFeature(index)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
          <button className="ghost brief-add" onClick={addFeature}>
            Add a line
          </button>
        </div>

        <div
          className={`brief-shots ${dragOver ? "drag-over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void pin(e.dataTransfer.files);
          }}
        >
          {stored.shots.map((shot) => (
            <div className="brief-shot" key={shot.id}>
              <img src={`${HTTP_BASE}${shot.url}`} alt={shot.name} />
              <button
                className="icon-button brief-unpin"
                title="Unpin this screenshot"
                onClick={() => send({ type: "brief_unpin", projectId, shotId: shot.id })}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          ))}
          <label className="brief-drop">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                if (e.target.files) void pin(e.target.files);
                e.target.value = "";
              }}
            />
            <span>{stored.shots.length ? "Add a screenshot" : "Drop screenshots of the main pages"}</span>
          </label>
        </div>

        <button
          className="brief-send"
          title="Put the brief and its screenshots in the composer, ready to send"
          onClick={() => {
            send({ type: "brief_compose", projectId });
            onClose();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M4 12h14M13 6l6 6-6 6" />
          </svg>
          Catch a model up
        </button>
      </div>
    </section>
  );
}
