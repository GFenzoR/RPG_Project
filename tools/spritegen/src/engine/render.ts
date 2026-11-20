// The engine's renderer: one frame of a spec into a sprite. A tiny orthographic ray caster
// for the 3/4 camera of style.ts (one ray per pixel centre, a depth buffer, no
// anti-aliasing), then the pixel-art passes:
//   1. shading: the part's normal against the light picks one of the four shades of its
//      palette.ts material (plus the glint on shiny parts; fire glows instead), with the
//      depth cue and the part's texture noise (in its own frame, so it never boils);
//   2. cleanup: a lone pixel inside a patch of one shade takes that shade (ART-6: no dither);
//   3. creases: where a part overlaps a farther one, the farther one gets a dark line;
//   4. marks: single pixels (eyes, nostrils, berries) where they are visible;
//   5. outline: 1 px around the silhouette, dark on the shadow side and lighter on the lit
//      side, by the size class's policy (ART-5), or fire's own (GLOW_OUTLINE).
// Everything is opaque or transparent, and the same spec and seed give the same pixels.
import { createImage } from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import { seedOf } from "../draw.ts";
import { lighten, PALETTE } from "../palette.ts";
import type { Material, MaterialName } from "../palette.ts";
import { add, apply, applyT, dot, scale, toLocal, toWorld } from "./math.ts";
import type { Vec3 } from "./math.ts";
import { frameTime, partTransforms, poseAt, REST } from "./rig.ts";
import { intersect, shapeBounds } from "./shapes.ts";
import type { SpriteSpec } from "./spec.ts";
import {
  ACTIONS,
  CREASE_DEPTH,
  GLOW,
  GLOW_OUTLINE,
  LIGHT,
  OUTLINE,
  PROJECTION,
  RIM_LIGHT,
  SHADES,
  SIZES,
  VIEW_DIR,
} from "./style.ts";
import type { ActionName, Dir, SizeClass, Tone } from "./style.ts";

/** Tone indices in the per-pixel buffer. */
const LIGHT_T = 0;
const BASE_T = 1;
const SHADOW_T = 2;
const DEEP_T = 3;
const GLINT_T = 4;
const OUTLINE_T = 5;
const TONE_INDEX: Record<Tone | "glint", number> = {
  light: LIGHT_T,
  base: BASE_T,
  shadow: SHADOW_T,
  deep: DEEP_T,
  glint: GLINT_T,
  outline: OUTLINE_T,
};

/** What a part does in a frame of a paper-doll layer (spec.layer). */
const SKIP = 0;
const DRAW = 1;
const OCCLUDE = 2;

/** How far behind the surface a mark may be and still show (px of view depth). */
const MARK_TOLERANCE = 1.5;
/** Rays start this far south of the model (any point south of every part works). */
const RAY_START_Y = -200;

/** Which frame to render: an action, a facing and a frame number (creatures only). */
export interface FrameRef {
  action: ActionName;
  dir: Dir;
  frame: number;
}

/** Which frame of an animated prop's loop to render (objects with `loop`, ART-7). */
export interface LoopRef {
  loop: number;
}

/** The canvas size and the size class of a spec. */
export function canvasOf(spec: SpriteSpec): { w: number; h: number; size: SizeClass } {
  const size: SizeClass = SIZES[spec.size];
  const [w, h] = spec.canvas ?? size.canvases[0] ?? [32, 32];
  return { w, h, size };
}

/** The colour of a shade of a material: tone index to RGBA. */
export function toneColor(m: Material, tone: number): Rgba {
  switch (tone) {
    case LIGHT_T:
      return m.light;
    case BASE_T:
      return m.base;
    case SHADOW_T:
      return m.shadow;
    case DEEP_T:
      return m.deep;
    case GLINT_T:
      return glintOf(m);
    default:
      return m.outline;
  }
}

/** The glint of a shiny material: its light shade lightened (ART-5 "plus a highlight"). */
export const glintOf = (m: Material): Rgba => lighten(m.light, SHADES.glint.lighten);

