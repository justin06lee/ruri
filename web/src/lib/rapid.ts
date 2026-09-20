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
