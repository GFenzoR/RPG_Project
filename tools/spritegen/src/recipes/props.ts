// Animated town props (docs/17 ART-7): fire that flickers, water that runs, cloth that
// flutters. Each is a sprite and its frames <sprite>/frame_<n> (timing in assets/sprites.yaml
// `tiles`; fire and cloth with a phase per tile so a row of torches never flickers in step),
// own art in 3/4 view lit from the top-left, standing on its tile (anchored at the
// bottom-right, as every sprite). Wall pieces sit over a wall's face: place them on the tile
// of an east-west wall, after the wall in the stack.
import { createImage } from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import {
  cylinderLight,
  disc,
  eachInEllipse,
  eachInRect,
  get,
  hash2,
  line,
  outline,
  px,
  rect,
  tileNoise,
} from "../draw.ts";
import { hex, mix } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";
import { stones } from "./walls.ts";

/** Frames of every animated prop. */
export const PROP_FRAMES = 4;

const FIRE = ["#6e1e10", "#b8401a", "#ef7d26", "#ffbd45", "#fff0b0"].map(hex);
const SMOKE = ["#2f2c30", "#3f3b3e", "#4f4a4b"].map(hex);
const IRON = ["#1f2024", "#33353b", "#4c4f57", "#70747d"].map(hex);
const STONE = ["#2c2a2d", "#3d3a3b", "#4f4b49", "#625d58", "#77716a"].map(hex);
const WOOD = ["#2a1c12", "#3f2a1b", "#573b26", "#6f4d33"].map(hex);
const WATER = ["#183247", "#21455f", "#2c5776", "#4a7c9a", "#9cc4d6"].map(hex);

function ramp(colors: readonly Rgba[], level: number): Rgba {
  const i = Math.max(0, Math.min(colors.length - 1, Math.floor(level * colors.length)));
  return colors[i] as Rgba;
}

/**
 * A flame standing on (cx, base), `w` wide and up to `h` tall, at frame `f`: each column
 * rises and falls on its own, the core is white-yellow and the edges red; a spark or two
 * flies above.
 */
function flame(
  img: Image,
  cx: number,
  base: number,
  w: number,
  h: number,
  f: number,
  seed: number,
): void {
  const half = w / 2;
  for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
    const u = (x + 0.5 - cx) / half;
    if (Math.abs(u) > 1) continue;
    const lick = 0.6 + 0.4 * hash2(x, f, seed);
    const col = h * (1 - u * u) * lick;
    for (let y = base; y > base - col; y--) {
      const v = (base - y) / Math.max(1, col);
      const core = 1 - Math.abs(u) * 1.2 - v * 0.9;
      px(img, x, y, ramp(FIRE, core * 0.9 + 0.35));
    }
  }
  for (let i = 0; i < 2; i++) {
    if (hash2(i, f, seed + 1) > 0.6) continue;
    const sx = Math.round(cx + (hash2(i, f, seed + 2) - 0.5) * w);
    const sy = Math.round(base - h - 1 - hash2(i, f, seed + 3) * 4);
    px(img, sx, sy, FIRE[3] as Rgba);
  }
}

/** A sprite and its frames, each drawn by draw(img, frame, seed). */
function animatedProp(
  sprite: string,
  w: number,
  h: number,
  draw: (img: Image, f: number, seed: number) => void,
): RecipeBook {
  const seed = seedOf(sprite);
  const book: RecipeBook = {};
  for (let f = 0; f < PROP_FRAMES; f++)
    book[f === 0 ? sprite : `${sprite}/frame_${f}`] = {
      kind: "object",
      width: w,
      height: h,
      draw: (img) => draw(img, f, seed),
    };
  return book;
}

/** Draws a static part once into a layer, outlines it, and copies it in. */
function part(img: Image, w: number, h: number, draw: (layer: Image) => void, amount = 0.45): void {
  const layer = createImage(w, h);
  draw(layer);
  outline(layer, { amount });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = get(layer, x, y);
      if (c) px(img, x, y, c);
    }
}

