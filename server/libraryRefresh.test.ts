import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { componentStale, type Attachment, type NamedComponent } from "../shared/protocol.js";
import { ComponentStore } from "./components.js";
import { entryLines } from "./library.js";
import {
  CHANGE_GRACE_MS,
  changesSince,
  dirtyFiles,
  fileHistory,
  parseHistory,
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
  test("a turn that edits its files leaves the picture and note behind", () => {
    const store = new ComponentStore();
    const item = store.add("p", { name: "the peek band", files: ["web/src/components/PeekBand.tsx"] });
    store.addShot("p", item.id, shot("s"));
    // pretend the picture and note are from well before this turn
    const e = store.items("p")[0]!;
    e.shotAt = 10;
    e.noteAt = 10;
    expect(store.touch("p", ["web/src/components/Other.tsx"], 100)).toBe(false);
    expect(store.touch("p", ["web/src/components/PeekBand.tsx"], 100)).toBe(true);
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: true, note: true });
  });

  test("a turn that also retook the picture keeps it current", () => {
    const store = new ComponentStore();
    const item = store.add("p", { name: "the peek band", files: ["web/src/components/PeekBand.tsx"] });
    const turnStarted = Date.now() - 1_000;
    store.addShot("p", item.id, shot("s")); // during the turn
    store.items("p")[0]!.noteAt = 10; // the note is old
    store.touch("p", ["web/src/components/PeekBand.tsx"], turnStarted);
    expect(componentStale(store.items("p")[0]!)).toEqual({ picture: false, note: true });
  });

  test("a review keeps an untouched look's picture and takes a new note", () => {
    const store = new ComponentStore();
    const item = store.add("p", { name: "the peek band", files: ["a.tsx"] });
    store.addShot("p", item.id, shot("s"));
    const e = store.items("p")[0]!;
    e.shotAt = 10;
    e.noteAt = 10;
    store.noteChange("p", item.id, 50);
    store.reviewed("p", item.id, { note: "the strip, now draggable", looks: false });
    const after = store.items("p")[0]!;
    expect(after.note).toBe("the strip, now draggable");
    expect(componentStale(after)).toEqual({ picture: false, note: false });

    store.noteChange("p", item.id, Date.now() + 10);
    store.reviewed("p", item.id, { looks: true });
    expect(componentStale(store.items("p")[0]!).picture).toBe(true);
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
});

describe("the pictures chat", () => {
  test("its prompt lists each entry, why, and how to file the picture", () => {
    const prompt = photoPrompt([
      { item: entry({ selector: ".band-stage", route: "/", clicks: [".open"] }), why: "none" },
      {
        item: entry({ slug: "hero-face", name: "the hero face", shots: [shot("s")] }),
        why: "changed",
        commits: ["2026-09-22 feat: circle frame"],
      },
    ]);
    expect(prompt).toContain("2 of them");
    expect(prompt).toContain('peek-band — "the peek band" (no picture yet)');
    expect(prompt).toContain("on screen: / >> .open >> .band-stage");
    expect(prompt).toContain("(its look changed since its picture)");
    expect(prompt).toContain("changed by: 2026-09-22 feat: circle frame");
    expect(prompt).toContain("ruri edit <slug> --shot <png>");
    expect(prompt).toContain("Don't change the project's code");
  });
});
