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
      store.add(here.id, { ...proposal, exact: true });
      return "added";
    },
    items: (id) => store.items(id),
    find: (id, handle) => store.find(id, handle),
    add: (id, input) => store.add(id, input),
    update: (id, componentId, patch) => store.update(id, componentId, patch),
    remove: (id, componentId) => store.remove(id, componentId),
    shoot: () => false,
    copyShots: (id, componentId, shots) => {
      for (const shot of shots) store.addShot(id, componentId, shot);
    },
    dir: (id) => store.dir(id),
    setDir: (id, dir) => store.setDir(id, dir),
    noteInstall: (id, componentId, paths) => store.noteInstall(id, componentId, paths),
    changed: () => {},
  };
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
    expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(3);
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

  test("register, list, search, show, edit and remove", () => {
    const here = project("app", {
      "src/components/ConfirmCard.tsx": "export function ConfirmCard() {}\n",
      "src/components/confirm.css": ".confirm { color: red }\n",
      "server/db.ts": "export const db = 1;\n",
    });
    const store = new ComponentStore();
    const host = hostFor(here, store);

    const refused = runLibrary(host, ["register", "db", "--files", "server/db.ts"]);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("interface");

    const made = runLibrary(host, [
      "register",
      "confirm-card",
      "--files",
      "src/components/ConfirmCard.tsx,src/components/confirm.css",
      "--note",
      "asks yes or no over the pane",
      "--tags",
      "dialog",
    ]);
    expect(made.ok).toBe(true);
    expect(made.text).toContain("registered confirm-card");
    expect(
      runLibrary(host, ["register", "confirm-card", "--files", "src/components/ConfirmCard.tsx"]).ok,
    ).toBe(false);

    expect(runLibrary(host, ["list"]).text).toContain("confirm-card — confirm card: asks yes or no");
    expect(runLibrary(host, ["search", "dialog"]).text).toContain("confirm-card");
    expect(runLibrary(host, ["search", "spaceship"]).text).toContain("nothing in the library matches");

    const shown = runLibrary(host, ["show", "confirm-card"]);
    expect(shown.text).toContain("export function ConfirmCard()");
    expect(shown.text).toContain(".confirm { color: red }");
    expect(shown.text).toContain("Install: ruri add confirm-card");

    expect(runLibrary(host, ["edit", "confirm-card", "--name", "the yes-no card"]).ok).toBe(true);
    expect(store.find(here.id, "confirm-card")?.name).toBe("the yes-no card");
    expect(runLibrary(host, ["show", "the yes-no card", "--no-code"]).text).not.toContain("export function");

    expect(runLibrary(host, ["remove", "confirm-card"]).ok).toBe(true);
    expect(store.items(here.id)).toEqual([]);
    expect(fs.existsSync(path.join(here.path, "src/components/ConfirmCard.tsx"))).toBe(true);
  });

  test("a path typed from a subfolder means that file", () => {
    const here = project("app", { "web/src/Card.tsx": "x\n" });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    expect(
      runLibrary(host, ["register", "card", "--files", "src/Card.tsx"], path.join(here.path, "web")).ok,
    ).toBe(true);
    expect(store.find(here.id, "card")?.files).toEqual(["web/src/Card.tsx"]);
  });

  test("add wants a folder once, remembers it, and never clobbers without --overwrite", () => {
    const here = project("app", {
      "web/ui/Dial.tsx": "dial v1\n",
      "web/ui/dial.css": ".dial{}\n",
    });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    runLibrary(host, ["register", "dial", "--files", "web/ui/Dial.tsx,web/ui/dial.css"]);

    const unset = runLibrary(host, ["add", "dial"]);
    expect(unset.ok).toBe(false);
    expect(unset.text).toContain("--dir");

    const first = runLibrary(host, ["add", "dial", "--dir", "desktop/src/ui"]);
    expect(first.ok).toBe(true);
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "utf8")).toBe("dial v1\n");
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/dial.css"), "utf8")).toBe(".dial{}\n");
    expect(store.dir(here.id)).toBe("desktop/src/ui");
    expect(store.find(here.id, "dial")?.installs).toEqual([
      "desktop/src/ui/Dial.tsx",
      "desktop/src/ui/dial.css",
    ]);

    // the copy was changed there; the next add leaves it alone
    fs.writeFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "dial, edited\n");
    const again = runLibrary(host, ["add", "dial"]);
    expect(again.text).toContain("already there and different");
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "utf8")).toBe("dial, edited\n");
    runLibrary(host, ["add", "dial", "--overwrite"]);
    expect(fs.readFileSync(path.join(here.path, "desktop/src/ui/Dial.tsx"), "utf8")).toBe("dial v1\n");

    expect(runLibrary(host, ["add", "dial", "--dir", "../outside"]).ok).toBe(false);
  });

  test("add from another project copies it over and joins this project's library", () => {
    const there = project("gallery", {
      "src/components/gallery/CrtMonitor.tsx": "crt\n",
      "src/components/gallery/crt-gl.ts": "gl\n",
    });
    const here = project("site", { "package.json": "{}", "bun.lock": "" });
    const store = new ComponentStore();
    hostFor(there, store);
    store.add(there.id, {
      name: "the crt monitor",
      files: ["src/components/gallery/CrtMonitor.tsx", "src/components/gallery/crt-gl.ts"],
      deps: ["three"],
      note: "a CRT that renders its children",
    });
    const host = hostFor(here, store, [there]);
    store.setDir(here.id, "app/ui");
    const out = runLibrary(host, ["add", "gallery/crt-monitor"]);
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(here.path, "app/ui/CrtMonitor.tsx"), "utf8")).toBe("crt\n");
    expect(fs.readFileSync(path.join(here.path, "app/ui/crt-gl.ts"), "utf8")).toBe("gl\n");
    expect(out.text).toContain("bun add three");
    const joined = store.find(here.id, "crt-monitor");
    expect(joined?.files).toEqual(["app/ui/CrtMonitor.tsx", "app/ui/crt-gl.ts"]);
    expect(joined?.note).toBe("a CRT that renders its children");

    expect(runLibrary(host, ["add", "nowhere/crt-monitor"]).text).toContain("no open project");
  });

  test("an unknown handle suggests what is close", () => {
    const here = project("app", { "src/PeekBand.tsx": "x" });
    const store = new ComponentStore();
    const host = hostFor(here, store);
    runLibrary(host, ["register", "peek-band", "--files", "src/PeekBand.tsx"]);
    expect(runLibrary(host, ["show", "peek"]).text).toContain("did you mean: peek-band");
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
    expect(search(store.items("p"), "dialog").map((i) => i.slug)).toEqual(["dialog", "menu"]);
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
