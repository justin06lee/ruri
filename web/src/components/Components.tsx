import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentFile, NamedComponent } from "../../../shared/protocol";
import { ToolImage } from "./Attachments";
import { fileToBase64 } from "../lib/files";
import { highlightFor } from "../lib/highlighter";
import { useNoteStale } from "../lib/runNote";
import { spinStar } from "../lib/spin";
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
 * only way in for what was built before any of this (server/sweep.ts,
 * server/shots.ts). Correcting any of it is what this page is for.
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

/** How well an entry answers a search — 0 when it doesn't: every word has
 *  to be somewhere in it, and one in its name, handle or tags counts for
 *  more than one in its note or its files (server/library.ts ranks the
 *  same way for `ruri search`). */
function score(item: NamedComponent, query: string): number {
  const words = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const strong = [item.slug, item.name, ...item.aliases, ...(item.tags ?? [])].join(" ").toLowerCase();
  const weak = [item.note, ...item.files, ...(item.uses ?? [])].join(" ").toLowerCase();
  let total = 0;
  for (const word of words) {
    if (strong.includes(word)) total += 3;
    else if (weak.includes(word)) total += 1;
    else return 0;
  }
  return total;
}

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

/* ── the gallery ───────────────────────────────────────────────────── */

/** One entry in the grid: its picture, what it's called, its handle. */
function Tile({ projectId, item, onOpen }: { projectId: string; item: NamedComponent; onOpen(): void }) {
  const shot = item.shots[0];
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      className={`lib-tile${item.star ? " fresh" : ""}`}
      // Hovering a card is having looked at it: the star has done its job
      // the moment the eye is on the thing it was pointing at.
      onMouseEnter={() => {
        if (item.star) send({ type: "component_seen", projectId, componentId: item.id });
      }}
      onClick={onOpen}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const dropped = [...e.dataTransfer.files];
        if (dropped.length === 0) return;
        e.preventDefault();
        void addShots(projectId, item.id, dropped);
      }}
    >
      {item.star === "still" && <Star where="still" />}
      <span className="lib-tile-shot">
        {shot?.url && !broken ? (
          <img src={HTTP_BASE + shot.url} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span className="lib-tile-blank">
            <span className="lib-tile-glyph">{(item.slug[0] ?? "?").toUpperCase()}</span>
            no picture yet — drop one here
          </span>
        )}
      </span>
      <span className="lib-tile-name">
        {item.name}
        {item.star === "just" && <Star where="just" />}
      </span>
      <span className="lib-tile-slug">{item.slug}</span>
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
  const cut = file.lines !== undefined && (from > 1 || count < file.lines);
  return (
    <>
      {cut && (
        <div className="lib-code-cut">
          Lines {from}–{from + count - 1} of {file.lines}
        </div>
      )}
      <div className="lib-code" ref={scroller}>
        <div className="lib-code-inner" style={{ ["--lib-line" as string]: `${LINE_PX}px` }}>
          {file.line !== undefined && file.line >= from && file.line < from + count && (
            <div className="lib-code-mark" style={{ top: (file.line - from) * LINE_PX }} />
          )}
          <pre className="lib-code-gutter" aria-hidden>
            {numbers}
          </pre>
          <pre className="lib-code-text">
            <code
              className="hljs"
              {...(name ? { "data-hl": name } : {})}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </pre>
        </div>
      </div>
    </>
  );
}

/** The files of one component, a tab each: its own first, then the places
 *  it reaches into. */
function CodeTabs({ projectId, item }: { projectId: string; item: NamedComponent }) {
  const files = useRuri((s) => s.componentCode[item.id]);
  const [tab, setTab] = useState(0);
  const [copied, setCopied] = useState(false);
  // read again whenever the entry changes: its files may have
  const key = `${item.files.join("|")}#${(item.uses ?? []).join("|")}#${item.updated ?? item.ts}`;
  useEffect(() => {
    send({ type: "component_code", projectId, componentId: item.id });
  }, [projectId, item.id, key]);
  if (!files) return <div className="lib-code-missing">Reading…</div>;
  if (files.length === 0) {
    return <div className="lib-code-missing">No files on this one yet — say which under Details.</div>;
  }
  const open = files[Math.min(tab, files.length - 1)]!;
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
            title={`${file.path}${file.line ? `:${file.line}` : ""}${file.own ? "" : " — a place it reaches into"}`}
            onClick={() => setTab(i)}
          >
            {file.path.slice(file.path.lastIndexOf("/") + 1)}
            {file.line ? <span className="lib-tab-line">:{file.line}</span> : null}
          </button>
        ))}
        <span className="lib-tabs-gap" />
        <button
          type="button"
          className={`lib-copy${copied ? " copied" : ""}`}
          disabled={!open.text}
          title="Copy this file"
          onClick={() => {
            void navigator.clipboard.writeText(open.text ?? "").then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="lib-code-path">
        {open.path}
        {open.own ? "" : " — reaches into"}
      </div>
      <CodeView file={open} />
    </div>
  );
}

