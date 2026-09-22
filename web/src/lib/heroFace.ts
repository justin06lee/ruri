import { HERO_CENTER, HERO_FRAMES } from "../peek";
import { type Animate, EFFECTS, type HoverEffect, SPEED_MAX, SPEED_MIN } from "./effects";

/**
 * The hero face's shape, and nothing live: the face over an empty chat —
 * which pictures it can be, how one is picked, what it sits in, what it
 * does under the pointer — and the greeting Home gives with it. A stored
 * one read back, checked, since it comes off disk. The window's copy is
 * ../hero.ts; the face on screen is components/HeroFace.tsx.
 */

/** The cropped Ruri panels the app comes with: /hero/v1.png … v12.png. */
export const HERO_COUNT = 12;

/** The built-in faces and as many of the user's own again, twice over. */
export const MAX_FACES = HERO_COUNT + 24;
export const MAX_GREETINGS = 20;
export const GREETING_CHARS = 80;

export const SIZE_MIN = 64;
export const SIZE_MAX = 240;
export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 6;
/** How far a face slides under its frame, percent of the frame. */
export const SHIFT_MAX = 100;

export interface HeroFace {
  /** v1 … v12 for the built-in faces, anything else for the user's. */
  id: string;
  /** /hero/v<n>.png, or /uploads/<file>. */
  src: string;
  /** Shown instead while the pointer is on it — played from the start if
   *  it moves. */
  hoverSrc?: string;
  /** Sideways, percent of the frame's width — positive is right. */
  x: number;
  /** Down, percent of the frame's height — positive is down. */
  y: number;
  /** 1 fits the whole picture in the frame; past 1 fills it and crops. */
  zoom: number;
  /** In the mix a random face is drawn from. */
  on: boolean;
  /** Swap ink and paper in the dark themes. */
  invert: boolean;
  animate: Animate;
}

export type HeroShape = "circle" | "rounded" | "square" | "none";
export type HeroBackdrop = "white" | "paper" | "none";
/**
 * When a random face is drawn: `project` — each project keeps the one it
 * was born with and Home draws anew every launch (how it has always been);
 * `launch` — every chat draws anew every launch; `visit` — every time the
 * face comes up.
 */
export type HeroShuffle = "project" | "launch" | "visit";

export interface Hero {
  /** A face at all, or just the title and the box. */
  show: boolean;
  mode: "random" | "one";
  /** The face `one` means. */
  one: string;
  shuffle: HeroShuffle;
  /** Clicking the face draws another. */
  reroll: boolean;
  faces: HeroFace[];
  shape: HeroShape;
  /** px across. */
  size: number;
  /** The rim round the frame. */
  line: boolean;
  backdrop: HeroBackdrop;
  effect: HoverEffect;
  amount: number;
  speed: number;
  /** What Home says under the face; several take turns. */
  greetings: string[];
}

export const builtinSrc = (n: number): string => `/hero/v${n}.png`;

export function builtinFace(n: number): HeroFace {
  const frame = HERO_FRAMES[n] ?? HERO_CENTER;
  return {
    id: `v${n}`,
    src: builtinSrc(n),
    x: frame.x,
    y: frame.y,
    zoom: frame.zoom,
    on: true,
    invert: false,
    animate: "always",
  };
}

/** How it has always been: the twelve faces, drawn at random, each
 *  project keeping its own, in a white circle, saying "sup." on Home. */
export function defaultHero(): Hero {
  return {
    show: true,
    mode: "random",
    one: "v12",
    shuffle: "project",
    reroll: false,
    faces: Array.from({ length: HERO_COUNT }, (_, i) => builtinFace(i + 1)),
    shape: "circle",
    size: 132,
    line: true,
    backdrop: "white",
    effect: "none",
    amount: 0,
    speed: EFFECTS.none.speed,
    greetings: ["sup."],
  };
}

/* ── reading it back ─────────────────────────────────────────────── */

/** Only pictures ruri serves itself: the built-in faces and uploads. */
const SRC = /^\/(hero\/v\d+\.png|uploads\/[A-Za-z0-9._-]+)$/;

const num = (value: unknown, min: number, max: number, fallback: number, places = 0): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const f = 10 ** places;
  return Math.min(max, Math.max(min, Math.round(value * f) / f));
};

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