/** Every colour a spec may put in a sprite: its materials' shades, outlines and glints. */
export function allowedColors(spec: SpriteSpec): Set<string> {
  const out = new Set<string>();
  const used = new Set<MaterialName>();
  for (const p of spec.parts) {
    used.add(p.material);
    for (const s of p.shapes) if (s.material) used.add(s.material);
    for (const m of p.marks ?? []) if (m.material) used.add(m.material);
  }
  for (const name of used) {
    const m = PALETTE[name];
    for (let t = LIGHT_T; t <= OUTLINE_T; t++) out.add(colorKey(toneColor(m, t)));
  }
  return out;
}

export const colorKey = (c: readonly number[]): string => `${c[0]},${c[1]},${c[2]}`;

/** 3D value noise in [0, 1): smooth between hashed lattice points. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const sx = smooth(x - xi);
  const sy = smooth(y - yi);
  const sz = smooth(z - zi);
  const h = (a: number, b: number, c: number): number => hash3(xi + a, yi + b, zi + c, seed);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), sx), l(h(0, 1, 0), h(1, 1, 0), sx), sy),
    l(l(h(0, 0, 1), h(1, 0, 1), sx), l(h(0, 1, 1), h(1, 1, 1), sx), sy),
    sz,
  );
}
const smooth = (t: number): number => t * t * (3 - 2 * t);
function hash3(x: number, y: number, z: number, seed: number): number {
  let h =
    (Math.imul(x | 0, 0x27d4eb2d) ^
      Math.imul(y | 0, 0x165667b1) ^
      Math.imul(z | 0, 0x1b873593) ^
      seed) >>>
    0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Renders one frame of a spec: a creature's action, facing and frame, or an object (no
 * `ref`). `seed` drives the texture noise; by default it comes from the sprite path, so
 * every frame of a sprite shares it and its texture stays put while it moves.
 */
