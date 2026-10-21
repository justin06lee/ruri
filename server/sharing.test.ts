import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import type { StatusReport } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { createRequestHandler } from "./routes.js";
import { Sharing, type Pairing } from "./sharing.js";
import { createSocketServer } from "./socket.js";

const TOKEN = "local-token";

let dir = "";
let before: string | undefined;
let sharing: Sharing;
let ctx: ServerContext;
let full: Pairing;
let phone: Pairing;

beforeAll(async () => {
  before = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-sharing-test-"));
  process.env["RURI_CONFIG_DIR"] = dir;
  sharing = new Sharing();
  // no projects: the status is only asked whether it answers
  ctx = {
    options: { token: TOKEN },
    listeningPort: 0,
    sharing,
    store: { list: () => [] },
  } as unknown as ServerContext;
  const serve = createRequestHandler(ctx);
  sharing.start({
    serve: (req, res) => serve(req, res, true),
    sockets: (server) =>
      createSocketServer(ctx, server, {
        refusal: (origin, req) => sharing.refusal(origin, req),
        seat: (req) => sharing.deviceFor(req),
        compress: true,
      }),
    closeDevice: () => {},
    changed: () => {},
  });
  full = await sharing.pairDirect("laptop");
  phone = await sharing.pairDirect("Justin's iPhone", "status");
});

afterAll(async () => {
  await sharing.close();
  if (before === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = before;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A request through the door, with a device's key; for a stream, its
 *  first chunk. */
function ask(
  pathname: string,
  key: string | undefined,
  method = "GET",
): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: phone.port,
        path: pathname,
        method,
        rejectUnauthorized: false,
        // a connection of its own: one a stream or a refused upgrade ended
        // is not handed to the next request
        agent: false,
        headers: key ? { "x-ruri-token": key } : {},
      },
      (res) => {
        res.once("data", (chunk: Buffer) => {
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            body: chunk.toString("utf8"),
          });
          res.destroy();
        });
        res.once("end", () =>
          resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: "" }),
        );
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

/** What a socket upgrade at the door is answered with: 101 when it opens. */
function upgrade(key: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1",
      port: phone.port,
      path: `/?token=${encodeURIComponent(key)}`,
      rejectUnauthorized: false,
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A request as the door's checks see it. */
const showing = (key: string) => ({ headers: { "x-ruri-token": key }, url: "/" }) as unknown as http.IncomingMessage;

describe("a key scoped to the status", () => {
  test("reads GET /status and the live stream", async () => {
    const once = await ask("/status", phone.key);
    expect(once.status).toBe(200);
    expect(once.type).toContain("application/json");
    const report = JSON.parse(once.body) as StatusReport;
    expect(report.projects).toEqual([]);
    const live = await ask("/status/live", phone.key);
    expect(live.status).toBe(200);
    expect(live.type).toContain("text/event-stream");
    expect(live.body.startsWith("event: status\ndata: ")).toBe(true);
  });

  test("is refused everywhere else with a 403 that says why — the socket too", async () => {
    for (const [pathname, method] of [
      ["/", "GET"],
      ["/healthz", "GET"],
      ["/uploads/a.png", "GET"],
      ["/readfile?path=/etc/hosts", "GET"],
      ["/music/playlists", "GET"],
      ["/status/other", "GET"],
      ["/talk/some-chat", "POST"],
      ["/bridge/some-chat", "POST"],
      ["/library/some-chat", "POST"],
      ["/sharing/invite", "POST"],
    ] as const) {
      const answer = await ask(pathname, phone.key, method);
      expect([pathname, answer.status]).toEqual([pathname, 403]);
      expect(answer.body).toContain("status only");
    }
    expect(await upgrade(phone.key)).toBe(403);
    expect(sharing.refusal(undefined, showing(phone.key))).toBe(403);
  });

  test("is told apart in Settings → Devices, and kept as a hash with its scope", () => {
    const devices = sharing.info().devices;
    expect(devices.find((d) => d.id === phone.deviceId)?.scope).toBe("status");
    expect(devices.find((d) => d.id === full.deviceId)?.scope).toBeUndefined();
    const kept = fs.readFileSync(path.join(dir, "sharing.json"), "utf8");
    expect(kept).not.toContain(phone.key);
    // read again, as the next launch would: still scoped
    expect(new Sharing().deviceFor(showing(phone.key))?.scope).toBe("status");
  });
});

describe("a full key", () => {
  test("reaches everything, as before", async () => {
    expect((await ask("/healthz", full.key)).status).toBe(200);
    expect((await ask("/status", full.key)).status).toBe(200);
    expect(sharing.refusal(undefined, showing(full.key))).toBe(0);
    expect(sharing.deviceFor(showing(full.key))?.scope).toBeUndefined();
  });

  test("no key gets nothing", async () => {
    expect((await ask("/status", undefined)).status).toBe(401);
    expect((await ask("/status", "not-a-key")).status).toBe(401);
    expect(await upgrade("not-a-key")).toBe(401);
  });
});

describe("making a phone's key", () => {
  test("on this computer's own port, with the token: scoped, or refused for a scope ruri doesn't know", async () => {
    const handle = createRequestHandler(ctx);
    const server = http.createServer((req, res) => handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const post = (body: unknown, token = TOKEN) =>
      fetch(`${base}/sharing/pair-local`, {
        method: "POST",
        headers: { "x-ruri-token": token },
        body: JSON.stringify(body),
      });
    try {
      expect((await post({ name: "phone", scope: "status" }, "wrong")).status).toBe(401);
      expect((await post({ name: "phone", scope: "everything" })).status).toBe(400);
      const made = (await (await post({ name: "Second phone", scope: "status" })).json()) as Pairing;
      expect(made.ok).toBe(true);
      expect(made.fingerprint).toBeTruthy();
      expect(sharing.deviceFor(showing(made.key))?.scope).toBe("status");
      expect((await ask("/healthz", made.key)).status).toBe(403);
    } finally {
      server.close();
    }
  });
});

describe("unpairing", () => {
  test("a scoped key, or a full one, stops working", async () => {
    sharing.forget(phone.deviceId);
    expect((await ask("/status", phone.key)).status).toBe(401);
    expect(await upgrade(phone.key)).toBe(401);
    sharing.forget(full.deviceId);
    expect((await ask("/healthz", full.key)).status).toBe(401);
  });
});
