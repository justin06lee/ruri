import { useState, type HTMLAttributes } from "react";
import { type Hero, type HeroFace, launchRoll, pickFace, pickGreeting, pinned, useHero } from "../hero";
import { useShown, useStill } from "../pictures";

/**
 * The hero face: the face over a chat with nothing in it yet, as Settings
 * has it (hero.ts) — and one face in its frame, drawn the same way here,
 * on the Settings page, and in its thumbnails.
 */

/** What a face's frame looks like and does — a hero's, or a thumbnail's. */
export type FaceLook = Pick<Hero, "shape" | "size" | "line" | "backdrop" | "effect" | "amount" | "speed">;

export function FacePortrait({
  face,
  look,
  quiet = false,
  still = false,
  className = "",
  style,
  onPointerEnter,
  onPointerLeave,
  ...rest
}: {
  face: HeroFace;
  look: FaceLook;
  /** Hover does nothing — while the face is being framed by hand. */
  quiet?: boolean;
  /** Its first frame, whatever it is set to do: a thumbnail. */
  still?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  const [over, setOver] = useState(false);
  const hot = over && !quiet && !still;
  const shown = useShown(face, hot);
  const held = useStill(face.src);
  return (
    <div
      {...rest}
      className={`hero-host fx-host fx-${look.effect}${hot ? " hot" : ""} ${className}`}
      style={
        {
          "--hero-size": `${look.size}px`,
          "--amt": look.amount,
          "--speed": `${look.speed}ms`,
          ...style,
        } as React.CSSProperties
      }
      onPointerEnter={(e) => {
        setOver(true);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        setOver(false);
        onPointerLeave?.(e);
      }}
    >
      <div
        className={`hero-frame fx-art shape-${look.shape} backdrop-${look.backdrop}${look.line ? "" : " no-line"}`}
      >
        <img
          className={`hero-face${face.invert ? " invert" : ""}`}
          src={still ? held : shown}
          alt=""
          draggable={false}
          style={{
            left: `calc(50% + ${face.x}%)`,
            top: `calc(50% + ${face.y}%)`,
            transform: `translate(-50%, -50%) scale(${face.zoom})`,
          }}
        />
      </div>
    </div>
  );
}

/**
 * The face and the title over an empty chat. Home's title is its greeting;
 * a project's is its chat's. Mounted afresh for every chat (ChatPane keys
 * it), which is what "a new face every visit" draws on.
 */
export function HeroTop({ channel, home, title }: { channel: string; home: boolean; title?: string }) {
  const hero = useHero();
  const [visit] = useState(Math.random);
  const [bump, setBump] = useState(0);
  const draw = { key: channel, home, launch: launchRoll, visit, bump };
  const drawn = pickFace(hero, draw);
  // fixture and screenshot runs: the same face every time a random one
  // would be drawn (one face always is the same face already) — until it
  // is clicked for another, which is someone asking for a different one
  const face =
    pinned && hero.show && hero.mode === "random" && bump === 0
      ? (hero.faces.find((f) => f.id === "v12") ?? drawn)
      : drawn;
  const words = title ?? pickGreeting(hero, draw);
  const another = hero.reroll && hero.mode === "random" && hero.faces.filter((f) => f.on).length > 1;
  return (
    <>
      {face && (
        <FacePortrait
          face={face}
          look={hero}
          className={another ? "rerolls" : ""}
          {...(another ? { title: "Another face", onClick: () => setBump((n) => n + 1) } : {})}
        />
      )}
      {words && <div className="hero-title">{words}</div>}
    </>
  );
}
