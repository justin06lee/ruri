import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { searchComponents, stem, words as wordsIn } from "../../../shared/librarySearch";
import { componentStale, type Attachment, type ComponentFile, type NamedComponent } from "../../../shared/protocol";
import { Viewer } from "./Attachments";
import { useConfirm } from "./Confirm";
import { fileToBase64 } from "../lib/files";
import { highlightFor } from "../lib/highlighter";
import { useNoteStale } from "../lib/runNote";
import { spinStar } from "../lib/spin";
import { probe, useGone, useThumb } from "../lib/thumbs";
import { HTTP_BASE, send, useRuri } from "../store";

/**
 * The component library: every piece of a project's interface, as a
 * gallery — each one with its picture, the user's name for it, and the
 * handle an agent installs it by — and each one opens onto its details
 * and its code.
 *
 * Every project has its own. Half of every "no, the OTHER one" is a naming
 * problem — the user says "the dragon gauges" and the model reads a
 * repository that has never used those words — so an entry fixes the words
 * to an address: files, a note, a picture. The other half of it is agents
 * building the same card twice, so the library is also something they
 * draw from, shadcn-style, with the `ruri` command every session has
 * (server/library.ts): `ruri search`, `ruri show`, `ruri add` to copy one
 * into place, `ruri register` to put back what they build.
 *
 * Entries arrive three ways. A session that has just built something names
 * it (a card comes up in the chat with its suggested name, and what the
 * user confirms is the entry), or registers it from its shell. And the
 * button at the top reads the whole repo and names what nobody has — the
 * only way in for what was built before any of this (server/sweep.ts).
 *
 * The same button keeps it true: entries whose files moved or went are
 * re-pointed or retired, notes the code has outgrown are rewritten, and
 * everything without a current picture gets one — photographed by selector
 * where that reaches, and by an agent in a "Library pictures" chat where it
 * doesn't (server/handlers/components.ts). A card whose code changed after
 * its picture says so. Correcting any of it is what this page is for.
 *
 * A library runs to hundreds, so the gallery is built for finding: a search
 * that marks what it matched (the same search as `ruri search`), chips
 * that narrow it to what is new, names nobody has kept, what needs a
 * picture, what is out of date and what has lost its files, arrow keys
 * through the cards, and a way back that lands where you left.
 * Its cards show small copies of the pictures (lib/thumbs.ts), never the
 * screenshots themselves.
 *
 * Interface only — screens, panels, cards, controls. Backend code has no
 * place in a component library, and nothing puts it here.
 *
 * New entries wear a spinning star until they've been seen: beside the name
 * for what the last prompt named, and hooked over the card's top-left
 * corner for what's been waiting longer. Looking at them is what takes it
 * off — hover one, or simply leave the page.
 */

/** Comma-or-newline separated, the way people actually type lists. */
function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * How to find a component in the running app, written as one path:
 *
 *   /settings >> .tab-advanced >> .danger-zone
 *
 * A leading segment starting with "/" is the page to open; the last is the
 * thing itself; anything between is clicked on the way. One field, because
 * three fields for "where is it" would be three fields nobody fills in —
 * and this is what the screenshot pass follows, so it has to be typeable
 * when the sweep's guess was wrong.
 */
function parsePath(value: string): { selector: string; route: string; clicks: string[] } {
  const parts = value
    .split(">>")
    .map((part) => part.trim())
    .filter(Boolean);
  const route = parts[0]?.startsWith("/") ? parts.shift()! : "";
  const selector = parts.pop() ?? "";
  return { selector, route, clicks: parts };
}

/** The same path, written back out for the field to hold. */
function showPath(item: NamedComponent): string {
  if (!item.selector) return "";
  return [item.route ?? "", ...(item.clicks ?? []), item.selector].filter(Boolean).join(" >> ");
}

/** A handle the way the server will keep it (server/library.ts slugify),
 *  so the field shows what was saved rather than what was typed. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "component";
}

/** Short words a search drops, which would otherwise be marked everywhere. */
const UNMARKED = new Set(["the", "and", "for", "with", "that", "this", "its", "our", "your"]);

/**
 * What a search looks for, to mark in what it found: its words cut down the
 * way the search cuts them (shared/librarySearch.ts), so "navigation" is
 * marked for "nav" and "prices" for "pricing". The search is the same one
 * `ruri search` uses — the page and the agents find the same things.
 */
function marksOf(query: string): string[] {
  const all = wordsIn(query).map(stem);
  const kept = all.filter((w) => w.length >= 3 && !UNMARKED.has(w));
  return [...new Set(kept.length ? kept : all)];
}

/** Whether a word of an entry is one a search was looking for. */
function marked(word: string, marks: string[]): boolean {
  const own = stem(word);
  return marks.some((m) => own.startsWith(m) || (own.length >= 4 && m.startsWith(own)));
}

