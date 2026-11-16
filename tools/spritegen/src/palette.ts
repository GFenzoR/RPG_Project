// Named materials, four shades each (highlight, base, shadow, deep shadow) plus an outline
// colour: a darker version of the deep shade, never pure black. Tuned to sit next to the
// Dungeon Crawl tiles (dark saturated grass, warm browns, grey metals). assets/README.md.
import type { Rgba } from "@rpg/spritepack";

export interface Material {
  /** Lit from the top-left: top faces, rims. */
  light: Rgba;
  /** The local colour. */
  base: Rgba;
  /** Faces turned away from the light (the south face in 3/4 view). */
  shadow: Rgba;
  /** Creases, the far edge, the bottom row. */
  deep: Rgba;
  /** The 1px outline around a shape of this material. */
  outline: Rgba;
}

export function hex(h: string): Rgba {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255];
}

/** Linear blend of two colours (t = 0 gives a, 1 gives b); alpha stays opaque. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const c = (i: number): number => Math.round((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * t);
  return [c(0), c(1), c(2), 255];
}

/** Multiplies the colour by (1 - amount): 0.3 is 30% darker. */
export function darken(c: Rgba, amount: number): Rgba {
  const k = 1 - amount;
  return [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k), 255];
}

/** Moves the colour toward white by amount (0..1). */
export function lighten(c: Rgba, amount: number): Rgba {
  return mix(c, [255, 255, 255, 255], amount);
}

/** A material from four hex shades; the outline is the deep shade 45% darker. */
export function material(light: string, base: string, shadow: string, deep: string): Material {
  const d = hex(deep);
  return {
    light: hex(light),
    base: hex(base),
    shadow: hex(shadow),
    deep: d,
    outline: darken(d, 0.45),
  };
}

/** Shades as an array, lightest first: handy for noise textures (pick by index). */
export function shades(m: Material): [Rgba, Rgba, Rgba, Rgba] {
  return [m.light, m.base, m.shadow, m.deep];
}

export const PALETTE = {
  // Woods
  wood: material("#b38a58", "#8c6840", "#674a2b", "#47321c"),
  darkWood: material("#7f5d3c", "#5e432a", "#43301e", "#2d2014"),
  /** Grey, sun-bleached planks: docks, piers, old crates. */
  weatheredWood: material("#958a74", "#73695c", "#544c43", "#39342e"),
  bark: material("#7a6047", "#5a4532", "#3f3023", "#2a2018"),
  // Stone and earth
  /** Field rock: a little darker and greener than cut stone. */
  rock: material("#9c998e", "#78766d", "#57554f", "#3b3a36"),
  stone: material("#a9a59b", "#86827a", "#64615b", "#46443f"),
  darkStone: material("#77736b", "#595650", "#403d39", "#2b2926"),
  dirt: material("#8d6a3f", "#6e5130", "#523b23", "#382817"),
  sand: material("#d6c08e", "#b9a271", "#957f55", "#6c5b3c"),
  // Volcanic island (T5.5)
  /** Fine grey volcanic ash: warmer and flatter than rock. */
  ash: material("#a39d93", "#8b857c", "#726d65", "#58544e"),
  /** Dark blue-grey basalt: the hexagonal column tops of the Brasal paving. */
  basalt: material("#6d717b", "#545861", "#40434b", "#2d2f36"),
  /** Crushed red-brown scoria: cinder paths. */
  cinder: material("#a3654c", "#7f4a39", "#5d352b", "#3e241e"),
  /** Cooled lava crust: near-black, a little warm. */
  lavaRock: material("#5a5251", "#403a3a", "#2f2a2b", "#1f1b1c"),
  // Metals
  iron: material("#b7bbbf", "#878c92", "#5e6369", "#3d4147"),
  darkIron: material("#6f747a", "#4f5359", "#373a3f", "#24262a"),
  copper: material("#d69c66", "#b0703e", "#7e4b27", "#533018"),
  silver: material("#e4e6e8", "#b6babe", "#868a8f", "#5b5f64"),
  gold: material("#f2d372", "#d0a33b", "#9a7225", "#634715"),
  // Soft materials
  leather: material("#aa7c53", "#845b39", "#604027", "#402a19"),
  cloth: material("#dacfae", "#b9ab88", "#908265", "#665b46"),
  redCloth: material("#bb5650", "#8f3c37", "#672a27", "#451b1a"),
  blueCloth: material("#6181a6", "#466381", "#324862", "#213145"),
  rope: material("#d2b77d", "#ad935b", "#836d40", "#5a4a2b"),
  paper: material("#eee2c0", "#d5c69c", "#ae9f77", "#7f7255"),
  // Plants (grass matches the dark green of the Dungeon Crawl grass tiles)
  grass: material("#3f7a32", "#2a6024", "#1c4a1a", "#123512"),
  foliage: material("#5f8a3a", "#436d2b", "#2f5120", "#1e3716"),
  pine: material("#4a7a40", "#30592f", "#1f4022", "#132a16"),
  moss: material("#7d8c45", "#5f6e32", "#465224", "#2e3717"),
  // Creatures
  skin: material("#e8c09a", "#c99a74", "#a07253", "#6f4c35"),
  fur: material("#9a8670", "#76654f", "#554838", "#382f25"),
  bone: material("#ece4cf", "#cfc4a6", "#a69a7c", "#776d55"),
  feather: material("#f0f0ea", "#cfd0ca", "#a3a6a2", "#727673"),
  // Liquids and glows
  water: material("#5d93b5", "#3e7398", "#2c5677", "#1d3b55"),
  ember: material("#ffd36b", "#f39a35", "#c4581f", "#7e2e12"),
} as const satisfies Record<string, Material>;

export type MaterialName = keyof typeof PALETTE;
