// Audio engine (T3.7) over the Web Audio API: one gain per channel (sfx, ui, music,
// ambient) under a master gain, lazily loaded and cached buffers, a cap on simultaneous
// voices, simple positional sound (distance attenuation and stereo pan around the player)
// and two crossfading loop slots (music and ambient bed).
//
// The AudioContext is only created on unlock(), after the first user gesture, because
// browsers (and the desktop webviews) refuse to start audio before one. Until then play()
// is silent and the wanted loops are only remembered.
//
// Everything the browser provides comes through AudioPorts, so tests run on a fake context.
import type { SoundChannel, SoundManifest } from "../content-types.ts";
import type { Pos } from "../state/geometry.ts";
import { ALL_CHANNELS } from "./prefs.ts";
import type { AudioPrefs, VolumeChannel } from "./prefs.ts";

// ---- the slice of Web Audio the engine uses --------------------------------------------

export interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface NodeLike {
  connect(node: NodeLike): unknown;
  disconnect(): void;
}

export interface GainLike extends NodeLike {
  readonly gain: ParamLike;
}

export interface PannerLike extends NodeLike {
  readonly pan: ParamLike;
}

export interface BufferLike {
  readonly duration: number;
}

export interface SourceLike extends NodeLike {
  buffer: BufferLike | null;
  loop: boolean;
  start(when?: number): void;
  stop(when?: number): void;
  addEventListener(type: "ended", listener: () => void): void;
}

export interface ContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: NodeLike;
  resume(): Promise<void>;
  createGain(): GainLike;
  createStereoPanner(): PannerLike;
  createBufferSource(): SourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<BufferLike>;
}

export interface AudioPorts {
  /** A new AudioContext, or undefined where there is no Web Audio. */
  createContext(): ContextLike | undefined;
  /** Bytes of a sound file. */
  fetch(url: string): Promise<ArrayBuffer>;
  /** Milliseconds, monotonic (performance.now). */
  now(): number;
  /** Uniform in [0, 1): picks among a sound's variants. */
  random(): number;
}

/** The browser's implementation of the ports. */
export function browserPorts(): AudioPorts {
  return {
    createContext() {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      return Ctor ? (new Ctor() as unknown as ContextLike) : undefined;
    },
    async fetch(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.arrayBuffer();
    },
    now: () => performance.now(),
    random: Math.random,
  };
}

// ---- tuning ------------------------------------------------------------------------------

/** One-shot voices playing at once, all channels together. */
export const MAX_VOICES = 16;
/** Farthest tile (Chebyshev distance) a positional sound is heard from. */
export const HEAR_RANGE = 8;
/** Distance at which the pan reaches its maximum (half the 15-tile view). */
export const PAN_RANGE = 7;
export const MAX_PAN = 0.8;
/** A sound whose file arrives later than this after it was asked for is dropped. */
export const LATE_MS = 300;

/** Gain and pan of a sound at `at` heard from `listener`; undefined = out of earshot. */
export function spatial(at: Pos, listener: Pos): { gain: number; pan: number } | undefined {
  if (at.z !== listener.z) return undefined;
  const dx = at.x - listener.x;
  const d = Math.max(Math.abs(dx), Math.abs(at.y - listener.y));
  if (d > HEAR_RANGE) return undefined;
  const gain = 1 - d / (HEAR_RANGE + 1);
  const pan = Math.max(-1, Math.min(1, dx / PAN_RANGE)) * MAX_PAN;
  return { gain, pan };
}

interface Voice {
  sound: string;
  source: SourceLike;
  /** Context time when it ends by itself. */
  endsAt: number;
}

interface LoopSlot {
  /** The sound that should play here (undefined = silence). */
  want: string | undefined;
  /** What actually plays, with its own fade gain. */
  playing: { sound: string; source: SourceLike; gain: GainLike } | undefined;
}

type LoopKind = "music" | "ambient";

export class AudioEngine {
  private readonly manifest: SoundManifest;
  private readonly ports: AudioPorts;
  private prefs: AudioPrefs;
  private ctx: ContextLike | undefined;
  private master: GainLike | undefined;
  private readonly channels = new Map<SoundChannel, GainLike>();
  private readonly buffers = new Map<string, Promise<BufferLike | undefined>>();
  private readonly decoded = new Map<string, BufferLike>();
  private voices: Voice[] = [];
  private readonly loops: Record<LoopKind, LoopSlot> = {
    music: { want: undefined, playing: undefined },
    ambient: { want: undefined, playing: undefined },
  };
  /** Sound ids started, newest last (E2E hook and tests). */
  readonly history: string[] = [];

  constructor(manifest: SoundManifest, prefs: AudioPrefs, ports: AudioPorts) {
    this.manifest = manifest;
    this.prefs = prefs;
    this.ports = ports;
  }

  get unlocked(): boolean {
    return this.ctx !== undefined;
  }

