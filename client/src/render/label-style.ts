// The look of the labels over creatures (docs/17 UI-3 "Nombres"), pure and unit-tested: the
// colour tokens of names, guild lines and skulls, how much they contrast with their black
// outline, and how big they are drawn at each map zoom.
//
// Size: the labels are rasterised once at the pixel font's grid size (CANVAS_FONT_SIZE, one
// grid cell per pixel) and the Text is scaled by a whole number with nearest-neighbour
// sampling, so every cell becomes an exact square of pixels and the pixel look stays crisp.
// The scale follows the map zoom (device pixels per sprite pixel): before, a name stayed
// 11 device px whatever the zoom, a quarter of a tile on a high-density screen at 4x. The
// player picks "normal" or "large" (Options → Interface, state/ui-prefs.ts); large is the
// default since the owner asked for bigger names (2026-11-23).
//
// Colour: every label fill keeps a contrast of at least LABEL_MIN_CONTRAST (the WCAG ratio
// for normal text) against the black outline it is drawn with, and the kinds keep hues far
// apart (self blue, player amber, monster red, NPC violet, guild green).

/** The outline around every label (and its stroke colour in a TextStyle). */
export const LABEL_OUTLINE = 0x000000;

/** Fill colours of the names by who the creature is, and of the guild line. */
export const LABEL_COLORS = {
  /** The own character. */
  self: 0x5ea2ff,
  /** Other players. */
  player: 0xf0b040,
  monster: 0xff4f5e,
  /** Was 0x7d4fb0, a dark purple the owner could hardly read (contrast 3.6). */
  npc: 0xc79bff,
  guild: 0xb8e986,
} as const;

/** Fill colours of the PvP marks drawn with shapes (T5.2), when a mark has no sprite. */
export const SKULL_COLORS = {
  aggressor: 0xf2b233,
  murderer: 0xf04848,
  outlaw: 0xb07cff,
} as const;

/** The least contrast a label fill keeps against its outline (WCAG AA, normal text). */
export const LABEL_MIN_CONTRAST = 4.5;

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of 0xrrggbb, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: number): number {
  return (
    0.2126 * channel((rgb >> 16) & 0xff) +
    0.7152 * channel((rgb >> 8) & 0xff) +
    0.0722 * channel(rgb & 0xff)
  );
}

/** WCAG contrast ratio of two colours, 1 (the same) to 21 (black on white). */
export function contrastRatio(a: number, b: number): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Hue of 0xrrggbb in degrees [0, 360). */
export function hueOf(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 255;
  const g = ((rgb >> 8) & 0xff) / 255;
  const b = (rgb & 0xff) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** How big the names are (Options → Interface "Name size"). */
export type NameSize = "normal" | "large";
export const NAME_SIZES: readonly NameSize[] = ["normal", "large"];
/** The owner asked for bigger names (2026-11-23): large unless the player picks normal. */
export const DEFAULT_NAME_SIZE: NameSize = "large";

/**
 * Screen pixels per cell of the font's grid for the labels at map scale `zoom` (whole
 * device pixels per sprite pixel): a whole number, at least 1. Normal is half the zoom
 * rounded down (zoom 2-3: 1, as before on a common monitor; 4-5: 2; 6-7: 3); large is 3/5
 * of it rounded up (zoom 2-3: 2, 4-5: 3, 6: 4). At zoom 1 both are 1.
 */
export function labelScale(zoom: number, size: NameSize): number {
  const z = Math.max(1, Math.floor(Number.isFinite(zoom) ? zoom : 1));
  const s = size === "normal" ? Math.floor(z / 2) : Math.ceil((z * 3) / 5);
  return Math.max(1, Math.min(z, s));
}
