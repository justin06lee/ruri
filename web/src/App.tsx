import { useEffect, useState } from "react";
import { ChatPane } from "./components/ChatPane";
import { Settings } from "./components/Settings";
import { useRapidFire } from "./components/RapidFire";
import { Sidebar } from "./components/Sidebar";
import { prewarmMarkdown } from "./markdown";
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
          .flatMap((event) =>
            event.kind === "assistant" || event.kind === "user" ? [event.text] : [],
          ),
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
  const showing = rapid.on ? rapid.current : undefined;
  const settingsOpen = useRuri((s) => s.settingsOpen);
  const setSettingsOpen = useRuri((s) => s.setSettingsOpen);

  return (
    <div className="app">
      <Prewarm />
      <Sidebar />
      {settingsOpen ? (
        <Settings onClose={() => setSettingsOpen(false)} />
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
