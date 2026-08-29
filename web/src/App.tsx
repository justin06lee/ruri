import { useEffect } from "react";
import { ChatPane } from "./components/ChatPane";
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

  return (
    <div className="app">
      <Sidebar />
      <ChatPane />
    </div>
  );
}
