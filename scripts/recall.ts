/**
 * The recall note a finished reply leaves behind, and the work it carries.
 *
 * Compaction is built from these notes, so whatever a note drops is gone
 * from the model's memory of the conversation. A reply that ends by
 * offering what it would do next — a ranked list, "next is stage 7…" — was
 * having that offer compressed out of existence, which is the one part a
 * user is most likely to come back for days later. The note now keeps it,
 * verbatim enough to act on.
 *
 * Three small calls to the small model. The assertions are deliberately
 * loose — the exact wording is the model's business — and check only what
 * the compaction actually depends on: the marker appears when work was put
 * forward, it does not when none was, and the items are not compressed to
 * a shrug.
 *
 * Run manually: bun run recall-test
 */
import { endsIntact, offTask, summarizePrompt, summarizeReply, smallModelEnabled } from "../server/smallmodel.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", String(detail));
  }
}

/* ── the head-and-tail cut, which is what puts the offer in reach ──── */

const long = `${"HEAD".padEnd(5000, "x")}TAIL-MARKER`;
const cut = endsIntact(long, 400);
check("a long reply keeps its opening", cut.startsWith("HEAD"), cut.slice(0, 20));
check("and, above all, its close", cut.endsWith("TAIL-MARKER"), cut.slice(-20));
check("short replies are left alone", endsIntact("small", 400) === "small");

/* ── commentary is not a note ─────────────────────────────────────── */

// The failures seen in real compactions: the model answered the message
// (asked for files, said it can't see images) or reviewed it ("this isn't a
// message to compress") instead of compressing it.
const META_PROMPT =
  "Compressed list (do these first, before Ruri bridge):\n\n1. Music tab auto-scroll to active on open\n2. Chat auto-naming broken - waits for full prompt before triggering\n3. Home page split agent/all-agents view with token spend stats";
check(
  "a review of the message is off task",
  offTask("This isn't a message to compress—it's a feature request and formatting complaint. Provide the actual user messages that need compaction.", META_PROMPT),
);
check(
  "an answer to the message is off task",
  offTask("I can't see images, and these questions are outside Google Drive—I only have file management tools here.", "[image #1] fix this [image #2] and this"),
);
check(
  "a question the message never asked is off task",
  offTask("Can you share the file ID or link to the code for this feature?", "find the naming components feature and tell me where it lives"),
);
check(
  "a note longer than its source is off task",
  offTask("fix the header flicker on scroll and also shrink the logo a bit while you are at it please", "fix header flicker"),
);
check("a real compression passes", !offTask("header flickers on scroll; shrink logo", "hey so when I scroll down the page the header kind of flickers? could we make the logo smaller too"));
check(
  "the job's words are fine when the message used them",
  !offTask("fix compaction model so notes don't do this; small model changeable?", "can you fix the compaction model so it doesn't do this? it's just using a small model that I can change right?"),
);
check("an empty note is left to the fallback", !offTask("", "anything"));

if (!smallModelEnabled()) {
  console.log("\nRURI_NO_MEMORY=1 — skipping the model half");
  process.exit(failed === 0 ? 0 : 1);
}

/* ── what the note keeps ──────────────────────────────────────────── */

const RANKED = `## What I'd steal, ranked

1. **A serverless address, exactly like theirs.** Keys + relay, no control plane.
2. \`makima ping --until-direct\`. Tells you whether the router cooperated and you got a direct path.
3. **Distribution.** \`make\` from source is the single biggest barrier to "dead simple." A Homebrew tap and static release binaries.
4. **File copy.** \`makima cp file laptop:\` — we have nothing, and SFTP-over-the-mesh is not much code.
5. **Built-in SSH server.** Works on a box with no \`sshd\`, and \`--ssh-authorized-keys github:justin06lee\`.
6. **Ephemeral / rootless try-mode.** Netstack is a big lift.
7. **PSK.** Cheap post-quantum hedge, a few lines.

My call: 1, 2 and 3 are the high-value ones.

Want me to start on any of them?`;

const ranked = await summarizeReply({
  turnId: "t1",
  user: "what would you steal from tailscale?",
  assistant: RANKED,
  tools: ["Read", "Grep", "WebFetch"],
});
console.log(`\n  ${ranked}\n`);
check("a ranked list of proposals is carried", ranked.includes("next:"), ranked);
// the items themselves, not a count of them: five of the seven is enough
// slack for the model to merge a pair and still have kept the list
const kept = ["ping", "cp", "ssh", "psk", "homebrew", "serverless", "try-mode", "release"].filter((word) =>
  ranked.toLowerCase().includes(word),
);
check("with the items still in it", kept.length >= 5, `kept ${kept.length}: ${kept.join(", ")}`);
check("and the flags spelled as written", ranked.includes("--until-direct"), ranked);

const staged = await summarizeReply({
  turnId: "t2",
  user: "finish stage 6",
  assistant:
    "42 tests, clippy clean, release build passes, no stray processes. Next is stage 7 — cited lecture synthesis with the entailment pass, which is where the anti-slop machinery actually gets exercised.",
  tools: ["Bash", "Edit"],
});
console.log(`\n  ${staged}\n`);
check("a one-line next step is carried too", staged.includes("next:"), staged);
check("and the outcome still leads", /42|test|clippy|build/i.test(staged.split("next:")[0] ?? ""), staged);
check("naming the stage it named", /stage 7/i.test(staged), staged);

const plain = await summarizeReply({
  turnId: "t3",
  user: "the header flickers on scroll",
  assistant:
    "Found it — the sticky header was re-measuring on every scroll event. Moved the measurement behind a ResizeObserver in Header.tsx and the flicker is gone. Typecheck and build pass.",
  tools: ["Read", "Edit", "Bash"],
});
console.log(`\n  ${plain}\n`);
check("a reply that offered nothing invents nothing", !plain.includes("next:"), plain);
check("and still says what changed", /header|resizeobserver/i.test(plain), plain);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
/* ── the model, handed the messages that broke it ─────────────────── */

const metaNote = await summarizePrompt(META_PROMPT);
console.log("    meta prompt →", JSON.stringify(metaNote));
check("a message about compression still gets compressed", metaNote.length > 0 && !offTask(metaNote, META_PROMPT), metaNote);
check("and the note keeps its items", /music/i.test(metaNote) && /nam/i.test(metaNote), metaNote);

const ADDRESSED = "[image #1] I can't see what you changed. Share the file or tell me where it's located (GitHub repo, Google Drive folder, etc.) and I'll compress your request for the developer.";
const addressedNote = await summarizePrompt(ADDRESSED);
console.log("    addressed prompt →", JSON.stringify(addressedNote));
check("a message that reads as addressed to the helper is compressed, not answered", addressedNote.length > 0 && !offTask(addressedNote, ADDRESSED), addressedNote);

process.exit(failed === 0 ? 0 : 1);
