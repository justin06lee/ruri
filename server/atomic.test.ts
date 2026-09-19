import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonAtomic, writeTextAtomic, writeTextAtomicAsync } from "./atomic.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-atomic-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Temp files left lying around in the directory. */
const leftovers = () => fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

describe("writeTextAtomic", () => {
  test("writes the text and leaves no temp file behind", () => {
    const file = path.join(dir, "a.txt");
    writeTextAtomic(file, "hello");
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    expect(leftovers()).toEqual([]);
  });

  test("creates the directories on the way", () => {
    const file = path.join(dir, "deep", "er", "a.txt");
    writeTextAtomic(file, "x");
    expect(fs.readFileSync(file, "utf8")).toBe("x");
  });

  test("replaces an existing file whole", () => {
    const file = path.join(dir, "a.txt");
    writeTextAtomic(file, "a much longer first version");
    writeTextAtomic(file, "short");
    expect(fs.readFileSync(file, "utf8")).toBe("short");
  });

  test("the mode lands on the file, and again on every rewrite", () => {
    const file = path.join(dir, "secret.json");
    writeTextAtomic(file, "1", 0o644);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    // a rename brings a fresh temp file each time, so the mode is not
    // something only the first write decides
    writeTextAtomic(file, "2", 0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("2");
  });

  test("a failed rename leaves neither a half file nor a temp file", () => {
    // a non-empty directory where the file should go: the rename cannot
    // land, and the bytes already written must not be left beside it
    const file = path.join(dir, "taken");
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(file, "inside"), "");
    expect(() => writeTextAtomic(file, "text")).toThrow();
    expect(fs.statSync(file).isDirectory()).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});

describe("writeJsonAtomic", () => {
  test("writes JSON with the spacing asked for", () => {
    const file = path.join(dir, "v.json");
    writeJsonAtomic(file, { a: 1, b: [1, 2] }, 2);
    const text = fs.readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ a: 1, b: [1, 2] });
    expect(text).toContain("\n  ");
  });

  test("passes the mode through", () => {
    const file = path.join(dir, "v.json");
    writeJsonAtomic(file, {}, undefined, 0o600);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("writeTextAtomicAsync", () => {
  test("writes when the write is still the newest", async () => {
    const file = path.join(dir, "a.txt");
    await writeTextAtomicAsync(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(leftovers()).toEqual([]);
  });

  test("a write that went stale is thrown away, file and temp both", async () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "old");
    await writeTextAtomicAsync(file, "new", () => true);
    expect(fs.readFileSync(file, "utf8")).toBe("old");
    expect(leftovers()).toEqual([]);
  });
});
