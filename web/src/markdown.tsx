import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Attachment } from "../../shared/protocol";
import { Viewer } from "./components/Attachments";
import { createStreamingBlocks, renderMarkdown } from "./lib/markdownHtml";
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

/** Sanitised HTML as nodes, ready to go into the page. */
function nodesOf(html: string): DocumentFragment {
  const template = document.createElement("template");
  // sanitised by DOMPurify (lib/markdownHtml.ts)
  template.innerHTML = html;
  return template.content;
}

/**
 * A reply as it is being written.
 *
 * The server lets a reply through a finished paragraph at a time
 * (server/paragraphs.ts). Each used to re-render the whole reply and hand
 * it to the page as one string, which threw every node of it away and laid
 * the lot out again — on a long reply, most of what streaming cost. Now each
 * finished block is rendered once (createStreamingBlocks) and put into the
 * page once, and only the block still being written is replaced, so a new
 * paragraph costs the parsing and the layout of that paragraph. React draws
 * the box and never its contents; this effect does, before the transcript
 * measures itself to follow the reply down (ChatPane). Half-finished
 * replies are never cached, and the final text goes through `Markdown`
 * proper the moment the turn ends and the event replaces the draft.
 */
export function StreamingMarkdown({ text }: { text: string }) {
  // a lazy initialiser, so the reply gets one renderer for its whole life
  const [render] = useState(createStreamingBlocks);
  const box = useRef<HTMLDivElement>(null);
  /** The nodes of the block still being written, replaced each step. */
  const live = useRef<ChildNode[]>([]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const step = render(text);
    if (step.reset) el.replaceChildren();
    else for (const node of live.current) node.remove();
    for (const piece of step.add) el.append(nodesOf(piece));
    const tail = nodesOf(step.live);
    live.current = [...tail.childNodes];
    el.append(tail);
  }, [render, text]);
  const timers = useCopyTimers();
  return <div ref={box} className="md" onClick={(e) => onClick(e, timers)} />;
}
