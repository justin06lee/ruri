/**
 * A reply, paragraph by paragraph.
 *
 * The harnesses stream a reply a token at a time, and forwarding each token
 * as it came meant twenty-odd messages a second to the window for as long as
 * a reply lasted — every one of them re-rendering the conversation and
 * re-parsing the whole reply so far as markdown. Nobody reads a sentence
 * half-written, so the gate holds the text back and lets it through a
 * finished paragraph at a time: at a blank line, or when a code block closes
 * (a blank line inside a code block is still the same block). Whatever is
 * left when the message ends arrives with the finished message itself.
 */
export class ParagraphGate {
  /** Received and not yet let through. */
  private held = "";
  /** How much of `held` has been read line by line. */
  private scanned = 0;
  /** The fence that opened the code block we're in ("```", "~~~~"), if any. */
  private fence: string | null = null;

  /** Take the next piece of the stream; returns what may be shown now. */
  push(delta: string): string {
    this.held += delta;
    let release = 0;
    for (;;) {
      const end = this.held.indexOf("\n", this.scanned);
      if (end === -1) break;
      const line = this.held.slice(this.scanned, end).trim();
      this.scanned = end + 1;
      const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && !this.fence) {
        this.fence = marker;
      } else if (marker && this.fence && marker[0] === this.fence[0] && marker.length >= this.fence.length && line === marker) {
        this.fence = null;
        release = this.scanned;
      } else if (!this.fence && line === "") {
        release = this.scanned;
      }
    }
    if (release === 0) return "";
    const out = this.held.slice(0, release);
    // a blank line on its own (after a code block closes) is not a
    // paragraph — it waits and goes out with the one that follows
    if (out.trim() === "") return "";
    this.held = this.held.slice(release);
    this.scanned -= release;
    return out;
  }

  /** Everything still held back, for a stream that ends mid-paragraph. */
  flush(): string {
    const out = this.held;
    this.held = "";
    this.scanned = 0;
    this.fence = null;
    return out;
  }
}
