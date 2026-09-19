import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SecretStore } from "./secrets.js";

let dir: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-secrets-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

/** A store with the one secret most tests want. */
function seeded(): SecretStore {
  const store = new SecretStore();
  store.upsert({ name: "deploy box", username: "root", secret: "hunter2hunter2", note: "the prod box" });
  return store;
}

describe("what the UI and the harness see", () => {
  test("meta carries everything but the value", () => {
    const [meta] = seeded().meta();
    expect(meta).toMatchObject({
      name: "deploy box",
      username: "root",
      note: "the prod box",
      hasValue: true,
    });
    expect(meta).not.toHaveProperty("value");
    expect(meta?.id).toBeString();
  });

  test("the environment: RURI_SECRET_<SLUG> and RURI_USER_<SLUG>", () => {
    expect(seeded().env()).toEqual({
      RURI_SECRET_DEPLOY_BOX: "hunter2hunter2",
      RURI_USER_DEPLOY_BOX: "root",
    });
  });

  test("a slug keeps letters and digits of any script and trims the rest", () => {
    const store = new SecretStore();
    store.upsert({ name: "  --café-1--  ", secret: "abcdefg" });
    store.upsert({ name: "!!!", secret: "abcdefg" });
    expect(Object.keys(store.env())).toEqual(["RURI_SECRET_CAFÉ_1"]);
  });
});

describe("fill", () => {
  test("swaps a handle for its value, by name or by slug, spaces and case aside", () => {
    const store = seeded();
    expect(store.fill("ssh {{deploy box}}")).toBe("ssh hunter2hunter2");
    expect(store.fill("ssh {{ DEPLOY_BOX }}")).toBe("ssh hunter2hunter2");
    expect(store.fill("ssh {{Deploy Box}}")).toBe("ssh hunter2hunter2");
  });

  test("the .user form is the account", () => {
    const store = seeded();
    expect(store.fill("{{deploy box.user}}@host")).toBe("root@host");
    expect(store.fill("{{deploy box.username}}@host")).toBe("root@host");
  });

  test("a handle ruri does not know is left exactly as written", () => {
    expect(seeded().fill("{{unknown}} and {{deploy box}}")).toBe("{{unknown}} and hunter2hunter2");
  });

  test("text with no handle in it comes straight back", () => {
    const text = "nothing to see";
    expect(seeded().fill(text)).toBe(text);
    expect(seeded().wanted(text)).toBe(false);
    expect(seeded().wanted("{{x}}")).toBe(true);
    // an empty vault has nothing to fill, whatever the text holds
    process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-secrets-empty-"));
    expect(new SecretStore().wanted("{{x}}")).toBe(false);
  });

  test("fillInput reaches into arrays and objects", () => {
    const filled = seeded().fillInput({
      command: "echo {{deploy box}}",
      args: ["{{deploy box.user}}", 3],
      nested: { ok: true },
    });
    expect(filled).toEqual({ command: "echo hunter2hunter2", args: ["root", 3], nested: { ok: true } });
  });
});

describe("redact", () => {
  test("puts the handle back wherever the value shows", () => {
    expect(seeded().redact("password: hunter2hunter2 (hunter2hunter2)")).toBe(
      "password: {{deploy box}} ({{deploy box}})",
    );
  });

  test("a value under six characters is never redacted: it would match half the log", () => {
    const store = seeded();
    store.upsert({ name: "pin", secret: "1234" });
    expect(store.redact("pin 1234 on line 1234")).toBe("pin 1234 on line 1234");
    store.upsert({ name: "six", secret: "abcdef" });
    expect(store.redact("abcdef")).toBe("{{six}}");
  });

  test("empty text stays empty, and redactInput walks a structure", () => {
    const store = seeded();
    expect(store.redact("")).toBe("");
    expect(store.redactInput({ cmd: "hunter2hunter2", list: ["x", "hunter2hunter2"] })).toEqual({
      cmd: "{{deploy box}}",
      list: ["x", "{{deploy box}}"],
    });
  });
});

describe("upsert", () => {
  test("the same name, case aside, edits rather than adds", () => {
    const store = seeded();
    store.upsert({ name: "Deploy Box", note: "renamed note" });
    expect(store.names()).toEqual(["Deploy Box"]);
    expect(store.meta()[0]).toMatchObject({ note: "renamed note", hasValue: true });
    // no secret given: the value is kept
    expect(store.fill("{{deploy box}}")).toBe("hunter2hunter2");
  });

  test("an empty secret keeps the old value; a new one replaces it", () => {
    const store = seeded();
    store.upsert({ name: "deploy box", secret: "" });
    expect(store.fill("{{deploy box}}")).toBe("hunter2hunter2");
    store.upsert({ name: "deploy box", secret: "newpassword" });
    expect(store.fill("{{deploy box}}")).toBe("newpassword");
  });

  test("by id, a rename is a rename", () => {
    const store = seeded();
    const id = store.meta()[0]!.id;
    store.upsert({ id, name: "staging box", username: "" });
    expect(store.names()).toEqual(["staging box"]);
    expect(store.meta()[0]).not.toHaveProperty("username");
  });

  test("a blank name is ignored", () => {
    const store = seeded();
    store.upsert({ name: "   ", secret: "abcdefgh" });
    expect(store.names()).toEqual(["deploy box"]);
  });

  test("remove takes one out", () => {
    const store = seeded();
    store.upsert({ name: "other", secret: "abcdefgh" });
    store.remove(store.meta()[0]!.id);
    expect(store.names()).toEqual(["other"]);
  });
});

describe("on disk", () => {
  test("survives a reload, owner-only", () => {
    seeded();
    const again = new SecretStore();
    expect(again.names()).toEqual(["deploy box"]);
    expect(again.fill("{{deploy box}}")).toBe("hunter2hunter2");
    expect(fs.statSync(path.join(dir, "secrets.json")).mode & 0o777).toBe(0o600);
  });

  test("a broken file is an empty vault, not a crash", () => {
    fs.writeFileSync(path.join(dir, "secrets.json"), "{ not json");
    expect(new SecretStore().names()).toEqual([]);
  });
});

describe("briefing", () => {
  test("names and accounts, never values", () => {
    const text = seeded().briefing();
    expect(text).toContain("{{deploy box}}");
    expect(text).toContain("$RURI_SECRET_DEPLOY_BOX");
    expect(text).toContain('account "root" (also {{deploy box.user}})');
    expect(text).toContain("the prod box");
    expect(text).not.toContain("hunter2hunter2");
  });

  test("a harness without a hook is told to use the environment", () => {
    const text = seeded().briefing(false);
    expect(text).toContain("$RURI_SECRET_DEPLOY_BOX");
    expect(text).toContain("cannot substitute {{handles}}");
    expect(text).not.toContain("- {{deploy box}}");
  });

  test("nothing in the vault, nothing to say", () => {
    expect(new SecretStore().briefing()).toBe("");
  });
});