/** Text with what the search matched marked in it. */
function Marked({ text, marks }: { text: string; marks: string[] }) {
  if (marks.length === 0) return <>{text}</>;
  // split on a captured word puts every word at an odd index
  return (
    <>
      {text.split(/([\p{L}\p{N}]+)/u).map((part, i) =>
        i % 2 === 1 && marked(part, marks) ? (
          <mark key={i} className="lib-mark">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A picture's address on this server. */
function srcOf(shot: Attachment): string {
  return HTTP_BASE + (shot.url ?? "");
}

/** The pictures of an entry that can be shown, by address. */
function srcsOf(item: NamedComponent): string[] {
  return item.shots.flatMap((shot) => (shot.url ? [srcOf(shot)] : []));
}

/** Whether an entry has no picture to show: none taken, or every one of
 *  them found gone. */
function unpictured(item: NamedComponent, gone: ReadonlySet<string>): boolean {
  return srcsOf(item).every((src) => gone.has(src));
}

/** What the gallery can be narrowed to. */
type Filter = "all" | "new" | "unsure" | "unpictured" | "outdated" | "lost";

const FILTERS: Array<{ id: Filter; label: string; title: string }> = [
  { id: "all", label: "All", title: "Everything in the library" },
  { id: "new", label: "New", title: "Named since you last looked" },
  {
    id: "unsure",
    label: "Names to check",
    title: "An agent or the repo sweep chose these names — open one to keep it or call it what you call it",
  },
  {
    id: "unpictured",
    label: "Needs a picture",
    title: "No picture yet, or its picture is missing — Update everything takes them",
  },
  {
    id: "outdated",
    label: "Outdated",
    title: "Its code changed after its picture was taken — Update everything retakes them",
  },
  {
    id: "lost",
    label: "Files gone",
    title: "Its files are in neither the project nor any of its worktrees — say where they went, or take it out",
  },
];

function inFilter(item: NamedComponent, filter: Filter, gone: ReadonlySet<string>): boolean {
  switch (filter) {
    case "all":
      return true;
    case "new":
      return item.star !== undefined;
    case "unpictured":
      return unpictured(item, gone);
    case "outdated":
      return !unpictured(item, gone) && componentStale(item).picture;
    case "unsure":
      return !item.confirmed;
    case "lost":
      return (item.missing?.length ?? 0) > 0;
  }
}

type Sort = "recent" | "name";

/** When an entry was last given something — made, edited, or pictured. */
function lastTouched(item: NamedComponent): number {
  return Math.max(item.ts, item.updated ?? 0, item.shotAt ?? 0);
}

/**
 * How the gallery was left, per project: the search, the chip, the order
 * and how far down it was. Coming back from a component, or from another
 * page, lands where you were — in a library of three hundred, starting
 * again from the top every time was most of the work of browsing it.
 */
interface View {
  query: string;
  filter: Filter;
  sort: Sort;
  scroll: number;
}

const views = new Map<string, View>();
const FRESH: View = { query: "", filter: "all", sort: "recent", scroll: 0 };

/**
 * The star a new component wears. It turns, because a page of identical
 * cards is exactly the place a still mark goes unnoticed — and it turns
 * slowly, because this is a page you read. The turning is lib/spin.ts: ten
 * steps a second off one shared clock, not an endless CSS animation.
 */
function Star({ where }: { where: "just" | "still" }) {
  return (
    <span
      className={`comp-star ${where}`}
      ref={spinStar}
      title={where === "just" ? "Named just now" : "New since you last looked"}
      aria-label="new"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2.5l2.7 6.1 6.6.7-4.9 4.5 1.4 6.5L12 17l-5.8 3.3 1.4-6.5L2.7 9.3l6.6-.7z" />
      </svg>
    </span>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** Send dropped, pasted or picked pictures to be kept with an entry. */
async function addShots(projectId: string, componentId: string, list: File[]): Promise<void> {
  for (const file of list) {
    if (!file.type.startsWith("image/")) continue;
    send({
      type: "component_shot",
      projectId,
      componentId,
      upload: {
        id: crypto.randomUUID(),
        kind: "image",
        mediaType: file.type,
        name: file.name,
        n: 1,
        data: await fileToBase64(file),
      },
    });
  }
}

/**
 * A field's text while it is being edited, following the saved value
 * whenever that changes underneath it (an agent's `ruri edit`, another
 * window) — adjusted as it renders rather than in an effect after.
 */
function useDraft(value: string): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  if (saved !== value) {
    setSaved(value);
    setDraft(value);
  }
  return [draft, setDraft];
}

/** True for a moment after `mark()` — long enough to see "saved". */
function useFlash(): [boolean, () => void] {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!at) return;
    const timer = setTimeout(() => setAt(0), 1400);
    return () => clearTimeout(timer);
  }, [at]);
  return [at > 0, () => setAt(Date.now())];
}

/** A button that copies `text`, and says so. */
function CopyButton({ text, label = "Copy", title }: { text: string | undefined; label?: string; title: string }) {
  const [copied, flash] = useFlash();
  return (
    <button
      type="button"
      className={`lib-copy${copied ? " copied" : ""}`}
      disabled={!text}
      title={title}
      onClick={() => {
        if (text) void navigator.clipboard.writeText(text).then(flash);
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

/* ── seeing the cards that are near ────────────────────────────────── */

type Watch = (el: Element, onNear: () => void) => () => void;

/** Tells a card when it comes within a screen or so of being seen, so its
 *  picture is made only then. One observer for the page, on its scroller. */
const NearContext = createContext<Watch | null>(null);

function useWatcher(root: RefObject<HTMLElement | null>): Watch {
  const observer = useRef<IntersectionObserver | null>(null);
  const calls = useRef(new Map<Element, () => void>());
  useEffect(() => () => observer.current?.disconnect(), []);
  return useCallback(
    (el, onNear) => {
      observer.current ??= new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            calls.current.get(entry.target)?.();
            calls.current.delete(entry.target);
            observer.current?.unobserve(entry.target);
          }
        },
        { root: root.current, rootMargin: "700px 0px" },
      );
      calls.current.set(el, onNear);
      observer.current.observe(el);
      return () => {
        calls.current.delete(el);
        observer.current?.unobserve(el);
      };
    },
    [root],
  );
}

/** Whether the element has come near the screen — and stays so once it has. */
function useNear(ref: RefObject<Element | null>): boolean {
  const watch = useContext(NearContext);
  const [near, setNear] = useState(watch === null);
  useEffect(() => {
    const el = ref.current;
    if (!el || near || !watch) return;
    return watch(el, () => setNear(true));
  }, [ref, near, watch]);
  return near;
}

/* ── the gallery ───────────────────────────────────────────────────── */

/** One entry in the grid: its picture, what it's called, a line of its
 *  note, its handle. */
function Tile({
  projectId,
  item,
  marks,
  onOpen,
}: {
  projectId: string;
  item: NamedComponent;
  marks: string[];
  onOpen(): void;
}) {
  const box = useRef<HTMLButtonElement>(null);
  const near = useNear(box);
  const srcs = srcsOf(item);
  const { src, index } = useThumb(srcs, near);
  const [over, setOver] = useState(false);
  const behind = componentStale(item).picture;
  const lost = item.missing?.length ?? 0;
  const note = item.note.trim().split("\n")[0] ?? "";
  return (
    <button
      ref={box}
      type="button"
      className={`lib-tile${item.star ? " fresh" : ""}${over ? " drop" : ""}`}
      data-id={item.id}
      // Hovering a card is having looked at it: the star has done its job
      // the moment the eye is on the thing it was pointing at.
      onMouseEnter={() => {
        if (item.star) send({ type: "component_seen", projectId, componentId: item.id });
      }}
      onClick={onOpen}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const dropped = [...e.dataTransfer.files];
        if (dropped.length === 0) return;
        e.preventDefault();
        void addShots(projectId, item.id, dropped);
      }}
    >
      {item.star === "still" && <Star where="still" />}
      <span className={`lib-tile-shot${src ? "" : " empty"}`}>
        {src ? (
          <>
            <img src={src} alt="" decoding="async" draggable={false} />
            {behind ? (
              <span
                className="lib-badge"
                title="Its code changed after this picture was taken — Update everything retakes it"
              >
                outdated
              </span>
            ) : index > 0 ? (
              <span className="lib-badge" title="Its newest picture is missing — this is an older one">
                older picture
              </span>
            ) : null}
          </>
        ) : src === null ? (
          <span className="lib-tile-blank">
            <span className="lib-tile-glyph">{(item.slug[0] ?? "?").toUpperCase()}</span>
            {srcs.length > 0 ? (
              <span className="lib-tile-why" title="Its picture's file is gone — Update everything retakes it">
                picture missing
              </span>
            ) : (
              <span className="lib-tile-why">no picture yet</span>
            )}
            <span className="lib-tile-hint">drop one here</span>
          </span>
        ) : null}
        {lost > 0 && (
          <span className="lib-badge left" title={`Not in the project or any of its worktrees: ${item.missing!.join(", ")}`}>
            {lost === item.files.length ? "files gone" : `${lost} file${lost === 1 ? "" : "s"} gone`}
          </span>
        )}
        {over && <span className="lib-tile-dropping">Drop to add the picture</span>}
      </span>
      <span className="lib-tile-name">
        <span
          className={`lib-tile-name-text${item.confirmed ? "" : " unsure"}`}
          title={
            item.confirmed
              ? undefined
              : item.found
                ? "The repo sweep's guess at a name — open it to keep it or rename it"
                : "An agent chose this name — open it to keep it or rename it"
          }
        >
          <Marked text={item.name} marks={marks} />
        </span>
        {item.star === "just" && <Star where="just" />}
      </span>
      <span className="lib-tile-note">{note ? <Marked text={note} marks={marks} /> : "No note yet."}</span>
      <span className="lib-tile-slug">
        <Marked text={item.slug} marks={marks} />
      </span>
    </button>
  );
}

/* ── one component ─────────────────────────────────────────────────── */

/** highlight.js's name for a file's language, by its extension. */
function languageOf(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    css: "css",
    scss: "scss",
    less: "less",
    html: "xml",
    htm: "xml",
    vue: "xml",
    svelte: "xml",
    astro: "xml",
    svg: "xml",
    xml: "xml",
    swift: "swift",
    go: "go",
    rs: "rust",
    py: "python",
    rb: "ruby",
    kt: "kotlin",
    java: "java",
    cpp: "cpp",
    cc: "cpp",
    h: "cpp",
    hpp: "cpp",
    c: "c",
    cs: "csharp",
    json: "json",
    md: "markdown",
    mdx: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
  };
  return map[ext] ?? "plaintext";
}

/** A file's line height in the code view — the gutter, the code and the
 *  marked line all step by it. */
const LINE_PX = 19;

/** One file, highlighted, with line numbers and its marked line. */
function CodeView({ file }: { file: ComponentFile }) {
  const scroller = useRef<HTMLDivElement>(null);
  const code = file.text ?? "";
  const from = file.from ?? 1;
  const count = code.split("\n").length;
  const { html, name } = useMemo(() => highlightFor(languageOf(file.path), code), [file.path, code]);
  const numbers = useMemo(
    () => Array.from({ length: count }, (_, i) => String(from + i)).join("\n"),
    [from, count],
  );
  // the line the entry points at, a few lines down from the top
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    box.scrollTop = file.line ? Math.max(0, (file.line - from - 4) * LINE_PX) : 0;
    box.scrollLeft = 0;
  }, [file.path, file.line, from]);
  if (file.missing) {
    return <div className="lib-code-missing">Not found in the project — moved, renamed, or deleted.</div>;
  }
  return (
    <div className="lib-code" ref={scroller}>
      <div className="lib-code-inner" style={{ ["--lib-line" as string]: `${LINE_PX}px` }}>
        {file.line !== undefined && file.line >= from && file.line < from + count && (
          <div className="lib-code-mark" style={{ top: (file.line - from) * LINE_PX }} />
        )}
        <pre className="lib-code-gutter" aria-hidden>
          {numbers}
        </pre>
        <pre className="lib-code-text">
          <code className="hljs" {...(name ? { "data-hl": name } : {})} dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      </div>
    </div>
  );
}

