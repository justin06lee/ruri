/**
 * The paragraph gate (server/paragraphs.ts): a streamed reply comes out a
 * finished paragraph at a time, code blocks whole, and nothing is lost.
 *
 *   bun run paragraphs-test
 */
import { ParagraphGate } from "../server/paragraphs.js";

function run(reply: string, chunk: number): string[] {
  const gate = new ParagraphGate();
  const out: string[] = [];
  for (let i = 0; i < reply.length; i += chunk) {
    const piece = gate.push(reply.slice(i, i + chunk));
    if (piece) out.push(piece);
  }
  const rest = gate.flush();
  if (rest) out.push(rest);
  return out;
}

const reply = [
  "First paragraph, which wraps\nonto a second line.",
  "",
  "- a list item",
  "- another",
  "",
  "```ts",
  "const a = 1;",
  "",
  "const b = 2;",
  "```",
  "Straight after the block.",
  "",
  "~~~~",
  "``` not a close",
  "~~~~",
  "",
  "Last words, no trailing newline",
].join("\n");

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("     ", JSON.stringify(detail));
  }
};

for (const chunk of [1, 3, 7, 50, 10_000]) {
  const pieces = run(reply, chunk);
  check(`chunks of ${chunk}: nothing lost or reordered`, pieces.join("") === reply);
  check(
    `chunks of ${chunk}: the code block arrives whole`,
    pieces.some((p) => p.includes("const a = 1;\n\nconst b = 2;\n```")),
    pieces,
  );
  check(
    `chunks of ${chunk}: no piece ends inside a paragraph`,
    pieces.slice(0, -1).every((p) => p.trim() !== "" && (p.endsWith("\n\n") || p.endsWith("```\n") || p.endsWith("~~~~\n"))),
    pieces,
  );
}
check("token by token, the first paragraph comes out alone", run(reply, 1)[0] === "First paragraph, which wraps\nonto a second line.\n\n");
check("a tilde fence is not closed by backticks", run(reply, 1).some((p) => p.startsWith("~~~~\n``` not a close\n~~~~\n")));
check("a stream with no blank line is held to the end", run("one line\nanother line", 1).length === 1);

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all good");
