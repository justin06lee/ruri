import { useEffect, useRef, useState } from "react";
import type { Playlist, Track } from "../../../shared/protocol";
import { AudioEngine, type PlayerState, type RepeatMode } from "../lib/audio";
import { getPref as ls, setPref as lsSet } from "../prefs";
import { HTTP_BASE, useRuri } from "../store";
import { isAwake, subscribeAwake, whileAwake } from "../lib/beat";
import { Dropdown } from "./Dropdown";

/** How often the waveform and the notes move: enough to read as live,
 *  an eighth of the display's rate. */
const MOTION_MS = 66;

const EMPTY: PlayerState = {
  playing: false,
  track: null,
  position: 0,
  duration: 0,
  index: -1,
  queueLength: 0,
};


function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Five tiny bars fed by the engine's analyser, riding the gap between
 *  the track title and the chevron while music plays — read fifteen times
 *  a second while ruri is in front, laid flat while it is not. */
function Waveform({ engineRef }: { engineRef: React.RefObject<AudioEngine | null> }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(
    () =>
      whileAwake(
        () => {
          const levels = engineRef.current?.levels(5);
          levels?.forEach((v, i) => {
            const bar = barsRef.current[i];
            if (bar) bar.style.transform = `scaleY(${Math.max(0.15, Math.min(1, v * 1.6)).toFixed(3)})`;
          });
        },
        MOTION_MS,
        () => {
          for (const bar of barsRef.current) if (bar) bar.style.transform = "scaleY(0.15)";
        },
      ),
    [engineRef],
  );
  return (
    <span className="wave" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
        />
      ))}
    </span>
  );
}

/** Each note's rise: seconds before its first, and seconds per rise. */
const NOTES: Array<{ delay: number; period: number }> = [
  { delay: 0, period: 5.2 },
  { delay: 1.8, period: 5.8 },
  { delay: 3.2, period: 4.7 },
];

/** A slow rise with a side-to-side wobble, fading in and out — the path
 *  (at, x, y) and the fade (at, opacity), each point to point. */
const RISE_PATH: Array<[number, number, number]> = [
  [0, 0, 0],
  [0.3, 4, -15],
  [0.5, -3, -27],
  [0.7, 3, -39],
  [1, -2, -52],
];
const RISE_FADE: Array<[number, number]> = [
  [0, 0],
  [0.12, 0.55],
  [0.5, 0.45],
  [1, 0],
];

function along<T extends number[]>(points: T[], at: number): number[] {
  let i = 1;
  while (i < points.length - 1 && points[i]![0]! < at) i++;
  const a = points[i - 1]!;
  const b = points[i]!;
  const f = (at - a[0]!) / (b[0]! - a[0]! || 1);
  return a.slice(1).map((v, k) => v + (b[k + 1]! - v) * f);
}

/**
 * Faint little notes wobbling upward while music plays. Moved from here,
 * fifteen times a second while ruri is in front, rather than by an endless
 * CSS animation that redrew the window at the display's rate for as long
 * as the music lasted; behind another app they are simply gone.
 */
function FloatingNotes() {
  const notesRef = useRef<Array<SVGSVGElement | null>>([]);
  useEffect(() => {
    const started = performance.now();
    return whileAwake(
      () => {
        const seconds = (performance.now() - started) / 1000;
        NOTES.forEach(({ delay, period }, i) => {
          const note = notesRef.current[i];
          if (!note) return;
          if (seconds < delay) return;
          const at = ((seconds - delay) % period) / period;
          const [x, y] = along(RISE_PATH, at);
          const [opacity] = along(RISE_FADE, at);
          note.style.transform = `translate(${x!.toFixed(1)}px, ${y!.toFixed(1)}px)`;
          note.style.opacity = opacity!.toFixed(2);
        });
      },
      MOTION_MS,
      () => {
        for (const note of notesRef.current) if (note) note.style.opacity = "0";
      },
    );
  }, []);
  return (
    <span className="note-float" aria-hidden>
      {[0, 1, 2].map((i) => (
        <svg
          key={i}
          ref={(el) => {
            notesRef.current[i] = el;
          }}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      ))}
    </span>
  );
}

