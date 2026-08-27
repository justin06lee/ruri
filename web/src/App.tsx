import { useEffect } from "react";
import { ChatPane } from "./components/ChatPane";
import { RapidFire } from "./components/RapidFire";
import { Sidebar } from "./components/Sidebar";
import { connect, useRuri } from "./store";

let connectedOnce = false;

export function App() {
  const rapid = useRuri((s) => s.rapid);

  useEffect(() => {
    if (!connectedOnce) {
      connectedOnce = true;
      connect();
    }
  }, []);

  return (
    <div className="app">
      <Sidebar />
      {rapid ? <RapidFire /> : <ChatPane />}
    </div>
  );
}
