/**
 * The window's own copies of what it just sent.
 *
 * A picture sent with a prompt is in the window already — it was in the
 * composer a moment ago — and the server's copy of it comes back as a URL
 * to fetch. Drawn from the URL, the bubble's picture would go blank and
 * load in again as the server's event replaced the window's own; over a
 * network, a visible while later. So the composer hands its copies here
 * instead of letting them go, and the transcript draws a picture from its
 * copy while there is one. The newest few are kept; the rest are let go,
 * and are fetched like any other picture.
 */

/** Attachment id → the blob URL of the file the composer held. */
const kept = new Map<string, string>();
const KEEP = 48;

/** Keep the composer's copy of a file it sent, under the attachment's id. */
export function keepLocal(attachmentId: string, objectUrl: string): void {
  const before = kept.get(attachmentId);
  if (before && before !== objectUrl) URL.revokeObjectURL(before);
  kept.delete(attachmentId);
  kept.set(attachmentId, objectUrl);
  while (kept.size > KEEP) {
    const [oldest, url] = kept.entries().next().value!;
    kept.delete(oldest);
    URL.revokeObjectURL(url);
  }
}

/** The window's own copy of an attachment, if it still has one. */
export function localSrc(attachmentId: string): string | undefined {
  return kept.get(attachmentId);
}
