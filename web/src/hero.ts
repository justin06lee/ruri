/**
 * The rotating hero faces: cropped Ruri panels in /public/hero. Home rolls a
 * fresh one per app launch; each project keeps the one its id hashes to, so
 * a new project gets a random face that then stays put.
 */

export const HERO_COUNT = 11;

/** Fixture/screenshot runs must be deterministic — pin the original face. */
const pinned = typeof location !== "undefined" && location.search.includes("fixture");

/** Rolled once per page load — a new face every time the app opens. */
export const launchHero = pinned ? 11 : Math.floor(Math.random() * HERO_COUNT) + 1;

/** Stable per project: hash the id into a variant. */
export function heroFor(id: string): number {
  if (pinned) return 11;
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % HERO_COUNT) + 1;
}

export const heroUrl = (n: number): string => `/hero/v${n}.png`;
