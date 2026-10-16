import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ComponentStore } from "./components.js";
import {
  cliEnv,
  installCli,
  isUiFile,
  parseArgs,
  planCopy,
  readFile,
  runLibrary,
  search,
  skillDir,
  slugify,
  splitFiles,
  SKILL_DESCRIPTION,
  writeLibrarySkill,
  type LibraryHost,
  type LibraryProject,
} from "./library.js";

let config: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-library-"));
  process.env["RURI_CONFIG_DIR"] = config;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

/** A project folder with these files in it. */
function project(name: string, files: Record<string, string>): LibraryProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ruri-lib-${name}-`));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return { id: `id-${name}`, name, path: dir };
}

/** The host the command gets in the app, over a real store. */
function hostFor(here: LibraryProject, store: ComponentStore, others: LibraryProject[] = []): LibraryHost {
  return {
    here,
    projects: () => [here, ...others],
    // as in bypass: straight in
    ask: (proposal) => {
      store.add(here.id, {
        ...proposal,
        exact: true,
        ...(proposal.checkout ? { filedIn: proposal.checkout } : {}),
      });
      return "added";
    },
    items: (id) => store.items(id),
    find: (id, handle) => store.find(id, handle),
    add: (id, input) => store.add(id, input),
    update: (id, componentId, patch, filed) =>
      store.update(id, componentId, patch, {
        ...(filed?.sig ? { sig: filed.sig } : {}),
        ...(filed?.in ? { filedIn: filed.in } : {}),
      }),
    remove: (id, componentId) => store.remove(id, componentId),
    shoot: (id, componentId, file, filed) =>
      fs.existsSync(file) &&
      store.addShot(
        id,
        componentId,
        { id: path.basename(file), kind: "image", mediaType: "image/png", name: path.basename(file), n: 1 },
        filed?.sig,
        filed?.in,
      ),
    copyShots: (id, componentId, shots) => {
      for (const shot of shots) store.addShot(id, componentId, shot);
    },
    current: (id, componentId, filed) => {
      store.current(id, componentId, filed?.sig, filed?.in);
    },
    dir: (id) => store.dir(id),
    setDir: (id, dir) => store.setDir(id, dir),
    noteInstall: (id, componentId, paths) => store.noteInstall(id, componentId, paths),
    follow: async () => {},
    changed: () => {},
  };
}

/** A real git repository with these files committed, and a worktree of it
 *  on a branch of its own. */
function repoWithWorktree(files: Record<string, string>): { main: LibraryProject; tree: string } {
  const main = project("repo", files);
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git(main.path, ["init", "-q", "-b", "master"]);
  git(main.path, ["add", "-A"]);
  git(main.path, ["commit", "-q", "-m", "first"]);
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-lib-tree-"));
  fs.rmSync(tree, { recursive: true });
  git(main.path, ["worktree", "add", "-q", tree, "-b", "feat/x"]);
  return { main, tree };
}

describe("handles", () => {
  test("a name becomes a kebab handle without its article", () => {
    expect(slugify("the peek band")).toBe("peek-band");
    expect(slugify("Makima’s eye icons")).toBe("makima-s-eye-icons");
    expect(slugify("  Café Menu!! ")).toBe("cafe-menu");
    expect(slugify("the")).toBe("the");
    expect(slugify("!!!")).toBe("component");
  });

  test("the store hands out unique handles and finds entries by any name", () => {
    const store = new ComponentStore();
    const a = store.add("p", { name: "the peek band", files: ["web/src/PeekBand.tsx"] });
    const b = store.add("p", { name: "peek band!", files: ["web/src/Other.tsx"] });
    expect(a.slug).toBe("peek-band");
    expect(b.slug).toBe("peek-band-2");
    expect(store.find("p", "peek-band")?.id).toBe(a.id);
    expect(store.find("p", "The Peek Band")?.id).toBe(a.id);
    expect(store.find("p", "peek band!")?.id).toBe(b.id);
  });
});

describe("interface only", () => {
  test("views, styles and pictures are interface; server modules are not", () => {
    expect(isUiFile("web/src/components/PeekBand.tsx")).toBe(true);
    expect(isUiFile("web/src/styles.css:2864")).toBe(true);
    expect(isUiFile("assets/icon.svg")).toBe(true);
    expect(isUiFile("tui/internal/ui/view.go")).toBe(true);
    expect(isUiFile("server/compaction.ts")).toBe(false);
    expect(isUiFile("server/secrets.ts")).toBe(false);
    expect(isUiFile("shared/protocol.ts")).toBe(false);
  });

  test("a line-numbered or shared file is a place it reaches, and its own name picks its files", () => {
    expect(
      splitFiles(
        [
          "web/src/components/PeekBand.tsx",
          "web/src/lib/peekBand.ts",
          "web/src/components/Sidebar.tsx",
          "web/src/styles.css",
          "web/src/components/ChatPane.tsx:1015",
          "server/bridge.ts",
        ],
        "peek-band",
      ),
    ).toEqual({
      files: ["web/src/components/PeekBand.tsx", "web/src/lib/peekBand.ts"],
      uses: [
        "web/src/styles.css",
        "web/src/components/ChatPane.tsx:1015",
        "server/bridge.ts",
        "web/src/components/Sidebar.tsx",
      ],
    });
    // nothing carries the name: every interface file of its own is its own
    expect(splitFiles(["src/App.tsx", "src/Viewport.tsx"], "world-editor")).toEqual({
      files: ["src/App.tsx", "src/Viewport.tsx"],
    });
  });

  test("an old index becomes a library: backend entries set aside, handles made, files split", () => {
    const file = path.join(config, "components", "p.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        items: [
          {
            id: "1",
            name: "the talk page",
            aliases: [],
            files: ["web/src/components/TalkPage.tsx", "web/src/components/ChatPane.tsx", "server/talk.ts"],
            note: "who may message whom",
            shots: [],
            ts: 1,
          },
          {
            id: "2",
            name: "compaction",
            aliases: [],
            files: ["server/compaction.ts"],
            note: "",
            shots: [],
            ts: 2,
          },
        ],
      }),
    );
    const store = new ComponentStore();
    const items = store.items("p");
    expect(items.map((i) => i.slug)).toEqual(["talk-page"]);
    expect(items[0]!.files).toEqual(["web/src/components/TalkPage.tsx"]);
    expect(items[0]!.uses).toEqual(["server/talk.ts", "web/src/components/ChatPane.tsx"]);
    const aside = JSON.parse(fs.readFileSync(path.join(config, "components", "p.not-ui.json"), "utf8"));
    expect(aside.items.map((i: { name: string }) => i.name)).toEqual(["compaction"]);
    // migrated once: the file now says so, and a reload changes nothing
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(4);
    expect(new ComponentStore().items("p").map((i) => i.slug)).toEqual(["talk-page"]);
  });
});

describe("the command", () => {
  test("arguments: words, valued flags (both spellings, repeats), switches", () => {
    const args = parseArgs(["add", "a", "b", "--dir", "src/ui", "--tags=x,y", "--tags", "z", "--overwrite"]);
    expect(args.words).toEqual(["add", "a", "b"]);
    expect(args.flags.get("dir")).toEqual(["src/ui"]);
    expect(args.flags.get("tags")).toEqual(["x,y", "z"]);
    expect([...args.switches]).toEqual(["overwrite"]);
  });

  test("register, list, search, show, edit and remove", async () => {
    const here = project("app", {
      "src/components/ConfirmCard.tsx": "export function ConfirmCard() {}\n",
      "src/components/confirm.css": ".confirm { color: red }\n",
      "server/db.ts": "export const db = 1;\n",
    });
    const store = new ComponentStore();
    const host = hostFor(here, store);

    const refused = await runLibrary(host, ["register", "db", "--name", "the db", "--files", "server/db.ts"]);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("interface");

    const made = await runLibrary(host, [
      "register",
      "confirm-card",
      "--name",
      "the confirm card",
      "--files",
      "src/components/ConfirmCard.tsx,src/components/confirm.css",
      "--note",
      "asks yes or no over the pane",
      "--tags",
      "dialog",
    ]);
    expect(made.ok).toBe(true);
    expect(made.text).toContain("registered confirm-card");
    expect(made.text).toContain("no picture");
    const again = await runLibrary(host, [
      "register",
      "confirm-card",
      "--name",
      "another",
      "--files",
      "src/components/ConfirmCard.tsx",
    ]);
    expect(again.ok).toBe(false);

    expect((await runLibrary(host, ["list"])).text).toContain(
      "confirm-card — the confirm card: asks yes or no over the pane [no picture]",
    );
    expect((await runLibrary(host, ["search", "dialog"])).text).toContain("confirm-card");
    expect((await runLibrary(host, ["search", "spaceship"])).text).toContain(
      "nothing in this project's library",
    );

    const shown = await runLibrary(host, ["show", "confirm-card"]);
    expect(shown.text).toContain("export function ConfirmCard()");
    expect(shown.text).toContain(".confirm { color: red }");
    expect(shown.text).toContain("Install: ruri add confirm-card");

    expect((await runLibrary(host, ["edit", "confirm-card", "--name", "the yes-no card"])).ok).toBe(true);
    expect(store.find(here.id, "confirm-card")?.name).toBe("the yes-no card");
    expect((await runLibrary(host, ["show", "the yes-no card", "--no-code"])).text).not.toContain(
      "export function",
    );

    expect((await runLibrary(host, ["remove", "confirm-card"])).ok).toBe(true);
    expect(store.items(here.id)).toEqual([]);
    expect(fs.existsSync(path.join(here.path, "src/components/ConfirmCard.tsx"))).toBe(true);
  });

  test("a name is a person's words: required, and never code", async () => {
    const here = project("app", { "src/NavBar.tsx": "x\n" });
    const host = hostFor(here, new ComponentStore());
    const bare = await runLibrary(host, ["register", "navbar", "--files", "src/NavBar.tsx"]);
    expect(bare.ok).toBe(false);
    expect(bare.text).toContain('--name "<what a person calls it>"');
    for (const name of ["NavBar", "nav-bar", "navBar", "NavBar.tsx", "nav_bar"]) {
      const out = await runLibrary(host, ["register", "navbar", "--name", name, "--files", "src/NavBar.tsx"]);
      expect(out.ok).toBe(false);
      expect(out.text).toContain("a name for code");
    }
    expect(
      (await runLibrary(host, ["register", "navbar", "--name", "the top nav", "--files", "src/NavBar.tsx"]))
        .ok,
    ).toBe(true);
    expect((await runLibrary(host, ["edit", "navbar", "--name", "TopNav"])).ok).toBe(false);
  });

  test("the same code, the same name, a shared stylesheet and files that aren't there", async () => {
    const here = project("app", {
      "src/Dialog.tsx": "d\n",
      "src/Dialog.css": ".d{}\n",
      "src/styles.css": "body{}\n",
      "src/Big.tsx": "big\n",
    });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    await runLibrary(host, [
      "register",
      "dialog",
      "--name",
      "the dialog",
      "--files",
      "src/Dialog.tsx,src/Dialog.css",
    ]);

    const twin = await runLibrary(host, [
      "register",
      "modal",
      "--name",
      "the modal",
      "--files",
      "src/Dialog.tsx",
    ]);
    expect(twin.ok).toBe(false);
    expect(twin.text).toContain("already dialog's");
    expect(twin.text).toContain('--alias "the modal"');

    const named = await runLibrary(host, [
      "register",
      "big",
      "--name",
      "The Dialog",
      "--files",
      "src/Big.tsx",
    ]);
    expect(named.ok).toBe(false);
    expect(named.text).toContain("already dialog's name");

    const styled = await runLibrary(host, [
      "register",
      "big",
      "--name",
      "the big panel",
      "--files",
      "src/Big.tsx,src/styles.css",
    ]);
    expect(styled.ok).toBe(true);
    expect(store.find(here.id, "big")?.files).toEqual(["src/Big.tsx"]);
    expect(store.find(here.id, "big")?.uses).toEqual(["src/styles.css"]);

    const ghost = await runLibrary(host, [
      "register",
      "ghost",
      "--name",
      "the ghost",
      "--files",
      "src/Ghost.tsx",
    ]);
    expect(ghost.ok).toBe(false);
    expect(ghost.text).toContain("not found: src/Ghost.tsx");

    // a part that lives inside another's file is registered by where it sits
    const part = await runLibrary(host, [
      "register",
      "dialog-title",
      "--name",
      "the dialog title",
      "--uses",
      "src/Dialog.tsx:1",
    ]);
    expect(part.ok).toBe(true);
    expect(store.find(here.id, "dialog-title")?.files).toEqual([]);
  });

  test("edit: a picture that can't be read changes nothing; --alias adds a name", async () => {
    const here = project("app", { "src/Card.tsx": "c\n", "shot.png": "png" });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    await runLibrary(host, ["register", "card", "--name", "the card", "--files", "src/Card.tsx"]);
    const bad = await runLibrary(host, ["edit", "card", "--note", "changed", "--shot", "nope.png"]);
    expect(bad.ok).toBe(false);
    expect(store.find(here.id, "card")?.note).toBe("");
    const good = await runLibrary(
      host,
      ["edit", "card", "--shot", "shot.png", "--alias", "the tile"],
      here.path,
    );
    expect(good.ok).toBe(true);
    expect(store.find(here.id, "card")?.shots).toHaveLength(1);
    await runLibrary(host, ["edit", "card", "--alias", "the box"]);
    expect(store.find(here.id, "card")?.aliases).toEqual(["the tile", "the box"]);
    expect(store.find(here.id, "the box")?.slug).toBe("card");
  });

  test("a path typed from a subfolder means that file, and so does one from the root", async () => {
    const here = project("app", { "web/src/Card.tsx": "x\n", "web/src/Tile.tsx": "y\n" });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    const sub = path.join(here.path, "web");
    expect(
      (await runLibrary(host, ["register", "card", "--name", "the card", "--files", "src/Card.tsx"], sub)).ok,
    ).toBe(true);
    expect(store.find(here.id, "card")?.files).toEqual(["web/src/Card.tsx"]);
    expect(
      (await runLibrary(host, ["register", "tile", "--name", "the tile", "--files", "web/src/Tile.tsx"], sub))
        .ok,
    ).toBe(true);
    expect(store.find(here.id, "tile")?.files).toEqual(["web/src/Tile.tsx"]);
  });

  test("from a worktree: its files are read there, and copies land there", async () => {
    const { main, tree } = repoWithWorktree({
      "src/components/Dial.tsx": "dial\n",
      "src/components/Knob.tsx": "knob\n",
    });
    fs.writeFileSync(path.join(tree, "src/components/Toast.tsx"), "toast\n");
    const store = new ComponentStore();
    const host = hostFor(main, store);
    const made = await runLibrary(
      host,
      ["register", "toast", "--name", "the toast", "--files", "src/components/Toast.tsx"],
      path.join(tree, "src"),
    );
    expect(made.ok).toBe(true);
    const toast = store.find(main.id, "toast")!;
    expect(toast.files).toEqual(["src/components/Toast.tsx"]);
    expect(fs.realpathSync(toast.filedIn!)).toBe(fs.realpathSync(tree));
    expect(toast.noteSig).toBeTruthy();
    expect((await runLibrary(host, ["show", "toast"], tree)).text).toContain("toast\n");

    await runLibrary(
      host,
      ["register", "dial", "--name", "the dial", "--files", "src/components/Dial.tsx"],
      main.path,
    );
    const copied = await runLibrary(host, ["add", "dial", "--dir", "src/ui"], tree);
    expect(copied.ok).toBe(true);
    expect(copied.text).toContain("into the checkout you are in");
    expect(fs.existsSync(path.join(tree, "src/ui/Dial.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(main.path, "src/ui/Dial.tsx"))).toBe(false);
  });

  test("add wants a folder once, remembers it, and never clobbers without --overwrite", async () => {
    const here = project("app", {
      "web/ui/Dial.tsx": "dial v1\n",
      "web/ui/dial.css": ".dial{}\n",
    });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    await runLibrary(host, [
      "register",
      "dial",
      "--name",
      "the dial",
      "--files",
      "web/ui/Dial.tsx,web/ui/dial.css",
    ]);

    const unset = await runLibrary(host, ["add", "dial"]);
    expect(unset.ok).toBe(false);
    expect(unset.text).toContain("--dir");

    const first = await runLibrary(host, ["add", "dial", "--dir", "desktop/src/ui"]);
    expect(first.ok).toBe(true);
    expect(first.text).not.toContain("imports");
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "utf8")).toBe("dial v1\n");
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/dial.css"), "utf8")).toBe(".dial{}\n");
    expect(store.dir(here.id)).toBe("desktop/src/ui");
    expect(store.find(here.id, "dial")?.installs).toEqual([
      "desktop/src/ui/Dial.tsx",
      "desktop/src/ui/dial.css",
    ]);

    // the copy was changed there; the next add leaves it alone
    fs.writeFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "dial, edited\n");
    const again = await runLibrary(host, ["add", "dial"]);
    expect(again.text).toContain("already there and different");
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "utf8")).toBe("dial, edited\n");
    await runLibrary(host, ["add", "dial", "--overwrite"]);
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "utf8")).toBe("dial v1\n");

    expect((await runLibrary(host, ["add", "dial", "--dir", "../outside"])).ok).toBe(false);
  });

  test("with no folder set, add goes where the project's components live", async () => {
    const here = project("app", { "src/components/A.tsx": "a", "src/components/B.tsx": "b" });
    const there = project("gallery", { "ui/Crt.tsx": "crt\n" });
    const store = new ComponentStore();
    store.add(there.id, { name: "the crt", files: ["ui/Crt.tsx"] });
    const host = hostFor(here, store, [there]);
    const out = await runLibrary(host, ["add", "gallery/crt"]);
    expect(out.ok).toBe(true);
    expect(out.text).toContain("into src/components — where this project's components live");
    expect(fs.readFileSync(path.join(here.path, "src/components/Crt.tsx"), "utf8")).toBe("crt\n");
    // a guess is not remembered: saying where is
    expect(store.dir(here.id)).toBeUndefined();
  });

  test("add from another project copies it over, joins this library, and says what it needs", async () => {
    const there = project("gallery", {
      "src/components/gallery/CrtMonitor.tsx":
        'import { Canvas } from "@react-three/fiber";\nimport { glow } from "./crt-gl";\nimport { theme } from "../../theme";\nimport * as fs from "node:fs";\n',
      "src/components/gallery/crt-gl.ts": 'import * as THREE from "three";\n',
      "src/theme.ts": "export const theme = {};\n",
      "src/styles.css": ".crt{}\n",
    });
    const here = project("site", {
      "package.json": JSON.stringify({ dependencies: { three: "1" } }),
      "bun.lock": "",
      "app/ui/Other.tsx": "other",
    });
    const store = new ComponentStore();
    store.add(there.id, {
      name: "the crt monitor",
      files: ["src/components/gallery/CrtMonitor.tsx", "src/components/gallery/crt-gl.ts"],
      uses: ["src/styles.css:1"],
      note: "a CRT that renders its children",
    });
    // this project already has something else under that handle
    store.add(here.id, { name: "the crt monitor", slug: "crt-monitor", files: ["app/ui/Other.tsx"] });
    const host = hostFor(here, store, [there]);
    store.setDir(here.id, "app/ui");
    const out = await runLibrary(host, ["add", "gallery/crt-monitor"]);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(here.path, "app/ui/crt-gl.ts"), "utf8")).toContain("three");
    expect(out.text).toContain("bun add @react-three/fiber");
    expect(out.text).not.toContain("bun add @react-three/fiber three");
    expect(out.text).toContain("app/ui/CrtMonitor.tsx imports ../../theme — not there");
    expect(out.text).not.toContain("./crt-gl —");
    expect(out.text).toContain("not copied — it also reaches into src/styles.css:1");
    // the one already here is left alone; this one is a new entry
    expect(store.find(here.id, "crt-monitor")?.files).toEqual(["app/ui/Other.tsx"]);
    const joined = store.items(here.id).find((i) => i.files.includes("app/ui/CrtMonitor.tsx"));
    expect(joined?.slug).toBe("crt-monitor-2");
    expect(joined?.name).toBe("the crt monitor (from gallery)");
    expect(joined?.note).toBe("a CRT that renders its children");

    expect((await runLibrary(host, ["add", "nowhere/crt-monitor"])).text).toContain("no open project");
  });

  test("an unknown handle suggests what is close, typos included", async () => {
    const here = project("app", { "src/PeekBand.tsx": "x", "src/ConfirmDialog.tsx": "y" });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    await runLibrary(host, [
      "register",
      "peek-band",
      "--name",
      "the peek band",
      "--files",
      "src/PeekBand.tsx",
    ]);
    await runLibrary(host, [
      "register",
      "confirm-dialog",
      "--name",
      "the confirm dialog",
      "--files",
      "src/ConfirmDialog.tsx",
    ]);
    expect((await runLibrary(host, ["show", "peek"])).text).toContain("did you mean: peek-band");
    expect((await runLibrary(host, ["show", "confirm-dialg"])).text).toContain(
      "did you mean: confirm-dialog",
    );
    expect((await runLibrary(host, ["edit", "peek-bnd", "--note", "x"])).text).toContain(
      "did you mean: peek-band",
    );
  });

  test("search reaches the other open projects: --all, list <project>, and when nothing here matches", async () => {
    const here = project("app", { "src/Card.tsx": "x" });
    const there = project("gallery", { "ui/Toast.tsx": "t" });
    const store = new ComponentStore();
    store.add(here.id, { name: "the card", files: ["src/Card.tsx"] });
    store.add(there.id, { name: "the toast", files: ["ui/Toast.tsx"], note: "slides in at the bottom" });
    const host = hostFor(here, store, [there]);
    const none = await runLibrary(host, ["search", "notification"]);
    expect(none.text).toContain("nothing in this project's library");
    expect(none.text).toContain("gallery/toast — the toast");
    const all = await runLibrary(host, ["search", "card", "toast", "--all"]);
    expect(all.text).toContain("card — the card");
    expect(all.text).toContain("gallery/toast");
    expect((await runLibrary(host, ["list", "gallery"])).text).toContain("gallery/toast — the toast");
    expect((await runLibrary(host, ["show", "gallery/toast", "--no-code"])).text).toContain(
      "Install: ruri add gallery/toast",
    );
  });
});

describe("reading and copying", () => {
  test("a long file named at a line is read around that line", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n");
    const here = project("app", { "web/src/styles.css": lines });
    const file = readFile(here.path, "web/src/styles.css:900", false);
    expect(file.from).toBe(870);
    expect(file.lines).toBe(2000);
    expect(file.text?.split("\n")[0]).toBe("line 870");
    expect(readFile(here.path, "../etc/passwd", true).missing).toBe(true);
    expect(readFile(here.path, "nope.tsx", true).missing).toBe(true);
  });

  test("files that share a folder land flat; ones that don't keep their layout under it", () => {
    const src = project("a", { "web/src/components/A.tsx": "a", "web/src/lib/a.ts": "b" });
    const dest = project("b", {});
    expect(
      planCopy(src.path, ["web/src/components/A.tsx", "web/src/lib/a.ts"], dest.path, "ui").map((p) => p.to),
    ).toEqual(["ui/components/A.tsx", "ui/lib/a.ts"]);
    expect(planCopy(src.path, ["web/src/components/A.tsx"], dest.path, "ui").map((p) => p.to)).toEqual([
      "ui/A.tsx",
    ]);
  });

  test("search ranks a hit in the handle over one in a file path", () => {
    const store = new ComponentStore();
    store.add("p", { name: "the dialog", files: ["src/Dialog.tsx"] });
    store.add("p", { name: "the menu", files: ["src/dialog/Menu.tsx"] });
    expect(search(store.items("p"), "dialog").map((i) => i.slug)).toEqual(["dialog"]);
    store.add("p", { name: "the menu bar", files: ["src/MenuBar.tsx"], note: "has a dialog in it" });
    expect(search(store.items("p"), "dialog").map((i) => i.slug)).toEqual(["dialog", "menu-bar"]);
  });

  test("search finds a component by the top of its code", () => {
    const here = project("app", {
      "src/Thing.tsx": "/** A toast that slides in from the bottom. */\nexport function Thing() {}",
    });
    const store = new ComponentStore();
    store.add(here.id, { name: "the thing", files: ["src/Thing.tsx"] });
    expect(search(store.items(here.id), "slides").map((i) => i.slug)).toEqual([]);
    expect(search(store.items(here.id), "slides", [here.path]).map((i) => i.slug)).toEqual(["thing"]);
  });
});

describe("the skill", () => {
  test("its description never changes; its body is the list", () => {
    const store = new ComponentStore();
    store.add("p", {
      name: "the peek band",
      files: ["web/src/PeekBand.tsx"],
      note: "pictures across the top",
    });
    writeLibrarySkill("p", "ruri", store.items("p"), "web/src/components");
    const skill = fs.readFileSync(path.join(skillDir("p"), "skills", "components", "SKILL.md"), "utf8");
    expect(skill).toContain(`description: ${SKILL_DESCRIPTION}\n`);
    expect(skill).toContain("## peek-band — the peek band");
    expect(skill).toContain("installs into web/src/components");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(skillDir("p"), ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("ruri");
    // nothing about the list is in the description
    expect(SKILL_DESCRIPTION).not.toContain("peek");
  });
});

describe("the shell command", () => {
  test("posts every argument intact, with where it was run, and prints the answer", async () => {
    installCli();
    let seen: URLSearchParams | undefined;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen = new URLSearchParams(body);
        const failed = seen.getAll("a")[0] === "fail";
        res.writeHead(failed ? 400 : 200, { "content-type": "text/plain" });
        res.end(failed ? "no such thing" : "fine");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env = { ...process.env, ...cliEnv(`http://127.0.0.1:${port}/library/chat-1`) };
    // run it without blocking: the server answering it is in this process
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string }>((resolve) => {
        execFile("ruri", args, { env, cwd: os.tmpdir() }, (err, stdout) =>
          resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout }),
        );
      });
    try {
      const out = await run(["register", "a b", "--note", `it's "quoted" & = 100%`, "--files=x.tsx,y.css"]);
      expect(out).toEqual({ code: 0, stdout: "fine\n" });
      expect(seen?.getAll("a")).toEqual([
        "register",
        "a b",
        "--note",
        `it's "quoted" & = 100%`,
        "--files=x.tsx,y.css",
      ]);
      expect(fs.realpathSync(seen!.get("cwd")!)).toBe(fs.realpathSync(os.tmpdir()));

      const failed = await run(["fail"]);
      expect(failed.code).not.toBe(0);
      expect(failed.stdout).toBe("no such thing\n");
    } finally {
      server.close();
    }
    const outside = { ...process.env, PATH: cliEnv("x").PATH, RURI_LIBRARY: "" };
    let refused: { status?: number } = {};
    try {
      execFileSync("ruri", ["list"], { env: outside, stdio: "pipe" });
    } catch (err) {
      refused = err as typeof refused;
    }
    expect(refused.status).toBe(2);
  });
});
