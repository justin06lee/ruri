import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NamedComponent } from "../shared/protocol.js";
import {
  ComponentStore,
  mentionBlock,
  mentionedIn,
  readIndexFile,
  syncIndexFile,
  writeIndexFile,
} from "./components.js";

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
      uses: ["web/styles.css:120"],
      anchors: { "web/styles.css:120": ".team-grid {" },
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
    expect(text).toContain("Reaches into: web/styles.css (at `.team-grid {`)");
    // the code moving on, or a new picture, leaves the file as it was
    const before = new Date(1_700_000_000_000);
    fs.utimesSync(file, before, before);
    writeIndexFile(dir, [
      {
        ...item,
        changedAt: 99,
        shots: [...item.shots, ...item.shots],
        uses: ["web/styles.css:180"],
        anchors: { "web/styles.css:180": ".team-grid {" },
      },
    ]);
    expect(fs.statSync(file).mtimeMs).toBe(1_700_000_000_000);
    writeIndexFile(dir, [{ ...item, note: "who is on it now" }]);
    expect(fs.readFileSync(file, "utf8")).toContain("who is on it now");
  });
});

describe("what the project's file lists, taken in", () => {
  /** A project folder that isn't blank, with the files its entries name. */
  function project(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-components-clone-"));
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(path.join(dir, "web", "team-page.tsx"), "x");
    fs.writeFileSync(
      path.join(dir, "web", "styles.css"),
      "a {\n}\n\n.team-grid {\n}\n.card, .card-wide {\n}\n",
    );
    return dir;
  }
  const file = (dir: string) => path.join(dir, ".ruri", "components.md");

  const team = entry("team-page", "the team page", {
    note: "who is on the team\n\nIts second paragraph. Tags: not a tag line",
    aliases: ["the roster", "team"],
    root: "web/team-page.tsx#TeamPage",
    uses: ["web/styles.css:4", "web/styles.css:6", "server/team.ts", "web/app.tsx:12"],
    anchors: { "web/styles.css:4": ".team-grid {", "web/styles.css:6": ".card, .card-wide {" },
    installs: ["web/copies/team-page.tsx"],
    tags: ["page", "team"],
    deps: ["zod"],
    selector: ".team-page",
  });

  test("the file reads back as what was written", () => {
    const dir = project();
    const plain = entry("peek-band", "the peek band — the skyline");
    writeIndexFile(dir, [team, plain]);
    const listed = readIndexFile(fs.readFileSync(file(dir), "utf8"));
    expect(listed.map((e) => e.slug)).toEqual(["team-page", "peek-band"]);
    expect(listed[0]).toMatchObject({
      name: "the team page",
      note: team.note,
      aliases: ["the roster", "team"],
      root: "web/team-page.tsx#TeamPage",
      files: ["web/team-page.tsx"],
      uses: [
        { ref: "web/styles.css", anchor: ".team-grid {" },
        { ref: "web/styles.css", anchor: ".card, .card-wide {" },
        { ref: "server/team.ts" },
        { ref: "web/app.tsx:12" },
      ],
      installs: ["web/copies/team-page.tsx"],
      tags: ["page", "team"],
      deps: ["zod"],
      selector: ".team-page",
    });
    expect(listed[1]).toMatchObject({ name: "the peek band — the skyline", note: "", uses: [] });
  });

  test("an install with none of it opens with the library its project committed, and writes the file back unchanged", () => {
    const dir = project();
    writeIndexFile(dir, [team, entry("peek-band", "the peek band")]);
    const committed = fs.readFileSync(file(dir), "utf8");
    // another machine: nothing in its library, where the file used to be
    // written down to nothing
    const store = new ComponentStore();
    expect(syncIndexFile(store, "p1", dir)).toBe(2);
    expect(fs.readFileSync(file(dir), "utf8")).toBe(committed);
    const taken = store.find("p1", "team-page")!;
    expect(taken).toMatchObject({ name: "the team page", note: team.note, confirmed: true, shots: [] });
    // the places it reaches, at the lines their words are on now
    expect(taken.uses).toEqual(["web/styles.css:4", "web/styles.css:6", "server/team.ts", "web/app.tsx:12"]);
    expect(taken.star).toBeUndefined();
    // and again changes nothing
    expect(syncIndexFile(store, "p1", dir)).toBe(0);
    expect(new ComponentStore().items("p1")).toHaveLength(2);
  });

  test("what is named here joins what the file lists, instead of replacing it", () => {
    const dir = project();
    writeIndexFile(dir, [team]);
    const store = new ComponentStore();
    store.add("p1", { name: "the drawing page", files: ["web/drawing-page.tsx"], exact: true });
    expect(syncIndexFile(store, "p1", dir)).toBe(1);
    const text = fs.readFileSync(file(dir), "utf8");
    expect(text).toContain("## drawing-page — the drawing page");
    expect(text).toContain("## team-page — the team page");
  });

  test("one taken out here stays out, and leaves the file", () => {
    const dir = project();
    writeIndexFile(dir, [team, entry("peek-band", "the peek band")]);
    const store = new ComponentStore();
    syncIndexFile(store, "p1", dir);
    store.remove("p1", store.find("p1", "peek-band")!.id);
    // the file still lists it as this is asked: it is not taken back in
    expect(syncIndexFile(store, "p1", dir)).toBe(0);
    expect(fs.readFileSync(file(dir), "utf8")).not.toContain("peek-band");
    expect(store.items("p1").map((i) => i.slug)).toEqual(["team-page"]);
    // until the project's file says it again — a pull, a revert
    writeIndexFile(dir, [team, entry("peek-band", "the peek band")]);
    expect(syncIndexFile(store, "p1", dir)).toBe(1);
  });

  test("words changed in the file are taken; words changed here stand; nothing leaves for being absent", () => {
    const dir = project();
    const band = entry("peek-band", "the peek band", { note: "the skyline" });
    writeIndexFile(dir, [team, band]);
    const store = new ComponentStore();
    syncIndexFile(store, "p1", dir);
    // a pull: the band's note rewritten elsewhere, the team page gone from the file
    writeIndexFile(dir, [{ ...band, note: "the skyline, at dusk", tags: ["band"] }]);
    expect(syncIndexFile(store, "p1", dir)).toBe(1);
    expect(store.find("p1", "peek-band")).toMatchObject({ note: "the skyline, at dusk", tags: ["band"] });
    expect(store.find("p1", "team-page")).toBeDefined();
    expect(fs.readFileSync(file(dir), "utf8")).toContain("## team-page");
    // changed here and in the file both: this install's stands
    const id = store.find("p1", "peek-band")!.id;
    store.update("p1", id, { note: "the skyline, here" });
    writeIndexFile(dir, [{ ...band, note: "the skyline, elsewhere" }]);
    expect(syncIndexFile(store, "p1", dir)).toBe(0);
    expect(store.find("p1", "peek-band")!.note).toBe("the skyline, here");
    expect(fs.readFileSync(file(dir), "utf8")).toContain("the skyline, here");
  });

  test("a place whose words are gone from its file keeps them, to be found again", () => {
    const dir = project();
    writeIndexFile(dir, [
      entry("team-page", "the team page", {
        uses: ["web/styles.css:40", "web/gone.css:3"],
        anchors: { "web/styles.css:40": ".no-such-rule {", "web/gone.css:3": ".elsewhere {" },
      }),
    ]);
    const committed = fs.readFileSync(file(dir), "utf8");
    const store = new ComponentStore();
    syncIndexFile(store, "p1", dir);
    expect(store.find("p1", "team-page")!.anchors).toEqual({
      "web/styles.css:1": ".no-such-rule {",
      "web/gone.css:1": ".elsewhere {",
    });
    expect(fs.readFileSync(file(dir), "utf8")).toBe(committed);
  });
});
