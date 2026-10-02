import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BriefStore } from "./brief.js";
import { adoptShared, dueRead, touchProject } from "./catchupBrief.js";
import type { ServerContext } from "./context.js";
import { setCompletionClient, updateShape } from "./smallmodel.js";

let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-lazy-"));
});
afterAll(() => {
  setCompletionClient(null);
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

/** A project folder holding these files. */
function folder(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-lazy-project-"));
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "// what it is for\nexport const x = 1;\n");
  }
  return dir;
}

/** A small model that answers each kind of call, and remembers what it was asked. */
function model(): { asked: string[] } {
  const asked: string[] = [];
  setCompletionClient(async ({ system }) => {
    const said = String(system);
    asked.push(said);
    const reply = said.includes("from a read of its repository")
      ? {
          description: "A demo app.",
          features: ["Does a thing"],
          layers: [
            { name: "UI", slug: "ui", what: "React", paths: ["web/"] },
            { name: "Server", slug: "server", what: "Node", paths: ["server/"] },
          ],
          flows: [],
          run: ["make dev"],
          layout: [],
          conventions: [],
        }
      : { summary: "A layer.", map: [], flows: [], files: [], rules: [], edges: [] };
    return JSON.stringify(reply);
  });
  return { asked };
}

function context(dir: string): ServerContext {
  const project = { id: "p", name: "demo", path: dir, sessions: [] };
  return {
    store: { get: (id: string) => (id === "p" ? project : undefined), findSession: () => undefined },
    briefs: new BriefStore(),
    clients: { broadcast: () => {} },
    catchingUp: new Set<string>(),
    archive: { events: () => [], summaries: () => ({}), turnIds: () => [] },
  } as unknown as ServerContext;
}

