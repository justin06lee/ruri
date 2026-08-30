/**
 * The three pages ruri is drawn on, and the clock that can turn them.
 *
 * Light is paper, dark is the same page at night, and ember is the same page
 * by firelight — warm through and through, with no blue channel to speak of,
 * for the hours when a bright screen is the thing keeping you up. The
 * schedule gives each one a time it takes over; picking one by hand turns
 * the schedule off, since that pick is you overruling the clock.
 *
 * All of it is per machine — the same reason the theme already was: it's
 * about the room you're in, not the project you're on. Kept through
 * ./prefs, which is localStorage in front of the server's copy, so a
 * relaunch finds the theme you left on.
 */
import { getPref, setPref, watchPref } from "./prefs";

export type Theme = "light" | "dark" | "ember";

export const THEMES: Theme[] = ["light", "dark", "ember"];

/** Minutes past midnight each theme takes over, and whether the clock runs. */
export interface ThemeSchedule {
  on: boolean;
  light: number;
  dark: number;
  ember: number;
}

const KEY = "ruri-theme";
const SCHEDULE_KEY = "ruri-theme-schedule";

/** Morning light, evening dark, night ember — the hours most people mean. */
export const DEFAULT_SCHEDULE: ThemeSchedule = {
  on: false,
  light: 5 * 60,
  dark: 14 * 60,
  ember: 18 * 60,
};

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "ember";
}

/** The theme last picked by hand. */
export function getTheme(): Theme {
  const saved = getPref(KEY);
  return isTheme(saved) ? saved : "light";
}

export function getSchedule(): ThemeSchedule {
  try {
    const raw = JSON.parse(getPref(SCHEDULE_KEY) ?? "null") as Partial<ThemeSchedule>;
    if (!raw || typeof raw !== "object") return DEFAULT_SCHEDULE;
    const minutes = (value: unknown, fallback: number) =>
      typeof value === "number" && value >= 0 && value < 1440 ? Math.round(value) : fallback;
    return {
      on: raw.on === true,
      light: minutes(raw.light, DEFAULT_SCHEDULE.light),
      dark: minutes(raw.dark, DEFAULT_SCHEDULE.dark),
      ember: minutes(raw.ember, DEFAULT_SCHEDULE.ember),
    };
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

export function saveSchedule(schedule: ThemeSchedule): void {
  setPref(SCHEDULE_KEY, JSON.stringify(schedule));
}

/** Which theme the schedule puts at a given minute of the day. */
export function themeAt(minuteOfDay: number, schedule: ThemeSchedule): Theme {
  const marks: Array<[Theme, number]> = [
    ["light", schedule.light],
    ["dark", schedule.dark],
    ["ember", schedule.ember],
  ].sort((a, b) => (a[1] as number) - (b[1] as number)) as Array<[Theme, number]>;
  // before the first boundary of the day you're still inside the last one,
  // which started yesterday
  let pick = marks[marks.length - 1]![0];
  for (const [theme, at] of marks) if (minuteOfDay >= at) pick = theme;
  return pick;
}

function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** The theme that should be on screen right now, clock and all. */
export function currentTheme(): Theme {
  const schedule = getSchedule();
  return schedule.on ? themeAt(nowMinutes(), schedule) : getTheme();
}

/** Paint a theme. `remember` marks it as the hand-picked one. */
export function applyTheme(theme: Theme, remember = true): void {
  document.documentElement.dataset["theme"] = theme;
  if (!remember) return;
  setPref(KEY, theme);
}

/** Apply whatever is due before first paint. */
export function initTheme(): void {
  document.documentElement.dataset["theme"] = currentTheme();
  // The window's own copy can be empty — a machine that has never run a
  // build that kept these, or a launch that had to fall back to another
  // port. The snapshot brings the real one a moment later, and the page
  // turns over then rather than staying on the wrong theme all session.
  const restore = () => {
    const due = currentTheme();
    if (document.documentElement.dataset["theme"] !== due) applyTheme(due, false);
  };
  watchPref(KEY, restore);
  watchPref(SCHEDULE_KEY, restore);
}

/**
 * Keep the page in step with the clock while the app is open. Half a minute
 * is fine — a boundary you cross is a boundary you're not watching — and a
 * window coming back to the front checks straight away.
 */
export function startThemeClock(): () => void {
  const tick = () => {
    const due = currentTheme();
    if (document.documentElement.dataset["theme"] !== due) applyTheme(due, false);
  };
  const timer = setInterval(tick, 30_000);
  document.addEventListener("visibilitychange", tick);
  window.addEventListener("focus", tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", tick);
    window.removeEventListener("focus", tick);
  };
}