function readFace(raw: unknown): HeroFace | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f["src"] !== "string" || !SRC.test(f["src"])) return null;
  if (typeof f["id"] !== "string" || !f["id"]) return null;
  return {
    id: f["id"].slice(0, 40),
    src: f["src"],
    ...(typeof f["hoverSrc"] === "string" && SRC.test(f["hoverSrc"]) ? { hoverSrc: f["hoverSrc"] } : {}),
    x: num(f["x"], -SHIFT_MAX, SHIFT_MAX, 0, 1),
    y: num(f["y"], -SHIFT_MAX, SHIFT_MAX, 0, 1),
    zoom: num(f["zoom"], ZOOM_MIN, ZOOM_MAX, 1, 2),
    on: f["on"] !== false,
    invert: f["invert"] === true,
    animate: oneOf(f["animate"], ["always", "hover", "still"] as const, "always"),
  };
}

/** A stored hero, or the default when nothing (or nothing usable) is. */
export function parseHero(raw: string | null): Hero {
  const base = defaultHero();
  if (!raw) return base;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return base;
  }
  if (!data || typeof data !== "object") return base;
  const seen = new Set<string>();
  const faces = Array.isArray(data["faces"])
    ? data["faces"]
        .map(readFace)
        .filter((f): f is HeroFace => f !== null && !seen.has(f.id) && Boolean(seen.add(f.id)))
        .slice(0, MAX_FACES)
    : base.faces;
  const effect = oneOf(data["effect"], Object.keys(EFFECTS) as HoverEffect[], "none");
  const spec = EFFECTS[effect];
  const greetings = Array.isArray(data["greetings"])
    ? data["greetings"]
        .filter((g): g is string => typeof g === "string")
        .map((g) => g.trim().slice(0, GREETING_CHARS))
        .filter(Boolean)
        .slice(0, MAX_GREETINGS)
    : base.greetings;
  return {
    show: data["show"] !== false,
    mode: oneOf(data["mode"], ["random", "one"] as const, "random"),
    one: typeof data["one"] === "string" ? data["one"].slice(0, 40) : base.one,
    shuffle: oneOf(data["shuffle"], ["project", "launch", "visit"] as const, "project"),
    reroll: data["reroll"] === true,
    faces,
    shape: oneOf(data["shape"], ["circle", "rounded", "square", "none"] as const, "circle"),
    size: num(data["size"], SIZE_MIN, SIZE_MAX, base.size),
    line: data["line"] !== false,
    backdrop: oneOf(data["backdrop"], ["white", "paper", "none"] as const, "white"),
    effect,
    amount: effect === "none" ? 0 : num(data["amount"], spec.min, spec.max, spec.amount),
    speed: num(data["speed"], SPEED_MIN, SPEED_MAX, spec.speed),
    greetings,
  };
}

/* ── which face, which words ─────────────────────────────────────── */

/** The same id, the same number — how a project keeps its face. */
export function hash(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export interface Draw {
  /** The chat the face is for. */
  key: string;
  home: boolean;
  /** 0–1, drawn once when the app opened. */
  launch: number;
  /** 0–1, drawn when this face came up. */
  visit: number;
  /** How many times it has been clicked for another. */
  bump: number;
}

/** Which face a chat shows — none when there are none to show. */
export function pickFace(hero: Hero, draw: Draw): HeroFace | undefined {
  if (!hero.show) return undefined;
  const pool = hero.faces.filter((f) => f.on);
  if (hero.mode === "one") return hero.faces.find((f) => f.id === hero.one) ?? pool[0] ?? hero.faces[0];
  if (pool.length === 0) return undefined;
  let at: number;
  if (hero.shuffle === "visit") at = Math.floor(draw.visit * pool.length);
  else if (hero.shuffle === "launch") at = hash(draw.key) + Math.floor(draw.launch * 2 ** 31);
  else at = draw.home ? Math.floor(draw.launch * pool.length) : hash(draw.key);
  return pool[(at + draw.bump) % pool.length];
}

/** What Home says: one line always, several in turn — a new one each
 *  launch, or each visit when random faces change every visit. */
export function pickGreeting(hero: Hero, draw: Pick<Draw, "launch" | "visit">): string {
  const lines = hero.greetings;
  if (lines.length === 0) return "";
  const roll = hero.mode === "random" && hero.shuffle === "visit" ? draw.visit : draw.launch;
  return lines[Math.floor(roll * lines.length) % lines.length]!;
}
