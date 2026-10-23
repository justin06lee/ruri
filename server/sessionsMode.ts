import { SESSIONS_MODE_PREF } from "../shared/protocol.js";
import type { PrefStore } from "./prefs.js";

/**
 * Sessions or Team: the one global switch behind how a project runs.
 *
 * Sessions (the default) is a project as a list of ordinary chats, each one
 * a full-power session that runs only when it is sent a message. Team is a
 * project as its lead with a team behind it (server/team.ts, workers.ts,
 * talk.ts): kept whole in the tree, dormant until this pref says "team".
 * Read live, so flipping it needs no restart; web/src/prefs.ts reads the
 * same key.
 */

export function sessionsMode(ctx: { prefs: Pick<PrefStore, "all"> }): boolean {
  return ctx.prefs.all()[SESSIONS_MODE_PREF] !== "team";
}
