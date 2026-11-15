// Placeholder app icons of the installable web client (PWA, T5.6): a 32x32 pixel-art emblem
// (a shield with a sword, our own drawing) upscaled with whole-pixel steps on the page's
// background colour. Deterministic, like the rest of spritegen; the PNGs are committed.
//
//   node --experimental-strip-types tools/spritegen/src/pwa-icons.ts [--root DIR]
//
// writes client/public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { blit, createImage, encodePng, fillRect, scaleImage } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { disc, line, polygon, px, rect } from "./draw.ts";
import { darken, hex, lighten } from "./palette.ts";

/** Same as `--bg` in client/src/ui/client.css and theme_color in the manifest. */
export const ICON_BACKGROUND = hex("#12151b");

const GOLD = hex("#d9b44a");
const STEEL = hex("#b8c2cc");
const SHIELD = hex("#7a2f2a");

/** The 32x32 emblem on a transparent background. */
export function emblem(): Image {
  const img = createImage(32, 32);
  // Shield: gold rim, red field, darker lower half.
  const outer = [
    [5, 4],
    [27, 4],
    [27, 15],
    [16, 29],
    [5, 15],
  ] as const;
  const inner = [
    [7, 6],
    [25, 6],
    [25, 15],
    [16, 26],
    [7, 15],
  ] as const;
  polygon(img, outer, darken(GOLD, 0.25));
  polygon(img, inner, SHIELD);
  polygon(
    img,
    [
      [7, 15],
      [25, 15],
      [16, 26],
    ],
    darken(SHIELD, 0.3),
  );
  line(img, 6, 5, 26, 5, lighten(GOLD, 0.2));
  // Sword over the shield, point down.
  rect(img, 15, 2, 2, 20, STEEL);
  line(img, 15, 2, 15, 21, lighten(STEEL, 0.4));
  px(img, 15, 22, STEEL);
  px(img, 16, 22, darken(STEEL, 0.2));
  px(img, 15, 23, darken(STEEL, 0.2));
  rect(img, 11, 7, 10, 2, GOLD); // guard
  line(img, 11, 7, 20, 7, lighten(GOLD, 0.3));
  disc(img, 16, 4, 1.6, 1.6, GOLD); // pommel
  return img;
}

/**
 * The emblem centred on a full-bleed background, scaled by the largest whole factor that
 * keeps it within `fill` of the side. Maskable icons use a smaller fill so the emblem stays
 * inside the 80% safe circle a launcher may crop to.
 */
export function icon(size: number, fill: number): Image {
  const art = emblem();
  const factor = Math.max(1, Math.floor((size * fill) / art.width));
  const big = scaleImage(art, factor);
  const out = createImage(size, size);
  fillRect(out, 0, 0, size, size, ICON_BACKGROUND);
  const at = Math.floor((size - big.width) / 2);
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const s = (y * big.width + x) * 4;
      if ((big.data[s + 3] ?? 0) === 0) continue;
      blit(big, x, y, 1, 1, out, at + x, at + y);
    }
  }
  return out;
}

/** File name → image, as referenced by client/public/manifest.webmanifest and the pages. */
export function pwaIcons(): Map<string, Image> {
  return new Map([
    ["icon-192.png", icon(192, 0.9)],
    ["icon-512.png", icon(512, 0.9)],
    ["icon-maskable-512.png", icon(512, 0.56)],
    ["apple-touch-icon.png", icon(180, 0.9)],
  ]);
}

export function writePwaIcons(root: string): string[] {
  const dir = join(root, "client", "public", "icons");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, img] of pwaIcons()) {
    writeFileSync(join(dir, name), encodePng(img));
    written.push(join(dir, name));
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: "string", default: "." } } });
  for (const file of writePwaIcons(resolve(values.root))) console.log(`pwa-icons: ${file}`);
}