function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cut stone texture lit from the top-left (blocks of about 8 px). */
function stoneAt(x: number, y: number, seed: number, light: number): Rgba {
  const st = stones(((x % 32) + 32) % 32, ((y % 32) + 32) % 32, 8, 8, seed);
  if (st.gap < 0.1) return STONE[0] as Rgba;
  return ramp(STONE, light + (hash2(st.id, 1, seed) - 0.5) * 0.25 - (st.dx + st.dy) * 0.25);
}

// ---- smelting forge (32x64) -------------------------------------------------------------------

/** A stone furnace with a fire in its arched mouth and smoke from its chimney. */
function forge(img: Image, f: number, seed: number): void {
  part(img, 32, 64, (l) => {
    // Body: a 3/4 block, top lit, front in shadow, slightly narrower chimney above.
    eachInRect(2, 30, 28, 32, (x, y) => px(l, x, y, stoneAt(x, y, seed, y < 36 ? 0.75 : 0.45)));
    eachInRect(9, 8, 14, 24, (x, y) =>
      px(l, x, y, stoneAt(x, y + 5, seed, y < 12 ? 0.8 : 0.5 - (x - 9) * 0.02)),
    );
    // The mouth: an arch on darkness.
    eachInRect(8, 42, 16, 18, (x, y) => {
      const dx = (x + 0.5 - 16) / 8;
      const dy = (y + 0.5 - 48) / 6;
      if (y < 48 && dx * dx + dy * dy > 1) return;
      px(l, x, y, hex("#120c0c"));
    });
    rect(l, 4, 59, 24, 3, STONE[1] as Rgba);
  });
  // Coals and the fire in the mouth (not outlined: it glows).
  for (let x = 9; x < 23; x++) px(img, x, 58, ramp(FIRE, 0.3 + hash2(x, f, seed) * 0.4));
  flame(img, 16, 57, 13, 12, f, seed);
  // Glow on the stone round the mouth.
  for (const [x, y] of [
    [7, 46],
    [24, 46],
    [7, 52],
    [24, 52],
    [7, 58],
    [24, 58],
  ] as const)
    px(img, x, y, mix(FIRE[1] as Rgba, STONE[2] as Rgba, 0.5));
  // Smoke puffs rising from the chimney, a puff higher each frame.
  for (let i = 0; i < 2; i++) {
    const k = (f + i * 2) % PROP_FRAMES;
    const cy = 6 - k * 2;
    const cx = 16 + (k % 2 === 0 ? -1 : 1) + i;
    if (cy < 1) continue;
    disc(img, cx, cy, 2.5 - k * 0.3, 1.8, SMOKE[k < 2 ? 2 : 1] as Rgba);
  }
}

// ---- cooking hearth (32x32) -------------------------------------------------------------------

/** A ring of blackened stones round a log fire, with an iron grill over it. */
function hearth(img: Image, f: number, seed: number): void {
  part(img, 32, 32, (l) => {
    // The ring: stones on an ellipse, lit on their top-left.
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 2 * Math.PI;
      const cx = 16 + Math.cos(a) * 11;
      const cy = 22 + Math.sin(a) * 6;
      eachInEllipse(cx, cy, 2.8, 2.2, (x, y, nx, ny) => {
        px(l, x, y, ramp(STONE, 0.55 + (hash2(i, 1, seed) - 0.5) * 0.3 - (nx + ny) * 0.3));
      });
    }
    // Logs, crossed.
    line(l, 9, 25, 22, 19, WOOD[2] as Rgba);
    line(l, 9, 26, 22, 20, WOOD[1] as Rgba);
    line(l, 10, 19, 23, 25, WOOD[3] as Rgba);
    line(l, 10, 20, 23, 26, WOOD[1] as Rgba);
  });
  for (let x = 11; x < 22; x++) px(img, x, 23, ramp(FIRE, 0.25 + hash2(x, f, seed) * 0.4));
  flame(img, 16, 22, 11, 13, f, seed);
  // The grill: a bar on two posts.
  line(img, 6, 10, 26, 10, IRON[3] as Rgba);
  line(img, 6, 11, 26, 11, IRON[1] as Rgba);
  for (const x of [6, 26]) line(img, x, 10, x, 22, IRON[2] as Rgba);
}

