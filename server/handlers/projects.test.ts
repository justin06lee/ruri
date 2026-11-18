import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerContext } from "../context.js";
import { addAccount } from "../accounts.js";
import { ProjectStore } from "../projects.js";
import { accountHandlers } from "./accounts.js";
import { createManagerHost, projectHandlers } from "./projects.js";
import { settingHandlers } from "./settings.js";

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
    expect(host.openProject({ path: path.join(real, "umi"), name: "Toji" })).toStartWith(
      "already open: toji",
    );
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

describe("midna watching a chat", () => {
  test("set_chat_watch marks the chat, every window hears it, and it outlives a restart", () => {
    host.openProject({ path: path.join(real, "ruri") });
    const chatId = store.list()[0]!.sessions[0]!.id;
    const broadcasts: unknown[] = [];
    const ctx = {
      store,
      clients: { broadcast: (m: unknown) => broadcasts.push(m) },
    } as unknown as ServerContext;
    const watch = (id: string, on: boolean) =>
      projectHandlers.set_chat_watch(ctx, {} as never, { type: "set_chat_watch", chatId: id, watch: on });
    watch(chatId, true);
    expect(store.findSession(chatId)?.session.watched).toBe(true);
    expect(broadcasts).toHaveLength(1);
    expect(new ProjectStore().findSession(chatId)?.session.watched).toBe(true);
    watch(chatId, false);
    expect(store.findSession(chatId)?.session).not.toHaveProperty("watched");
    expect(new ProjectStore().findSession(chatId)?.session).not.toHaveProperty("watched");
    // a chat that isn't there is no one's
    watch("nope", true);
    expect(broadcasts).toHaveLength(2);
  });
});

describe("a project's accounts", () => {
  test("set_account puts the project on it — by its id or a chat's — and it outlives a restart", () => {
    host.openProject({ path: path.join(real, "ruri") });
    const project = store.list()[0]!;
    const chatId = project.sessions[0]!.id;
    const broadcasts: unknown[] = [];
    const told: string[] = [];
    const ctx = {
      store,
      clients: { broadcast: (m: unknown) => broadcasts.push(m) },
    } as unknown as ServerContext;
    const ws = { send: (m: string) => told.push(m) } as never;
    const set = (id: string, account: string) =>
      accountHandlers.set_account(ctx, ws, { type: "set_account", projectId: id, account });
    // unset is work, so asking for work changes nothing
    set(project.id, "work");
    expect(broadcasts).toHaveLength(0);
    set(chatId, "personal");
    expect(store.get(project.id)?.accounts).toEqual({ claude: "personal" });
    expect(new ProjectStore().get(project.id)?.accounts).toEqual({ claude: "personal" });
    expect(broadcasts).toEqual([{ type: "projects", projects: store.list() }]);
    // back to work is back to unset
    set(project.id, "work");
    expect(store.get(project.id)).not.toHaveProperty("accounts");
    expect(new ProjectStore().get(project.id)).not.toHaveProperty("accounts");
    // an account that isn't one is said so, and changes nothing
    set("nope", "personal");
    set(project.id, "nobody");
    expect(broadcasts).toHaveLength(2);
    expect(told).toHaveLength(2);
  });

  test("the Claude pick from before there were others is kept when Codex gets one", () => {
    host.openProject({ path: path.join(real, "ruri") });
    const project = store.list()[0]!;
    store.update(project.id, { account: "personal" });
    const ctx = { store, clients: { broadcast: () => {} } } as unknown as ServerContext;
    // the built-in Codex account is the default, so name one of the user's
    const side = addAccount("codex", "Side");
    accountHandlers.set_account(ctx, {} as never, {
      type: "set_account",
      projectId: project.id,
      account: side.id,
    });
    const saved = new ProjectStore().get(project.id)!;
    expect(saved.accounts).toEqual({ claude: "personal", codex: side.id });
    expect(saved).not.toHaveProperty("account");
  });

  test("a chat runs on an account of its own over its project's, and follows it again", () => {
    host.openProject({ path: path.join(real, "ruri") });
    const project = store.list()[0]!;
    const chatId = project.sessions[0]!.id;
    const broadcasts: unknown[] = [];
    const ctx = {
      store,
      clients: { broadcast: (m: unknown) => broadcasts.push(m) },
    } as unknown as ServerContext;
    const pick = (account?: string) =>
      accountHandlers.set_chat_account(ctx, { send: () => {} } as never, {
        type: "set_chat_account",
        chatId,
        provider: "claude",
        ...(account ? { account } : {}),
      });
    pick("personal");
    expect(store.findSession(chatId)?.session.accounts).toEqual({ claude: "personal" });
    expect(new ProjectStore().findSession(chatId)?.session.accounts).toEqual({ claude: "personal" });
    // the project itself stays where it was
    expect(store.get(project.id)).not.toHaveProperty("accounts");
    // picking what the project runs on is following the project
    pick("work");
    expect(store.findSession(chatId)?.session).not.toHaveProperty("accounts");
    pick("personal");
    pick();
    expect(store.findSession(chatId)?.session).not.toHaveProperty("accounts");
    expect(broadcasts).toHaveLength(4);
  });

  test("an account taken away takes the chats on it back to their project's", () => {
    host.openProject({ path: path.join(real, "ruri") });
    const project = store.list()[0]!;
    const chatId = project.sessions[0]!.id;
    const ctx = {
      store,
      clients: { broadcast: () => {} },
      terminals: { closeChannel: () => {} },
    } as unknown as ServerContext;
    const side = addAccount("claude", "Side");
    accountHandlers.set_chat_account(ctx, {} as never, {
      type: "set_chat_account",
      chatId,
      provider: "claude",
      account: side.id,
    });
    expect(store.findSession(chatId)?.session.accounts).toEqual({ claude: side.id });
    accountHandlers.account_remove(ctx, {} as never, { type: "account_remove", id: side.id });
    expect(store.findSession(chatId)?.session).not.toHaveProperty("accounts");
  });
});

