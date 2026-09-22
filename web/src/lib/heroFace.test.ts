import { describe, expect, test } from "bun:test";
import { HERO_FRAMES } from "../peek";
import {
  defaultHero,
  type Draw,
  hash,
  HERO_COUNT,
  type Hero,
  MAX_FACES,
  parseHero,
  pickFace,
  pickGreeting,
} from "./heroFace";

const draw = (over: Partial<Draw> = {}): Draw => ({
  key: "project-abc",
  home: false,
  launch: 0.5,
  visit: 0.25,
  bump: 0,
  ...over,
});

const upload = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  src: `/uploads/${id}-face.png`,
  x: 0,
  y: 0,
  zoom: 1,
  on: true,
  invert: false,
  animate: "always",
  ...over,
});

describe("parseHero", () => {
  test("nothing stored is how it has always been: twelve faces, framed by the tuner", () => {
    const hero = parseHero(null);
    expect(hero).toEqual(defaultHero());
    expect(hero.faces).toHaveLength(HERO_COUNT);
    expect(hero.faces[2]).toMatchObject({ id: "v3", src: "/hero/v3.png", ...HERO_FRAMES[3] });
    expect(hero.greetings).toEqual(["sup."]);
    expect(parseHero("{nope")).toEqual(defaultHero());
  });

  test("a hero reads back as it was kept", () => {
    const kept: Hero = {
      ...defaultHero(),
      mode: "one",
      one: "mine",
      shuffle: "visit",
      reroll: true,
      faces: [
        { ...defaultHero().faces[0]!, on: false },
        { ...upload("mine"), hoverSrc: "/uploads/x.gif", animate: "hover", invert: true } as Hero["faces"][0],
      ],
      shape: "rounded",
      size: 180,
      line: false,
      backdrop: "paper",
      effect: "wiggle",
      amount: 12,
      speed: 400,
      greetings: ["hey", "yo"],
    };
    expect(parseHero(JSON.stringify(kept))).toEqual(kept);
  });

  test("a face from anywhere but ruri itself, or twice over, is dropped", () => {
    const hero = parseHero(
      JSON.stringify({
        faces: [upload("a"), upload("b", { src: "https://x.test/y.png" }), upload("a"), upload("c")],
      }),
    );
    expect(hero.faces.map((f) => f.id)).toEqual(["a", "c"]);
  });

  test("numbers come into range, words into the list, and no more than fit", () => {
    const hero = parseHero(
      JSON.stringify({
        size: 9999,
        effect: "explode",
        faces: Array.from({ length: MAX_FACES + 3 }, (_, i) => upload(`f${i}`, { zoom: 99, x: -500 })),
        greetings: ["  sup.  ", "", 42, "x".repeat(200)],
      }),
    );
    expect(hero.size).toBe(240);
    expect(hero.effect).toBe("none");
    expect(hero.faces).toHaveLength(MAX_FACES);
    expect(hero.faces[0]).toMatchObject({ zoom: 6, x: -100 });
    expect(hero.greetings).toEqual(["sup.", "x".repeat(80)]);
  });
});

describe("pickFace", () => {
  test("by default a project keeps the face it always had", () => {
    const hero = defaultHero();
    for (const key of ["p1", "7b2e1c9a-proj", "ruri"]) {
      // the old rule: v(hash % 12 + 1)
      expect(pickFace(hero, draw({ key }))?.id).toBe(`v${(hash(key) % HERO_COUNT) + 1}`);
      expect(pickFace(hero, draw({ key, launch: 0.9 }))?.id).toBe(pickFace(hero, draw({ key }))?.id);
    }
  });

  test("and Home draws a new one each launch", () => {
    const hero = defaultHero();
    expect(pickFace(hero, draw({ home: true, launch: 0 }))?.id).toBe("v1");
    expect(pickFace(hero, draw({ home: true, launch: 0.99 }))?.id).toBe("v12");
  });

  test("each launch: the same chat, a different face when the app opens again", () => {
    const hero = { ...defaultHero(), shuffle: "launch" as const };
    const faces = new Set([0.1, 0.35, 0.6, 0.85].map((launch) => pickFace(hero, draw({ launch }))?.id));
    expect(faces.size).toBeGreaterThan(1);
    expect(pickFace(hero, draw({ launch: 0.1 }))?.id).toBe(pickFace(hero, draw({ launch: 0.1 }))?.id);
  });

  test("every visit: whatever the visit drew", () => {
    const hero = { ...defaultHero(), shuffle: "visit" as const };
    expect(pickFace(hero, draw({ visit: 0 }))?.id).toBe("v1");
    expect(pickFace(hero, draw({ visit: 0.5 }))?.id).toBe("v7");
  });

  test("only faces in the mix are drawn, and a click moves to the next", () => {
    const hero = {
      ...defaultHero(),
      faces: defaultHero().faces.map((f) => ({ ...f, on: f.id === "v2" || f.id === "v5" })),
    };
    const first = pickFace(hero, draw())?.id;
    expect(["v2", "v5"]).toContain(first!);
    expect(pickFace(hero, draw({ bump: 1 }))?.id).toBe(first === "v2" ? "v5" : "v2");
  });

  test("always one is that one, in or out of the mix", () => {
    const hero = {
      ...defaultHero(),
      mode: "one" as const,
      one: "v4",
      faces: defaultHero().faces.map((f) => ({ ...f, on: false })),
    };
    expect(pickFace(hero, draw({ key: "a" }))?.id).toBe("v4");
    expect(pickFace(hero, draw({ key: "b", home: true, bump: 3 }))?.id).toBe("v4");
  });

  test("no face when it is hidden, or none are left to draw", () => {
    expect(pickFace({ ...defaultHero(), show: false }, draw())).toBeUndefined();
    const none = { ...defaultHero(), faces: defaultHero().faces.map((f) => ({ ...f, on: false })) };
    expect(pickFace(none, draw())).toBeUndefined();
  });
});

describe("pickGreeting", () => {
  test("one line is always said; several take turns by launch, or by visit when faces are", () => {
    expect(pickGreeting(defaultHero(), draw())).toBe("sup.");
    const several = { ...defaultHero(), greetings: ["a", "b", "c", "d"] };
    expect(pickGreeting(several, draw({ launch: 0.1, visit: 0.9 }))).toBe("a");
    expect(pickGreeting({ ...several, shuffle: "visit" }, draw({ launch: 0.1, visit: 0.9 }))).toBe("d");
    expect(pickGreeting({ ...defaultHero(), greetings: [] }, draw())).toBe("");
  });
});