// ---- wall torch (32x32, on a wall's face) ----------------------------------------------------

/** A torch in an iron bracket on a wall's face, its flame flickering. */
function wallTorch(img: Image, f: number, seed: number): void {
  part(img, 32, 32, (l) => {
    rect(l, 13, 14, 6, 2, IRON[2] as Rgba); // the bracket
    line(l, 16, 16, 16, 20, IRON[1] as Rgba);
    for (let y = 9; y < 22; y++) {
      px(l, 15, y, WOOD[3] as Rgba);
      px(l, 16, y, WOOD[2] as Rgba);
      px(l, 17, y, WOOD[1] as Rgba);
    }
    rect(l, 14, 8, 5, 3, hex("#3a2a1e")); // the pitch-soaked head
  });
  flame(img, 16, 8, 7, 9, f, seed);
}

// ---- brazier (32x64) ------------------------------------------------------------------------

/** An iron bowl of coals on three legs, a tall fire. */
function brazier(img: Image, f: number, seed: number): void {
  part(img, 32, 64, (l) => {
    for (const [x0, x1] of [
      [9, 6],
      [23, 26],
      [16, 16],
    ] as const)
      line(l, x0, 48, x1, 62, IRON[x0 === 16 ? 1 : 2] as Rgba);
    eachInEllipse(16, 44, 10, 5, (x, y, nx, ny) => {
      if (ny < -0.2) return;
      px(l, x, y, ramp(IRON, 0.6 - nx * 0.3 + ny * 0.1 - (ny > 0.6 ? 0.3 : 0)));
    });
  });
  eachInEllipse(16, 42, 9, 2.5, (x, y) =>
    px(img, x, y, ramp(FIRE, 0.25 + hash2(x, f + y, seed) * 0.5)),
  );
  flame(img, 16, 41, 15, 20, f, seed);
}

// ---- fountain (32x64) -----------------------------------------------------------------------

/** A round stone basin with a pillar; water spills from a bowl on top and ripples below. */
function fountain(img: Image, f: number, seed: number): void {
  part(img, 32, 64, (l) => {
    // Basin rim (an ellipse ring) and its front wall.
    eachInRect(1, 44, 30, 18, (x, y) => {
      const nx = (x + 0.5 - 16) / 15;
      const top = (y + 0.5 - 50) / 6;
      const front = y >= 50 && Math.abs(nx) <= 1 && y < 60;
      if (nx * nx + top * top <= 1 || front)
        px(l, x, y, stoneAt(x, y, seed, front && y > 51 ? 0.4 : 0.7));
    });
    // Pillar and the upper bowl.
    eachInRect(13, 26, 6, 22, (x, y) => {
      const u = (x + 0.5 - 16) / 3;
      px(l, x, y, ramp(STONE, cylinderLight(u) * 0.8 + 0.1));
    });
    eachInEllipse(16, 25, 8, 3, (x, y, nx) => px(l, x, y, ramp(STONE, 0.75 - nx * 0.3)));
  });
  // Water in the basin, rippling.
  eachInEllipse(16, 50, 13, 4.2, (x, y) => {
    const v =
      tileNoise(x + f * 2, y, 4, 2, seed) +
      (Math.hypot(x - 16, (y - 50) * 2.5) % 4 === f ? 0.4 : 0);
    px(img, x, y, ramp(WATER, 0.2 + v * 0.6));
  });
  eachInEllipse(16, 24, 6.5, 2, (x, y) =>
    px(img, x, y, ramp(WATER, 0.45 + hash2(x, f, seed) * 0.3)),
  );
  // Falling water: two thin streams whose bright beads move down each frame.
  for (const sx of [9, 23]) {
    for (let y = 26; y < 48; y++) {
      const bead = (y + f * 3) % 6 === 0;
      px(img, sx + (sx < 16 ? (y - 26) >> 3 : -((y - 26) >> 3)), y, WATER[bead ? 4 : 3] as Rgba);
    }
  }
  // The jet on top.
  for (let y = 16; y < 24; y++) px(img, 16, y, WATER[(y + f) % 3 === 0 ? 4 : 3] as Rgba);
  px(img, 15 + (f % 2), 15, WATER[4] as Rgba);
}

