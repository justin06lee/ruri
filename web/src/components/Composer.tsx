import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HOME_ID, type Project } from "../../../shared/protocol";
import { fileToBase64 } from "../lib/files";
import { clearComposerDraft, composerDrafts, send, setComposerDraft, showError, useRuri } from "../store";
import { tooBigNotice, useConfirm } from "./Confirm";
import { AttachmentStrip, cropRegion, fileKind, Viewer, type ComposerAttachment, type Region } from "./Attachments";
import { CommandMenu, commandPrefix } from "./CommandMenu";
import { DragonGauges } from "./Dragon";
import { MarkerMirror } from "./Markers";
import {
  fitBox,
  backspaceHits,
  findMarkers,
  holdMarkers,
  holdMarkersAt,
  markerText,
  releaseMarkers,
  removeMarker,
  stripMarkers,
  type Marker,
} from "../lib/markers";
import { SessionControls } from "./SessionControls";
import type { SketchBackground } from "./Sketch";
import { Icon } from "./chat/Icon";
import { NO_QUEUED } from "./chat/empty";

/* The shell panel brings xterm with it — a quarter of the app's JavaScript,
   for a mode most sessions never turn on. It arrives when the `>_` button is
   pressed instead of on every launch. */
const TerminalPanel = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.TerminalPanel })),
);


/** The bar's flex gap, plus a little air, in the fold measurement. */
const BAR_GAP = 14;

/**
 * The composer's lesser buttons behind one, for a box too narrow to show
 * them all: the shell, the sketch pad, the scissors. Send stays out, and
 * so does stop — those are the ones a hand reaches for.
 */
function MoreActions({
  onShell,
  onSketch,
  onSplit,
}: {
  onShell(): void;
  onSketch?: () => void;
  /** Absent while there is nothing to split. */
  onSplit?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (fn?: () => void) => () => {
    setOpen(false);
    fn?.();
  };
  return (
    <div className="more-actions" ref={ref}>
      <button className={`more ${open ? "active" : ""}`} title="More" onClick={() => setOpen(!open)}>
        <svg className="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && (
        <div className="dropdown-menu up more-menu" role="menu">
          <button className="dropdown-item" role="menuitem" onClick={pick(onShell)}>
            <Icon d="M4 17l6-6-6-6M12 19h8" />
            Shell
          </button>
          {onSketch && (
            <button className="dropdown-item" role="menuitem" onClick={pick(onSketch)}>
              <Icon d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              Draw
            </button>
          )}
          <button className="dropdown-item" role="menuitem" disabled={!onSplit} onClick={pick(onSplit)}>
            <Icon d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.6 15.4M14.7 14.7L20 20M8.6 8.6L12 12" />
            Split and send
          </button>
        </div>
      )}
    </div>
  );
}

