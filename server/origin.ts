/**
 * Who prompted the turn a chat is on: the user, or another agent.
 *
 * A human prompt is one the user wrote; an agent prompt is a message from
 * another chat's model (server/talk.ts). The two are told apart by what the
 * server itself wrote on the prompt when it delivered it — the user event's
 * `from` — never by anything the prompt says, so a prompt cannot claim to be
 * the user's, or another agent's.
 *
 * It matters for who hears about the turn: an agent prompt's answer, its
 * failure and — when the user trusts that agent (server/trusted.ts) — its
 * cards go to the agent that sent it; a human prompt's go to the user.
 */
import type { LetterFrom, TranscriptEvent } from "../shared/protocol.js";

export type Origin = { by: "human" } | { by: "agent"; chat: string };

/** The little of the server this reads. */
export interface OriginWorld {
  archive: { events(chat: string): TranscriptEvent[] };
  talk?: { pending?: { get(id: string): { from: string } | undefined } };
}

/** ruri's own prompt sending a chat back to the work a message stopped
 *  (talk.ts resumePrompt): whose work that was is told by the prompt
 *  before the ones that cut in. */
const BACK_TO_WORK = "↩";

/** Whose a prompt carrying `from` is: the sender's — or, for an answer
 *  coming back, the agent this chat asked it on behalf of. An answer to a
 *  question the chat asked for itself is its own business: the user's. */
function sender(world: OriginWorld, from: LetterFrom): Origin {
  if (!from.answer) return { by: "agent", chat: from.agent };
  const owed = from.owes ? world.talk?.pending?.get(from.owes) : undefined;
  return owed ? { by: "agent", chat: owed.from } : { by: "human" };
}

/**
 * Who prompted the turn `chat` is on (or was last on). Anything that
 * cannot be told is the user's: they are who everything falls back to.
 */
export function promptedBy(world: OriginWorld, chat: string): Origin {
  const events = world.archive.events(chat);
  let resumed = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== "user") continue;
    const from = event.from;
    if (!from) {
      if (event.text.startsWith(BACK_TO_WORK)) {
        resumed = true;
        continue;
      }
      return { by: "human" };
    }
    // back at work a message stopped: past what cut in, to the work itself
    if (resumed && from.cutIn) continue;
    return sender(world, from);
  }
  return { by: "human" };
}
