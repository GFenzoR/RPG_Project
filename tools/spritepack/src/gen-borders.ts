// Generates the original art for the autoborder pieces of data/borders.yaml:
// assets/sprites/borders/<rule>_<piece>.png. Each piece is the `from` ground (its own art from
// tools/spritegen, its pack texture, or its placeholder colour) over a transparent tile, shaped
// by where the `from` ground is, with an irregular edge (never straight, docs/17 ART-4) and a
// slightly darker rim; where the other ground is water, surf runs along the edge on the
// water's side: a bright line of foam at the edge and a broken line further out that rolls in
// over SURF_FRAMES frames (<piece>/frame_<n>, played in step by the renderer, docs/17 ART-7). Deterministic: same input, same bytes. Re-run it when a ground's sprite changes
// (its recipe in tools/spritegen, or its entry in assets/sprites.yaml).
//   node --experimental-strip-types tools/spritepack/src/gen-borders.ts [--root DIR]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { createImage, decodePng, encodePng } from "./image.ts";
import type { Image, Rgba } from "./image.ts";
import { parseManifest } from "./manifest.ts";
import type { SpriteEntry } from "./manifest.ts";

const T = 32;
const DEPTH = 9; // how far the `from` ground reaches into the tile, in pixels

type Piece =
  "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | `inner_${"ne" | "nw" | "se" | "sw"}`;

/**
 * Distance of the edge from the side, at position t along it: three waves that all repeat
 * every tile, so the edge runs on from one tile to the next. Never more than a pixel from one
 * column to the next: a shore that rolls, not a saw.
 */
export const wave = (t: number): number =>
  DEPTH +
  Math.round(
    Math.sin((t / T) * Math.PI * 2) +
      Math.sin((t / T) * Math.PI * 4 + 1.3) +
      0.6 * Math.sin((t / T) * Math.PI * 6 + 0.4),
  );

/** Whether pixel (x, y) of the tile is covered by the `from` ground for this piece. */
export function covered(piece: Piece, x: number, y: number): boolean {
  const side = (s: string): boolean => {
    if (s === "n") return y < wave(x);
    if (s === "s") return T - 1 - y < wave(x);
    if (s === "w") return x < wave(y);
    return T - 1 - x < wave(y); // e
  };
  if (piece.length === 1) return side(piece);
  if (piece.startsWith("inner_")) {
    const [a, b] = [...piece.slice(6)] as [string, string];
    return side(a) || side(b);
  }
  // Diagonal corner: a quarter disc around the corner.
  const cx = piece.includes("e") ? T - 1 : 0;
  const cy = piece.includes("s") ? T - 1 : 0;
  return Math.hypot(x - cx, y - cy) < DEPTH + 2;
}

/** The colour of the ground at pixel (x, y) of a tile. */
export type Fill = (x: number, y: number) => Rgba;

/** Foam along a shore: the bright line right at the edge, and the fainter surf further out. */
export const FOAM: readonly Rgba[] = [
  [168, 198, 210, 255],
  [92, 132, 156, 255],
];

/**
 * The surf, frame by frame: how far out (px from the edge) its broken line runs, or 0 for the
 * wash, when the wave has reached the shore and the faint foam lies solid by the bright line.
 * Frame 0 is the still look (the editor, mapcli render, icons); then the wash, and a new wave
 * that comes in from 4 px out.
 */
export const SURF: readonly number[] = [2, 0, 4, 3];
export const SURF_FRAMES = SURF.length;
/** How far out of the edge the surf reaches, px. */
const SURF_REACH = 4;
/** The broken line: dashes of 5 px with gaps of 3, along any edge, seamless tile to tile. */
const dash = (x: number, y: number): boolean => (x + y) % 8 < 5;

/** Whether a 4-neighbour of (x, y) inside the tile passes the test. */
function touches(x: number, y: number, test: (x: number, y: number) => boolean): boolean {
  return [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([dx, dy]) => {
    const nx = x + (dx as number);
    const ny = y + (dy as number);
    return nx >= 0 && ny >= 0 && nx < T && ny < T && test(nx, ny);
  });
}

/**
 * How far each pixel of the tile is from the covered part, in 4-neighbour steps: 0 covered,
 * 1..SURF_REACH out on the other ground, SURF_REACH + 1 further.
 */
function edgeDistance(isCovered: (x: number, y: number) => boolean): Uint8Array {
  const d = new Uint8Array(T * T).fill(SURF_REACH + 1);
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (isCovered(x, y)) d[y * T + x] = 0;
  for (let step = 1; step <= SURF_REACH; step++)
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++)
        if (
          (d[y * T + x] as number) > step &&
          touches(x, y, (nx, ny) => d[ny * T + nx] === step - 1)
        )
          d[y * T + x] = step;
  return d;
}

