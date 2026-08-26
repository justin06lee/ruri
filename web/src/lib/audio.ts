/**
 * Two-deck Web Audio engine with equal-power crossfade, shuffle, and repeat.
 * Ported from justin06lee/home (src/renderer/src/lib/audio.ts); tracks stream
 * from ruri's own server (/music/track) instead of a custom protocol.
 */
import type { Track } from "../../../shared/protocol";

export interface PlayerState {
  playing: boolean;
  track: Track | null;
  position: number;
  duration: number;
  index: number;
  queueLength: number;
}

interface Deck {
  el: HTMLAudioElement;
  gain: GainNode;
}

const CURVE_POINTS = 64;

/** Equal-power fade curves — a linear gain ramp dips in perceived loudness
 *  halfway through a crossfade, which is exactly where you'd notice it. */
function fadeCurves(): { out: Float32Array; in: Float32Array } {
  const out = new Float32Array(CURVE_POINTS);
  const incoming = new Float32Array(CURVE_POINTS);
  for (let i = 0; i < CURVE_POINTS; i++) {
    const t = (i / (CURVE_POINTS - 1)) * (Math.PI / 2);
    out[i] = Math.cos(t);
    incoming[i] = Math.sin(t);
  }
  return { out, in: incoming };
}

export class AudioEngine {
  private ctx: AudioContext;
  private master: GainNode;
  private analyser: AnalyserNode;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private decks: [Deck, Deck];
  private active = 0;

  private queue: Track[] = [];
  /** Indices into `queue`, in play order. Rewritten when shuffle toggles. */
  private order: number[] = [];
  private cursor = -1;

  private crossfadeSeconds = 6;
  private shuffle = false;
  private repeat = true;
  private fading = false;
  private fadeTimer = 0;
  private fadeFrom: Deck | null = null;
  private raf = 0;
  private scheduler = 0;
  private lastEmit: PlayerState | null = null;

  /** Resolves a track's URL to something the audio element can load. */
  private readonly resolveUrl: (track: Track) => string;

  onState: (s: PlayerState) => void = () => {};

  constructor(resolveUrl: (track: Track) => string = (t) => t.url) {
    this.resolveUrl = resolveUrl;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    // master → analyser → speakers, so the mini waveform sees exactly
    // what's audible (post-crossfade, post-volume)
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.decks = [this.makeDeck(), this.makeDeck()];
    this.tick();
    // Deciding *when* to crossfade must not depend on animation frames:
    // Chromium stops firing them once the window is occluded, which is exactly
    // when someone has switched apps and left the music going.
    this.scheduler = window.setInterval(this.schedule, 250);
  }

