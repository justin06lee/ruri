import { PEEKS } from "../peek";
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
  /** /peek/u<n>.png for the built-in heads, /uploads/<file> for the user's. */
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
}

export interface Band {
  /** Back to front: a later picture sits over an earlier one. */
  pictures: BandPicture[];
}

/** The five hand-cut heads the band has always had, placed as the tuner
 *  left them — and, like before, still until something is set. */
export function defaultBand(): Band {
  return {
    pictures: PEEKS.map((p) => ({
      id: `u${p.n}`,
      src: `/peek/u${p.n}.png`,
      x: p.x,
      drop: p.drop,
      w: p.w,
      effect: "none",
      amount: EFFECTS.lift.amount,
      speed: EFFECTS.lift.speed,
      animate: "always",
      invert: true,
      flip: false,
    })),
  };
}

/** Whether a picture does anything under the pointer — and so has to
 *  catch it, which in the desktop app means leaving the window's drag
 *  region (components/PeekBand.tsx). */
export function reacts(picture: BandPicture): boolean {
  return picture.effect !== "none" || Boolean(picture.hoverSrc) || picture.animate === "hover";
}

/* ── reading it back ─────────────────────────────────────────────── */

/** Only pictures ruri serves itself: the built-in heads and uploads. */
const SRC = /^\/(peek\/u\d+\.png|uploads\/[A-Za-z0-9._-]+)$/;

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
