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
  /** Fine grey volcanic ash: warmer and flatter than rock, and no lighter than a ground may be
   * (docs/17 ART-6, L* 20-50): the plains of the Isla Volcánica are not the brightest thing on
   * screen. */
  ash: material("#858077", "#706c64", "#5c5852", "#46433f"),
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
  /** The bristleback boar (engine/specs/boar.ts): dark brown hide, pale crest, pink snout. */
  boarFur: material("#7c6350", "#5c4738", "#423328", "#2b211a"),
  bristle: material("#b3a289", "#8f7e67", "#6b5c4a", "#493e32"),
  snout: material("#c49484", "#a07364", "#7a5446", "#52372d"),
  hoof: material("#5a5048", "#3f3832", "#2c2723", "#1d1a17"),
  /** The bramble stag (engine/specs/stag.ts): red coat, pale belly, thorn-wood antlers. */
  stagCoat: material("#b8814f", "#935f36", "#6b4325", "#462b17"),
  stagBelly: material("#e4d2b0", "#c8b48e", "#a08b69", "#76654b"),
  thornWood: material("#6e5440", "#4f3a2b", "#38291e", "#251b13"),
  berry: material("#f07a72", "#d8343a", "#a32228", "#6e171b"),
  /** Eyes and nostrils: near black, a little warm; shiny parts get a glint. */
  eye: material("#4a3c38", "#2e2422", "#211918", "#161010"),
  // Liquids and glows
  water: material("#5d93b5", "#3e7398", "#2c5677", "#1d3b55"),
  ember: material("#ffd36b", "#f39a35", "#c4581f", "#7e2e12"),
  /**
   * The forge echo (engine/specs/forge-echo.ts): a white-hot core (body, head, arms) inside
   * flames that go from yellow to orange to a red rim (hair, beard, tongues, the tail).
   */
  fireCore: material("#fff8d8", "#ffe070", "#ffab30", "#f0661c"),
  flame: material("#ffd447", "#ff9021", "#e9511a", "#b3260f"),
  // Equipment icons (engine/specs/items, docs/17 "Íconos de items"): each level band of the
  // catalog has its own metal and accent, so a better piece reads as better at a glance.
  /** Band 1: pitted, rusty iron (the cutlass, the hatchet's head, hoops and nails). */
  rust: material("#b78a68", "#8d654a", "#664632", "#432d20"),
  /** Band 3: bright, cold forged steel with a blue cast. */
  steel: material("#dfe7ee", "#a9b5c1", "#76838f", "#4b5661"),
  /** Band 5: wyrmling scales, jade green. */
  wyrmScale: material("#8cc49a", "#5a9a72", "#3c7053", "#264a37"),
  /** Band 6: tidesteel, sea-blue steel, dark enough for its runes to glow on it. */
  tidesteel: material("#bfe2e8", "#7eb0bd", "#55808f", "#365766"),
  /** Band 6: the runes that light tidesteel (a `glow` part: brightest toward the camera). */
  rune: material("#b4fff6", "#45e3e8", "#1fa9c6", "#136f93"),
  /** Pearl and nacre: the pearlstorm wand, the pearlweave robe, the pommels of band 6. */
  pearl: material("#f8f3f5", "#dcd2dc", "#b0a4b5", "#7c7086"),
  /** Wood that spent centuries under the sea: dark blue-grey. */
  drownwood: material("#74838c", "#55626c", "#3d4750", "#283037"),
  /** White coral, still cold from the sea floor. */
  coral: material("#f4ece6", "#d9c9c2", "#ad9a95", "#7a6866"),
  /** Glass that keeps a lightning strike: violet blue (the stormglass wand). */
  stormglass: material("#dcd6ff", "#a093f2", "#6c5cc6", "#44388c"),
  /** Volcanic glass: near black with a violet sheen. */
  obsidian: material("#7a7088", "#4b4358", "#322c3c", "#1f1a27"),
  /** Ice that never melts: pale cyan crystal (the druid's staffs). */
  ice: material("#f2fbff", "#c2e7f6", "#88bfd9", "#5689a8"),
  /** Black ice from the volcano's basalt: dark blue. */
  blackIce: material("#93a9d8", "#5d72aa", "#3e4e7e", "#283357"),
  /** The spark wand's charge: a yellow-white crackle (a `glow` part). */
  spark: material("#fffbd0", "#ffe46e", "#f0b02e", "#b0711a"),
  /** Tarred, salt-stained leather: near black brown (the tarred boots). */
  tar: material("#806a57", "#5c4a3b", "#42352a", "#2b221b"),
  /** Robe cloths by band: moss green, ash grey, dusk violet and pearl white. */
  mossCloth: material("#a3b672", "#768f4d", "#556b36", "#384823"),
  ashCloth: material("#aea8a0", "#86817a", "#635f59", "#43403c"),
  duskCloth: material("#a28bc9", "#7761a2", "#55437a", "#372b53"),
  pearlCloth: material("#d9e1ec", "#a8b5c8", "#7a87a0", "#4e5972"),
  /** The emberheart ring's stone, a red that beats (a `glow` part). */
  heartstone: material("#ffd2c4", "#ff6a52", "#d8332d", "#8e1822"),
  // The forge's materials (engine/specs/forge-materials.ts, docs/02 "Forja"): the greater
  // temper stone's blue-grey whetstone, the radiant one's pale stone, and the warding amber.
  temperBlue: material("#a3b6c8", "#768a9e", "#566678", "#3a4653"),
  paleStone: material("#c8c3b3", "#a19c8d", "#7b776c", "#56534b"),
  amber: material("#ffd27a", "#e8a03a", "#b4661c", "#723c10"),
} as const satisfies Record<string, Material>;

export type MaterialName = keyof typeof PALETTE;
