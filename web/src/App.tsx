import { useEffect, useState } from "react";
import { ChatPane } from "./components/ChatPane";
import { Settings } from "./components/Settings";
import { useRapidFire } from "./components/RapidFire";
import { ProjectsPage } from "./components/HomeBoard";
import { Sidebar } from "./components/Sidebar";
import { Switcher } from "./components/Switcher";
import { prewarmMarkdown } from "./lib/markdownHtml";
import { HOME_ID } from "../../shared/protocol";
import { setPref } from "./prefs";
import { connect, useRuri } from "./store";

let connectedOnce = false;

/** How many events of each session to render ahead of being asked. */
const PREWARM_TAIL = 24;
/** How still the app has to be before it renders ahead. */
const PREWARM_QUIET_MS = 1200;

/**
 * Render the sessions you haven't opened yet, on frames with nothing else to
 * do. Markdown is cached by its own text, so this is the whole trick behind
 * a session opening instantly the first time you click it: by then its last
 * screenful is already HTML.
 *
 * It reads the whole transcript map, which changes on every event any
 * session emits — so it renders nothing itself and lives in its own leaf
 * component, rather than making the sidebar and the open conversation
 * re-render along with it several times a second during a turn.
 */
function usePrewarm(): void {
  const transcripts = useRuri((s) => s.transcripts);
  const activeId = useRuri((s) => s.activeId);
  // The map changes with every event of every session, several times a
  // second during a turn, and walking all of them to build a list of text
  // to pre-render is not something to do at that rate. Rendering ahead is
  // only ever worth doing when nothing is happening, so it waits for a
  // pause — and a turn in progress simply keeps pushing the pause back.
  const [quiet, setQuiet] = useState(transcripts);
  useEffect(() => {
    const timer = setTimeout(() => setQuiet(transcripts), PREWARM_QUIET_MS);
    return () => clearTimeout(timer);
  }, [transcripts]);

  useEffect(() => {
    const pending = Object.entries(quiet)
      .filter(([channelId]) => channelId !== activeId)
      .flatMap(([, events]) =>
        events
          .slice(-PREWARM_TAIL)
          .flatMap((event) => (event.kind === "assistant" || event.kind === "user" ? [event.text] : [])),
      );
    if (pending.length === 0) return;
    let index = 0;
    let handle = 0;
    const pass = (deadline?: IdleDeadline) => {
      while (index < pending.length && (!deadline || deadline.timeRemaining() > 6)) {
        prewarmMarkdown(pending[index]!);
        index += 1;
      }
      if (index >= pending.length) return;
      schedule();
    };
    const schedule = () => {
      handle =
        typeof requestIdleCallback === "function"
          ? requestIdleCallback(pass, { timeout: 4000 })
          : window.setTimeout(pass, 50);
    };
    schedule();
    return () => {
      if (!handle) return;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
  }, [quiet, activeId]);
}

function Prewarm(): null {
  usePrewarm();
  return null;
}

/** A field Tab belongs to: it moves between answers there, or completes
 *  in a shell. The composer's own box is not one — it has nothing to tab
 *  to, and it is where the caret sits whenever Home is up. */
function tabOwnedBy(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.matches(".composer-field textarea")) return false;
  return el.isContentEditable || el.matches("input, textarea, select");
}

/**
 * Tab flips between the Home agent and the projects page — the two
 * places you go to see everything at once, a key apart. Only from those
 * two, only with nothing else claiming the key: a menu that completes on
 * Tab (the composer's commands) has already taken it by the time it gets
 * here, and a field or a card standing over the page keeps it.
 */
function useHomeTabKey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (tabOwnedBy(document.activeElement)) return;
      if (document.querySelector('.viewer-overlay, .confirm-overlay, [role="dialog"]')) return;
      const s = useRuri.getState();
      if (s.settingsOpen || s.rapid) return;
      if (s.projectsOpen) {
        e.preventDefault();
        // to the agent itself, not whichever of Home's pages was up last:
        // the pane reads the remembered tab as it mounts, which is now
        setPref("ruri-home-tab", "chat");
        s.setActive(HOME_ID);
        // and the caret back in its box, so a thought left there on the
        // way over carries on where it was — once the pane is up
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            document.querySelector<HTMLTextAreaElement>(".composer-field textarea")?.focus(),
          ),
        );
      } else if (s.activeId === HOME_ID) {
        e.preventDefault();
        s.setProjectsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  useEffect(() => {
    if (!connectedOnce) {
      connectedOnce = true;
      connect();
    }
  }, []);

  // Rapid fire lives out here, above the pane it drives: the pane remounts on
  // every hand-off (fresh scroll, fresh composer, the fade replayed), and the
  // line has to outlive that.
  const rapid = useRapidFire();
  useHomeTabKey();
  const showing = rapid.on ? rapid.current : undefined;
  const settingsOpen = useRuri((s) => s.settingsOpen);
  const setSettingsOpen = useRuri((s) => s.setSettingsOpen);
  // the projects page takes the pane the way settings does: it is not a
  // chat, and nothing about a chat should be underneath it
  const projectsOpen = useRuri((s) => s.projectsOpen);

  return (
    <div className="app">
      <Prewarm />
      <Sidebar />
      <Switcher />
      {settingsOpen ? (
        <Settings onClose={() => setSettingsOpen(false)} />
      ) : projectsOpen ? (
        <main className="chat projects-pane">
          <ProjectsPage />
        </main>
      ) : (
        <ChatPane key={showing ?? "active"} {...(showing ? { channelId: showing } : {})} rapid={rapid} />
      )}
      {/* the hand-off card sits over the pane, not inside it: the pane
          remounts underneath while this is up, which is the point */}
      {rapid.intro && (
        <div className="rapid-intro" key={rapid.intro.name + (rapid.intro.title ?? "")}>
          <div className="rapid-intro-name">{rapid.intro.name}</div>
          {rapid.intro.title && <div className="rapid-intro-title">{rapid.intro.title}</div>}
        </div>
      )}
    </div>
  );
}
