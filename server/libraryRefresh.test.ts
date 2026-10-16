import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { componentStale, type Attachment, type NamedComponent } from "../shared/protocol.js";
import { codeSig } from "./checkouts.js";
import { ComponentStore } from "./components.js";
import { entryLines } from "./library.js";
import {
  CHANGE_GRACE_MS,
  changesSince,
  dirtyFiles,
  fileHistory,
  lineSince,
  mapLine,
  parseHistory,
  parseHunks,
  reanchor,
  renamedTo,
  seenChange,
  tidyFiles,
} from "./libraryRefresh.js";
import { photoPrompt } from "./photographer.js";

let config: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-refresh-"));
  process.env["RURI_CONFIG_DIR"] = config;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

function shot(id: string): Attachment {
  return { id, kind: "image", mediaType: "image/png", name: `${id}.png`, n: 1, url: `/uploads/${id}.png` };
}

function entry(over: Partial<NamedComponent>): NamedComponent {
  return {
    id: "c1",
    name: "the peek band",
    slug: "peek-band",
    aliases: [],
    files: ["web/src/components/PeekBand.tsx"],
    note: "the strip of pictures",
    shots: [],
    ts: 1_000,
    ...over,
  };
}

/** A git repo with these files committed, and a way to run git in it at
 *  a given time (s). */
function repo(files: Record<string, string>): { dir: string; git(args: string[], when: number): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-refresh-repo-"));
  const git = (args: string[], when: number) => {
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `@${when} +0000`,
        GIT_COMMITTER_DATE: `@${when} +0000`,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  };
  git(["init", "-q", "-b", "master"], 1_700_000_000);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(["add", "-A"], 1_700_000_000);
  git(["commit", "-q", "-m", "first"], 1_700_000_000);
  return { dir, git };
}

