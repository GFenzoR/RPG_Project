// The music director (the owner's request of 2026-11-18, docs/02 "Sonido"): which track of
// which pool plays, from which second, and how one gives way to the next. Pure and
// deterministic: it is fed the place (the title screen, or the world's zone, quest area and
// boss in view) with a clock (ms) and a random source injected by its owner, and keeps a
// list of voices — a track playing from a second, with an equal-power gain envelope — that
// the engine (engine.ts) mirrors on streamed media elements.
//
// - Each place plays a pool (assets/sounds.yaml music.pools), shuffled like a deck of cards:
//   every track once per round, and never the same one twice in a row.
// - A track starts at one of its entries (music-gemini measured them: where a phrase
//   begins), never at its first second, unless it has none (a loop file).
// - Back in a zone (or the title screen) within `resumeMs`, its track goes on where it was;
//   after that, a fresh one. After a boss, the zone's track comes back at a fresh entry.
// - Crossfades are equal-power (sin/cos), with a length by what changed (`Fades`).
// - A new zone or quest area takes over only after `dwellMs` in it: walking along a border
//   never flaps. A boss takes over at once and lets go `bossHoldMs` after the last one left
//   the view.
// - A zone's (or quest area's) track plays out its own ending, then a breath of ambience
//   (`gapMs`) before the next; the title's and a boss's crossfade into the next before the
//   ending, so they never stop.
// - Ordinary fights are not an input at all: the owner wants the zone's music to go on.

/** A track of a pool, from assets/sounds.yaml (music-gemini measured it). */
export interface MusicTrack {
  /** Length, s; undefined = a loop file (soundgen's themes): it loops and never ends. */
  seconds: number | undefined;
  /** Where its body ends, s: the composed ending starts there. */
  end: number;
  /** Where it may start, s, ascending (never 0). */
  entries: readonly number[];
}

/** Crossfade lengths, ms, by what changed. */
export interface Fades {
  /** Another zone or quest area (or back to one). */
  zone: number;
  /** A boss came into view. */
  bossIn: number;
  /** The boss's music lets go, back to the zone's. */
  bossOut: number;
  /** The title screen and the world, either way. */
  title: number;
  /** The next track of a pool (a fade-in after a gap, or a crossfade). */
  next: number;
}

export interface DirectorConfig {
  /** Pool id → its tracks (sound ids). */
  pools: Readonly<Record<string, readonly string[]>>;
  /** Sound id → its measures. */
  tracks: Readonly<Record<string, MusicTrack>>;
  /** The title screen's pool, if it has one. */
  titlePool: string | undefined;
  fades: Fades;
  dwellMs: number;
  bossHoldMs: number;
  resumeMs: number;
  /** Silence (ambience) between two tracks of a zone, ms: [min, max]. */
  gapMs: readonly [number, number];
}

/** Where the player is, as pools. */
export type Scene =
  | { kind: "silent" }
  | { kind: "title" }
  | {
      kind: "world";
      /** The zone's pool: the island, or the caves under it. */
      zone: string | undefined;
      /** The pool of the important quest area the player stands in. */
      quest: string | undefined;
      /** The pool of a boss in view. */
      boss: string | undefined;
    };

/** What a pool is playing for: how it ends a track and whether it resumes. */
export type Role = "title" | "zone" | "quest" | "boss";

/** A gain going from `from` to `to` over `ms` from `at`, along an equal-power curve. */
export interface Envelope {
  at: number;
  ms: number;
  from: number;
  to: number;
}

/** A track playing (or fading out). The engine gives each one a media element. */
export interface Voice {
  readonly id: number;
  readonly sound: string;
  readonly pool: string;
  readonly role: Role;
  /** The second of the track it started from, at `startedAt` (ms). */
  readonly from: number;
  readonly startedAt: number;
  /** A loop file: the element loops and the voice never ends by itself. */
  readonly loop: boolean;
  /** Replaced (never mutated) when it changes, so the engine sees the change by identity. */
  env: Envelope;
}

/** Most voices at once; a new one beyond this cuts the oldest fading one short. */
export const MAX_VOICES = 3;
/** How fast a voice cut short fades, ms. */
export const CUT_MS = 250;
/** A remembered position this close to the body's end (s) starts a fresh track instead. */
export const RESUME_MARGIN_S = 15;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * The gain of an envelope at `now`: before it, `from`; after it, `to`; in between, the
 * equal-power curve sin(a + (b − a)·p) with a = asin(from), b = asin(to). From 0 to 1 that
 * is sin(p·π/2) and from 1 to 0 cos(p·π/2), so a crossfade of two voices keeps
 * in² + out² = 1: the same power all the way through (a linear one dips 3 dB mid-way).
 */