// ---- wall banner (32x32, on a wall's face) ---------------------------------------------------

const BANNER = ["#3a1416", "#5a1d20", "#7a282a", "#93383a"].map(hex);
const GOLD = ["#5c4515", "#9a7225", "#d0a33b"].map(hex);

/** A cloth banner hanging from a rod on a wall's face; its tail ripples. */
function wallBanner(img: Image, f: number, seed: number): void {
  // The rod.
  line(img, 7, 3, 25, 3, WOOD[2] as Rgba);
  px(img, 6, 3, GOLD[2] as Rgba);
  px(img, 26, 3, GOLD[2] as Rgba);
  // The cloth: each row sways by a phase that runs down the banner.
  part(img, 32, 32, (l) => {
    for (let y = 4; y < 28; y++) {
      const off = Math.round(Math.sin((y / 6 - f / 2) * Math.PI) * ((y - 4) / 24) * 1.5);
      const w0 = 9 + off;
      for (let x = w0; x < w0 + 14; x++) {
        // A notch cut up into the bottom of the cloth.
        const ex = x - w0 - 6.5;
        if (y >= 23 && Math.abs(ex) < y - 22.5) continue;
        const fold = Math.sin(((x - w0) / 14) * Math.PI * 2 + f) * 0.18;
        let level = 0.55 + fold - (x - w0) * 0.02;
        // The emblem: a gold diamond with a light core.
        const d = Math.abs(ex) + Math.abs(y - 13.5);
        if (d <= 4) {
          px(l, x, y, GOLD[d <= 1.5 ? 2 : ex + (y - 13.5) < 0 ? 2 : 1] as Rgba);
          continue;
        }
        if (x === w0 || x === w0 + 13) level -= 0.2;
        px(l, x, y, ramp(BANNER, level + (hash2(x, y, seed) - 0.5) * 0.08));
      }
    }
  });
  rect(img, 9, 4, 14, 1, GOLD[1] as Rgba);
}

// ---- boulder shadow ---------------------------------------------------------------------------

/** The cast shadow of a 32x32 object: a low blob toward the bottom-right. */
function blobShadow(cx: number, cy: number, rx: number, ry: number): (img: Image) => void {
  return (img) => disc(img, cx, cy, rx, ry, [0, 0, 0, 255]);
}

export const PROPS: RecipeBook = {
  ...animatedProp("decor/smelting_forge", 32, 64, forge),
  ...animatedProp("decor/cooking_hearth", 32, 32, hearth),
  ...animatedProp("decor/wall_torch", 32, 32, wallTorch),
  ...animatedProp("decor/brazier", 32, 64, brazier),
  ...animatedProp("decor/fountain", 32, 64, fountain),
  ...animatedProp("decor/wall_banner", 32, 32, wallBanner),
  "decor/boulder/shadow": { kind: "object", draw: blobShadow(19, 27, 13, 4) },
  "decor/smelting_forge/shadow": { kind: "object", height: 64, draw: blobShadow(20, 61, 14, 4) },
  "decor/fountain/shadow": { kind: "object", height: 64, draw: blobShadow(19, 60, 15, 4) },
  "decor/brazier/shadow": { kind: "object", height: 64, draw: blobShadow(18, 62, 9, 2.5) },
};
