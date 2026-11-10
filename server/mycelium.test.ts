import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NamedComponent } from "../shared/protocol.js";
import { MYCELIUM_PREF } from "../shared/protocol.js";
import { ComponentStore } from "./components.js";
import { runLibrary, type LibraryHost, type LibraryProject } from "./library.js";
import {
  findMyc,
  mycFor,
  myceliumOn,
  parseExample,
  parseRoot,
  pickRoots,
  playUrl,
  readMirror,
  rendersLive,
  setExamples,
  settleMycelium,
  stopPlays,
  writeMirror,
  type MyceliumHost,
} from "./mycelium.js";

let config: string;
let work: string;
let savedConfig: string | undefined;
let savedMyc: string | undefined;
beforeAll(() => {
  savedConfig = process.env["RURI_CONFIG_DIR"];
  savedMyc = process.env["RURI_MYC"];
});
beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-myc-config-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-myc-"));
  process.env["RURI_CONFIG_DIR"] = config;
  // never the real myc
  process.env["RURI_MYC"] = "";
});
afterEach(() => {
  stopPlays();
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});
afterAll(() => {
  // back to the run's own folder (scripts/test-config.ts), never to the user's
  if (savedConfig === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = savedConfig;
  if (savedMyc === undefined) delete process.env["RURI_MYC"];
  else process.env["RURI_MYC"] = savedMyc;
});

/**
 * A stand-in for myc: every call is written to calls.log, and each command
 * prints the file of its name from the stand-in's folder (scan.json,
 * show.json, show.txt) — what the test put there.
 */
function fakeMyc(answers: Record<string, string>): { bin: string; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(work, "fake-"));
  for (const [name, text] of Object.entries(answers)) fs.writeFileSync(path.join(dir, name), text);
  const bin = path.join(dir, "myc");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
here="${dir}"
echo "$@" >> "$here/calls.log"
shift 2
cmd="$1"
json=""
for a in "$@"; do [ "$a" = "--json" ] && json=1; done
if [ "$cmd" = "play" ]; then
  [ -f "$here/play.fail" ] && { echo "no node_modules here" >&2; exit 1; }
  echo "myc play: http://localhost:4999/  (2 components; Ctrl-C stops it)"
  exec sleep 30
fi
if [ -n "$json" ] && [ -f "$here/$cmd.json" ]; then cat "$here/$cmd.json"; exit 0; fi
if [ -f "$here/$cmd.txt" ]; then cat "$here/$cmd.txt"; exit 0; fi
echo '{"error":"nothing here"}'
exit 1
`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () => {
      try {
        return fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
      } catch {
        return [];
      }
    },
  };
}

function entry(over: Partial<NamedComponent> & { slug: string }): NamedComponent {
  return {
    id: `id-${over.slug}`,
    name: over.slug.replace(/-/g, " "),
    aliases: [],
    files: [],
    note: "",
    shots: [],
    ts: 1,
    ...over,
  };
}

describe("the setting", () => {
  test("off unless turned on, and nothing without myc on the machine", () => {
    const prefs = (value?: string) => ({
      prefs: { all: (): Record<string, string> => (value ? { [MYCELIUM_PREF]: value } : {}) },
    });
    expect(myceliumOn(prefs())).toBe(false);
    expect(myceliumOn(prefs("on"))).toBe(true);
    expect(findMyc()).toBeNull();
    expect(mycFor(prefs("on"))).toBeNull();
    const { bin } = fakeMyc({});
    process.env["RURI_MYC"] = bin;
    expect(mycFor(prefs("on"))).toBe(bin);
    expect(mycFor(prefs("off"))).toBeNull();
  });
});

describe("roots", () => {
  test("a root is a file and a declaration", () => {
    expect(parseRoot("web/src/Card.tsx#Card")).toEqual({ file: "web/src/Card.tsx", symbol: "Card" });
    expect(parseRoot("web/src/Card.tsx")).toEqual({ file: "web/src/Card.tsx" });
  });

  test("a browser renders React, not SwiftUI or Go", () => {
    expect(rendersLive("web/src/Card.tsx#Card")).toBe(true);
    expect(rendersLive("ios/Ruri/Views/HomeView.swift#HomeView")).toBe(false);
    expect(rendersLive("internal/ui/model.go#Model")).toBe(false);
    expect(rendersLive(undefined)).toBe(false);
  });

  const found = [
    { file: "src/HomeBoard.tsx", symbol: "HomeTabs" },
    { file: "src/HomeBoard.tsx", symbol: "ProjectsPage" },
    { file: "src/Diff.tsx", symbol: "DiffView" },
    { file: "src/Components.tsx", symbol: "Components" },
    { file: "src/Components.tsx", symbol: "CopyButton" },
    { file: "src/Composer.tsx", symbol: "Composer" },
    { file: "src/Composer.tsx", symbol: "SendButton" },
  ];

  test("the declaration named like the entry is its root", () => {
    const picked = pickRoots(
      [
        entry({ slug: "home-tabs", files: ["src/HomeBoard.tsx"] }),
        entry({ slug: "projects-page", name: "the projects page", files: ["src/HomeBoard.tsx"] }),
      ],
      found,
    );
    expect(picked.get("id-home-tabs")).toBe("src/HomeBoard.tsx#HomeTabs");
    expect(picked.get("id-projects-page")).toBe("src/HomeBoard.tsx#ProjectsPage");
  });

  test("the only component its files hold, by any name", () => {
    const picked = pickRoots([entry({ slug: "patch", files: ["src/Diff.tsx"] })], found);
    expect(picked.get("id-patch")).toBe("src/Diff.tsx#DiffView");
  });

  test("the one its file is named after, when no other entry is about that file", () => {
    expect(pickRoots([entry({ slug: "input-box", files: ["src/Composer.tsx"] })], found).get("id-input-box")).toBe(
      "src/Composer.tsx#Composer",
    );
    // two entries about one file: which of them is the file's own is anyone's guess
    const two = pickRoots(
      [
        entry({ slug: "library-page", files: ["src/Components.tsx"] }),
        entry({ slug: "new-stars", files: ["src/Components.tsx"] }),
      ],
      found,
    );
    expect(two.size).toBe(0);
  });

  test("one word in common is not a name", () => {
    const picked = pickRoots(
      [
        entry({ slug: "name-everything-button", files: ["src/Components.tsx"] }),
        entry({ slug: "other", files: ["src/Components.tsx"] }),
      ],
      found,
    );
    expect(picked.has("id-name-everything-button")).toBe(false);
  });

  test("a root belongs to one entry, and one already tied is left alone", () => {
    const picked = pickRoots(
      [
        entry({ slug: "tabs", root: "src/HomeBoard.tsx#HomeTabs", files: ["src/HomeBoard.tsx"] }),
        entry({ slug: "home-tabs", files: ["src/HomeBoard.tsx"] }),
      ],
      found,
    );
    expect(picked.size).toBe(0);
  });
});

describe("the mirror", () => {
  test("rooted entries are written for mycelium, under ruri's id", () => {
    const { slugs, wrote } = writeMirror(work, [
      entry({ slug: "card", name: "the card", note: "a card\nmore", aliases: ["tile"], root: "src/Card.tsx#Card" }),
      entry({ slug: "loose" }),
    ]);
    expect(slugs).toEqual(["card"]);
    expect(wrote).toBe(true);
    const card = readMirror(work).get("card")!;
    expect(card.root).toEqual({ file: "src/Card.tsx", symbol: "Card" });
    expect(card.name).toBe("the card");
    expect(card.note).toBe("a card");
    expect(card.aliases).toEqual(["tile"]);
    expect(card.ruri).toBe("id-card");
    expect(readMirror(work).has("loose")).toBe(false);
  });

  test("what mycelium added to an entry is kept, and nothing is written when nothing changed", () => {
    const items = [entry({ slug: "card", root: "src/Card.tsx#Card" })];
    writeMirror(work, items);
    const file = path.join(work, ".mycelium", "components", "card.json");
    const kept = { ...JSON.parse(fs.readFileSync(file, "utf8")), pins: ["src/card.css"], fingerprint: { hash: "h" } };
    fs.writeFileSync(file, JSON.stringify(kept));
    expect(writeMirror(work, items).wrote).toBe(false);
    expect(writeMirror(work, [{ ...items[0]!, note: "now with a note" }]).wrote).toBe(true);
    const card = readMirror(work).get("card")!;
    expect(card.pins).toEqual(["src/card.css"]);
    expect(card["fingerprint"]).toEqual({ hash: "h" });
    // a root moved by hand is measured anew
    writeMirror(work, [{ ...items[0]!, root: "src/Card.tsx#BigCard" }]);
    expect(readMirror(work).get("card")!["fingerprint"]).toBeUndefined();
  });

  test("an entry gone or renamed takes its mirror with it; mycelium's own entries stay", () => {
    writeMirror(work, [entry({ slug: "card", root: "src/Card.tsx#Card" })]);
    const dir = path.join(work, ".mycelium", "components");
    fs.writeFileSync(
      path.join(dir, "theirs.json"),
      JSON.stringify({ slug: "theirs", name: "Theirs", root: { file: "src/T.tsx", symbol: "T" }, pins: [] }),
    );
    writeMirror(work, [entry({ slug: "price-card", id: "id-card", root: "src/Card.tsx#Card" })]);
    expect([...readMirror(work).keys()].sort()).toEqual(["price-card", "theirs"]);
  });

  test("examples are props by name", () => {
    expect(parseExample('basic={"title":"Hi"}')).toEqual({ name: "basic", props: { title: "Hi" } });
    expect(typeof parseExample("basic")).toBe("string");
    expect(typeof parseExample("basic=[1]")).toBe("string");
    expect(typeof parseExample("basic={oops}")).toBe("string");
    writeMirror(work, [entry({ slug: "card", root: "src/Card.tsx#Card" })]);
    expect(setExamples(work, "card", [{ name: "basic", props: { title: "Hi" } }])).toBe(true);
    expect(setExamples(work, "card", [{ name: "basic", props: { title: "Yo" } }])).toBe(true);
    expect(setExamples(work, "card", [{ name: "long", props: {} }], [])).toBe(true);
    expect(readMirror(work).get("card")!.examples).toEqual([
      { name: "basic", props: { title: "Yo" } },
      { name: "long", props: {} },
    ]);
    setExamples(work, "card", [], ["basic", "long"]);
    expect(readMirror(work).get("card")!.examples).toBeUndefined();
    expect(setExamples(work, "nope", [], [])).toBe(false);
  });
});

/** A library of plain objects, the way the store answers settleMycelium. */
function hostOf(items: NamedComponent[]): MyceliumHost {
  return {
    items: () => items,
    link: (id, patch) => {
      const item = items.find((i) => i.id === id)!;
      if (patch.root !== undefined) {
        if (patch.root) item.root = patch.root;
        else delete item.root;
      }
      if (patch.orphaned) item.orphaned = true;
      else if (patch.orphaned === false) delete item.orphaned;
      return true;
    },
    refile: (id, files) => {
      items.find((i) => i.id === id)!.files = files;
      return true;
    },
  };
}

describe("settling a library against the code", () => {
  test("entries are tied, mirrored, and take their files from the trace", async () => {
    fs.mkdirSync(path.join(work, "src"), { recursive: true });
    fs.writeFileSync(path.join(work, "src", "card.css"), ".card{}");
    const items = [
      entry({ slug: "card", files: ["src/Card.tsx", "src/card.css", "src/shared.ts"] }),
      entry({ slug: "theme", files: [] }),
    ];
    const myc = fakeMyc({
      "scan.json": JSON.stringify([
        { file: "src/Card.tsx", symbol: "Card", exported: true },
        { file: "src/List.tsx", symbol: "List", exported: true },
        { file: "src/List.tsx", symbol: "Inner", exported: false },
      ]),
      "show.json": JSON.stringify({
        slug: "card",
        status: "new",
        root: { file: "src/Card.tsx", symbol: "Card", line: 3 },
        files: [
          { file: "src/Card.tsx", kind: "code" },
          { file: "src/useCard.ts", kind: "code" },
        ],
        shared: ["src/shared.ts"],
      }),
    });
    const settled = await settleMycelium(myc.bin, work, hostOf(items), { link: true });
    expect(settled).toEqual({ changed: true, linked: 1, orphaned: 0, unnamed: 1 });
    expect(items[0]!.root).toBe("src/Card.tsx#Card");
    // the stylesheet nothing imports stays its own, pinned; the shared file is let go
    expect(items[0]!.files).toEqual(["src/Card.tsx", "src/useCard.ts", "src/card.css"]);
    expect(readMirror(work).get("card")!.pins).toEqual(["src/card.css"]);
    expect(items[1]!.root).toBeUndefined();
    const calls = myc.calls();
    expect(calls[0]).toContain("scan --all --json");
    expect(calls[1]).toContain("show card --no-code --json");
    // new to mycelium: recorded, so the next look measures from here
    expect(calls[2]).toContain("check --update");
  });

  test("a root that was renamed is followed; nothing to record, nothing recorded", async () => {
    const items = [
      entry({ slug: "card", root: "src/Card.tsx#Card", files: ["src/Card.tsx"] }),
      entry({ slug: "list", root: "src/List.tsx#List", files: ["src/List.tsx"] }),
    ];
    writeMirror(work, items);
    const myc = fakeMyc({
      "show.json": JSON.stringify([
        {
          slug: "card",
          status: "relinked",
          root: { file: "src/cards/PriceCard.tsx", symbol: "PriceCard" },
          files: [{ file: "src/cards/PriceCard.tsx", kind: "code" }],
        },
        {
          slug: "list",
          status: "ok",
          root: { file: "src/List.tsx", symbol: "List" },
          files: [{ file: "src/List.tsx", kind: "code" }],
        },
      ]),
    });
    const settled = await settleMycelium(myc.bin, work, hostOf(items));
    expect(settled.changed).toBe(true);
    expect(items[0]!.root).toBe("src/cards/PriceCard.tsx#PriceCard");
    expect(items[0]!.files).toEqual(["src/cards/PriceCard.tsx"]);
    expect(myc.calls().some((call) => call.includes("scan"))).toBe(false);
    expect(myc.calls().at(-1)).toContain("check --update");

    const quiet = fakeMyc({
      "show.json": JSON.stringify([
        {
          slug: "card",
          status: "ok",
          root: { file: "src/cards/PriceCard.tsx", symbol: "PriceCard" },
          files: [{ file: "src/cards/PriceCard.tsx", kind: "code" }],
        },
        { slug: "list", status: "ok", root: { file: "src/List.tsx", symbol: "List" }, files: [{ file: "src/List.tsx", kind: "code" }] },
      ]),
    });
    writeMirror(work, items);
    const again = await settleMycelium(quiet.bin, work, hostOf(items));
    expect(again).toEqual({ changed: false, linked: 2, orphaned: 0 });
    expect(quiet.calls()).toHaveLength(1);
  });

  test("a root found nowhere marks the entry lost, and finding it again clears that", async () => {
    const items = [entry({ slug: "card", root: "src/Card.tsx#Card", files: ["src/Card.tsx"] })];
    const lost = fakeMyc({
      "show.json": JSON.stringify({ slug: "card", status: "orphaned", root: { file: "src/Card.tsx", symbol: "Card" } }),
    });
    const settled = await settleMycelium(lost.bin, work, hostOf(items));
    expect(settled.orphaned).toBe(1);
    expect(items[0]!.orphaned).toBe(true);
    expect(items[0]!.files).toEqual(["src/Card.tsx"]);
    const back = fakeMyc({
      "show.json": JSON.stringify({
        slug: "card",
        status: "ok",
        root: { file: "src/Card.tsx", symbol: "Card" },
        files: [{ file: "src/Card.tsx", kind: "code" }],
      }),
    });
    await settleMycelium(back.bin, work, hostOf(items));
    expect(items[0]!.orphaned).toBeUndefined();
  });

  test("a myc that answers nothing changes nothing", async () => {
    const items = [entry({ slug: "card", root: "src/Card.tsx#Card", files: ["src/Card.tsx"] })];
    const broken = fakeMyc({});
    const settled = await settleMycelium(broken.bin, work, hostOf(items), { link: true });
    expect(settled.changed).toBe(false);
    expect(items[0]!.files).toEqual(["src/Card.tsx"]);
  });
});

describe("the store", () => {
  test("link ties an entry to its root, and unties it", () => {
    const store = new ComponentStore();
    const item = store.add("p", { name: "the card", files: ["src/Card.tsx"], exact: true });
    expect(store.link("p", item.id, { root: "src/Card.tsx#Card" })).toBe(true);
    expect(store.link("p", item.id, { root: "src/Card.tsx#Card" })).toBe(false);
    expect(store.link("p", item.id, { orphaned: true })).toBe(true);
    expect(store.items("p")[0]!.orphaned).toBe(true);
    // a new root is not the lost one
    store.link("p", item.id, { root: "src/Card.tsx#BigCard" });
    expect(store.items("p")[0]!.orphaned).toBeUndefined();
    store.link("p", item.id, { root: null });
    expect(store.items("p")[0]!.root).toBeUndefined();
    // and it survives a reload
    store.link("p", item.id, { root: "src/Card.tsx#Card" });
    expect(new ComponentStore().items("p")[0]!.root).toBe("src/Card.tsx#Card");
  });
});

describe("live rendering", () => {
  test("a playground is started once per project and its address handed out", async () => {
    const myc = fakeMyc({});
    const url = await playUrl(myc.bin, work);
    expect(url).toBe("http://localhost:4999/");
    expect(await playUrl(myc.bin, work)).toBe(url);
    expect(myc.calls().filter((call) => call.endsWith("play"))).toHaveLength(1);
    stopPlays();
    // stopped: the next ask starts another
    await playUrl(myc.bin, work);
    expect(myc.calls().filter((call) => call.endsWith("play"))).toHaveLength(2);
  });

  test("one that doesn't come up says why", async () => {
    const myc = fakeMyc({ "play.fail": "" });
    await expect(playUrl(myc.bin, work)).rejects.toThrow("no node_modules here");
  });
});

/* ── the ruri command ─────────────────────────────────────────────── */

function projectAt(files: Record<string, string>): LibraryProject {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  }
  return { id: "p", name: "shop", path: work };
}

function hostFor(here: LibraryProject, store: ComponentStore, bin?: string): LibraryHost & { settled: number } {
  const host: LibraryHost & { settled: number } = {
    settled: 0,
    here,
    projects: () => [here],
    ask: (proposal) => {
      store.add(here.id, { ...proposal, exact: true });
      return "added";
    },
    items: (id) => store.items(id),
    find: (id, handle) => store.find(id, handle),
    add: (id, input) => store.add(id, input),
    update: (id, componentId, patch) => store.update(id, componentId, patch),
    remove: (id, componentId) => store.remove(id, componentId),
    shoot: () => false,
    copyShots: () => {},
    current: () => {},
    dir: (id) => store.dir(id),
    setDir: (id, dir) => store.setDir(id, dir),
    noteInstall: () => {},
    follow: async () => {},
    changed: () => {},
    ...(bin
      ? {
          mycelium: {
            bin,
            link: (id, componentId, root) => void store.link(id, componentId, { root }),
            mirror: (id) => void writeMirror(here.path, store.items(id)),
            examples: (_id, slug, add, remove) => setExamples(here.path, slug, add, remove),
            settle: () => {
              host.settled++;
            },
          },
        }
      : {}),
  };
  return host;
}

describe("the ruri command over mycelium", () => {
  const files = {
    "src/Card.tsx": "export function Card() { return <div className='card' />; }\nexport function Badge() { return <b />; }\n",
    "src/List.tsx": "export function List() { return <ul />; }\n",
  };
  const scan = JSON.stringify([
    { file: "src/Card.tsx", symbol: "Card", exported: true },
    { file: "src/Card.tsx", symbol: "Badge", exported: true },
    { file: "src/List.tsx", symbol: "List", exported: true },
  ]);

  test("register --root ties the entry, and the root's file is its own", async () => {
    const store = new ComponentStore();
    const here = projectAt(files);
    const host = hostFor(here, store, fakeMyc({ "scan.json": scan }).bin);
    const answer = await runLibrary(host, [
      "register",
      "price-card",
      "--name",
      "the price card",
      "--root",
      "src/Card.tsx#Card",
      "--note",
      "a price",
    ]);
    expect(answer.ok).toBe(true);
    expect(answer.text).toContain("starts at src/Card.tsx#Card");
    expect(answer.text).toContain("--example");
    const item = store.find("p", "price-card")!;
    expect(item.root).toBe("src/Card.tsx#Card");
    expect(item.files).toEqual(["src/Card.tsx"]);
    expect(host.settled).toBe(1);
  });

  test("a file with one component needs no #Symbol; one with several asks which", async () => {
    const store = new ComponentStore();
    const host = hostFor(projectAt(files), store, fakeMyc({ "scan.json": scan }).bin);
    const one = await runLibrary(host, ["register", "the-list", "--name", "the list", "--root", "src/List.tsx"]);
    expect(one.ok).toBe(true);
    expect(store.find("p", "the-list")!.root).toBe("src/List.tsx#List");
    const several = await runLibrary(host, ["register", "card", "--name", "the card", "--root", "src/Card.tsx"]);
    expect(several.ok).toBe(false);
    expect(several.text).toContain("src/Card.tsx#Card, src/Card.tsx#Badge");
    const wrong = await runLibrary(host, ["register", "card", "--name", "the card", "--root", "src/Card.tsx#Nope"]);
    expect(wrong.ok).toBe(false);
    expect(wrong.text).toContain("no declaration named Nope");
    const taken = await runLibrary(host, ["register", "list-2", "--name", "another list", "--root", "src/List.tsx#List"]);
    expect(taken.ok).toBe(false);
    expect(taken.text).toContain("already the-list's root");
  });

  test("without mycelium --root says how to get it, and plain registering still works", async () => {
    const store = new ComponentStore();
    const host = hostFor(projectAt(files), store);
    const answer = await runLibrary(host, ["register", "card", "--name", "the card", "--root", "src/Card.tsx#Card"]);
    expect(answer.ok).toBe(false);
    expect(answer.text).toContain("Live components");
    const plain = await runLibrary(host, ["register", "card", "--name", "the card", "--files", "src/Card.tsx"]);
    expect(plain.ok).toBe(true);
    expect(store.find("p", "card")!.root).toBeUndefined();
  });

  test("edit ties, unties and gives examples; show answers with mycelium's reading", async () => {
    const store = new ComponentStore();
    const here = projectAt(files);
    const myc = fakeMyc({
      "scan.json": scan,
      "show.txt": "card — the card  [ok]\n\nroot     src/Card.tsx#Card:1\nfiles    src/Card.tsx:1\n\n── src/Card.tsx:1\nexport function Card() {}\n",
    });
    const host = hostFor(here, store, myc.bin);
    await runLibrary(host, ["register", "card", "--name", "the card", "--files", "src/Card.tsx"]);
    const early = await runLibrary(host, ["edit", "card", "--example", 'basic={"title":"Hi"}']);
    expect(early.ok).toBe(false);
    expect(early.text).toContain("isn't tied to the code yet");

    const tied = await runLibrary(host, ["edit", "card", "--root", "src/Card.tsx#Card", "--example", 'basic={"title":"Hi"}']);
    expect(tied.ok).toBe(true);
    expect(tied.text).toContain("starts at src/Card.tsx#Card");
    expect(tied.text).toContain("renders with basic");
    expect(store.find("p", "card")!.root).toBe("src/Card.tsx#Card");
    expect(readMirror(here.path).get("card")!.examples).toEqual([{ name: "basic", props: { title: "Hi" } }]);

    const bad = await runLibrary(host, ["edit", "card", "--example", "basic=nope"]);
    expect(bad.ok).toBe(false);

    const shown = await runLibrary(host, ["show", "card"]);
    expect(shown.ok).toBe(true);
    expect(shown.text).toContain("## card — the card");
    expect(shown.text).toContain("Starts at: src/Card.tsx#Card");
    expect(shown.text).toContain("── src/Card.tsx:1");
    expect(myc.calls().at(-1)).toContain("show card");

    const untied = await runLibrary(host, ["edit", "card", "--root", "none"]);
    expect(untied.ok).toBe(true);
    expect(store.find("p", "card")!.root).toBeUndefined();
    // untied: the files are read whole, the old way
    const plain = await runLibrary(host, ["show", "card"]);
    expect(plain.text).toContain("--- src/Card.tsx ---");
  });
});