export function gainAt(env: Envelope, now: number): number {
  if (env.ms <= 0) return now < env.at ? env.from : env.to;
  if (now <= env.at) return env.from;
  if (now >= env.at + env.ms) return env.to;
  const a = Math.asin(clamp01(env.from));
  const b = Math.asin(clamp01(env.to));
  return Math.sin(a + ((b - a) * (now - env.at)) / env.ms);
}

/**
 * The points (ms, gain) the engine ramps through, every `stepMs` from `from` to the end of
 * the envelope (the last one exactly at its end): Web Audio ramps linearly between them.
 * Empty when the envelope is over (the gain holds at `to`).
 */
export function envelopePoints(env: Envelope, from: number, stepMs: number): [number, number][] {
  const end = env.at + env.ms;
  if (from >= end || env.ms <= 0) return [];
  const out: [number, number][] = [];
  const step = Math.max(1, stepMs);
  for (let t = Math.max(from, env.at) + step; t < end; t += step) out.push([t, gainAt(env, t)]);
  out.push([end, env.to]);
  return out;
}

/** Where a voice's track is at `now`, s (a loop file's is its first pass). */
export function positionAt(voice: Voice, now: number): number {
  return voice.from + Math.max(0, now - voice.startedAt) / 1000;
}

/** A small seeded random source (mulberry32): the same seed, the same music. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Target {
  pool: string;
  role: Role;
}

/** A start the director decided on, waiting until its file is ready. */
interface Pending {
  target: Target | undefined;
  sound: string | undefined;
  from: number;
  fadeMs: number;
  /** A natural next (after a gap or into a crossfade): the outgoing track is not remembered. */
  next: boolean;
}

interface Memory {
  sound: string;
  position: number;
  at: number;
}

export class MusicDirector {
  private readonly config: DirectorConfig;
  private readonly random: () => number;
  private voiceList: Voice[] = [];
  private nextId = 1;
  /** What plays now (the lead voice's pool), or undefined: silence or a gap. */
  private current: Target | undefined;
  /** The voice that carries `current` (the last one started). */
  private lead: Voice | undefined;
  /** A gap between two tracks of the current pool ends at this time. */
  private gapUntil: number | undefined;
  private pending: Pending | undefined;
  /** The zone or quest area the music follows, and the one the player is waiting in. */
  private place: Target | undefined;
  private candidate: { target: Target | undefined; since: number } | undefined;
  private placed = false;
  /** The boss whose music plays, and when one was last in view. */
  private boss: string | undefined;
  private bossSeenAt = Number.NEGATIVE_INFINITY;
  private readonly bags = new Map<string, string[]>();
  private readonly last = new Map<string, string>();
  private readonly lastEntry = new Map<string, number>();
  private readonly memory = new Map<string, Memory>();
  /** The next track of each pool, decided when its current one starts (to prefetch it). */
  private readonly queued = new Map<string, string>();
  /** Bumped on every change of the voices (the engine skips work when it did not move). */
  version = 0;

  constructor(config: DirectorConfig, random: () => number) {
    this.config = config;
    this.random = random;
  }

  /** The voices playing or fading, oldest first. */
  voices(): readonly Voice[] {
    return this.voiceList;
  }

  /** The pool playing now (tests, E2E). */
  playing(): { pool: string; role: Role } | undefined {
    return this.current;
  }

  /** The sound of the lead voice (what `playingLoops` reports). */
  leadSound(): string | undefined {
    return this.lead?.sound;
  }

  /** Sounds the engine should have ready: a start waiting for its file, then the next ones. */
  wanted(): string[] {
    const out: string[] = [];
    if (this.pending?.sound !== undefined) out.push(this.pending.sound);
    if (this.current) {
      const next = this.queued.get(this.current.pool);
      if (next !== undefined && !out.includes(next)) out.push(next);
    }
    return out;
  }

  /**
   * Moves the music to `now` for `scene`. `ready(sound)` says whether the engine can play a
   * sound right away: a start waits (the old music goes on) until it can.
   */
  update(now: number, scene: Scene, ready: (sound: string) => boolean): void {
    this.dropFinished(now);
    const want = this.desired(now, scene);
    const planned = this.pending !== undefined && sameTarget(want, this.pending.target);
    if (!sameTarget(want, this.current) && !planned) {
      this.pending = this.planChange(now, want);
    } else if (sameTarget(want, this.current) && this.pending && !this.pending.next) {
      this.pending = undefined; // back to what plays before the change happened
    }
    if (!this.pending) this.planNext(now);
    const p = this.pending;
    if (p && (p.sound === undefined || ready(p.sound))) {
      this.pending = undefined;
      this.apply(now, p);
    }
  }

