// Audio engine (T3.7) over the Web Audio API: one gain per channel (sfx, ui, music,
// ambient) under a master gain, lazily loaded and cached buffers, a cap on simultaneous
// voices, simple positional sound (distance attenuation and stereo pan around the player),
// the positional ambience's loops, and the music.
//
// The ambience is the living world's (livingworld/client/src/ambience.ts, through the glue
// client/src/audio/ambience.ts): a few times a second it hands setAmbience the loops that
// should sound, each with its gain, pan and start point; the engine mirrors them on looping
// buffer sources in the ambient channel and ramps each gain and pan to its new value over
// AMBIENCE_RAMP_MS (the module already moves them slowly: nothing is ever cut).
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
// plays another track of its pool, or keeps the old music. A file the element cannot play
// at all (MEDIA_ERR_SRC_NOT_SUPPORTED: a codec it lacks) is not fetched again this session,
// and where the browser says it lacks Ogg Opus (old WebKit) no track is ever fetched: the
// retries would download ~1 MB a minute for nothing. A loop file (soundgen's themes,
// with no `seconds`) is decoded and loops on a buffer source instead: a media element's
// `loop` leaves a gap at every turn.
//
// A sound effect or an ambient loop whose file does not come is asked again with the
// atlas's policy (@rpg/renderer/retry ASSET_RETRY: 4 attempts, waits of 0.5, 1 and 2 s);
// then it is forgotten and asked again on a play after STREAM_RETRY_MS (doubling up to
// STREAM_RETRY_MAX_MS), as the music: before, a short cut of the network left a hit, a
// spell or an island's ambience silent until the page was loaded again.
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
import { ASSET_RETRY, sleep, withRetry } from "@rpg/renderer/retry";
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
  /** `offset`: where in the buffer it starts, s (a loop then wraps round to its start). */
  start(when?: number, offset?: number): void;
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
  /**
   * `fn` runs when the element cannot play its file: broken, or a codec it lacks. It says
   * `unsupported` when the element cannot play that kind of file at all
   * (MEDIA_ERR_SRC_NOT_SUPPORTED), which fetching it again never mends.
   */
  onError(fn: (unsupported: boolean) => void): void;
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
  /** Resolves after `ms` (the waits between the attempts of a sound file's fetch). */
  sleep(ms: number): Promise<void>;
  /** Milliseconds, monotonic (performance.now). */
  now(): number;
  /** Uniform in [0, 1): picks among a sound's variants, and the music director's picks. */
  random(): number;
  /** A media element whose output goes into `ctx`; undefined where there is none. */
  createStream(ctx: ContextLike): StreamLike | undefined;
  /** Whether a media element can play the music's tracks (Ogg Opus); asked once. */
  canStream(): boolean;
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
  let failed: (unsupported: boolean) => void = () => undefined;
  // A play() that a later play() or stop() replaced must not seek, start or report anything.
  let turn = 0;
  let refused = false;
  el.addEventListener("ended", () => ended());
  // A file it cannot play: loadedmetadata never comes. stop() leaves no src to fail at.
  // Code 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) is a kind of file it cannot play at all.
  el.addEventListener("error", () => {
    if (el.getAttribute("src") !== null) failed(el.error?.code === 4);
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
          else failed(name === "NotSupportedError");
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
    sleep,
    now: () => performance.now(),
    random: Math.random,
    createStream: browserStream,
    canStream() {
      // Old WebKit (Safari, iOS, the macOS and iOS webviews) has no Ogg Opus in <audio>.
      if (typeof Audio === "undefined") return false;
      try {
        return new Audio().canPlayType('audio/ogg; codecs="opus"') !== "";
      } catch {
        return false;
      }
    },
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
 * Ambient loops kept decoded beyond the ones playing: the last ones that stopped, so walking
 * back and forth along a beach does not decode again; older ones are forgotten (docs/07
 * "Audio": a 16 s mono loop is ~3 MB decoded).
 */
export const KEEP_LOOPS = 2;
/** An ambience voice's gain and pan ramp to a new value over this, ms. */
export const AMBIENCE_RAMP_MS = 300;
/** A voice that is no longer handed over (the game closed) fades out over this, ms. */
export const AMBIENCE_RELEASE_MS = 1500;

/** A loop of the ambience (livingworld/client/src/ambience.ts AmbienceVoice). */
export interface AmbientLoop {
  readonly id: number;
  readonly sound: string;
  /** 0..1, multiplied with the sound's volume. */
  readonly gain: number;
  readonly pan: number;
  /** Where in the loop it starts, as a fraction of its length. */
  readonly offset: number;
}
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

/** An ambience voice the engine mirrors: its source once its file has come. */
interface AmbientNode {
  sound: string;
  playing: { source: SourceLike; gain: GainLike; panner: PannerLike } | undefined;
  /** Its file is being fetched. */
  loading: boolean;
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
  /**
   * Sound files (effects, ambient loops) whose attempts ran out → when a play may fetch
   * them again (ports.now, ms; Infinity for one that does not decode, never again this
   * session); `soundFailures` counts the times, the wait doubling.
   */
  private readonly soundFailed = new Map<string, number>();
  private readonly soundFailures = new Map<string, number>();
  private readonly decoded = new Map<string, BufferLike>();
  private voices: OneShot[] = [];
  /** The ambience's loops as last handed over, and the nodes playing them by voice id. */
  private ambience: readonly AmbientLoop[] = [];
  private readonly ambientNodes = new Map<number, AmbientNode>();
  /** Ambient loops that played, least recently used first (KEEP_LOOPS stay decoded). */
  private recentLoops: string[] = [];
  private readonly director: MusicDirector;
  private scene: Scene = { kind: "silent" };
  /** Music files being fetched or fetched: a track into an object URL, a loop file decoded. */
  private readonly streams = new Map<string, Promise<void>>();
  private readonly streamUrls = new Map<string, string>();
  private readonly loopBuffers = new Map<string, BufferLike>();
  /**
   * Music files that failed → when to fetch them again (audio clock, ms); Infinity for one
   * the browser cannot play at all, never fetched again this session.
   */
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
    const config = directorConfig(manifest);
    this.director = new MusicDirector(config, () => ports.random());
    // No Ogg Opus in a media element: the streamed tracks never count as ready, so none is
    // fetched (each would come down whole to fail, again at every retry). The director
    // stays silent, or plays a loop file of its pool (those are decoded, not streamed).
    if (!ports.canStream()) {
      for (const [id, t] of Object.entries(config.tracks))
        if (t.seconds !== undefined) this.failed.set(id, Infinity);
      console.warn("audio: this browser cannot play the music (Ogg Opus)");
    }
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
      this.syncAmbience();
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
    this.syncAmbience(); // muted ambience lets go of its loops; unmuted, they come back
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
    return this.playId(id, at, listener);
  }

  /**
   * Plays the sound `id` of sounds.yaml itself (no event: the living world's data names
   * its sounds, livingworld/README.md), positional like play. Returns id if it starts.
   */
  playId(id: string, at?: Pos, listener?: Pos): string | undefined {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return undefined;
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

  /**
   * Loads and decodes a sound once, its fetch retried with ASSET_RETRY. When the attempts
   * run out it resolves undefined, is logged and forgotten: a play asks for it again once
   * STREAM_RETRY_MS have passed (doubling at each failure), not on every play meanwhile.
   * A file that came but does not decode (a browser without Ogg) is not asked for again
   * this session (giveUp).
   */
  private load(id: string): Promise<BufferLike | undefined> {
    const p = this.buffers.get(id);
    if (p) return p;
    const def = this.manifest.sounds[id];
    const ctx = this.ctx;
    if (!def || !ctx) return Promise.resolve(undefined);
    const due = this.soundFailed.get(id);
    if (due !== undefined && this.ports.now() < due) return Promise.resolve(undefined);
    this.soundFailed.delete(id);
    const loading: Promise<BufferLike | undefined> = withRetry(() => this.ports.fetch(def.url), {
      policy: ASSET_RETRY,
      sleep: (ms) => this.ports.sleep(ms),
    }).then(
      (data) =>
        ctx.decodeAudioData(data).then(
          (b) => {
            this.soundFailures.delete(id);
            // A loop forgotten while it loaded is not cached again.
            if (this.buffers.get(id) === loading) this.decoded.set(id, b);
            return b;
          },
          (err: unknown) => this.giveUp(id, loading, err, true),
        ),
      (err: unknown) => this.giveUp(id, loading, err, false),
    );
    this.buffers.set(id, loading);
    return loading;
  }

  /**
   * A sound file that did not load (`loading`): logged and forgotten. One whose attempts
   * ran out is due again after the wait (soundFailed); one that came but does not decode
   * (`undecodable`) never is this session: it would fail the same way on every try, like
   * the music the browser cannot play (canStream, `unsupported`).
   */
  private giveUp(
    id: string,
    loading: Promise<BufferLike | undefined>,
    err: unknown,
    undecodable: boolean,
  ): undefined {
    console.warn(`audio: cannot ${undecodable ? "decode" : "load"} ${id}`, err);
    if (this.buffers.get(id) === loading) this.buffers.delete(id);
    if (undecodable) {
      this.soundFailed.set(id, Number.POSITIVE_INFINITY);
      return undefined;
    }
    const n = (this.soundFailures.get(id) ?? 0) + 1;
    this.soundFailures.set(id, n);
    const wait = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_MS * 2 ** (n - 1));
    this.soundFailed.set(id, this.ports.now() + wait);
    return undefined;
  }

  /** Whether a sound's decoded buffer is cached (tests: what a loop change forgets). */
  isCached(id: string): boolean {
    return this.buffers.has(id);
  }

  /**
   * Keeps the decoded ambient loops that play, and the KEEP_LOOPS that played last; older
   * ones are forgotten (a source still fading out keeps its own reference to its buffer).
   */
  private trimLoops(): void {
    const live = new Set([...this.ambientNodes.values()].map((n) => n.sound));
    const order = [...this.recentLoops.filter((r) => !live.has(r)), ...live];
    let idle = order.length - live.size;
    const keep: string[] = [];
    for (const id of order) {
      if (!live.has(id) && idle > KEEP_LOOPS) {
        this.buffers.delete(id);
        this.decoded.delete(id);
        idle--;
        continue;
      }
      keep.push(id);
    }
    this.recentLoops = keep;
  }

  // ---- the ambience ---------------------------------------------------------------------

  /**
   * The loops the ambience wants now (livingworld/client/src/ambience.ts): a new voice
   * starts at its offset, one that goes on ramps to its new gain and pan, and one no longer
   * listed fades out over AMBIENCE_RELEASE_MS. Remembered while locked; with the ambient
   * channel muted nothing is fetched or played. A file that did not come is asked again by
   * a later call once its wait is over (load keeps the policy): the glue calls this a few
   * times a second.
   */
  setAmbience(loops: readonly AmbientLoop[]): void {
    this.ambience = loops;
    this.syncAmbience();
  }

  /** What plays now: the music's lead track, the loudest ambient loop and all of them. */
  playingLoops(): {
    music: string | undefined;
    ambient: string | undefined;
    ambience: string[];
  } {
    const playing = this.ambience.filter((l) => this.ambientNodes.get(l.id)?.playing);
    let loudest: AmbientLoop | undefined;
    for (const l of playing) if (!loudest || l.gain > loudest.gain) loudest = l;
    return {
      music: this.director.leadSound(),
      ambient: loudest?.sound,
      ambience: playing.map((l) => l.sound).sort(),
    };
  }

  private syncAmbience(): void {
    const ctx = this.ctx;
    const out = this.channels.get("ambient");
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    const audible = this.level("ambient") > 0;
    const wanted = new Map(audible ? this.ambience.map((l) => [l.id, l] as const) : []);
    for (const [id, node] of this.ambientNodes) {
      if (wanted.has(id)) continue;
      this.ambientNodes.delete(id);
      const p = node.playing;
      if (!p) continue;
      const end = t + AMBIENCE_RELEASE_MS / 1000;
      p.gain.gain.cancelScheduledValues(t);
      p.gain.gain.setValueAtTime(p.gain.gain.value, t);
      p.gain.gain.linearRampToValueAtTime(0, end);
      p.source.stop(end);
    }
    const ramp = t + AMBIENCE_RAMP_MS / 1000;
    for (const loop of wanted.values()) {
      const def = this.manifest.sounds[loop.sound];
      if (!def || def.channel !== "ambient") continue;
      let node = this.ambientNodes.get(loop.id);
      const p = node?.playing;
      if (p) {
        p.gain.gain.cancelScheduledValues(t);
        p.gain.gain.setValueAtTime(p.gain.gain.value, t);
        p.gain.gain.linearRampToValueAtTime(def.volume * loop.gain, ramp);
        p.panner.pan.cancelScheduledValues(t);
        p.panner.pan.setValueAtTime(p.panner.pan.value, t);
        p.panner.pan.linearRampToValueAtTime(loop.pan, ramp);
        continue;
      }
      if (node?.loading) continue;
      if (!node) {
        node = { sound: loop.sound, playing: undefined, loading: false };
        this.ambientNodes.set(loop.id, node);
        this.trimLoops();
      }
      this.startLoop(ctx, out, loop.id, node, def.volume);
    }
  }

  private startLoop(
    ctx: ContextLike,
    out: GainLike,
    id: number,
    node: AmbientNode,
    volume: number,
  ): void {
    node.loading = true;
    void this.load(node.sound).then((buffer) => {
      node.loading = false;
      // Still wanted, under the same voice, and not started meanwhile?
      if (!buffer || this.ambientNodes.get(id) !== node || node.playing) return;
      const loop = this.ambience.find((l) => l.id === id);
      if (!loop) return;
      const at = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(volume * loop.gain, at + AMBIENCE_RAMP_MS / 1000);
      const p = ctx.createStereoPanner();
      p.pan.setValueAtTime(loop.pan, at);
      src.connect(g);
      g.connect(p);
      p.connect(out);
      src.start(at, (((loop.offset % 1) + 1) % 1) * buffer.duration);
      node.playing = { source: src, gain: g, panner: p };
      this.pushHistory(node.sound);
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
      fresh.stream.onError((unsupported) => {
        if (this.decks.get(id) !== fresh) return;
        this.markFailed(sound, unsupported);
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

  /**
   * A music file failed (to arrive or to play): forgotten, and fetched again later; one the
   * element cannot play at all (`forever`: a codec it lacks) is not fetched again.
   */
  private markFailed(sound: string, forever = false): void {
    const n = (this.failures.get(sound) ?? 0) + 1;
    this.failures.set(sound, n);
    const wait = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_MS * 2 ** (n - 1));
    this.failed.set(sound, forever ? Infinity : (this.ctx?.currentTime ?? 0) * 1000 + wait);
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
