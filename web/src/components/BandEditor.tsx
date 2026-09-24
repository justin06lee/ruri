import { useEffect, useRef, useState } from "react";
import {
  BAND_H,
  BAND_THEMES,
  BAND_W,
  EFFECTS,
  getBand,
  MAX_PICTURES,
  newId,
  offThemes,
  resetBand,
  setBand,
  SPEED_MAX,
  SPEED_MIN,
  useBand,
  type Animate,
  type BandPicture,
  type HoverEffect,
} from "../band";
import { loadPicture, pictureUrl, storePicture, usePicture } from "../pictures";
import type { Theme } from "../theme";
import { useConfirm } from "./Confirm";
import { Dropdown } from "./Dropdown";
import { BandPic } from "./PeekBand";
import { NumField, Row } from "./SettingsRows";

/**
 * Settings → Peek band: the pictures across the top of the sidebar, set up
 * by hand.
 *
 * The band is drawn here at twice its size, over a strip showing faintly
 * what hangs below it (the real one clips that away): drag a picture to
 * place it, scroll over one to size it, arrow keys to nudge the one
 * picked. Hovering one here does what it will do there. Every change is on
 * the sidebar the moment it is made (band.ts keeps it a beat later). A
 * picture kept to some themes is on the stage only while one of those is.
 */

const SCALE = 2;
/** Band-space px shown under the band, for what hangs below it. */
const BELOW = 40;

const EFFECT_OPTIONS = (Object.keys(EFFECTS) as HoverEffect[]).map((value) => ({
  value,
  label: EFFECTS[value].label,
}));

const THEME_LABEL: Record<Theme, string> = { light: "Light", dark: "Dark", ember: "Ember" };

const ANIMATE: Array<{ value: Animate; label: string; title: string }> = [
  {
    value: "always",
    label: "Always",
    title: "Plays all the time (held still while ruri is not the window in use)",
  },
  {
    value: "hover",
    label: "On hover",
    title: "Rests on its first frame; plays from the start while the pointer is on it",
  },
  { value: "still", label: "Still", title: "Never plays: its first frame" },
];

/** Change one picture, reading the band as it is now (a drag outlives the
 *  render it started in). */