  /** The engine heard a voice's element end before the director expected it. */
  ended(voiceId: number, now: number): void {
    const v = this.voiceList.find((x) => x.id === voiceId);
    if (!v || v.loop) return;
    this.voiceList = this.voiceList.filter((x) => x !== v);
    this.version++;
    if (v === this.lead) this.leadEnded(now);
  }

  // ---- what should play --------------------------------------------------------------

  private desired(now: number, scene: Scene): Target | undefined {
    if (scene.kind === "silent") {
      this.placed = false;
      return undefined;
    }
    if (scene.kind === "title") {
      this.placed = false;
      this.boss = undefined;
      const pool = this.config.titlePool;
      return pool !== undefined && this.hasPool(pool) ? { pool, role: "title" } : undefined;
    }
    // The zone or quest area, with a dwell before a change takes over.
    const here: Target | undefined =
      scene.quest !== undefined && this.hasPool(scene.quest)
        ? { pool: scene.quest, role: "quest" }
        : scene.zone !== undefined && this.hasPool(scene.zone)
          ? { pool: scene.zone, role: "zone" }
          : undefined;
    if (!this.placed) {
      // Coming into the world (or after the title): no dwell.
      this.placed = true;
      this.place = here;
      this.candidate = undefined;
    } else if (sameTarget(here, this.place)) {
      this.candidate = undefined;
    } else if (!this.candidate || !sameTarget(here, this.candidate.target)) {
      this.candidate = { target: here, since: now };
    } else if (now - this.candidate.since >= this.config.dwellMs) {
      this.place = here;
      this.candidate = undefined;
    }
    // A boss in view, held a while after the last one left it.
    if (scene.boss !== undefined && this.hasPool(scene.boss)) {
      this.boss = scene.boss;
      this.bossSeenAt = now;
    } else if (this.boss !== undefined && now - this.bossSeenAt >= this.config.bossHoldMs) {
      this.boss = undefined;
    }
    if (this.boss !== undefined) return { pool: this.boss, role: "boss" };
    return this.place;
  }

  private hasPool(pool: string): boolean {
    return (this.config.pools[pool]?.length ?? 0) > 0;
  }

  // ---- changes -----------------------------------------------------------------------

  /** A change of place: what starts, from where, over how long. */
  private planChange(now: number, want: Target | undefined): Pending {
    const from = this.current;
    const fades = this.config.fades;
    const fadeMs =
      from?.role === "title" || want?.role === "title"
        ? fades.title
        : want?.role === "boss"
          ? fades.bossIn
          : from?.role === "boss"
            ? fades.bossOut
            : from === undefined && want === undefined
              ? 0
              : fades.zone;
    if (!want) return { target: undefined, sound: undefined, from: 0, fadeMs, next: false };
    const afterBoss = from?.role === "boss" && want.role !== "boss";
    const mem = this.memory.get(want.pool);
    const fresh = mem === undefined || now - mem.at > this.config.resumeMs;
    const track = mem && this.config.tracks[mem.sound];
    if (want.role !== "boss" && mem && !fresh && track?.seconds !== undefined) {
      if (afterBoss) {
        // Back from a boss: the zone's track again, at a fresh entry.
        return {
          target: want,
          sound: mem.sound,
          from: this.entryOf(mem.sound),
          fadeMs,
          next: false,
        };
      }
      if (mem.position < track.end - RESUME_MARGIN_S)
        return { target: want, sound: mem.sound, from: mem.position, fadeMs, next: false };
    }
    const sound = this.takeQueued(want.pool) ?? this.pick(want.pool);
    return {
      target: want,
      sound,
      from: sound === undefined ? 0 : this.entryOf(sound),
      fadeMs,
      next: false,
    };
  }

  /** The current pool's own course: a gap that ends, or a track that reaches its end. */
  private planNext(now: number): void {
    const cur = this.current;
    if (!cur) return;
    if (this.gapUntil !== undefined) {
      if (now >= this.gapUntil) this.queueNext(cur, this.config.fades.next);
      return;
    }
    const lead = this.lead;
    if (!lead || lead.loop) return;
    const track = this.config.tracks[lead.sound];
    if (!track || track.seconds === undefined) return;
    if (cur.role === "title" || cur.role === "boss") {
      // Crossfade into the next before the ending, so the music never stops.
      const startAt = Math.max(0, track.end - this.config.fades.next / 1000);
      if (positionAt(lead, now) >= startAt) this.queueNext(cur, this.config.fades.next);
    }
    // A zone's track plays to its end (dropFinished sees it) and then rests.
  }

  private queueNext(cur: Target, fadeMs: number): void {
    const sound = this.takeQueued(cur.pool) ?? this.pick(cur.pool);
    this.pending = {
      target: cur,
      sound,
      from: sound === undefined ? 0 : this.entryOf(sound),
      fadeMs,
      next: true,
    };
  }

