import { useEffect } from "react";
import { ChatPane } from "./components/ChatPane";
import { useRapidFire } from "./components/RapidFire";
import { Sidebar } from "./components/Sidebar";
import { connect } from "./store";

let connectedOnce = false;

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

  return (
    <div className="app">
      <Sidebar />
      <ChatPane key={showing ?? "active"} {...(showing ? { channelId: showing } : {})} rapid={rapid} />
    </div>
  );
}
