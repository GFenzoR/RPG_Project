// Audio engine (T3.7) over the Web Audio API: one gain per channel (sfx, ui, music,
// ambient) under a master gain, lazily loaded and cached buffers, a cap on simultaneous
// voices, simple positional sound (distance attenuation and stereo pan around the player),
// a crossfading ambient bed, and the music.
//
// The music is the director's (director.ts, the owner's request of 2026-11-18): the engine
// tells it where the player is (setMusic) and pumps it every PUMP_MS on the audio clock;
// each of its voices plays on a media element routed into the music channel through its
// own gain, which follows the voice's equal-power envelope with Web Audio ramps. A track is
// streamed, not decoded whole (docs/07 "Audio": three minutes of stereo decoded are
// ~66 MB): its file is fetched once into an object URL (the compressed bytes, ~1 MB) that
// the element decodes as it plays and can seek in, whatever the server says about byte
// ranges. The last KEEP_STREAMS files stay; nothing is fetched while the music is muted.
// A file that fails (the network, a deploy, a file the element cannot decode) is fetched
// again after STREAM_RETRY_MS, doubling up to STREAM_RETRY_MAX_MS; meanwhile the director
// plays another track of its pool, or keeps the old music. A loop file (soundgen's themes,
// with no `seconds`) is decoded and loops on a buffer source instead: a media element's
// `loop` leaves a gap at every turn.
//
// The AudioContext is only created on unlock(), after the first user gesture, because
// browsers (and the desktop webviews) refuse to start audio before one. Until then play()
// is silent and the wanted ambient loop and music are only remembered. The music's
// elements are made in that gesture too, and each one plays-and-pauses nothing in it
// (StreamLike.bless): WebKit lets an element start later only if play() was called on it
// within a gesture. A play() refused anyway is tried again on the next gesture.
//
// Everything the browser provides comes through AudioPorts, so tests run on a fake context.
import type { SoundChannel, SoundManifest } from "../content-types.ts";
import type { Pos } from "../state/geometry.ts";
import {
  MAX_VOICES as MAX_MUSIC_VOICES,
  MusicDirector,
  envelopePoints,
  gainAt,
  positionAt,
} from "./director.ts";
import type {
  DirectorConfig,
  Envelope,
  MusicTrack,
  Readiness,
  Role,
  Scene,
  Voice,
} from "./director.ts";
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

/** A media element routed into the graph: how the music streams. */
export interface StreamLike {
  /** The element's output (a MediaElementAudioSourceNode). */
  readonly output: NodeLike;
  /** Plays `url` (from loadStream) from `at` seconds; a loop file loops. */
  play(url: string, at: number, loop: boolean): void;
  /** Stops and lets go of the file. */
  stop(): void;
  /** `fn` runs when the file plays to its end (never after stop). */
  onEnded(fn: () => void): void;
  /** `fn` runs when the element cannot play its file: broken, or a codec it lacks. */
  onError(fn: () => void): void;
  /**
   * Called within a user gesture on an element with no file: it plays and pauses nothing,
   * which in WebKit (Safari, iOS, the macOS webview) lets it start playing later.
   */
  bless(): void;
  /** Whether the browser refused the last play() for want of a gesture (it is silent). */
  blocked(): boolean;
  /** Where the element is in its file, s (E2E). */
  time(): number;
}

export interface AudioPorts {
  /** A new AudioContext, or undefined where there is no Web Audio. */
  createContext(): ContextLike | undefined;
  /** Bytes of a sound file. */
  fetch(url: string): Promise<ArrayBuffer>;
  /** Milliseconds, monotonic (performance.now). */
  now(): number;
  /** Uniform in [0, 1): picks among a sound's variants, and the music director's picks. */
  random(): number;
  /** A media element whose output goes into `ctx`; undefined where there is none. */
  createStream(ctx: ContextLike): StreamLike | undefined;
  /** Fetches a whole file and gives an object URL of it (its compressed bytes). */
  loadStream(url: string): Promise<string>;
  /** Lets go of an object URL of loadStream. */
  releaseStream(objectUrl: string): void;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
}

