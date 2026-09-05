/**
 * The "thinking" indicator: a two-frame hand-drawn Ruri doodle (traced with
 * potrace from the user's sketches) that flips between poses every half
 * second. Inline SVG with fill: currentColor so it follows the theme ink.
 *
 * Beside it, the working line — what a running turn has done so far. A
 * turn is otherwise a closed box between the prompt and the result, which
 * is fine for the minute it usually takes and no help at all on the hour
 * it sometimes takes: a doodle waving at you for forty minutes says the
 * same thing whether the model is deep in a build or the connection died
 * an hour ago. The clock, the token count and the gap since anything last
 * came back are the three numbers that tell those apart.
 */
import { useEffect, useState } from "react";
import type { TurnProgress } from "../../../shared/protocol";

const FRAMES: string[] = [
  "M3912 4933 c-46 -22 -81 -68 -88 -114 -5 -32 -16 -48 -53 -77 -95 -76 -178 -170 -245 -277 -118 -187 -231 -358 -275 -413 -49 -62 -31 -63 -219 14 -181 74 -529 187 -1028 333 -213 62 -529 169 -637 214 -21 9 -60 31 -85 49 -40 28 -55 33 -108 33 -50 0 -66 -4 -96 -27 -19 -15 -41 -42 -49 -60 -7 -18 -24 -48 -36 -67 -35 -51 -61 -144 -273 -961 -161 -625 -175 -701 -134 -770 61 -105 212 -109 274 -8 11 18 29 76 41 128 12 52 26 104 32 115 20 40 110 176 113 172 2 -2 15 -120 29 -263 47 -505 48 -509 107 -540 17 -9 57 -19 88 -21 111 -10 159 34 345 317 128 195 247 350 338 438 l54 54 7 -124 c4 -67 16 -224 27 -347 21 -241 35 -297 88 -374 59 -87 113 -110 191 -82 79 28 136 74 230 185 93 111 374 390 392 390 6 0 8 -14 5 -32 -4 -18 -9 -200 -13 -405 l-7 -372 -26 18 c-65 47 -164 65 -224 42 -65 -25 -265 -227 -443 -449 l-83 -103 -10 38 c-38 133 -82 397 -96 573 -8 107 -20 212 -26 233 -31 111 -159 161 -250 97 -32 -23 -68 -89 -69 -124 0 -10 -22 -54 -49 -96 -47 -73 -117 -229 -231 -515 -28 -71 -54 -134 -57 -138 -3 -5 -33 44 -67 110 -111 212 -300 519 -342 554 -34 30 -62 32 -109 9 -57 -28 -101 -81 -115 -139 -18 -75 -23 -593 -11 -1115 13 -554 19 -615 60 -666 34 -42 83 -77 125 -88 55 -15 820 22 1121 54 77 9 263 18 413 21 l272 6 0 -120 c0 -66 3 -148 6 -182 l7 -61 182 0 182 0 6 107 c24 391 -7 520 -143 588 -30 16 -54 17 -195 12 -88 -3 -212 -11 -275 -16 -169 -15 -475 -39 -640 -51 -139 -10 -637 -30 -747 -30 l-53 0 1 328 c1 180 4 358 8 395 l6 68 71 -128 c86 -154 103 -168 210 -168 62 1 76 4 108 28 74 57 144 183 251 455 38 95 72 169 75 165 3 -5 16 -63 28 -130 12 -67 35 -177 51 -245 17 -67 35 -154 41 -192 14 -91 31 -128 71 -157 46 -32 132 -38 176 -10 17 11 92 100 166 199 74 98 198 247 276 330 l141 151 56 -77 c31 -42 83 -105 115 -139 36 -37 59 -70 59 -84 0 -37 46 -105 84 -123 19 -9 56 -16 84 -16 62 0 109 30 138 86 20 40 21 62 27 425 6 437 -8 1334 -22 1394 -5 21 -20 46 -32 56 -50 38 -206 51 -293 25 -51 -15 -123 -78 -404 -348 -85 -82 -157 -148 -162 -148 -10 0 -28 97 -35 190 -3 41 -7 198 -9 349 -5 314 -2 306 -96 354 -88 45 -129 39 -231 -32 -105 -73 -357 -330 -489 -499 -52 -67 -98 -121 -101 -122 -3 0 -9 127 -12 283 -4 155 -11 300 -16 321 -18 73 -145 176 -218 176 -16 0 -38 -7 -49 -15 -10 -8 -22 -15 -26 -15 -13 0 35 147 113 341 43 109 79 204 79 210 0 13 -48 28 490 -149 938 -310 992 -329 1172 -414 203 -96 250 -105 337 -68 64 28 121 90 233 254 71 105 235 326 242 326 1 0 2 -127 1 -282 0 -312 7 -358 62 -430 40 -52 73 -68 135 -68 116 1 211 61 472 304 99 91 181 164 183 162 4 -4 -66 -336 -97 -454 -11 -44 -67 -239 -126 -433 -152 -509 -179 -632 -229 -1029 -29 -228 -90 -547 -131 -685 -49 -166 -73 -269 -93 -403 -12 -74 -23 -137 -25 -140 -2 -4 0 -38 5 -76 7 -53 15 -76 33 -95 14 -14 32 -42 40 -62 19 -45 114 -222 219 -407 l80 -142 154 0 c117 0 153 3 153 13 0 33 -90 197 -319 582 -83 139 -101 177 -101 210 0 57 40 215 120 475 81 260 97 333 150 682 50 329 76 442 162 712 138 430 160 503 219 728 124 472 216 887 226 1015 6 78 4 85 -21 123 -37 56 -79 80 -141 80 -65 0 -104 -25 -148 -92 -19 -29 -72 -89 -118 -133 -71 -67 -152 -131 -466 -369 l-25 -19 7 147 c14 273 20 636 12 668 -27 101 -144 156 -235 111z M3749 3281 c-50 -31 -122 -129 -140 -192 -10 -33 -9 -47 11 -101 12 -35 31 -75 41 -89 56 -79 300 -103 383 -38 39 31 78 120 83 193 8 91 -2 131 -44 177 -57 63 -97 79 -201 79 -80 0 -92 -3 -133 -29z",
  "M3598 4990 c-45 -24 -76 -73 -84 -134 -5 -33 -29 -86 -77 -169 -156 -271 -202 -402 -258 -732 l-24 -138 -120 8 c-66 4 -579 9 -1140 10 -756 2 -1046 6 -1121 15 -96 12 -104 12 -145 -7 -24 -11 -64 -26 -88 -33 -25 -6 -57 -25 -73 -42 -44 -47 -51 -93 -44 -278 26 -723 37 -1129 44 -1595 9 -592 8 -585 70 -637 42 -35 96 -52 147 -45 l42 6 7 -72 c22 -259 27 -370 20 -528 -6 -155 -4 -180 11 -212 31 -67 71 -92 176 -111 91 -17 100 -17 299 3 226 23 413 26 1066 14 l381 -6 -9 -46 c-5 -26 -6 -84 -1 -131 4 -47 7 -95 6 -108 l-2 -22 195 0 c107 0 194 2 194 5 0 2 -9 27 -20 55 -16 40 -20 74 -20 167 0 64 5 143 12 174 15 73 0 122 -55 185 -73 83 -18 78 -782 80 -374 1 -777 2 -895 3 l-215 1 -38 388 c-21 213 -43 446 -49 517 -5 72 -14 137 -18 145 -10 17 7 52 84 174 31 49 56 93 56 99 0 5 40 67 88 136 49 69 122 175 163 234 l74 109 7 -44 c22 -135 50 -527 54 -748 6 -287 13 -323 70 -366 65 -50 169 -41 218 17 25 29 31 46 55 154 21 89 274 705 354 859 l40 78 25 -68 c178 -501 245 -673 324 -827 61 -119 100 -151 178 -150 100 1 164 73 157 173 -3 32 3 93 14 145 19 96 119 518 123 522 1 1 7 -50 14 -115 15 -152 32 -209 77 -252 31 -30 42 -35 100 -38 52 -3 70 0 97 16 48 30 78 88 78 150 0 60 -50 337 -124 690 -50 239 -55 255 -85 286 -43 45 -83 55 -176 46 -68 -7 -80 -11 -110 -40 -63 -61 -122 -260 -190 -640 -21 -113 -41 -211 -44 -218 -4 -7 -29 59 -56 150 -102 346 -198 587 -262 664 -30 36 -78 54 -144 54 -61 0 -64 -1 -104 -44 -47 -48 -173 -294 -274 -531 -66 -155 -63 -155 -76 0 -14 162 -35 266 -71 352 -32 77 -35 92 -25 119 17 48 13 115 -9 151 -37 62 -144 92 -208 59 -51 -27 -109 -106 -307 -421 -160 -253 -293 -449 -339 -498 l-44 -47 -6 72 c-3 40 -15 334 -26 653 -11 319 -21 610 -23 646 l-2 67 380 8 c209 5 547 8 750 7 339 -2 1264 -28 1430 -40 62 -4 74 -2 105 19 74 50 78 66 145 484 26 168 50 258 66 248 5 -3 9 -12 9 -20 0 -52 164 -488 228 -607 36 -67 83 -90 184 -91 106 0 163 31 378 204 96 78 178 144 181 146 4 2 -6 -37 -22 -86 -33 -107 -58 -222 -139 -635 -33 -170 -80 -386 -105 -480 -151 -570 -432 -1707 -457 -1855 -13 -78 -7 -109 31 -152 15 -18 62 -100 103 -183 61 -122 225 -422 272 -497 10 -16 29 -18 163 -18 118 0 153 3 153 13 0 34 -80 180 -312 570 l-129 218 34 147 c36 151 61 272 72 352 31 226 123 605 229 945 131 424 177 591 241 887 36 167 75 339 86 383 48 193 132 413 260 681 54 114 33 204 -61 252 -73 38 -121 28 -270 -53 -69 -38 -174 -101 -235 -140 -60 -39 -121 -78 -135 -85 -14 -7 -83 -52 -155 -99 -71 -47 -134 -89 -140 -93 -7 -4 -26 30 -53 95 -56 137 -56 134 -112 470 -55 325 -61 350 -93 397 -45 67 -143 90 -219 50z M3749 3281 c-50 -31 -122 -129 -140 -192 -10 -33 -9 -47 11 -101 12 -35 31 -75 41 -89 56 -79 300 -103 383 -38 39 31 78 120 83 193 8 91 -2 131 -44 177 -57 63 -97 79 -201 79 -80 0 -92 -3 -133 -29z"
];

