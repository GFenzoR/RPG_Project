// The sky (livingworld/README.md "Día y noche"): from the world time the server sends
// (WorldClock: the day and how far into the cycle), the light colour over the surface, how
// much the lamps glow, the moon and where the cast shadows point. Pure and free of Pixi: the
// client's glue (client/src/render/sky.ts) reads it every frame and the renderer draws it.
//
// The cycle (data/livingworld/daynight.yaml): the day starts at cycle 0 with dawn and ends
// with dusk; the night follows. The sun rises in the east at the start of the day and sets
// in the west at its end, so a cast shadow points west in the morning, lies short under the
// feet at noon and points east in the afternoon; the moon crosses the night the same way.
// Shadows lie "north" (up the screen) in the 3/4 view: the sun is on the viewer's side.

export type SkyPhase = "dawn" | "day" | "dusk" | "night";

/** data/livingworld/daynight.yaml as the client uses it (times in ms, colours 0xrrggbb). */
export interface DayNightData {
  dayMs: number;
  nightMs: number;
  dawnMs: number;
  duskMs: number;
  lunarDays: number;
  dawn: number;
  day: number;
  dusk: number;
  nightNewMoon: number;
  nightFullMoon: number;
  /** The night never gets darker than this luminance (0..1). */
  floor: number;
  /** Opacity of a cast shadow under a high sun, and under a full moon. */
  sunShadow: number;
  moonShadow: number;
  /** The longest a shadow gets, in heights of its caster. */
  maxShadow: number;
}

/** The owner's cycle (2026-11-23): 180 minutes of day, 60 of night. */
export const DEFAULT_DAY_NIGHT: DayNightData = {
  dayMs: 180 * 60_000,
  nightMs: 60 * 60_000,
  dawnMs: 15 * 60_000,
  duskMs: 15 * 60_000,
  lunarDays: 8,
  dawn: 0xffc9a8,
  day: 0xffffff,
  dusk: 0xffa86e,
  nightNewMoon: 0x58648c,
  nightFullMoon: 0x8494c4,
  floor: 0.5,
  sunShadow: 0.42,
  moonShadow: 0.16,
  maxShadow: 1.4,
};

/** How high the sun climbs at noon (radians): a short shadow, never none. */
export const SUN_TOP = (65 * Math.PI) / 180;
/** The north part of a shadow is foreshortened this much by the 3/4 view. */
export const NORTH_SQUASH = 0.5;
/** A shadow always reaches at least this far north (heights): it lies on the ground. */
export const MIN_NORTH = 0.12;
/** A shadow fades in while its light is lower than this (sine of the arc). */
const RISE = 0.3;

/** Where a cast shadow's tip lies, per unit of its caster's height, and how dark it is. */
export interface ShadowCast {
  /** East (+) or west (-) of the feet. */
  x: number;
  /** North of the feet (up the screen), > 0. */
  y: number;
  alpha: number;
}

