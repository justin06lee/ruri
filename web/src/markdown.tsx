import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Viewer } from "./components/Attachments";
import { markdownHtml, renderMarkdown } from "./lib/markdownHtml";

/** A picture in a reply, clicked: what the viewer is asked to show. */
interface Picture {
  src: string;
  name: string;
}

/** Copy-button delegation: one handler for every code block in the subtree —
 *  and a picture clicked is handed back, to open in the viewer. */
function onClick(
  e: React.MouseEvent<HTMLDivElement>,
  timersRef: RefObject<Set<number>>,
  onPicture?: (p: Picture) => void,
): void {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLImageElement && onPicture) {
    e.preventDefault();
    onPicture({
      src: target.currentSrc || target.src,
      name: target.alt || target.src.split("/").pop() || "picture",
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const [picture, setPicture] = useState<Picture | null>(null);
  const timers = useCopyTimers();
  return (
    <>
      {/* sanitised by DOMPurify (lib/markdownHtml.ts) */}
      <div
        className="md"
        onClick={(e) => onClick(e, timers, setPicture)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {picture && (
        <Viewer
          target={{ kind: "image", src: picture.src, label: picture.name, name: picture.name }}
          onClose={() => setPicture(null)}
        />
      )}
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