export function Thinking() {
  return (
    <div className="thinking" aria-hidden>
      {FRAMES.map((d, i) => (
        <svg key={i} className={`thinking-frame f${i + 1}`} viewBox="0 0 512 512">
          <g transform="translate(0,512) scale(0.1,-0.1)" fill="currentColor" stroke="none">
            <path d={d} />
          </g>
        </svg>
      ))}
    </div>
  );
}

/* ── the working line ────────────────────────────────────────────── */

/**
 * What Ruri is doing, allegedly. The word means nothing — it is there so a
 * line that is otherwise three numbers has a subject, and so a long wait
 * visibly keeps moving. Sleepy, dragon-ish, a bit put-upon: the voice the
 * Home agent already uses.
 */
const WORDS = [
  "Undulating", "Pondering", "Ruminating", "Noodling", "Mulling",
  "Percolating", "Simmering", "Brooding", "Puzzling", "Untangling",
  "Rummaging", "Burrowing", "Circling", "Squinting", "Whittling",
  "Tinkering", "Wrangling", "Hatching", "Scheming", "Sifting",
  "Prowling", "Lumbering", "Slouching", "Stretching", "Grumbling",
  "Trundling", "Skulking", "Meandering", "Dawdling", "Smouldering",
  "Roosting", "Preening", "Hoarding", "Kindling", "Drowsing",
];
/** How long each word stays before the next one. */
const WORD_MS = 5_000;
/** Nothing back for this long is worth saying out loud — under it, a gap
 *  is just a tool running, and a warning every time one did would teach
 *  the user to ignore the line. */
