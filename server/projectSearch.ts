import { shown } from "./brief.js";
import type { ServerContext } from "./context.js";
import type { Embedder } from "./embeddings.js";
import { lineText } from "./memoryLines.js";
import { linesWith, type LineRecord } from "./memoryLog.js";
import { exchangeFields, exchangeGist, exchangesOf, type Exchange } from "./recall.js";
import { hybrid, type Candidate, type Floor, type Hit, type Meaning } from "./retrieval.js";

/**
 * Everything in a project a question can be answered from — every
 * exchange of every chat, every line of the memory, and the lines that
 * left it — as candidates for one search (server/retrieval.ts). The
 * brief's pick and `ruri recall` both search the whole project: what one
 * chat found out is as likely to bear on another's next prompt as on its
 * own (the old pick read only the chat at hand).
 */

export type Found =
  { kind: "exchange"; exchange: Exchange & { title: string } } | { kind: "line"; line: LineRecord };

/** Every exchange in a project, every chat, each numbered in its chat. */
export function projectExchanges(ctx: ServerContext, projectId: string): Array<Exchange & { title: string }> {
  const project = ctx.store.get(projectId);
  if (!project) return [];
  return project.sessions.flatMap((session) =>
    exchangesOf(
      session.id,
      ctx.archive.allEvents(session.id),
      ctx.archive.summaries(session.id),
      project.name,
      ctx.archive.exchangeNumbers(session.id),
    ).map((ex) => ({ ...ex, title: session.title || "untitled" })),
  );
}

/** A memory line as its meaning is read. */
export function lineGist(line: LineRecord): string {
  return lineText(line);
}

/** The project's candidates: its exchanges, and its memory's lines — the
 *  current ones and, with `past`, the ones that left (archived only, or
 *  every kind with "all"). */
export function candidatesOf(
  ctx: ServerContext,
  projectId: string,
  options: { past?: "archived" | "all"; exchanges?: Array<Exchange & { title: string }> } = {},
): Array<Candidate<Found>> {
  const exchanges = options.exchanges ?? projectExchanges(ctx, projectId);
  const out: Array<Candidate<Found>> = exchanges.map((exchange) => ({
    item: { kind: "exchange", exchange },
    key: `${exchange.chat}#${exchange.n}`,
    text: exchangeGist(exchange),
    fields: exchangeFields(exchange),
  }));
  const state = ctx.memory.state(projectId);
  const lines = [
    ...linesWith(state).filter((line) => shown(line) && line.part !== "now"),
    ...(options.past
      ? [...state.lines.values()].filter((line) =>
          options.past === "all" ? line.status !== "current" : line.status === "archived",
        )
      : []),
  ];
  for (const line of lines) {
    out.push({
      item: { kind: "line", line },
      key: `line:${line.id}`,
      text: lineGist(line),
      fields: [[lineGist(line), 2]],
    });
  }
  return out;
}

/** The meaning side of a search, from what the embedder already has —
 *  undefined when it has nothing for the question. Never waits. */
export function cachedMeaning(embedder: Embedder | undefined, query: string): Meaning<Found> | undefined {
  if (!embedder?.usable()) return undefined;
  const q = embedder.cached(query, "query");
  if (!q) return undefined;
  return { query: q, of: (c) => embedder.cached(c.text) };
}

/** Search a project, waiting for whatever embeddings are missing (for
 *  `ruri recall`, whose asker waits anyway). */
export async function searchProject(
  ctx: ServerContext,
  projectId: string,
  query: string,
  options: { limit?: number; floor?: Floor; past?: "archived" | "all" } = {},
): Promise<Array<Hit<Found>>> {
  const candidates = candidatesOf(ctx, projectId, { past: options.past ?? "all" });
  let meaning: Meaning<Found> | undefined;
  // a stand-in context (a test, a script) may have no embedder at all
  const embedder = ctx.embedder as Embedder | undefined;
  if (embedder && (embedder.usable() || (await embedder.check()))) {
    const [q] = await embedder.embed([query], "query");
    if (q) {
      await embedder.embed(candidates.map((c) => c.text));
      meaning = { query: q, of: (c: Candidate<Found>) => embedder.cached(c.text) };
    }
  }
  return hybrid(candidates, query, {
    limit: options.limit ?? 10,
    ...(options.floor ? { floor: options.floor } : {}),
    ...(meaning ? { meaning } : {}),
  });
}

/** Have one chat's exchanges embedded, in the background — after a turn. */
export function warmChat(ctx: ServerContext, chat: string): void {
  const embedder = ctx.embedder as Embedder | undefined;
  if (!embedder?.usable()) return;
  const project = ctx.store.findSession(chat)?.project;
  if (!project) return;
  embedder.warm(
    exchangesOf(chat, ctx.archive.allEvents(chat), ctx.archive.summaries(chat), project.name).map(
      exchangeGist,
    ),
  );
}

/** Have the project's exchanges and lines embedded, in the background. */
export function warmProject(ctx: ServerContext, projectId: string): void {
  const embedder = ctx.embedder as Embedder | undefined;
  if (!embedder?.usable()) return;
  embedder.warm(candidatesOf(ctx, projectId, { past: "all" }).map((c) => c.text));
}
