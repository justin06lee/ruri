/**
 * Bundle the Electron main process (desktop/main.ts + server + yagami + Agent
 * SDK) into a single ESM file. Bundling everything means the packaged app
 * ships no node_modules at all — the only external runtime is Electron itself,
 * and the Claude engine is the user's own installed `claude` CLI, which yagami
 * resolves at runtime.
 */
import { build } from "esbuild";

const banner = {
  js: 'import { createRequire as __ruriCreateRequire } from "node:module"; const require = __ruriCreateRequire(import.meta.url);',
};

// the shell: the window and everything that needs one
await build({
  entryPoints: ["desktop/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-electron/main.mjs",
  external: ["electron"],
  banner,
  logLevel: "info",
});

// the server: spawned detached by the shell, run as plain node under the
// same Electron binary (ELECTRON_RUN_AS_NODE) — no electron import in it
await build({
  entryPoints: ["desktop/server-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist-electron/server.mjs",
  banner,
  logLevel: "info",
});
