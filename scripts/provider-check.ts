/**
 * Cross-harness sanity: does a Codex session take every effort level ruri
 * offers, and does the small-model layer answer through a harness model?
 * Costs a few real (cheap) turns — run manually: bun run provider-check
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProvider, isSessionProvider, Yagami } from "@justin06lee/yagami";
import { EFFORT_LEVELS } from "../shared/protocol.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-provider-"));
const provider = createProvider("codex", {}, { workDir: dir, appName: "ruri" });
if (!isSessionProvider(provider)) {
  console.error("FAIL: codex is not a session provider here");
  process.exit(1);
}

let ok = true;
for (const effort of EFFORT_LEVELS) {
  const session = provider.openSession({
    cwd: dir,
    appName: "ruri",
    effort,
    native: { sandbox: "read-only" },
    permissions: { decide: () => Promise.resolve("allow" as const) },
  });
  let text = "";
  let failed: string | undefined;
  try {
    for await (const event of session.send("Reply with exactly: ok")) {
      if (event.type === "text") text += event.text;
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
  }
  await session.close();
  const good = failed === undefined && text.toLowerCase().includes("ok");
  if (!good) ok = false;
  console.log(`effort ${effort.padEnd(6)} → ${good ? "ok" : `FAILED: ${failed ?? JSON.stringify(text)}`}`);
}

const model = process.env["RURI_SMALL_MODEL"] ?? "codex:gpt-5.6-sol";
try {
  const reply = await new Yagami().messages.create({
    model,
    max_tokens: 64,
    system: "Answer with one word.",
    messages: [{ role: "user", content: "Say: pong" }],
  });
  const text = (reply.content ?? [])
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("")
    .trim();
  const good = text.toLowerCase().includes("pong");
  if (!good) ok = false;
  console.log(`small model ${model} → ${good ? "ok" : `FAILED: ${JSON.stringify(text)}`}`);
} catch (err) {
  ok = false;
  console.log(`small model ${model} → FAILED: ${err instanceof Error ? err.message : String(err)}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(ok ? "\nPROVIDER CHECK PASS" : "\nPROVIDER CHECK FAIL");
process.exit(ok ? 0 : 1);