  /** Call on a user gesture: creates (or resumes) the context and starts the wanted loops. */
  unlock(): void {
    if (!this.ctx) {
      const ctx = this.ports.createContext();
      if (!ctx) return;
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      for (const ch of ["sfx", "ui", "music", "ambient"] as const) {
        const g = ctx.createGain();
        g.connect(this.master);
        this.channels.set(ch, g);
      }
      this.applyVolumes();
      for (const kind of ["music", "ambient"] as const) this.startLoop(kind);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
  }

  setPrefs(prefs: AudioPrefs): void {
    this.prefs = prefs;
    this.applyVolumes();
  }

  /** Effective volume of a channel (0 when it or master is muted). */
  level(ch: VolumeChannel): number {
    const own = this.prefs.muted[ch] ? 0 : this.prefs.volume[ch];
    if (ch === "master") return own;
    return this.prefs.muted.master ? 0 : own * this.prefs.volume.master;
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    for (const ch of ALL_CHANNELS) {
      const node = ch === "master" ? this.master : this.channels.get(ch);
      const v = this.prefs.muted[ch] ? 0 : this.prefs.volume[ch];
      node?.gain.setValueAtTime(v, t);
    }
  }

  /**
   * Plays the first of `events` that sounds.yaml maps (more specific names first). With
   * `at` and `listener` it is positional. Returns the sound id it starts, or undefined.
   */
  play(events: readonly string[], at?: Pos, listener?: Pos): string | undefined {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    let ids: string[] | undefined;
    for (const e of events) {
      ids = this.manifest.events[e];
      if (ids) break;
    }
    if (!ids || ids.length === 0) return undefined;
    const id = ids[Math.min(ids.length - 1, Math.floor(this.ports.random() * ids.length))] ?? "";
    const def = this.manifest.sounds[id];
    if (!def || def.channel === "music" || def.channel === "ambient") return undefined;
    if (this.level(def.channel) <= 0) return undefined; // muted: do not spend a voice
    const where = at && listener ? spatial(at, listener) : { gain: 1, pan: 0 };
    if (!where) return undefined;
    this.pruneVoices();
    if (this.voices.length >= MAX_VOICES) return undefined;
    if (this.voices.filter((v) => v.sound === id).length >= def.maxVoices) return undefined;
    const buffer = this.decoded.get(id);
    if (buffer) {
      this.startVoice(id, buffer, def.volume * where.gain, where.pan);
      return id;
    }
    const asked = this.ports.now();
    void this.load(id).then((b) => {
      if (!b || this.ports.now() - asked > LATE_MS) return;
      this.pruneVoices();
      if (this.voices.length >= MAX_VOICES) return;
      this.startVoice(id, b, def.volume * where.gain, where.pan);
    });
    return id;
  }

  private startVoice(id: string, buffer: BufferLike, gain: number, pan: number): void {
    const ctx = this.ctx;
    const def = this.manifest.sounds[id];
    const out = def && this.channels.get(def.channel);
    if (!ctx || !out) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    let tail: NodeLike = g;
    if (pan !== 0) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    tail.connect(out);
    const voice: Voice = { sound: id, source: src, endsAt: ctx.currentTime + buffer.duration };
    this.voices.push(voice);
    src.addEventListener("ended", () => {
      this.voices = this.voices.filter((v) => v !== voice);
      tail.disconnect();
    });
    src.start();
    this.history.push(id);
    if (this.history.length > 50) this.history.shift();
  }

  private pruneVoices(): void {
    const t = this.ctx?.currentTime ?? 0;
    this.voices = this.voices.filter((v) => v.endsAt > t);
  }

  /** Voices playing now (tests). */
  get activeVoices(): number {
    this.pruneVoices();
    return this.voices.length;
  }

  /** Loads and decodes a sound once; failures are cached as undefined (and logged once). */
  private load(id: string): Promise<BufferLike | undefined> {
    let p = this.buffers.get(id);
    if (!p) {
      const def = this.manifest.sounds[id];
      const ctx = this.ctx;
      p =
        def && ctx
          ? this.ports
              .fetch(def.url)
              .then((data) => ctx.decodeAudioData(data))
              .then((b) => {
                this.decoded.set(id, b);
                return b;
              })
              .catch((err: unknown) => {
                console.warn(`audio: cannot load ${id}`, err);
                return undefined;
              })
          : Promise.resolve(undefined);
      this.buffers.set(id, p);
    }
    return p;
  }

  // ---- loops ---------------------------------------------------------------------------

  /** The music and ambient loops that should play (undefined = none); changes crossfade. */
  setLoops(music: string | undefined, ambient: string | undefined): void {
    for (const [kind, id] of [
      ["music", music],
      ["ambient", ambient],
    ] as const) {
      const slot = this.loops[kind];
      if (slot.want === id) continue;
      slot.want = id;
      this.startLoop(kind);
    }
  }

  /** What each loop slot plays now (tests, E2E). */
  playingLoops(): { music: string | undefined; ambient: string | undefined } {
    return { music: this.loops.music.playing?.sound, ambient: this.loops.ambient.playing?.sound };
  }

  private startLoop(kind: LoopKind): void {
    const ctx = this.ctx;
    const slot = this.loops[kind];
    if (!ctx) return;
    const fade = this.manifest[kind].fadeMs / 1000;
    const old = slot.playing;
    if (old?.sound === slot.want) return;
    if (old) {
      const t = ctx.currentTime;
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + fade);
      old.source.stop(t + fade);
      slot.playing = undefined;
    }
    const id = slot.want;
    const def = id === undefined ? undefined : this.manifest.sounds[id];
    const out = this.channels.get(kind);
    if (id === undefined || !def || def.channel !== kind || !out) return;
    void this.load(id).then((buffer) => {
      // Still wanted, and nothing else started meanwhile?
      if (!buffer || slot.want !== id || slot.playing) return;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(def.volume, t + fade);
      src.connect(g);
      g.connect(out);
      src.start(t);
      slot.playing = { sound: id, source: src, gain: g };
      this.history.push(id);
    });
  }
}
