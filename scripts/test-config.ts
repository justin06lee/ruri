/**
 * `bun test`'s preload: a config folder of the run's own, made before any
 * test file is loaded, and gone when the run ends.
 *
 * Tests that touch the config set their own folder and put back whatever
 * was there before. Without this, what was there before is the user's own
 * ~/.config/ruri — so a store that wrote a moment after its test had ended
 * (or a test that set no folder at all) wrote into the user's live data:
 * a test's one-project briefs.json over every project's sheets.
 */
import { afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-test-config-"));
process.env["RURI_CONFIG_DIR"] = dir;
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