  private apply(now: number, p: Pending): void {
    const old = this.lead;
    if (old && !p.next) this.remember(old, now);
    // The old music fades out over the same span the new one fades in.
    for (const v of this.voiceList) if (v.env.to > 0) this.fadeOut(v, now, p.fadeMs);
    this.gapUntil = undefined;
    this.current = p.target;
    this.lead = undefined;
    if (!p.target || p.sound === undefined) return;
    const track = this.config.tracks[p.sound];
    const voice: Voice = {
      id: this.nextId++,
      sound: p.sound,
      pool: p.target.pool,
      role: p.target.role,
      from: p.from,
      startedAt: now,
      loop: track?.seconds === undefined,
      env: { at: now, ms: p.fadeMs, from: 0, to: 1 },
    };
    this.cutOldest(now);
    this.voiceList.push(voice);
    this.lead = voice;
    this.last.set(p.target.pool, p.sound);
    this.memory.delete(p.target.pool);
    if (!this.queued.has(p.target.pool)) {
      const next = this.pick(p.target.pool);
      if (next !== undefined) this.queued.set(p.target.pool, next);
    }
    this.version++;
  }

  private fadeOut(v: Voice, now: number, ms: number): void {
    v.env = { at: now, ms, from: gainAt(v.env, now), to: 0 };
    this.version++;
  }

  /** Beyond MAX_VOICES, the oldest voices fading out go in CUT_MS. */
  private cutOldest(now: number): void {
    let extra = this.voiceList.length + 1 - MAX_VOICES;
    for (const v of this.voiceList) {
      if (extra <= 0) break;
      if (v.env.to > 0 || v.env.at + v.env.ms <= now + CUT_MS) continue;
      v.env = { at: now, ms: CUT_MS, from: gainAt(v.env, now), to: 0 };
      extra--;
      this.version++;
    }
  }

  private remember(v: Voice, now: number): void {
    this.memory.set(v.pool, { sound: v.sound, position: positionAt(v, now), at: now });
  }

  /** Voices that faded out or played to their end go; a lead that ended starts a gap. */
  private dropFinished(now: number): void {
    const keep: Voice[] = [];
    let leadEnded = false;
    for (const v of this.voiceList) {
      const faded = v.env.to <= 0 && now >= v.env.at + v.env.ms;
      const track = this.config.tracks[v.sound];
      const over = !v.loop && track?.seconds !== undefined && positionAt(v, now) >= track.seconds;
      if (faded || over) {
        if (v === this.lead) leadEnded = true;
        continue;
      }
      keep.push(v);
    }
    if (keep.length !== this.voiceList.length) {
      this.voiceList = keep;
      this.version++;
    }
    if (leadEnded) this.leadEnded(now);
  }

  private leadEnded(now: number): void {
    this.lead = undefined;
    const cur = this.current;
    if (!cur) return;
    if (cur.role === "zone" || cur.role === "quest") {
      const [min, max] = this.config.gapMs;
      this.gapUntil = now + min + this.random() * Math.max(0, max - min);
    } else {
      this.gapUntil = now; // the title's and a boss's go straight on
    }
  }

  // ---- picks -------------------------------------------------------------------------

  private takeQueued(pool: string): string | undefined {
    const sound = this.queued.get(pool);
    this.queued.delete(pool);
    return sound;
  }

  /**
   * The next track of a pool: a shuffled round of all of them, never the one that played
   * last (`last` is set when a track starts, in apply).
   */
  private pick(pool: string): string | undefined {
    const tracks = this.config.pools[pool] ?? [];
    if (tracks.length <= 1) return tracks[0];
    const last = this.last.get(pool);
    let bag = this.bags.get(pool) ?? [];
    let i = bag.findIndex((s) => s !== last);
    if (i < 0) {
      bag = this.shuffled(tracks);
      i = bag.findIndex((s) => s !== last);
    }
    const [sound] = bag.splice(i, 1);
    this.bags.set(pool, bag);
    return sound;
  }

  private shuffled(tracks: readonly string[]): string[] {
    const out = [...tracks];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.floor(this.random() * (i + 1)));
      const a = out[i] as string;
      out[i] = out[j] as string;
      out[j] = a;
    }
    return out;
  }

  /** A random entry of a track, not the one it started from last time; 0 with none. */
  private entryOf(sound: string): number {
    const entries = this.config.tracks[sound]?.entries ?? [];
    if (entries.length === 0) return 0;
    const before = this.lastEntry.get(sound);
    const choices = entries.length > 1 ? entries.filter((e) => e !== before) : entries;
    const at = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))];
    const entry = at ?? entries[0] ?? 0;
    this.lastEntry.set(sound, entry);
    return entry;
  }
}

function sameTarget(a: Target | undefined, b: Target | undefined): boolean {
  return a?.pool === b?.pool;
}
