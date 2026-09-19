/**
 * Bundle the Electron main process (desktop/main.ts + server + yagami + Agent
 * SDK) into a single ESM file. Bundling everything means the packaged app
 * ships no node_modules at all — the only external runtime is Electron itself,
 * and the Claude engine is the user's own installed `claude` CLI, which yagami
 * resolves at runtime.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "esbuild";

/**
 * Emptied first, because electron-builder packages `dist-electron/**` whole
 * (see the "files" field): anything left here from an older build ships in
 * the app whether or not the source still has a use for it. That is how the
 * entry point of a reverted feature stayed in the bundle after the revert —
 * esbuild only overwrites what it writes, and never had reason to mention
 * the file it no longer produced.
 */
fs.rmSync("dist-electron", { recursive: true, force: true });

/**
 * One copy of each shared dependency, not two.
 *
 * yagami comes from the registry now, but when it was linked in from a
 * sibling checkout (`file:../yagami`, still the way to work on both at
 * once — see docs/harness-integration.md) it resolved its own imports from
 * its own node_modules, so the Agent SDK and zod were bundled twice at
 * slightly different versions: 2.7 MB of a 4.9 MB bundle doing the same
 * job, loaded and initialised twice at launch. Every import of these
 * packages, wherever it comes from, lands on the copies this repo installs
 * (a superset of what yagami uses) — and a nested copy under
 * node_modules/@justin06lee/yagami/node_modules is never bundled twice.
 */
const shared = ["@anthropic-ai/claude-agent-sdk", "zod", "@agentclientprotocol/sdk", "ws"];
const alias = Object.fromEntries(
  shared
    .filter((name) => fs.existsSync(path.join("node_modules", name)))
    .map((name) => [name, path.resolve("node_modules", name)]),
);

await build({
  entryPoints: ["desktop/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-electron/main.mjs",
  external: ["electron"],
  alias,
  // half the bytes for the same program — this is a build artifact, and the
  // parser has less to read at every launch
  minify: true,
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __ruriCreateRequire } from "node:module"; const require = __ruriCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});
