/**
 * What Home says over its empty chat — a list of lines, one said at a time,
 * taking turns a launch at a time. The shape and nothing live: a stored
 * list read back, checked, since it comes off disk. The window's copy is
 * ../greetings.ts; Settings → Greeting edits it.
 *
 * They used to be one field of the hero face's preference (`ruri-hero`,
 * the face over an empty chat, since retired); a list kept there is read
 * until one is kept under its own key.
 */

export const MAX_GREETINGS = 20;
export const GREETING_CHARS = 80;
export const DEFAULT_GREETINGS: readonly string[] = ["sup."];

/** Lines as the user left them: trimmed, clipped, no blanks, no more than fit. */
export function cleanGreetings(lines: readonly unknown[]): string[] {
  return lines
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.trim().slice(0, GREETING_CHARS))
    .filter(Boolean)
    .slice(0, MAX_GREETINGS);
}

/** What a textarea holds, one greeting to a line. */
export function greetingsFromText(text: string): string[] {
  return cleanGreetings(text.split("\n"));
}

function listIn(raw: string | null, field?: string): string[] | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    const list = field
      ? data && typeof data === "object"
        ? (data as Record<string, unknown>)[field]
        : undefined
      : data;
    return Array.isArray(list) ? cleanGreetings(list) : null;
  } catch {
    return null;
  }
}

/**
 * The greetings kept: the list under its own key; else the one the hero
 * face's preference held; else "sup.". An empty list is a choice — no
 * title on Home — and is kept as one.
 */
export function parseGreetings(stored: string | null, legacyHero: string | null = null): string[] {
  return listIn(stored) ?? listIn(legacyHero, "greetings") ?? [...DEFAULT_GREETINGS];
}

/** The line said: one always, several in turn by `roll` (0–1, drawn once
 *  a launch). Nothing when there are none. */
export function pickGreeting(lines: readonly string[], roll: number): string {
  if (lines.length === 0) return "";
  return lines[Math.floor(roll * lines.length) % lines.length]!;
}
