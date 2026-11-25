// The living world's own pixel art (livingworld/README.md), written to
// assets/livingworld/sprites/ (spriteFile): small plants that bend when walked through
// (livingworld/plants/<item>, used by data/items/plants.yaml) and the client's effect masks
// (livingworld/fx/<name>: footprints, ripples, dust, leaves and critters, and the colour
// art of the trail wear, recipes/trail.ts), which the
// client looks up by name. The masks are white or near white: the client tints them
// (a footprint takes its surface's colour). Original art, 32x32 in the 3/4 style.
import type { Image, Rgba } from "@rpg/spritepack";
import { disc, line, opaque, px } from "../draw.ts";
import { hex } from "../palette.ts";
import type { Rng } from "../draw.ts";
import type { Recipe, RecipeBook } from "../recipe.ts";
import { TRAIL } from "./trail.ts";
import { plantWind } from "../wind.ts";
import type { WindMeta } from "../wind.ts";

const WHITE: Rgba = [255, 255, 255, 255];
const LIGHT: Rgba = [214, 214, 214, 255];

/** Blades of grass from the ground line up, leaning a little each. */
function blades(
  img: Image,
  rand: Rng,
  n: number,
  x0: number,
  x1: number,
  minH: number,
  maxH: number,
  colors: readonly Rgba[],
): void {
  for (let i = 0; i < n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * (i + rand() * 0.8)) / n);
    const h = Math.round(minH + rand() * (maxH - minH));
    const lean = (rand() * 2 - 1) * 0.35;
    const base = 29 + Math.round(rand() * 2);
    for (let k = 0; k < h; k++) {
      const c = colors[Math.min(colors.length - 1, Math.floor((k / h) * colors.length))] as Rgba;
      px(img, Math.round(x + lean * k), base - k, c);
    }
  }
}

/**
 * A stem from under (x, y) down to the plant or the ground: a flower or a seed head never
 * floats loose, so the wind moves it with its plant (assets/README.md "Plantas y viento").
 */
function stemDown(img: Image, x: number, y: number, color: Rgba): void {
  for (let yy = y + 1; yy <= 30 && !opaque(img, x, yy); yy++) px(img, x, yy, color);
}

const GRASS = ["#22401a", "#33592a", "#4a7232", "#668e3e", "#86aa52"].map(hex);
const DRY = ["#4a4420", "#625a29", "#7c7234", "#988c43", "#b0a455"].map(hex);
const REED = ["#2c3a1c", "#3d4e24", "#53652e", "#6a7a38"].map(hex);
const PETALS = ["#c9a0dc", "#e8d36a", "#e6e6e6", "#d7745f"].map(hex);

/** A small plant: every one says how it takes the wind (wind.ts plantWind). */
const plant = (wind: WindMeta, draw: (img: Image, rand: Rng) => void): Recipe => ({
  kind: "object",
  wind,
  draw: (img, rand) => draw(img, rand),
});

const PLANTS: RecipeBook = {
  "livingworld/plants/grass_tuft": plant(plantWind("tall_grass"), (img, rand) => {
    blades(img, rand, 12, 9, 23, 5, 10, GRASS);
  }),
  "livingworld/plants/tall_grass": plant(plantWind("tall_grass"), (img, rand) => {
    blades(img, rand, 16, 5, 27, 10, 18, GRASS);
    blades(img, rand, 6, 8, 24, 12, 20, DRY);
  }),
  "livingworld/plants/wildflowers": plant(plantWind("flower"), (img, rand) => {
    blades(img, rand, 12, 6, 26, 5, 11, GRASS);
    for (let i = 0; i < 6; i++) {
      const x = 8 + Math.round(rand() * 16);
      const y = 18 + Math.round(rand() * 6);
      const c = PETALS[i % PETALS.length] as Rgba;
      stemDown(img, x, y, GRASS[1] as Rgba);
      px(img, x, y, c);
      px(img, x + 1, y, c);
      px(img, x, y - 1, c);
      px(img, x + 1, y - 1, hex("#f2e27a"));
    }
  }),
  "livingworld/plants/reeds": plant(plantWind("reed"), (img, rand) => {
    blades(img, rand, 10, 7, 25, 14, 22, REED);
    // Brown seed heads on the tallest stems.
    for (let i = 0; i < 4; i++) {
      const x = 9 + Math.round(rand() * 14);
      const y = 8 + Math.round(rand() * 5);
      stemDown(img, x, y + 3, REED[1] as Rgba);
      line(img, x, y, x, y + 3, hex("#5a3a22"));
      line(img, x + 1, y + 1, x + 1, y + 2, hex("#6e4a2c"));
    }
  }),
};

