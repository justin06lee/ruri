import type { Theme } from "../theme";
import { type Animate, EFFECTS, type HoverEffect, SPEED_MAX, SPEED_MIN } from "./effects";

export * from "./effects";

/**
 * The peek band's shape, and nothing live: what a picture in it is, the
 * hovers it can have, the band a fresh install shows, and a stored band
 * read back — checked, since it comes off disk. The band as the window
 * holds it (and the pictures' bytes) is ../band.ts.
 */

/** Wide as the sidebar, tall as the titlebar: the box the band fills. */
export const BAND_W = 264;
export const BAND_H = 46;

/** Enough for any band worth having, and well inside a preference's size. */
export const MAX_PICTURES = 16;

export interface BandPicture {
  id: string;
  /** /peek/<name>.webp for the built-in pictures, /uploads/<file> for the user's. */
  src: string;
  /** Shown instead while the pointer is on it — played from the start if
   *  it moves. */
  hoverSrc?: string;
  /** Left edge, px from the band's left. */
  x: number;
  /** How far down the band it starts, px — negative starts above it. */
  drop: number;
  /** Rendered width, px; the height follows the picture. */
  w: number;
  effect: HoverEffect;
  /** The effect's strength, in EFFECTS[effect].unit. */
  amount: number;
  /** ms — see EffectSpec.speed. */
  speed: number;
  animate: Animate;
  /** Swap ink and paper with the dark themes, the way line art should. */
  invert: boolean;
  /** Mirrored left to right. */
  flip: boolean;
  /** Shown only on these themes — absent, it is on all of them. */
  themes?: Theme[];
}

export interface Band {
  /** Back to front: a later picture sits over an earlier one. */
  pictures: BandPicture[];
}

/** Every theme, in the order the editor lists them. */
export const BAND_THEMES: readonly Theme[] = ["light", "dark", "ember"];

/** Classes that take a picture off the themes it is not kept to —
 *  styles.css hides `.not-<theme>` while that theme is on. */
export function offThemes(picture: Pick<BandPicture, "themes">): string {
  const on = picture.themes;
  return on
    ? BAND_THEMES.filter((theme) => !on.includes(theme))
        .map((theme) => ` not-${theme}`)
        .join("")
    : "";
}

/** One of the built-in pictures, where the band a fresh install shows has
 *  it: the whole band wide, its sky across the title bar. */
function builtin(id: string, theme: Theme): BandPicture {
  return {
    id,
    src: `/peek/${id}.webp`,
    x: -10,
    drop: -24,
    w: 276,
    effect: "none",
    amount: 0,
    speed: EFFECTS.none.speed,
    animate: "always",
    invert: false,
    flip: false,
    themes: [theme],
  };
}

/** The band a fresh install shows: the one mountain path, as each theme
 *  has it — by day on light, under the stars on dark, at sunset on ember. */
export function defaultBand(): Band {
  return { pictures: [builtin("day", "light"), builtin("night", "dark"), builtin("ember", "ember")] };
}

/* ── reading it back ─────────────────────────────────────────────── */

/** Only pictures ruri serves itself: the built-in ones and uploads. */
const SRC = /^\/(peek\/(day|night|ember)\.webp|uploads\/[A-Za-z0-9._-]+)$/;

/** The themes a stored picture keeps to, or none to say every theme. */
function readThemes(raw: unknown): Theme[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const themes = BAND_THEMES.filter((theme) => raw.includes(theme));
  return themes.length > 0 && themes.length < BAND_THEMES.length ? themes : undefined;
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;

function readPicture(raw: unknown): BandPicture | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p["src"] !== "string" || !SRC.test(p["src"])) return null;
  const effect: HoverEffect =
    typeof p["effect"] === "string" && p["effect"] in EFFECTS ? (p["effect"] as HoverEffect) : "none";
  const spec = EFFECTS[effect];
  const animate: Animate = p["animate"] === "hover" || p["animate"] === "still" ? p["animate"] : "always";
  const themes = readThemes(p["themes"]);
  return {
    id: typeof p["id"] === "string" && p["id"] ? p["id"].slice(0, 40) : newId(),
    src: p["src"],
    ...(typeof p["hoverSrc"] === "string" && SRC.test(p["hoverSrc"]) ? { hoverSrc: p["hoverSrc"] } : {}),
    x: clamp(p["x"], -BAND_W, BAND_W * 2, 0),
    drop: clamp(p["drop"], -BAND_H * 4, BAND_H * 2, 0),
    w: clamp(p["w"], 8, BAND_W * 2, 64),
    effect,
    amount:
      effect === "none"
        ? clamp(p["amount"], -720, 720, 0)
        : clamp(p["amount"], spec.min, spec.max, spec.amount),
    speed: clamp(p["speed"], SPEED_MIN, SPEED_MAX, spec.speed),
    animate,
    invert: p["invert"] === true,
    flip: p["flip"] === true,
    ...(themes ? { themes } : {}),
  };
}

/** A stored band, or the default one when nothing (or nothing usable) is
 *  stored. An empty list is a real choice — a bare band — and stays. */
export function parseBand(raw: string | null): Band {
  if (!raw) return defaultBand();
  try {
    const data = JSON.parse(raw) as { pictures?: unknown };
    if (!Array.isArray(data.pictures)) return defaultBand();
    const pictures = data.pictures.map(readPicture).filter((p): p is BandPicture => p !== null);
    return { pictures: pictures.slice(0, MAX_PICTURES) };
  } catch {
    return defaultBand();
  }
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}