/**
 * One piece: the from-ground where it covers the tile, its edge pixels a little darker. With
 * foam, the other ground's pixels by the edge are surf, as it looks in `frame` (SURF).
 */
export function borderSprite(piece: Piece, fill: Fill, foam = false, frame = 0): Image {
  const img = createImage(T, T);
  const isCovered = (x: number, y: number): boolean => covered(piece, x, y);
  const dist = foam ? edgeDistance(isCovered) : undefined;
  const surf = SURF[frame % SURF_FRAMES] as number;
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      if (!isCovered(x, y)) {
        const d = dist?.[y * T + x];
        if (d === 1) img.data.set(FOAM[0] as Rgba, (y * T + x) * 4);
        else if ((surf === 0 && d === 2) || (d === surf && dash(x, y)))
          img.data.set(FOAM[1] as Rgba, (y * T + x) * 4);
        continue;
      }
      const edge = touches(x, y, (nx, ny) => !isCovered(nx, ny));
      const c = fill(x, y);
      const k = edge ? 0.8 : 1;
      img.data.set(
        [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k), 255],
        (y * T + x) * 4,
      );
    }
  return img;
}

interface Rule {
  id: string;
  from: string;
  to: string;
  pieces: Record<string, string>;
}

/** Grounds that get foam on their shore (the "to" ground of a border rule). */
const WATER = /^water_/;

/** Border sprites for data/borders.yaml (and the surf frames of shores): sprite path → PNG bytes. */
export function borderSprites(root: string): Map<string, Buffer> {
  const rules = parse(readFileSync(join(root, "data/borders.yaml"), "utf8")) as Rule[];
  const items = new Map<string, string>();
  for (const f of ["ground.yaml", "decoration.yaml"]) {
    const list = parse(readFileSync(join(root, "data/items", f), "utf8")) as {
      id: string;
      sprite: string;
    }[];
    for (const i of list) items.set(i.id, i.sprite);
  }
  const { manifest } = parseManifest(readFileSync(join(root, "assets/sprites.yaml"), "utf8"));
  const out = new Map<string, Buffer>();
  for (const rule of rules) {
    const groundSprite = items.get(rule.from);
    const entry = groundSprite ? manifest.sprites.get(groundSprite) : undefined;
    const fill = groundFill(root, entry, groundSprite);
    for (const [piece, item] of Object.entries(rule.pieces)) {
      const sprite = items.get(item);
      if (!sprite) throw new Error(`border piece "${item}" is not in data/items`);
      const foam = WATER.test(rule.to);
      out.set(sprite, encodePng(borderSprite(piece as Piece, fill, foam)));
      if (foam)
        for (let f = 1; f < SURF_FRAMES; f++)
          out.set(`${sprite}/frame_${f}`, encodePng(borderSprite(piece as Piece, fill, true, f)));
    }
  }
  return out;
}

/**
 * The pixels of a ground: its own art (assets/sprites/<sprite>.png, e.g. drawn by
 * tools/spritegen), else the top-left tile of its pack image, else its placeholder colour.
 * Run tools/spritegen before this when a ground's recipe changes.
 */
function groundFill(root: string, entry: SpriteEntry | undefined, sprite?: string): Fill {
  const own = sprite ? join(root, "assets/sprites", `${sprite}.png`) : undefined;
  if (entry?.kind === "source" || (own && existsSync(own))) {
    const file = entry?.kind === "source" ? join(root, "assets", entry.source) : (own as string);
    const src = decodePng(readFileSync(file));
    const ox = entry?.kind === "source" ? (entry.rect?.x ?? 0) : 0;
    const oy = entry?.kind === "source" ? (entry.rect?.y ?? 0) : 0;
    return (x, y) => {
      const i = ((oy + y) * src.width + ox + x) * 4;
      return [src.data[i] ?? 0, src.data[i + 1] ?? 0, src.data[i + 2] ?? 0, 255];
    };
  }
  const color: Rgba =
    entry?.kind === "placeholder" && entry.color ? entry.color : [128, 128, 128, 255];
  return () => color;
}

function main(): void {
  const { values } = parseArgs({ options: { root: { type: "string", default: "." } } });
  const root = resolve(values.root);
  const sprites = borderSprites(root);
  for (const [sprite, png] of sprites) {
    const file = join(root, "assets/sprites", `${sprite}.png`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, png);
  }
  console.log(`wrote ${sprites.size} border sprites`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""))) main();
