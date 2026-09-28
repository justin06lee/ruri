import * as path from "node:path";
import type { MemoryPart, StackLayer } from "../shared/protocol.js";
import { layerOfFile, memoryLineText } from "./brief.js";
import { chatByPrefix, dominantLayer, exchangeRef, pushSheet, sourceLabel } from "./catchupBrief.js";
import { ownerProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import { branchFacts, gitLines, gitState } from "./gitState.js";
import { parseArgs, slugify } from "./library.js";
import { addLine, allLines, dayOf, findLine, lineText, memoryEmpty, replaceLine } from "./memoryLines.js";
import { isEdit, runIndexCommand, runLayerCommand } from "./sheetEdits.js";
import {
  exchangeLine,
  exchangesOf,
  exchangeText,
  projectRelative,
  rank,
  rankExchanges,
  type Exchange,
} from "./recall.js";

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
                                     goes to the layer this turn's changes are in, if they are in one
  ruri memory                        the memory as it stands, each line with its id and where it came from
  ruri forget <id>                   take out a line that is wrong, or done (not one of the user's)
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

/** Every exchange in a project, every chat. */
function projectExchanges(ctx: ServerContext, projectId: string): Array<Exchange & { title: string }> {
  const project = ctx.store.get(projectId);
  if (!project) return [];
  return project.sessions.flatMap((session) =>
    exchangesOf(
      session.id,
      ctx.archive.allEvents(session.id),
      ctx.archive.summaries(session.id),
      project.name,
    ).map((ex) => ({ ...ex, title: session.title || "untitled" })),
  );
}

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
      out.push(
        `  ${line.id}  ${line.layer ? `[${line.layer}] ` : ""}${memoryLineText(line, ref ? { refs: { [line.id]: ref } } : {})}`,
      );
    }
    out.push("");
  }
  out.push("ruri recall show <ref> prints the exchange a line came from; ruri forget <id> takes a line out.");
  return out.join("\n");
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
      const { memory, line } = addLine(ctx.briefs.get(projectId).memory, part, {
        text,
        ...(why ? { why } : {}),
        date: dayOf(),
        by: "agent",
        ...(turn ? { source: { chat: channelId, turn } } : {}),
        ...(layer ? { layer } : {}),
      });
      ctx.briefs.remember(projectId, memory);
      pushSheet(ctx, projectId);
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
      return yes(
        memoryText(ctx, projectId, (await gitState(project.path).then((s) => s && gitLines(s))) ?? []),
      );

    case "forget":
    case "done": {
      const id = args.words[1];
      if (!id) return no(`ruri ${command} <id> — \`ruri memory\` lists each line's id`);
      const memory = ctx.briefs.get(projectId).memory;
      const found = findLine(memory, id);
      if (!found || !memory) return no(`no line ${id} in the memory — \`ruri memory\` lists them`);
      if (found.line.by === "user" || found.line.pinned) {
        return no(
          `${found.line.id} is the user's — they change it on the architecture page. Say so to them if it's wrong.`,
        );
      }
      ctx.briefs.remember(projectId, replaceLine(memory, found.line.id, undefined));
      pushSheet(ctx, projectId);
      return yes(`took out ${found.line.id}: ${lineText(found.line)}`);
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
        );
        const ex = exchanges[n - 1];
        if (!ex)
          return no(
            `that chat has ${exchanges.length} exchange${exchanges.length === 1 ? "" : "s"}, not ${n}`,
          );
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
      const hits = rankExchanges(projectExchanges(ctx, projectId), query, { limit: 10 });
      const memory = ctx.briefs.get(projectId).memory;
      const lines = memory
        ? rank(allLines(memory), query, ({ line }) => [[lineText(line), 1]], { limit: 4, min: 1 })
        : [];
      if (hits.length === 0 && lines.length === 0) {
        return yes(`nothing in ${project.name}'s chats matches "${query}" — try other words, or fewer`);
      }
      const out: string[] = [];
      if (lines.length) {
        out.push("In the memory:");
        for (const { item } of lines) out.push(`  ${item.line.id}  ${lineText(item.line)}`);
        out.push("");
      }
      if (hits.length) {
        out.push("Exchanges, best match first:");
        for (const { item } of hits) {
          const ex = item as Exchange & { title: string };
          out.push(`  ${exchangeRef(ex.chat, ex.n)}  ${dayOf(ex.ts)}  "${ex.title}" — ${exchangeLine(ex)}`);
        }
        out.push("", "ruri recall show <ref> prints one whole.");
      }
      return yes(out.join("\n"));
    }
  }
  return undefined;
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
