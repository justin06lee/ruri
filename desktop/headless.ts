/** No screen to draw on: Linux with neither X nor Wayland — a computer
 *  reached over SSH, a service started at boot before anyone logs in. */
export const HEADLESS =
  process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"];

/**
 * What every window is made with when there is no screen. On Linux a
 * framed window's title bar is drawn from the GTK theme, and with no screen
 * GTK is never loaded — but Electron asks it for the frame anyway, through
 * a function pointer that was never filled in, and the app dies (SIGSEGV,
 * a call to address 0) the moment its first window is made. A frameless
 * window asks GTK for nothing, and one nobody can see has no title bar to
 * miss.
 */
export const HEADLESS_WINDOW: { frame?: false } = HEADLESS ? { frame: false } : {};
