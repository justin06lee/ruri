import { useEffect, useRef, useState } from "react";
import type { Playlist, Track } from "../../../shared/protocol";
import { AudioEngine, type PlayerState } from "../lib/audio";
import { HTTP_BASE, useRuri } from "../store";
import { Dropdown } from "./Dropdown";

const EMPTY: PlayerState = {
  playing: false,
  track: null,
  position: 0,
  duration: 0,
  index: -1,
  queueLength: 0,
};

function ls(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // fine — preference just won't persist
  }
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Five tiny bars fed by the engine's analyser, riding the gap between
 *  the track title and the chevron while music plays. */
function Waveform({ engineRef }: { engineRef: React.RefObject<AudioEngine | null> }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const levels = engineRef.current?.levels(5);
      levels?.forEach((v, i) => {
        const bar = barsRef.current[i];
        if (bar) bar.style.transform = `scaleY(${Math.max(0.15, Math.min(1, v * 1.6)).toFixed(3)})`;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [engineRef]);
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

/** Faint little notes wobbling upward while music plays. */
function FloatingNotes() {
  return (
    <span className="note-float" aria-hidden>
      {[0, 1, 2].map((i) => (
        <svg key={i} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
  const [volume, setVolumeState] = useState(() => {
    const v = Number(ls("ruri-music-volume"));
    return Number.isFinite(v) && v > 0 ? v : 0.6;
  });
  const engineRef = useRef<AudioEngine | null>(null);

  const engine = (): AudioEngine => {
    if (!engineRef.current) {
      const e = new AudioEngine((t: Track) => HTTP_BASE + t.url);
      e.onState = setState;
      e.setVolume(volume);
      e.setShuffle(shuffle);
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

              <div className="player-tracks">
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