export function renderSpec(
  spec: SpriteSpec,
  ref?: FrameRef | LoopRef,
  seed = seedOf(spec.sprite),
): Image {
  const { w, h, size } = canvasOf(spec);
  const ox = size.anchor === "bc" ? w / 2 : w - 16;
  const oy = h - size.ground;
  const k = PROJECTION.depth;
  const D = VIEW_DIR;
  const V = scale(D, -1);
  const L = LIGHT.dir;

  let pose = REST;
  let dir: Dir | undefined;
  if (ref && "loop" in ref) {
    const l = spec.loop;
    if (!l) throw new Error(`${spec.sprite}: no loop`);
    pose = poseAt(l, ref.loop / l.frames, true);
  } else if (ref) {
    const a = spec.actions?.[ref.action];
    if (!a) throw new Error(`${spec.sprite}: no ${ref.action} action`);
    pose = poseAt(a, frameTime(ref.action, ref.frame, a.frames), ACTIONS[ref.action].loop);
    dir = ref.dir;
  }
  const transforms = partTransforms(spec, pose, dir);
  // A paper-doll layer (spec.layer): its own parts give pixels (DRAW); the occluders are cast
  // and hide what is behind them but stay transparent (OCCLUDE); the rest is left out.
  const drawn = spec.layer ? new Set(spec.layer.draw) : undefined;
  const hiders = spec.layer?.occlude ? new Set(spec.layer.occlude) : undefined;
  const role = spec.parts.map((p) =>
    !drawn || drawn.has(p.name) ? DRAW : !hiders || hiders.has(p.name) ? OCCLUDE : SKIP,
  );

  const n = w * h;
  const depth = new Float64Array(n).fill(Infinity);
  const partOf = new Int16Array(n).fill(-1);
  const shapeOf = new Int16Array(n).fill(-1);
  const normal = new Float32Array(n * 3);
  const localP = new Float32Array(n * 3);
  const project = (p: Vec3): [number, number] => [ox + p[0], oy - (p[2] + k * p[1])];

  // 1. Cast: the nearest surface of every part's shapes at each pixel.
  spec.parts.forEach((part, pi) => {
    const t = transforms[pi];
    if (!t || role[pi] === SKIP) return;
    const dLocal = applyT(t.rot, D);
    part.shapes.forEach((shape, si) => {
      const [lo, hi] = shapeBounds(shape);
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (let c = 0; c < 8; c++) {
        const corner: Vec3 = [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]];
        const [u, v] = project(toWorld(t, corner));
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      const xa = Math.max(0, Math.floor(u0) - 1);
      const xb = Math.min(w - 1, Math.ceil(u1) + 1);
      const ya = Math.max(0, Math.floor(v0) - 1);
      const yb = Math.min(h - 1, Math.ceil(v1) + 1);
      for (let y = ya; y <= yb; y++) {
        const z0 = oy - (y + 0.5) - k * RAY_START_Y;
        for (let x = xa; x <= xb; x++) {
          const o: Vec3 = [x + 0.5 - ox, RAY_START_Y, z0];
          const hit = intersect(shape, toLocal(t, o), dLocal);
          if (!hit) continue;
          const p = add(o, scale(D, hit.t));
          const dd = dot(p, D);
          const i = y * w + x;
          if (dd >= (depth[i] ?? Infinity)) continue;
          depth[i] = dd;
          partOf[i] = pi;
          shapeOf[i] = si;
          const nw = apply(t.rot, hit.n);
          normal.set(nw, i * 3);
          localP.set(toLocal(t, p), i * 3);
        }
      }
    });
  });

  // 2. Shade. A layer's depth cue spans its occluders (the body), so every layer of a
  // figure shades its depth like the body it is drawn on.
  const occ = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (role[partOf[i] ?? -1] === OCCLUDE) occ[i] = 1;
  const cueFromOccluders = occ.some((v) => v === 1);
  let dMin = Infinity;
  let dMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if ((partOf[i] ?? -1) < 0 || (cueFromOccluders && !occ[i])) continue;
    const d = depth[i] ?? 0;
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }
  const dSpan = Math.max(1, dMax - dMin);
  const tone = new Int8Array(n).fill(-1);
  const mat: (Material | undefined)[] = new Array<Material | undefined>(n);
  const fixed = new Uint8Array(n); // marks and glints: left alone by the cleanup
  for (let i = 0; i < n; i++) {
    const pi = partOf[i] ?? -1;
    if (pi < 0 || occ[i]) continue;
    const part = spec.parts[pi];
    const shape = part?.shapes[shapeOf[i] ?? 0];
    if (!part || !shape) continue;
    const m = PALETTE[shape.material ?? part.material];
    const nv: Vec3 = [normal[i * 3] ?? 0, normal[i * 3 + 1] ?? 0, normal[i * 3 + 2] ?? 1];
    let level: number;
    if (part.glow) level = GLOW.rim + (GLOW.core - GLOW.rim) * Math.max(0, dot(nv, V));
    else
      level =
        (dot(nv, L) + LIGHT.wrap) / LIGHT.span -
        (LIGHT.depthCue * ((depth[i] ?? 0) - dMin)) / dSpan;
    level += (part.bias ?? 0) + (shape.bias ?? 0);
    if (part.texture) {
      const c = part.texture.cell;
      const q: Vec3 = [localP[i * 3] ?? 0, localP[i * 3 + 1] ?? 0, localP[i * 3 + 2] ?? 0];
      level +=
        part.texture.amount *
        2 *
        (noise3(q[0] / c[0], q[1] / c[1], q[2] / c[2], seed + pi * 7919) - 0.5);
    }
    let t =
      level >= SHADES.light
        ? LIGHT_T
        : level >= SHADES.base
          ? BASE_T
          : level >= SHADES.shadow
            ? SHADOW_T
            : DEEP_T;
    if (part.shiny) {
      const nl = dot(nv, L);
      const r: Vec3 = [2 * nl * nv[0] - L[0], 2 * nl * nv[1] - L[1], 2 * nl * nv[2] - L[2]];
      if (dot(r, V) > SHADES.glint.above) {
        t = GLINT_T;
        fixed[i] = 1;
      }
    }
    tone[i] = t;
    mat[i] = m;
  }

  // 3. Cleanup: a pixel whose four neighbours share another shade of the same material.
  const cleaned = Int8Array.from(tone);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if ((tone[i] ?? -1) < 0 || fixed[i]) continue;
      const nb = [i - 1, i + 1, i - w, i + w];
      const first = tone[nb[0] ?? 0] ?? -1;
      if (first < 0 || first === tone[i]) continue;
      if (nb.every((j) => tone[j] === first && mat[j] === mat[i] && !fixed[j])) cleaned[i] = first;
    }
  tone.set(cleaned);

  // 4. Creases: the farther of two overlapping parts gets a dark line along the nearer one.
  const policy = OUTLINE[size.kind];
  const glowCreaseT = TONE_INDEX[GLOW_OUTLINE.crease];
  const creased = Int8Array.from(tone);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const pi = partOf[i] ?? -1;
      if (pi < 0 || occ[i] || fixed[i]) continue;
      const creaseT = spec.parts[pi]?.glow ? glowCreaseT : TONE_INDEX[policy.crease];
      const di = depth[i] ?? 0;
      const near = (j: number, ok: boolean): boolean => {
        if (!ok) return false;
        const pj = partOf[j] ?? -1;
        // A layer's edge against what it is drawn over (a hem on the legs, a hairline on
        // the forehead) is a crease at any depth: the layer gets the line, not the body.
        return pj >= 0 && pj !== pi && (occ[j] === 1 || di - (depth[j] ?? 0) > CREASE_DEPTH);
      };
      if (
        near(i - 1, x > 0) ||
        near(i + 1, x < w - 1) ||
        near(i - w, y > 0) ||
        near(i + w, y < h - 1)
      )
        if ((tone[i] ?? 0) < creaseT) creased[i] = creaseT;
    }
  tone.set(creased);

  // 4b. The lit rim: one shade lighter where nothing is above or to the left.
  if (RIM_LIGHT > 0) {
    const rimmed = Int8Array.from(tone);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = tone[i] ?? -1;
        if (t <= LIGHT_T || t > DEEP_T || fixed[i] || spec.parts[partOf[i] ?? -1]?.glow) continue;
        const open = (j: number, ok: boolean): boolean => !ok || ((tone[j] ?? -1) < 0 && !occ[j]);
        if (open(i - 1, x > 0) || open(i - w, y > 0)) rimmed[i] = Math.max(LIGHT_T, t - RIM_LIGHT);
      }
    tone.set(rimmed);
  }

  // 5. Marks.
  spec.parts.forEach((part, pi) => {
    const t = transforms[pi];
    if (!t || role[pi] !== DRAW) return;
    for (const mk of part.marks ?? []) {
      const p = toWorld(t, mk.at);
      const [u, v] = project(p);
      const x = Math.floor(u);
      const y = Math.floor(v);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      const md = dot(p, D);
      if ((partOf[i] ?? -1) >= 0 && (depth[i] ?? 0) < md - MARK_TOLERANCE) continue;
      if ((partOf[i] ?? -1) < 0) {
        partOf[i] = pi;
        depth[i] = md;
      }
      tone[i] = TONE_INDEX[mk.tone ?? "deep"];
      mat[i] = PALETTE[mk.material ?? part.material];
      fixed[i] = 1;
      occ[i] = 0;
    }
  });

  // 6. Outline, outside the silhouette.
  const img = createImage(w, h);
  const put = (i: number, c: Rgba): void => {
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  };
  for (let i = 0; i < n; i++) {
    const m = mat[i];
    const t = tone[i] ?? -1;
    if (m && t >= 0) put(i, toneColor(m, t));
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((tone[i] ?? -1) >= 0 || occ[i]) continue;
      // Shadow side first: the figure is to the left of or above this pixel.
      const sides: [number, boolean, boolean][] = [
        [i - 1, x > 0, true],
        [i - w, y > 0, true],
        [i + 1, x < w - 1, false],
        [i + w, y < h - 1, false],
      ];
      for (const [j, ok, dark] of sides) {
        if (!ok || (tone[j] ?? -1) < 0) continue;
        const m = mat[j];
        if (!m) continue;
        const glow = spec.parts[partOf[j] ?? -1]?.glow ?? false;
        const pol = glow ? GLOW_OUTLINE : policy;
        put(i, toneColor(m, TONE_INDEX[dark ? pol.dark : pol.lit]));
        break;
      }
    }
  return img;
}
