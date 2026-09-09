import { useEffect, useMemo, useRef, useState } from "react";
import { HOME_ID } from "../../../shared/protocol";
import { send, useRuri } from "../store";

/**
 * The switcher: tap the right Option key (or ⌘K) and a search stands over
 * the app. Type a few letters of a project, a session, or a place — Home,
 * Rapid fire, Settings — and Enter goes to the best match. The best match
 * is also written into the box ahead of the caret, greyed, the way
 * Spotlight completes a name; Tab or → takes the completion, arrows move
 * down the list, Escape puts it away.
 *
 * It is the right Option key *alone*: a press with nothing else during it.
 * Option held for a shortcut (⌥→ across a word, ⌥⌘I for the inspector)
 * is not a tap, and opens nothing.
 */

type Kind = "place" | "project" | "session";

interface Entry {
  id: string;
  kind: Kind;
  /** What is searched and completed. */
  name: string;
  /** Where it is — the project's path, the session's project. */
  where?: string;
  go(): void;
}

/**
 * How well `text` answers `query`, or null for not at all. A name that
 * starts with the query beats one with a word that does, which beats one
 * containing it, which beats the letters merely appearing in order — and
 * shorter names win ties, since they are the closer match.
 */
function score(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  const words = t.split(/[\s/_.-]+/);
  if (words.some((word) => word.startsWith(q))) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 600 - at - t.length;
  // in order, with gaps: each gap costs, so "fui" finds "Frontend UI"
  // ahead of some longer thing the letters happen to be scattered through
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j += 1) {
    if (t[j] !== q[i]) continue;
    if (last >= 0 && j !== last + 1) gaps += 1;
    last = j;
    i += 1;
  }
  if (i < q.length) return null;
  return 300 - gaps * 20 - t.length;
}

const KIND_LABEL: Record<Kind, string> = { place: "go", project: "project", session: "chat" };

/** A project's own page name, for the list and the completion. */
function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

