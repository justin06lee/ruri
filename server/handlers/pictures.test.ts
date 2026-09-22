import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AttachmentUpload, ServerMessage, WindowDragPhase } from "../../shared/protocol.js";
import type { ClientConn, ServerContext } from "../context.js";
import { hostHandlers } from "./host.js";
import { settingHandlers } from "./settings.js";

let dir: string;
let saved: string | undefined;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-band-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A window's socket that keeps what it is sent. */
function socket(): { ws: ClientConn; said: ServerMessage[] } {
  const said: ServerMessage[] = [];
  const ws = { readyState: 1, send: (data: string) => said.push(JSON.parse(data) as ServerMessage) };
  return { ws: ws as unknown as ClientConn, said };
}

const upload = (over: Partial<AttachmentUpload> = {}): AttachmentUpload => ({
  id: "pic-1",
  kind: "image",
  mediaType: "image/gif",
  name: "band.gif",
  n: 0,
  data: Buffer.from("GIF89a-bytes").toString("base64"),
  ...over,
});

const ctx = {} as ServerContext;

describe("store_picture", () => {
  test("a picture is kept with the uploads, and the window told where", () => {
    const { ws, said } = socket();
    settingHandlers.store_picture(ctx, ws, { type: "store_picture", upload: upload() });
    expect(said).toHaveLength(1);
    const reply = said[0] as Extract<ServerMessage, { type: "picture_stored" }>;
    expect(reply).toMatchObject({ type: "picture_stored", id: "pic-1" });
    expect(reply.url).toMatch(/^\/uploads\/pic-1-band\.gif$/);
    expect(fs.readFileSync(path.join(dir, "uploads", path.basename(reply.url!)), "utf8")).toBe(
      "GIF89a-bytes",
    );
  });

  test("anything but a picture — or an SVG, which would be a page — is refused", () => {
    for (const mediaType of ["image/svg+xml", "text/html", "application/pdf"]) {
      const { ws, said } = socket();
      settingHandlers.store_picture(ctx, ws, {
        type: "store_picture",
        upload: upload({ id: "x", mediaType }),
      });
      expect(said).toEqual([{ type: "picture_stored", id: "x", url: null }]);
    }
  });
});

describe("window_drag", () => {
  test("each phase goes to the shell", () => {
    const phases: WindowDragPhase[] = [];
    const withShell = {
      options: { windowDrag: (phase: WindowDragPhase) => phases.push(phase) },
    } as unknown as ServerContext;
    const { ws } = socket();
    for (const phase of ["start", "move", "move", "end", "zoom"] as const) {
      hostHandlers.window_drag(withShell, ws, { type: "window_drag", phase });
    }
    expect(phases).toEqual(["start", "move", "move", "end", "zoom"]);
  });

  test("with no shell (ruri headless) it does nothing", () => {
    const { ws } = socket();
    expect(() =>
      hostHandlers.window_drag({ options: {} } as ServerContext, ws, { type: "window_drag", phase: "start" }),
    ).not.toThrow();
  });
});