describe("the sidebar's arrangement", () => {
  type Sent = { type: string; [key: string]: unknown };
  let sent: Sent[];
  let ctx: ServerContext;
  const ids = () => store.list().map((p) => p.name);
  const idOf = (name: string) => store.list().find((p) => p.name === name)!.id;
  const types = () => sent.map((m) => m.type);

  beforeEach(() => {
    for (const dir of ["ruri", "umi", "toji"]) host.openProject({ path: path.join(real, dir) });
    sent = [];
    ctx = { store, clients: { broadcast: (m: Sent) => sent.push(m) } } as unknown as ServerContext;
  });

  test("a project carried before another: the list follows, and outlives a restart", () => {
    expect(ids()).toEqual(["ruri", "umi", "toji"]);
    projectHandlers.sidebar_move(ctx, {} as never, {
      type: "sidebar_move",
      id: idOf("toji"),
      beforeId: idOf("ruri"),
    });
    expect(ids()).toEqual(["toji", "ruri", "umi"]);
    // the arrangement, and the projects again since their order moved
    expect(types()).toEqual(["sidebar", "projects"]);
    expect(new ProjectStore().list().map((p) => p.name)).toEqual(["toji", "ruri", "umi"]);
  });

  test("a folder made around a project, folded, renamed, filled and taken away", () => {
    const [ruri, umi, toji] = [idOf("ruri"), idOf("umi"), idOf("toji")];
    const folderId = "0b6f6f4e-8f0c-4a8e-9a57-2f1f3c1d2e3a";
    projectHandlers.folder_add(ctx, {} as never, {
      type: "folder_add",
      folderId,
      name: "side jobs",
      projectId: umi,
    });
    expect(store.sidebar()).toEqual({
      order: [ruri, folderId, toji],
      folders: [{ id: folderId, name: "side jobs", projects: [umi] }],
    });
    // nothing moved in the list: only the arrangement goes out
    expect(types()).toEqual(["sidebar"]);
    expect(store.folderName(umi)).toBe("side jobs");

    projectHandlers.folder_set(ctx, {} as never, { type: "folder_set", folderId, collapsed: true });
    projectHandlers.folder_set(ctx, {} as never, { type: "folder_set", folderId, name: "play" });
    expect(store.sidebar().folders[0]).toEqual({
      id: folderId,
      name: "play",
      collapsed: true,
      projects: [umi],
    });

    // ruri goes into it, ahead of umi: the list's order follows the folder's
    projectHandlers.sidebar_move(ctx, {} as never, {
      type: "sidebar_move",
      id: ruri,
      folderId,
      beforeId: umi,
    });
    expect(store.sidebar().folders[0]?.projects).toEqual([ruri, umi]);
    expect(ids()).toEqual(["ruri", "umi", "toji"]);
    expect(new ProjectStore().sidebar()).toEqual(store.sidebar());

    // the folder itself carried to the end: its projects go with it
    projectHandlers.sidebar_move(ctx, {} as never, { type: "sidebar_move", id: folderId });
    expect(ids()).toEqual(["toji", "ruri", "umi"]);

    projectHandlers.folder_remove(ctx, {} as never, { type: "folder_remove", folderId });
    expect(store.sidebar()).toEqual({ order: [toji, ruri, umi], folders: [] });
    expect(ids()).toEqual(["toji", "ruri", "umi"]);
  });

  test("every change is answered with the arrangement, even one that changes nothing", () => {
    projectHandlers.sidebar_move(ctx, {} as never, { type: "sidebar_move", id: "nope" });
    projectHandlers.folder_remove(ctx, {} as never, { type: "folder_remove", folderId: "nope" });
    expect(types()).toEqual(["sidebar", "sidebar"]);
  });

  test("a project closed leaves the arrangement; one opened joins its end", () => {
    const folderId = "0b6f6f4e-8f0c-4a8e-9a57-2f1f3c1d2e3b";
    store.addFolder(folderId, "work", idOf("umi"));
    store.remove(idOf("umi"));
    expect(store.sidebar()).toEqual({
      order: [idOf("ruri"), folderId, idOf("toji")],
      folders: [{ id: folderId, name: "work", projects: [] }],
    });
    host.openProject({ path: path.join(real, "umi") });
    expect(store.sidebar().order.at(-1)).toBe(idOf("umi"));
  });

  test("Home opening a project into a folder by name: the one of that name, or a new one", () => {
    fs.mkdirSync(path.join(real, "공항"), { recursive: true });
    fs.mkdirSync(path.join(real, "kiln"), { recursive: true });
    host.openProject({ path: path.join(real, "공항"), folder: "여행" });
    // the same name as a disk would spell it, decomposed: the same folder
    host.openProject({ path: path.join(real, "kiln"), folder: "여행".normalize("NFD") });
    const { folders } = store.sidebar();
    expect(folders).toHaveLength(1);
    expect(folders[0]?.projects).toEqual([idOf("공항"), idOf("kiln")]);
    expect(host.listProjects().find((p) => p.name === "kiln")?.folder).toBe("여행");
    expect(host.listProjects().find((p) => p.name === "ruri")).not.toHaveProperty("folder");
  });

  test("a list from before there was an arrangement: starred first, and its group labels as folders", () => {
    const file = path.join(process.env["RURI_CONFIG_DIR"]!, "projects.json");
    type Kept = { id: string; starred?: boolean; folder?: string };
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { projects: Kept[]; sidebar?: unknown };
    delete saved.sidebar;
    const [ruri, umi, toji] = saved.projects as [Kept, Kept, Kept];
    umi.starred = true;
    ruri.folder = "Work";
    toji.folder = "work";
    fs.writeFileSync(file, JSON.stringify(saved));
    const old = new ProjectStore();
    expect(old.list().map((p) => p.name)).toEqual(["umi", "ruri", "toji"]);
    const layout = old.sidebar();
    expect(layout.folders).toHaveLength(1);
    expect(layout.folders[0]).toMatchObject({ name: "Work", projects: [ruri.id, toji.id] });
    expect(layout.order).toEqual([umi.id, layout.folders[0]!.id]);
    // the label was only ever the folder's: it is not kept on the project
    expect(old.list().every((p) => !("folder" in p))).toBe(true);
  });
});

