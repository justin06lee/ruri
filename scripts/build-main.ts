/**
 * Bundle the Electron main process (desktop/main.ts + server + yagami + Agent
 * SDK) into a single ESM file. Bundling everything means the packaged app
 * ships no node_modules at all — the only external runtime is Electron itself,
 * and the Claude engine is the user's own installed `claude` CLI, which yagami
 * resolves at runtime.
 */
import * as fs from "node:fs";
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

await build({
  entryPoints: ["desktop/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-electron/main.mjs",
  external: ["electron"],
  banner: {
    js: 'import { createRequire as __ruriCreateRequire } from "node:module"; const require = __ruriCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});