export function Switcher() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Whoever had focus when the switcher opened gets it back after. */
  const before = useRef<HTMLElement | null>(null);
  const projects = useRuri((s) => s.projects);
  const activeId = useRuri((s) => s.activeId);
  const setActive = useRuri((s) => s.setActive);
  const setRapid = useRuri((s) => s.setRapid);
  const setSettingsOpen = useRuri((s) => s.setSettingsOpen);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [
      { id: "home", kind: "place", name: "Home", where: "the orchestrator", go: () => setActive(HOME_ID) },
      { id: "rapid", kind: "place", name: "Rapid fire", where: "prompt whichever session is ready", go: () => setRapid(true) },
      { id: "settings", kind: "place", name: "Settings", where: "themes, models, the vault", go: () => setSettingsOpen(true) },
    ];
    for (const project of projects) {
      list.push({
        id: `project:${project.id}`,
        kind: "project",
        name: project.name,
        where: shortPath(project.path),
        go: () => {
          const first = project.sessions[0];
          if (first) {
            setActive(first.id);
            return;
          }
          // no chats yet: open one, and go to it when it arrives
          send({ type: "new_session", projectId: project.id });
          const unsubscribe = useRuri.subscribe((s) => {
            const fresh = s.projects.find((p) => p.id === project.id)?.sessions[0];
            if (!fresh) return;
            unsubscribe();
            s.setActive(fresh.id);
          });
        },
      });
      for (const session of project.sessions) {
        list.push({
          id: session.id,
          kind: "session",
          name: session.title ?? "new session",
          where: project.name,
          go: () => setActive(session.id),
        });
      }
    }
    return list;
  }, [projects, setActive, setRapid, setSettingsOpen]);

  const results = useMemo(() => {
    const q = query.trim();
    const scored = entries.flatMap((entry) => {
      const own = score(q, entry.name);
      const whereScore = entry.where ? score(q, entry.where) : null;
      // a match on where it is counts, but for less than one on the name
      const best = Math.max(own ?? -Infinity, whereScore === null ? -Infinity : whereScore - 400);
      if (best === -Infinity) return [];
      return [{ entry, best }];
    });
    if (q) scored.sort((a, b) => b.best - a.best);
    return scored.map((s) => s.entry).filter((entry) => entry.id !== activeId);
  }, [entries, query, activeId]);

  const picked = results[Math.min(cursor, Math.max(results.length - 1, 0))];
  /** The rest of the best name, greyed after what has been typed. */
  const completion =
    picked && query && picked.name.toLowerCase().startsWith(query.toLowerCase())
      ? picked.name.slice(query.length)
      : "";

  const close = () => {
    setOpen(false);
    setQuery("");
    setCursor(0);
    const back = before.current;
    before.current = null;
    requestAnimationFrame(() => back?.focus());
  };
  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    close();
    entry.go();
    // wherever it went, the box to type in is the thing to be on — the
    // chat's composer, once it is up
    before.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".composer-box textarea")?.focus()),
    );
  };

  // The right Option key, tapped: down, then up, with no other key between.
  // ⌘K as well, since hands know it.
  useEffect(() => {
    let armed = false;
    const onDown = (e: KeyboardEvent) => {
      if (e.code === "AltRight" && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        armed = true;
        return;
      }
      armed = false;
      if (e.key.toLowerCase() === "k" && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        toggle();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "AltRight" || !armed) return;
      armed = false;
      toggle();
    };
    const onBlur = () => {
      armed = false;
    };
    const toggle = () => {
      setOpen((was) => {
        if (was) {
          // through close(), so focus goes back where it was
          queueMicrotask(close);
          return was;
        }
        before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return true;
      });
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // the picked row stays in view as the arrows move down the list
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".switcher-row.picked")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, results]);

  if (!open) return null;

  return (
    <div className="switcher-veil" onMouseDown={close}>
      <div className="switcher" role="dialog" aria-label="Go to" onMouseDown={(e) => e.stopPropagation()}>
        <div className="switcher-field">
          <svg className="switcher-glass" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <div className="switcher-box">
            {/* the completion is drawn under the input, after the typed
                text — the same font, so it sits exactly where the caret is */}
            <div className="switcher-ghost" aria-hidden>
              <span className="switcher-typed">{query}</span>
              <span className="switcher-rest">{completion}</span>
            </div>
            <input
              ref={inputRef}
              className="switcher-input"
              value={query}
              placeholder="Go to a project, a chat, a place…"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(picked);
                } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
                  e.preventDefault();
                  setCursor((c) => Math.min(c + 1, results.length - 1));
                } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
                  e.preventDefault();
                  setCursor((c) => Math.max(c - 1, 0));
                } else if (
                  completion &&
                  (e.key === "Tab" ||
                    (e.key === "ArrowRight" && e.currentTarget.selectionStart === query.length))
                ) {
                  e.preventDefault();
                  setQuery(picked!.name);
                }
              }}
            />
          </div>
          <kbd className="switcher-key">esc</kbd>
        </div>
        <div className="switcher-list" ref={listRef}>
          {results.length === 0 && <div className="switcher-empty">nothing called that</div>}
          {results.map((entry, i) => (
            <button
              key={entry.id}
              className={`switcher-row ${entry === picked ? "picked" : ""}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(entry)}
            >
              <span className="switcher-name">{entry.name}</span>
              {entry.where && <span className="switcher-where">{entry.where}</span>}
              <span className="switcher-kind">{KIND_LABEL[entry.kind]}</span>
            </button>
          ))}
        </div>
        <div className="switcher-foot">
          <span><kbd>↑↓</kbd> move</span>
          <span><kbd>⇥</kbd> complete</span>
          <span><kbd>⏎</kbd> go</span>
          <span className="switcher-foot-key"><kbd>⌥</kbd> right option opens this</span>
        </div>
      </div>
    </div>
  );
}
