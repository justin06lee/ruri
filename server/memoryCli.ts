import type { MemoryPart } from "../shared/protocol.js";
import { memoryLineText } from "./brief.js";
import { chatByPrefix, exchangeRef, pushSheet, sourceLabel } from "./catchupBrief.js";
import { ownerProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import { branchFacts, gitLines, gitState } from "./gitState.js";
import { parseArgs } from "./library.js";
import { addLine, allLines, dayOf, findLine, lineText, memoryEmpty, replaceLine } from "./memoryLines.js";
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
 * only guess at a reason from outside. `ruri recall` searches every
 * exchange in the project, across its chats, and prints one whole; the
 * ref after each memory line is what it takes. `ruri state` is git and
 * this chat's changes, live.
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

export const MEMORY_COMMANDS = new Set(["note", "memory", "forget", "done", "state", "recall"]);

export const MEMORY_HELP = `and this project's memory — .ruri/catchup.md, which every session reads first:

  ruri note <kind> "<what>" [--why "<why>"]
                                     write down what the next session will need: kind is decision,
                                     failed, worked, trap or open. What you learned, not what you built
  ruri memory                        the memory as it stands, each line with its id and where it came from
  ruri forget <id>                   take out a line that is wrong, or done (not one of the user's)
  ruri state                         git, and what this chat has changed — live
  ruri recall <words>                search every exchange in this project, across its chats
  ruri recall show <ref>             one exchange whole; a ref is what follows a memory line: 7a3637b4#16`;

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

/** A chat's changed files, most recent first. */
function changedFiles(ctx: ServerContext, channelId: string, projectName: string): string[] {
  const seen: string[] = [];
  for (const event of [...ctx.archive.allEvents(channelId)].reverse()) {
    if (event.kind !== "tool" || !event.diff?.path) continue;
    const file = projectRelative(event.diff.path, projectName);
    if (!seen.includes(file)) seen.push(file);
  }
  return seen;
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
      out.push(`  ${line.id}  ${memoryLineText(line, ref ? { refs: { [line.id]: ref } } : {})}`);
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
      const { memory, line } = addLine(ctx.briefs.get(projectId).memory, part, {
        text,
        ...(why ? { why } : {}),
        date: dayOf(),
        by: "agent",
        ...(turn ? { source: { chat: channelId, turn } } : {}),
      });
      ctx.briefs.remember(projectId, memory);
      pushSheet(ctx, projectId);
      const missingWhy = !why && (part === "decisions" || part === "failed");
      return yes(
        `noted under "${TITLES[part]}" as ${line.id}: ${lineText(line)}` +
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

    case "state": {
      const state = await gitState(project.path);
      const out = [`${project.name} — now`, ""];
      if (state) out.push(...gitLines(state).map((l) => `- ${l}`));
      else out.push("- not a git repository (or git isn't answering)");
      const files = changedFiles(ctx, channelId, project.name);
      if (files.length) {
        out.push(
          "",
          `This chat has changed (by its edit tools, newest first — shell edits don't show): ${files.slice(0, 25).join(", ")}${files.length > 25 ? `, and ${files.length - 25} more` : ""}`,
        );
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