/** A labelled one-line field that saves when it loses focus. */
function Field({
  label,
  value,
  placeholder,
  mono,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onSave(next: string): void;
}) {
  const [draft, setDraft] = useDraft(value);
  return (
    <label className="lib-field">
      <span>{label}</span>
      <input
        className={mono ? "mono" : undefined}
        value={draft}
        placeholder={placeholder}
        spellCheck={!mono}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && onSave(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

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

function Detail({ projectId, item, onBack }: { projectId: string; item: NamedComponent; onBack(): void }) {
  const [name, setName] = useDraft(item.name);
  const [note, setNote] = useDraft(item.note);
  const [shown, setShown] = useState(0);
  const [copied, setCopied] = useState(false);
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (item.star) send({ type: "component_seen", projectId, componentId: item.id });
  }, [projectId, item.id, item.star]);

  const patch = (extra: Patch) =>
    send({ type: "component_update", projectId, componentId: item.id, ...extra });
  const install = `ruri add ${item.slug}`;
  const shot = item.shots[Math.min(shown, item.shots.length - 1)];

  return (
    <div className="lib-detail">
      <div className="lib-detail-top">
        <button type="button" className="ghost lib-back" onClick={onBack} title="Back to the library (Esc)">
          <Icon d="M15 18l-6-6 6-6" />
          Library
        </button>
        <input
          className="lib-detail-name"
          value={name}
          placeholder="what you call it"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== item.name && patch({ name: name.trim() })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {item.found && (
          <span className="lib-found" title="The repo sweep named this one — a guess until you correct it">
            found by the sweep
          </span>
        )}
      </div>

      <div className="lib-install">
        <code>{install}</code>
        <button
          type="button"
          className={`lib-copy${copied ? " copied" : ""}`}
          title="Copy the command an agent installs it with"
          onClick={() => {
            void navigator.clipboard.writeText(install).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
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
            {shot?.url ? (
              <ToolImage key={shot.id} image={{ url: shot.url, name: shot.name }} />
            ) : (
              <div className="lib-preview-blank">
                No picture yet. Drop or paste one here — or give it an <b>on screen</b> path and press{" "}
                <b>Name everything</b> to have it taken.
              </div>
            )}
          </div>
          <div className="lib-thumbs">
            {/* The picture opens; only the × takes it away — looking at a
                screenshot must never be what deletes it. */}
            {item.shots.map((s, i) => (
              <div key={s.id} className={`lib-thumb${i === shown ? " on" : ""}`}>
                <button type="button" className="lib-thumb-pick" title={s.name} onClick={() => setShown(i)}>
                  <img src={HTTP_BASE + (s.url ?? "")} alt="" />
                </button>
                <button
                  type="button"
                  className="att-remove"
                  title="Remove this screenshot"
                  onClick={() => {
                    send({ type: "component_unshot", projectId, componentId: item.id, shotId: s.id });
                    setShown(0);
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
            <label className="lib-thumb add" title="Add a screenshot">
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
          </div>
        </div>

        <div className="lib-meta">
          <textarea
            className="lib-note"
            value={note}
            placeholder="What it is, and anything to know before touching it…"
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== item.note && patch({ note })}
          />
          <Field label="handle" value={item.slug} mono onSave={(slug) => slug.trim() && patch({ slug })} />
          <Field
            label="also called"
            value={item.aliases.join(", ")}
            placeholder="the gauges, the bars"
            onSave={(v) => patch({ aliases: parseList(v) })}
          />
          <Field
            label="tags"
            value={(item.tags ?? []).join(", ")}
            placeholder="dialog, nav, animation"
            onSave={(v) => patch({ tags: parseList(v) })}
          />
          <Field
            label="its files"
            value={item.files.join(", ")}
            placeholder="src/components/Card.tsx, src/components/card.css"
            mono
            onSave={(v) => patch({ files: parseList(v) })}
          />
          <Field
            label="reaches into"
            value={(item.uses ?? []).join(", ")}
            placeholder="src/styles.css:120, src/App.tsx"
            mono
            onSave={(v) => patch({ uses: parseList(v) })}
          />
          <Field
            label="packages"
            value={(item.deps ?? []).join(", ")}
            placeholder="framer-motion"
            mono
            onSave={(v) => patch({ deps: parseList(v) })}
          />
          {/* What finds it in the running app — this is what gets
              photographed, so a wrong one here is a picture of the wrong
              thing. Fix it and sweep again; anything still without a
              picture gets another go. */}
          <Field
            label="on screen"
            value={showPath(item)}
            placeholder=".dragon-gauges  ·  /settings >> .tab >> .panel"
            mono
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
    <label className="lib-dir" title="The folder `ruri add` copies components into, from the project's root">
      installs into
      <input
        className="mono"
        value={draft}
        placeholder="not set yet"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== dir && send({ type: "library_dir", projectId, dir: draft.trim() })}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

/** One empty list, so a project with no library yet is the same value each render. */
const NO_COMPONENTS: NamedComponent[] = [];

export function Components({ projectId }: { projectId: string }) {
  const items = useRuri((s) => s.components[projectId]) ?? NO_COMPONENTS;
  const title = useRuri((s) => s.projects.find((p) => p.id === projectId)?.name) ?? "This project";
  const sweep = useRuri((s) => s.sweeps[projectId]);
  const busy = sweep?.busy === true;
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const page = useRef<HTMLElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

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

  // one taken out while it was open simply isn't open any more
  const open = openId ? items.find((item) => item.id === openId) : undefined;
  const shown = useMemo(() => {
    if (!query.trim()) return items;
    return items
      .map((item) => ({ item, score: score(item, query) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((hit) => hit.item);
  }, [items, query]);

  // each view starts at its own top
  useLayoutEffect(() => {
    page.current?.scrollTo({ top: 0 });
  }, [open?.id]);

  // Esc from a component goes back to the gallery; "/" searches it —
  // neither while something is being typed into
  const opened = open !== undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
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

  return (
    <section className="board-page lib-page" ref={page}>
      <div className="board-inner lib-inner">
        {open ? (
          <Detail key={open.id} projectId={projectId} item={open} onBack={() => setOpenId(null)} />
        ) : (
          <>
            <div className="lib-head">
              <div className="lib-title">{title}</div>
              <div className="lib-sub">
                {note ?? `${items.length} component${items.length === 1 ? "" : "s"}`}
                <span className="lib-sub-sep">·</span>
                <InstallDir projectId={projectId} />
                <button
                  className="comp-sweep"
                  disabled={busy}
                  title={
                    "Read the whole repo, name every piece of interface nobody has named yet, and — if " +
                    "the project can be opened — start it up and photograph each one"
                  }
                  onClick={() => send({ type: "components_sweep", projectId })}
                >
                  {busy ? "Sweeping…" : "Name everything"}
                </button>
              </div>
            </div>

            <label className="lib-search">
              <Icon d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4" />
              <input
                ref={searchBox}
                value={query}
                placeholder="Search the library — a name, a handle, a tag, a file…"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    e.currentTarget.blur();
                  } else if (e.key === "Enter" && shown.length === 1) setOpenId(shown[0]!.id);
                }}
              />
              {query && (
                <button type="button" className="lib-search-clear" title="Clear" onClick={() => setQuery("")}>
                  <Icon d="M6 6l12 12M18 6L6 18" />
                </button>
              )}
            </label>

            {items.length === 0 ? (
              <div className="board-empty lib-empty">
                Nothing in the library yet. Pieces arrive on their own — when a session builds part of this
                project's interface it puts it in, under a name you get to change; agents look here before
                building, and copy what they need with <code>ruri add</code>. For everything that was here
                before any of that, <b>Name everything</b> reads the repo, names each piece of interface it
                finds, and takes its picture if the project can be opened.
              </div>
            ) : shown.length === 0 ? (
              <div className="board-empty lib-empty">Nothing matches “{query}”.</div>
            ) : (
              <div className="lib-grid">
                {shown.map((item) => (
                  <Tile key={item.id} projectId={projectId} item={item} onOpen={() => setOpenId(item.id)} />
                ))}
              </div>
            )}

            {items.length > 0 && (
              <div className="board-foot">
                Written to <code>.ruri/components.md</code> in the project and to a skill for Claude, and
                handed to the model whenever a prompt names one. Agents search and install it with the{" "}
                <code>ruri</code> command.
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
