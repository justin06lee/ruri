import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (navigator.userAgent.includes("Electron")) document.body.classList.add("desktop");

createRoot(document.getElementById("root")!).render(<App />);
