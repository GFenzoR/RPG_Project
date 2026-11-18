// Generates the original art for the autoborder pieces of data/borders.yaml:
// assets/sprites/borders/<rule>_<piece>.png. Each piece is the `from` ground (its own art from
// tools/spritegen, its pack texture, or its placeholder colour) over a transparent tile, shaped
// by where the `from` ground is, with an irregular edge (never straight, docs/17 ART-4) and a
// slightly darker rim; where the other ground is water, a line of foam runs along the edge on
// the water's side. Deterministic: same input, same bytes. Re-run it when a ground's sprite changes
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
 * Distance of the edge from the side, at position t along it: two waves that both repeat
 * every tile, so the edge runs on from one tile to the next.
 */
const wave = (t: number): number =>
  DEPTH +
  Math.round(1.5 * Math.sin((t / T) * Math.PI * 4) + 1.2 * Math.sin((t / T) * Math.PI * 6 + 1.3));

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

/** Foam along a shore: right at the edge, then a fainter line a pixel further out. */
export const FOAM: readonly Rgba[] = [
  [168, 198, 210, 255],
  [92, 132, 156, 255],
];

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
 * One piece: the from-ground where it covers the tile, its edge pixels a little darker. With
 * foam, the uncovered pixels next to the edge are foam (every other one two pixels out).
 */
export function borderSprite(piece: Piece, fill: Fill, foam = false): Image {
  const img = createImage(T, T);
  const isCovered = (x: number, y: number): boolean => covered(piece, x, y);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      if (!isCovered(x, y)) {
        if (!foam) continue;
        if (touches(x, y, isCovered)) img.data.set(FOAM[0] as Rgba, (y * T + x) * 4);
        else if ((x + y) % 2 === 0 && touches(x, y, (nx, ny) => touches(nx, ny, isCovered)))
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

/** Border sprites for data/borders.yaml: sprite path → PNG bytes. */
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
      out.set(sprite, encodePng(borderSprite(piece as Piece, fill, WATER.test(rule.to))));
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
