import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerContext } from "../context.js";
import { ProjectStore } from "../projects.js";
import { createManagerHost } from "./projects.js";

let root: string;
/** The workspace as the disk has it, and a symlink onto it — the way
 *  ~/Workspace points at an external drive. */
let real: string;
let linked: string;
let saved: string | undefined;
let store: ProjectStore;
let host: ReturnType<typeof createManagerHost>;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ruri-open-")));
  real = path.join(root, "drive", "Workspace");
  linked = path.join(root, "Workspace");
  for (const dir of ["ruri", "umi", "backups/ruri", "toji.bak", "toji"]) {
    fs.mkdirSync(path.join(real, dir), { recursive: true });
  }
  fs.symlinkSync(real, linked);
  saved = process.env["RURI_CONFIG_DIR"];
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(root, "config-"));
  store = new ProjectStore();
  store.setWorkspaceDir(real);
  // a brief already there, so opening reads no repo
  const ctx = {
    store,
    clients: { broadcast: () => {} },
    briefs: { get: () => ({ description: "known", features: [], shots: [] }) },
  } as unknown as ServerContext;
  host = createManagerHost(ctx);
});

const names = () => store.list().map((p) => p.name);

describe("Home opens a project once", () => {
  test("the same folder by its symlinked path is already open", () => {
    expect(host.openProject({ path: path.join(real, "ruri") })).toStartWith("opened: ruri");
    expect(host.openProject({ path: path.join(linked, "ruri") })).toStartWith("already open: ruri");
    expect(names()).toEqual(["ruri"]);
  });

  test("or in another letter case, or with a trailing slash", () => {
    host.openProject({ path: path.join(real, "ruri") });
    const upper = path.join(real, "RURI");
    // only a case-insensitive disk has a RURI to find
    if (fs.existsSync(upper)) expect(host.openProject({ path: upper })).toStartWith("already open");
    expect(host.openProject({ path: `${path.join(real, "ruri")}/` })).toStartWith("already open");
    expect(names()).toEqual(["ruri"]);
  });

  test("another folder of the same name is the one already open", () => {
    host.openProject({ path: path.join(real, "ruri") });
    const again = host.openProject({ path: path.join(real, "backups", "ruri") });
    expect(again).toStartWith(`already open: ruri (${path.join(real, "ruri")})`);
    expect(again).toContain("was not opened as another");
    expect(names()).toEqual(["ruri"]);
  });

  test("so is one given an open project's display name", () => {
    host.openProject({ path: path.join(real, "toji.bak"), name: "toji" });
    expect(host.openProject({ path: path.join(real, "toji") })).toStartWith("already open: toji");
    expect(host.openProject({ path: path.join(real, "umi"), name: "Toji" })).toStartWith("already open: toji");
    expect(names()).toEqual(["toji"]);
  });

  test("a relative path is the workspace root's", () => {
    expect(host.openProject({ path: "./umi" })).toBe(`opened: umi (${path.join(real, "umi")})`);
    expect(host.openProject({ path: "umi" })).toStartWith("already open: umi");
  });

  test("new_project makes nothing when a project of that name is open", () => {
    host.openProject({ path: path.join(real, "backups", "ruri") });
    expect(host.newProject("RURI")).toStartWith("already open: ruri");
    expect(names()).toEqual(["ruri"]);
    expect(host.newProject("hitbox")).toStartWith("created and opened: hitbox");
    expect(fs.existsSync(path.join(real, "hitbox"))).toBe(true);
  });

  test("different names still open side by side", () => {
    host.openProject({ path: path.join(real, "ruri") });
    expect(host.openProject({ path: path.join(linked, "umi") })).toStartWith("opened: umi");
    expect(names()).toEqual(["ruri", "umi"]);
  });
});
