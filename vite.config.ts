import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The two endpoints below write files — src/peek.ts and PNGs under
 * web/public — on a plain POST to :5173, so a page on any other origin
 * open in the same browser could post to them. A request is taken only
 * from the dev server's own page: its Origin (or, for the odd client that
 * sends none, its Referer) must be the dev server itself.
 */
const DEV_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
function fromDevPage(req: import("node:http").IncomingMessage): boolean {
  const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
  return origin !== undefined && DEV_ORIGINS.has(origin);
}

/**
 * The art tuner's save button (`make tuner` → /tuner.html) posts here, and
 * this rewrites the two lists in src/peek.ts — the file the app reads. Dev
 * server only: the tuner page and this endpoint never enter a build.
 */
function tunerSave(): Plugin {
  const file = path.join(import.meta.dirname, "web", "src", "peek.ts");
  const num = (value: unknown, fallback = 0) => (typeof value === "number" ? Math.round(value) : fallback);
  /** Framing is finer than whole pixels — keep a decimal, but only one. */
  const fine = (value: unknown, places: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Number(value.toFixed(places))
      : fallback;
  return {
    name: "ruri-tuner-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__tuner/save", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (!fromDevPage(req)) {
          res.statusCode = 403;
          res.end("not from the dev page");
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const { peeks, frames } = JSON.parse(body) as {
              peeks: Array<Record<string, number>>;
              frames: Record<string, { x: number; y: number; zoom: number }>;
            };
            const peekLines = peeks
              .map(
                (p) =>
                  `  { n: ${num(p["n"])}, x: ${num(p["x"])}, w: ${num(p["w"])}, ` +
                  `drop: ${num(p["drop"])}, lift: ${num(p["lift"])} },`,
              )
              .join("\n");
            // a face left centred at its fitted size says nothing worth storing
            const frameLines = Object.entries(frames)
              .filter(([, f]) => f.x !== 0 || f.y !== 0 || f.zoom !== 1)
              .sort((a, b) => Number(a[0]) - Number(b[0]))
              .map(
                ([n, f]) =>
                  `  ${n}: { x: ${fine(f.x, 1, 0)}, y: ${fine(f.y, 1, 0)}, ` +
                  `zoom: ${fine(f.zoom, 2, 1)} },`,
              )
              .join("\n");

            const source = fs.readFileSync(file, "utf8");
            const next = source
              .replace(/export const PEEKS: Peek\[\] = \[[\s\S]*?\n\];/, `export const PEEKS: Peek[] = [\n${peekLines}\n];`)
              .replace(
                /export const HERO_FRAMES: Record<number, HeroFrame> = \{[\s\S]*?\n?\};/,
                frameLines
                  ? `export const HERO_FRAMES: Record<number, HeroFrame> = {\n${frameLines}\n};`
                  : "export const HERO_FRAMES: Record<number, HeroFrame> = {};",
              );
            fs.writeFileSync(file, next);
            res.statusCode = 200;
            res.end("ok");
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

/**
 * The tuner's other half: what the art *is*, not just where it sits. It lists
 * the files behind the heads and the faces (size, dimensions, when they last
 * changed), and takes a dropped PNG straight into web/public — so replacing
 * a head is dropping it on the head, not finding the folder.
 */
function tunerImages(): Plugin {
  const publicDir = path.join(import.meta.dirname, "web", "public");
  /** Where the raw pages live — RURI_ART overrides. */
  const SOURCE_DIR = process.env["RURI_ART"] ?? path.join(os.homedir(), "Pictures");
  const target = (kind: string, n: number): string | null => {
    if (!Number.isInteger(n) || n < 1 || n > 99) return null;
    if (kind === "peek") return path.join(publicDir, "peek", `u${n}.png`);
    if (kind === "hero") return path.join(publicDir, "hero", `v${n}.png`);
    return null;
  };
  return {
    name: "ruri-tuner-images",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__tuner/files", (_req, res) => {
        const list = (dir: string, prefix: string) => {
          try {
            return fs
              .readdirSync(path.join(publicDir, dir))
              .filter((name) => name.startsWith(prefix) && name.endsWith(".png"))
              .map((name) => {
                const stat = fs.statSync(path.join(publicDir, dir, name));
                return { name, bytes: stat.size, changed: stat.mtimeMs };
              });
          } catch {
            return [];
          }
        };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ peek: list("peek", "u"), hero: list("hero", "v") }));
      });

      // the raw pages the heads are cut from, wherever the user keeps them
      server.middlewares.use("/__tuner/source", (req, res) => {
        const file = path.join(SOURCE_DIR, path.basename(req.url ?? "").replace(/\?.*$/, ""));
        if (!file.startsWith(SOURCE_DIR) || !file.endsWith(".png") || !fs.existsSync(file)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", "image/png");
        res.end(fs.readFileSync(file));
      });

      server.middlewares.use("/__tuner/sources", (_req, res) => {
        let names: string[] = [];
        try {
          names = fs
            .readdirSync(SOURCE_DIR)
            .filter((name) => /^ruri\d+\.png$/.test(name))
            .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
        } catch {
          names = [];
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ dir: SOURCE_DIR, names }));
      });

      server.middlewares.use("/__tuner/image", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        if (!fromDevPage(req)) {
          res.statusCode = 403;
          res.end("not from the dev page");
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const { kind, n, data } = JSON.parse(body) as { kind: string; n: number; data: string };
            const file = target(kind, n);
            if (!file) throw new Error("not a slot this tool writes");
            const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
            if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("PNG only");
            fs.writeFileSync(file, bytes);
            res.statusCode = 200;
            res.end("ok");
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

/**
 * The dev page's way in. The ruri server refuses a socket without its token
 * (server/server.ts); the desktop app puts it on the window's URL, but the
 * vite page has no such URL. So vite hands over the token the server wrote
 * to <configDir>/token — to its own page only: a request carrying another
 * site's Origin gets nothing, and there are no CORS headers to read it with.
 */
function devToken(): Plugin {
  const file = path.join(process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"), "token");
  return {
    name: "ruri-dev-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__token", (req, res) => {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http://${req.headers.host}`) {
          res.statusCode = 403;
          res.end();
          return;
        }
        let token: string;
        try {
          token = fs.readFileSync(file, "utf8").trim();
        } catch {
          // no server running yet — the page asks again when it retries
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", "text/plain");
        res.setHeader("cache-control", "no-store");
        res.end(token);
      });
    },
  };
}

/**
 * A Content-Security-Policy for the built app, as a meta tag. The page is
 * served by ruri's own server on 127.0.0.1, so everything it loads is its
 * own origin: scripts only from there (the built HTML has no inline
 * script), styles from there plus inline (React style props, xterm), and
 * images, media and the attachment viewer's frame from there or from blob
 * and data URLs the page made itself. A reply's markdown can therefore not
 * pull a script, a frame or a tracking pixel from anywhere else. Build only:
 * the dev page needs Vite's inline preamble and its own HMR socket.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "ruri-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig({
  root: "web",
  plugins: [react(), tunerSave(), tunerImages(), devToken(), contentSecurityPolicy()],
  // which port the standalone server is on, for the dev page (store.ts)
  define: { "import.meta.env.RURI_PORT": JSON.stringify(process.env["RURI_PORT"] ?? "7777") },
  server: {
    port: 5173,
  },
  // no license banners in the bundle — the notices ship in node_modules
  esbuild: { legalComments: "none" },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    // The built page only ever runs inside this app's own Electron, so it
    // is compiled for that Chromium and nothing older: no down-levelling,
    // no helpers for syntax the engine already has.
    target: "chrome140",
    // gzip figures for a bundle nobody serves over a network
    reportCompressedSize: false,
    // the tuner is a dev tool; only the app itself is built
    rollupOptions: { input: "web/index.html" },
  },
});
