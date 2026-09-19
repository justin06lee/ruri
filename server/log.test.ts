import { describe, expect, test } from "bun:test";
import { errorCode, errorMessage, isMissing, warn } from "./log.js";

/** An errno-style error, the way node's fs throws them. */
function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: no such thing`);
  err.code = code;
  return err;
}

describe("errorMessage", () => {
  test("an Error's message, anything else stringified", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("errorCode", () => {
  test("reads the errno code off the error", () => {
    expect(errorCode(errno("ENOENT"))).toBe("ENOENT");
  });

  test("follows the cause chain, the way fetch wraps a socket error", () => {
    const wrapped = new Error("fetch failed", { cause: errno("ECONNREFUSED") });
    expect(errorCode(wrapped)).toBe("ECONNREFUSED");
    const twice = new Error("outer", { cause: wrapped });
    expect(errorCode(twice)).toBe("ECONNREFUSED");
  });

  test("nothing for an error without one, or for a non-error", () => {
    expect(errorCode(new Error("plain"))).toBeUndefined();
    expect(errorCode("ENOENT")).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    // a code that is not a string is not a code
    const odd = new Error("odd") as Error & { code: number };
    odd.code = 2;
    expect(errorCode(odd)).toBeUndefined();
  });
});

describe("isMissing", () => {
  test("only ENOENT is the file not being there", () => {
    expect(isMissing(errno("ENOENT"))).toBe(true);
    expect(isMissing(new Error("x", { cause: errno("ENOENT") }))).toBe(true);
    expect(isMissing(errno("EACCES"))).toBe(false);
    expect(isMissing(new Error("ENOENT in the message only"))).toBe(false);
    expect(isMissing("ENOENT")).toBe(false);
  });
});

describe("warn", () => {
  /** Run `fn` with stderr captured; returns what was written. */
  function captured(fn: () => void): string[] {
    const lines: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      fn();
    } finally {
      process.stderr.write = original;
    }
    return lines;
  }

  test("one line: stamp, scope, what was tried, what went wrong", () => {
    const lines = captured(() => warn("ledger", new Error("disk full"), "save"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ruri ledger: save: disk full\n$/);
  });

  test("without a note, the scope and the message alone", () => {
    const lines = captured(() => warn("secrets", "denied"));
    expect(lines[0]).toMatch(/ ruri secrets: denied\n$/);
    expect(lines[0]).not.toContain(": :");
  });
});
