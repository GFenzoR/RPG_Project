// Placeholder sprites: a coloured square with a border and the item's initials.
import { drawText, GLYPH_H, textWidth } from "./font.ts";
import { createImage, fillRect } from "./image.ts";
import type { Image, Rgba } from "./image.ts";

export const TILE = 32;

export interface PlaceholderSpec {
  label: string;
  color: Rgba;
  width: number;
  height: number;
}

/** "weapons/iron_sword" -> "IS", "creatures/wolf" -> "WO", "tools/rope_2" -> "R2". */
export function defaultLabel(spritePath: string): string {
  const name = spritePath.slice(spritePath.lastIndexOf("/") + 1);
  const words = name.split("_").filter((w) => w.length > 0);
  const label =
    words.length >= 2
      ? words
          .map((w) => w[0])
          .join("")
          .slice(0, 2)
      : (words[0] ?? "").slice(0, 2);
  return label.toUpperCase();
}

/** Stable colour per category (first path segment), so related sprites look alike. */
export function defaultColor(spritePath: string): Rgba {
  const category = spritePath.split("/")[0] ?? spritePath;
  let h = 2166136261;
  for (let i = 0; i < category.length; i++) {
    h ^= category.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return hslToRgb((h % 360) / 360, 0.45, 0.42);
}

function hslToRgb(h: number, s: number, l: number): Rgba {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number): number => {
    const t = t0 < 0 ? t0 + 1 : t0 > 1 ? t0 - 1 : t0;
    const v =
      t < 1 / 6
        ? p + (q - p) * 6 * t
        : t < 1 / 2
          ? q
          : t < 2 / 3
            ? p + (q - p) * (2 / 3 - t) * 6
            : p;
    return Math.round(v * 255);
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3), 255];
}

function shade(c: Rgba, factor: number): Rgba {
  return [Math.round(c[0] * factor), Math.round(c[1] * factor), Math.round(c[2] * factor), 255];
}

function luminance(c: Rgba): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function renderPlaceholder(spec: PlaceholderSpec): Image {
  const { width: w, height: h, color } = spec;
  const img = createImage(w, h);
  fillRect(img, 0, 0, w, h, shade(color, 0.6));
  fillRect(img, 1, 1, w - 2, h - 2, color);
  if (spec.label.length > 0) {
    const scale = textWidth(spec.label, 2) <= w - 4 && GLYPH_H * 2 <= h - 4 ? 2 : 1;
    const tw = textWidth(spec.label, scale);
    const x = Math.floor((w - tw) / 2);
    const y = Math.floor((h - GLYPH_H * scale) / 2);
    const light = luminance(color) < 140;
    const ink: Rgba = light ? [245, 245, 240, 255] : [20, 20, 24, 255];
    const shadow = shade(color, 0.55);
    drawText(img, spec.label, x + 1, y + 1, scale, shadow);
    drawText(img, spec.label, x, y, scale, ink);
  }
  return img;
}
