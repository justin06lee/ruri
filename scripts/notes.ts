/**
 * Recall notes that survive a spent small model (server/smallmodel.ts), and
 * the outline a chat folds its history into (server/archive.ts): a model
 * out of quota hands the call to the other harness's cheap one and rests;
 * a plain failure gets its second go first; with every model down the
 * failure comes back to the caller; turns assemble knowing whether their
 * reply is whole; the outline carries each exchange's cut prompt, its last
 * reply and its size, with the marks between, and is kept until the
 * history changes; notes go on the wire as their two halves, empty ones
 * left out.
 *
 *   bun run notes-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-notes-"));
process.env["RURI_CONFIG_DIR"] = root;
delete process.env["RURI_SMALL_MODEL"];
const { SessionArchive } = await import("../server/archive.js");
const { assembleTurns, setCompletionClient, setSmallModel, summarizePrompt } = await import("../server/smallmodel.js");
type Event = import("../shared/protocol.js").TranscriptEvent;
type Client = Parameters<typeof setCompletionClient>[0];

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("     ", JSON.stringify(detail).slice(0, 300));
  }
};

const LUNA = "codex:gpt-5.6-luna";
const SOURCE = "hey so the header flickers when I scroll, and could the logo be a bit smaller";
const NOTE = "header flickers on scroll; shrink logo";

/** A completions client that fails the named models with `error` and
 *  answers the rest, recording every model it was asked. */
function scripted(down: Record<string, string>): { client: Client; calls: string[] } {
  const calls: string[] = [];
  const client = {
    messages: {
      create: async (request: { model: string }) => {
        calls.push(request.model);
        const error = down[request.model];
        if (error) throw new Error(error);
        return { content: [{ type: "text", text: NOTE }] };
      },
    },
  } as unknown as Client;
  return { client, calls };
}

const LIMIT = "codex: You've hit your usage limit. Upgrade to Pro or try again at 9:52 PM.";

/* a spent model hands over at once, and rests */
{
  setSmallModel(undefined);
  const { client, calls } = scripted({ [LUNA]: LIMIT });
  setCompletionClient(client);
  const note = await summarizePrompt(SOURCE);
  check("a usage limit goes straight to Haiku", note === NOTE && calls.join() === `${LUNA},haiku`, calls);
  calls.length = 0;
  await summarizePrompt(SOURCE);
  check("the spent model rests: the next call skips it", calls.join() === "haiku", calls);
}

/* a plain failure gets its second go before handing over */
{
  const { client, calls } = scripted({ [LUNA]: "spawn codex ENOENT" });
  setCompletionClient(client);
  const note = await summarizePrompt(SOURCE);
  check("a plain failure is tried twice, then handed over", note === NOTE && calls.join() === `${LUNA},${LUNA},haiku`, calls);
}

/* Claude as the small model falls back to Luna */
{
  setSmallModel("haiku");
  const { client, calls } = scripted({ haiku: "429 rate limit" });
  setCompletionClient(client);
  const note = await summarizePrompt(SOURCE);
  check("a spent Claude model hands over to Luna", note === NOTE && calls.join() === `haiku,${LUNA}`, calls);
  setSmallModel(undefined);
}

/* every model down: the caller hears about it */
{
  const { client } = scripted({ [LUNA]: LIMIT, haiku: "429 rate limit" });
  setCompletionClient(client);
  const outcome = await summarizePrompt(SOURCE).then(
    () => "answered",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  check("with both down the failure comes back", outcome.includes("rate limit"), outcome);
  setCompletionClient(null);
}

const ts = Date.now();
const user = (id: string, text: string): Event => ({ kind: "user", id, text, ts }) as Event;
const said = (id: string, text: string): Event => ({ kind: "assistant", id, text, ts }) as Event;
const tool = (id: string): Event => ({ kind: "tool", id, name: "Bash", summary: "ls", ts }) as Event;
const result = (id: string): Event => ({ kind: "result", id, ok: true, ts }) as Event;
const mark = (id: string): Event => ({ kind: "compaction", id, text: `brief ${id}`, entries: [], ts }) as Event;

/* turns know whether their reply is whole */
{
  const turns = assembleTurns([
    user("u1", "one"), said("a1", "first"), tool("t1"), said("a1b", "second"), result("r1"),
    user("u2", "two"), said("a2", "cut off"),
    user("u3", "three"), said("a3", "running"),
  ]);
  check(
    "finished: by its result, by a later prompt, not while running",
    turns.map((t) => t.finished).join() === "true,true,false",
    turns.map((t) => t.finished),
  );
  check("a turn's reply is its messages joined, its tools by name", turns[0]!.turn.assistant === "first\n\nsecond" && turns[0]!.turn.tools.join() === "Bash", turns[0]);
}

/* the outline of a history */
{
  const archive = new SessionArchive();
  const long = "word ".repeat(120);
  const events: Event[] = [
    user("u1", long), said("a1", "a first message"), tool("t1"), said("a1b", "the last reply"), result("r1"),
    mark("c1"),
    user("u2", "second prompt"), result("r2"),
    mark("c2"),
    user("u4", "a marked-up reply"), said("a4", "## Done\n- **Bridge windows** close with the turn; see `bridge.ts`"), result("r4"),
    mark("c4"),
    user("u3", "live prompt"), said("a3", "live reply"),
  ];
  for (const event of events) archive.append("ch", event);
  const items = archive.earlier("ch");
  check("exchanges and marks, in order", items.map((i) => (i.kind === "turn" ? i.turnId : i.id)).join() === "u1,c1,u2,c2,u4", items);
  const marked = items[4];
  check(
    "a reply's stand-in is plain text, its markdown marks off",
    marked?.kind === "turn" && marked.reply === "Done Bridge windows close with the turn; see bridge.ts",
    marked,
  );
  const first = items[0];
  check(
    "a cut prompt, the last reply, the event count",
    first?.kind === "turn" && first.prompt.length <= 220 && first.prompt.endsWith("…") && first.reply === "the last reply" && first.count === 5,
    first,
  );
  const second = items[2];
  check("an exchange with no reply has none", second?.kind === "turn" && second.reply === "" && second.count === 2, second);
  check("the live part is not in it", !items.some((i) => i.kind === "turn" && i.turnId === "u3"));
  check("kept while the history is unchanged", archive.earlier("ch") === items);
  archive.append("ch", mark("c3"));
  const grown = archive.earlier("ch");
  check(
    "a compaction renews it",
    grown !== items && grown.map((i) => (i.kind === "turn" ? i.turnId : i.id)).join() === "u1,c1,u2,c2,u4,c4,u3",
    grown,
  );

  /* notes on the wire */
  archive.setSummary("ch", "u1", "user", "note one");
  archive.setSummary("ch", "u1", "reply", "");
  archive.setSummary("ch", "u2", "reply", "");
  const wire = archive.allSummaries(["ch"])["ch"] ?? {};
  check("both halves apart, an empty one left out", JSON.stringify(wire["u1"]) === JSON.stringify({ user: "note one" }), wire);
  check("a turn whose only note is empty is left out", wire["u2"] === undefined, wire);
  check("an asked-for empty half still counts as asked", archive.summaries("ch")["u2"]?.reply === "");
  archive.flushAll();
}

fs.rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? "\nall notes checks pass" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
