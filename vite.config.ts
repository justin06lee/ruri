import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The dev page's way in. The ruri server refuses a socket without its token
 * (server/server.ts); the desktop app puts it on the window's URL, but the
 * vite page has no such URL. So vite hands over the token the server wrote
 * to <configDir>/token — to its own page only: a request carrying another
 * site's Origin gets nothing, and there are no CORS headers to read it with.
 */
function devToken(): Plugin {
  const file = path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "token",
  );
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
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: policy },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig({
  root: "web",
  plugins: [
    // The React Compiler: it works out for itself which values a component
    // recomputes needlessly and memoises them, everywhere, rather than
    // where somebody remembered to write useMemo. ChatPane has eighteen of
    // those by hand; the composer, the sidebar and the boards have almost
    // none, and they re-render on every event of every session.
    react({ babel: { plugins: [["babel-plugin-react-compiler", { target: "19" }]] } }),
    devToken(),
    contentSecurityPolicy(),
  ],
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
  },
});