function CtlIcon({ d, filled = false }: { d: string; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
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

export function Player() {
  const [open, setOpen] = useState(ls("ruri-music-open") === "1");
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistId, setPlaylistId] = useState<string>(ls("ruri-music-playlist") ?? "");
  const [state, setState] = useState<PlayerState>(EMPTY);
  const [shuffle, setShuffleState] = useState(ls("ruri-music-shuffle") === "1");
  // deliberately not persisted — every launch starts with repeat off
  const [repeat, setRepeatState] = useState<RepeatMode>("off");
  const [volume, setVolumeState] = useState(() => {
    const v = Number(ls("ruri-music-volume"));
    return Number.isFinite(v) && v > 0 ? v : 0.6;
  });
  const engineRef = useRef<AudioEngine | null>(null);
  /** The engine's latest state while ruri was asleep, not yet shown. */
  const unseen = useRef<PlayerState | null>(null);
  useEffect(
    () =>
      subscribeAwake(() => {
        if (!isAwake() || !unseen.current) return;
        setState(unseen.current);
        unseen.current = null;
      }),
    [],
  );

  const engine = (): AudioEngine => {
    if (!engineRef.current) {
      const e = new AudioEngine((t: Track) => HTTP_BASE + t.url);
      // the position moves four times a second while music plays: asleep
      // (lib/awake.ts) only the latest is kept, and shown on waking
      e.onState = (next) => {
        if (isAwake()) setState(next);
        else unseen.current = next;
      };
      e.setVolume(volume);
      e.setShuffle(shuffle);
      e.setRepeat(repeat);
      engineRef.current = e;
    }
    return engineRef.current;
  };

  useEffect(() => {
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Rescan when opened, and again whenever the music dir changes in Settings.
  const musicEpoch = useRuri((s) => s.musicEpoch);
  useEffect(() => {
    if (!open) return;
    void fetch(`${HTTP_BASE}/music/playlists`)
      .then((r) => r.json())
      .then((data: { playlists: Playlist[] }) => setPlaylists(data.playlists))
      .catch(() => setPlaylists([]));
  }, [open, musicEpoch]);

  const playlist = playlists.find((p) => p.id === playlistId) ?? playlists[0] ?? null;

  // Opening the panel lands on the track that is playing: the list is a
  // short window over a long playlist, and the one you came to see is the
  // one that's on. Its own scroller moves, never the sidebar around it.
  const tracksRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const list = tracksRef.current;
    const current = list?.querySelector<HTMLElement>(".player-track.current");
    if (!list || !current) return;
    const top = current.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTop = Math.max(0, top - list.clientHeight / 2 + current.offsetHeight / 2);
  }, [open, playlist]);

  const toggleOpen = () => {
    setOpen(!open);
    lsSet("ruri-music-open", open ? "0" : "1");
  };

  const playTrack = (index: number) => {
    if (playlist) engine().setQueue(playlist.tracks, index);
  };

  const togglePlay = () => {
    if (state.track) engine().toggle();
    else if (playlist?.tracks.length) engine().setQueue(playlist.tracks, 0);
  };

  const setShuffle = (on: boolean) => {
    setShuffleState(on);
    lsSet("ruri-music-shuffle", on ? "1" : "0");
    engine().setShuffle(on);
  };

  const setVolume = (v: number) => {
    setVolumeState(v);
    lsSet("ruri-music-volume", String(v));
    engine().setVolume(v);
  };

  // off → loop the playlist → loop the current track → off
  const cycleRepeat = () => {
    const next: RepeatMode = repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
    setRepeatState(next);
    engine().setRepeat(next);
  };

  return (
    <div className="player">
      {state.playing && <FloatingNotes />}
      <button className="player-toggle" onClick={toggleOpen}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
        <span className="player-toggle-label">
          {state.track ? state.track.title : "Music"}
        </span>
        {state.playing && <Waveform engineRef={engineRef} />}
        <svg
          className={`dropdown-chevron ${open ? "" : "up"}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d={open ? "M6 9l6 6 6-6" : "M6 15l6-6 6 6"} />
        </svg>
      </button>

      {open && (
        <div className="player-panel">
          {playlists.length === 0 ? (
            <div className="player-hint">
              No music yet — drop folders of tracks into <code>~/Music/ruri</code>.
            </div>
          ) : (
            <>
              <Dropdown
                title="Playlist"
                value={playlist?.id ?? ""}
                options={playlists.map((p) => ({
                  value: p.id,
                  label: `${p.name} (${p.tracks.length})`,
                }))}
                onSelect={(id) => {
                  setPlaylistId(id);
                  lsSet("ruri-music-playlist", id);
                }}
              />

              <div className="player-tracks" ref={tracksRef}>
                {playlist?.tracks.map((track, i) => (
                  <button
                    key={track.id}
                    className={`player-track ${state.track?.id === track.id ? "current" : ""}`}
                    title={track.filename}
                    onClick={() => playTrack(i)}
                  >
                    {track.title}
                  </button>
                ))}
              </div>

              <div className="player-seek">
                <span className="player-time">{mmss(state.position)}</span>
                <input
                  type="range"
                  min={0}
                  max={state.duration || 1}
                  step={0.5}
                  value={Math.min(state.position, state.duration || 1)}
                  onChange={(e) => engine().seek(Number(e.target.value))}
                />
                <span className="player-time">{mmss(state.duration)}</span>
              </div>

              <div className="player-controls">
                <button className="icon-button" title="Previous" onClick={() => engine().prev()}>
                  <CtlIcon d="M19 20L9 12l10-8v16zM5 19V5" />
                </button>
                <button className="icon-button" title={state.playing ? "Pause" : "Play"} onClick={togglePlay}>
                  {state.playing ? (
                    <CtlIcon d="M10 4H6v16h4V4zM18 4h-4v16h4V4z" filled />
                  ) : (
                    <CtlIcon d="M6 4l14 8-14 8V4z" filled />
                  )}
                </button>
                <button className="icon-button" title="Next" onClick={() => engine().next()}>
                  <CtlIcon d="M5 4l10 8-10 8V4zM19 5v14" />
                </button>
                <button
                  className={`icon-button ${shuffle ? "active" : ""}`}
                  title="Shuffle"
                  onClick={() => setShuffle(!shuffle)}
                >
                  <CtlIcon d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                </button>
                <button
                  className={`icon-button ${repeat !== "off" ? "active" : ""}`}
                  title={
                    repeat === "off"
                      ? "Repeat off — click to loop the playlist"
                      : repeat === "all"
                        ? "Looping the playlist — click to loop this track"
                        : "Looping this track — click to turn repeat off"
                  }
                  onClick={cycleRepeat}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M17 2l4 4-4 4M3 12v-2a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 12v2a4 4 0 0 1-4 4H3" />
                    {repeat === "one" && (
                      <text
                        x="12"
                        y="15"
                        textAnchor="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill="currentColor"
                        stroke="none"
                      >
                        1
                      </text>
                    )}
                  </svg>
                </button>
                <input
                  className="player-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  title="Volume"
                  onChange={(e) => setVolume(Number(e.target.value))}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
