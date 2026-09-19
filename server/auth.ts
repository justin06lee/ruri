/**
 * Who may talk to the server: a page from its own origin (or no browser at
 * all), carrying the token. The HTTP routes (server/routes.ts) and the
 * socket's upgrade (server/socket.ts) both ask here.
 */
import { timingSafeEqual } from "node:crypto";
import type * as http from "node:http";

/** The dev page's origins: vite serves the UI on :5173 and talks to the
 *  standalone server across origins. Honoured only when there is no built
 *  UI to serve — the packaged app never hears from them. */
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * Whether a request may come from where it says it comes from. No Origin
 * at all is a non-browser client (a script, curl, a harness's bridge call)
 * and passes; a browser's Origin must be this server's own page — or, in
 * dev, vite's. Anything else is some other site's page on the same
 * machine, and gets nothing.
 */
export function originAllowed(origin: string | undefined, port: number, dev: boolean): boolean {
  if (origin === undefined) return true;
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return own.includes(origin) || (dev && DEV_ORIGINS.includes(origin));
}

/** The token a request carries — the header first, the query second. */
export function presentedToken(req: http.IncomingMessage): string {
  const header = req.headers["x-ruri-token"];
  if (typeof header === "string") return header;
  return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
}

/** Compared in constant time: a wrong token takes as long as a right one. */
export function tokenMatches(presented: string, token: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
