import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readIntegrations } from "./integrations.js";

/** A CLI that answers each listing with what the fixture says — and
 *  anything else with a failure, so a test that changes something fails. */
function fakeCli(bin: string, name: string, answers: Record<string, unknown>): void {
  const cases = Object.entries(answers)
    .map(([args, out]) => `  "${args}") cat <<'JSON'\n${JSON.stringify(out)}\nJSON\n  ;;`)
    .join("\n");
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ncase "$*" in\n${cases}\n  *) exit 1 ;;\nesac\n`, {
    mode: 0o755,
  });
}

describe("what the harnesses plug in", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-int-"));
  const project = path.join(root, "project");
  const saved = { path: process.env["PATH"], claude: process.env["CLAUDE_CONFIG_DIR"] };

  beforeAll(() => {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.mkdirSync(project);
    fakeCli(bin, "claude", {
      "plugin list --json": [
        {
          id: "stripe@claude-plugins-official",
          version: "0.9.2",
          scope: "user",
          enabled: true,
          mcpServers: { stripe: { type: "http", url: "https://mcp.stripe.com" } },
        },
      ],
      "plugin marketplace list --json": [
        { name: "claude-plugins-official", repo: "anthropics/claude-plugins-official" },
      ],
    });
    fakeCli(bin, "codex", {
      "mcp list --json": [
        {
          name: "motion",
          enabled: false,
          transport: {
            type: "stdio",
            command: "npx",
            args: ["-y", "motion mcp"],
            env: { TOKEN: "codex-secret" },
          },
        },
      ],
      "plugin list --json": { installed: [] },
      "plugin marketplace list --json": { marketplaces: [] },
    });
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
    process.env["CLAUDE_CONFIG_DIR"] = root;
    fs.writeFileSync(
      path.join(root, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          agent28: { command: "/Applications/Agent28.app/agent28", env: { KEY: "user-secret" } },
        },
        // Claude files a project under its real path
        projects: {
          [fs.realpathSync(project)]: {
            mcpServers: {
              mine: {
                type: "http",
                url: "https://x.dev/mcp",
                headers: { Authorization: "Bearer local-secret" },
              },
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "node", args: ["server.js"] } } }),
    );
  });

  afterAll(() => {
    process.env["PATH"] = saved.path;
    if (saved.claude === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
    else process.env["CLAUDE_CONFIG_DIR"] = saved.claude;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("every server, from every place it is kept — with a project's own", async () => {
    const found = await readIntegrations(project);
    expect(found.errors).toEqual([]);
    const rows = found.servers.map((s) => `${s.harness}/${s.scope}/${s.name}${s.enabled ? "" : " (off)"}`);
    expect(rows.sort()).toEqual(
      [
        "claude/user/agent28",
        "claude/local/mine",
        "claude/project/shared",
        "claude/plugin/stripe",
        "codex/codex/motion (off)",
      ].sort(),
    );
    expect(found.servers.find((s) => s.name === "motion")?.target).toBe('npx -y "motion mcp"');
    expect(found.plugins.map((p) => p.id)).toEqual(["stripe@claude-plugins-official"]);
    expect(found.marketplaces.map((m) => m.source)).toEqual(["anthropics/claude-plugins-official"]);
  });

  test("what a server is given travels by name, never by value", async () => {
    const found = await readIntegrations(project);
    const sent = JSON.stringify(found);
    for (const secret of ["user-secret", "local-secret", "codex-secret"]) expect(sent).not.toContain(secret);
    expect(found.servers.find((s) => s.name === "agent28")?.env).toEqual(["KEY"]);
    expect(found.servers.find((s) => s.name === "mine")?.headers).toEqual(["Authorization"]);
  });

  test("without a project, only what applies everywhere", async () => {
    const found = await readIntegrations();
    expect(found.servers.some((s) => s.scope === "local" || s.scope === "project")).toBe(false);
  });
});
