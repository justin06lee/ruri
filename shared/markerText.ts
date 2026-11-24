/**
 * A prompt's attachment markers, as text every reader takes.
 *
 * The window's composer keeps the space inside a marker unbreakable (a
 * no-break space, U+00A0) so a chip never wraps in two, and saves its draft
 * that way. Everything else — the model, the phone, a search for
 * "[image #1]" — reads a marker with a plain space.
 */
export function plainMarkers(text: string): string {
  return text.replace(/\[(image|video|file|region)\u00a0#(\d+)\]/g, "[$1 #$2]");
}
