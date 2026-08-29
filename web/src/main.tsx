import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme, startThemeClock } from "./theme";
import "@fontsource-variable/space-grotesk";
import "./styles.css";

initTheme();
// and keep it in step, for a schedule that turns the page while you work
startThemeClock();
if (navigator.userAgent.includes("Electron")) document.body.classList.add("desktop");

// A file dropped outside a drop zone must never navigate the window to the
// file (which would blank the whole app); targeted handlers run first and
// this only eats what they didn't take.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

createRoot(document.getElementById("root")!).render(<App />);
