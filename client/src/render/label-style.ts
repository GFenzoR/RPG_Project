// The look of the labels over creatures (docs/17 UI-3 "Nombres"), pure and unit-tested: the
// colour tokens of names, role lines, guild lines and skulls, how much they contrast with
// their black outline, and how big they are drawn at each map zoom and pixel density.
//
// Size: a label is rasterised at the very size it shows, in device pixels, and never
// scaled (labelFontPx): the canvas's backing store is device pixels, so the text is as
// sharp as the screen at any zoom and any devicePixelRatio (Windows at 125 % or 150 %
// too). It is set in the interface's sans (Alegreya Sans, OFL), bold, with a round black
// outline. Before (lote 19) the names were the 11 px pixel font blown up 2x or 3x with
// nearest-neighbour sampling: every cell a 2 or 3 px block, which the owner found
// "pixelated and too big" (2026-11-25). The size follows the zoom the player sees (CSS
// pixels per sprite pixel) and is then turned into device pixels. The player picks
// "normal" or "large" (Options → Interface, state/ui-prefs.ts); large is the default.
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

/**
 * What an NPC does, under its name: the NPC's violet, much paler (and the line is smaller),
 * so it reads as part of the same label and not as another creature's name.
 */
export const LABEL_ROLE_COLOR = 0xe4d9f5;

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

/** The family of the labels (ui/fonts.css, vite/fonts.ts): the interface's sans. */
export const LABEL_FONT_FAMILY = "Alegreya Sans";
/** TextStyle.fontFamily of the labels: that font, the system sans until it loads. */
export const LABEL_FONT = `"${LABEL_FONT_FAMILY}", system-ui, sans-serif`;
/** Weights of the name line and of the lines under it (role, guild). */
export const LABEL_NAME_WEIGHT = "700";
export const LABEL_SUB_WEIGHT = "500";

/** The map zooms the sizes are tuned for, in CSS pixels per sprite pixel. */
const MIN_SEEN_ZOOM = 1;
const MAX_SEEN_ZOOM = 4;
/** CSS px of a name at seen zoom z: BASE + STEP * z. Large: 12, 15, 18, 21; normal: 10 to 16. */
const NAME_PX: Readonly<Record<NameSize, { base: number; step: number }>> = {
  normal: { base: 8, step: 2 },
  large: { base: 9, step: 3 },
};
/** The lines under the name are this much of it, and never under SUB_MIN_PX CSS px. */
export const SUB_RATIO = 0.8;
const SUB_MIN_PX = 9;
/** The role line shrinks to this much of its size before it takes more lines (render/labels.ts). */
export const SHRINK_MIN = 0.82;
/**
 * The smallest a name is ever drawn, CSS px (the floor of the lines under it too): a name is
 * never cut, it shrinks to here at most and, still too wide, shows wider than its room.
 */
export const NAME_MIN_PX = SUB_MIN_PX;

const density = (dpr: number): number => (Number.isFinite(dpr) && dpr > 0 ? dpr : 1);

/**
 * NAME_MIN_PX in device pixels on a screen of `dpr`: the same size to the eye at 100 % and
 * at 200 % (6 device px, the floor before, were 3 CSS px on a dense screen).
 */
export function minNamePx(dpr: number): number {
  return Math.round(NAME_MIN_PX * density(dpr));
}

/**
 * Font size of the names in device pixels, at map scale `zoom` (whole device pixels per
 * sprite pixel) on a screen of `dpr` device pixels per CSS pixel. A whole number: the Text
 * is rasterised at this size and drawn 1:1. What the player sees is zoom / dpr, so the
 * same window looks the same at 100 % and at 150 % display scaling.
 */
export function labelFontPx(zoom: number, dpr: number, size: NameSize): number {
  const d = density(dpr);
  const z = Math.max(1, Number.isFinite(zoom) ? zoom : 1) / d;
  const seen = Math.min(MAX_SEEN_ZOOM, Math.max(MIN_SEEN_ZOOM, z));
  const k = NAME_PX[size];
  return Math.round((k.base + k.step * seen) * d);
}

/** Font size of the lines under a name (an NPC's role, a guild), device pixels. */
export function subFontPx(namePx: number, dpr: number): number {
  return Math.min(
    namePx,
    Math.max(Math.round(SUB_MIN_PX * density(dpr)), Math.round(namePx * SUB_RATIO)),
  );
}

/** Width of the outline of a label of `fontPx` (half of it shows outside the letters). */
export function labelStroke(fontPx: number): number {
  return Math.max(2, Math.round(fontPx / 4.5));
}

/** Rows from one line of a label to the next, device pixels. */
export function linePitch(fontPx: number): number {
  return Math.round(fontPx * 1.1);
}

/** Whole-number scale of the pixel-art marks next to a name (skulls), from its size. */
export function markScale(namePx: number): number {
  return Math.max(1, Math.round(namePx / 9));
}
