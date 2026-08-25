/** Light/dark theme, persisted per machine. Light (paper) is the default. */

export type Theme = "light" | "dark";

const KEY = "ruri-theme";

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode etc. — theme just won't persist
  }
}

/** Apply the saved theme before first paint. */
export function initTheme(): void {
  document.documentElement.dataset["theme"] = getTheme();
}