describe("pictures, newest first", () => {
  test("a new picture goes in front and becomes the one shown", () => {
    const store = new ComponentStore();
    const item = store.add("p", { name: "the peek band", files: ["web/src/components/PeekBand.tsx"] });
    store.addShot("p", item.id, shot("old"));
    store.addShot("p", item.id, shot("new"));
    const now = store.items("p")[0]!;
    expect(now.shots.map((s) => s.id)).toEqual(["new", "old"]);
    expect(now.shotAt).toBeGreaterThan(0);
  });

  test("an old library is put the new way round, pictures filed together kept in order", () => {
    const uploads = path.join(config, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    const stamp = (id: string, at: number) => {
      const file = path.join(uploads, `${id}.png`);
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, at / 1000, at / 1000);
    };
    const day = 86_400_000;
    stamp("a", 1_700_000_000_000);
    stamp("b", 1_700_000_000_000 + 5_000); // filed with a
    stamp("c", 1_700_000_000_000 + 3 * day); // retaken later
    fs.mkdirSync(path.join(config, "components"), { recursive: true });
    fs.writeFileSync(
      path.join(config, "components", "p.json"),
      JSON.stringify({ version: 2, items: [entry({ shots: [shot("a"), shot("b"), shot("c")] })] }),
    );
    const item = new ComponentStore().items("p")[0]!;
    expect(item.shots.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(Math.round(item.shotAt!)).toBe(1_700_000_000_000 + 3 * day);
    expect(item.noteAt).toBe(1_000);
  });

  test("the same handle asked for on purpose is the same entry", () => {
    const store = new ComponentStore();
    store.add("p", { name: "the peek band", slug: "peek-band", files: ["web/src/components/PeekBand.tsx"] });
    const again = store.add("p", { name: "peek strip", slug: "peek-band", note: "now with GIFs" });
    expect(store.items("p")).toHaveLength(1);
    expect(again.note).toBe("now with GIFs");
  });
});

describe("falling behind the code", () => {
  /** A folder holding a component's file, and the store's check against it. */
  function bench(text: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-refresh-code-"));
    fs.writeFileSync(path.join(dir, "a.tsx"), text);
    const store = new ComponentStore();
    const sig = () => codeSig(dir, ["a.tsx"]);
    const check = (wip?: { dir: string }) =>
      store.check("p", (item) => ({
        missing: [],
        ...(sig() ? { sig: sig()! } : {}),
        ...(wip && item.filedIn ? { wip: codeSig(wip.dir, item.files)! } : {}),
      }));
    const write = (next: string) => {
      fs.writeFileSync(path.join(dir, "a.tsx"), next);
      // a new mtime, so the hash is read again
      const later = Date.now() / 1000 + Math.random() * 100;
      fs.utimesSync(path.join(dir, "a.tsx"), later, later);
    };
    return { dir, store, sig, check, write };
  }

  test("a change to its code leaves picture and note behind; undoing it is no change", () => {
    const { store, sig, check, write } = bench("v1");
    const item = store.add("p", { name: "the peek band", files: ["a.tsx"], sig: sig()! });
    store.addShot("p", item.id, shot("s"), sig());
    expect(check()).toBe(false);
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: false, note: false });
    write("v2");
    expect(check()).toBe(true);
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: true, note: true });
    // checked again with nothing new: nothing moves
    expect(check()).toBe(false);
    write("v1");
    expect(check()).toBe(true);
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: false, note: false });
  });

  test("a new picture of the changed code is current; the note it left alone is not", () => {
    const { store, sig, check, write } = bench("v1");
    const item = store.add("p", { name: "the peek band", files: ["a.tsx"], sig: sig()! });
    store.addShot("p", item.id, shot("s"), sig());
    write("v2");
    check();
    store.addShot("p", item.id, shot("t"), sig());
    check();
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: false, note: true });
    store.update("p", item.id, { note: "now with GIFs" }, { sig: sig()! });
    check();
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: false, note: false });
  });

  test("a picture re-taken in a worktree is not out of date before its merge, nor after", () => {
    const main = bench("v1");
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-refresh-tree-"));
    fs.writeFileSync(path.join(tree, "a.tsx"), "v2");
    const { store, sig, check } = main;
    const item = store.add("p", { name: "the peek band", files: ["a.tsx"], sig: sig()! });
    store.addShot("p", item.id, shot("s"), sig());
    // the branch changes it, and files a new picture and note from there
    const there = codeSig(tree, ["a.tsx"])!;
    store.addShot("p", item.id, shot("t"), there, tree);
    store.update("p", item.id, { note: "v2" }, { sig: there, filedIn: tree });
    check({ dir: tree });
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: false, note: false });
    // merged: the project's folder has what the worktree had
    main.write("v2");
    check({ dir: tree });
    const merged = store.items("p")[0]!;
    expect(componentStale(merged)).toEqual({ picture: false, note: false });
    expect(merged.filedIn).toBeUndefined();
  });

  test("an entry from before signatures takes the code as it is, unless it is already behind", () => {
    const { store, sig, check } = bench("v1");
    const a = store.add("p", { name: "the band", files: ["a.tsx"] });
    const b = store.add("p", { name: "the strip", files: ["a.tsx"] });
    store.addShot("p", a.id, shot("s"));
    store.addShot("p", b.id, shot("t"));
    for (const item of store.items("p")) {
      delete item.shotSig;
      delete item.noteSig;
    }
    store.items("p")[1]!.changedAt = Date.now() + 1_000;
    check();
    expect(store.items("p")[0]!.shotSig).toBe(sig()!);
    expect(componentStale(store.items("p")[0]!).picture).toBe(false);
    expect(componentStale(store.items("p")[1]!).picture).toBe(true);
    // "still right": the mark comes off without a new picture
    store.current("p", b.id, sig());
    check();
    expect(componentStale(store.items("p")[1]!)).toEqual({ picture: false, note: false });
  });

  test("the move from turns: git's word on what changed, the rest let go", () => {
    const store = new ComponentStore();
    const a = store.add("p", { name: "the band", files: ["a.tsx"] });
    const b = store.add("p", { name: "the strip", files: ["b.tsx"] });
    store.addShot("p", a.id, shot("s"));
    store.addShot("p", b.id, shot("t"));
    for (const item of store.items("p")) item.changedAt = Date.now() + 5_000;
    expect(store.checked("p")).toBe(false);
    store.rebase("p", new Map([[b.id, Date.now() + 10_000]]));
    expect(store.checked("p")).toBe(true);
    expect(componentStale(store.items("p")[0]!).picture).toBe(false);
    expect(componentStale(store.items("p")[1]!).picture).toBe(true);
    expect(new ComponentStore().checked("p")).toBe(true);
  });

  test("a review keeps an untouched look's picture and takes a new note", () => {
    const store = new ComponentStore();
    const item = store.add("p", { name: "the peek band", files: ["a.tsx"] });
    store.addShot("p", item.id, shot("s"));
    const e = store.items("p")[0]!;
    e.shotAt = 10;
    e.noteAt = 10;
    e.changedAt = 50;
    store.reviewed("p", item.id, { note: "the strip, now draggable", looks: false }, "sig2");
    const after = store.items("p")[0]!;
    expect(after.note).toBe("the strip, now draggable");
    expect(after.shotSig).toBe("sig2");
    expect(componentStale(after)).toEqual({ picture: false, note: false });

    after.changedAt = Date.now() + 10;
    store.reviewed("p", item.id, { looks: true }, "sig3");
    expect(componentStale(store.items("p")[0]!).picture).toBe(true);
  });

  test("pictures whose files are gone are let go as the library loads", () => {
    const uploads = path.join(config, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, "kept.png"), "x");
    fs.mkdirSync(path.join(config, "components"), { recursive: true });
    fs.writeFileSync(
      path.join(config, "components", "p.json"),
      JSON.stringify({
        version: 4,
        items: [
          entry({ id: "a", shots: [shot("gone"), shot("kept")], shotAt: 5 }),
          entry({ id: "b", slug: "b", name: "b", shots: [shot("gone2")], shotAt: 5, shotSig: "x" }),
        ],
      }),
    );
    const items = new ComponentStore().items("p");
    expect(items[0]!.shots.map((s) => s.id)).toEqual(["kept"]);
    expect(items[1]!.shots).toEqual([]);
    expect(items[1]!.shotAt).toBeUndefined();
  });

  test("a stale picture says so where a model reads the entry", () => {
    const lines = entryLines(entry({ shots: [shot("s")], shotAt: 10, changedAt: 20 })).join("\n");
    expect(lines).toContain("ruri edit peek-band --shot");
    expect(entryLines(entry({ shots: [shot("s")], shotAt: 30, changedAt: 20 })).join("\n")).not.toContain(
      "--shot",
    );
  });

  test("retired entries leave the library but are kept beside it", () => {
    const store = new ComponentStore();
    const a = store.add("p", { name: "old dialog", files: ["x.tsx"] });
    store.add("p", { name: "new dialog", files: ["y.tsx"] });
    expect(store.retire("p", [a.id]).map((i) => i.name)).toEqual(["old dialog"]);
    expect(store.items("p").map((i) => i.name)).toEqual(["new dialog"]);
    const kept = JSON.parse(fs.readFileSync(path.join(config, "components", "p.gone.json"), "utf8"));
    expect(kept.items.map((i: NamedComponent) => i.name)).toEqual(["old dialog"]);
  });
});

