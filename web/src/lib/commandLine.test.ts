import { describe, expect, test } from "bun:test";
import { splitCommand } from "./commandLine";

describe("a command line as words", () => {
  test("spaces split, quotes and backslashes keep them", () => {
    expect(splitCommand("npx -y @sentry/mcp-server")).toEqual(["npx", "-y", "@sentry/mcp-server"]);
    expect(splitCommand(`node "/Applications/My App/server.js" --port 3000`)).toEqual([
      "node",
      "/Applications/My App/server.js",
      "--port",
      "3000",
    ]);
    expect(splitCommand("run 'a b' c\\ d")).toEqual(["run", "a b", "c d"]);
    expect(splitCommand(`say "" twice`)).toEqual(["say", "", "twice"]);
    expect(splitCommand("  padded   out  ")).toEqual(["padded", "out"]);
  });
});
