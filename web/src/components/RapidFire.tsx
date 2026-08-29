import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project, SessionInfo } from "../../../shared/protocol";
import { Composer, EventView, PermissionBanner } from "./ChatPane";
import { QuestionCard } from "./Questions";
import { Thinking } from "./Thinking";
import { useRuri } from "../store";

/**
 * Rapid fire: one card at a time, always the session that's ready for a
 * prompt. Send (or skip) and the next needy session slides in; a session
 * that finishes its turn rejoins the line at the back. Working sessions
 * stay out of sight — when everyone's busy, the page just waits.
 */

interface Entry {
  project: Project;
  session: SessionInfo;
}

export function RapidFire() {
  const projects = useRuri((s) => s.projects);
  const statuses = useRuri((s) => s.statuses);
  const transcripts = useRuri((s) => s.transcripts);
  const allPermissions = useRuri((s) => s.permissions);
  const setRapid = useRuri((s) => s.setRapid);

  // sidebar order: starred first, then the rest
  const entries: Entry[] = [
    ...projects.filter((p) => p.starred),
    ...projects.filter((p) => !p.starred),
  ].flatMap((project) => project.sessions.map((session) => ({ project, session })));

  // The line of sessions awaiting a prompt: order is arrival order — the
  // initial sweep is sidebar order, finished turns append at the back.
  const [queue, setQueue] = useState<string[]>([]);
  // Just-prompted sessions, held out of the line until their "working"
  // status lands (or a beat passes, if the send failed silently).
  const sentRef = useRef(new Set<string>());

  useEffect(() => {
    setQueue((prev) => {
      for (const id of [...sentRef.current]) {
        if (statuses[id] === "working") sentRef.current.delete(id);
      }
      const eligible = entries
        .map((e) => e.session.id)
        .filter((id) => (statuses[id] ?? "idle") !== "working" && !sentRef.current.has(id));
      const kept = prev.filter((id) => eligible.includes(id));
      const added = eligible.filter((id) => !kept.includes(id));
      return [...kept, ...added];
    });
    // statuses/projects identity changes drive the sync
  }, [statuses, projects]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = queue[0];
  const entry = entries.find((e) => e.session.id === current);

  // Being shown in the line counts as read.
  useEffect(() => {
    if (!current) return;
    if (useRuri.getState().unread[current]) {
      useRuri.setState((s) => ({ unread: { ...s.unread, [current]: false } }));
    }
  }, [current]);

  const advance = () => {
    if (!current) return;
    sentRef.current.add(current);
    setQueue((q) => q.slice(1));
    // a send that never reaches "working" (dropped socket, refused) frees
    // the session back into the line after a beat
    const id = current;
    setTimeout(() => {
      if (sentRef.current.has(id) && useRuri.getState().statuses[id] !== "working") {
        sentRef.current.delete(id);
      }
    }, 4000);
  };

  const skip = () => setQueue((q) => (q.length > 1 ? [...q.slice(1), q[0]!] : q));

  // A card opens at the end of the exchange, not its beginning — what you're
  // answering is the last thing the session said, sitting right above the
  // box you type in. The view follows new content while you're at the
  // bottom; scroll up to read and it stays where you left it.
  const contextRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const bottom = () => {
    const el = contextRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const onScroll = () => {
    const el = contextRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const workingCount = entries.filter((e) => statuses[e.session.id] === "working").length;
  const transcript = current ? (transcripts[current] ?? []) : [];
  // context = the session's last exchange (its latest prompt → result)
  const lastUser = transcript.map((e) => e.kind).lastIndexOf("user");
  const tail = lastUser === -1 ? transcript : transcript.slice(lastUser);
  const permissions = allPermissions.filter((p) => p.projectId === current);
  const status = current ? (statuses[current] ?? "idle") : "idle";

  // a new card starts pinned, at the bottom
  useLayoutEffect(() => {
    pinnedRef.current = true;
    bottom();
  }, [current]);
  useLayoutEffect(() => {
    if (pinnedRef.current) bottom();
  }, [tail.length, permissions.length, status]);

  // The exchange keeps growing after that first scroll — images decode,
  // markdown settles, diffs lay out — so while pinned, any growth re-bottoms
  // the view instead of leaving it stranded partway up. The box itself is
  // watched too: a prompt growing to several lines takes its height out of
  // the view, and the newest text would otherwise slide under the composer.
  const growth = useRef<ResizeObserver | null>(null);
  const observeContext = useCallback((node: HTMLDivElement | null) => {
    growth.current?.disconnect();
    growth.current = null;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) bottom();
    });
    observer.observe(node);
    // the scroll box — read off the node, since a parent's ref isn't set yet
    if (node.parentElement) observer.observe(node.parentElement);
    growth.current = observer;
  }, []);
  useEffect(() => () => growth.current?.disconnect(), []);

  return (
    <main className="chat rapid">
      <header className="chat-header">
        <div className="chat-id">
          <div className="chat-title">
            Rapid fire
            <span className="chat-session-title">
              {" "}
              · {queue.length} ready · {workingCount} working
            </span>
          </div>
        </div>
        <div className="header-controls">
          <button className="icon-button" title="Leave rapid fire" onClick={() => setRapid(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </header>

      {entry ? (
        <div className="rapid-card" key={entry.session.id}>
          <div className="rapid-session">
            <span className="rapid-project">{entry.project.name}</span>
            {entry.session.title && <span className="rapid-role">· {entry.session.title}</span>}
            {queue.length > 1 && (
              <button className="rapid-skip" title="Pass — send it to the back of the line" onClick={skip}>
                skip
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            )}
          </div>
          <div className="rapid-context" ref={contextRef} onScroll={onScroll}>
            <div className="rapid-context-inner" ref={observeContext}>
              {tail.length === 0 ? (
                <div className="rapid-fresh">Fresh session — give it its first prompt.</div>
              ) : (
                tail.map((event) => (
                  <EventView key={event.id} event={event} project={entry.project} channelId={entry.session.id} />
                ))
              )}
              {permissions.map((request) =>
                // same rule as the chat: a question gets the picker, not the card
                request.kind === "question" ? (
                  <QuestionCard key={request.requestId} request={request} />
                ) : (
                  <PermissionBanner key={request.requestId} request={request} />
                ),
              )}
            </div>
          </div>
          <Composer
            key={entry.session.id}
            channelId={entry.session.id}
            project={entry.project}
            busy={status === "permission"}
            onSent={advance}
          />
        </div>
      ) : (
        <div className="rapid-empty">
          <Thinking />
          <div className="rapid-empty-text">
            {entries.length === 0
              ? "No sessions open — ask Home to open some projects first."
              : "Everyone's working. The next session appears the moment it finishes."}
          </div>
        </div>
      )}
    </main>
  );
}