async function settled(ctx: ServerContext): Promise<void> {
  for (let i = 0; i < 200 && ctx.catchingUp.size > 0; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
}

describe("a project's repo is read when someone works in it", () => {
  test("opened is not worked in: taking in what a clone brought reads nothing", () => {
    const { asked } = model();
    const ctx = context(folder(["web/App.tsx", "server/main.ts"]));
    expect(adoptShared(ctx, "p")).toBe(false);
    expect(asked).toHaveLength(0);
    expect(ctx.briefs.get("p").description).toBe("");
  });

  test("worked in, it has its index read — and no layer's sheet until work reaches that layer", async () => {
    const { asked } = model();
    const ctx = context(folder(["web/App.tsx", "server/main.ts", "README.md"]));
    touchProject(ctx, "p");
    await settled(ctx);
    expect(asked.filter((system) => system.includes("from a read of its repository"))).toHaveLength(1);
    expect(asked.filter((system) => system.includes("ONE layer"))).toHaveLength(0);
    const brief = ctx.briefs.get("p");
    expect(brief.description).toBe("A demo app.");
    expect(brief.layers?.map((l) => l.slug)).toEqual(["ui", "server"]);
    expect(brief.layerSheets).toBeUndefined();
    expect(brief.readFiles).toBe(2);
    // worked in again, it has a sheet: nothing more is read
    touchProject(ctx, "p");
    await settled(ctx);
    expect(asked).toHaveLength(1);
  });

  test("a blank project has nothing to read", async () => {
    const { asked } = model();
    const ctx = context(folder(["LICENSE"]));
    touchProject(ctx, "p");
    await settled(ctx);
    expect(asked).toHaveLength(0);
  });

  test("a clone opens with the shape it brought, read by nobody", async () => {
    const { asked } = model();
    const dir = folder(["web/App.tsx"]);
    fs.mkdirSync(path.join(dir, ".ruri"));
    fs.writeFileSync(
      path.join(dir, ".ruri", "architecture.json"),
      JSON.stringify({
        description: "Shared by a teammate.",
        features: ["One"],
        layers: [{ name: "UI", slug: "ui", what: "React", paths: ["web/"] }],
        layerSheets: { ui: { summary: "The UI.", map: [], flows: [], files: [], rules: [], edges: [] } },
      }),
    );
    const ctx = context(dir);
    touchProject(ctx, "p");
    await settled(ctx);
    expect(asked).toHaveLength(0);
    expect(ctx.briefs.get("p").description).toBe("Shared by a teammate.");
    expect(ctx.briefs.get("p").layerSheets?.["ui"]?.summary).toBe("The UI.");
  });
});

describe("a young project, drawn by its folds", () => {
  const young = (readFiles?: number) => ({
    description: "Something new.",
    features: [],
    layers: [{ name: "UI", what: "React", where: "web" }],
    ...(readFiles !== undefined ? { readFiles } : {}),
  });

  test("is read once it has grown enough to cut a stack from", async () => {
    model();
    const few = context(folder(["web/a.ts", "web/b.ts", "web/c.ts"]));
    few.briefs.write("p", young());
    expect(await dueRead(few, "p")).toBe(false);
    const grown = context(folder(Array.from({ length: 14 }, (_, i) => `web/f${i}.ts`)));
    grown.briefs.write("p", young());
    expect(await dueRead(grown, "p")).toBe(true);
  });

  test("a read that found too little is not repeated until the project has really grown", async () => {
    model();
    const ctx = context(folder(Array.from({ length: 14 }, (_, i) => `web/f${i}.ts`)));
    ctx.briefs.write("p", young(10));
    expect(await dueRead(ctx, "p")).toBe(false);
    ctx.briefs.write("p", young(7));
    expect(await dueRead(ctx, "p")).toBe(true);
  });

  test("an empty one with a description is never read again", async () => {
    model();
    const ctx = context(folder([]));
    ctx.briefs.write("p", { description: "The supplied repository is empty.", features: [] });
    expect(await dueRead(ctx, "p")).toBe(false);
  });
});

describe("a stack grows where the work broke new ground", () => {
  const current = {
    description: "d",
    features: [],
    layers: [
      { name: "UI", slug: "ui", what: "React", paths: ["web/"] },
      { name: "Server", slug: "server", what: "Node", paths: ["server/main.ts"] },
      { name: "Runtime", slug: "runtime", what: "Bun" },
    ],
    flows: [],
    layout: [],
    map: [],
  };

  function answering(reply: Record<string, unknown>): void {
    setCompletionClient(async () => JSON.stringify(reply));
  }

  test("a new file goes to the layer the model names; a new part becomes a layer above the runtime", async () => {
    const dir = folder(["web/a.tsx", "server/main.ts", "server/queue.ts", "worker/run.ts", "worker/jobs.ts"]);
    answering({
      description: "d",
      features: [],
      flows: [],
      layout: [],
      place: { "server/queue.ts": "server", "web/a.tsx": "server" },
      newLayers: [
        // it may claim only unowned ground: the worker folder, not the UI's
        { name: "Worker", what: "background jobs", paths: ["worker/", "web/"] },
        { name: "Nothing", what: "owns nothing it may", paths: ["web/a.tsx"] },
      ],
    });
    const next = (await updateShape("demo", current, "added a worker", dir, true, [
      "server/queue.ts",
      "worker/run.ts",
      "worker/jobs.ts",
    ]))!;
    expect(next.layers.map((l) => l.name)).toEqual(["UI", "Server", "Worker", "Runtime"]);
    expect(next.layers[1]!.paths).toEqual(["server/main.ts", "server/queue.ts"]);
    expect(next.layers[2]!.paths).toEqual(["worker/"]);
    // a file some layer already owns is not handed to another
    expect(next.layers[0]!.paths).toEqual(["web/"]);
  });

  test("with nothing unowned, the stack is left exactly as it was", async () => {
    answering({
      description: "d",
      features: [],
      newLayers: [{ name: "Invented", what: "x", paths: ["web/"] }],
    });
    const next = (await updateShape("demo", current, "a fix", folder(["web/a.tsx"]), true, []))!;
    expect(next.layers).toEqual(current.layers);
  });
});
