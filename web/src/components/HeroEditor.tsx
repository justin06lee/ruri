import { useEffect, useRef, useState } from "react";
import {
  builtinFace,
  getHero,
  GREETING_CHARS,
  type HeroBackdrop,
  type HeroFace,
  type HeroShape,
  type HeroShuffle,
  MAX_FACES,
  MAX_GREETINGS,
  patchHero,
  resetHero,
  SHIFT_MAX,
  SIZE_MAX,
  SIZE_MIN,
  useHero,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../hero";
import { type Animate, EFFECTS, type HoverEffect, SPEED_MAX, SPEED_MIN } from "../lib/effects";
import { newId } from "../lib/peekBand";
import { loadPicture, storePicture, usePicture } from "../pictures";
import { useConfirm } from "./Confirm";
import { Dropdown } from "./Dropdown";
import { FacePortrait, type FaceLook } from "./HeroFace";
import { NumField, Row } from "./SettingsRows";

/**
 * Settings → Hero face: the face over an empty chat, set up by hand.
 *
 * The faces it can be — the twelve it came with and any of the user's own
 * — sit in a grid beside the one picked, drawn at its real size in its real
 * frame: drag it to slide it in the frame, scroll to zoom, hover to see
 * what it does. Above that, whether there is a face at all and how one is
 * chosen; below, the picked face's own settings, then the frame and the
 * hover every face shares, then what Home says.
 */

const EFFECT_OPTIONS = (Object.keys(EFFECTS) as HoverEffect[]).map((value) => ({
  value,
  label: EFFECTS[value].label,
}));

const SHUFFLE: Array<{ value: HeroShuffle; label: string; note: string }> = [
  {
    value: "project",
    label: "Per project",
    note: "each project keeps the face it was given; Home draws a new one every launch",
  },
  { value: "launch", label: "Each launch", note: "every chat draws a new face each time ruri opens" },
  { value: "visit", label: "Every visit", note: "a new face every time one comes up" },
];

const SHAPES: Array<{ value: HeroShape; label: string }> = [
  { value: "circle", label: "Circle" },
  { value: "rounded", label: "Rounded" },
  { value: "square", label: "Square" },
  { value: "none", label: "None" },
];

const BACKDROPS: Array<{ value: HeroBackdrop; label: string }> = [
  { value: "white", label: "White" },
  { value: "paper", label: "Paper" },
  { value: "none", label: "None" },
];

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

/** A built-in face goes back to how the tuner framed it; the user's own to
 *  the middle, whole. */
const BUILTIN = /^v(\d+)$/;

function updateFace(id: string, patch: Partial<HeroFace>): void {
  patchHero({ faces: getHero().faces.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
}

function Seg<T extends string>({
  options,
  value,
  onPick,
}: {
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onPick(value: T): void;
}) {
  return (
    <div className="seg">
      {options.map((option) => (
        <button
          key={option.value}
          className={`seg-option ${value === option.value ? "active" : ""}`}
          {...(option.title ? { title: option.title } : {})}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  on,
  onFlip,
  labels = ["On", "Off"],
}: {
  on: boolean;
  onFlip(): void;
  labels?: [string, string];
}) {
  return (
    <button className={`seg-option toggle ${on ? "active" : ""}`} onClick={onFlip}>
      {on ? labels[0] : labels[1]}
    </button>
  );
}

export function HeroEditor() {
  const hero = useHero();
  const [picked, setPicked] = useState<string | undefined>(() => {
    const now = getHero();
    return now.mode === "one" ? now.one : now.faces[0]?.id;
  });
  const [framing, setFraming] = useState(false);
  const [adding, setAdding] = useState(0);
  const [problem, setProblem] = useState<string>();
  const [greetings, setGreetings] = useState(() => getHero().greetings.join("\n"));
  const previewRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pickFor = useRef<"add" | "replace" | "hover">("add");
  const { confirm, card } = useConfirm();

  const face = hero.faces.find((f) => f.id === picked) ?? hero.faces[0];
  const art = usePicture(face?.src);
  const thumbLook: FaceLook = {
    shape: "circle",
    size: 40,
    line: true,
    backdrop: hero.backdrop,
    effect: "none",
    amount: 0,
    speed: 180,
  };

  // scrolling over the face zooms it, not the page
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const onWheel = (e: WheelEvent) => {
      const id = (e.target as Element).closest<HTMLElement>(".hero-host[data-id]")?.dataset["id"];
      const now = id ? getHero().faces.find((f) => f.id === id) : undefined;
      if (!now) return;
      e.preventDefault();
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, now.zoom * Math.exp(-e.deltaY * 0.002)));
      updateFace(now.id, { zoom: Math.round(zoom * 100) / 100 });
    };
    preview.addEventListener("wheel", onWheel, { passive: false });
    return () => preview.removeEventListener("wheel", onWheel);
  }, []);

  const startFraming = (e: React.PointerEvent) => {
    if (e.button !== 0 || !face) return;
    e.preventDefault();
    const size = getHero().size;
    const from = { x: e.clientX, y: e.clientY, fx: face.x, fy: face.y };
    const id = face.id;
    setFraming(true);
    const clamp = (v: number) => Math.round(Math.min(SHIFT_MAX, Math.max(-SHIFT_MAX, v)) * 10) / 10;
    const move = (ev: PointerEvent) =>
      updateFace(id, {
        x: clamp(from.fx + ((ev.clientX - from.x) / size) * 100),
        y: clamp(from.fy + ((ev.clientY - from.y) / size) * 100),
      });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setFraming(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The zoom at which the face stops fitting and fills the frame. */
  const fill = async () => {
    if (!face) return;
    const loaded = await loadPicture(face.src);
    if (!loaded) return;
    const img = new Image();
    img.src = loaded.url;
    await img.decode().catch(() => {});
    if (!img.naturalWidth || !img.naturalHeight) return;
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    const short = Math.min(img.naturalWidth, img.naturalHeight);
    updateFace(face.id, { x: 0, y: 0, zoom: Math.round((long / short) * 100) / 100 });
  };

  const add = async (files: File[]) => {
    setProblem(undefined);
    const room = MAX_FACES - getHero().faces.length;
    if (room <= 0) {
      setProblem(`There is room for ${MAX_FACES} faces at most.`);
      return;
    }
    if (files.length > room) setProblem(`Only ${room} more fit — ${MAX_FACES} faces at most.`);
    for (const file of files.slice(0, room)) {
      setAdding((n) => n + 1);
      try {
        const src = await storePicture(file, "face");
        const added: HeroFace = {
          id: newId(),
          src,
          x: 0,
          y: 0,
          zoom: 1,
          on: true,
          invert: false,
          animate: "always",
        };
        patchHero({ faces: [...getHero().faces, added] });
        setPicked(added.id);
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setAdding((n) => n - 1);
      }
    }
  };

  const swap = async (file: File, field: "src" | "hoverSrc") => {
    if (!face) return;
    setProblem(undefined);
    setAdding((n) => n + 1);
    try {
      updateFace(face.id, { [field]: await storePicture(file, "face") });
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
    const faces = getHero().faces;
    const at = faces.findIndex((f) => f.id === id);
    const rest = faces.filter((f) => f.id !== id);
    patchHero({ faces: rest });
    setPicked(rest[Math.min(at, rest.length - 1)]?.id);
  };

  const dropHover = (id: string) =>
    patchHero({
      faces: getHero().faces.map((f) => {
        if (f.id !== id) return f;
        const { hoverSrc: _gone, ...kept } = f;
        return kept;
      }),
    });

  const reframe = (f: HeroFace) => {
    const n = BUILTIN.exec(f.id)?.[1];
    const back = n && f.src === builtinFace(Number(n)).src ? builtinFace(Number(n)) : { x: 0, y: 0, zoom: 1 };
    updateFace(f.id, { x: back.x, y: back.y, zoom: back.zoom });
  };

  const restore = async () => {
    const yes = await confirm({
      title: "Put the hero back as it came?",
      body: "The twelve faces, drawn at random with each project keeping its own, in a white circle — and Home says “sup.” again. Your own faces leave the mix.",
      ok: "Restore",
    });
    if (!yes) return;
    resetHero();
    setGreetings(getHero().greetings.join("\n"));
    setPicked(getHero().faces[0]?.id);
  };

  const spec = EFFECTS[hero.effect];
  const inMix = hero.faces.filter((f) => f.on).length;
  const shuffle = SHUFFLE.find((s) => s.value === hero.shuffle) ?? SHUFFLE[0]!;

  return (
    <div className="heroedit">
      {card}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/apng,image/svg+xml"
        hidden
        onChange={(e) => onPicked([...(e.target.files ?? [])])}
      />

      <Row label="Face">
        <Toggle on={hero.show} onFlip={() => patchHero({ show: !hero.show })} labels={["Shown", "Hidden"]} />
        <span className="settings-note">
          {hero.show ? "a face over every empty chat" : "just the title and the box"}
        </span>
      </Row>

      {hero.show && (
        <>
          <Row label="Which one">
            <Seg
              options={[
                { value: "random", label: "Random" },
                { value: "one", label: "Always one" },
              ]}
              value={hero.mode}
              onPick={(mode) => patchHero(mode === "one" && face ? { mode, one: face.id } : { mode })}
            />
            <span className="settings-note">
              {hero.mode === "random"
                ? `drawn from the ${inMix} face${inMix === 1 ? "" : "s"} in the mix`
                : "the face marked ★ below, everywhere"}
            </span>
          </Row>

          {hero.mode === "random" && (
            <>
              <Row label="New face">
                <Seg
                  options={SHUFFLE}
                  value={hero.shuffle}
                  onPick={(value) => patchHero({ shuffle: value })}
                />
                <span className="settings-note">{shuffle.note}</span>
              </Row>
              <Row label="On click">
                <Toggle
                  on={hero.reroll}
                  onFlip={() => patchHero({ reroll: !hero.reroll })}
                  labels={["New face", "Nothing"]}
                />
                <span className="settings-note">
                  {hero.reroll
                    ? "clicking the face draws a different one"
                    : "the face stays put when clicked"}
                </span>
              </Row>
            </>
          )}

          <div
            className="heroedit-stage"
            onDragOver={(e) => {
              if ([...e.dataTransfer.items].some((item) => item.kind === "file")) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              void add([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/")));
            }}
          >
            <div className="heroedit-preview" ref={previewRef}>
              {face ? (
                <FacePortrait
                  face={face}
                  look={hero}
                  quiet={framing}
                  data-id={face.id}
                  className={framing ? "framing" : ""}
                  onPointerDown={startFraming}
                />
              ) : (
                <span className="settings-note">no faces — add one with +</span>
              )}
            </div>
            <div className="heroedit-grid">
              {hero.faces.map((f) => (
                <button
                  key={f.id}
                  className={`heroedit-chip${f.id === face?.id ? " active" : ""}${
                    hero.mode === "random" && !f.on ? " off" : ""
                  }`}
                  title={hero.mode === "random" && !f.on ? "Left out of the mix" : "Pick this face"}
                  onClick={() => setPicked(f.id)}
                >
                  <FacePortrait face={f} look={thumbLook} still />
                  {hero.mode === "one" && hero.one === f.id && <span className="heroedit-star">★</span>}
                </button>
              ))}
              <button
                className="heroedit-chip add"
                disabled={hero.faces.length >= MAX_FACES}
                title={hero.faces.length >= MAX_FACES ? `${MAX_FACES} faces at most` : "Add faces"}
                onClick={() => openPicker("add")}
              >
                +
              </button>
            </div>
          </div>
          <p className="settings-note bandedit-hint">
            Drag the face to slide it in its frame, scroll over it to zoom, hover it to see its hover. Drop
            pictures here to add them.{adding > 0 ? " Adding…" : ""}
          </p>
          {problem && <p className="settings-note bandedit-problem">{problem}</p>}

          {face && (
            <div className="bandedit-panel">
              <Row label="This face">
                {hero.mode === "one" ? (
                  hero.one === face.id ? (
                    <span className="settings-note">★ the face every chat shows</span>
                  ) : (
                    <button className="ghost" onClick={() => patchHero({ one: face.id })}>
                      Use this one
                    </button>
                  )
                ) : (
                  <Toggle
                    on={face.on}
                    onFlip={() => updateFace(face.id, { on: !face.on })}
                    labels={["In the mix", "Left out"]}
                  />
                )}
                <button className="ghost" onClick={() => openPicker("replace")}>
                  Replace…
                </button>
                {!BUILTIN.test(face.id) && (
                  <button className="ghost" onClick={() => remove(face.id)}>
                    Remove
                  </button>
                )}
              </Row>

              <Row label="Framing">
                <NumField
                  key={`${face.id}-x`}
                  label="across"
                  places={1}
                  value={face.x}
                  onChange={(x) => updateFace(face.id, { x: Math.min(SHIFT_MAX, Math.max(-SHIFT_MAX, x)) })}
                />
                <NumField
                  key={`${face.id}-y`}
                  label="down"
                  places={1}
                  value={face.y}
                  onChange={(y) => updateFace(face.id, { y: Math.min(SHIFT_MAX, Math.max(-SHIFT_MAX, y)) })}
                />
                <NumField
                  key={`${face.id}-zoom`}
                  label="zoom"
                  places={2}
                  value={face.zoom}
                  onChange={(zoom) =>
                    updateFace(face.id, { zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) })
                  }
                />
                <button
                  className="ghost"
                  title="The whole picture in the frame"
                  onClick={() => updateFace(face.id, { x: 0, y: 0, zoom: 1 })}
                >
                  Fit
                </button>
                <button
                  className="ghost"
                  title="The frame filled, cropping the rest"
                  onClick={() => void fill()}
                >
                  Fill
                </button>
                <button
                  className="ghost"
                  title="How it was framed to start with"
                  onClick={() => reframe(face)}
                >
                  Reset
                </button>
              </Row>

              <Row label="Hover picture">
                {face.hoverSrc ? (
                  <>
                    <span className="heroedit-chip still">
                      <FacePortrait face={{ ...face, src: face.hoverSrc }} look={thumbLook} still />
                    </span>
                    <button className="ghost" onClick={() => openPicker("hover")}>
                      Change…
                    </button>
                    <button className="ghost" onClick={() => dropHover(face.id)}>
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
                  <Seg
                    options={ANIMATE}
                    value={face.animate}
                    onPick={(animate) => updateFace(face.id, { animate })}
                  />
                </Row>
              )}

              <Row label="Dark themes">
                <Toggle on={face.invert} onFlip={() => updateFace(face.id, { invert: !face.invert })} />
                <span className="settings-note">
                  {face.invert ? "ink and paper swap, for line art" : "keeps its own colours"}
                </span>
              </Row>
            </div>
          )}

          <div className="bandedit-panel heroedit-look">
            <Row label="Frame">
              <Seg options={SHAPES} value={hero.shape} onPick={(shape) => patchHero({ shape })} />
            </Row>
            <Row label="Size">
              <input
                type="range"
                className="bandedit-range"
                min={SIZE_MIN}
                max={SIZE_MAX}
                value={hero.size}
                onChange={(e) => patchHero({ size: Number(e.target.value) })}
              />
              <span className="bandedit-readout">{hero.size}px</span>
            </Row>
            {hero.shape !== "none" && (
              <>
                <Row label="Rim">
                  <Toggle on={hero.line} onFlip={() => patchHero({ line: !hero.line })} />
                </Row>
                <Row label="Backdrop">
                  <Seg
                    options={BACKDROPS}
                    value={hero.backdrop}
                    onPick={(backdrop) => patchHero({ backdrop })}
                  />
                  <span className="settings-note">behind a face that doesn't fill its frame</span>
                </Row>
              </>
            )}
            <Row label="On hover">
              <Dropdown
                value={hero.effect}
                options={EFFECT_OPTIONS}
                onSelect={(value) => {
                  const effect = value as HoverEffect;
                  patchHero({ effect, amount: EFFECTS[effect].amount, speed: EFFECTS[effect].speed });
                }}
              />
            </Row>
            {hero.effect !== "none" && (
              <>
                <Row label="Strength">
                  <input
                    type="range"
                    className="bandedit-range"
                    min={spec.min}
                    max={spec.max}
                    value={hero.amount}
                    onChange={(e) => patchHero({ amount: Number(e.target.value) })}
                  />
                  <span className="bandedit-readout">
                    {hero.amount}
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
                    value={hero.speed}
                    onChange={(e) => patchHero({ speed: Number(e.target.value) })}
                  />
                  <span className="bandedit-readout">
                    {hero.speed} ms{spec.loops ? " a round" : ""}
                  </span>
                </Row>
              </>
            )}
          </div>
        </>
      )}

      <div className="bandedit-panel">
        <Row label="Home says">
          <div className="heroedit-greetings">
            <textarea
              rows={Math.min(6, Math.max(2, greetings.split("\n").length))}
              value={greetings}
              placeholder="nothing — no title on Home"
              onChange={(e) => {
                setGreetings(e.target.value);
                patchHero({
                  greetings: e.target.value
                    .split("\n")
                    .map((line) => line.trim().slice(0, GREETING_CHARS))
                    .filter(Boolean)
                    .slice(0, MAX_GREETINGS),
                });
              }}
            />
            <span className="settings-note">
              One line is always said; put several, one to a line, and they take turns —{" "}
              {hero.shuffle === "visit" && hero.mode === "random"
                ? "a new one every visit"
                : "a new one each launch"}
              .
            </span>
          </div>
        </Row>
      </div>

      <div className="heroedit-foot">
        <button className="ghost" onClick={() => void restore()}>
          Restore the originals
        </button>
      </div>
    </div>
  );
}
