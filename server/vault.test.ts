/**
 * The ghostly vault from ruri's side, against a stand-in for the `ghostly`
 * command: a script in a folder of the test's own that keeps its items in
 * a JSON file and writes down every run — its arguments and what came in
 * on stdin — so a test can say what was, and was not, put on a command
 * line. The real command, over its own stand-in for Bitwarden's CLI, is
 * server/vault.ghostly.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ghostly, GhostlyError } from "./ghostly.js";
import { SecretStore } from "./secrets.js";
import { Vault } from "./vault.js";

interface StandInItem {
  id: string;
  name: string;
  type?: string;
  username?: string;
  password?: string;
  collections?: string[];
  humanOnly?: boolean;
}

interface StandInState {
  enrolled: boolean;
  ok: boolean;
  problem?: string;
  collections: string[];
  items: StandInItem[];
  /** A command that fails, and what it says: { list: "…" }. */
  fail?: Record<string, string>;
  /** Milliseconds every run takes. */
  slow?: number;
}

const STAND_IN = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const stateFile = path.join(dir, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const started = Date.now();
const fail = (message, hint, code = 1) => {
  process.stderr.write("ghostly: " + message + "\\n" + (hint ? "         " + hint + "\\n" : ""));
  process.exit(code);
};
const finish = () => {
  fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv, stdin, started, ended: Date.now() }) + "\\n");
};
const main = () => {
  const [command, ...rest] = argv;
  const dashes = rest.indexOf("--");
  const flags = dashes === -1 ? rest : rest.slice(0, dashes);
  const ref = dashes === -1 ? undefined : rest[dashes + 1];
  const flag = (name) => {
    const hit = flags.find((f) => f.startsWith("--" + name + "="));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  if (!state.enrolled) fail("this machine has no agent enrolled yet", "run \`ghostly init\`");
  if (state.fail && state.fail[command]) fail(state.fail[command], "the stand-in was told to");
  const summary = (item) => ({
    id: item.id,
    name: item.name,
    type: item.type || "login",
    username: item.username || null,
    uris: [],
    fields: [...(item.username ? ["username"] : []), ...(item.password ? ["password"] : [])],
    collections: item.collections || [],
    shared: (item.collections || []).length > 0,
    humanOnly: item.humanOnly === true,
  });
  const find = (wanted) =>
    state.items.find((item) => item.id === wanted) ||
    state.items.find((item) => item.name.toLowerCase() === String(wanted).toLowerCase());
  if (command === "status") {
    process.stdout.write(JSON.stringify({
      server: "https://vault.test", email: "ruri@ghostly.test", ok: state.ok,
      ...(state.problem ? { problem: state.problem } : {}),
      organizations: ["ghostly"], collections: state.collections, items: state.items.length, lastSync: null,
    }));
  } else if (command === "list") {
    process.stdout.write(JSON.stringify(state.items.map(summary)));
  } else if (command === "get") {
    const item = find(ref);
    if (!item) fail('no item named "' + ref + '"');
    if (item.humanOnly) fail('"' + item.name + '" is marked for master password re-prompt, so ghostly will not hand it to an agent');
    process.stdout.write(item.password + "\\n");
  } else if (command === "put") {
    const existing = find(ref);
    const update = flags.includes("--update");
    if (existing && !update) fail('"' + existing.name + '" already exists', "pass --update to replace its password");
    const password = flags.includes("--generate") ? "generated-" + (state.items.length + 1) + "-Zx9" : stdin.replace(/\\r?\\n$/, "");
    if (!password) fail("the secret on stdin was empty", undefined, 2);
    const username = flag("username");
    const collection = flag("collection");
    if (existing) {
      existing.password = password;
      if (username !== undefined) existing.username = username;
    } else {
      if (!collection && state.collections.length > 1) fail("this agent can see several collections (" + state.collections.join(", ") + ")", "pass --collection <name>");
      state.items.push({
        id: "made-" + (state.items.length + 1), name: ref, password,
        ...(username ? { username } : {}),
        collections: [collection || state.collections[0]].filter(Boolean),
      });
    }
    save();
    process.stderr.write("✓ stored\\n");
  } else if (command === "rm") {
    const item = find(ref);
    if (!item) fail('no item named "' + ref + '"');
    state.items = state.items.filter((entry) => entry !== item);
    save();
  } else {
    fail('unknown command "' + command + '"', undefined, 2);
  }
};
process.on("exit", finish);
if (state.slow) setTimeout(main, state.slow);
else main();
`;

const GITHUB = "gh-S3cret-Passw0rd!";
const STAGING = "pg-pass-0xDEADBEEF";

let home: string;
let dir: string;
const saved = { config: process.env["RURI_CONFIG_DIR"], ghostly: process.env["RURI_GHOSTLY"] };

function setState(patch: Partial<StandInState>): void {
  const file = path.join(home, "state.json");
  const before = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as StandInState) : {};
  fs.writeFileSync(file, JSON.stringify({ ...before, ...patch }));
}

function state(): StandInState {
  return JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8")) as StandInState;
}

interface Call {
  argv: string[];
  stdin: string;
  started: number;
  ended: number;
}

function calls(command?: string): Call[] {
  const file = path.join(home, "calls.jsonl");
  if (!fs.existsSync(file)) return [];
  const all = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Call);
  return command ? all.filter((call) => call.argv[0] === command) : all;
}

function forgetCalls(): void {
  fs.rmSync(path.join(home, "calls.jsonl"), { force: true });
}

/** What ruri wrote to its own disk. */
function onDisk(): string {
  const file = path.join(dir, "secrets.json");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function make(): { vault: Vault; secrets: SecretStore; said: () => number } {
  const secrets = new SecretStore();
  let told = 0;
  const vault = new Vault(secrets, new Ghostly({ timeoutMs: 10_000, statusTimeoutMs: 10_000 }), () => {
    told += 1;
  });
  return { vault, secrets, said: () => told };
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ghostly-"));
  fs.writeFileSync(path.join(home, "ghostly"), STAND_IN, { mode: 0o755 });
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-vault-"));
  process.env["RURI_CONFIG_DIR"] = dir;
  process.env["RURI_GHOSTLY"] = path.join(home, "ghostly");
  fs.writeFileSync(
    path.join(home, "state.json"),
    JSON.stringify({
      enrolled: true,
      ok: true,
      collections: ["agent"],
      items: [
        { id: "id-github", name: "GitHub", username: "octo", password: GITHUB, collections: ["agent"] },
        { id: "id-staging", name: "Staging DB", password: STAGING, collections: ["agent"] },
        {
          id: "id-root",
          name: "Root",
          username: "root",
          password: "people-only-pw",
          collections: ["agent"],
          humanOnly: true,
        },
        { id: "id-note", name: "A note", type: "note", collections: ["agent"] },
        { id: "id-empty", name: "No password", username: "x", collections: ["agent"] },
      ],
    } satisfies StandInState),
  );
  forgetCalls();
});

afterAll(() => {
  for (const [key, value] of [
    ["RURI_CONFIG_DIR", saved.config],
    ["RURI_GHOSTLY", saved.ghostly],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ghostly's command, as ruri runs it", () => {
  test('RURI_GHOSTLY="" is no ghostly at all', async () => {
    process.env["RURI_GHOSTLY"] = "";
    const ghostly = new Ghostly();
    expect(ghostly.where()).toBeNull();
    expect(ghostly.list()).rejects.toThrow("not installed");
  });

  test("status says who the agent is; a machine with none is told apart", async () => {
    const ghostly = new Ghostly();
    expect(await ghostly.status()).toEqual({
      server: "https://vault.test",
      email: "ruri@ghostly.test",
      ok: true,
      collections: ["agent"],
    });
    setState({ enrolled: false });
    const error = await ghostly.status().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GhostlyError);
    expect((error as GhostlyError).unenrolled).toBe(true);
    expect((error as GhostlyError).hint).toBe("run `ghostly init`");
  });

  test("the list carries no secret", async () => {
    const items = await new Ghostly().list();
    expect(items.map((item) => item.name)).toEqual(["GitHub", "Staging DB", "Root", "A note", "No password"]);
    expect(items[0]).toEqual({
      id: "id-github",
      name: "GitHub",
      type: "login",
      username: "octo",
      fields: ["username", "password"],
      collections: ["agent"],
      humanOnly: false,
    });
    expect(JSON.stringify(items)).not.toContain(GITHUB);
  });

  test("a read is the value, without the newline ghostly ends it with", async () => {
    expect(await new Ghostly().read("id-github")).toBe(GITHUB);
  });

  test("a secret goes in on stdin, never on the command line", async () => {
    const ghostly = new Ghostly();
    await ghostly.put("-dash name", { username: "-u" }, "s3cret with spaces\nand a line");
    const [put] = calls("put");
    expect(put?.argv).toEqual(["put", "--username=-u", "--", "-dash name"]);
    expect(put?.stdin).toBe("s3cret with spaces\nand a line");
    expect(JSON.stringify(put?.argv)).not.toContain("s3cret");
    expect(await ghostly.read("-dash name")).toBe("s3cret with spaces\nand a line");
  });

  test("what ghostly says when it refuses comes back whole: the message and its hint", async () => {
    const error = await new Ghostly().put("GitHub", {}, "another").catch((err: unknown) => err);
    expect((error as GhostlyError).message).toBe('"GitHub" already exists');
    expect((error as GhostlyError).said).toBe(
      '"GitHub" already exists — pass --update to replace its password',
    );
  });

  test("one run at a time, in the order asked", async () => {
    setState({ slow: 60 });
    const ghostly = new Ghostly();
    await Promise.all([
      ghostly.list(),
      ghostly.read("id-github"),
      ghostly.read("id-staging"),
      ghostly.list(),
    ]);
    const ran = calls();
    expect(ran.map((call) => call.argv[0])).toEqual(["list", "get", "get", "list"]);
    for (let i = 1; i < ran.length; i++) expect(ran[i]!.started).toBeGreaterThanOrEqual(ran[i - 1]!.ended);
  });

  test("a ghostly that does not answer costs the wait, not the server", async () => {
    setState({ slow: 5_000 });
    const ghostly = new Ghostly({ timeoutMs: 200 });
    expect(ghostly.list()).rejects.toThrow("did not answer");
  });
});

describe("the first read", () => {
  test("logins with a password come in, values and all — and none of it reaches ruri's disk", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    expect(vault.view()).toMatchObject({
      installed: true,
      enrolled: true,
      ok: true,
      server: "https://vault.test",
      account: "ruri@ghostly.test",
      collections: ["agent"],
      syncing: false,
    });
    expect(vault.view().syncedAt).toBeNumber();
    expect(secrets.meta().map((m) => [m.name, m.store, m.hasValue, m.humanOnly ?? false])).toEqual([
      ["GitHub", "ghostly", true, false],
      ["Staging DB", "ghostly", true, false],
      ["Root", "ghostly", false, true],
    ]);
    expect(secrets.env()).toEqual({
      RURI_SECRET_GITHUB: GITHUB,
      RURI_USER_GITHUB: "octo",
      RURI_SECRET_STAGING_DB: STAGING,
    });
    expect(secrets.fill("psql {{Staging DB}} as {{github.user}}")).toBe(`psql ${STAGING} as octo`);
    expect(secrets.redact(`leaked ${GITHUB}`)).toBe("leaked {{GitHub}}");
    expect(onDisk()).not.toContain(GITHUB);
    expect(onDisk()).not.toContain(STAGING);
  });

  test("one kept for people only is listed, never read, and not offered to a model", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    expect(calls("get").map((call) => call.argv.at(-1))).toEqual(["id-github", "id-staging"]);
    expect(secrets.briefing()).toContain("{{GitHub}}");
    expect(secrets.briefing()).not.toContain("Root");
    expect(secrets.fill("su {{Root}}")).toBe("su {{Root}}");
  });

  test("no ghostly on the machine: nothing is asked, and the page is told so", async () => {
    process.env["RURI_GHOSTLY"] = "";
    const { vault, secrets } = make();
    await vault.refresh(true);
    expect(vault.view()).toEqual({
      installed: false,
      enrolled: false,
      ok: false,
      collections: [],
      syncing: false,
    });
    expect(vault.usable).toBe(false);
    expect(secrets.meta()).toEqual([]);
    expect(calls()).toEqual([]);
  });

  test("ghostly here but no agent enrolled: installed, and no more", async () => {
    setState({ enrolled: false });
    const { vault } = make();
    await vault.refresh(true);
    expect(vault.view()).toEqual({
      installed: true,
      enrolled: false,
      ok: false,
      collections: [],
      syncing: false,
    });
    // and found once `ghostly init` has been run, with no restart
    setState({ enrolled: true });
    await vault.refresh(false);
    expect(vault.usable).toBe(true);
  });

  test("a read that fails is said, and costs only that one", async () => {
    setState({ fail: { get: "the vault is locked" } });
    const { vault, secrets } = make();
    await vault.refresh(true);
    expect(vault.view().ok).toBe(true);
    expect(vault.view().failed).toStartWith(
      'ghostly could not read "GitHub", "Staging DB": the vault is locked',
    );
    expect(secrets.meta().map((m) => m.hasValue)).toEqual([false, false, false]);
    setState({ fail: {} });
    await vault.refresh(true);
    expect(vault.view().failed).toBeUndefined();
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBe(GITHUB);
  });
});

describe("keeping in step", () => {
  test("the list alone: what is gone leaves, what is new is read, what is held is not read again", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    forgetCalls();
    const before = state();
    setState({
      items: [
        ...before.items.filter((item) => item.id !== "id-staging"),
        { id: "id-new", name: "Fresh", password: "fresh-value-1", collections: ["agent"] },
      ],
    });
    await vault.refresh(false);
    expect(calls().map((call) => call.argv[0])).toEqual(["list", "get"]);
    expect(calls("get")[0]?.argv.at(-1)).toBe("id-new");
    expect(Object.keys(secrets.env()).sort()).toEqual([
      "RURI_SECRET_FRESH",
      "RURI_SECRET_GITHUB",
      "RURI_USER_GITHUB",
    ]);
    expect(secrets.redact(STAGING)).toBe(STAGING);
  });

  test("a value changed in the vault is picked up by a full read", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    const before = state();
    setState({
      items: before.items.map((item) =>
        item.id === "id-github" ? { ...item, password: "rotated-value" } : item,
      ),
    });
    await vault.refresh(false);
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBe(GITHUB);
    await vault.refresh(true);
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBe("rotated-value");
  });

  test("a vault that does not answer leaves what is held alone, and says why", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    setState({ fail: { list: "the vault did not answer" } });
    await vault.refresh(false);
    expect(vault.view()).toMatchObject({ installed: true, enrolled: true, ok: false, syncing: false });
    expect(vault.view().problem).toStartWith("the vault did not answer");
    expect(vault.usable).toBe(false);
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBe(GITHUB);
    // and back, once it answers
    setState({ fail: {} });
    await vault.refresh(false);
    expect(vault.view().ok).toBe(true);
    expect(vault.view().problem).toBeUndefined();
  });

  test("an unreachable vault that still lists from its cache keeps working, and is not written to", async () => {
    setState({ ok: false, problem: "the vault server did not answer" });
    const { vault, secrets } = make();
    await vault.refresh(true);
    expect(vault.view()).toMatchObject({ ok: false, problem: "the vault server did not answer" });
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBe(GITHUB);
    await vault.save({ name: "new one", secret: "kept-on-this-machine" });
    expect(calls("put")).toEqual([]);
    expect(secrets.meta().find((m) => m.name === "new one")?.store).toBeUndefined();
  });

  test("asking twice while one read waits is asking once; a page opening asks at most once a minute", async () => {
    const { vault } = make();
    const first = vault.refresh(true);
    const second = vault.refresh(true);
    const third = vault.refresh(false);
    await Promise.all([first, second, third]);
    expect(calls("list")).toHaveLength(1);
    vault.opened();
    await vault.refresh(false);
    // opened() asked nothing of its own: the one list is the refresh's
    expect(calls("list")).toHaveLength(2);
  });

  test("every window is told when a read starts and when it lands", async () => {
    const { vault, said } = make();
    await vault.refresh(true);
    expect(said()).toBe(2);
  });
});

describe("saving", () => {
  test("a new secret goes to the vault, on stdin — its value nowhere on ruri's disk, its note kept by id", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    forgetCalls();
    await vault.save({
      name: "deploy box",
      username: "root",
      note: "the prod box",
      secret: "hunter2hunter2",
    });
    const [put] = calls("put");
    expect(put?.argv).toEqual(["put", "--username=root", "--", "deploy box"]);
    expect(put?.stdin).toBe("hunter2hunter2");
    // the list again for its id, and no read: ruri wrote the value itself
    expect(calls().map((call) => call.argv[0])).toEqual(["put", "list"]);
    const made = secrets.meta().find((m) => m.name === "deploy box");
    expect(made).toMatchObject({
      store: "ghostly",
      username: "root",
      note: "the prod box",
      hasValue: true,
      collection: "agent",
    });
    expect(secrets.env()["RURI_SECRET_DEPLOY_BOX"]).toBe("hunter2hunter2");
    expect(onDisk()).not.toContain("hunter2hunter2");
    expect(JSON.parse(onDisk())).toEqual({ secrets: [], ghostlyNotes: { [made!.id]: "the prod box" } });
    // a fresh ruri reads the note back once the vault lists the item
    const again = make();
    await again.vault.refresh(true);
    expect(again.secrets.briefing()).toContain("the prod box");
  });

  test("the vault makes one when asked to, and ruri reads back what it made", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    await vault.save({ name: "made here", generate: true });
    const [put] = calls("put");
    expect(put?.argv).toEqual(["put", "--generate", "--", "made here"]);
    expect(put?.stdin).toBe("");
    expect(secrets.env()["RURI_SECRET_MADE_HERE"]).toStartWith("generated-");
  });

  test("with several collections shared, the one chosen is where it goes", async () => {
    setState({ collections: ["agent", "work"] });
    const { vault, secrets } = make();
    await vault.refresh(true);
    await vault.save({ name: "no choice", secret: "abcdefgh" });
    expect(vault.view().failed).toContain("several collections (agent, work)");
    expect(secrets.meta().some((m) => m.name === "no choice")).toBe(false);
    await vault.save({ name: "chosen", secret: "abcdefgh", collection: "work" });
    expect(vault.view().failed).toBeUndefined();
    expect(secrets.meta().find((m) => m.name === "chosen")?.collection).toBe("work");
  });

  test("a new value for one of the vault's replaces it there", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    forgetCalls();
    await vault.save({ id: "id-github", name: "GitHub", username: "octo", secret: "a-new-password" });
    expect(calls().map((call) => call.argv)).toEqual([["put", "--update", "--", "GitHub"]]);
    expect(calls("put")[0]?.stdin).toBe("a-new-password");
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBe("a-new-password");
    expect(state().items.find((item) => item.id === "id-github")?.password).toBe("a-new-password");
  });

  test("a changed account name sends back the value ruri holds; a changed note sends nothing", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    forgetCalls();
    await vault.save({ id: "id-github", name: "GitHub", username: "octo", note: "for pushes" });
    expect(calls()).toEqual([]);
    expect(secrets.meta().find((m) => m.id === "id-github")?.note).toBe("for pushes");
    await vault.save({ id: "id-github", name: "GitHub", username: "hubot", note: "for pushes" });
    expect(calls("put")[0]?.argv).toEqual(["put", "--username=hubot", "--update", "--", "GitHub"]);
    expect(calls("put")[0]?.stdin).toBe(GITHUB);
    expect(secrets.env()).toMatchObject({ RURI_SECRET_GITHUB: GITHUB, RURI_USER_GITHUB: "hubot" });
  });

  test("one of the vault's keeps its name: ghostly has no rename", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    await vault.save({ id: "id-github", name: "Renamed", username: "octo", secret: "a-new-password" });
    expect(secrets.meta().find((m) => m.id === "id-github")?.name).toBe("GitHub");
    expect(calls("put")[0]?.argv.at(-1)).toBe("GitHub");
  });

  test("one kept for people only can be given a new password, which ruri then lets go of", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    await vault.save({ id: "id-root", name: "Root", username: "admin" });
    expect(vault.view().failed).toContain("kept for people only");
    expect(calls("put")).toEqual([]);
    await vault.save({ id: "id-root", name: "Root", username: "admin", secret: "typed-again-pw" });
    expect(vault.view().failed).toBeUndefined();
    expect(state().items.find((item) => item.id === "id-root")).toMatchObject({
      username: "admin",
      password: "typed-again-pw",
    });
    expect(secrets.meta().find((m) => m.id === "id-root")).toMatchObject({
      hasValue: false,
      humanOnly: true,
    });
    expect(secrets.redact("typed-again-pw")).toBe("typed-again-pw");
  });

  test("what ghostly refuses is said on the page, and gone after the next thing that works", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    // the vault holds one ruri does not list (it has no password): the name is taken
    await vault.save({ name: "No password", secret: "abcdefgh" });
    expect(vault.view().failed).toBe('"No password" already exists — pass --update to replace its password');
    expect(secrets.meta().some((m) => m.name === "No password")).toBe(false);
    expect(onDisk()).not.toContain("abcdefgh");
    await vault.save({ name: "fine", secret: "abcdefgh" });
    expect(vault.view().failed).toBeUndefined();
    // …or after a Refresh by hand, while the slow look on its own leaves it said
    await vault.save({ name: "No password", secret: "abcdefgh" });
    await vault.refresh(false);
    expect(vault.view().failed).toContain("already exists");
    await vault.refresh(true);
    expect(vault.view().failed).toBeUndefined();
  });

  test("with no vault, a secret is kept in ruri's own file, as it always was", async () => {
    process.env["RURI_GHOSTLY"] = "";
    const { vault, secrets } = make();
    await vault.refresh(true);
    await vault.save({ name: "deploy box", username: "root", secret: "hunter2hunter2" });
    expect(secrets.meta()).toMatchObject([{ name: "deploy box", username: "root", hasValue: true }]);
    expect(secrets.meta()[0]?.store).toBeUndefined();
    expect(onDisk()).toContain("hunter2hunter2");
    await vault.save({ name: "made", generate: true });
    expect(vault.view().failed).toContain("only the ghostly vault makes a password");
    expect(secrets.meta()).toHaveLength(1);
    await vault.remove(secrets.meta()[0]!.id);
    expect(secrets.meta()).toEqual([]);
  });

  test("one of ruri's own stays ruri's own when edited, vault or no vault", async () => {
    const { vault, secrets } = make();
    secrets.upsert({ name: "old one", secret: "kept-locally" });
    await vault.refresh(true);
    const id = secrets.meta().find((m) => m.name === "old one")!.id;
    await vault.save({ id, name: "old one", username: "me", secret: "kept-locally-2" });
    // and by its name alone, as a new one of a name ruri already has always was
    await vault.save({ name: "Old One", note: "still here" });
    expect(calls("put")).toEqual([]);
    const own = secrets.meta().find((m) => m.id === id);
    expect(own).toMatchObject({ name: "Old One", note: "still here", hasValue: true });
    expect(own?.store).toBeUndefined();
    expect(onDisk()).toContain("kept-locally-2");
  });
});

describe("forgetting and moving", () => {
  test("forgetting one of the vault's sends it to the vault's trash", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    await vault.save({ id: "id-github", name: "GitHub", username: "octo", note: "for pushes" });
    await vault.remove("id-github");
    expect(calls("rm")[0]?.argv).toEqual(["rm", "--", "id-github"]);
    expect(secrets.meta().some((m) => m.id === "id-github")).toBe(false);
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBeUndefined();
    expect(state().items.some((item) => item.id === "id-github")).toBe(false);
    expect(onDisk()).not.toContain("for pushes");
  });

  test("moving one of ruri's own: stored in the vault, then out of ruri's file, its note along", async () => {
    const { vault, secrets } = make();
    secrets.upsert({ name: "deploy box", username: "root", note: "the prod box", secret: "hunter2hunter2" });
    await vault.refresh(true);
    expect(onDisk()).toContain("hunter2hunter2");
    await vault.move(secrets.meta().find((m) => m.name === "deploy box")!.id);
    expect(vault.view().failed).toBeUndefined();
    expect(calls("put")[0]?.argv).toEqual(["put", "--username=root", "--", "deploy box"]);
    expect(calls("put")[0]?.stdin).toBe("hunter2hunter2");
    const moved = secrets.meta().filter((m) => m.name === "deploy box");
    expect(moved).toMatchObject([
      { store: "ghostly", username: "root", note: "the prod box", hasValue: true },
    ]);
    expect(onDisk()).not.toContain("hunter2hunter2");
    expect(secrets.env()["RURI_SECRET_DEPLOY_BOX"]).toBe("hunter2hunter2");
  });

  test("a move the vault refuses leaves ruri's own where it was", async () => {
    const { vault, secrets } = make();
    secrets.upsert({ name: "github", secret: "the-local-one" });
    secrets.upsert({ name: "empty" });
    await vault.refresh(true);
    const id = (name: string): string => secrets.meta().find((m) => m.name === name && !m.store)!.id;
    await vault.move(id("github"));
    expect(vault.view().failed).toContain('the vault already has one named "github"');
    await vault.move(id("empty"));
    expect(vault.view().failed).toContain("has no value yet");
    expect(calls("put")).toEqual([]);
    expect(onDisk()).toContain("the-local-one");
  });
});

describe("a name both places hold", () => {
  test("the vault's answers to it; ruri's own waits behind, and is still redacted", async () => {
    const { vault, secrets } = make();
    secrets.upsert({ name: "github", secret: "the-local-one" });
    await vault.refresh(true);
    expect(secrets.env()["RURI_SECRET_GITHUB"]).toBe(GITHUB);
    expect(secrets.fill("{{github}}")).toBe(GITHUB);
    expect(secrets.meta().map((m) => [m.name, m.store ?? "local", m.shadowed ?? false])).toEqual([
      ["GitHub", "ghostly", false],
      ["Staging DB", "ghostly", false],
      ["Root", "ghostly", false],
      ["github", "local", true],
    ]);
    expect(secrets.redact("the-local-one")).toBe("{{github}}");
    expect(secrets.briefing().match(/github/gi)).toHaveLength(3);
  });

  test("one the vault keeps for people only stands in front of nothing", async () => {
    const { vault, secrets } = make();
    secrets.upsert({ name: "root", secret: "the-local-root" });
    await vault.refresh(true);
    expect(secrets.env()["RURI_SECRET_ROOT"]).toBe("the-local-root");
    expect(secrets.meta().find((m) => m.name === "root")?.shadowed).toBeUndefined();
  });
});
