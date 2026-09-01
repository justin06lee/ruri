/**
 * Where the art sits — placed by hand in the tuner (`make tuner`), saved
 * back here by it, and read by the app.
 *
 * This file is data, not decisions: every number in it was set by dragging
 * the thing itself. The tuner rewrites it wholesale, so keep the shape and
 * put commentary here in the header rather than beside the values.
 */

/** One peeking head in the titlebar band. */
export interface Peek {
  /** Which cut-out: /peek/u{n}.png. */
  n: number;
  /** Left edge, px from the band's left. */
  x: number;
  /** Rendered width, px — height follows the aspect ratio. */
  w: number;
  /** How far down the band it starts, px. */
  drop: number;
  /** How far it rises when the cursor is over it, px (negative = up). */
  lift: number;
}

export const PEEKS: Peek[] = [
  { n: 1, x: 1, w: 65, drop: 4, lift: -18 },
  { n: 2, x: 56, w: 63, drop: 18, lift: -22 },
  { n: 3, x: 89, w: 78, drop: 20, lift: -24 },
  { n: 4, x: 138, w: 89, drop: 17, lift: -22 },
  { n: 5, x: 210, w: 88, drop: 4, lift: -20 },
];

/**
 * How a hero face sits inside its circle. The picture is fitted whole inside
 * the circle first (zoom 1 shows all of it); zoom past 1 fills the circle and
 * crops, and x/y slide it under the circle afterwards.
 */
export interface HeroFrame {
  /** Sideways nudge, percent of the circle's width — positive is right. */
  x: number;
  /** Vertical nudge, percent of the circle's height — positive is down. */
  y: number;
  /** Size: 1 fits the whole picture, >1 fills the circle and crops. */
  zoom: number;
}

export const HERO_CENTER: HeroFrame = { x: 0, y: 0, zoom: 1 };

/** Per-face framing; anything missing is centred at its fitted size. */
export const HERO_FRAMES: Record<number, HeroFrame> = {
  1: { x: 0, y: 4, zoom: 1.1 },
  3: { x: -3.2, y: 21.9, zoom: 1.21 },
  4: { x: 3.2, y: 5.9, zoom: 1.15 },
  6: { x: -0.8, y: 33.1, zoom: 1.43 },
  7: { x: -8.5, y: 8.1, zoom: 1.05 },
  8: { x: 7.6, y: 11.8, zoom: 1.16 },
  11: { x: -1.6, y: 9.6, zoom: 1 },
};

export function heroFrame(n: number): HeroFrame {
  return HERO_FRAMES[n] ?? HERO_CENTER;
}