  private makeDeck(): Deck {
    const el = new Audio();
    el.preload = "auto";
    // Keeps the MediaElementSource CORS-clean in dev mode (vite origin →
    // server origin); a tainted source outputs silence through gain nodes.
    el.crossOrigin = "anonymous";
    const src = this.ctx.createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.master);
    el.addEventListener("ended", () => this.onDeckEnded(el));
    return { el, gain };
  }

  private get current(): Deck {
    return this.decks[this.active]!;
  }

  private get idle(): Deck {
    return this.decks[1 - this.active]!;
  }

  private onDeckEnded(el: HTMLAudioElement): void {
    if (el !== this.current.el) return;
    if (this.fading) return;
    this.advance(1, true);
  }

  /** Publish state only when something a viewer could notice has changed —
   *  emitting a fresh object per animation frame re-renders the whole tree. */
  private emit(): void {
    const track = this.cursor >= 0 ? (this.queue[this.order[this.cursor]!] ?? null) : null;
    const next: PlayerState = {
      playing: !this.current.el.paused,
      track,
      position: this.current.el.currentTime || 0,
      duration: Number.isFinite(this.current.el.duration) ? this.current.el.duration : 0,
      index: this.cursor,
      queueLength: this.order.length,
    };
    const prev = this.lastEmit;
    if (
      prev &&
      prev.playing === next.playing &&
      prev.track?.id === next.track?.id &&
      prev.index === next.index &&
      prev.queueLength === next.queueLength &&
      Math.abs(prev.duration - next.duration) < 0.01 &&
      Math.abs(prev.position - next.position) < 0.1
    ) {
      return;
    }
    this.lastEmit = next;
    this.onState(next);
  }

  /** Starts the next track early enough to overlap by `crossfadeSeconds`. */
  private schedule = (): void => {
    const el = this.current.el;
    if (el.paused || this.crossfadeSeconds <= 0 || this.fading) return;
    const d = el.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    if (d - el.currentTime > this.crossfadeSeconds) return;
    const isLast = this.cursor === this.order.length - 1;
    if (!isLast || this.repeat) this.advance(1, true);
  };

  private tick = (): void => {
    this.emit();
    this.raf = requestAnimationFrame(this.tick);
  };

  private buildOrder(keepCurrent = true): void {
    const currentTrackIdx = this.cursor >= 0 ? this.order[this.cursor]! : -1;
    const indices = this.queue.map((_, i) => i);
    if (this.shuffle) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j]!, indices[i]!];
      }
    }
    this.order = indices;
    if (keepCurrent && currentTrackIdx >= 0) {
      const at = this.order.indexOf(currentTrackIdx);
      if (at > 0) {
        // Move the playing track to the front so it isn't interrupted.
        this.order.splice(at, 1);
        this.order.unshift(currentTrackIdx);
      }
      this.cursor = 0;
    }
  }

  setQueue(tracks: Track[], startIndex = 0): void {
    this.queue = tracks;
    this.cursor = -1;
    this.buildOrder(false);
    if (!tracks.length) {
      this.stop();
      return;
    }
    const target = this.shuffle ? 0 : Math.max(0, Math.min(startIndex, this.order.length - 1));
    this.cursor = target;
    void this.loadInto(this.current, this.queue[this.order[this.cursor]!]!, true);
  }

  private async loadInto(deck: Deck, track: Track, play: boolean): Promise<void> {
    if (!track) return;
    deck.el.src = this.resolveUrl(track);
    deck.el.currentTime = 0;
    deck.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    deck.gain.gain.setValueAtTime(1, this.ctx.currentTime);
    if (play) await this.play();
  }

  /** End an in-flight crossfade right now, silencing the outgoing deck. */
  private finalizeFade(): void {
    if (!this.fading) return;
    window.clearTimeout(this.fadeTimer);
    this.fadeTimer = 0;
    const from = this.fadeFrom;
    const now = this.ctx.currentTime;
    if (from) {
      from.el.pause();
      from.el.removeAttribute("src");
      from.gain.gain.cancelScheduledValues(now);
      from.gain.gain.setValueAtTime(0, now);
    }
    this.current.gain.gain.cancelScheduledValues(now);
    this.current.gain.gain.setValueAtTime(1, now);
    this.fadeFrom = null;
    this.fading = false;
  }

  async play(): Promise<void> {
    if (this.ctx.state === "suspended") await this.ctx.resume();
    try {
      await this.current.el.play();
    } catch {
      // Autoplay refusal before a user gesture; the next explicit play wins.
    }
    this.emit();
  }

  pause(): void {
    this.finalizeFade();
    this.current.el.pause();
    this.emit();
  }

  toggle(): void {
    if (this.current.el.paused) void this.play();
    else this.pause();
  }

  stop(): void {
    this.finalizeFade();
    for (const d of this.decks) {
      d.el.pause();
      d.el.removeAttribute("src");
      d.el.load();
    }
    this.cursor = -1;
    this.emit();
  }

  advance(delta: number, fade = false): void {
    if (!this.order.length) return;
    // A manual skip during a fade collapses the fade first, so the two
    // transitions can't overlap and strand a deck at partial gain.
    if (!fade) this.finalizeFade();

    let next = this.cursor + delta;
    if (next >= this.order.length) {
      if (!this.repeat) {
        this.pause();
        return;
      }
      next = 0;
    }
    if (next < 0) next = this.repeat ? this.order.length - 1 : 0;

    const track = this.queue[this.order[next]!];
    if (!track) return;

    const wasPlaying = !this.current.el.paused;
    this.cursor = next;

    if (!fade || this.crossfadeSeconds <= 0 || !wasPlaying) {
      void this.loadInto(this.current, track, wasPlaying);
      return;
    }
    void this.crossfadeTo(track);
  }

  private async crossfadeTo(track: Track): Promise<void> {
    if (this.fading) return;
    this.fading = true;

    const from = this.current;
    const to = this.idle;
    const dur = this.crossfadeSeconds;
    const now = this.ctx.currentTime;
    const { out, in: incoming } = fadeCurves();

    to.el.src = this.resolveUrl(track);
    to.el.currentTime = 0;
    to.gain.gain.cancelScheduledValues(now);
    to.gain.gain.setValueAtTime(0, now);

    try {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      await to.el.play();
    } catch {
      this.fading = false;
      return;
    }

    const start = this.ctx.currentTime;
    from.gain.gain.cancelScheduledValues(start);
    from.gain.gain.setValueCurveAtTime(out, start, dur);
    to.gain.gain.setValueCurveAtTime(incoming, start, dur);

    this.active = 1 - this.active;
    this.fadeFrom = from;
    this.fadeTimer = window.setTimeout(() => this.finalizeFade(), dur * 1000);
  }

  next(): void {
    this.advance(1, false);
  }

  prev(): void {
    // Standard behaviour: restart the track unless you're near the beginning.
    if (this.current.el.currentTime > 3) {
      this.current.el.currentTime = 0;
      return;
    }
    this.advance(-1, false);
  }

  seek(seconds: number): void {
    const d = this.current.el.duration;
    if (Number.isFinite(d)) this.current.el.currentTime = Math.max(0, Math.min(seconds, d));
    this.emit();
  }

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v));
    this.master.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
  }

  /** Coarse spectrum levels (0..1), low to high, for the mini waveform. */
  levels(bands: number): number[] {
    this.freq ??= new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(this.freq);
    // the top third of the spectrum is usually dead air — skip it
    const usable = Math.floor(this.freq.length * 0.66);
    const out: number[] = [];
    for (let i = 0; i < bands; i++) {
      const a = Math.floor((i / bands) * usable);
      const b = Math.max(a + 1, Math.floor(((i + 1) / bands) * usable));
      let sum = 0;
      for (let j = a; j < b; j++) sum += this.freq[j]!;
      out.push(sum / ((b - a) * 255));
    }
    return out;
  }

  setShuffle(on: boolean): void {
    this.shuffle = on;
    this.buildOrder(true);
    this.emit();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.clearInterval(this.scheduler);
    this.stop();
    void this.ctx.close();
  }
}
