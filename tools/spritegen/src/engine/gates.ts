// Quality gates of engine sprites (docs/17 "Motor de sprites"): what a frame must be before
// it ships. Each check is a small pure function over images, so the tests can prove it
// catches what it should on hand-made images, and gateProblems runs them all on a spec.
import type { Image } from "@rpg/spritepack";
import { PALETTE } from "../palette.ts";
import { engineFrames } from "./book.ts";
import { allowedColors, canvasOf, colorKey, toneColor } from "./render.ts";
import { specMaterials, validateSpec } from "./spec.ts";
import type { SpriteSpec } from "./spec.ts";
import { DITHER_MAX_SHARE, GLOW_OUTLINE, OUTLINE, VALUE_BAND } from "./style.ts";
import type { Tone } from "./style.ts";

const TONE_I: Record<Tone, number> = { light: 0, base: 1, shadow: 2, deep: 3, outline: 5 };

const alphaAt = (img: Image, x: number, y: number): number =>
  x < 0 || y < 0 || x >= img.width || y >= img.height
    ? 0
    : (img.data[(y * img.width + x) * 4 + 3] ?? 0);
const keyAt = (img: Image, x: number, y: number): string => {
  const i = (y * img.width + x) * 4;
  return `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
};

/** Alpha other than 0 and 255 (ART-6: partial transparency is the renderer's). */
export function partialAlpha(img: Image): number {
  let n = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    const a = img.data[i] ?? 0;
    if (a !== 0 && a !== 255) n++;
  }
  return n;
}

/** Opaque colours outside `allowed` (palette compliance), and pure black ones (ART-5). */
export function offPalette(img: Image, allowed: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (alphaAt(img, x, y) && (!allowed.has(keyAt(img, x, y)) || keyAt(img, x, y) === "0,0,0"))
        out.add(keyAt(img, x, y));
  return [...out];
}

/**
 * The share of opaque pixels that sit in a checkerboard: unlike each of their four
 * neighbours, which all share one colour (ART-6 allows dithering on at most 10 %).
 */
export function ditherShare(img: Image): number {
  let opaque = 0;
  let checker = 0;
  for (let y = 1; y < img.height - 1; y++)
    for (let x = 1; x < img.width - 1; x++) {
      if (!alphaAt(img, x, y)) continue;
      opaque++;
      const nb = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ] as const;
      if (!nb.every(([a, b]) => alphaAt(img, a, b))) continue;
      const first = keyAt(img, x - 1, y);
      if (first !== keyAt(img, x, y) && nb.every(([a, b]) => keyAt(img, a, b) === first)) checker++;
    }
  return opaque ? checker / opaque : 0;
}

/** Silhouette pixels: opaque with a transparent (or off-canvas) 4-neighbour. */
function rim(img: Image): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (
        alphaAt(img, x, y) &&
        (!alphaAt(img, x - 1, y) ||
          !alphaAt(img, x + 1, y) ||
          !alphaAt(img, x, y - 1) ||
          !alphaAt(img, x, y + 1))
      )
        out.push([x, y]);
  return out;
}

/** The share of silhouette pixels drawn in one of the outline colours (ART-5). */
export function outlineCoverage(img: Image, outline: ReadonlySet<string>): number {
  const r = rim(img);
  if (r.length === 0) return 0;
  return r.filter(([x, y]) => outline.has(keyAt(img, x, y))).length / r.length;
}

/** Sizes of the 8-connected opaque components, largest first. */
export function components(img: Image): number[] {
  const seen = new Uint8Array(img.width * img.height);
  const sizes: number[] = [];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (!alphaAt(img, x, y) || seen[y * img.width + x]) continue;
      let n = 0;
      const stack: [number, number][] = [[x, y]];
      seen[y * img.width + x] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop() ?? [0, 0];
        n++;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (!alphaAt(img, nx, ny) || seen[ny * img.width + nx]) continue;
            seen[ny * img.width + nx] = 1;
            stack.push([nx, ny]);
          }
      }
      sizes.push(n);
    }
  return sizes.sort((a, b) => b - a);
}

/** The opaque box: [x0, y0, x1, y1] inclusive, or undefined when empty. */
export function box(img: Image): [number, number, number, number] | undefined {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (alphaAt(img, x, y)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? undefined : [x0, y0, x1, y1];
}

/** Intersection over union of two silhouettes (1 = the same shape). */
export function silhouetteIoU(a: Image, b: Image): number {
  let inter = 0;
  let union = 0;
  for (let i = 3; i < a.data.length; i += 4) {
    const p = (a.data[i] ?? 0) !== 0;
    const q = (b.data[i] ?? 0) !== 0;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union ? inter / union : 1;
}

/** CIELAB L* of an sRGB colour. */
export function lstar(r: number, g: number, b: number): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** Mean L* of the opaque pixels. */
export function meanL(img: Image): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (!img.data[i + 3]) continue;
    sum += lstar(img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0);
    n++;
  }
  return n ? sum / n : 0;
}

/** The colours that count as outline for a spec: its policy's tones of every material. */
export function outlineColors(spec: SpriteSpec): Set<string> {
  const { size } = canvasOf(spec);
  const out = new Set<string>();
  for (const name of specMaterials(spec)) {
    const m = PALETTE[name];
    for (const pol of [OUTLINE[size.kind], OUTLINE.object, GLOW_OUTLINE])
      for (const t of [pol.lit, pol.dark]) out.add(colorKey(toneColor(m, TONE_I[t])));
  }
  return out;
}

/** Thresholds of the gates (docs/17 "Motor de sprites"). */
export const GATES = {
  /** ART-5: at least this share of the silhouette is outline. */
  outlineCoverage: 0.85,
  /** One figure: loose bits of at most this many pixels are allowed (a spark and its outline). */
  looseBit: 10,
  /** At least this share of the bounding box is filled (not a wireframe of 1 px limbs). */
  fill: 0.2,
  /** Walk frames are not all the same silhouette (the legs move). */
  walkMaxIoU: 0.99,
  /** An attack's strongest frame and the standing one differ this much at least. */
  attackMaxIoU: 0.9,
  /** A death's last frame and the standing one. */
  deathMaxIoU: 0.75,
  /** Facing south and facing west are told apart by the silhouette alone. */
  facingMaxIoU: 0.85,
  /**
   * Seen from the front or the back, a creature is at least this share of its profile's
   * length wide: a profile turned to the camera reads as a thin stripe at 1x (the review of
   * the engine boar, 2026-11-18: 16 px from the front against 38 of profile; it ships 22).
   */
  frontWidth: 0.45,
  /** bc sprites: the figure seen from the front or the back is centred within this. */
  centre: 2,
  /** Extra rows a hovering (flying) sprite may keep under its lowest point. */
  hover: 4,
} as const;

/** Every gate on every frame of a spec; problems as "<frame>: <what>" lines. */
export function gateProblems(spec: SpriteSpec): string[] {
  const out = validateSpec(spec);
  if (out.length) return out;
  const { w, h, size } = canvasOf(spec);
  const frames = engineFrames(spec);
  const allowed = allowedColors(spec);
  const outline = outlineColors(spec);
  for (const f of frames) {
    const img = f.image;
    const bad = (msg: string): void => {
      out.push(`${f.path}: ${msg}`);
    };
    if (img.width !== w || img.height !== h) bad(`is ${img.width}x${img.height}, not ${w}x${h}`);
    if (partialAlpha(img)) bad("has alpha other than 0 and 255");
    const off = offPalette(img, allowed);
    if (off.length) bad(`colours outside its palette.ts materials: ${off.slice(0, 4).join(" ")}`);
    const dither = ditherShare(img);
    if (dither > DITHER_MAX_SHARE)
      bad(`${(dither * 100).toFixed(1)} % checkerboard pixels (ART-6)`);
    const b = box(img);
    if (!b) {
      bad("is empty");
      continue;
    }
    if (b[0] === 0 || b[1] === 0 || b[2] === w - 1 || b[3] === h - 1)
      bad("touches the canvas edge (clipped)");
    const cov = outlineCoverage(img, outline);
    if (cov < GATES.outlineCoverage)
      bad(`outline covers ${(cov * 100).toFixed(0)} % of the silhouette`);
    const parts = components(img);
    const loose = parts.slice(1).filter((n) => n > GATES.looseBit);
    if (loose.length)
      bad(`${loose.length} loose pieces apart from the figure (sizes ${loose.join(", ")})`);
    const opaque = parts.reduce((a, n) => a + n, 0);
    const fill = opaque / ((b[2] - b[0] + 1) * (b[3] - b[1] + 1));
    if (fill < GATES.fill) bad(`fills ${(fill * 100).toFixed(0)} % of its box: too thin to read`);
    const l = meanL(img);
    const [lo, hi] = VALUE_BAND[size.kind];
    if (l < lo || l > hi)
      bad(`mean L* ${l.toFixed(1)} outside the ${size.kind} band ${lo}-${hi} (ART-6)`);
  }

  // Size and anchor (ART-2): on the walk frames (creatures) or the image (objects). Height and
  // length are profile measures (the ART-2 notes give them for the side view), so they are
  // taken facing west and east; facing south and north the figure must be centred.
  const stand = frames.filter((f) => !f.ref || f.ref.action === "walk");
  const range = (
    name: string,
    v: number,
    r: readonly [number, number] | undefined,
    at: string,
  ): void => {
    if (r && (v < r[0] || v > r[1]))
      out.push(`${at}: figure ${name} ${v} px, outside ${r[0]}-${r[1]} (ART-2)`);
  };
  const classSize = size as {
    height?: readonly [number, number];
    width?: readonly [number, number];
  };
  for (const f of stand) {
    const b = box(f.image);
    if (!b) continue;
    const side = !f.ref || f.ref.dir === "w" || f.ref.dir === "e";
    if (side) {
      range("height", b[3] - b[1] + 1, spec.figure?.height ?? classSize.height, f.path);
      range("width", b[2] - b[0] + 1, spec.figure?.width ?? classSize.width, f.path);
    }
    if (size.anchor === "bc") {
      // A hovering sprite may lift its lowest point (a flame's tip) a little more.
      const most = size.ground + (spec.flying ? GATES.hover : 0);
      const foot = h - 1 - b[3];
      if (foot < 1 || foot > most)
        out.push(`${f.path}: ${foot} rows under the feet, want 1-${most}`);
      if (!side) {
        const off = (b[0] + b[2] + 1) / 2 - w / 2;
        if (Math.abs(off) > GATES.centre) out.push(`${f.path}: ${off} px off centre (bc anchor)`);
      }
    } else if (b[3] < h - 32) out.push(`${f.path}: does not stand on its tile (br anchor)`);
  }

  // Readability at 1x: the actions and the facings are told apart by their silhouettes.
  const get = (action: string, dir: string, n: number): Image | undefined =>
    frames.find((f) => f.ref?.action === action && f.ref.dir === dir && f.ref.frame === n)?.image;
  if (spec.actions) {
    for (const dir of ["s", "w", "n", "e"] as const) {
      const walk = frames
        .filter((f) => f.ref?.action === "walk" && f.ref.dir === dir)
        .map((f) => f.image);
      if (
        walk.length > 1 &&
        walk.every((img) => silhouetteIoU(img, walk[0] ?? img) > GATES.walkMaxIoU)
      )
        out.push(`${spec.sprite}: walk ${dir} frames all have the same silhouette`);
      const rest = get("walk", dir, 0);
      if (!rest) continue;
      const attack = spec.actions.attack;
      if (attack) {
        let min = 1;
        for (let n = 0; n < attack.frames; n++) {
          const a = get("attack", dir, n);
          if (a) min = Math.min(min, silhouetteIoU(a, rest));
        }
        if (min > GATES.attackMaxIoU)
          out.push(
            `${spec.sprite}: attack ${dir} barely moves (IoU ${min.toFixed(2)} with standing)`,
          );
      }
      const death = spec.actions.death;
      const last = death ? get("death", dir, death.frames - 1) : undefined;
      if (last && silhouetteIoU(last, rest) > GATES.deathMaxIoU)
        out.push(`${spec.sprite}: death ${dir} ends too close to standing`);
    }
    const s = get("walk", "s", 0);
    const wv = get("walk", "w", 0);
    if (s && wv && silhouetteIoU(s, wv) > GATES.facingMaxIoU)
      out.push(`${spec.sprite}: facing south and west look the same`);
    const widths = (dirs: readonly string[]): number[] =>
      frames
        .filter((f) => f.ref?.action === "walk" && dirs.includes(f.ref.dir))
        .map((f) => box(f.image))
        .filter((b) => b !== undefined)
        .map((b) => b[2] - b[0] + 1);
    const front = Math.min(...widths(["s", "n"]));
    const profile = Math.max(...widths(["w", "e"]));
    if (Number.isFinite(front) && Number.isFinite(profile) && front < GATES.frontWidth * profile)
      out.push(
        `${spec.sprite}: ${front} px wide from the front or the back against a ${profile} px ` +
          `profile: under ${Math.round(GATES.frontWidth * 100)} %, a stripe at 1x`,
      );
  }
  return out;
}