export function Composer({
  channelId,
  project,
  busy,
  onSent,
  onSketch,
}: {
  /** The session (or Home) this composer sends to. */
  channelId: string;
  project: Project;
  busy: boolean;
  /** Fires right after a prompt goes out (rapid fire advances on it). */
  onSent?: () => void;
  /** Open the sketch pad — blank, or on one of the attached pictures. */
  onSketch?: (background?: SketchBackground) => void;
}) {
  const projectId = channelId;
  const saved = composerDrafts.get(channelId);
  const [text, setText] = useState(holdMarkers(saved?.text ?? ""));
  const [atts, setAtts] = useState<ComposerAttachment[]>(saved?.atts ?? []);
  const [viewing, setViewing] = useState<string | null>(null);
  /** The attachment whose chip the pointer is over — lit in the strip, so
   *  a chip and its thumbnail read as one thing. */
  const [hot, setHot] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** The box has two modes: writing a prompt, and a shell in the project's
   *  directory. The shell keeps running either way — this only decides
   *  which one the box is showing. */
  const [shell, setShell] = useState(false);
  const counter = useRef(saved?.counter ?? { image: 0, video: 0, file: 0, region: 0 });
  /** Where the caret was last seen in the prompt — a marker drawn in the
   *  viewer lands there, since the textarea lost focus to the overlay. */
  const caretRef = useRef(0);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** The slash word the caret sits in, which is what opens the command
   *  menu — null when it is nowhere near one, or when Escape put it away
   *  until the word changes. */
  const [slash, setSlash] = useState<{ at: number; word: string } | null>(null);
  const dismissed = useRef<string | null>(null);
  /** The menu's own handler for the keys it owns while it is open. */
  const menuKey = useRef<((key: string) => boolean) | null>(null);
  const draftBump = useRuri((s) => s.draftBumps[channelId] ?? 0);
  const bumpSeen = useRef(draftBump);
  /** The queued prompt this box is rewriting, if any: sending puts it back
   *  in line rather than queueing a new one. */
  const editing = useRuri((s) => (s.queued[channelId] ?? NO_QUEUED).find((item) => item.editing));
  const barRef = useRef<HTMLDivElement>(null);
  /** Too narrow for three pickers and four buttons in a row: the pickers
   *  fold into one and the buttons behind a ⋯, leaving send (and stop). */
  const [compact, setCompact] = useState(false);
  /** What the unfolded bar needs, as last measured while unfolded — the
   *  folded bar is judged against that, since it cannot measure itself. */
  const need = useRef(0);
  const look = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    if (!bar.querySelector(".dropdown.combo, .more-actions")) {
      const controls = bar.querySelector<HTMLElement>(".composer-controls, .shell-where");
      const actions = bar.querySelector<HTMLElement>(".composer-actions");
      need.current = (controls?.offsetWidth ?? 0) + (actions?.offsetWidth ?? 0) + BAR_GAP;
    }
    setCompact(bar.clientWidth < need.current);
  }, []);
  // Whenever the bar, or what is in it, is laid out again: a label
  // changes, stop comes and goes, the window is resized. The parts are
  // other elements once the bar folds or the shell takes it, so they are
  // found again then.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(look);
    observer.observe(bar);
    for (const part of bar.querySelectorAll(".composer-controls, .shell-where, .composer-actions")) {
      observer.observe(part);
    }
    look();
    return () => observer.disconnect();
  }, [look, compact, shell]);

  // Every keystroke and attachment change lands in the per-channel draft —
  // and on disk, so a half-written prompt is still there after a ⌘Q.
  useEffect(() => {
    setComposerDraft(channelId, { text, atts, counter: counter.current });
  }, [channelId, text, atts]);

  /** Attach files; `at` places the [markers] at that text index (a drop's
   *  caret position or the paste caret) instead of the end. */
  const { confirm: ask, card } = useConfirm();
  const addFiles = (files: FileList | File[], at?: number) => {
    const added: ComposerAttachment[] = [];
    const tooBig = [...files].filter((file) => file.size > 25 * 1024 * 1024);
    if (tooBig.length) void ask(tooBigNotice(tooBig));
    for (const file of files) {
      if (tooBig.includes(file)) continue;
      const kind = fileKind(file);
      const n = ++counter.current[kind];
      added.push({
        id: crypto.randomUUID(),
        file,
        kind,
        mediaType: file.type || "application/octet-stream",
        name: file.name,
        n,
        objectUrl: URL.createObjectURL(file),
        regions: [],
      });
    }
    if (added.length === 0) return;
    setAtts((prev) => [...prev, ...added]);
    insertMarkers(added.map((a) => markerText(a.kind, a.n)).join(" "), at);
  };

  /** Drop marker text into the prompt at `at` (the end when unset), leaving
   *  the prompt's own text — trailing newlines included — untouched: only
   *  the spaces around the marker, so typing never sticks to a "]" or "[". */
  const insertMarkers = (markers: string, at?: number) => {
    setText((prev) => {
      const idx = at === undefined ? prev.length : Math.min(at, prev.length);
      const before = prev.slice(0, idx);
      const after = prev.slice(idx);
      const lead = before && !/\s$/.test(before) ? " " : "";
      const tail = /^\s/.test(after) ? "" : " ";
      // the caret follows the marker, so the next one lands after it — and
      // the markers may have landed against another chip, which is what the
      // spacing rules are for
      const held = holdMarkersAt(
        `${before}${lead}${markers}${tail}${after}`,
        before.length + lead.length + markers.length + tail.length,
      );
      caretRef.current = held.caret;
      return held.text;
    });
  };

  /** A box drawn in the viewer: it takes the next region number in this
   *  prompt and its marker lands where the caret was, so what you have to
   *  say about it is written in the prompt like anything else. */
  const addRegion = (attId: string, rect: { x: number; y: number; w: number; h: number }) => {
    const n = ++counter.current.region;
    setAtts((prev) =>
      prev.map((a) => (a.id === attId ? { ...a, regions: [...a.regions, { ...rect, n }] } : a)),
    );
    insertMarkers(markerText("region", n), caretRef.current);
  };

  // The drop point as a text index — computed ONCE, at drop time. (Never
  // call this from dragover: hit-testing on every drag frame can wedge
  // Chromium's drag session so the drop never fires at all.)
  const caretFromPoint = (x: number, y: number): number | null => {
    try {
      const area = areaRef.current;
      const doc = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      };
      if (!area || !doc.caretPositionFromPoint) return null;
      const pos = doc.caretPositionFromPoint(x, y);
      if (!pos) return null;
      // Chromium reports a caret inside a text control as (the control, offset)
      if (pos.offsetNode === area || area.contains(pos.offsetNode)) {
        return Math.min(pos.offset, area.value.length);
      }
      return null;
    } catch {
      // best-effort — a failed lookup just appends at the end
      return null;
    }
  };

  /** An attachment goes, and every marker that stood for it goes with it —
   *  its own, and those of the regions drawn on it. Words that pointed at
   *  a picture that is no longer there would only mislead. */
  const removeAtt = (id: string) => {
    const target = atts.find((a) => a.id === id);
    if (!target) return;
    URL.revokeObjectURL(target.objectUrl);
    const regions = new Set(target.regions.map((r) => r.n));
    setAtts((prev) => prev.filter((a) => a.id !== id));
    setText((prev) =>
      stripMarkers(
        prev,
        (m) => (m.kind === target.kind && m.n === target.n) || (m.kind === "region" && regions.has(m.n)),
      ),
    );
    if (hot === id) setHot(null);
  };

  /** The viewer took a region off a picture: its marker leaves the prompt. */
  const setRegions = (id: string, regions: Region[]) => {
    const kept = new Set(regions.map((r) => r.n));
    const gone = new Set(
      (atts.find((a) => a.id === id)?.regions ?? []).map((r) => r.n).filter((n) => !kept.has(n)),
    );
    setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, regions } : a)));
    if (gone.size) setText((prev) => stripMarkers(prev, (m) => m.kind === "region" && gone.has(m.n)));
  };

  /** The attachment a marker stands for: its own, or the one a region was
   *  drawn on. */
  const attachmentFor = (marker: Marker): ComposerAttachment | undefined =>
    marker.kind === "region"
      ? atts.find((a) => a.regions.some((r) => r.n === marker.n))
      : atts.find((a) => a.kind === marker.kind && a.n === marker.n);

  /** A chip was clicked: a command leaves the prompt, an attachment's chip
   *  opens the attachment — the same viewer its thumbnail opens. */
  const openMarker = (marker: Marker) => {
    if (marker.kind === "command") {
      const next = removeMarker(text, marker);
      setText(next.text);
      placeCaret(next.caret);
      return;
    }
    const att = attachmentFor(marker);
    if (!att) return;
    caretRef.current = marker.end;
    setViewing(att.id);
  };

  /** Backspace right after a chip (or inside one), Delete right before:
   *  the whole marker goes, never half of it. */
  const deleteMarkerAt = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const area = e.currentTarget;
    if (area.selectionStart !== area.selectionEnd) return false;
    const at = area.selectionStart;
    const hit = findMarkers(text)
      .filter(markerPresent)
      .find((m) =>
        e.key === "Backspace" ? backspaceHits(text, m, at) : at >= m.start && at < m.end,
      );
    if (!hit) return false;
    // what the chip stood between may now be two words, or two chips
    const cut = removeMarker(text, hit);
    const next = holdMarkersAt(cut.text, cut.caret);
    setText(next.text);
    placeCaret(next.caret);
    return true;
  };

  // The markers in the prompt draw as chips over the textarea (see
  // Markers.tsx) — only while they stand for something in the strip: a
  // marker whose file was removed is words again.
  const markerPresent = useCallback(
    (marker: Marker) =>
      marker.kind === "command"
        ? true
        : marker.kind === "region"
          ? atts.some((a) => a.regions.some((r) => r.n === marker.n))
          : atts.some((a) => a.kind === marker.kind && a.n === marker.n),
    [atts],
  );
  /** Whether the caret is inside a slash word, and which. Every place the
   *  caret moves says so, since a menu that only opened on typing would
   *  hang around after an arrow key took the caret elsewhere. */
  const trackSlash = (text: string, caret: number) => {
    const found = commandPrefix(text, caret);
    if (!found) {
      dismissed.current = null;
      setSlash(null);
      return;
    }
    if (dismissed.current !== null && dismissed.current !== found.word) dismissed.current = null;
    setSlash(dismissed.current === found.word ? null : found);
  };

  const placeCaret = (index: number) => {
    caretRef.current = index;
    requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.setSelectionRange(index, index);
    });
  };

  const autosize = useCallback(() => {
    const area = areaRef.current;
    if (!area) return;
    // Reading scrollHeight forces the browser to lay the whole page out, and
    // this runs on every mount — including the one a session switch causes,
    // where the box is usually empty and the answer is always one row. So an
    // empty box skips the measurement entirely and the switch skips a reflow.
    if (!area.value) {
      area.style.height = "";
      return;
    }
    fitBox(area, 220);
  }, []);

  // The draft changed from outside (a review's fix-it prompt, a rewound
  // prompt, a saved draft's files arriving after a launch): the map is the
  // source of truth — re-read it, attachments and marker numbering included.
  // Heard from the store as the bump lands (the map is always written
  // first), rather than noticed by an effect after a render.
  useEffect(
    () =>
      useRuri.subscribe((s) => {
        const bump = s.draftBumps[channelId] ?? 0;
        if (bump === bumpSeen.current) return;
        bumpSeen.current = bump;
        const fresh = composerDrafts.get(channelId);
        if (!fresh) return;
        setText(holdMarkers(fresh.text));
        setAtts((prev) => (prev === fresh.atts ? prev : fresh.atts));
        counter.current = fresh.counter;
        requestAnimationFrame(() => areaRef.current?.focus());
      }),
    [channelId],
  );

  const submit = async (mode: "send" | "send_split" = "send") => {
    const trimmed = releaseMarkers(text).trim();
    if (!trimmed && atts.length === 0) return;
    const uploads = await Promise.all(
      atts.map(async (att) => ({
        id: att.id,
        kind: att.kind,
        mediaType: att.mediaType,
        name: att.name,
        n: att.n,
        data: await fileToBase64(att.file),
        ...(att.regions.length
          ? {
              regions: await Promise.all(
                att.regions.map(async (region) => ({
                  n: region.n,
                  data: await cropRegion(att.objectUrl, region),
                  mediaType: "image/png",
                  rect: { x: region.x, y: region.y, w: region.w, h: region.h },
                })),
              ),
            }
          : {}),
      })),
    );
    const sent = editing
      ? // the rewrite goes back in line where the prompt was
        send({
          type: "queue_update",
          projectId,
          itemId: editing.id,
          text: trimmed,
          ...(uploads.length ? { attachments: uploads } : {}),
          ...(mode === "send_split" ? { split: true } : {}),
        })
      : send({
          type: mode,
          projectId,
          text: trimmed,
          ...(uploads.length ? { attachments: uploads } : {}),
        });
    // nothing took it: the prompt stays here, files and all, to send again
    if (!sent) {
      showError("Not connected — the prompt stays in the composer; send again once ruri is back.");
      return;
    }
    for (const att of atts) URL.revokeObjectURL(att.objectUrl);
    clearComposerDraft(channelId);
    setAtts([]);
    setText("");
    onSent?.();
  };

  // Fit the height after every committed text change — mount (restored
  // drafts), typing, marker drops, seeds, and the post-send clear. A layout
  // effect, so it measures the DOM *after* React writes the new value (a
  // rAF here could fire first and measure the stale text, leaving a sent
  // long prompt's height behind).
  useLayoutEffect(() => autosize(), [autosize, text]);

  // The box is fitted to its text, but the text's shape depends on the box:
  // widen it and the same prompt needs fewer lines. Fitting on the prompt
  // alone leaves the box as tall as it was before the window was resized —
  // and a textarea taller than its own text reports *its* height as the
  // text's, which is what the chip mirror measures itself against. That is
  // how a resize with no keystroke after it used to take every chip off the
  // prompt until the next one. So the box refits whenever the textarea is
  // laid out again, and once the fonts have landed. Fitting is idempotent:
  // the settled height is the one this writes, so the observer sees no new
  // size and does not come round again.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const observer = new ResizeObserver(autosize);
    observer.observe(area);
    void document.fonts?.ready.then(autosize);
    return () => observer.disconnect();
    // a fresh textarea comes up each time the shell gives the box back
  }, [shell, autosize]);

  /** The box as it was when the shell took its place: the caret, the
   *  scroll. The textarea is unmounted while the shell shows, and a fresh
   *  one comes up one row tall with the caret at the start — so on the
   *  way back it is measured again and put back exactly where it was. */
  const held = useRef<{ start: number; end: number; top: number } | null>(null);
  const toggleShell = () => {
    const area = areaRef.current;
    if (!shell && area) held.current = { start: area.selectionStart, end: area.selectionEnd, top: area.scrollTop };
    setShell(!shell);
  };
  useLayoutEffect(() => {
    if (shell) return;
    autosize();
    const was = held.current;
    const area = areaRef.current;
    if (!was || !area) return;
    held.current = null;
    area.focus();
    area.setSelectionRange(was.start, was.end);
    area.scrollTop = was.top;
    caretRef.current = was.start;
  }, [shell, autosize]);

  const viewingAtt = atts.find((a) => a.id === viewing);

  return (
    <div className="composer">
      {card}
      <div className="composer-row">
        <DragonGauges channelId={channelId} model={project.model} side="left" />
        <div
          className={`composer-box ${dragOver ? "drag-over" : ""} ${compact ? "compact" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files, caretFromPoint(e.clientX, e.clientY) ?? undefined);
          }}
        >
          {shell && (
            <Suspense fallback={<div className="terminal" />}>
              <TerminalPanel channelId={channelId} />
            </Suspense>
          )}
          {!shell && editing && (
            <div className="composer-editing">
              <span>rewriting a queued prompt — Enter puts it back in line</span>
              <button
                className="ghost"
                title="Never mind — the prompt goes back in line as it was"
                onClick={() => {
                  send({ type: "queue_edit_cancel", projectId, itemId: editing.id });
                  for (const att of atts) URL.revokeObjectURL(att.objectUrl);
                  clearComposerDraft(channelId);
                  setAtts([]);
                  setText("");
                }}
              >
                put it back
              </button>
            </div>
          )}
          {!shell && (
            <AttachmentStrip
              attachments={atts}
              highlight={hot}
              onRemove={removeAtt}
              onView={(a) => {
                // the caret as the prompt last had it — the viewer is about
                // to take focus, and a region drawn in there lands right here
                caretRef.current = areaRef.current?.selectionStart ?? text.length;
                setViewing(a.id);
              }}
            />
          )}
          {!shell && (
          <div className="composer-field">
          <textarea
            ref={areaRef}
            rows={1}
            placeholder="Message ruri…"
            value={text}
            onChange={(e) => {
              const held = holdMarkersAt(e.target.value, e.target.selectionStart);
              caretRef.current = held.caret;
              setText(held.text);
              trackSlash(held.text, held.caret);
              // a space kept between a chip and the word just typed against
              // it: the caret goes back to the end of that word
              if (held.caret !== e.target.selectionStart) placeCaret(held.caret);
            }}
            // wherever the caret was when the viewer took focus is where a
            // region's marker goes
            onSelect={(e) => {
              caretRef.current = e.currentTarget.selectionStart;
              trackSlash(e.currentTarget.value, e.currentTarget.selectionStart);
            }}
            onKeyDown={(e) => {
              // while the command menu stands, the arrows, Enter, Tab and
              // Escape are its keys — Enter takes a command rather than
              // sending a prompt that is half a command's name
              if (slash && menuKey.current?.(e.key)) {
                e.preventDefault();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
                return;
              }
              if ((e.key === "Backspace" || e.key === "Delete") && deleteMarkerAt(e)) e.preventDefault();
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length > 0) {
                e.preventDefault();
                addFiles(files, areaRef.current?.selectionStart ?? undefined);
              }
            }}
          />
          <MarkerMirror
            areaRef={areaRef}
            text={text}
            present={markerPresent}
            refit={autosize}
            onMove={(next) => {
              setText(next.text);
              placeCaret(next.caret);
            }}
            onOpen={openMarker}
            onHover={(marker) => setHot(marker ? (attachmentFor(marker)?.id ?? null) : null)}
          />
          </div>
          )}
          {/* a child of the box, not of the field: what the menu has to
              stand clear of is the whole box, and the field's top slides
              down whenever attachments sit above it */}
          {slash && (
            <CommandMenu
              projectId={channelId === HOME_ID ? undefined : projectId}
              word={slash.word}
              pickRef={menuKey}
              onClose={() => {
                dismissed.current = slash.word;
                setSlash(null);
              }}
              onPick={(command) => {
                // the whole slash word becomes the command, with the space
                // that finishes it — which is also what makes it a chip
                const before = text.slice(0, slash.at);
                const after = text.slice(slash.at + 1 + slash.word.length);
                const lead = `/${command.name}`;
                const tail = after.startsWith(" ") ? "" : " ";
                const next = holdMarkersAt(`${before}${lead}${tail}${after}`, before.length + lead.length + tail.length);
                setText(next.text);
                placeCaret(next.caret);
                dismissed.current = null;
                setSlash(null);
              }}
            />
          )}
          <div className="composer-bar" ref={barRef}>
            {shell ? (
              <span className="shell-where">{project.name} · shell</span>
            ) : (
              <SessionControls project={project} channelId={channelId} compact={compact} />
            )}
            <div className="composer-actions">
              {compact && !shell && (
                <MoreActions
                  onShell={toggleShell}
                  onSketch={onSketch ? () => onSketch() : undefined}
                  onSplit={text.trim() ? () => void submit("send_split") : undefined}
                />
              )}
              {(!compact || shell) && (
                <button
                  className={`shell-toggle ${shell ? "active" : ""}`}
                  title={shell ? "Back to writing a prompt" : "A shell in this project's directory"}
                  onClick={toggleShell}
                >
                  <Icon d={shell ? "M4 6h16M4 12h10M4 18h16" : "M4 17l6-6-6-6M12 19h8"} />
                </button>
              )}
              {!compact && !shell && onSketch && (
                <button
                  className="sketch-toggle"
                  title="Draw — a sketch to show the model, or open a picture to draw on"
                  onClick={() => onSketch()}
                >
                  <Icon d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </button>
              )}
              {busy && !shell && (
                <button
                  className="stop"
                  title="Interrupt the running turn"
                  onClick={() => send({ type: "interrupt", projectId })}
                >
                  <svg className="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              )}
              {!compact && !shell && (
                <button
                  className="split-send"
                  title="Split into separate prompts and send them one by one"
                  onClick={() => void submit("send_split")}
                  disabled={!text.trim()}
                >
                  <Icon d="M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.6 15.4M14.7 14.7L20 20M8.6 8.6L12 12" />
                </button>
              )}
              {!shell && (
                <button
                  className="send"
                  title="Send (Enter)"
                  onClick={() => void submit()}
                  disabled={!text.trim() && atts.length === 0}
                >
                  <Icon d="M12 19V5M5 12l7-7 7 7" />
                </button>
              )}
            </div>
          </div>
        </div>
        <DragonGauges channelId={channelId} model={project.model} side="right" />
      </div>
      <div className="composer-hint">
        {shell
          ? "Shells in this project — ⌘T for another, ⌘1–9 to switch · they keep running while you're away"
          : editing
            ? "Enter puts the rewrite back in line · the prompts behind it go on without it meanwhile"
            : compact
              ? "Enter to send · Shift+Enter for a new line · drop files to attach"
              : "Enter to send · Shift+Enter for a new line · drop images, videos, or files to attach · scissors to split a long prompt"}
      </div>
      {viewingAtt && (
        <Viewer
          target={{
            kind: viewingAtt.kind,
            src: viewingAtt.objectUrl,
            label: `${viewingAtt.kind} #${viewingAtt.n} — ${viewingAtt.name}`,
            name: viewingAtt.name,
            mediaType: viewingAtt.mediaType,
            attachment: viewingAtt,
          }}
          onClose={() => setViewing(null)}
          onRegions={setRegions}
          onRegionAdd={addRegion}
          {...(onSketch && viewingAtt.kind === "image"
            ? {
                onDraw: () => {
                  setViewing(null);
                  onSketch({ id: viewingAtt.id, url: viewingAtt.objectUrl, name: viewingAtt.name });
                },
              }
            : {})}
        />
      )}
    </div>
  );
}
