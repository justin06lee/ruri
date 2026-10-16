import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NamedComponent } from "../shared/protocol.js";
import { mentionBlock, mentionedIn, writeIndexFile } from "./components.js";

let config: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-components-"));
  process.env["RURI_CONFIG_DIR"] = config;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

function entry(slug: string, name: string, over: Partial<NamedComponent> = {}): NamedComponent {
  return {
    id: slug,
    slug,
    name,
    aliases: [],
    files: [`web/${slug}.tsx`],
    note: "",
    shots: [],
    ts: 1,
    ...over,
  };
}

const library = [
  entry("team-page", "the team page"),
  entry("rapid-fire-bar", "the rapid fire bar"),
  entry("drawing-page", "drawing page"),
  entry("drawing-page-text-box", "the drawing page text box"),
  entry("patch", "the patch", { found: true }),
  entry("player", "the player", { found: true, confirmed: true }),
  entry("switcher", "the switcher"),
  entry("peek-band", "the peek band", { aliases: ["the skyline"] }),
];

const named = (prompt: string) => mentionedIn(prompt, library).map((item) => item.slug);

describe("a prompt that names a component", () => {
  test("with or without its article, with spaces or hyphens", () => {
    expect(named("the team page is broken")).toEqual(["team-page"]);
    expect(named("team page shows the wrong state")).toEqual(["team-page"]);
    expect(named("rapid-fire bar flickers")).toEqual(["rapid-fire-bar"]);
    expect(named("fix `peek-band` please")).toEqual(["peek-band"]);
    expect(named("the skyline is too tall")).toEqual(["peek-band"]);
    expect(named("the teams page")).toEqual([]);
  });

  test("the longer name is the one meant", () => {
    expect(named("the drawing page text box is cut off")).toEqual(["drawing-page-text-box"]);
    expect(named("the drawing page and its text box")).toEqual(["drawing-page"]);
  });

  test("a one-word name the sweep guessed is too ordinary to count, until it is confirmed", () => {
    expect(named("apply the patch and commit")).toEqual([]);
    expect(named("the player stops")).toEqual(["player"]);
    expect(named("why does the switcher open the lead")).toEqual(["switcher"]);
  });

  test("in the order they come, no more than five", () => {
    expect(named("the switcher, then the team page")).toEqual(["switcher", "team-page"]);
    const many = Array.from({ length: 8 }, (_, i) => entry(`thing-${i}`, `widget number ${i}`));
    expect(mentionedIn(many.map((m) => m.name).join(", "), many)).toHaveLength(5);
  });

  test("what rides down with it is short: the newest picture, no copies", () => {
    const block = mentionBlock([
      entry("team-page", "the team page", {
        installs: ["src/x.tsx"],
        shots: [
          { id: "a", kind: "image", mediaType: "image/png", name: "a.png", n: 1, url: "/uploads/new.png" },
          { id: "b", kind: "image", mediaType: "image/png", name: "b.png", n: 1, url: "/uploads/old.png" },
        ],
        shotAt: 10,
        changedAt: 20,
      }),
    ]);
    expect(block).toContain("<ruri:components>");
    expect(block).toContain("new.png");
    expect(block).not.toContain("old.png");
    expect(block).not.toContain("Copies installed");
    expect(block).toContain("Its code has changed since that picture.");
  });
});

describe(".ruri/components.md", () => {
  test("holds what lasts — no pictures, no out-of-date marks — and is written only when that changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-components-project-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(path.join(dir, "web", "team-page.tsx"), "x");
    const item = entry("team-page", "the team page", {
      note: "who is on the team",
      shots: [{ id: "a", kind: "image", mediaType: "image/png", name: "a.png", n: 1, url: "/uploads/a.png" }],
      shotAt: 10,
      changedAt: 20,
    });
    writeIndexFile(dir, [item]);
    const file = path.join(dir, ".ruri", "components.md");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("## team-page — the team page");
    expect(text).toContain("who is on the team");
    expect(text).not.toContain("uploads");
    expect(text).not.toContain("changed since");
    // the code moving on, or a new picture, leaves the file as it was
    const before = new Date(1_700_000_000_000);
    fs.utimesSync(file, before, before);
    writeIndexFile(dir, [{ ...item, changedAt: 99, shots: [...item.shots, ...item.shots] }]);
    expect(fs.statSync(file).mtimeMs).toBe(1_700_000_000_000);
    writeIndexFile(dir, [{ ...item, note: "who is on it now" }]);
    expect(fs.readFileSync(file, "utf8")).toContain("who is on it now");
  });
});
