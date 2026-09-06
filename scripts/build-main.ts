/**
 * Bundle the Electron main process (desktop/main.ts + server + yagami + Agent
 * SDK) into a single ESM file. Bundling everything means the packaged app
 * ships no node_modules at all — the only external runtime is Electron itself,
 * and the Claude engine is the user's own installed `claude` CLI, which yagami
 * resolves at runtime.
 */
import { build } from "esbuild";

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
