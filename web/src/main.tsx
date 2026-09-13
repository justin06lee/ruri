import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installCopy } from "./copy";
import { installPressGuard } from "./press";
import { initTheme, startThemeClock } from "./theme";
import "@fontsource-variable/space-grotesk";
import "./styles.css";

initTheme();
// and keep it in step, for a schedule that turns the page while you work
startThemeClock();
if (navigator.userAgent.includes("Electron")) document.body.classList.add("desktop");
// a press that starts on a button ends on it, however far the button moves
installPressGuard();
// copying a reply puts the markdown back, numbers and all
installCopy();

// A file dropped outside a drop zone must never navigate the window to the
// file (which would blank the whole app); targeted handlers run first and
// this only eats what they didn't take.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// The typeface is a web font, and a page drawn before it arrives is drawn
// in a fallback and then redrawn — the flash at launch. The file is served
// from this machine, so waiting for it costs milliseconds; the wait is
// capped so a font that never comes cannot keep the window blank.
const FONT_WAIT_MS = 1500;
void Promise.race([
  document.fonts.load('1em "Space Grotesk Variable"').catch(() => []),
  new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
]).then(() => {
  createRoot(document.getElementById("root")!).render(<App />);
});
