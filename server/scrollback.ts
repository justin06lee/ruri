/**
 * A shell's scrollback, kept as the chunks it arrived in.
 *
 * It used to be one string, re-made on every chunk the shell printed:
 *
 *     buffer = (buffer + text).slice(-SCROLLBACK)
 *
 * which copies the whole scrollback — up to the budget — for every write a
 * pty makes. A build printing a few hundred lines a second therefore moved
 * tens of megabytes a second through the allocator to keep two hundred
 * kilobytes of text, and the cost rose with how much the shell had already
 * said rather than with how much it just said.
 *
 * Here the chunks are kept as they came. An append pushes one and, when the
 * budget is passed, drops whole chunks off the front — cutting into one only
 * for the partial chunk at the boundary. Both are O(what just arrived).
 * The joined string is made only when somebody asks to read it (a window
 * attaching to the tab), and kept until the next append.
 */

/** Chunks smaller than this are merged into the one before, so a shell
 *  printing a byte at a time does not make an array entry per byte. */
const MERGE_UNDER = 4096;

/** Slots left behind by dropped chunks are reclaimed once they are both
 *  numerous and most of the array — amortising the copy to O(1) per chunk. */
const COMPACT_SLOTS = 64;

/**
 * Held text, oldest first, capped at `max` UTF-16 code units — the unit the
 * single-string version counted in, so a tab keeps exactly as much as it did.
 */
export class Scrollback {
  private chunks: string[] = [];
  /** Index of the oldest chunk still held; everything before it is dropped. */
  private first = 0;
  /** Code units cut from the front of `chunks[first]`. */
  private cut = 0;
  /** Code units held, `cut` already taken off. */
  private held = 0;
  private joined: string | undefined = "";

  constructor(private readonly max: number) {}

  /** What the shell has printed, oldest first. */
  read(): string {
    if (this.joined !== undefined) return this.joined;
    const parts = this.chunks.slice(this.first);
    if (parts.length > 0 && this.cut > 0) parts[0] = parts[0]!.slice(this.cut);
    this.joined = parts.join("");
    return this.joined;
  }

  /** How much is held, in the units `max` is given in. */
  get length(): number {
    return this.held;
  }

  push(text: string): void {
    if (text.length === 0 || this.max <= 0) return;
    this.joined = undefined;

    // One chunk longer than the whole budget is the whole scrollback: its
    // tail is all that would survive the trim below anyway, and detaching
    // it lets the rest of a megabyte-long write be collected at once.
    if (text.length >= this.max) {
      const from = alignForward(text, text.length - this.max);
      this.chunks = [detach(text.slice(from))];
      this.first = 0;
      this.cut = 0;
      this.held = text.length - from;
      return;
    }

    const last = this.chunks.length - 1;
    const previous = last >= this.first ? this.chunks[last] : undefined;
    if (previous !== undefined && previous.length + text.length <= MERGE_UNDER) {
      this.chunks[last] = previous + text;
    } else {
      this.chunks.push(text);
    }
    this.held += text.length;
    this.trim();
  }

  /** Nothing kept — the tab's shell is gone. */
  clear(): void {
    this.chunks = [];
    this.first = 0;
    this.cut = 0;
    this.held = 0;
    this.joined = "";
  }

  /** Drop from the front until the budget holds. */
  private trim(): void {
    while (this.held > this.max) {
      const front = this.chunks[this.first]!;
      const alive = front.length - this.cut;
      const over = this.held - this.max;
      if (over < alive) {
        // The boundary falls inside this chunk: move the mark rather than
        // re-making the string, and never between a surrogate pair.
        const at = alignForward(front, this.cut + over);
        this.held -= at - this.cut;
        this.cut = at;
        break;
      }
      this.chunks[this.first] = "";
      this.first += 1;
      this.cut = 0;
      this.held -= alive;
    }
    if (this.first >= COMPACT_SLOTS && this.first * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.first);
      this.first = 0;
    }
  }
}

/**
 * The first whole character at or after `at`.
 *
 * Cutting a scrollback to its budget can land between the two halves of an
 * astral character — an emoji, most of CJK's rarer half — and half of one
 * renders as a replacement glyph in the terminal that reads it. One code
 * unit less of history is the cheaper loss.
 */
function alignForward(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at + 1 : at;
}

/**
 * A copy that holds nothing but itself.
 *
 * `slice` hands back a view onto the string it was taken from, which keeps
 * the whole of that string alive — so slicing the tail off a ten-megabyte
 * write would pin all ten megabytes for as long as the tail is held. Round
 * tripping through a buffer makes a string that owns its own characters.
 */
function detach(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}
