/**
 * What the window's page may ask of the shell it is in — as against the
 * server it talks to. When the window is onto another computer
 * (desktop/remote.ts), the server is over there and only this shell is
 * here: which computer the window is onto, pairing with another, and
 * carrying the window are this device's business, so they come here.
 *
 * Bundled to CommonJS on its own (scripts/build-main.ts): a sandboxed
 * preload gets `require("electron")` and nothing else.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ruriShell", {
  /** Which this is, for a page served by a ruri of another version. */
  version: 2,
  state: () => ipcRenderer.invoke("ruri:state"),
  peers: () => ipcRenderer.invoke("ruri:peers"),
  setUp: (target: unknown) => ipcRenderer.invoke("ruri:setup", target),
  /** Each step of a setup over SSH as the far side reports it; returns the
   *  way to stop listening. */
  onSetupStep: (listener: (step: string) => void) => {
    const heard = (_event: unknown, step: string) => listener(step);
    ipcRenderer.on("ruri:setup-step", heard);
    return () => ipcRenderer.off("ruri:setup-step", heard);
  },
  pairWords: (ask: unknown) => ipcRenderer.invoke("ruri:pair-words", ask),
  use: (hostId: string | null) => ipcRenderer.invoke("ruri:use", hostId),
  forget: (hostId: string) => ipcRenderer.invoke("ruri:forget", hostId),
  retry: () => ipcRenderer.invoke("ruri:retry"),
  windowDrag: (phase: string) => ipcRenderer.send("ruri:drag", phase),
});
