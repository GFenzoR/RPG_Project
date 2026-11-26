// The shadows lamps, torches and fires cast (livingworld/README.md "Sombras de las luces",
// data/livingworld/shadows.yaml `lights`). Owner (2026-11-26): inside a building, in a cave
// and by a lamp at night a shadow follows the nearest light, not the sun, and it has to be
// dynamic. Pure and free of Pixi: where the shadow of a caster goes and how strong it is,
// from the lights around it. The canvas lays the sprites (client/src/render/light-shadows.ts).
//
// A light reaches `reach` times the radius of its glow. Inside that, the shadow points away
// from the light, short at its foot and long at the edge, and fades out over the last
// `fade` of the reach. Between lights it blends the two nearest, each weighed by how much
// nearer it is than the third: the weight of a light is zero at the moment it trades places
// with the next one, so a shadow never jumps while its caster walks among lamps.

/** data/livingworld/shadows.yaml `lights`. */
export interface LightShadowRules {
  /** A light casts shadows this many times its glow's radius away. */
  reach: number;
  /** Opacity of the shadows a light casts (the layer's, like sun_shadow of daynight.yaml). */
  alpha: number;
  /** Length at the light's foot and at the edge of its reach, in heights of the caster. */
  minLength: number;
  maxLength: number;
  /** The last share of the reach over which the shadow fades away, 0..1. */
  fade: number;
  /** How much the shadows breathe with the flame, share of alpha (0: still). */
  breathe: number;
  /**
   * What is left of the contact ellipse where nothing casts a shadow at all (no sun, no
   * moon, no light), share of its full strength: much fainter than a cast shadow.
   */
  unlitContact: number;
}

export const DEFAULT_LIGHT_SHADOWS: LightShadowRules = {
  reach: 1.6,
  alpha: 0.34,
  minLength: 0.35,
  maxLength: 1.3,
  fade: 0.35,
  breathe: 0.06,
  unlitContact: 0.4,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The `lights` entry of shadows.yaml (parsed YAML); undefined without it. Lenient: clamps. */
export function parseLightShadows(raw: unknown): LightShadowRules | undefined {
  if (!isObj(raw)) return undefined;
  const d = DEFAULT_LIGHT_SHADOWS;
  const num = (key: string, def: number, min: number, max: number): number => {
    const v = raw[key];
    return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
  };
  const minLength = num("min_length", d.minLength, 0, 3);
  return {
    reach: num("reach", d.reach, 0.5, 4),
    alpha: num("alpha", d.alpha, 0, 1),
    minLength,
    maxLength: Math.max(minLength, num("max_length", d.maxLength, 0, 3)),
    fade: num("fade", d.fade, 0.05, 1),
    breathe: num("breathe", d.breathe, 0, 0.5),
    unlitContact: num("unlit_contact", d.unlitContact, 0, 1),
  };
}

/** Numbers per light in the flat list lightCast reads: x, y (tiles), glow radius, side. */
export const LIGHT_STRIDE = 4;
/** A light's side: under the sky, under a roof, or on the wall between (it lights both). */
export const SIDE_OUT = 0;
export const SIDE_IN = 1;
export const SIDE_BOTH = 2;
/** Nearer than this to a light, tiles, the shadow shrinks to nothing under the caster. */
const FOOT_TILES = 0.75;

/** The shadow of one caster. */
export interface LightCast {
  /**
   * Where the tip of a caster one px high lands: px east (+) and px north (+) of its base
   * (the same vector as the sun's, sky.ts ShadowCast).
   */
  x: number;
  y: number;
  /** 0..1 of the lights' alpha: 1 near a light, fading to 0 at the edge of its reach. */
  strength: number;
}

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * The shadow the lights cast for a caster standing at (cx, cy), in tiles (its tile's centre:
 * a light of tile (x, y) is at the same (x, y)), written into `out`. `lights`: LIGHT_STRIDE
 * numbers each; `side`: where the caster is (SIDE_OUT, SIDE_IN): a lamp in the street casts
 * nothing inside a house, nor a hearth outside. False (and strength 0) when no light
 * reaches it. Allocates nothing.
 */
export function lightCast(
  rules: LightShadowRules,
  lights: ArrayLike<number>,
  cx: number,
  cy: number,
  side: number,
  out: LightCast,
): boolean {
  // The three nearest by nearness (1 at the light, 0 at the edge of its reach).
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let i1 = -1;
  let i2 = -1;
  for (let i = 0; i + LIGHT_STRIDE <= lights.length; i += LIGHT_STRIDE) {
    const s = lights[i + 3] as number;
    if (s !== SIDE_BOTH && s !== side) continue;
    const reach = (lights[i + 2] as number) * rules.reach;
    if (!(reach > 0)) continue;
    const dx = cx - (lights[i] as number);
    const dy = cy - (lights[i + 1] as number);
    const n = 1 - Math.hypot(dx, dy) / reach;
    if (n <= 0) continue;
    if (n > n1) {
      n3 = n2;
      n2 = n1;
      i2 = i1;
      n1 = n;
      i1 = i;
    } else if (n > n2) {
      n3 = n2;
      n2 = n;
      i2 = i;
    } else if (n > n3) n3 = n;
  }
  out.x = 0;
  out.y = 0;
  out.strength = 0;
  if (i1 < 0) return false;
  const a1 = n1 - n3;
  const a2 = i2 < 0 ? 0 : n2 - n3;
  // Shares of the two nearest, over their plain nearness: where three lights are equally
  // near they all cancel and the shadow gathers under the caster, without a jump.
  const total = n1 + n2;
  add(rules, lights, i1, cx, cy, n1, a1 / total, out);
  if (a2 > 0) add(rules, lights, i2, cx, cy, n2, a2 / total, out);
  out.strength = smooth(n1 / rules.fade);
  return out.strength > 0;
}

/** Adds light `i`'s share `w` of the cast vector: away from it, longer the farther. */
function add(
  rules: LightShadowRules,
  lights: ArrayLike<number>,
  i: number,
  cx: number,
  cy: number,
  nearness: number,
  w: number,
  out: LightCast,
): void {
  const dx = cx - (lights[i] as number);
  const dy = cy - (lights[i + 1] as number);
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return;
  const length = rules.minLength + (rules.maxLength - rules.minLength) * (1 - nearness);
  const k = (w * length * Math.min(1, d / FOOT_TILES)) / d;
  out.x += dx * k;
  // The map's y grows to the south; the cast's to the north.
  out.y -= dy * k;
}

/**
 * How much the lights' shadows breathe at `nowMs`: a factor around 1 for their alpha, slow
 * and never regular (two sines out of step). 1 with `breathe` 0.
 */
export function lightBreath(rules: LightShadowRules, nowMs: number): number {
  if (!(rules.breathe > 0)) return 1;
  const t = nowMs / 1000;
  return 1 + rules.breathe * (0.6 * Math.sin(t * 5.3) + 0.4 * Math.sin(t * 8.9 + 1.7));
}
