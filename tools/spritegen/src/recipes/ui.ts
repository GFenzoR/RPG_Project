// Client interface icons (kind "ui"): drawn inside UI_ICON_BOX at the centre of a 32x32
// sprite, which is all the client shows of them. The client finds them by path, not by a
// data/ field: ui/marks/<id> are the PvP marks of client/src/render/marks.ts.
//
// PvP marks (T5.2): original sigils, one silhouette per mark so they read without colour
// too, in the colours of docs/02 "Marcas": amber crossed blades for the aggressor (drew
// steel on someone), a crimson drop for the murderer (spilled blood), a violet broken shield
// for the outlaw (lost the protection of the law). Tiny, so they are hand-placed pixel maps
// instead of shapes, lit from the top-left with a near-black outline like the creatures'.
import type { Image, Rgba } from "@rpg/spritepack";
import { opaque, px } from "../draw.ts";
import { hex, material } from "../palette.ts";
import type { Material } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";
import { UI_ICON_BOX } from "../recipe.ts";

/** The outline of every mark: near black, warm, like the cast shadows. */
const INK: Rgba = hex("#140e0c");

const AMBER = material("#ffe3a0", "#f2b233", "#b97f1c", "#7a4f0d");
const STEEL_GRIP = material("#9a7a5a", "#6e5238", "#4e3926", "#33241a");
const CRIMSON = material("#ff8f86", "#d23a3a", "#9a2426", "#641517");
const VIOLET = material("#c9a2f2", "#8e4fd6", "#6533a3", "#41206b");

/**
 * Draws a pixel map: one string per row, one character per pixel, at the icon box's
 * inner corner (the box minus the 1 px left for the outline). Characters: "." nothing,
 * L/B/S/D the light, base, shadow and deep shades of `m`, g/G a second material's base and
 * light (`m2`), W a white glint. Then outlines the result (outside, 8-neighbour) in INK.
 */
function pixelMap(img: Image, rows: readonly string[], m: Material, m2: Material = m): void {
  const x0 = UI_ICON_BOX.x + 1;
  const y0 = UI_ICON_BOX.y + 1;
  const colours: Record<string, Rgba> = {
    L: m.light,
    B: m.base,
    S: m.shadow,
    D: m.deep,
    g: m2.base,
    G: m2.light,
    W: hex("#fffaf0"),
  };
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = colours[ch];
      if (c) px(img, x0 + x, y0 + y, c);
    });
  });
  outsideOutline(img, INK);
}

/** A 1 px outline around every shape, outside it (thin details keep their colour). */
function outsideOutline(img: Image, c: Rgba): void {
  const marks: [number, number][] = [];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (opaque(img, x, y)) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1 && !near; dx++) near = opaque(img, x + dx, y + dy);
      if (near) marks.push([x, y]);
    }
  for (const [x, y] of marks) px(img, x, y, c);
}

// The maps are 10x10: the outline makes them 12x12, the icon box.

/**
 * Aggressor: two swords crossed, amber, points up: 2 px blades (lit edge, base edge) that
 * meet in the middle, a crossguard across each blade's end, leather grips and pommels.
 */
const AGGRESSOR = [
  "LB......BL",
  ".LB....BL.",
  "..LB..BL..",
  "...LBBL...",
  "....LB....",
  "..SBLLBS..",
  "...S..S...",
  "..G.SS.G..",
  ".G......G.",
  "B........B",
];

/** Murderer: a drop of blood, crimson, with a glint on its lit side. */
const MURDERER = [
  "....BB....",
  "....BB....",
  "...LBBS...",
  "...LBBS...",
  "..LWBBBS..",
  ".LWBBBBSS.",
  ".LBBBBBSS.",
  ".BBBBBSSD.",
  "..SBSSSD..",
  "...SDDD...",
];

/** Outlaw: a heater shield split by a jagged crack, violet, its halves pushed apart. */
const OUTLAW = [
  "LLLL..BBBS",
  "LBBB..BBBS",
  "LBBBB.BBBS",
  "LBBB.BBBBS",
  "LBBB..BBBS",
  ".BBBB.BBS.",
  ".BBB.BBBS.",
  "..BB..BS..",
  "...B.BS...",
  "....DD....",
];

export const UI: RecipeBook = {
  "ui/marks/aggressor": { kind: "ui", draw: (img) => pixelMap(img, AGGRESSOR, AMBER, STEEL_GRIP) },
  "ui/marks/murderer": { kind: "ui", draw: (img) => pixelMap(img, MURDERER, CRIMSON) },
  "ui/marks/outlaw": { kind: "ui", draw: (img) => pixelMap(img, OUTLAW, VIOLET) },
};
