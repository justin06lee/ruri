import * as path from "node:path";
import type { MemoryPart, StackLayer } from "../shared/protocol.js";
import { layerOfFile, memoryLineText } from "./brief.js";
import { chatByPrefix, dominantLayer, exchangeRef, pushSheet, sourceLabel } from "./catchupBrief.js";
import { ownerProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import { branchFacts, gitLines, gitState } from "./gitState.js";
import { parseArgs, slugify } from "./library.js";
import { dayOf, lineText, memoryEmpty } from "./memoryLines.js";
import { linesWith, type LineRecord, type MemoryEvent } from "./memoryLog.js";
import { ASK_FROM, SAME_AT } from "./memoryFold.js";
import { mostAlike } from "./similarity.js";
import { checkMemory, withAnchors } from "./memoryCheck.js";
import { isEdit, runIndexCommand, runLayerCommand } from "./sheetEdits.js";
import { readTurnRecord } from "./turnRecords.js";
import { searchProject } from "./projectSearch.js";
import { exchangeLine, exchangesOf, exchangeText, projectRelative } from "./recall.js";
import { RECALL_FLOOR } from "./retrieval.js";

/**
 * The project's memory from a session's shell — the same `ruri` command as
 * the component library (server/library.ts), and the same endpoint.
 *
 * `ruri note` is how the agent that did the work writes down what it
 * learned — the decision and its reason, the approach that failed and
 * why — first-hand, where the small model gathering from the chats can
 * only guess at a reason from outside; a line about one layer is filed
 * with it (`--layer`, or the layer this turn's changes are in). `ruri
 * recall` searches every exchange in the project, across its chats, and
 * prints one whole; the ref after each memory line is what it takes.
 * `ruri state` is git and this chat's changes, live. `ruri layer` is the
 * stack, and one layer's own sheet — what a session reads before working
 * in that layer, and then keeps true (server/sheetEdits.ts); `ruri
 * architecture` is the index, read and kept the same way.
 */

export interface MemoryAnswer {
  ok: boolean;
  text: string;
}

const yes = (text: string): MemoryAnswer => ({ ok: true, text });
const no = (text: string): MemoryAnswer => ({ ok: false, text });

const KINDS: Record<string, MemoryPart> = {
  decision: "decisions",
  decisions: "decisions",
  decided: "decisions",
  failed: "failed",
  fail: "failed",
  failure: "failed",
  tried: "failed",
  worked: "worked",
  works: "worked",
  trap: "gotchas",
  traps: "gotchas",
  gotcha: "gotchas",
  gotchas: "gotchas",
  rule: "gotchas",
  open: "open",
  todo: "open",
};

export const MEMORY_COMMANDS = new Set([
  "note",
  "memory",
  "forget",
  "done",
  "state",
  "recall",
  "layer",
  "layers",
  "stack",
  "architecture",
  "arch",
]);

export const MEMORY_HELP = `and this project's memory — .ruri/catchup.md, which every session reads first:

  ruri note <kind> "<what>" [--why "<why>"] [--layer <slug>|project]
                                     write down what the next session will need: kind is decision,
                                     failed, worked, trap or open. What you learned, not what you built.
                                     A line about one layer is read with its sheet; without --layer it
                                     goes to the layer this turn's changes are in, if they are in one.
                                     A line the memory already has is replaced by yours rather than
                                     kept twice; one that might be is shown to you first —
                                     --update <id> replaces that line, --new adds yours anyway
  ruri memory                        the memory as it stands, each line with its id and where it came from
  ruri forget <id> [--why "<why>"]   take out a line that is wrong, or done (not one of the user's); the
                                     log keeps it, with your reason
  ruri memory log [<id>]             what happened to the memory, or to one line: added, reworded,
                                     superseded, retired, archived, restored — by whom, and why
  ruri memory past                   the lines that left the memory, and why each went
  ruri memory restore <id>           bring a line that left back into the memory
  ruri memory undo [<fold>]          take the newest fold of the memory back whole (or the one named)
  ruri memory confirm <id>           let in a line gathered from web or tool output, once you have
                                     checked it against the code
  ruri memory check                  hold every line up against the code now: what moved is marked, and
                                     the memory model confirms, corrects or retires what it can
  ruri state                         git, and what this chat has changed — live
  ruri recall <words>                search every exchange in this project, across its chats
  ruri recall show <ref>             one exchange whole; a ref is what follows a memory line: 7a3637b4#16

and its architecture — the stack every session is shown, and a sheet for each layer. Read one this
way and you can edit it in this chat, as long as nobody else changes it first — keep it true to what
your work changed:

  ruri layer                         the stack, top to bottom, each layer with its handle
  ruri layer <slug>                  one layer's sheet, every line numbered: where to change what in it,
                                     how it works, its key files, its traps, what git says changed in it
                                     lately, what sessions learned there — read it before you work there
  ruri layer <slug> add <section> "<line>"      sections: summary, map, flows, files, rules, edges
  ruri layer <slug> set <section> <n> "<line>"  (set summary "<text>" takes no number)
  ruri layer <slug> drop <section> <n>
  ruri layer <slug> own|disown <path>…          the files and folders it owns
  ruri architecture                  the index (.ruri/architecture.md), every line numbered, and the
                                     files no layer owns yet
  ruri architecture add|set|drop <section> …    sections: description, stack, flows, where, run,
                                     conventions, features`;

const TITLES: Record<MemoryPart, string> = {
  now: "Where it stands",
  decisions: "Decisions, and why",
  worked: "What worked",
  failed: "What didn't, and why",
  gotchas: "Gotchas and rules",
  open: "Still open",
};

/**
 * A chat's changed files, most recent first: what each finished turn
 * changed as its checkpoints tell it, and — for the turn still running, and
 * turns from before those were kept — what its edit tools changed.
 */
function changedFiles(ctx: ServerContext, channelId: string, projectName: string): string[] {
  const seen: string[] = [];
  const summaries = ctx.archive.summaries(channelId);
  const add = (file: string) => {
    if (!seen.includes(file)) seen.push(file);
  };
  let turn: string[] = [];
  // newest first: a turn's edit-tool files, then — at its prompt — its
  // checkpoint's, which include them
  for (const event of [...ctx.archive.allEvents(channelId)].reverse()) {
    if (event.kind === "tool" && event.diff?.path) turn.push(projectRelative(event.diff.path, projectName));
    if (event.kind !== "user") continue;
    const kept = summaries[event.id]?.files;
    for (const file of kept ?? turn) add(file);
    turn = [];
  }
  return seen;
}

/** The files the turn now running has changed so far, project-relative. */
async function turnSoFar(
  ctx: ServerContext,
  channelId: string,
  project: { name: string; path: string },
): Promise<string[]> {
  const events = ctx.archive.events(channelId);
  const at = events.findLastIndex((e) => e.kind === "user");
  if (at === -1) return [];
  const edited = events
    .slice(at)
    .flatMap((e) => (e.kind === "tool" && e.diff?.path ? [projectRelative(e.diff.path, project.name)] : []));
  const since = await Promise.resolve()
    .then(() => ctx.checkpoints.changedSince(project, channelId, events[at]!.id))
    .catch(() => undefined);
  return [...new Set([...edited.filter((f) => !path.isAbsolute(f)), ...(since ?? [])])];
}

function memoryText(ctx: ServerContext, projectId: string, git: string[]): string {
  const project = ctx.store.get(projectId)!;
  const memory = ctx.briefs.get(projectId).memory;
  const out = [`${project.name} — its memory (.ruri/catchup.md), with each line's id`, ""];
  if (git.length) out.push("Git, now:", ...git.map((l) => `  ${l}`), "");
  if (memoryEmpty(memory)) {
    out.push('Nothing in it yet. ruri note <kind> "<what>" --why "<why>" starts it.');
    return out.join("\n");
  }
  for (const part of Object.keys(TITLES) as MemoryPart[]) {
    const lines = memory![part];
    if (!lines.length) continue;
    out.push(`${TITLES[part]}:`);
    for (const line of lines) {
      const ref = line.source ? sourceLabel(ctx, line.source)?.ref : undefined;
      const marks = [
        ...(line.check ? [`may be stale: ${line.check.reason}`] : []),
        ...(line.quarantined ? ["from web or tool output — not shown to sessions until confirmed"] : []),
      ];
      out.push(
        `  ${line.id}  ${line.layer ? `[${line.layer}] ` : ""}${memoryLineText(line, ref ? { refs: { [line.id]: ref } } : {})}${marks.length ? ` [${marks.join("; ")}]` : ""}`,
      );
    }
    out.push("");
  }
  out.push(
    "ruri recall show <ref> prints the exchange a line came from; ruri forget <id> takes a line out;",
    "ruri memory log <id> is a line's history, ruri memory past the lines that left.",
  );
  return out.join("\n");
}

/** When, as the log lists it: the day and the time. */
function stamp(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${dayOf(ts)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const DID: Record<MemoryEvent["op"], string> = {
  import: "brought in",
  add: "added",
  edit: "reworded",
  supersede: "superseded",
  merge: "merged",
  retire: "retired",
  archive: "archived",
  restore: "restored",
  pin: "pinned",
  unpin: "unpinned",
  flag: "flagged",
  verify: "checked",
  confirm: "confirmed",
  undo: "undone",
};

/** One event, as `ruri memory log` prints it. */
function eventLine(event: MemoryEvent): string {
  const who =
    event.by === "system"
      ? "ruri"
      : event.by === "model"
        ? "the model"
        : event.by === "agent"
          ? "an agent"
          : "the user";
  const where =
    event.after.status === "current" ? event.after.part : `${event.after.part}, ${event.after.status}`;
  const why = [event.reason, event.evidence ? `evidence: ${event.evidence}` : ""].filter(Boolean).join(" — ");
  return `  #${event.seq}  ${stamp(event.at)}  ${event.line}  ${DID[event.op]} by ${who}${event.fold ? ` (fold ${event.fold})` : ""}${why ? ` — ${why}` : ""}\n      [${where}] ${lineText(event.after)}`;
}

/** A line that left the memory, as `ruri memory past` prints it. */
function pastLine(line: LineRecord): string {
  const when = line.invalidAt ? dayOf(line.invalidAt) : "";
  const into = line.supersededBy ? ` by ${line.supersededBy}` : "";
  return `  ${line.id}  ${line.status}${into} ${when}${line.reason ? ` — ${line.reason}` : ""}\n      [${line.part}${line.layer ? `, ${line.layer}` : ""}] ${lineText(line)}`;
}

/**
 * Run one memory command for a session in `channelId` — undefined when the
 * command isn't one of these, for the library to take. Never throws.
 */
export async function runMemoryCommand(
  ctx: ServerContext,
  channelId: string,
  argv: string[],
): Promise<MemoryAnswer | undefined> {
  const args = parseArgs(argv);
  const command = (args.words[0] ?? "").toLowerCase();
  if (!MEMORY_COMMANDS.has(command)) return undefined;
  const project = ownerProject(ctx, channelId);
  if (!project) return no("ruri: this chat belongs to no project, so there is no memory to keep");
  const projectId = project.id;

  switch (command) {
    case "note": {
      const kind = (args.words[1] ?? "").toLowerCase();
      const part = KINDS[kind];
      if (!part) {
        return no(
          `ruri note <kind> "<what>" [--why "<why>"] — kind is one of decision, failed, worked, trap, open${kind ? ` (not "${kind}")` : ""}`,
        );
      }
      const text = args.words.slice(2).join(" ").trim();
      if (!text) return no(`ruri note ${kind} "<what>" — what is it?`);
      const why = args.flags.get("why")?.at(-1)?.trim();
      if (text.length > 400 || (why?.length ?? 0) > 300) {
        return no("ruri note: one line — say it in under forty words, and put the reason in --why");
      }
      const turn = ctx.archive.events(channelId).findLast((e) => e.kind === "user")?.id;
      const layers = ctx.briefs.get(projectId).layers ?? [];
      const named = args.flags.get("layer")?.at(-1)?.trim();
      let layer: string | undefined;
      let guessed = false;
      if (named && named.toLowerCase() !== "project") {
        const found = findLayer(layers, named);
        if (!found?.slug) {
          return no(
            `no layer "${named}" — the stack is ${layers.map((l) => l.slug ?? slugify(l.name)).join(", ") || "empty"}; --layer project files it across the project`,
          );
        }
        layer = found.slug;
      } else if (!named && layers.length) {
        // left off: the layer this turn's changes are in, when they are in one
        layer = dominantLayer(layers, await turnSoFar(ctx, channelId, project));
        guessed = !!layer;
      }
      // a line the memory already has is said again, not added twice: one
      // that plainly restates an agent's or the model's line takes its
      // place; one that only might is put back to the agent to decide
      const current = linesWith(ctx.memory.state(projectId)).filter((l) => !l.quarantined);
      const target = args.flags.get("update")?.at(-1)?.trim();
      let replace: LineRecord | undefined;
      if (target) {
        replace = current.find((l) => l.id.toLowerCase() === target.toLowerCase());
        if (!replace)
          return no(`ruri note --update ${target}: no current line ${target} — \`ruri memory\` lists them`);
      } else if (!args.switches.has("new")) {
        const [like] = mostAlike(`${text} ${why ?? ""}`, current, (l) => `${l.text} ${l.why ?? ""}`, {
          limit: 1,
          floor: ASK_FROM,
        });
        if (like && like.score >= SAME_AT && like.item.by !== "user" && !like.item.pinned)
          replace = like.item;
        else if (like) {
          const owner =
            like.item.by === "user" || like.item.pinned
              ? "the user's"
              : like.item.by === "agent"
                ? "an agent's"
                : "the model's";
          return no(
            `that may already be in the memory — ${like.item.id} (${like.item.part}, ${owner}): ${lineText(like.item)}\n` +
              (like.item.by === "user" || like.item.pinned
                ? "It is the user's line: if yours says something it doesn't, add it with --new."
                : `If yours says the same thing better, replace it: ruri note ${kind} "${text}" --update ${like.item.id}. If it says something else, add it with --new.`),
          );
        }
      }
      const fields = {
        text,
        ...(why ? { why } : {}),
        ...(turn ? { source: { chat: channelId, turn } } : {}),
        ...(layer ? { layer } : {}),
      };
      const result = ctx.memory.apply(
        projectId,
        await withAnchors(ctx, projectId, [
          replace
            ? {
                op: "supersede",
                line: replace.id,
                ...fields,
                ...(replace.part !== part ? { part } : {}),
                layer: layer ?? null,
                reason: target
                  ? "an agent's newer line, by its own say"
                  : "said again by an agent, in its own words",
                evidence: turn ? `${channelId.slice(0, 8)}'s turn` : "an agent's note",
              }
            : { op: "add", part, ...fields },
        ]),
        { by: "agent", chat: channelId },
      );
      const line = result.added[0];
      if (!line) return no(`ruri note: ${result.refused[0]?.reason ?? "the line could not be kept"}`);
      pushSheet(ctx, projectId);
      if (replace) {
        return yes(
          `${replace.id} said that already (${lineText(replace)}) — it is ${line.id} now, in your words: ${lineText(line)}. The log keeps the old one (ruri memory log ${replace.id}).`,
        );
      }
      const missingWhy = !why && (part === "decisions" || part === "failed");
      const where = layer
        ? ` with the ${layer} layer${guessed ? ` (where this turn's changes are — if it holds across the project, ruri forget ${line.id} and note it again with --layer project)` : ""}`
        : layers.length
          ? " across the project"
          : "";
      return yes(
        `noted under "${TITLES[part]}"${where} as ${line.id}: ${lineText(line)}` +
          (missingWhy
            ? `\n(a ${kind} without its reason is half useful — ruri forget ${line.id} and note it again with --why)`
            : ""),
      );
    }

    case "memory":
      return memoryCommand(ctx, channelId, projectId, args.words.slice(1), project);

    case "forget":
    case "done": {
      const id = args.words[1];
      if (!id) return no(`ruri ${command} <id> — \`ruri memory\` lists each line's id`);
      const found = ctx.memory.record(projectId, id);
      if (!found || found.status !== "current") {
        return no(`no line ${id} in the memory — \`ruri memory\` lists them`);
      }
      if (found.by === "user" || found.pinned) {
        return no(
          `${found.id} is the user's — they change it on the architecture page. Say so to them if it's wrong.`,
        );
      }
      const why = args.flags.get("why")?.at(-1)?.trim() || args.flags.get("reason")?.at(-1)?.trim();
      const reason = why || (command === "done" ? "done, says an agent" : "taken out by an agent");
      const result = ctx.memory.apply(projectId, [{ op: "retire", line: found.id, reason }], {
        by: "agent",
        chat: channelId,
      });
      if (result.refused.length) return no(`ruri ${command}: ${result.refused[0]!.reason}`);
      pushSheet(ctx, projectId);
      return yes(
        `took out ${found.id}: ${lineText(found)} — the log keeps it (ruri memory restore ${found.id} brings it back)`,
      );
    }

    case "layer":
    case "layers":
    case "stack": {
      const brief = ctx.briefs.get(projectId);
      const layers = brief.layers ?? [];
      if (layers.length === 0) {
        return yes(
          `${project.name} has no stack on file yet — the user can have it read from the repo on the architecture page`,
        );
      }
      // `ruri layer <slug> add|set|drop|own|disown …` edits; anything else
      // after `ruri layer` names the layer, a word or several
      const editing = isEdit(args.words[2]);
      const wanted = (editing ? args.words.slice(1, 2) : args.words.slice(1)).join(" ").trim();
      if (!wanted) {
        const out = [`${project.name} — the stack, top to bottom`, ""];
        layers.forEach((layer, i) => {
          const sheet = layer.slug && brief.layerSheets?.[layer.slug];
          out.push(
            `${i + 1}. ${layer.slug ?? slugify(layer.name)} — ${layer.name}${layer.what ? `: ${layer.what}` : ""}${sheet ? "" : " (no sheet)"}`,
          );
        });
        out.push("", "ruri layer <slug> prints one layer's sheet.");
        return yes(out.join("\n"));
      }
      const layer = findLayer(layers, wanted);
      if (!layer) {
        return no(
          `no layer "${wanted}" — the stack is ${layers.map((l) => l.slug ?? slugify(l.name)).join(", ")}`,
        );
      }
      return runLayerCommand(ctx, channelId, project, layer, editing ? args.words.slice(2) : []);
    }

    case "architecture":
    case "arch":
      return runIndexCommand(ctx, channelId, project, args);

    case "state": {
      const state = await gitState(project.path);
      const out = [`${project.name} — now`, ""];
      if (state) out.push(...gitLines(state).map((l) => `- ${l}`));
      else out.push("- not a git repository (or git isn't answering)");
      const files = [
        ...new Set([
          ...(await turnSoFar(ctx, channelId, project)),
          ...changedFiles(ctx, channelId, project.name),
        ]),
      ];
      if (files.length) {
        out.push(
          "",
          `This chat has changed, newest first: ${files.slice(0, 25).join(", ")}${files.length > 25 ? `, and ${files.length - 25} more` : ""}`,
        );
        const layers = ctx.briefs.get(projectId).layers ?? [];
        const touched = [...new Set(files.flatMap((f) => layerOfFile(layers, f)?.slug ?? []))];
        if (touched.length)
          out.push(`In the layers: ${touched.join(", ")} — \`ruri layer <handle>\` for each one's sheet.`);
      }
      const open = ctx.briefs.get(projectId).memory?.open ?? [];
      if (open.length) {
        out.push("", "Still open, by the memory:");
        for (const line of open) {
          const fact = branchFacts(line.text, state);
          out.push(`- ${line.id}  ${lineText(line)}${fact ? ` ${fact}` : ""}`);
        }
      }
      return yes(out.join("\n"));
    }

    case "recall": {
      if ((args.words[1] ?? "").toLowerCase() === "show") {
        const ref = args.words[2];
        if (!ref) return no("ruri recall show <ref> — a ref like 7a3637b4#16, or #16 for this chat's");
        const match = /^(?:([0-9a-z-]{4,}))?#?(\d+)$/i.exec(ref.trim());
        if (!match) return no(`"${ref}" isn't a ref — they look like 7a3637b4#16`);
        const chat = match[1] ? chatByPrefix(ctx, projectId, match[1]) : channelId;
        if (!chat) return no(`no chat in ${project.name} starts ${match[1]}`);
        const n = Number(match[2]);
        const exchanges = exchangesOf(
          chat,
          ctx.archive.allEvents(chat),
          ctx.archive.summaries(chat),
          project.name,
          ctx.archive.exchangeNumbers(chat),
        );
        const ex = exchanges.find((e) => e.n === n);
        if (!ex) {
          // the history's cap dropped it, or a rewind took it: its turn
          // record is what is left, when there is one
          const record = readTurnRecord(chat, n);
          if (record) return yes(`# ${exchangeRef(chat, n)} — from its turn record\n\n${record}`);
          const top = exchanges.at(-1)?.n ?? 0;
          return no(
            n > top
              ? `that chat has ${top} exchange${top === 1 ? "" : "s"}, not ${n}`
              : `exchange ${n} of that chat is gone — rewound away, or dropped from its history`,
          );
        }
        const title = ctx.store.findSession(chat)?.session.title || "untitled";
        return yes(
          exchangeText(
            ex,
            `# ${exchangeRef(chat, n)} — exchange ${n} of the "${title}" chat, ${dayOf(ex.ts)}`,
          ),
        );
      }
      const query = args.words.slice(1).join(" ").trim();
      if (!query) return no("ruri recall <words> — what to look for");
      const found = await searchProject(ctx, projectId, query, { limit: 14, floor: RECALL_FLOOR });
      const lines = found.flatMap((hit) => (hit.item.kind === "line" ? [hit.item.line] : [])).slice(0, 6);
      const hits = found
        .flatMap((hit) => (hit.item.kind === "exchange" ? [hit.item.exchange] : []))
        .slice(0, 10);
      if (hits.length === 0 && lines.length === 0) {
        return yes(
          `nothing in ${project.name}'s chats or memory matches "${query}" — try other words, or fewer`,
        );
      }
      const out: string[] = [];
      if (lines.length) {
        out.push("In the memory:");
        for (const line of lines) {
          const gone =
            line.status === "current"
              ? ""
              : ` [${line.status}${line.supersededBy ? ` by ${line.supersededBy}` : ""}${line.reason ? `: ${line.reason}` : ""}]`;
          out.push(`  ${line.id}  ${lineText(line)}${gone}`);
        }
        out.push("");
      }
      if (hits.length) {
        out.push("Exchanges, best match first:");
        for (const ex of hits) {
          out.push(`  ${exchangeRef(ex.chat, ex.n)}  ${dayOf(ex.ts)}  "${ex.title}" — ${exchangeLine(ex)}`);
        }
        out.push("", "ruri recall show <ref> prints one whole.");
      }
      return yes(out.join("\n"));
    }
  }
  return undefined;
}

/** `ruri memory …`: the memory, its log, what left it, and putting a line
 *  or a fold back. */
async function memoryCommand(
  ctx: ServerContext,
  channelId: string,
  projectId: string,
  words: string[],
  project: { name: string; path: string },
): Promise<MemoryAnswer> {
  const sub = (words[0] ?? "").toLowerCase();
  const id = words[1];
  const agent = { by: "agent" as const, chat: channelId };
  switch (sub) {
    case "":
      return yes(
        memoryText(ctx, projectId, (await gitState(project.path).then((s) => s && gitLines(s))) ?? []),
      );
    case "log":
    case "history": {
      const events = ctx.memory.history(projectId, id);
      if (events.length === 0) {
        return yes(id ? `nothing in the log for ${id}` : `${project.name}'s memory has no log yet`);
      }
      const shown = id ? events : events.slice(-40);
      return yes(
        [
          id
            ? `${id} — every change to it, oldest first:`
            : `${project.name} — the memory's log, the last ${shown.length} of ${events.length} changes, oldest first:`,
          ...shown.map(eventLine),
        ].join("\n"),
      );
    }
    case "past": {
      const past = ctx.memory.past(projectId);
      if (past.length === 0) return yes("no line has left the memory yet");
      return yes(
        [
          `${project.name} — lines that left the memory, the latest first (ruri memory restore <id> brings one back):`,
          ...past.slice(0, 60).map(pastLine),
          ...(past.length > 60
            ? [`  … and ${past.length - 60} more — ruri recall finds them by their words`]
            : []),
        ].join("\n"),
      );
    }
    case "restore": {
      if (!id) return no("ruri memory restore <id> — `ruri memory past` lists the lines that left");
      const result = ctx.memory.apply(
        projectId,
        [{ op: "restore", line: id, reason: "brought back by an agent" }],
        agent,
      );
      if (!result.events.length)
        return no(`ruri memory restore: ${result.refused[0]?.reason ?? `no line ${id}`}`);
      pushSheet(ctx, projectId);
      return yes(`${id} is back in the memory: ${lineText(result.events[0]!.after)}`);
    }
    case "undo": {
      const result = ctx.memory.undo(projectId, agent, id);
      if (!result.fold) return no("there is no fold in the log to take back");
      if (result.undone.length) pushSheet(ctx, projectId);
      return yes(
        `took fold ${result.fold} back: ${result.undone.length} line${result.undone.length === 1 ? "" : "s"} as they were before it${result.kept.length ? `; ${result.kept.join(", ")} changed since and stay as they are` : ""}`,
      );
    }
    case "check": {
      const report = await checkMemory(ctx, projectId);
      if (!report) return no("a check of this memory is running already — try again in a minute");
      const marked = [...ctx.memory.state(projectId).lines.values()]
        .filter((line) => line.status === "current" && line.check)
        .map((line) => {
          const kind = line.check!.kind ?? "stale";
          const label =
            kind === "unchecked" ? "unchecked" : kind === "conflict" ? "disagrees" : "may be stale";
          return `  ${line.id}  ${label}: ${line.check!.reason}\n      ${lineText(line)}`;
        });
      const v = report.verdicts;
      return yes(
        [
          `${project.name} — its memory held up against the code and against itself:`,
          `  ${report.checked} lines checked: ${report.stale} where something they rest on moved, ${report.unchecked} naming what the code doesn't show${report.baselined ? `, ${report.baselined} anchored for the first time` : ""}${report.misfiled ? `, ${report.misfiled} taken out as not project memory` : ""}`,
          `  the memory model: ${v.holds} hold, ${v.superseded} corrected, ${v.retired} retired, ${v.unsure} it couldn't settle`,
          ...(report.clashes.length
            ? [
                `  lines giving one setting two values: ${report.clashes.map((c) => `${c.a}/${c.b} (${c.names.join(", ")})`).join(", ")}`,
              ]
            : []),
          ...(report.conflicts.length
            ? [
                `  pairs that might disagree: ${report.conflicts.map((c) => `${c.a}/${c.b} ${c.verdict}`).join(", ")}`,
              ]
            : []),
          ...(marked.length ? ["", "Still marked:", ...marked] : ["", "Nothing is marked."]),
        ].join("\n"),
      );
    }
    case "confirm": {
      if (!id) return no("ruri memory confirm <id>");
      const result = ctx.memory.apply(projectId, [{ op: "confirm", line: id }], agent);
      if (!result.events.length)
        return no(`ruri memory confirm: ${result.refused[0]?.reason ?? `no line ${id}`}`);
      pushSheet(ctx, projectId);
      return yes(`${id} is confirmed — sessions read it now`);
    }
  }
  return no(
    `ruri memory ${sub}? — ruri memory [log [<id>] | past | restore <id> | undo [<fold>] | confirm <id> | check]`,
  );
}

/** A layer by its handle, its name, or the start of either. */
function findLayer(layers: StackLayer[], wanted: string): StackLayer | undefined {
  const key = slugify(wanted);
  const handle = (layer: StackLayer) => layer.slug ?? slugify(layer.name);
  return (
    layers.find((l) => handle(l) === key) ??
    layers.find((l) => l.name.toLowerCase() === wanted.toLowerCase()) ??
    layers.find((l) => handle(l).startsWith(key) || slugify(l.name).startsWith(key))
  );
}
