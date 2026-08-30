import { useEffect } from "react";
import { ChatPane } from "./components/ChatPane";
import { useRapidFire } from "./components/RapidFire";
import { Sidebar } from "./components/Sidebar";
import { prewarmMarkdown } from "./markdown";
import { connect, useRuri } from "./store";

let connectedOnce = false;

/** How many events of each session to render ahead of being asked. */
const PREWARM_TAIL = 24;

/**
 * Render the sessions you haven't opened yet, on frames with nothing else to
 * do. Markdown is cached by its own text, so this is the whole trick behind
 * a session opening instantly the first time you click it: by then its last
 * screenful is already HTML.
 */
function usePrewarm(): void {
  const transcripts = useRuri((s) => s.transcripts);
  const activeId = useRuri((s) => s.activeId);
  useEffect(() => {
    const pending = Object.entries(transcripts)
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
  }, [transcripts, activeId]);
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
  usePrewarm();

  return (
    <div className="app">
      <Sidebar />
      <ChatPane key={showing ?? "active"} {...(showing ? { channelId: showing } : {})} rapid={rapid} />
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
