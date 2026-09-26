/**
 * Who stands in the rapid fire line, and in what order.
 *
 * Pure, and kept apart from the line itself (components/RapidFire.tsx), so
 * the two rules that decide what you are handed can be checked without a
 * store or a DOM:
 *
 * - A hidden project is never in the line. It is out of the sidebar and out
 *   of the switcher; being handed one to prompt is the one way it could
 *   come back uninvited, so the filter is first and nothing overrides it.
 * - "Starred only" narrows what is left, and is a filter on top of hidden,
 *   never instead of it. Off, the line is every open project, starred ones
 *   first — the order the sidebar shows them in either way.
 */
import type { ProjectStatus } from "../../../shared/protocol";

/** As much of a project as the line cares about. */
export interface LineProject {
  hidden?: boolean;
  starred?: boolean;
  sessions: { id: string }[];
}

export interface Line {
  /** Every session in the line, in the order it goes round them. */
  ids: string[];
  /** The ones that could take a prompt right now. */
  ready: string[];
}

export function lineOf(
  projects: LineProject[],
  statuses: Record<string, ProjectStatus>,
  starredOnly = false,
): Line {
  const inLine = projects.filter((p) => !p.hidden && (!starredOnly || p.starred));
  const ids = [...inLine.filter((p) => p.starred), ...inLine.filter((p) => !p.starred)].flatMap((project) =>
    project.sessions.map((session) => session.id),
  );
  return { ids, ready: ids.filter((id) => (statuses[id] ?? "idle") !== "working") };
}

/**
 * The next session ready for a prompt, going round the line from `from` —
 * never `from` itself: a hand-off that comes back to the session it left
 * would fade the chat out and straight back in, and the prompt just sent
 * there can still read as ready for the moment before its turn is reported.
 * From outside the line (entering it, or a session that has left), the
 * first one ready.
 */
export function nextAfter(line: Line, from: string | undefined): string | undefined {
  if (line.ready.length === 0) return undefined;
  const at = from ? line.ids.indexOf(from) : -1;
  if (at === -1) return line.ready[0];
  for (let step = 1; step < line.ids.length; step++) {
    const candidate = line.ids[(at + step) % line.ids.length]!;
    if (line.ready.includes(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Where the line's pick should be, given where it is: unchanged while that
 * session can still take a prompt. Entering the line from a session that
 * could take one starts there. Nobody else waiting, it stays on this one to
 * watch it finish — but only while it is still in the line: narrowed to the
 * starred, hidden away or closed, it is not the line's to hand back.
 */
export function repick(line: Line, current: string | undefined, activeId: string | null): string | undefined {
  if (current && line.ready.includes(current)) return current;
  const next =
    current === undefined && activeId && line.ready.includes(activeId) ? activeId : nextAfter(line, current);
  return next ?? (current && line.ids.includes(current) ? current : undefined);
}
