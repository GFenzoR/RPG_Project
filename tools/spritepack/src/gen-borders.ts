// Generates the original placeholder art for the autoborder pieces of data/borders.yaml:
// assets/sprites/borders/<rule>_<piece>.png. Each piece is the colour of the `from` ground
// over a transparent tile, shaped by where the `from` ground is, with a slightly wavy edge
// and a darker rim so map renders read clearly. Deterministic: same input, same bytes.
//   node --experimental-strip-types tools/spritepack/src/gen-borders.ts [--root DIR]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { createImage, encodePng } from "./image.ts";
import type { Image, Rgba } from "./image.ts";
import { parseManifest } from "./manifest.ts";

const T = 32;
const DEPTH = 9; // how far the `from` ground reaches into the tile, in pixels

type Piece =
  "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | `inner_${"ne" | "nw" | "se" | "sw"}`;

/** Distance of the wavy edge from the side, at position t along it. */
const wave = (t: number): number => DEPTH + Math.round(1.5 * Math.sin((t / T) * Math.PI * 4));

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

export function borderSprite(piece: Piece, color: Rgba): Image {
  const img = createImage(T, T);
  const rim: Rgba = [
    Math.round(color[0] * 0.7),
    Math.round(color[1] * 0.7),
    Math.round(color[2] * 0.7),
    255,
  ];
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      if (!covered(piece, x, y)) continue;
      const edge = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => {
        const nx = x + (dx as number);
        const ny = y + (dy as number);
        return nx >= 0 && ny >= 0 && nx < T && ny < T && !covered(piece, nx, ny);
      });
      img.data.set(edge ? rim : color, (y * T + x) * 4);
    }
  return img;
}

interface Rule {
  id: string;
  from: string;
  pieces: Record<string, string>;
}

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
    const color: Rgba =
      entry?.kind === "placeholder" && entry.color ? entry.color : [128, 128, 128, 255];
    for (const [piece, item] of Object.entries(rule.pieces)) {
      const sprite = items.get(item);
      if (!sprite) throw new Error(`border piece "${item}" is not in data/items`);
      out.set(sprite, encodePng(borderSprite(piece as Piece, color)));
    }
  }
  return out;
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