const QUIET_MS = 90_000;

function words(startedAt: number, now: number): string {
  // seeded off the start so two turns running side by side don't chant
  const offset = Math.floor(startedAt / WORD_MS);
  return WORDS[(offset + Math.floor((now - startedAt) / WORD_MS)) % WORDS.length]!;
}

/** 42s, 3m 08s, 1h 14m — as long as it has been, in as few characters. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 309, 1.3k, 47k — the shape the CLI's own counter uses. */
function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function WorkingLine({ turn, effort }: { turn: TurnProgress; effort: string }) {
  // one tick a second: the clock has to move, and nothing else on screen
  // is going to move it while a turn sits in a long tool call
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const quiet = now - turn.at;
  return (
    <div className="working-line">
      <span className="working-word">{words(turn.startedAt, now)}…</span>
      <span className="working-stats">
        ({elapsed(now - turn.startedAt)}
        {turn.tokens > 0 && ` · ↓ ${tokens(turn.tokens)} tokens`}
        {` · ${effort} effort`}
        {quiet > QUIET_MS && (
          // the one part of this line worth reading twice: everything else
          // says "still going", this says "and nothing has come back since"
          <span className="working-quiet"> · quiet for {elapsed(quiet)}</span>
        )}
        )
      </span>
    </div>
  );
}
