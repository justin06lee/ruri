import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Attachment } from "../../shared/protocol";
import { Viewer } from "./components/Attachments";
import { markdownHtml, renderMarkdown } from "./lib/markdownHtml";
import { HTTP_BASE } from "./store";

/** Clicked — a picture in a reply, or a prompt's chip: what the viewer is
 *  asked to show. */
interface Picture {
  kind: "image" | "video" | "file";
  src: string;
  label: string;
  name: string;
  mediaType?: string;
}

/** The attachment a chip stands for: its own, or — for a region — the
 *  picture the boxes were drawn on (Composer.tsx maps them the same way). */
function chipAttachment(chip: HTMLElement, attachments: Attachment[]): Attachment | undefined {
  const n = Number(chip.dataset["n"]);
  const kind = chip.dataset["kind"];
  if (kind === "region") return attachments.find((a) => a.regions?.some((r) => r.n === n));
  return attachments.find((a) => a.kind === kind && a.n === n);
}

/** Copy-button delegation: one handler for every code block in the subtree —
 *  and a picture clicked is handed back, to open in the viewer. */
function onClick(
  e: React.MouseEvent<HTMLDivElement>,
  timersRef: RefObject<Set<number>>,
  onPicture?: (p: Picture) => void,
  attachments?: Attachment[],
): void {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLImageElement && onPicture) {
    e.preventDefault();
    const name = target.alt || target.src.split("/").pop() || "picture";
    onPicture({ kind: "image", src: target.currentSrc || target.src, label: name, name });
    return;
  }
  // a chip in a sent prompt opens what it stands for, as it did in the
  // composer — the same click, on the same-looking pill
  const chip = attachments && onPicture && target.closest<HTMLElement>(".marker-chip");
  if (chip) {
    const att = chipAttachment(chip, attachments);
    if (!att?.url) return;
    onPicture({
      kind: att.kind,
      src: HTTP_BASE + att.url,
      label: `${att.kind} #${att.n} — ${att.name}`,
      name: att.name,
      mediaType: att.mediaType,
    });
    return;
  }
  const button = target.closest(".code-copy");
  if (!(button instanceof HTMLButtonElement)) return;
  const code = button.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
  const timers = timersRef.current;
  void navigator.clipboard.writeText(code).then(() => {
    button.classList.add("copied");
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      button.classList.remove("copied");
    }, 1200);
    timers.add(timer);
  });
}

/** The "copied" flashes this block has going, cleared when it goes. */
function useCopyTimers(): RefObject<Set<number>> {
  const timers = useRef(new Set<number>());
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live) clearTimeout(timer);
      live.clear();
    };
  }, []);
  return timers;
}

export const Markdown = memo(function Markdown({
  text,
  attachments,
}: {
  text: string;
  /** A sent prompt's attachments: its [image #1] markers are drawn as the
   *  composer's chips, and a click on one opens it. */
  attachments?: Attachment[];
}) {
  const chips = Boolean(attachments?.length);
  const html = useMemo(() => renderMarkdown(text, chips), [text, chips]);
  const [picture, setPicture] = useState<Picture | null>(null);
  const timers = useCopyTimers();
  return (
    <>
      {/* sanitised by DOMPurify (lib/markdownHtml.ts) */}
      <div
        className="md"
        onClick={(e) => onClick(e, timers, setPicture, attachments)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {picture && <Viewer target={picture} onClose={() => setPicture(null)} />}
    </>
  );
});

/**
 * A reply as it is being written.
 *
 * The server lets a reply through a finished paragraph at a time
 * (server/paragraphs.ts), so this changes a few times per reply rather than
 * many times a second, and renders each version straight away. Half-finished
 * replies are never cached — they would push out the finished replies the
 * cache (lib/markdownHtml.ts) exists to keep — and the final text goes through `Markdown`
 * proper the moment the turn ends and the event replaces the draft.
 */
export function StreamingMarkdown({ text }: { text: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  const timers = useCopyTimers();
  // sanitised by DOMPurify (lib/markdownHtml.ts)
  return (
    <div className="md" onClick={(e) => onClick(e, timers)} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