/** The site root ("/"), where atlas/ and audio/ are served, whatever page loaded us. */
export function siteRoot(): string {
  return new URL("/", document.baseURI).href;
}

/** A music stream on an <audio> element (MediaElementAudioSourceNode). */
function browserStream(ctx: ContextLike): StreamLike | undefined {
  if (typeof Audio === "undefined") return undefined;
  const el = new Audio();
  el.preload = "auto";
  let output: NodeLike;
  try {
    output = (ctx as unknown as AudioContext).createMediaElementSource(el);
  } catch {
    return undefined;
  }
  let ended: () => void = () => undefined;
  let failed: () => void = () => undefined;
  // A play() that a later play() or stop() replaced must not seek, start or report anything.
  let turn = 0;
  let refused = false;
  el.addEventListener("ended", () => ended());
  // A file it cannot play: loadedmetadata never comes. stop() leaves no src to fail at.
  el.addEventListener("error", () => {
    if (el.getAttribute("src") !== null) failed();
  });
  return {
    output,
    play(url, at, loop) {
      const mine = ++turn;
      refused = false;
      el.loop = loop;
      const start = (): void => {
        if (mine !== turn) return;
        try {
          el.currentTime = at;
        } catch {
          // not seekable yet: it plays from where the element is
        }
        el.play().catch((err: unknown) => {
          const name = err instanceof DOMException ? err.name : "";
          if (mine !== turn || name === "AbortError") return;
          // No gesture behind it (WebKit): the next one plays it again (AudioEngine.unlock).
          if (name === "NotAllowedError") refused = true;
          else failed();
          console.warn("audio: cannot play the music", err);
        });
      };
      if (el.src === url && el.readyState >= 1) start();
      else {
        el.addEventListener("loadedmetadata", start, { once: true });
        el.src = url;
      }
    },
    stop() {
      turn++;
      refused = false;
      el.pause();
      el.removeAttribute("src");
      el.load();
    },
    onEnded(fn) {
      ended = fn;
    },
    onError(fn) {
      failed = fn;
    },
    bless() {
      if (el.getAttribute("src") !== null) return; // in use: its own play() counts
      el.play().catch(() => undefined); // no file: it waits, and pause() turns it down
      el.pause();
    },
    blocked: () => refused,
    time: () => el.currentTime,
  };
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
      // Pack file names may have capitals and spaces (vendor/<pack>/Sound Pack/x y.ogg).
      // Resolved from the site root: the game page lives in /play/ (T4.3).
      const res = await fetch(new URL(encodeURI(url), siteRoot()).href);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.arrayBuffer();
    },
    now: () => performance.now(),
    random: Math.random,
    createStream: browserStream,
    async loadStream(url) {
      const res = await fetch(new URL(encodeURI(url), siteRoot()).href);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const blob = await res.blob();
      return URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: "audio/ogg" }));
    },
    releaseStream: (objectUrl) => URL.revokeObjectURL(objectUrl),
    every(ms, fn) {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
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
/**
 * Ambient loops kept decoded: the one playing and the one before it, so going back and
 * forth between two zones does not decode again; older ones are forgotten.
 */
export const KEEP_LOOPS = 2;
/**
 * Music files kept fetched while unused (their compressed bytes, ~1 MB each; docs/07
 * "Audio"); the ones playing or wanted are kept on top of these. A decoded loop file is
 * kept only while it plays or is wanted.
 */
export const KEEP_STREAMS = 4;
/** A music file that failed is fetched again after this, ms, doubled at each failure… */
export const STREAM_RETRY_MS = 5000;
/** …up to this. */
export const STREAM_RETRY_MAX_MS = 60_000;
/**
 * Music elements made (and blessed) within the first gesture: as many as the director
 * plays at once, and one more for the moment it cuts the oldest fade short.
 */
export const MUSIC_DECKS = MAX_MUSIC_VOICES + 1;
/** How often the music director is pumped, ms (a track ends without any message). */
export const PUMP_MS = 250;
/** Spacing of the points of a gain ramp that follows an envelope, ms. */
export const RAMP_STEP_MS = 50;
/** A voice that gets its element late (unmuted, a slow file) fades in over this, ms. */
export const ATTACH_MS = 300;

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

/** The director's settings from sounds.yaml: its pools, the tracks' measures, the timings. */
export function directorConfig(manifest: SoundManifest): DirectorConfig {
  const m = manifest.music;
  const tracks: Record<string, MusicTrack> = {};
  const pools: Record<string, string[]> = {};
  for (const [pool, ids] of Object.entries(m.pools)) {
    const music = ids.filter((id) => manifest.sounds[id]?.channel === "music");
    if (music.length > 0) pools[pool] = music;
    for (const id of music) {
      const def = manifest.sounds[id];
      tracks[id] = {
        seconds: def?.seconds,
        end: def?.end ?? def?.seconds ?? 0,
        entries: def?.entries ?? [],
      };
    }
  }
  return {
    pools,
    tracks,
    titlePool: m.title,
    fades: m.fades,
    dwellMs: m.dwellMs,
    bossHoldMs: m.bossHoldMs,
    resumeMs: m.resumeMs,
    gapMs: m.gapMs,
  };
}

interface OneShot {
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

/** A media element (or a loop file's buffer source) and its gain, playing a voice. */
interface Deck {
  stream: StreamLike;
  gain: GainLike;
  voice: number;
  sound: string;
  /** The envelope its gain follows (the voice's, by identity). */
  env: Envelope;
  /** While it comes in late (ATTACH_MS): a linear ramp from `from` at `at` to `to`. */
  attach: { at: number; until: number; from: number; to: number } | undefined;
  /** A loop file's buffer source: made for its voice, never reused. */
  loop: boolean;
  /** Its element had its play-and-pause within a gesture (StreamLike.bless). */
  blessed: boolean;
}

/** What the music does now (tests, E2E). */
export interface MusicState {
  pool: string | undefined;
  role: Role | undefined;
  /**
   * Each voice: its gain on the envelope now, where its track is, and whether it has an
   * element; with one, the gain its node has now over the sound's volume (`heard`, what
   * the ramps really did) and where the element is in its file (`time`, s).
   */
  voices: {
    sound: string;
    pool: string;
    gain: number;
    position: number;
    playing: boolean;
    heard: number | undefined;
    time: number | undefined;
  }[];
  /** Files the director wants ready. */
  wanted: string[];
}

export class AudioEngine {
  private readonly manifest: SoundManifest;
  private readonly ports: AudioPorts;
  private prefs: AudioPrefs;
  private ctx: ContextLike | undefined;
  private master: GainLike | undefined;
  private readonly channels = new Map<SoundChannel, GainLike>();
  private readonly buffers = new Map<string, Promise<BufferLike | undefined>>();
  private readonly decoded = new Map<string, BufferLike>();
  private voices: OneShot[] = [];
  private readonly ambient: LoopSlot = { want: undefined, playing: undefined };
  /** The ambient loops wanted last, oldest first (at most KEEP_LOOPS). */
  private recentLoops: string[] = [];
  private readonly director: MusicDirector;
  private scene: Scene = { kind: "silent" };
  /** Music files being fetched or fetched: a track into an object URL, a loop file decoded. */
  private readonly streams = new Map<string, Promise<void>>();
  private readonly streamUrls = new Map<string, string>();
  private readonly loopBuffers = new Map<string, BufferLike>();
  /** Music files that failed → when to fetch them again (audio clock, ms). */
  private readonly failed = new Map<string, number>();
  /** How many times each music file failed (the wait before the next try doubles). */
  private readonly failures = new Map<string, number>();
  /** Fetched music files, oldest first (at most KEEP_STREAMS while unused). */
  private streamOrder: string[] = [];
  /** Voice id → the element playing it. */
  private readonly decks = new Map<number, Deck>();
  private readonly spareDecks: Deck[] = [];
  private stopPump: (() => void) | undefined;
  /** Sound ids started, newest last (E2E hook and tests). */
  readonly history: string[] = [];

  constructor(manifest: SoundManifest, prefs: AudioPrefs, ports: AudioPorts) {
    this.manifest = manifest;
    this.prefs = prefs;
    this.ports = ports;
    this.director = new MusicDirector(directorConfig(manifest), () => ports.random());
  }

  get unlocked(): boolean {
    return this.ctx !== undefined;
  }

  /** Call on a user gesture: creates (or resumes) the context and starts the wanted sound. */
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
      this.startAmbient();
      this.stopPump = this.ports.every(PUMP_MS, () => this.pump());
    }
    if (this.ctx.state === "suspended")
      void this.ctx
        .resume()
        .then(() => this.pump())
        .catch(() => undefined);
    this.blessDecks();
    this.pump();
  }

  /**
   * Within a gesture: makes the music's elements up to MUSIC_DECKS and blesses each new one
   * (StreamLike.bless), and plays again, from where its voice is now, an element whose
   * play() the browser refused for want of a gesture.
   */
  private blessDecks(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let elements = this.spareDecks.length;
    for (const d of this.decks.values()) if (!d.loop) elements++;
    for (; elements < MUSIC_DECKS; elements++) {
      const deck = this.newDeck(ctx);
      if (!deck) break;
      this.spareDecks.push(deck);
    }
    for (const d of this.spareDecks)
      if (!d.blessed) {
        d.stream.bless();
        d.blessed = true;
      }
    const now = ctx.currentTime * 1000;
    for (const [id, d] of this.decks) {
      if (!d.stream.blocked()) continue;
      const v = this.director.voices().find((x) => x.id === id);
      const url = this.streamUrls.get(d.sound);
      if (v && url !== undefined) d.stream.play(url, v.loop ? 0 : positionAt(v, now), v.loop);
    }
  }

  /** The volumes in use: the options panel starts from these each time it mounts. */
  currentPrefs(): AudioPrefs {
    return this.prefs;
  }

  setPrefs(prefs: AudioPrefs): void {
    this.prefs = prefs;
    this.applyVolumes();
    this.pump(); // muted music lets go of its elements; unmuted, they come back
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
    // Suspended (no gesture yet, or the tab's audio is paused): drop one-shots, or they
    // would pile up on a frozen clock and all fire when it resumes. Loops are unaffected.
    if (ctx.state !== "running") return undefined;
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
      // Plays queued while the file loaded run in order: the cap counts the ones before.
      if (this.voices.filter((v) => v.sound === id).length >= def.maxVoices) return;
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
    const voice: OneShot = { sound: id, source: src, endsAt: ctx.currentTime + buffer.duration };
    this.voices.push(voice);
    src.addEventListener("ended", () => {
      this.voices = this.voices.filter((v) => v !== voice);
      tail.disconnect();
    });
    src.start();
    this.pushHistory(id);
  }

  private pushHistory(id: string): void {
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
      const loading: Promise<BufferLike | undefined> =
        def && ctx
          ? this.ports
              .fetch(def.url)
              .then((data) => ctx.decodeAudioData(data))
              .then((b) => {
                // A loop forgotten while it loaded is not cached again.
                if (this.buffers.get(id) === loading) this.decoded.set(id, b);
                return b;
              })
              .catch((err: unknown) => {
                console.warn(`audio: cannot load ${id}`, err);
                return undefined;
              })
          : Promise.resolve(undefined);
      p = loading;
      this.buffers.set(id, p);
    }
    return p;
  }

  /** Whether a sound's decoded buffer is cached (tests: what a loop change forgets). */
  isCached(id: string): boolean {
    return this.buffers.has(id);
  }

  /** Keeps `id` among the last KEEP_LOOPS ambient loops and forgets the older ones. */
  private rememberLoop(id: string): void {
    const recent = this.recentLoops.filter((r) => r !== id);
    recent.push(id);
    while (recent.length > KEEP_LOOPS) {
      const old = recent.shift();
      if (old === undefined) break;
      // A source still fading out keeps its own reference to the buffer.
      this.buffers.delete(old);
      this.decoded.delete(old);
    }
    this.recentLoops = recent;
  }

  // ---- the ambient bed ------------------------------------------------------------------

  /** The ambient loop that should play (undefined = none); a change crossfades. */
  setAmbient(id: string | undefined): void {
    if (this.ambient.want === id) return;
    this.ambient.want = id;
    if (id !== undefined) this.rememberLoop(id);
    this.startAmbient();
  }

  /** What plays now: the music's lead track and the ambient loop (tests, E2E). */
  playingLoops(): { music: string | undefined; ambient: string | undefined } {
    return { music: this.director.leadSound(), ambient: this.ambient.playing?.sound };
  }

  private startAmbient(): void {
    const ctx = this.ctx;
    const slot = this.ambient;
    if (!ctx) return;
    const fade = this.manifest.ambient.fadeMs / 1000;
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
    const out = this.channels.get("ambient");
    if (id === undefined || !def || def.channel !== "ambient" || !out) return;
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
      this.pushHistory(id);
    });
  }

  // ---- the music ------------------------------------------------------------------------

  /** Where the player is, for the music director: the title screen, the world, or nothing. */
  setMusic(scene: Scene): void {
    this.scene = scene;
    this.pump();
  }

  /** What the music does now (tests, E2E). */
  musicState(): MusicState {
    const now = (this.ctx?.currentTime ?? 0) * 1000;
    const playing = this.director.playing();
    return {
      pool: playing?.pool,
      role: playing?.role,
      voices: this.director.voices().map((v) => {
        const deck = this.decks.get(v.id);
        const vol = this.manifest.sounds[v.sound]?.volume ?? 1;
        return {
          sound: v.sound,
          pool: v.pool,
          gain: gainAt(v.env, now),
          position: positionAt(v, now),
          playing: deck !== undefined,
          heard: deck && vol > 0 ? deck.gain.gain.value / vol : undefined,
          time: deck?.stream.time(),
        };
      }),
      wanted: this.director.wanted(),
    };
  }

  /**
   * Moves the director to the audio clock and mirrors its voices on media elements. Runs
   * every PUMP_MS, on a new scene, when a file arrives and when an element ends. Nothing
   * moves while the context is not running (no gesture yet, or audio paused by the system).
   */
  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime * 1000;
    const audible = this.level("music") > 0;
    if (audible) this.settleFailures(now);
    // Muted, nothing is fetched: every track counts as ready and plays on no element.
    const ready = (s: string): Readiness =>
      !audible ? "ready" : this.failed.has(s) ? "failed" : this.has(s) ? "ready" : "loading";
    this.director.update(now, this.scene, ready);
    if (audible) for (const s of this.director.wanted()) this.fetchMusic(s);
    this.syncDecks(ctx, now, audible);
  }

  /** Whether a music file is fetched (a loop file: decoded) and can play right away. */
  private has(sound: string): boolean {
    return this.streamUrls.has(sound) || this.loopBuffers.has(sound);
  }

  /**
   * Files due for another try are forgotten, so the next want fetches them again; a voice
   * with no element whose file failed goes (the director moves on to the next of its pool)
   * instead of "playing" in silence until the model thinks its track ended.
   */
  private settleFailures(now: number): void {
    for (const [s, at] of this.failed) if (now >= at) this.failed.delete(s);
    for (const v of this.director.voices())
      if (v.env.to > 0 && !this.decks.has(v.id) && this.failed.has(v.sound))
        this.director.lost(v.id, now);
  }

  private syncDecks(ctx: ContextLike, now: number, audible: boolean): void {
    const voices = this.director.voices();
    const live = new Set(voices.map((v) => v.id));
    for (const [id, deck] of this.decks) if (!audible || !live.has(id)) this.freeDeck(id, deck);
    if (!audible) return;
    for (const v of voices) {
      const deck = this.decks.get(v.id);
      if (deck) {
        if (deck.env !== v.env) this.follow(deck, v, now, false);
        continue;
      }
      if (v.env.to <= 0) continue; // fading out: not worth an element now
      const buffer = v.loop ? this.loopBuffers.get(v.sound) : undefined;
      const url = v.loop ? undefined : this.streamUrls.get(v.sound);
      if (buffer === undefined && url === undefined) {
        this.fetchMusic(v.sound);
        continue;
      }
      const fresh = buffer ? this.loopDeck(ctx, buffer) : this.takeDeck(ctx);
      if (!fresh) continue;
      fresh.voice = v.id;
      fresh.sound = v.sound;
      this.decks.set(v.id, fresh);
      const id = v.id;
      const sound = v.sound;
      fresh.stream.onEnded(() => {
        if (this.decks.get(id) !== fresh) return;
        this.director.ended(id, ctx.currentTime * 1000);
        this.pump();
      });
      fresh.stream.onError(() => {
        if (this.decks.get(id) !== fresh) return;
        this.markFailed(sound);
        this.director.lost(id, ctx.currentTime * 1000);
        this.pump();
      });
      // A voice that started a while ago (its file was late, or the music was muted) comes
      // in where it is now, with a short fade instead of a jump.
      const late = now - v.startedAt > PUMP_MS;
      fresh.stream.play(url ?? "", v.loop ? 0 : positionAt(v, now), v.loop);
      this.follow(fresh, v, now, late);
      this.pushHistory(v.sound);
    }
  }

  /**
   * Ramps a deck's gain along its voice's envelope from `now`. One that comes in late
   * (`late`, or still within its ATTACH_MS ramp when the envelope changes) ramps from where
   * its gain is to the envelope by the end of that ramp, never jumping to the envelope.
   */
  private follow(deck: Deck, v: Voice, now: number, late: boolean): void {
    const vol = this.manifest.sounds[v.sound]?.volume ?? 1;
    const p = deck.gain.gain;
    const t = now / 1000;
    p.cancelScheduledValues(t);
    const a = deck.attach;
    const coming = late
      ? { from: 0, until: now + ATTACH_MS }
      : a && now < a.until
        ? { from: a.from + ((a.to - a.from) * (now - a.at)) / (a.until - a.at), until: a.until }
        : undefined;
    let from = now;
    if (coming) {
      const to = gainAt(v.env, coming.until) * vol;
      p.setValueAtTime(coming.from, t);
      p.linearRampToValueAtTime(to, coming.until / 1000);
      deck.attach = { at: now, until: coming.until, from: coming.from, to };
      from = coming.until;
    } else {
      deck.attach = undefined;
      p.setValueAtTime(gainAt(v.env, now) * vol, t);
    }
    for (const [ms, g] of envelopePoints(v.env, from, RAMP_STEP_MS))
      p.linearRampToValueAtTime(g * vol, ms / 1000);
    deck.env = v.env;
  }

  /** An element for a voice: a spare one (the first made, the last freed), or a new one. */
  private takeDeck(ctx: ContextLike): Deck | undefined {
    return this.spareDecks.shift() ?? this.newDeck(ctx);
  }

  private newDeck(ctx: ContextLike): Deck | undefined {
    const out = this.channels.get("music");
    const stream = out && this.ports.createStream(ctx);
    if (!out || !stream) return undefined;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    stream.output.connect(gain);
    gain.connect(out);
    return {
      stream,
      gain,
      voice: 0,
      sound: "",
      env: { at: 0, ms: 0, from: 0, to: 0 },
      attach: undefined,
      loop: false,
      blessed: false,
    };
  }

  /**
   * A loop file (soundgen's themes) on a buffer source of its own, which loops without a
   * gap: a media element's `loop` leaves one at every turn (Chromium).
   */
  private loopDeck(ctx: ContextLike, buffer: BufferLike): Deck | undefined {
    const out = this.channels.get("music");
    if (!out) return undefined;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(out);
    let src: SourceLike | undefined;
    let since = 0;
    const stream: StreamLike = {
      output: gain,
      play() {
        src?.stop();
        src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.connect(gain);
        src.start();
        since = ctx.currentTime;
      },
      stop() {
        src?.stop();
        src?.disconnect();
        src = undefined;
      },
      onEnded: () => undefined,
      onError: () => undefined,
      bless: () => undefined,
      blocked: () => false,
      time: () => (src ? (ctx.currentTime - since) % Math.max(buffer.duration, 0.001) : 0),
    };
    return {
      stream,
      gain,
      voice: 0,
      sound: "",
      env: { at: 0, ms: 0, from: 0, to: 0 },
      attach: undefined,
      loop: true,
      blessed: true,
    };
  }

  private freeDeck(id: number, deck: Deck): void {
    const t = this.ctx?.currentTime ?? 0;
    deck.gain.gain.cancelScheduledValues(t);
    deck.gain.gain.setValueAtTime(0, t);
    deck.stream.stop();
    deck.attach = undefined;
    this.decks.delete(id);
    if (deck.loop) deck.gain.disconnect();
    else this.spareDecks.unshift(deck);
  }

  /**
   * Fetches a music file once: a track into an object URL, a loop file decoded. A failure
   * is logged and remembered (`failed`) until it is due for another try.
   */
  private fetchMusic(sound: string): void {
    const def = this.manifest.sounds[sound];
    const ctx = this.ctx;
    if (!def || !ctx || this.streams.has(sound) || this.failed.has(sound)) return;
    const current = (): boolean => this.streams.get(sound) === loading;
    const fetching: Promise<unknown> =
      def.seconds === undefined
        ? this.ports
            .fetch(def.url)
            .then((data) => ctx.decodeAudioData(data))
            .then((b) => {
              if (current()) this.loopBuffers.set(sound, b);
            })
        : this.ports.loadStream(def.url).then((url) => {
            if (current()) this.streamUrls.set(sound, url);
            else this.ports.releaseStream(url); // let go of while it loaded
          });
    const loading: Promise<void> = fetching.then(
      () => {
        if (!current()) return;
        this.keepStream(sound);
        this.pump();
      },
      (err: unknown) => {
        if (!current()) return;
        console.warn(`audio: cannot load ${sound}`, err);
        this.markFailed(sound);
        this.pump();
      },
    );
    this.streams.set(sound, loading);
  }

  /** A music file failed (to arrive or to play): forgotten, and fetched again later. */
  private markFailed(sound: string): void {
    const n = (this.failures.get(sound) ?? 0) + 1;
    this.failures.set(sound, n);
    const wait = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_MS * 2 ** (n - 1));
    this.failed.set(sound, (this.ctx?.currentTime ?? 0) * 1000 + wait);
    this.forgetStream(sound);
    this.streamOrder = this.streamOrder.filter((s) => s !== sound);
  }

  private forgetStream(sound: string): void {
    const url = this.streamUrls.get(sound);
    if (url !== undefined) this.ports.releaseStream(url);
    this.streamUrls.delete(sound);
    this.loopBuffers.delete(sound);
    this.streams.delete(sound);
  }

  /**
   * Keeps `sound` among the last KEEP_STREAMS files and lets go of older unused ones; a
   * decoded loop file goes as soon as it is unused (~10 MB of PCM each).
   */
  private keepStream(sound: string): void {
    const order = this.streamOrder.filter((s) => s !== sound);
    order.push(sound);
    const inUse = new Set([...this.decks.values()].map((d) => d.sound));
    for (const s of this.director.wanted()) inUse.add(s);
    inUse.add(sound);
    for (;;) {
      let i = order.findIndex((s) => !inUse.has(s) && this.loopBuffers.has(s));
      if (i < 0 && order.length > KEEP_STREAMS) i = order.findIndex((s) => !inUse.has(s));
      if (i < 0) break;
      const [old] = order.splice(i, 1);
      if (old !== undefined) this.forgetStream(old);
    }
    this.streamOrder = order;
  }

  /** Whether a music file is fetched and kept (tests: what the engine lets go of). */
  isStreamed(sound: string): boolean {
    return this.has(sound);
  }

  /** Stops the director's pump (tests; a page keeps one engine for its whole life). */
  close(): void {
    this.stopPump?.();
    this.stopPump = undefined;
  }
}
