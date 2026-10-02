/**
 * Bundle the app's two processes into an ESM file each: the Electron main
 * process (desktop/main.ts → main.mjs — the window, the bridge, the shell's
 * services) and the server it forks into a process of its own
 * (server/desktopServer.ts → server.mjs — the server, yagami and the Agent
 * SDK; desktop/serverProcess.ts says why it is apart). Bundling everything
 * means the packaged app ships no node_modules at all — the only external
 * runtime is Electron itself, and the Claude engine is the user's own
 * installed `claude` CLI, which yagami resolves at runtime.
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
  entryPoints: { main: "desktop/main.ts", server: "server/desktopServer.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir: "dist-electron",
  outExtension: { ".js": ".mjs" },
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

/**
 * The window's preload (desktop/preload.ts): CommonJS, on its own — a
 * sandboxed preload is a script, not a module, and gets `require("electron")`
 * and nothing more.
 */
await build({
  entryPoints: { preload: "desktop/preload.ts" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  minify: true,
  legalComments: "none",
  logLevel: "info",
});

/**
 * Nothing but ASCII in what was written. V8 keeps a script's source for as
 * long as the script lives, at a byte a character only if every character
 * is ASCII: a "—" in one regular expression kept the whole server bundle at
 * two bytes each, 2.3 MB more of the server's heap. esbuild escapes what is
 * in strings but leaves regular expressions as they were written; there,
 * as in a string, \uXXXX is the same character. Where one follows a
 * backslash, or a file uses String.raw (whose text an escape would change),
 * the build stops rather than guess.
 */
for (const file of ["dist-electron/main.mjs", "dist-electron/server.mjs", "dist-electron/preload.cjs"]) {
  const text = fs.readFileSync(file, "utf8");
  if (!/[\u0080-\uffff]/.test(text)) continue;
  if (text.includes("String.raw"))
    throw new Error(`${file} has non-ASCII text and String.raw: escape it in the source`);
  const ascii = text.replace(/[\u0080-\uffff]/g, (char, at: number) => {
    let slashes = 0;
    while (text[at - 1 - slashes] === "\\") slashes += 1;
    if (slashes % 2 === 1)
      throw new Error(`${file}: an escaped non-ASCII character at ${at}: escape it in the source`);
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  fs.writeFileSync(file, ascii);
}