/** The faint lines that stand where code is on its way. */
function CodeLoading() {
  return (
    <div className="lib-codebox loading" aria-busy>
      <div className="lib-tabs">
        <span className="lib-skel tab" />
        <span className="lib-skel tab" />
      </div>
      <div className="lib-code-skel">
        {[62, 48, 75, 30, 55, 68, 40].map((w, i) => (
          <span key={i} className="lib-skel line" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

/** The files of one component, a tab each: its own first, then the places
 *  it reaches into. */
function CodeTabs({ projectId, item }: { projectId: string; item: NamedComponent }) {
  const files = useRuri((s) => s.componentCode[item.id]);
  const [tab, setTab] = useState(0);
  // read again whenever the entry changes: its files may have
  const key = `${item.files.join("|")}#${(item.uses ?? []).join("|")}#${item.updated ?? item.ts}`;
  useEffect(() => {
    send({ type: "component_code", projectId, componentId: item.id });
  }, [projectId, item.id, key]);
  if (!files) return <CodeLoading />;
  if (files.length === 0) {
    return <div className="lib-code-missing boxed">No files on this one yet — list them under “its files”.</div>;
  }
  const open = files[Math.min(tab, files.length - 1)]!;
  const from = open.from ?? 1;
  const count = (open.text ?? "").split("\n").length;
  // a long file comes as the stretch that matters: Copy copies what is shown
  const cut = open.lines !== undefined && (from > 1 || count < open.lines);
  return (
    <div className="lib-codebox">
      <div className="lib-tabs" role="tablist">
        {files.map((file, i) => (
          <button
            key={`${file.path}:${file.line ?? ""}:${i}`}
            type="button"
            role="tab"
            aria-selected={i === tab}
            className={`lib-tab${i === tab ? " on" : ""}${file.own ? "" : " reach"}${file.missing ? " gone" : ""}`}
            title={`${file.path}${file.line ? `:${file.line}` : ""}${file.own ? "" : " — a place it reaches into"}${file.missing ? " — not found" : ""}`}
            onClick={() => setTab(i)}
          >
            {file.path.slice(file.path.lastIndexOf("/") + 1)}
            {file.line ? <span className="lib-tab-line">:{file.line}</span> : null}
          </button>
        ))}
      </div>
      <div className="lib-code-path">
        <span className="lib-code-file">
          {open.path}
          {open.own ? "" : " — reaches into"}
        </span>
        {cut && (
          <span className="lib-code-cut">
            lines {from}–{from + count - 1} of {open.lines}
          </span>
        )}
        <CopyButton
          text={open.text}
          label={cut ? "Copy these lines" : "Copy"}
          title={cut ? `Copy lines ${from}–${from + count - 1}` : "Copy this file"}
        />
      </div>
      <CodeView file={open} />
    </div>
  );
}

/**
 * A labelled one-line field that saves when it loses focus. `normalize`
 * turns what was typed into what will be kept — or null for something that
 * can't be (an empty handle), which puts the saved value back — so the
 * field never goes on showing something the library doesn't hold.
 */
function Field({
  label,
  value,
  placeholder,
  title,
  mono,
  wrap,
  normalize = (v) => v.trim(),
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  title?: string;
  mono?: boolean;
  /** Long values — a list of paths — wrap onto more lines rather than
   *  running out of the box. */
  wrap?: boolean;
  normalize?(typed: string): string | null;
  onSave(next: string): void;
}) {
  const [draft, setDraft] = useDraft(value);
  const [saved, flash] = useFlash();
  const commit = () => {
    const next = normalize(draft);
    if (next === null) {
      setDraft(value);
      return;
    }
    setDraft(next);
    if (next !== value) {
      onSave(next);
      flash();
    }
  };
  const props = {
    className: mono ? "mono" : undefined,
    value: draft,
    placeholder,
    spellCheck: !mono,
    onBlur: commit,
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.currentTarget.blur();
      } else if (e.key === "Escape") {
        // Escape lets go of an edit, and only then leaves the page
        setDraft(value);
        e.currentTarget.blur();
        e.stopPropagation();
      }
    },
  };
  return (
    <label className={`lib-field${wrap ? " wrap" : ""}`} title={title}>
      <span>{saved ? <b className="lib-saved">saved</b> : label}</span>
      {wrap ? (
        <textarea rows={1} {...props} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <input {...props} onChange={(e) => setDraft(e.target.value)} />
      )}
    </label>
  );
}

const asList = (typed: string) => parseList(typed).join(", ");

type Patch = Partial<{
  name: string;
  slug: string;
  aliases: string[];
  files: string[];
  uses: string[];
  tags: string[];
  deps: string[];
  note: string;
  selector: string;
  route: string;
  clicks: string[];
}>;

/** One of a component's pictures, small, in the strip under the big one. */
function ShotThumb({
  shot,
  on,
  onPick,
  onRemove,
}: {
  shot: Attachment;
  on: boolean;
  onPick(): void;
  onRemove(gone: boolean): void;
}) {
  const { src } = useThumb([srcOf(shot)], true);
  return (
    <div className={`lib-thumb${on ? " on" : ""}${src === null ? " gone" : ""}`}>
      <button
        type="button"
        className="lib-thumb-pick"
        title={src === null ? `${shot.name} — its file is gone` : shot.name}
        disabled={src === null}
        onClick={onPick}
      >
        {src ? <img src={src} alt="" draggable={false} /> : src === null ? <span>missing</span> : null}
      </button>
      {/* The picture opens; only the × takes it away — looking at a
          screenshot must never be what deletes it. */}
      <button
        type="button"
        className="att-remove"
        title={src === null ? "Forget this missing picture" : "Remove this picture"}
        onClick={() => onRemove(src === null)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function Detail({
  projectId,
  item,
  trail,
  onGo,
  onBack,
}: {
  projectId: string;
  item: NamedComponent;
  /** The gallery as it stood when this was opened, for ← and →. */
  trail: string[];
  onGo(id: string): void;
  onBack(): void;
}) {
  const dir = useRuri((s) => s.componentDirs[projectId]);
  const [name, setName] = useDraft(item.name);
  const [note, setNote] = useDraft(item.note);
  const [noteSaved, flashNote] = useFlash();
  const [shownId, setShownId] = useState<string>();
  const [viewing, setViewing] = useState(false);
  const [sure, setSure] = useState(false);
  // pictures this page failed to load, on top of those found gone elsewhere
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const gone = useGone();
  const { confirm, card } = useConfirm();
  useEffect(() => {
    if (item.star) send({ type: "component_seen", projectId, componentId: item.id });
  }, [projectId, item.id, item.star]);

  const patch = (extra: Patch) => send({ type: "component_update", projectId, componentId: item.id, ...extra });
  const install = `ruri add ${item.slug}`;
  // the one picked, by id — a new picture arriving at the front of the
  // list must not swap what is on screen — else the newest still there
  const live = item.shots.filter((s) => s.url && !gone.has(srcOf(s)) && !broken.has(s.id));
  const shot = live.find((s) => s.id === shownId) ?? live[0];
  const missing = item.shots.length - live.length;
  const behind = componentStale(item);
  const at = trail.indexOf(item.id);
  const prev = at > 0 ? trail[at - 1] : undefined;
  const next = at >= 0 && at < trail.length - 1 ? trail[at + 1] : undefined;

  // ← and → step through the gallery, as it was when this was opened
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (document.querySelector(".viewer-overlay, .confirm-overlay")) return;
      const to = e.key === "ArrowLeft" ? prev : e.key === "ArrowRight" ? next : undefined;
      if (!to) return;
      e.preventDefault();
      onGo(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onGo]);

  const removeShot = async (s: Attachment, isGone: boolean) => {
    // a picture whose file is already gone has nothing left to lose
    if (
      !isGone &&
      !(await confirm({
        title: "Remove this picture?",
        body: "It comes out of the library for good — nothing brings it back.",
        ok: "Remove",
      }))
    ) {
      return;
    }
    send({ type: "component_unshot", projectId, componentId: item.id, shotId: s.id });
  };

  return (
    <div className="lib-detail">
      {card}
      <div className="lib-detail-top">
        <button type="button" className="ghost lib-back" onClick={onBack} title="Back to the library (Esc)">
          <Icon d="M15 18l-6-6 6-6" />
          Library
        </button>
        <input
          className="lib-detail-name"
          value={name}
          placeholder="what you call it"
          title="What you call it — click to rename"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const clean = name.trim();
            if (!clean) setName(item.name);
            else if (clean !== item.name) patch({ name: clean });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              setName(item.name);
              e.currentTarget.blur();
              e.stopPropagation();
            }
          }}
        />
        {trail.length > 1 && at >= 0 && (
          <div className="lib-step">
            <button
              type="button"
              className="ghost"
              disabled={!prev}
              title="The one before (←)"
              onClick={() => prev && onGo(prev)}
            >
              <Icon d="M15 18l-6-6 6-6" />
            </button>
            <span>
              {at + 1} of {trail.length}
            </span>
            <button
              type="button"
              className="ghost"
              disabled={!next}
              title="The one after (→)"
              onClick={() => next && onGo(next)}
            >
              <Icon d="M9 18l6-6-6-6" />
            </button>
          </div>
        )}
      </div>

      {/* Most names come from an agent, and this page is the one place the
          user says what they call a thing: keeping it, or renaming it above,
          makes the name theirs (server/components.ts confirm). */}
      {!item.confirmed && (
        <div className="lib-ask">
          <span>
            {item.found ? (
              <>
                <b>The repo sweep's guess.</b> Is “{item.name}” what you call it? Its note and files are a guess
                too.
              </>
            ) : (
              <>
                <b>An agent named this.</b> Is “{item.name}” what you call it? If not, rename it above.
              </>
            )}
          </span>
          <button type="button" onClick={() => patch({ name: item.name })}>
            That's right
          </button>
        </div>
      )}

      {item.missing?.length ? (
        <div className="lib-ask lost">
          <span>
            <b>
              {item.missing.length === item.files.length
                ? "Its files are gone"
                : `${item.missing.length} of its files ${item.missing.length === 1 ? "is" : "are"} gone`}
              :
            </b>{" "}
            <span className="mono">{item.missing.join(", ")}</span> — in neither the project nor any of its
            worktrees. Say where {item.missing.length === 1 ? "it is" : "they are"} now under “its files”, or take
            it out of the library.
          </span>
        </div>
      ) : null}

      <div className="lib-install">
        <code>{install}</code>
        {dir && (
          <span className="lib-install-dir" title="Where `ruri add` copies it — set at the foot of the library">
            into {dir}/
          </span>
        )}
        <CopyButton text={install} title="Copy the command an agent installs it with" />
      </div>

      <div className="lib-detail-body">
        <div
          className="lib-preview"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const dropped = [...e.dataTransfer.files];
            if (dropped.length === 0) return;
            e.preventDefault();
            void addShots(projectId, item.id, dropped);
          }}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length === 0) return;
            e.preventDefault();
            void addShots(projectId, item.id, pasted);
          }}
        >
          <div className="lib-preview-main">
            {shot ? (
              <button
                type="button"
                className="lib-preview-pick"
                title={`${shot.name} — click to see it full size`}
                onClick={() => setViewing(true)}
              >
                <img
                  key={shot.id}
                  src={srcOf(shot)}
                  alt={item.name}
                  onError={() => setBroken((was) => new Set([...was, shot.id]))}
                />
              </button>
            ) : (
              <div className="lib-preview-blank">
                {missing > 0 ? (
                  <p>
                    Its {missing === 1 ? "picture is" : "pictures are"} missing — the file
                    {missing === 1 ? " is" : "s are"} gone. Drop or paste a new one here, or press{" "}
                    <b>Update everything</b> to have it taken.
                  </p>
                ) : (
                  <p>
                    No picture yet. Drop or paste one here — or press <b>Update everything</b> to have it taken.
                  </p>
                )}
              </div>
            )}
          </div>
          {viewing && shot && (
            <Viewer
              target={{ kind: "image", src: srcOf(shot), label: `${item.name} — ${shot.name}`, name: shot.name }}
              onClose={() => setViewing(false)}
            />
          )}
          {(behind.picture || behind.note) && (
            <div className="lib-behind">
              <span>
                Its code has changed since {behind.picture ? "this picture" : "its note was written"}
                {item.changedAt ? ` (${new Date(item.changedAt).toLocaleDateString()})` : ""} —{" "}
                <b>Update everything</b> {behind.picture ? "retakes it" : "rereads it"}, or say it still holds.
              </span>
              <button
                type="button"
                className="ghost"
                title="The picture and note still show it as it is: take the mark off without a new picture"
                onClick={() => send({ type: "component_current", projectId, componentId: item.id })}
              >
                Still right
              </button>
            </div>
          )}
          <div className="lib-thumbs">
            {item.shots.map((s) => (
              <ShotThumb
                key={s.id}
                shot={s}
                on={s.id === shot?.id}
                onPick={() => setShownId(s.id)}
                onRemove={(isGone) => void removeShot(s, isGone)}
              />
            ))}
            <label className="lib-thumb add" title="Add a picture — or drop or paste one onto the big one">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  void addShots(projectId, item.id, [...(e.target.files ?? [])]);
                  e.target.value = "";
                }}
              />
              <Icon d="M12 5v14M5 12h14" />
            </label>
            {item.shots.length > 1 && <span className="lib-thumbs-say">newest first</span>}
          </div>
        </div>

        <div className="lib-meta">
          <div className="lib-note-box">
            <textarea
              className="lib-note"
              value={note}
              placeholder="What it is, and anything to know before touching it…"
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => {
                if (note === item.note) return;
                patch({ note });
                flashNote();
              }}
            />
            {noteSaved && <b className="lib-saved lib-note-saved">saved</b>}
          </div>
          <Field
            label="handle"
            value={item.slug}
            mono
            title="What `ruri add` and `ruri show` know it by"
            normalize={(typed) => (typed.trim() ? slugify(typed) : null)}
            onSave={(slug) => patch({ slug })}
          />
          <Field
            label="also called"
            value={item.aliases.join(", ")}
            placeholder="none"
            title="Other names that mean it, comma-separated — the gauges, the bars"
            normalize={asList}
            onSave={(v) => patch({ aliases: parseList(v) })}
          />
          <Field
            label="tags"
            value={(item.tags ?? []).join(", ")}
            placeholder="none"
            title="Words to find it by, comma-separated — dialog, nav, animation"
            normalize={asList}
            onSave={(v) => patch({ tags: parseList(v) })}
          />
          <Field
            label="its files"
            value={item.files.join(", ")}
            placeholder="none — say which"
            title="Its own code, from the project's root: what `ruri add` copies — src/components/Card.tsx"
            mono
            wrap
            normalize={asList}
            onSave={(v) => patch({ files: parseList(v) })}
          />
          <Field
            label="reaches into"
            value={(item.uses ?? []).join(", ")}
            placeholder="none"
            title="Other places it touches, read but never copied, a line after a colon — src/styles.css:120"
            mono
            wrap
            normalize={asList}
            onSave={(v) => patch({ uses: parseList(v) })}
          />
          <Field
            label="packages"
            value={(item.deps ?? []).join(", ")}
            placeholder="none"
            title="Packages its code needs, which `ruri add` names for installing — framer-motion"
            mono
            normalize={asList}
            onSave={(v) => patch({ deps: parseList(v) })}
          />
          {/* What finds it in the running app — this is what gets
              photographed, so a wrong one here is a picture of the wrong
              thing. Fix it and update again; anything still without a
              current picture gets another go. */}
          <Field
            label="on screen"
            value={showPath(item)}
            placeholder="not set"
            title="A selector that finds it in the running app, so it can be photographed: .dragon-gauges — or a page and clicks first: /settings >> .tab >> .panel"
            mono
            normalize={(typed) =>
              typed
                .split(">>")
                .map((part) => part.trim())
                .filter(Boolean)
                .join(" >> ")
            }
            onSave={(v) => patch(parsePath(v))}
          />
          {item.installs?.length ? (
            <div className="lib-field static">
              <span>copies at</span>
              <div className="mono">{item.installs.join(", ")}</div>
            </div>
          ) : null}
          <div className="lib-meta-foot">
            {sure ? (
              <>
                <span>Take it out of the library? Its code stays in the project.</span>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    send({ type: "component_remove", projectId, componentId: item.id });
                    onBack();
                  }}
                >
                  Take it out
                </button>
                <button type="button" className="ghost" onClick={() => setSure(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button type="button" className="ghost lib-remove" onClick={() => setSure(true)}>
                Take out of the library
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="lib-section-title">Code</div>
      <CodeTabs projectId={projectId} item={item} />
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────── */

/** Where `ruri add` copies into — set by the first agent to say, or here. */
function InstallDir({ projectId }: { projectId: string }) {
  const dir = useRuri((s) => s.componentDirs[projectId]) ?? "";
  const [draft, setDraft] = useDraft(dir);
  return (
    <input
      className="mono lib-dir"
      value={draft}
      placeholder="a folder, not set yet"
      title="The folder `ruri add` copies components into, from the project's root"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const clean = draft.trim().replace(/\/+$/, "");
        setDraft(clean);
        if (clean !== dir) send({ type: "library_dir", projectId, dir: clean });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

/** One empty list, so a project with no library yet is the same value each render. */
const NO_COMPONENTS: NamedComponent[] = [];

export function Components({ projectId }: { projectId: string }) {
  // a page of its own per project: one project's search, chip and place
  // never carry into another's
  return <Library key={projectId} projectId={projectId} />;
}

function Library({ projectId }: { projectId: string }) {
  const items = useRuri((s) => s.components[projectId]) ?? NO_COMPONENTS;
  const sweep = useRuri((s) => s.sweeps[projectId]);
  const busy = sweep?.busy === true;
  const gone = useGone();
  const [view, setView] = useState<View>(() => views.get(projectId) ?? FRESH);
  const [openId, setOpenId] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const page = useRef<HTMLElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const cameFrom = useRef<string | null>(null);
  const watch = useWatcher(page);

  const change = (next: Partial<View>) => {
    const now = { ...view, ...next };
    setView(now);
    // how far down it is, the scroll listener keeps
    views.set(projectId, { ...now, scroll: views.get(projectId)?.scroll ?? 0 });
  };

  // The sweep's last word stays up for a moment after it finishes — long
  // enough to read what it did, not long enough to still be there next time
  // the page is opened and mean nothing.
  const noteStale = useNoteStale(sweep?.at, busy);
  const note = sweep?.note && !noteStale ? sweep.note : undefined;

  // Leaving the page is the other way of having looked: the stars were up
  // the whole time this was on screen, and they don't follow you out. The
  // ref keeps the send out of the effect's dependencies, so it fires once
  // on the way out rather than on every library update.
  const starred = useRef(false);
  useEffect(() => {
    starred.current = items.some((item) => item.star);
  }, [items]);
  useEffect(
    () => () => {
      if (starred.current) send({ type: "component_seen", projectId });
    },
    [projectId],
  );

  // which pictures are gone, for the counts, before the cards are seen
  useEffect(() => {
    void probe(items.flatMap(srcsOf));
  }, [items]);

  // one taken out while it was open simply isn't open any more
  const open = openId ? items.find((item) => item.id === openId) : undefined;
  const searching = view.query.trim() !== "";
  const marks = useMemo(() => marksOf(view.query), [view.query]);
  // what the search finds, best first — the same search as `ruri search`
  // (shared/librarySearch.ts) — and the chips count within it
  const hits = useMemo(() => (searching ? searchComponents(items, view.query) : items), [items, view.query, searching]);
  const counts = useMemo(() => {
    const out = { all: 0, new: 0, unsure: 0, unpictured: 0, outdated: 0, lost: 0 } satisfies Record<Filter, number>;
    for (const item of hits) for (const f of FILTERS) if (inFilter(item, f.id, gone)) out[f.id] += 1;
    return out;
  }, [hits, gone]);
  const shown = useMemo(() => {
    const kept = hits.filter((item) => inFilter(item, view.filter, gone));
    if (searching) return kept;
    return view.sort === "name"
      ? [...kept].sort((a, b) => a.name.localeCompare(b.name))
      : [...kept].sort((a, b) => lastTouched(b) - lastTouched(a));
  }, [hits, view.filter, view.sort, searching, gone]);

  const openOne = (id: string) => {
    if (!open) {
      // the gallery as it stands now is what ← and → walk
      views.set(projectId, { ...view, scroll: page.current?.scrollTop ?? 0 });
      setTrail(shown.map((item) => item.id));
    }
    cameFrom.current = id;
    setOpenId(id);
  };

  // A component starts at its own top; the gallery comes back where it was
  // left, with the card you came from in focus.
  const openKey = open?.id;
  useLayoutEffect(() => {
    const box = page.current;
    if (!box) return;
    if (openKey) {
      box.scrollTo({ top: 0 });
      return;
    }
    box.scrollTo({ top: views.get(projectId)?.scroll ?? 0 });
    const from = cameFrom.current;
    const tile = from ? grid.current?.querySelector<HTMLElement>(`[data-id="${from}"]`) : null;
    if (tile) {
      tile.focus({ preventScroll: true });
      // stepped along with → past where the gallery was left: show it
      tile.scrollIntoView({ block: "nearest" });
    }
  }, [openKey, projectId]);

  // remember how far down the gallery is, for coming back to it
  useEffect(() => {
    const box = page.current;
    if (!box || open) return;
    const onScroll = () => {
      const was = views.get(projectId) ?? view;
      views.set(projectId, { ...was, scroll: box.scrollTop });
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, [open, projectId, view]);

  // Esc from a component goes back to the gallery; "/" searches it —
  // neither while something is being typed into, nor under a dialog
  const opened = open !== undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (document.querySelector(".viewer-overlay, .confirm-overlay")) return;
      if (e.key === "Escape" && opened && !typing) {
        e.preventDefault();
        setOpenId(null);
      } else if (e.key === "/" && !opened && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchBox.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opened]);

  /** Arrow keys between the cards, the way they sit on screen. */
  const moveFocus = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key) || !(e.target instanceof HTMLElement)) return;
    const tiles = [...(grid.current?.querySelectorAll<HTMLElement>(".lib-tile") ?? [])];
    const at = tiles.indexOf(e.target);
    if (at < 0) return;
    const columns = grid.current
      ? getComputedStyle(grid.current).gridTemplateColumns.split(" ").filter(Boolean).length
      : 1;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[e.key] ?? 0;
    e.preventDefault();
    const to = at + step;
    if (to < 0 && e.key === "ArrowUp") searchBox.current?.focus();
    else tiles[Math.max(0, Math.min(tiles.length - 1, to))]?.focus();
  };

  const sweepButton = (
    <button
      type="button"
      className="comp-sweep"
      disabled={busy}
      title={
        "Bring the library up to date with the code: follow files that moved, retire what's " +
        "gone, rewrite notes the code has outgrown, name what nobody has — then photograph " +
        "everything without a current picture, in a “Library pictures” chat where it takes an agent"
      }
      onClick={() => send({ type: "components_sweep", projectId })}
    >
      {busy ? "Updating…" : "Update everything"}
    </button>
  );

  const filterLabel = FILTERS.find((f) => f.id === view.filter)?.label ?? "";

  return (
    <NearContext.Provider value={watch}>
      <section className="board-page lib-page" ref={page}>
        <div className="board-inner lib-inner">
          {open ? (
            <Detail
              key={open.id}
              projectId={projectId}
              item={open}
              trail={trail}
              onGo={openOne}
              onBack={() => setOpenId(null)}
            />
          ) : (
            <>
              <div className="board-head lib-head">
                <span className="board-title">Components</span>
                <span className={`board-sub${busy ? " lib-busy" : ""}`}>
                  {note ??
                    (items.length === 0
                      ? "none yet"
                      : `${items.length} in the library${counts.new ? ` · ${counts.new} new` : ""}`)}
                </span>
                {items.length > 0 && sweepButton}
              </div>

              {items.length === 0 ? (
                <div className="lib-empty-card">
                  <div className="lib-empty-art" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="lib-empty-title">No components yet</div>
                  <p>
                    Pieces arrive as sessions build this project's interface — each comes up in the chat under a
                    name you can change, and agents look here before building anything new.
                  </p>
                  <p>
                    For what was built before that, <b>Update everything</b> reads the repo, names each piece of
                    interface it finds and takes its picture.
                  </p>
                  {sweepButton}
                </div>
              ) : (
                <>
                  <label className="lib-search">
                    <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
                    <input
                      ref={searchBox}
                      value={view.query}
                      placeholder="Search — a name, a handle, a tag, a file…"
                      spellCheck={false}
                      onChange={(e) => change({ query: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          if (view.query) change({ query: "" });
                          else e.currentTarget.blur();
                          e.preventDefault();
                        } else if (e.key === "Enter" && shown[0]) {
                          openOne(shown[0].id);
                        } else if (e.key === "ArrowDown") {
                          e.preventDefault();
                          grid.current?.querySelector<HTMLElement>(".lib-tile")?.focus();
                        }
                      }}
                    />
                    {view.query ? (
                      <button
                        type="button"
                        className="lib-search-clear"
                        title="Clear (Esc)"
                        onClick={() => change({ query: "" })}
                      >
                        <Icon d="M6 6l12 12M18 6L6 18" />
                      </button>
                    ) : (
                      <kbd className="lib-key" title="Press / to search">
                        /
                      </kbd>
                    )}
                  </label>

                  <div className="lib-filters">
                    {FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0 || view.filter === f.id).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        className={`lib-chip${view.filter === f.id ? " on" : ""}`}
                        title={f.title}
                        aria-pressed={view.filter === f.id}
                        onClick={() => change({ filter: view.filter === f.id ? "all" : f.id })}
                      >
                        {f.label}
                        <span className="lib-chip-count">{counts[f.id]}</span>
                      </button>
                    ))}
                    <span className="lib-filters-gap" />
                    <div className="seg lib-sort" title={searching ? "A search is shown best match first" : undefined}>
                      {(
                        [
                          ["recent", "Recent"],
                          ["name", "A–Z"],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          className={`seg-option${view.sort === id && !searching ? " active" : ""}`}
                          disabled={searching}
                          onClick={() => change({ sort: id })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {shown.length === 0 ? (
                    <div className="lib-none">
                      {searching ? (
                        <>
                          Nothing {view.filter === "all" ? "" : `under “${filterLabel}” `}matches “{view.query}”.
                          <button type="button" className="ghost" onClick={() => change({ query: "" })}>
                            Clear the search
                          </button>
                        </>
                      ) : (
                        <>
                          Nothing under “{filterLabel}”.
                          <button type="button" className="ghost" onClick={() => change({ filter: "all" })}>
                            Show everything
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="lib-grid" ref={grid} onKeyDown={moveFocus}>
                      {shown.map((item) => (
                        <Tile
                          key={item.id}
                          projectId={projectId}
                          item={item}
                          marks={marks}
                          onOpen={() => openOne(item.id)}
                        />
                      ))}
                    </div>
                  )}

                  <div className="board-foot lib-foot">
                    Agents copy one into place with <code>ruri add &lt;handle&gt;</code>, into{" "}
                    <InstallDir projectId={projectId} />. The library is also written to{" "}
                    <code>.ruri/components.md</code> and to a skill for Claude, and handed to the model whenever a
                    prompt names one.
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </section>
    </NearContext.Provider>
  );
}
