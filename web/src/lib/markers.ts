/**
 * The composer's markers — [image #1] and the /commands — as text: finding
 * them, spacing them, moving and removing them. Pure string work, kept
 * apart from the mirror that draws them (components/Markers.tsx) so it can
 * be tested without a DOM, and so that file exports only its component.
 *
 * fitBox is here too: it is not a component, and the mirror and the
 * composer both lean on the height it records.
 */

/** A marker as written in the prompt. */
export interface Marker {
  kind: "image" | "video" | "file" | "region" | "command";
  /** The attachment's number; 0 for a command. */
  n: number;
  start: number;
  end: number;
  /** The marker's own characters. */
  text: string;
}

/** The space inside a marker, as the composer writes it. */
export const MARKER_SPACE = "\u00a0";

/** How far outside its characters a chip's pill is painted — the mirror
 *  keeps this much room on either side so the pill is never cut off at the
 *  edge of the box. Matches the ring in `.marker-chip`, with a pixel over. */
export const CHIP_BLEED = 3;

/**
 * An attachment marker with either space inside, or a slash command: a
 * word starting with "/" that stands on its own — not a path ("/tmp/x"
 * has a second slash), not a quoted mention ('/compact' has a quote against
 * the slash, not whitespace), not the tail of a URL — and not one still
 * being typed: a command is a chip once a space (or a line break) follows
 * it, so "/comm" on its way to "/commit" stays words under the caret.
 */