export interface Sky {
  phase: SkyPhase;
  /** The light colour multiplied over the surface (0xffffff: none). */
  ambient: number;
  /** How much lamps, fires and windows glow (0 by day, 1 at night). */
  lamps: number;
  /** The moon's light of the current (or the last) night: 0 new, 1 full. */
  moon: number;
  /** Night for the critters (fireflies). */
  night: boolean;
  /** The sun's or the moon's cast shadow (alpha 0: none). */
  shadow: ShadowCast;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const colour = (v: unknown, def: number): number =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? Number.parseInt(v.slice(1), 16) : def;

const numberIn = (v: unknown, lo: number, hi: number, def: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;

/**
 * The client's view of data/livingworld/daynight.yaml (already parsed YAML). Lenient like
 * parseLivingWorldData: make validate checks the schema; anything malformed falls back to
 * DEFAULT_DAY_NIGHT.
 */
export function parseDayNight(raw: unknown): DayNightData {
  const d = DEFAULT_DAY_NIGHT;
  if (!isObj(raw)) return d;
  const c = isObj(raw["cycle"]) ? raw["cycle"] : {};
  const s = isObj(raw["sky"]) ? raw["sky"] : {};
  const min = (v: unknown, def: number): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 60_000 : def;
  const dayMs = Math.max(60_000, min(c["day_minutes"], d.dayMs));
  const out: DayNightData = {
    dayMs,
    nightMs: Math.max(60_000, min(c["night_minutes"], d.nightMs)),
    dawnMs: Math.min(dayMs / 2, min(c["dawn_minutes"], d.dawnMs)),
    duskMs: Math.min(dayMs / 2, min(c["dusk_minutes"], d.duskMs)),
    lunarDays: Math.round(numberIn(c["lunar_days"], 2, 64, d.lunarDays)),
    dawn: colour(s["dawn"], d.dawn),
    day: colour(s["day"], d.day),
    dusk: colour(s["dusk"], d.dusk),
    nightNewMoon: colour(s["night_new_moon"], d.nightNewMoon),
    nightFullMoon: colour(s["night_full_moon"], d.nightFullMoon),
    floor: numberIn(s["floor"], 0.3, 1, d.floor),
    sunShadow: numberIn(s["sun_shadow"], 0, 0.8, d.sunShadow),
    moonShadow: numberIn(s["moon_shadow"], 0, 0.8, d.moonShadow),
    maxShadow: numberIn(s["max_shadow"], 0.2, 4, d.maxShadow),
  };
  return out;
}

/** The cycle's length, ms. */
export const cycleLength = (d: DayNightData): number => d.dayMs + d.nightMs;

/**
 * The world time `elapsedMs` real ms after the server said (day, cycleMs) at `rate`
 * (WorldClock): the client runs the clock on between two syncs.
 */
export function advance(
  d: DayNightData,
  day: number,
  cycleMs: number,
  rate: number,
  elapsedMs: number,
): { day: number; cycleMs: number } {
  const len = cycleLength(d);
  const t = cycleMs + Math.max(0, elapsedMs) * Math.max(0, rate);
  const wraps = Math.floor(t / len);
  return { day: day + wraps, cycleMs: t - wraps * len };
}

/** The moon's light on `day`: 0 at new moon (phase 0), 1 at full (phase lunarDays/2). */
export function moonLight(d: DayNightData, day: number): number {
  const phase = ((day % d.lunarDays) + d.lunarDays) % d.lunarDays;
  return (1 - Math.cos((2 * Math.PI * phase) / d.lunarDays)) / 2;
}

export function phaseAt(d: DayNightData, cycleMs: number): SkyPhase {
  if (cycleMs >= d.dayMs) return "night";
  if (cycleMs < d.dawnMs) return "dawn";
  if (cycleMs >= d.dayMs - d.duskMs) return "dusk";
  return "day";
}

/** Linear mix of two 0xrrggbb colours. */
export function mixColour(a: number, b: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ch = (s: number): number => {
    const x = (a >> s) & 0xff;
    const y = (b >> s) & 0xff;
    return Math.round(x + (y - x) * k);
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Perceived luminance of a colour, 0..1. */
export function luminance(c: number): number {
  return (0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff)) / 255;
}

/** c mixed toward white just enough that its luminance is at least `floor`. */
export function withFloor(c: number, floor: number): number {
  const l = luminance(c);
  if (l >= floor || l >= 1) return c;
  // Mixing toward white raises the luminance linearly: l + (1 - l) * t.
  return mixColour(c, 0xffffff, (floor - l) / (1 - l) + 1e-3);
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The shadow of a light `t` of the way across its arc (0 rising in the east, 1 setting in
 * the west), at most `maxLen` heights long, `strength` dark at its highest.
 */
export function arcShadow(
  t: number,
  maxLen: number,
  strength: number,
  out: ShadowCast,
): ShadowCast {
  const a = Math.PI * Math.min(1, Math.max(0, t));
  const up = Math.sin(a);
  const elevation = SUN_TOP * up;
  const len = Math.min(maxLen, 1 / Math.tan(Math.max(elevation, 1e-3)));
  out.x = -Math.cos(a) * len;
  out.y = Math.max(MIN_NORTH, up * len * NORTH_SQUASH);
  out.alpha = strength * smooth(0, RISE, up);
  return out;
}

/**
 * The Pixi transform that lays an upright sprite (anchored at its feet) on the ground as
 * `s`: skew.x and scale.y (scale.x stays 1). The tip of a sprite of height h lands h * s.x
 * east and h * s.y north of the feet.
 */
export function shadowTransform(s: ShadowCast): { skewX: number; scaleY: number } {
  return { skewX: Math.atan2(-s.x, s.y), scaleY: Math.hypot(s.x, s.y) };
}

/** A new Sky to fill with skyAt. */
export const newSky = (): Sky => ({
  phase: "day",
  ambient: 0xffffff,
  lamps: 0,
  moon: 0,
  night: false,
  shadow: { x: 0, y: MIN_NORTH, alpha: 0 },
});

/** The sky at `cycleMs` of `day`, written into `out` (a frame allocates nothing). */
export function skyAt(d: DayNightData, day: number, cycleMs: number, out: Sky = newSky()): Sky {
  const len = cycleLength(d);
  const pos = ((cycleMs % len) + len) % len;
  const phase = phaseAt(d, pos);
  // A night belongs to the day it fell on: the dawn after it still has that day's moon,
  // so the light never jumps when the cycle wraps.
  const moon = moonLight(d, phase === "dawn" ? day - 1 : day);
  const night = withFloor(mixColour(d.nightNewMoon, d.nightFullMoon, moon), d.floor);
  let ambient = d.day;
  let lamps = 0;
  if (phase === "dawn") {
    const f = pos / d.dawnMs;
    ambient = f < 0.5 ? mixColour(night, d.dawn, f * 2) : mixColour(d.dawn, d.day, f * 2 - 1);
    lamps = 1 - f;
  } else if (phase === "dusk") {
    const f = (pos - (d.dayMs - d.duskMs)) / d.duskMs;
    ambient = f < 0.5 ? mixColour(d.day, d.dusk, f * 2) : mixColour(d.dusk, night, f * 2 - 1);
    lamps = f;
  } else if (phase === "night") {
    ambient = night;
    lamps = 1;
  }
  out.phase = phase;
  out.ambient = withFloor(ambient, d.floor);
  out.lamps = lamps;
  out.moon = moon;
  out.night = phase === "night" || lamps > 0.5;
  if (pos < d.dayMs) arcShadow(pos / d.dayMs, d.maxShadow, d.sunShadow, out.shadow);
  else arcShadow((pos - d.dayMs) / d.nightMs, d.maxShadow, d.moonShadow * moon, out.shadow);
  return out;
}
