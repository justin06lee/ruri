/**
 * What a picture can do when the pointer is on it, and how a moving one
 * moves — the peek band's (lib/peekBand.ts), drawn by the CSS at .fx-host
 * in styles.css.
 */

/** What a picture does when the pointer is on it. */
export type HoverEffect =
  "none" | "lift" | "sink" | "grow" | "pop" | "tilt" | "spin" | "wiggle" | "bounce" | "glow" | "fade";

/** How an animated picture (a GIF, an animated PNG or WebP) moves. */
export type Animate = "always" | "hover" | "still";

export interface EffectSpec {
  label: string;
  /** What the strength is counted in, for the slider's readout. */
  unit: string;
  min: number;
  max: number;
  /** Where the strength starts when this effect is picked. */
  amount: number;
  /** ms: how long the move takes — or, for one that repeats, one round. */
  speed: number;
  /** Repeats for as long as the pointer stays. */
  loops?: boolean;
}

export const EFFECTS: Record<HoverEffect, EffectSpec> = {
  none: { label: "None", unit: "", min: 0, max: 0, amount: 0, speed: 180 },
  lift: { label: "Lift", unit: "px", min: 0, max: 46, amount: 20, speed: 180 },
  sink: { label: "Sink", unit: "px", min: 0, max: 46, amount: 10, speed: 180 },
  grow: { label: "Grow", unit: "%", min: 0, max: 80, amount: 15, speed: 180 },
  pop: { label: "Pop", unit: "px", min: 0, max: 46, amount: 14, speed: 220 },
  tilt: { label: "Tilt", unit: "°", min: -45, max: 45, amount: 10, speed: 200 },
  spin: { label: "Spin", unit: "°", min: -720, max: 720, amount: 360, speed: 600 },
  wiggle: { label: "Wiggle", unit: "°", min: 0, max: 30, amount: 8, speed: 400, loops: true },
  bounce: { label: "Bounce", unit: "px", min: 0, max: 30, amount: 8, speed: 500, loops: true },
  glow: { label: "Glow", unit: "px", min: 0, max: 16, amount: 6, speed: 200 },
  fade: { label: "Fade", unit: "%", min: 0, max: 100, amount: 50, speed: 200 },
};

export const SPEED_MIN = 60;
export const SPEED_MAX = 2000;
