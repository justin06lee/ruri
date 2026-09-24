/**
 * How the built-in hero faces sit in their frames — numbers first set by
 * dragging each face into place. The face's editor starts a built-in face
 * from here, and puts it back here on reset.
 */

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