const MARKER = /\[(image|video|file|region)[ \u00a0]#(\d+)\]|(?<=^|\s)\/([a-z0-9][\w:.-]*)(?=\s)/g;

export function findMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const match of text.matchAll(MARKER)) {
    if (match[3] !== undefined) {
      out.push({
        kind: "command",
        n: 0,
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
      continue;
    }
    out.push({
      kind: match[1] as Marker["kind"],
      n: Number(match[2]),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  return out;
}

/** The marker text for an attachment, spaced so the textarea never wraps it in half. */
export function markerText(kind: "image" | "video" | "file" | "region", n: number): string {
  return `[${kind}${MARKER_SPACE}#${n}]`;
}

/** Markers with plain spaces inside, made unbreakable. Same length, so no
 *  caret moves. */
function bindMarkers(text: string): string {
  return text.replace(/\[(image|video|file|region) #(\d+)\]/g, `[$1${MARKER_SPACE}#$2]`);
}

/** Spaces between two slash commands standing side by side. One leaves
 *  their pills 0.6px apart, which reads as a single wide chip; this is what
 *  looks like two things. Anything wider that is already there is left
 *  alone. */
const CHIP_GAP = 3;

/** Whether a marker is an attachment's — the ones that carry their own
 *  spaces and that the caret never goes into. */
const isAttachment = (marker: Marker) => marker.kind !== "command";

/**
 * The prompt with the right amount of space around every chip.
 *
 * An attachment's marker always has exactly one space on either side —
 * none before it at the start of a line, where there is nothing to hold it
 * apart from — so the tag and its two spaces are one thing, which the
 * caret steps over whole (`snapSelection`) and a delete takes whole
 * (`markerSpan`). Two side by side keep a space each. Extra spaces typed
 * against one are taken back out; missing ones are put in.
 *
 * A slash command is the words the person typed, and only ever gets more:
 * `CHIP_GAP` between it and a command after it, nothing pushed into one
 * being written.
 *
 * Returns the new text and where a caret at `caret` now stands. A caret
 * that was in a run of spaces against a tag comes out on the outside of
 * the tag's space — to its left before a tag, to its right after one.
 */
export function spaceMarkers(text: string, caret = 0): { text: string; caret: number } {
  const markers = findMarkers(text);
  if (markers.length === 0) return { text, caret };
  const ends = new Map(markers.map((marker) => [marker.end, marker]));
  const starts = new Map(markers.map((marker) => [marker.start, marker]));
  /** Each run of plain spaces against a chip: where it starts and ends, how
   *  long it should be, and where a caret inside it belongs. */
  const gaps = new Map<number, { end: number; want: number; exact: boolean; home: (gs: number) => number }>();
  const runAt = (from: number) => {
    let gs = from;
    while (text[gs - 1] === " ") gs -= 1;
    let ge = from;
    while (text[ge] === " ") ge += 1;
    return { gs, ge };
  };
  for (const marker of markers) {
    for (const side of ["left", "right"] as const) {
      const { gs, ge } = runAt(side === "left" ? marker.start : marker.end);
      if (gaps.has(gs)) continue;
      const leftChip = ends.get(gs);
      const rightChip = starts.get(ge);
      const leftTag = leftChip !== undefined && isAttachment(leftChip);
      const rightTag = rightChip !== undefined && isAttachment(rightChip);
      if (leftTag || rightTag) {
        const lineStart = gs === 0 || text[gs - 1] === "\n";
        // a space each between two chips; none before a tag at a line's start
        const want = leftChip && rightChip ? 2 : rightTag && lineStart ? 0 : 1;
        // before a tag the caret goes out to the left of its space, after
        // one to the right of it — between two, that is the same place
        const home = leftTag
          ? (s: number) => s + Math.min(1, want)
          : (s: number) => s + Math.max(0, want - 1);
        gaps.set(gs, { end: ge, want, exact: true, home });
        continue;
      }
      // a command's after side: held apart from a command after it
      if (side === "right" && rightChip !== undefined) {
        gaps.set(gs, { end: ge, want: Math.max(CHIP_GAP, ge - gs), exact: false, home: () => -1 });
      }
    }
  }
  let out = "";
  let at = 0;
  let shift = 0;
  let moved: number | null = caret < 0 ? caret : null;
  for (const gs of [...gaps.keys()].sort((a, b) => a - b)) {
    const gap = gaps.get(gs)!;
    if (moved === null && caret < gs) moved = caret + shift;
    if (moved === null && caret <= gap.end) {
      const home = gap.exact ? gap.home(gs + shift) : -1;
      // a command's gap only ever grows at its far end, so a caret in it stays
      moved = home >= 0 ? home : caret + shift;
    }
    out += text.slice(at, gs) + " ".repeat(gap.want);
    at = gap.end;
    shift += gap.want - (gap.end - gs);
  }
  if (moved === null) moved = caret + shift;
  return { text: out + text.slice(at), caret: moved };
}

/**
 * The stretch of the prompt an attachment's tag owns: the tag and the one
 * space either side of it. The caret is never inside it, and a backspace
 * or delete that reaches into it takes the whole of it.
 */
export function markerSpan(text: string, marker: Marker): { start: number; end: number } {
  return {
    start: text[marker.start - 1] === " " ? marker.start - 1 : marker.start,
    end: text[marker.end] === " " ? marker.end + 1 : marker.end,
  };
}

/**
 * A selection moved out of every tag it landed in.
 *
 * A caret that stepped into one from outside goes on through it — moving
 * right past its left space lands it after its right space, and the other
 * way round — and one put down inside by a click (`from` null) goes to the
 * nearer edge, the left one when it is a tie: a click between the left
 * space and the tag is a caret before the space. A selection grows to take
 * in the whole of any tag it ends in. Null when nothing needs to move.
 */
export function snapSelection(
  text: string,
  markers: Marker[],
  start: number,
  end: number,
  from: number | null,
): { start: number; end: number } | null {
  const spans = markers.filter(isAttachment).map((marker) => markerSpan(text, marker));
  const inside = (at: number) => spans.find((span) => at > span.start && at < span.end);
  if (start === end) {
    const span = inside(start);
    if (!span) return null;
    let to: number;
    if (from !== null && from <= span.start && start > from) to = span.end;
    else if (from !== null && from >= span.end && start < from) to = span.start;
    else to = start - span.start <= span.end - start ? span.start : span.end;
    return { start: to, end: to };
  }
  const a = inside(start);
  const b = inside(end);
  if (!a && !b) return null;
  return { start: a ? a.start : start, end: b ? b.end : end };
}

/** The prompt as it is sent: the space a chip was held apart from its
 *  neighbour by is the composer's doing, not something typed, so a run
 *  between two chips comes back down to the one space it reads as. */
function closeMarkerGaps(text: string): string {
  const markers = findMarkers(text);
  let out = "";
  let at = 0;
  for (let i = 0; i < markers.length - 1; i += 1) {
    const gap = text.slice(markers[i]!.end, markers[i + 1]!.start);
    if (gap.length < 2 || /[^ ]/.test(gap)) continue;
    out += text.slice(at, markers[i]!.end) + " ";
    at = markers[i + 1]!.start;
  }
  return out + text.slice(at);
}

/** Markers as the composer keeps them: the space inside each made
 *  unbreakable (a rewound prompt, a queued one, a saved draft from before
 *  this arrive with plain ones), and a space kept between a marker and the
 *  word against it. */
export function holdMarkers(text: string): string {
  return spaceMarkers(bindMarkers(text)).text;
}

/** The same for text the caret is in: what it becomes, and where the caret
 *  belongs in it. */
export function holdMarkersAt(text: string, caret: number): { text: string; caret: number } {
  return spaceMarkers(bindMarkers(text), caret);
}

/** The prompt as it goes out: markers with plain spaces, the way every
 *  reader of them expects. */
export function releaseMarkers(text: string): string {
  return closeMarkerGaps(text).replace(/\[(image|video|file|region)\u00a0#(\d+)\]/g, "[$1 #$2]");
}

/**
 * Whether a backspace at `at` is aimed at `marker`.
 *
 * Inside a chip, or right after it, is the whole chip — the same rule the
 * attachment markers have always had. Commands need one more position: the
 * space that finishes a command is what makes it a chip at all (see
 * MARKER), the composer types it along with the name, and so the caret
 * comes to rest one past the marker's end. Without this the first
 * backspace ate only that space, which un-chipped the command and left it
 * lying there as words to be deleted a letter at a time.
 */
export function backspaceHits(text: string, marker: Marker, at: number): boolean {
  if (isAttachment(marker)) {
    const span = markerSpan(text, marker);
    return at > span.start && at <= span.end;
  }
  if (at > marker.start && at <= marker.end) return true;
  return marker.kind === "command" && at === marker.end + 1 && text[marker.end] === " ";
}

/**
 * The prompt with one marker taken out, along with the space that separated
 * it from its neighbour — all of it, since a chip beside a chip is held
 * apart by more than one — so the words either side close up cleanly.
 * Returns the new text and where the caret belongs: where the marker was.
 */
export function removeMarker(text: string, marker: Marker): { text: string; caret: number } {
  let cutEnd = marker.end;
  while (text[cutEnd] === " ") cutEnd += 1;
  let cutStart = marker.start;
  if (cutEnd === marker.end) while (text[cutStart - 1] === " ") cutStart -= 1;
  return { text: text.slice(0, cutStart) + text.slice(cutEnd), caret: cutStart };
}

/** The prompt with every marker `drop` says yes to taken out. */
export function stripMarkers(text: string, drop: (marker: Marker) => boolean): string {
  let out = text;
  // from the end, so the earlier markers' positions stay true — and the
  // spacing is settled once at the end, for the same reason
  for (const marker of findMarkers(text).filter(drop).reverse()) out = removeMarker(out, marker).text;
  return spaceMarkers(out).text;
}

/**
 * The prompt with one marker moved: taken out where it was (with the one
 * space that separated it from its neighbour) and put down at `to`, with a
 * space on whichever side needs one — the same spacing a fresh marker gets.
 * Returns the new text and where the caret belongs: right after the chip.
 */
export function moveMarker(text: string, marker: Marker, to: number): { text: string; caret: number } {
  const word = text.slice(marker.start, marker.end);
  let cutEnd = marker.end;
  while (text[cutEnd] === " ") cutEnd += 1;
  let cutStart = marker.start;
  if (cutEnd === marker.end) while (text[cutStart - 1] === " ") cutStart -= 1;
  const cut = text.slice(0, cutStart) + text.slice(cutEnd);
  let at = to <= cutStart ? to : to >= cutEnd ? to - (cutEnd - cutStart) : cutStart;
  // a drop inside a word lands at the word's nearer edge: a chip between
  // "he" and "re" is never what was meant
  if (/\S/.test(cut[at - 1] ?? " ") && /\S/.test(cut[at] ?? " ")) {
    let left = at;
    while (left > 0 && /\S/.test(cut[left - 1]!)) left -= 1;
    let right = at;
    while (right < cut.length && /\S/.test(cut[right]!)) right += 1;
    at = at - left <= right - at ? left : right;
  }
  const before = cut.slice(0, at);
  const after = cut.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^\s/.test(after) ? " " : "";
  // the chip has landed among words that may be chips themselves; the
  // spacing rules settle what stands either side of it
  return spaceMarkers(`${before}${lead}${word}${tail}${after}`, before.length + lead.length + word.length);
}

/**
 * The text's true height in a box the browser sizes to its words
 * (`field-sizing: content`), for the chip mirror to check itself against.
 * A box under its cap is exactly as tall as its text — the browser made it
 * so — and costs nothing to ask. Only one held at its cap, scrolling, has
 * to be measured, the way `fitBox` does and for the same reasons, and its
 * height is handed back to the stylesheet after.
 */
export function textHeight(area: HTMLTextAreaElement): number {
  const cap = parseFloat(getComputedStyle(area).maxHeight);
  if (!(area.offsetHeight >= cap - 1)) return area.clientHeight;
  const height = fitBox(area, cap);
  area.style.height = "";
  fitted.delete(area);
  return height;
}

/** How tall each textarea's text really is, as last fitted (see `fitBox`). */
const fitted = new WeakMap<HTMLTextAreaElement, number>();

/** The text's true height as `fitBox` last measured it, if it has. */
export function fittedHeight(area: HTMLTextAreaElement): number | undefined {
  return fitted.get(area);
}

/**
 * Fit a textarea to its text, no taller than `cap`, and return the text's
 * true height.
 *
 * The obvious measure, `scrollHeight`, lies: a textarea is a scroll
 * container, and Chromium keeps room in its scrollable overflow for the
 * caret — a line whose last glyph ends within about three pixels of the
 * right edge counts one extra line of overflow, one per such line ending
 * at a newline or the end of the prompt, none of it drawn. The words wrap
 * exactly as they do anywhere else; only the number is off. So the box was
 * fitted a line too tall now and then, and the mirror — which draws the
 * same words the same way and measures its own height honestly — was told
 * it disagreed, and took the chips off a prompt whose line happened to end
 * flush with the edge. With overflow hidden there is no scroll container
 * and no room kept, and `scrollHeight` is the text's height. The box is
 * measured that way, for a moment, and put back.
 *
 * One catch: a box taller than `cap` scrolls, and where the scrollbar is
 * the classic kind it takes width from the words, which then wrap sooner.
 * The first measure has no scrollbar. If it comes out over the cap, the
 * box is given its height and looked at again with the scrollbar's width
 * taken out of the words the same way.
 */
export function fitBox(area: HTMLTextAreaElement, cap: number): number {
  const top = area.scrollTop;
  const measure = () => {
    area.style.overflow = "hidden";
    area.style.height = "auto";
    const h = area.scrollHeight;
    area.style.overflow = "";
    return h;
  };
  let height = measure();
  area.style.height = `${Math.min(height, cap)}px`;
  if (height > cap) {
    const bar = area.offsetWidth - area.clientWidth - area.clientLeft * 2;
    if (bar > 0) {
      const pad = area.style.paddingRight;
      area.style.paddingRight = `${parseFloat(getComputedStyle(area).paddingRight) + bar}px`;
      height = measure();
      area.style.paddingRight = pad;
      area.style.height = `${Math.min(height, cap)}px`;
    }
  }
  area.scrollTop = top;
  fitted.set(area, height);
  return height;
}