describe("what git says", () => {
  test("history parses per file, newest first", () => {
    const out =
      "\u00011700000200\u0002second\nweb/a.tsx\n\n\u00011700000100\u0002first\nweb/a.tsx\nweb/b.css\n";
    const byFile = parseHistory(out);
    expect(byFile.get("web/a.tsx")!.map((c) => c.subject)).toEqual(["second", "first"]);
    expect(byFile.get("web/b.css")![0]!.at).toBe(1_700_000_100_000);
  });

  test("changes past the grace count; a commit right after the picture is the same work", () => {
    const shotAt = 1_700_000_000_000;
    const item = entry({ files: ["a.tsx"], shots: [shot("s")], shotAt, noteAt: shotAt });
    const history = new Map([
      [
        "a.tsx",
        [
          { at: shotAt + CHANGE_GRACE_MS + 60_000, subject: "feat: a new layout" },
          { at: shotAt + 5 * 60_000, subject: "feat: add the band" },
        ],
      ],
    ]);
    const [change] = changesSince([item], history, new Set(), () => undefined);
    expect(change!.commits.map((c) => c.subject)).toEqual(["feat: a new layout"]);
    expect(
      changesSince([item], new Map([["a.tsx", [history.get("a.tsx")![1]!]]]), new Set(), () => 0),
    ).toEqual([]);
  });

  test("tests, docs, chores and reformatting are not changes to a component", () => {
    expect(seenChange("style: prettier across the repo")).toBe(false);
    expect(seenChange("test(chat): cover the queue")).toBe(false);
    expect(seenChange("chore!: drop node 18")).toBe(false);
    expect(seenChange("style(sidebar): rounder rows")).toBe(true);
    expect(seenChange("feat(chat): the brief scrolls")).toBe(true);
    expect(seenChange("a plain subject")).toBe(true);
  });

  test("uncommitted edits count, by when the file was written", () => {
    const item = entry({ files: ["a.tsx"], noteAt: 1_000 });
    const [change] = changesSince([item], new Map(), new Set(["a.tsx"]), () => 1_000 + CHANGE_GRACE_MS + 5);
    expect(change).toMatchObject({ uncommitted: true, commits: [] });
  });

  test("a renamed file is followed, a deleted one dropped, an entry with nothing left is gone", async () => {
    const { dir, git } = repo({
      "web/Band.tsx": "band",
      "web/Card.tsx": "card",
      "web/styles.css": "css",
      "web/Old.tsx": "old",
    });
    git(["mv", "web/Band.tsx", "web/PeekBand.tsx"], 1_700_000_500);
    git(["rm", "-q", "web/Old.tsx"], 1_700_000_500);
    git(["commit", "-q", "-m", "move things"], 1_700_000_500);

    expect(await renamedTo(dir, "web/Band.tsx")).toBe("web/PeekBand.tsx");
    expect(await renamedTo(dir, "web/Old.tsx")).toBeUndefined();
    // staged, not committed yet
    git(["mv", "web/Card.tsx", "web/PriceCard.tsx"], 1_700_000_600);
    expect(await renamedTo(dir, "web/Card.tsx")).toBe("web/PriceCard.tsx");
    git(["mv", "web/PriceCard.tsx", "web/Card.tsx"], 1_700_000_600);

    const tidy = await tidyFiles(dir, [
      entry({ id: "band", files: ["web/Band.tsx"], uses: ["web/styles.css:12"] }),
      entry({ id: "card", files: ["web/Card.tsx", "web/Old.tsx"] }),
      entry({ id: "old", files: ["web/Old.tsx"] }),
      entry({ id: "old-styled", files: ["web/Old.tsx"], uses: ["web/styles.css:3"] }),
      entry({ id: "fine", files: ["web/Card.tsx"] }),
    ]);
    expect(tidy).toEqual([
      { id: "band", files: ["web/PeekBand.tsx"] },
      { id: "card", files: ["web/Card.tsx"] },
      { id: "old", gone: true },
      { id: "old-styled", gone: true },
    ]);

    const history = await fileHistory(dir, 0);
    expect(history.get("web/PeekBand.tsx")![0]!.subject).toBe("move things");
    fs.writeFileSync(path.join(dir, "web/Card.tsx"), "card, edited");
    expect([...(await dirtyFiles(dir))]).toEqual(["web/Card.tsx"]);
  });

  test("a file still in one of the project's worktrees is not gone", async () => {
    const { dir } = repo({ "web/Card.tsx": "card" });
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-refresh-wt-"));
    fs.mkdirSync(path.join(tree, "web"));
    fs.writeFileSync(path.join(tree, "web/Toast.tsx"), "toast");
    const item = entry({ id: "toast", files: ["web/Toast.tsx"] });
    expect(await tidyFiles(dir, [item])).toEqual([{ id: "toast", gone: true }]);
    expect(await tidyFiles(dir, [item], [tree])).toEqual([]);
  });
});