function update(id: string, patch: Partial<BandPicture>): void {
  setBand({ pictures: getBand().pictures.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
}

/** Turn one theme on or off for a picture — never the last one, a picture
 *  on no theme at all being one to remove instead. All three is stored as
 *  no list, the way a picture that has never been kept to any is. */
function toggleTheme(picture: BandPicture, theme: Theme): void {
  const on = picture.themes ?? BAND_THEMES;
  const next = on.includes(theme)
    ? on.filter((t) => t !== theme)
    : BAND_THEMES.filter((t) => t === theme || on.includes(t));
  if (next.length === 0) return;
  setBand({
    pictures: getBand().pictures.map((p) => {
      if (p.id !== picture.id) return p;
      const { themes: _was, ...rest } = p;
      return next.length === BAND_THEMES.length ? rest : { ...rest, themes: next };
    }),
  });
}

/** A picture small enough to pick from a strip, held still if it moves. */
function Thumb({ src, invert, flip }: { src: string; invert?: boolean; flip?: boolean }) {
  const art = usePicture(src);
  return (
    <span className={`band-pic bandedit-thumb${invert ? " invert" : ""}`}>
      <span className="band-art fx-art">
        <img
          className={`band-img${flip ? " flip" : ""}`}
          src={art?.still ?? art?.url ?? pictureUrl(src)}
          alt=""
          draggable={false}
        />
      </span>
    </span>
  );
}

/** One of the faint copies under the band: the whole picture, where the
 *  band cuts it off. */
function Ghost({ picture }: { picture: BandPicture }) {
  const art = usePicture(picture.src);
  return (
    <div
      className={`band-pic${picture.invert ? " invert" : ""}${offThemes(picture)}`}
      style={{ left: picture.x, top: picture.drop, width: picture.w }}
    >
      <div className="band-art fx-art">
        <img
          className={`band-img${picture.flip ? " flip" : ""}`}
          src={art?.still ?? art?.url ?? pictureUrl(picture.src)}
          alt=""
          draggable={false}
        />
      </div>
    </div>
  );
}

export function BandEditor() {
  const { pictures } = useBand();
  const [picked, setPicked] = useState<string | null>(() => getBand().pictures[0]?.id ?? null);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState(0);
  const [problem, setProblem] = useState<string>();
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /** What the file picker is open for. */
  const pickFor = useRef<"add" | "replace" | "hover">("add");
  const { confirm, card } = useConfirm();

  const selected = pictures.find((p) => p.id === picked);
  const art = usePicture(selected?.src);

  // scrolling over a picture sizes it — and must not scroll the page too,
  // which a React wheel handler (passive) cannot stop
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      const id = (e.target as Element).closest<HTMLElement>(".band-pic[data-id]")?.dataset["id"];
      const picture = id ? getBand().pictures.find((p) => p.id === id) : undefined;
      if (!picture) return;
      e.preventDefault();
      setPicked(picture.id);
      update(picture.id, { w: Math.min(BAND_W * 2, Math.max(8, Math.round(picture.w - e.deltaY * 0.25))) });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  const startMove = (e: React.PointerEvent, picture: BandPicture) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPicked(picture.id);
    stageRef.current?.focus();
    const from = { x: e.clientX, y: e.clientY, px: picture.x, py: picture.drop };
    setMoving(true);
    const move = (ev: PointerEvent) =>
      update(picture.id, {
        x: Math.round(from.px + (ev.clientX - from.x) / SCALE),
        drop: Math.round(from.py + (ev.clientY - from.y) / SCALE),
      });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMoving(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const nudge = (e: React.KeyboardEvent) => {
    if (!selected) return;
    const step = e.shiftKey ? 10 : 1;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = by[e.key];
    if (!d) return;
    e.preventDefault();
    update(selected.id, { x: selected.x + d[0], drop: selected.drop + d[1] });
  };

  const add = async (files: File[]) => {
    setProblem(undefined);
    const room = MAX_PICTURES - getBand().pictures.length;
    if (room <= 0) {
      setProblem(`The band holds ${MAX_PICTURES} pictures at most.`);
      return;
    }
    if (files.length > room) setProblem(`Only ${room} more fit — the band holds ${MAX_PICTURES} at most.`);
    for (const file of files.slice(0, room)) {
      setAdding((n) => n + 1);
      try {
        const src = await storePicture(file, "band");
        const loaded = await loadPicture(src);
        // as tall as the band, to start: all of it showing, in the middle
        let w = 64;
        if (loaded) {
          const img = new Image();
          img.src = loaded.url;
          await img.decode().catch(() => {});
          if (img.naturalWidth && img.naturalHeight) {
            w = Math.round(Math.min(BAND_W, Math.max(16, (BAND_H * img.naturalWidth) / img.naturalHeight)));
          }
        }
        const picture: BandPicture = {
          id: newId(),
          src,
          x: Math.round((BAND_W - w) / 2),
          drop: 0,
          w,
          effect: "none",
          amount: 0,
          speed: EFFECTS.none.speed,
          animate: "always",
          invert: false,
          flip: false,
        };
        setBand({ pictures: [...getBand().pictures, picture] });
        setPicked(picture.id);
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setAdding((n) => n - 1);
      }
    }
  };

  const swap = async (file: File, field: "src" | "hoverSrc") => {
    if (!selected) return;
    setProblem(undefined);
    setAdding((n) => n + 1);
    try {
      update(selected.id, { [field]: await storePicture(file, "band") });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding((n) => n - 1);
    }
  };

  const openPicker = (purpose: "add" | "replace" | "hover") => {
    pickFor.current = purpose;
    const input = fileRef.current;
    if (!input) return;
    input.multiple = purpose === "add";
    input.value = "";
    input.click();
  };

  const onPicked = (files: File[]) => {
    if (files.length === 0) return;
    if (pickFor.current === "add") void add(files);
    else void swap(files[0]!, pickFor.current === "hover" ? "hoverSrc" : "src");
  };

  const remove = (id: string) => {
    const at = getBand().pictures.findIndex((p) => p.id === id);
    const rest = getBand().pictures.filter((p) => p.id !== id);
    setBand({ pictures: rest });
    setPicked(rest[Math.min(at, rest.length - 1)]?.id ?? null);
  };

  const dropHover = (id: string) =>
    setBand({
      pictures: getBand().pictures.map((p) => {
        if (p.id !== id) return p;
        const { hoverSrc: _gone, ...kept } = p;
        return kept;
      }),
    });

  const reorder = (id: string, by: -1 | 1) => {
    const list = [...getBand().pictures];
    const at = list.findIndex((p) => p.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to]!, list[at]!];
    setBand({ pictures: list });
  };

  const restore = async () => {
    const yes = await confirm({
      title: "Put the default band back?",
      body: "The band goes back to the mountain path — by day on light, at night on dark, at sunset on ember. Your pictures leave the band.",
      ok: "Restore",
    });
    if (!yes) return;
    resetBand();
    setPicked(getBand().pictures[0]?.id ?? null);
  };

  const spec = selected ? EFFECTS[selected.effect] : undefined;

  return (
    <div className="bandedit">
      {card}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/apng,image/svg+xml"
        hidden
        onChange={(e) => onPicked([...(e.target.files ?? [])])}
      />

      <div
        ref={stageRef}
        className={`bandedit-stage${moving ? " moving" : ""}`}
        style={{ width: BAND_W * SCALE, height: (BAND_H + BELOW) * SCALE }}
        tabIndex={0}
        onKeyDown={nudge}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as Element).classList.contains("bandedit-band")) {
            setPicked(null);
          }
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.items].some((item) => item.kind === "file")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          void add([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
        }}
      >
        <div
          className="bandedit-space"
          style={{ width: BAND_W, height: BAND_H + BELOW, transform: `scale(${SCALE})` }}
        >
          <div className="bandedit-ghosts" aria-hidden>
            {pictures.map((picture) => (
              <Ghost key={picture.id} picture={picture} />
            ))}
          </div>
          <div className="bandedit-band" style={{ width: BAND_W, height: BAND_H }}>
            {pictures.map((picture) => (
              <BandPic
                key={picture.id}
                picture={picture}
                quiet={moving}
                data-id={picture.id}
                className={picture.id === picked ? "picked" : ""}
                onPointerDown={(e) => startMove(e, picture)}
              />
            ))}
            {/* where the window's own buttons sit over the band */}
            <span className="bandedit-lights" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>
      </div>
      <p className="settings-note bandedit-hint">
        Twice its real size. Drag a picture to place it, scroll over it to size it, arrow keys nudge the one
        picked (hold Shift for ten). Drop pictures here to add them. The faint part under the line is what the
        band cuts off.
      </p>

      <div className="bandedit-strip">
        {pictures.map((picture) => (
          <button
            key={picture.id}
            className={`bandedit-chip${picture.id === picked ? " active" : ""}`}
            title="Pick this picture"
            onClick={() => setPicked(picture.id)}
          >
            <Thumb src={picture.src} invert={picture.invert} flip={picture.flip} />
          </button>
        ))}
        <button
          className="bandedit-chip add"
          disabled={pictures.length >= MAX_PICTURES}
          title={pictures.length >= MAX_PICTURES ? `The band holds ${MAX_PICTURES} at most` : "Add pictures"}
          onClick={() => openPicker("add")}
        >
          +
        </button>
        <span className="bandedit-count">
          {adding > 0 ? "adding…" : `${pictures.length} of ${MAX_PICTURES}`}
        </span>
        <button className="ghost bandedit-restore" onClick={() => void restore()}>
          Restore the default
        </button>
      </div>
      {problem && <p className="settings-note bandedit-problem">{problem}</p>}

      {selected && spec ? (
        <div className="bandedit-panel">
          <Row label="Picture">
            <button className="ghost" onClick={() => openPicker("replace")}>
              Replace…
            </button>
            <button
              className="ghost"
              onClick={() => reorder(selected.id, 1)}
              title="Draw it over the one in front"
            >
              Forward
            </button>
            <button
              className="ghost"
              onClick={() => reorder(selected.id, -1)}
              title="Draw it under the one behind"
            >
              Back
            </button>
            <button className="ghost" onClick={() => remove(selected.id)}>
              Remove
            </button>
          </Row>

          <Row label="On hover">
            <Dropdown
              value={selected.effect}
              options={EFFECT_OPTIONS}
              onSelect={(value) => {
                const effect = value as HoverEffect;
                update(selected.id, { effect, amount: EFFECTS[effect].amount, speed: EFFECTS[effect].speed });
              }}
            />
            <button
              className="ghost"
              title="Give every picture in the band this hover"
              onClick={() =>
                setBand({
                  pictures: getBand().pictures.map((p) => ({
                    ...p,
                    effect: selected.effect,
                    amount: selected.amount,
                    speed: selected.speed,
                  })),
                })
              }
            >
              Use on every picture
            </button>
          </Row>

          {selected.effect !== "none" && (
            <>
              <Row label="Strength">
                <input
                  type="range"
                  className="bandedit-range"
                  min={spec.min}
                  max={spec.max}
                  value={selected.amount}
                  onChange={(e) => update(selected.id, { amount: Number(e.target.value) })}
                />
                <span className="bandedit-readout">
                  {selected.amount}
                  {spec.unit}
                </span>
              </Row>
              <Row label="Speed">
                <input
                  type="range"
                  className="bandedit-range"
                  min={SPEED_MIN}
                  max={SPEED_MAX}
                  step={10}
                  value={selected.speed}
                  onChange={(e) => update(selected.id, { speed: Number(e.target.value) })}
                />
                <span className="bandedit-readout">
                  {selected.speed} ms{spec.loops ? " a round" : ""}
                </span>
              </Row>
            </>
          )}

          <Row label="Hover picture">
            {selected.hoverSrc ? (
              <>
                <span className="bandedit-chip still">
                  <Thumb src={selected.hoverSrc} invert={selected.invert} flip={selected.flip} />
                </span>
                <button className="ghost" onClick={() => openPicker("hover")}>
                  Change…
                </button>
                <button className="ghost" onClick={() => dropHover(selected.id)}>
                  Remove
                </button>
              </>
            ) : (
              <>
                <button className="ghost" onClick={() => openPicker("hover")}>
                  Pick one…
                </button>
                <span className="settings-note">
                  shown instead while the pointer is on it; a GIF plays from the start
                </span>
              </>
            )}
          </Row>

          {art?.animated && (
            <Row label="Animation">
              <div className="seg">
                {ANIMATE.map((option) => (
                  <button
                    key={option.value}
                    className={`seg-option ${selected.animate === option.value ? "active" : ""}`}
                    title={option.title}
                    onClick={() => update(selected.id, { animate: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </Row>
          )}

          <Row label="Themes">
            <div className="seg">
              {BAND_THEMES.map((theme) => {
                const on = !selected.themes || selected.themes.includes(theme);
                const last = on && (selected.themes?.length ?? BAND_THEMES.length) === 1;
                return (
                  <button
                    key={theme}
                    className={`seg-option ${on ? "active" : ""}`}
                    aria-disabled={last}
                    title={
                      last
                        ? "Its only theme — remove the picture instead"
                        : `${on ? "Take it off" : "Show it on"} the ${theme} theme`
                    }
                    onClick={() => toggleTheme(selected, theme)}
                  >
                    {THEME_LABEL[theme]}
                  </button>
                );
              })}
            </div>
            <span className="settings-note">
              {selected.themes ? "only on these — the stage shows the theme you're on" : "on every theme"}
            </span>
          </Row>

          <Row label="Dark themes">
            <button
              className={`seg-option toggle ${selected.invert ? "active" : ""}`}
              onClick={() => update(selected.id, { invert: !selected.invert })}
            >
              {selected.invert ? "On" : "Off"}
            </button>
            <span className="settings-note">
              {selected.invert ? "ink and paper swap, for line art" : "keeps its own colours"}
            </span>
          </Row>

          <Row label="Mirror">
            <button
              className={`seg-option toggle ${selected.flip ? "active" : ""}`}
              onClick={() => update(selected.id, { flip: !selected.flip })}
            >
              {selected.flip ? "On" : "Off"}
            </button>
          </Row>

          <Row label="Place">
            {(
              [
                ["x", "from the left", selected.x],
                ["drop", "down", selected.drop],
                ["w", "wide", selected.w],
              ] as const
            ).map(([field, label, value]) => (
              <NumField
                key={`${selected.id}-${field}`}
                label={label}
                value={value}
                onChange={(n) => update(selected.id, { [field]: field === "w" ? Math.max(8, n) : n })}
              />
            ))}
          </Row>
        </div>
      ) : (
        pictures.length === 0 && (
          <p className="settings-note">The band is bare. Add pictures with + or drop them on it.</p>
        )
      )}
    </div>
  );
}
