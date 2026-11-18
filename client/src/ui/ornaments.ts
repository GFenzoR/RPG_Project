// The gothic ornaments of the desktop screen (docs/17 UI-2, UI-4): small pixel-art pieces
// written as text, one character per pixel, like the toolbar's icons (ui/icons.tsx), and
// turned into SVG `data:` URLs for windows.css (CSS variables on .game: --orn-*). Own art
// (CC0, assets/CREDITS.md "Obra propia"), drawn for this game in the spirit of carved
// stone, dark iron and old gold, without tracing any other game's interface.
// - corner: the gold bracket with a garnet on each corner of a window (and the bar's ends);
// - spire: a gothic pinnacle beside each orb socket and over the bar's middle;
// - stud: an iron rivet along the bar's top and around the sockets (--orn-studs: spaced).
// Inline, because the desktop app's CSP allows `data:` images and no inline <style>: the
// variables are set through the style property (CSSOM), which it allows.
import { iconPath } from "./icons.tsx";

/** Colour of each character; "." is transparent. */
export const ORNAMENT_PALETTE: Readonly<Record<string, string>> = {
  "#": "#0d0a07", // outline
  o: "#b8923f", // gold
  "+": "#e2c47a", // gold, lit
  "-": "#6e5422", // gold, shaded
  i: "#4a4540", // iron
  I: "#2a2622", // iron, dark
  s: "#7a7268", // iron, lit
  S: "#a9a094", // iron, shine
  r: "#c0392b", // garnet
  R: "#6e1a12", // garnet, shaded
};

/** The drawings (ui/ornaments.test.ts checks their rows). */
export const ORNAMENTS = {
  /** Top left corner of a window; the other three are mirrors of it. */
  corner: [
    "#########...",
    "#++++++oo-#.",
    "#+ooooo--#..",
    "#+o#####....",
    "#+o#Rr#.....",
    "#o-#rR#.....",
    "#o-####.....",
    "#o-#........",
    "#o#.........",
    "#-#.........",
    "#-#.........",
    ".#..........",
  ],
  spire: [
    "....#....",
    "...#+#...",
    "...#o#...",
    "..#+o-#..",
    "..#oo-#..",
    ".#+oo--#.",
    ".#o#r#-#.",
    ".#o#R#-#.",
    "#+ooooo-#",
    "#o#####-#",
    "#o#iIi#-#",
    "#o#iIi#-#",
    "#-#####-#",
    "#########",
  ],
  stud: [".###.", "#sSs#", "#sss#", "#iiI#", ".###."],
} as const satisfies Record<string, readonly string[]>;

export type OrnamentName = keyof typeof ORNAMENTS;

/** A drawing mirrored left to right and/or top to bottom (the four corners of one). */
export function mirrored(rows: readonly string[], flipX: boolean, flipY: boolean): string[] {
  const out = rows.map((r) => (flipX ? [...r].reverse().join("") : r));
  return flipY ? out.reverse() : out;
}

/** A drawing with transparent columns added on its right up to `width` (a spaced row). */
export function padded(rows: readonly string[], width: number): string[] {
  return rows.map((r) => r.padEnd(width, "."));
}

/** An SVG of the drawing, one path per colour, its pixels kept square (crispEdges). */
export function ornamentSvg(rows: readonly string[]): string {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  let paths = "";
  for (const [ch, color] of Object.entries(ORNAMENT_PALETTE)) {
    const d = iconPath(rows, ch);
    if (d) paths += `<path fill="${color}" d="${d}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">${paths}</svg>`;
}

/** The drawing as a CSS url() of a `data:` SVG. */
export function ornamentUrl(rows: readonly string[]): string {
  return `url("data:image/svg+xml,${encodeURIComponent(ornamentSvg(rows))}")`;
}

let cached: Record<string, string> | undefined;

/**
 * The CSS variables windows.css draws the ornaments with (set on .game by GameView): the
 * four corners, the spire, the stud and a row of studs. Computed once.
 */
export function ornamentStyle(): Record<string, string> {
  if (!cached) {
    const c = ORNAMENTS.corner;
    cached = {
      "--orn-corner-tl": ornamentUrl(c),
      "--orn-corner-tr": ornamentUrl(mirrored(c, true, false)),
      "--orn-corner-bl": ornamentUrl(mirrored(c, false, true)),
      "--orn-corner-br": ornamentUrl(mirrored(c, true, true)),
      "--orn-spire": ornamentUrl(ORNAMENTS.spire),
      "--orn-stud": ornamentUrl(ORNAMENTS.stud),
      // A stud every 24 pixels: the iron band along the bar's top repeats it.
      "--orn-studs": ornamentUrl(padded(ORNAMENTS.stud, 24)),
    };
  }
  return cached;
}
