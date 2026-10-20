/**
 * The default hook against midna's own CLI, as installed: `midna event`
 * run the way ruri runs it, pointed by MIDNA_URL and MIDNA_TOKEN at a
 * stand-in for midna's POST /v1/inbound — so nothing reaches a real midna.
 * Skipped where midna 0.7 or later isn't installed (CI).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectEventPayload } from "../shared/protocol.js";
import { HookCenter, realIo } from "./projectHooks.js";

const MIDNA = process.env["RURI_MIDNA_CLI"] ?? path.join(os.homedir(), ".local", "bin", "midna");

function hasEvent(): boolean {
  try {
    const help = execFileSync(MIDNA, ["event", "--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return help.includes("--source");
  } catch (err) {
    // the usage line comes on a non-zero exit too
    const out =
      String((err as { stdout?: string; stderr?: string }).stdout ?? "") +
      String((err as { stderr?: string }).stderr ?? "");
    return out.includes("midna event --source");
  }
}

const here = fs.existsSync(MIDNA) && hasEvent();

describe.skipIf(!here)("midna's CLI, as the default hook runs it", () => {
  let server: http.Server;
  let base: string;
  let answer: { status: number; body: unknown } = { status: 202, body: {} };
  const got: Array<{ url: string; auth?: string; body: Record<string, unknown> }> = [];
  let dir: string;
  const saved = { url: process.env["MIDNA_URL"], token: process.env["MIDNA_TOKEN"] };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        got.push({
          url: req.url ?? "",
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          body: JSON.parse(body || "{}") as Record<string, unknown>,
        });
        res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env["MIDNA_URL"] = base;
    process.env["MIDNA_TOKEN"] = "stand-in-token";
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
    for (const [key, value] of [
      ["MIDNA_URL", saved.url],
      ["MIDNA_TOKEN", saved.token],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-midna-"));
    got.length = 0;
  });

  const payload: ProjectEventPayload = {
    id: "8b0c8c39-4a6f-4c4f-9a59-0c1e2d3f4a5b",
    source: "ruri",
    kind: "project.idle",
    project: { id: "p-umi", name: "umi", path: "/work/umi" },
    chats: [{ id: "c1", name: "Lead", role: "lead", lastSummary: "Shipped the onboarding flow" }],
    costUsd: 3.5,
    at: "2026-10-19T22:00:00.000Z",
  };

  /** One event through midna's default hook, waited on to its end. */
  async function send(): Promise<ReturnType<HookCenter["view"]>["deliveries"][number]> {
    const center = new HookCenter(
      { ...realIo, findMidna: () => MIDNA, later: () => ({ cancel() {} }) },
      () => {},
      {
        config: path.join(dir, "hooks.json"),
        log: path.join(dir, "log.json"),
      },
    );
    center.deliver(payload, center.targets(), dir);
    for (let i = 0; i < 500 && center.view().deliveries[0]?.state === "pending"; i++) await Bun.sleep(20);
    const delivery = center.view().deliveries[0]!;
    center.close();
    return delivery;
  }

  test("it POSTs /v1/inbound with the device's bearer: source, title, and the event as data — its id for dedup", async () => {
    answer = { status: 202, body: { status: "queued", eventId: 7, wakeupId: 31, dueAt: 1792447200000 } };
    const delivery = await send();
    expect(delivery).toMatchObject({ state: "ok", attempts: 1, result: "exit 0 · queued, event 7" });
    expect(got).toHaveLength(1);
    expect(got[0]?.url).toBe("/v1/inbound");
    expect(got[0]?.auth).toBe("Bearer stand-in-token");
    expect(got[0]?.body["source"]).toBe("ruri");
    expect(got[0]?.body["title"]).toBe("umi is idle");
    expect(got[0]?.body["data"]).toEqual(payload);
  });

  test("a duplicate is a delivery too", async () => {
    answer = { status: 202, body: { status: "duplicate", eventId: 7, wakeupId: 31 } };
    expect(await send()).toMatchObject({ state: "ok", result: "exit 0 · duplicate, event 7" });
  });

  test("413, 401 and 400 are given up at once", async () => {
    for (const [status, error] of [
      [413, "an event's data can be at most 64 KB of JSON"],
      [401, "unauthorized — pair this device first"],
      [400, '[\n  {\n    "code": "too_small",\n    "path": ["title"]\n  }\n]'],
    ] as const) {
      answer = { status, body: { error } };
      const delivery = await send();
      expect(delivery.state).toBe("failed");
      expect(delivery.attempts).toBe(1);
      expect(delivery.result).toStartWith("exit 1: midna:");
    }
  });

  test("a 500, or midna not there at all, is tried again", async () => {
    answer = { status: 500, body: { error: "database is locked" } };
    expect(await send()).toMatchObject({ state: "retrying", result: "exit 1: midna: database is locked" });
    const was = process.env["MIDNA_URL"];
    process.env["MIDNA_URL"] = "http://127.0.0.1:9";
    try {
      const away = await send();
      expect(away.state).toBe("retrying");
      expect(away.result).toContain("can't reach midna");
    } finally {
      process.env["MIDNA_URL"] = was;
    }
  });
});