describe("the default reasoning effort", () => {
  /** The store, and each chat a running session was told a new effort for. */
  function world() {
    const told: Array<[string, string]> = [];
    const ctx = {
      store,
      manager: { setEffort: (id: string, effort: string) => told.push([id, effort]) },
      clients: { broadcast: () => {} },
    } as unknown as ServerContext;
    return { ctx, told };
  }
  const lead = (name: string) => store.list().find((p) => p.name === name)!.sessions[0]!.id;

  test("a chat nobody picked an effort for follows the default, when it changes too", () => {
    const { ctx, told } = world();
    store.add("ruri", path.join(real, "ruri"));
    store.add("umi", path.join(real, "umi"));
    store.setSessionSettings(lead("umi"), { effort: "max" });
    void settingHandlers.set_default_effort(ctx, undefined as never, {
      type: "set_default_effort",
      effort: "high",
    });
    expect(store.effectiveSettings(lead("ruri"))?.effort).toBe("high");
    // nothing is written on a project riding the default: it follows the next one too
    expect(store.list().find((p) => p.name === "ruri")).not.toHaveProperty("effort");
    // a pick stands, and its session is left alone
    expect(store.effectiveSettings(lead("umi"))?.effort).toBe("max");
    expect(told).toEqual([
      ["home", "high"],
      [lead("ruri"), "high"],
    ]);
    void settingHandlers.set_default_effort(ctx, undefined as never, {
      type: "set_default_effort",
      effort: "low",
    });
    expect(store.effectiveSettings(lead("ruri"))?.effort).toBe("low");
    expect(new ProjectStore().effectiveSettings(lead("ruri"))?.effort).toBe("low");
  });

  test("projects an older ruri pinned at xhigh when the default changed ride the default again", () => {
    store.add("ruri", path.join(real, "ruri"));
    store.add("umi", path.join(real, "umi"));
    store.add("toji", path.join(real, "toji"));
    store.setSessionSettings(lead("umi"), { effort: "xhigh" });
    store.setDefaultEffort("high");
    // as that ruri left the file: the project marked, its chat not; Home too
    const file = path.join(process.env["RURI_CONFIG_DIR"]!, "projects.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      projects: Array<{ name: string; effort?: string }>;
      home?: { effort?: string };
    };
    raw.projects.find((p) => p.name === "ruri")!.effort = "xhigh";
    raw.home = { ...raw.home, effort: "xhigh" };
    fs.writeFileSync(file, JSON.stringify(raw));
    const next = new ProjectStore();
    expect(next.effectiveSettings(lead("ruri"))?.effort).toBe("high");
    expect(next.homeSettings().effort).toBeUndefined();
    expect(next.effectiveSettings(lead("toji"))?.effort).toBe("high");
    // xhigh picked in the composer is on the chat as well: it stands
    expect(next.effectiveSettings(lead("umi"))?.effort).toBe("xhigh");
  });
});
