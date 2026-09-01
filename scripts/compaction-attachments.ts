/**
 * Compaction must leave the fresh model a path to every attached image, not
 * just the prompt's [image #N] placeholder. Pure disk test — no model call.
 *
 * Run with: bun run compaction-attachments-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-compaction-images-"));
process.env["RURI_CONFIG_DIR"] = configDir;

// Import after setting RURI_CONFIG_DIR: this mirrors the server process and
// keeps the test's files wholly inside its temporary configuration directory.
const { buildCompaction, refreshArchivedTurnFiles } = await import("../server/compaction.js");
const { processAttachments, storedFilePath } = await import("../server/uploads.js");

const channelId = "images";
const pixels = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const processed = processAttachments("What is shown in [image #2]?", [
  {
    id: "att-2",
    kind: "image",
    mediaType: "image/png",
    name: "reference.png",
    n: 2,
    data: pixels.toString("base64"),
  },
]);
const imagePath = storedFilePath(processed.attachments[0]!.url!);

const events: TranscriptEvent[] = [
  {
    kind: "user",
    id: "user-1",
    text: processed.display,
    attachments: processed.attachments,
    ts: 1_700_000_000_000,
  },
  { kind: "assistant", id: "assistant-1", text: "I inspected it.", ts: 1_700_000_000_001 },
];

let bad = 0;
try {
  const built = buildCompaction(channelId, events, {});
  const turnPath = path.join(configDir, "turns", channelId, "001.md");
  const turn = fs.readFileSync(turnPath, "utf8");

  if (!built?.brief.includes(turnPath)) {
    console.error("FAIL: compaction brief does not point to the archived exchange");
    bad++;
  }
  if (!built?.brief.includes("image-viewing tool")) {
    console.error("FAIL: compaction brief does not tell the model how to inspect archived images");
    bad++;
  }
  if (!turn.includes("[image #2]") || !turn.includes(imagePath)) {
    console.error("FAIL: archived exchange does not map the image marker to its stored file");
    bad++;
  }
  if (!turn.includes("Open image paths with your image-viewing tool")) {
    console.error("FAIL: archived exchange does not tell the model to inspect the image pixels");
    bad++;
  }
  if (!fs.readFileSync(imagePath).equals(pixels)) {
    console.error("FAIL: archived image bytes are not available at the recorded path");
    bad++;
  }

  // Archives made before this feature are repaired on launch from the
  // attachment metadata which was always retained in the session JSON.
  fs.writeFileSync(turnPath, "legacy archive containing only [image #2]\n");
  refreshArchivedTurnFiles(channelId, events);
  const refreshed = fs.readFileSync(turnPath, "utf8");
  if (!refreshed.includes("[image #2]") || !refreshed.includes(imagePath)) {
    console.error("FAIL: an existing legacy archive is not refreshed with its image path");
    bad++;
  }

  const laterEvents: TranscriptEvent[] = [
    ...events,
    { kind: "user", id: "user-2", text: "A turn after the last compaction", ts: 1_700_000_000_002 },
  ];
  refreshArchivedTurnFiles(channelId, laterEvents);
  if (fs.existsSync(path.join(configDir, "turns", channelId, "002.md"))) {
    console.error("FAIL: startup refresh archived a newer, still-active turn");
    bad++;
  }

  const activeChannel = "not-compacted";
  refreshArchivedTurnFiles(activeChannel, events);
  if (fs.existsSync(path.join(configDir, "turns", activeChannel))) {
    console.error("FAIL: refreshing old archives created files for an active, uncompacted session");
    bad++;
  }

  if (bad === 0) {
    console.log("PASS: compacted turns map image markers to preserved, readable pixel files");
  }
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}

process.exitCode = bad === 0 ? 0 : 1;
