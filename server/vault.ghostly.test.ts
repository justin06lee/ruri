/**
 * The vault against ghostly's own command, from a checkout beside this
 * one: the real `ghostly`, run the way ruri runs it, over ghostly's own
 * stand-in for Bitwarden's CLI (its test/fake-bw.ts) in a home of the
 * test's making — so no vault anywhere is reached, and what is checked is
 * that ruri and ghostly still speak the same words: its JSON, its flags,
 * its stdin, its refusals.
 *
 * Skipped where there is no checkout (CI). RURI_GHOSTLY_SRC names one
 * that is somewhere other than ../ghostly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Ghostly } from "./ghostly.js";
import { SecretStore } from "./secrets.js";
import { Vault } from "./vault.js";

const SRC = process.env["RURI_GHOSTLY_SRC"] ?? path.resolve(import.meta.dir, "..", "..", "ghostly");
const CLI = path.join(SRC, "src", "cli.ts");
const FAKE_BW = path.join(SRC, "test", "fake-bw.ts");
const here = fs.existsSync(CLI) && fs.existsSync(FAKE_BW);

const GITHUB = "gh-S3cret-Passw0rd!";
const STAGING = "pg-pass-0xDEADBEEF";

describe.skipIf(!here)("ghostly's own command, as ruri runs it", () => {
  const keys = ["RURI_CONFIG_DIR", "RURI_GHOSTLY", "GHOSTLY_HOME", "GHOSTLY_BW"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let home: string;
  let dir: string;

  /** What ghostly's stand-in for bw holds, and every bw run so far. */
  const bw = {
    items: (): Array<{ name: string; login?: { username?: string | null; password?: string | null } }> =>
      (JSON.parse(fs.readFileSync(path.join(home, "agent", "bw", "fake.json"), "utf8")) as { items: never[] })
        .items,
    calls: (): string =>
      fs.existsSync(path.join(home, "agent", "bw", "calls.log"))
        ? fs.readFileSync(path.join(home, "agent", "bw", "calls.log"), "utf8")
        : "",
  };

  function make(): { vault: Vault; secrets: SecretStore } {
    const secrets = new SecretStore();
    return { secrets, vault: new Vault(secrets, new Ghostly(), () => undefined) };
  }

  beforeAll(() => {
    process.env["RURI_GHOSTLY"] = CLI;
    process.env["GHOSTLY_BW"] = FAKE_BW;
  });

  // an enrolled agent in a folder of its own, as ghostly's tests make one
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ghostly-home-"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-vault-real-"));
    process.env["GHOSTLY_HOME"] = home;
    process.env["RURI_CONFIG_DIR"] = dir;
    const agent = path.join(home, "agent");
    fs.mkdirSync(path.join(agent, "bw"), { recursive: true });
    fs.writeFileSync(
      path.join(agent, "config.json"),
      JSON.stringify({ server: "https://vault.test", email: "agent@ghostly.test" }),
    );
    fs.writeFileSync(path.join(agent, "master-password"), "the-agent-master-password\n", { mode: 0o600 });
    const login = (id: string, name: string, username: string, password: string, reprompt = 0): object => ({
      id: `aaaaaaaa-0000-0000-0000-00000000000${id}`,
      type: 1,
      name,
      organizationId: "org-1",
      collectionIds: ["col-1"],
      reprompt,
      login: { username, password, totp: null, uris: [] },
    });
    fs.writeFileSync(
      path.join(agent, "bw", "fake.json"),
      JSON.stringify({
        serverUrl: null,
        email: "agent@ghostly.test",
        password: "the-agent-master-password",
        status: "unauthenticated",
        generation: 0,
        items: [
          login("1", "GitHub", "octo-agent", GITHUB),
          login("2", "GitHub Staging", "app", STAGING),
          login("3", "Human only", "root", "reprompt-protected", 1),
        ],
        collections: [{ id: "col-1", organizationId: "org-1", name: "agent" }],
        organizations: [{ id: "org-1", name: "ghostly" }],
      }),
    );
  });

  afterAll(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("the first read: who the agent is, what is shared, each value — and people-only left alone", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    expect(vault.view()).toMatchObject({
      installed: true,
      enrolled: true,
      ok: true,
      server: "https://vault.test",
      account: "agent@ghostly.test",
      collections: ["agent"],
    });
    expect(vault.view().failed).toBeUndefined();
    expect(
      secrets.meta().map((m) => [m.name, m.username, m.hasValue, m.humanOnly ?? false, m.collection]),
    ).toEqual([
      ["GitHub", "octo-agent", true, false, "agent"],
      ["GitHub Staging", "app", true, false, "agent"],
      ["Human only", "root", false, true, "agent"],
    ]);
    expect(secrets.env()).toMatchObject({ RURI_SECRET_GITHUB: GITHUB, RURI_SECRET_GITHUB_STAGING: STAGING });
    expect(secrets.env()["RURI_SECRET_HUMAN_ONLY"]).toBeUndefined();
  }, 60_000);

  test("a secret saved in ruri lands in the vault, and never on a command line or ruri's disk", async () => {
    const { vault, secrets } = make();
    await vault.refresh(true);
    await vault.save({
      name: "deploy box",
      username: "root",
      note: "the prod box",
      secret: "hunter2-hunter2",
    });
    expect(vault.view().failed).toBeUndefined();
    expect(bw.items().find((item) => item.name === "deploy box")?.login).toMatchObject({
      username: "root",
      password: "hunter2-hunter2",
    });
    expect(secrets.meta().find((m) => m.name === "deploy box")).toMatchObject({
      store: "ghostly",
      username: "root",
      note: "the prod box",
      hasValue: true,
      collection: "agent",
    });
    expect(secrets.env()["RURI_SECRET_DEPLOY_BOX"]).toBe("hunter2-hunter2");
    expect(bw.calls()).not.toContain("hunter2-hunter2");
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain("hunter2-hunter2");
  }, 60_000);

  test("an edit, a password the vault makes, a forget, and a move — each as ghostly does it", async () => {
    const { vault, secrets } = make();
    secrets.upsert({ name: "old local", username: "me", secret: "kept-locally-9" });
    await vault.refresh(true);
    const id = (name: string): string => secrets.meta().find((m) => m.name === name)!.id;

    // a changed account name sends back the value ruri holds
    await vault.save({ id: id("GitHub"), name: "GitHub", username: "hubot" });
    expect(vault.view().failed).toBeUndefined();
    expect(bw.items().find((item) => item.name === "GitHub")?.login).toMatchObject({
      username: "hubot",
      password: GITHUB,
    });

    await vault.save({ name: "made here", generate: true });
    expect(vault.view().failed).toBeUndefined();
    const made = bw.items().find((item) => item.name === "made here")?.login?.password;
    expect(made).toBeString();
    expect(secrets.env()["RURI_SECRET_MADE_HERE"]).toBe(made!);

    await vault.remove(id("GitHub Staging"));
    expect(vault.view().failed).toBeUndefined();
    expect(secrets.meta().some((m) => m.name === "GitHub Staging")).toBe(false);

    await vault.move(id("old local"));
    expect(vault.view().failed).toBeUndefined();
    expect(secrets.meta().filter((m) => m.name === "old local")).toMatchObject([
      { store: "ghostly", username: "me" },
    ]);
    expect(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")).not.toContain("kept-locally-9");

    // and a refusal comes back in ghostly's own words
    await vault.save({ id: id("Human only"), name: "Human only", username: "admin" });
    expect(vault.view().failed).toContain("kept for people only");
  }, 120_000);

  test("a machine with ghostly and no agent is told apart from one with a vault", async () => {
    fs.rmSync(path.join(home, "agent", "config.json"));
    const { vault } = make();
    await vault.refresh(true);
    expect(vault.view()).toEqual({
      installed: true,
      enrolled: false,
      ok: false,
      collections: [],
      syncing: false,
    });
  }, 60_000);
});
