import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "./theme";
import "@fontsource-variable/space-grotesk";
import "./styles.css";

initTheme();
if (navigator.userAgent.includes("Electron")) document.body.classList.add("desktop");

createRoot(document.getElementById("root")!).render(<App />);