const fx = (draw: (img: Image) => void): Recipe => ({ kind: "effect", draw: (img) => draw(img) });

/** A shoe print: a sole and a heel, pointing up (north); the client turns it. */
function foot(img: Image, x: number, y: number): void {
  disc(img, x + 1.5, y + 2, 1.6, 2.2, LIGHT);
  disc(img, x + 1.5, y + 6.5, 1.2, 1.3, LIGHT);
}

/** A paw: a pad and four toes. */
function paw(img: Image, x: number, y: number, s: number): void {
  disc(img, x, y + 2 * s, 1.4 * s, 1.1 * s, LIGHT);
  for (const dx of [-1.6, -0.5, 0.6, 1.7]) px(img, Math.round(x + dx * s), Math.round(y), LIGHT);
}

/** A ring on the water at `r` (flattened: it lies on the ground). */
function ring(img: Image, r: number): void {
  for (let a = 0; a < 64; a++) {
    const t = (a / 64) * Math.PI * 2;
    px(img, Math.round(16 + Math.cos(t) * r), Math.round(16 + Math.sin(t) * r * 0.55), WHITE);
  }
}

/** A dust cloud of `n` puffs spread `r` from the middle. */
function cloud(img: Image, r: number, size: number): void {
  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2 + r * 0.3;
    disc(img, 16 + Math.cos(t) * r, 18 + Math.sin(t) * r * 0.5 - r * 0.3, size, size * 0.8, LIGHT);
  }
}

const FX: RecipeBook = {
  "livingworld/fx/footprint_feet": fx((img) => foot(img, 14, 12)),
  "livingworld/fx/footprint_paw": fx((img) => {
    paw(img, 15, 11, 1);
    paw(img, 17, 17, 1);
  }),
  "livingworld/fx/footprint_big_paw": fx((img) => {
    paw(img, 14, 9, 1.6);
    paw(img, 18, 18, 1.6);
  }),
  ...Object.fromEntries(
    [3, 6, 9, 12].map((r, i) => [`livingworld/fx/ripple_${i}`, fx((img) => ring(img, r))]),
  ),
  ...Object.fromEntries(
    [2, 4, 6, 8].map((r, i) => [
      `livingworld/fx/dust_${i}`,
      fx((img) => cloud(img, r, 2.2 - i * 0.3)),
    ]),
  ),
  ...Object.fromEntries(
    ["#7a8a2e", "#b07a28", "#8e3a24"].map((c, i) => [
      `livingworld/fx/leaf_${i}`,
      {
        kind: "effect",
        draw: (img: Image) => {
          const col = hex(c);
          line(img, 14, 16, 18, 16, col);
          line(img, 15, 15, 17, 15, col);
          line(img, 15, 17, 17, 17, col);
          px(img, 19, 17, hex("#4a3a1c"));
        },
      } satisfies Recipe,
    ]),
  ),
  // Critters: two frames each (wings up and down, or a flicker).
  ...Object.fromEntries(
    [0, 1].flatMap((f) => [
      [
        `livingworld/fx/bird_${f}`,
        fx((img) => {
          const body = hex("#5a4a3c");
          disc(img, 16, 17, 2.4, 1.6, body);
          px(img, 13, 16, hex("#3a3028"));
          px(img, 12, 16, hex("#d8a040"));
          if (f === 0) line(img, 15, 15, 18, 13, hex("#7a6650"));
          else line(img, 15, 17, 18, 19, hex("#7a6650"));
        }),
      ],
      [
        `livingworld/fx/butterfly_${f}`,
        fx((img) => {
          const wing = hex(f === 0 ? "#e8b23a" : "#c99420");
          const w = f === 0 ? 2 : 1;
          disc(img, 15 - w / 2, 16, w, 1.6, wing);
          disc(img, 17 + w / 2, 16, w, 1.6, wing);
          line(img, 16, 15, 16, 17, hex("#2a2018"));
        }),
      ],
      [
        `livingworld/fx/firefly_${f}`,
        fx((img) => {
          disc(img, 16, 16, f === 0 ? 1.5 : 1, f === 0 ? 1.5 : 1, hex("#f4f0a0"));
          px(img, 16, 16, WHITE);
        }),
      ],
      [
        `livingworld/fx/fish_${f}`,
        fx((img) => {
          const shade = hex("#1c2a30");
          disc(img, 16, 16, 4, 1.6, shade);
          line(img, 20, 16, 22, f === 0 ? 14 : 18, shade);
          line(img, 20, 16, 22, f === 0 ? 18 : 14, shade);
        }),
      ],
    ]),
  ),
};

export const LIVING: RecipeBook = { ...PLANTS, ...FX, ...TRAIL };
