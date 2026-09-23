import { describe, expect, test } from "bun:test";
import { PEEKS } from "../peek";
import { defaultBand, EFFECTS, MAX_PICTURES, parseBand, type BandPicture } from "./peekBand";

const picture = (over: Partial<BandPicture> = {}): BandPicture => ({
  id: "a",
  src: "/uploads/abc-band.gif",
  x: 10,
  drop: 4,
  w: 60,
  effect: "none",
  amount: 0,
  speed: 180,
  animate: "always",
  invert: false,
  flip: false,
  ...over,
});

const stored = (pictures: unknown[]) => JSON.stringify({ pictures });

describe("parseBand", () => {
  test("nothing stored is the five heads, placed as the tuner left them, still", () => {
    const band = parseBand(null);
    expect(band).toEqual(defaultBand());
    expect(band.pictures.map((p) => [p.src, p.x, p.w, p.drop])).toEqual(
      PEEKS.map((p) => [`/peek/u${p.n}.png`, p.x, p.w, p.drop]),
    );
    expect(band.pictures.every((p) => p.effect === "none" && !p.hoverSrc)).toBe(true);
  });

  test("something unreadable is the default too", () => {
    expect(parseBand("{not json")).toEqual(defaultBand());
    expect(parseBand(JSON.stringify({ other: 1 }))).toEqual(defaultBand());
  });

  test("an empty band is a choice, and stays empty", () => {
    expect(parseBand(stored([])).pictures).toEqual([]);
  });

  test("a band reads back as it was kept", () => {
    const kept = [
      picture(),
      picture({
        id: "b",
        src: "/peek/u2.png",
        hoverSrc: "/uploads/x.gif",
        effect: "wiggle",
        amount: 12,
        speed: 300,
        animate: "hover",
        invert: true,
        flip: true,
      }),
    ];
    expect(parseBand(stored(kept)).pictures).toEqual(kept);
  });

  test("a picture from anywhere but ruri itself is dropped", () => {
    const band = parseBand(
      stored([
        picture({ src: "https://example.com/a.png" }),
        picture({ src: "/uploads/../../etc/passwd" }),
        picture({ src: "javascript:alert(1)" }),
        picture({ id: "ok" }),
      ]),
    );
    expect(band.pictures.map((p) => p.id)).toEqual(["ok"]);
  });

  test("so is a hover picture from anywhere else, and the picture keeps", () => {
    const [only] = parseBand(stored([picture({ hoverSrc: "http://x/y.gif" })])).pictures;
    expect(only?.hoverSrc).toBeUndefined();
  });

  test("numbers are brought into range, and an unknown effect is none", () => {
    const [p] = parseBand(
      stored([{ ...picture(), x: 99_999, w: 1, drop: -99_999, effect: "explode", speed: 5 }]),
    ).pictures;
    expect(p).toMatchObject({ x: 528, w: 8, drop: -184, effect: "none", speed: 60 });
    const [lift] = parseBand(stored([picture({ effect: "lift", amount: 500 })])).pictures;
    expect(lift?.amount).toBe(EFFECTS.lift.max);
  });

  test("no more than the band holds", () => {
    const many = Array.from({ length: MAX_PICTURES + 5 }, (_, i) => picture({ id: `p${i}` }));
    expect(parseBand(stored(many)).pictures).toHaveLength(MAX_PICTURES);
  });
});