describe("lines that move", () => {
  test("a place at a line is found again by its text", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-refresh-lines-"));
    const css = (top: number) =>
      [
        ...Array.from({ length: top }, (_, i) => `.filler-${i} { color: red; }`),
        ".lib-grid {",
        "  gap: 4px;",
        "}",
      ].join("\n");
    fs.writeFileSync(path.join(dir, "styles.css"), css(10));
    // first sight: the line's text becomes its anchor
    const first = reanchor(dir, ["styles.css:11", "other.css"], undefined)!;
    expect(first.uses).toEqual(["styles.css:11", "other.css"]);
    expect(first.anchors).toEqual({ "styles.css:11": ".lib-grid {" });
    expect(reanchor(dir, first.uses, first.anchors)).toBeUndefined();
    // forty lines go in above it
    fs.writeFileSync(path.join(dir, "styles.css"), css(50));
    const moved = reanchor(dir, first.uses, first.anchors)!;
    expect(moved.uses).toEqual(["styles.css:51", "other.css"]);
    expect(moved.anchors).toEqual({ "styles.css:51": ".lib-grid {" });
    // a brace says nothing: no anchor for it
    expect(reanchor(dir, ["styles.css:53"], undefined)).toBeUndefined();
  });

  test("a line is followed through git's hunks", async () => {
    const hunks = parseHunks(
      ["@@ -3,0 +4,2 @@", "+a", "+b", "@@ -10,2 +12 @@", "-x", "-y", "+z", "@@ -20 +20,0 @@", "-gone"].join(
        "\n",
      ),
    );
    expect(mapLine(hunks, 2)).toBe(2);
    expect(mapLine(hunks, 3)).toBe(3);
    expect(mapLine(hunks, 4)).toBe(6);
    expect(mapLine(hunks, 11)).toBe(12);
    expect(mapLine(hunks, 15)).toBe(16);
    expect(mapLine(hunks, 25)).toBe(25);

    const { dir, git } = repo({ "s.css": ["a", "b", ".target {", "c"].join("\n") });
    fs.writeFileSync(path.join(dir, "s.css"), ["new1", "new2", "a", "b", ".target {", "c"].join("\n"));
    git(["commit", "-qam", "more"], 1_700_000_900);
    expect(await lineSince(dir, "s.css", 3, 1_700_000_100_000)).toBe(5);
  });
});

describe("the pictures chat", () => {
  test("its prompt lists each entry, why, and how to file the picture", () => {
    const prompt = photoPrompt([
      { item: entry({ selector: ".band-stage", route: "/", clicks: [".open"] }), why: "none" },
      {
        item: entry({ slug: "dragon-gauges", name: "the dragon gauges", shots: [shot("s")] }),
        why: "changed",
        commits: ["2026-09-22 feat: sweating dragons"],
      },
    ]);
    expect(prompt).toContain("2 of them");
    expect(prompt).toContain('peek-band — "the peek band" (no picture yet)');
    expect(prompt).toContain("on screen: / >> .open >> .band-stage");
    expect(prompt).toContain("(its look changed since its picture)");
    expect(prompt).toContain("changed by: 2026-09-22 feat: sweating dragons");
    expect(prompt).toContain("ruri edit <slug> --shot <png>");
    expect(prompt).toContain("Don't change the project's code");
  });
});
