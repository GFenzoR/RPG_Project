// The art direction of docs/17 §1-§3 as data, in one place: every engine renderer, gate and
// contact sheet reads its rules from here, so changing the look is one edit. Each block names
// the rule it encodes (ART-n, ANI-n) and the reference it comes from (docs/17 §1, "Motor de
// sprites"). Nothing here was taken from another game's sprites: these are style rules only.
import { normalize, rad } from "./math.ts";
import type { Vec3 } from "./math.ts";

export type Dir = "n" | "e" | "s" | "w";
export type ActionName = "idle" | "walk" | "attack" | "shoot" | "cast" | "death";
/** The shades of a palette.ts material, lightest first, plus its outline. */
export type Tone = "light" | "base" | "shadow" | "deep" | "outline";
/** What a sprite is, for the outline policy and the value band. */
export type SpriteKind = "creature" | "object";

/**
 * ART-1 (and the LPC style guide of docs/17 §1): orthographic 3/4 front view. Heights rise
 * straight up on screen at 1 px per unit; the camera sits 60 degrees from the vertical, so a
 * unit of depth (north, away from the camera) shows as tan(30°) ≈ 0.58 rows: you see the top
 * and the south face of everything. Model units are sprite pixels.
 */
export const PROJECTION = {
  cameraFromVerticalDeg: 60,
  depth: Math.tan(rad(90 - 60)),
} as const;

/** The view direction (from the camera into the scene) in model space: north and down. */
export const VIEW_DIR: Vec3 = normalize([0, 1, -PROJECTION.depth]);

/**
 * ART-5 (LPC: light from the top and a little from the left): the light comes from above,
 * from the left and a little from the camera's side, so a creature's flank facing the camera
 * reads as the base tone, its back as the light one and its belly and right side as the deep
 * one. level = (n·L + wrap) / span, the same curve as draw.ts domeLight, so engine sprites and
 * the hand-written recipes share their light. depthCue darkens what is farther from the
 * camera (a far leg, the hind quarters seen from the front), up to that much at the back.
 */
export const LIGHT = {
  dir: normalize([-0.5, -0.45, 0.75]),
  wrap: 0.35,
  span: 1.25,
  depthCue: 0.2,
} as const;

/**
 * ART-5 "3-4 tones per material plus a highlight": a light level picks one of the four
 * shades of a palette.ts material by these thresholds (draw.ts shadeOf uses the same).
 * Shiny parts (eyes, wet noses, metal) also get a glint, their light shade lightened, where
 * the light reflects straight at the camera.
 */
export const SHADES = {
  light: 0.75,
  base: 0.45,
  shadow: 0.2,
  glint: { above: 0.92, lighten: 0.35 },
} as const;

/** The level of the shades, for a glowing part (fire): brightest where it faces the camera. */
export const GLOW = { core: 0.9, rim: 0.05 } as const;

/**
 * ART-5 selective outline, 1 px around the silhouette in a dark tone of the local material:
 * creatures and characters get the darkest tone (near black, never #000) on the shadow side
 * (below and to the right) and a lighter one on the lit side (above and to the left); objects
 * a softer one. `crease` is the line drawn on the farther part where two parts overlap with
 * a gap in depth of at least CREASE_DEPTH px (a near leg over the body): the internal outline.
 * Grounds have none (they are not engine sprites).
 */
export const OUTLINE: Record<SpriteKind, { lit: Tone; dark: Tone; crease: Tone }> = {
  creature: { lit: "deep", dark: "outline", crease: "deep" },
  object: { lit: "shadow", dark: "deep", crease: "shadow" },
};
export const CREASE_DEPTH = 2.5;

/**
 * Fire (a `glow` part) keeps its own outline in any sprite: its deep shade (the red rim of a
 * flame) on the lit side and its outline (a dark ember) on the shadow side, so a fire spirit
 * stands out from rock and ash the way a flame does (docs/17 ART-5, ART-6: a glow reads by
 * its hot core against a dark edge). Its crease, where a nearer glowing part overlaps it (an
 * arm before the chest), is its shadow shade: a darker flame, never a black line.
 */
export const GLOW_OUTLINE: { lit: Tone; dark: Tone; crease: Tone } = {
  lit: "deep",
  dark: "outline",
  crease: "shadow",
};

/**
 * ART-5 light from the top-left, on the silhouette: a pixel of the figure with nothing above
 * it or to its left (the lit rim, just inside the lighter outline) is this many shades
 * lighter. It is what makes a round back or a head read as lit from that side at 1x.
 */
export const RIM_LIGHT = 1;

/**
 * ART-6: dithering never makes a gradient; as an intentional texture at most 10 % of the
 * pixels. The engine never dithers (shades are hard thresholds and a cleanup pass removes
 * lone pixels); the gate measures checkerboard pixels against this share.
 */
export const DITHER_MAX_SHARE = 0.1;

/** ART-6 value bands (L* of CIELAB): the mean of a sprite's opaque pixels. */
export const VALUE_BAND: Record<SpriteKind, readonly [number, number]> = {
  creature: [10, 85],
  object: [25, 65],
};

/**
 * ART-2 sizes and anchors: the canvas a class of sprite is drawn on, where it is anchored on
 * its tile, and the size of the figure (the opaque box of its frames, outline included) the
 * gates accept. `ground` is the canvas row of the model origin (the middle of the feet): far
 * enough from the bottom for the near feet and the outline when the creature faces the
 * camera. bc = feet centred on the tile (the client measures `foot`), br = bottom-right.
 */
export interface SizeClass {
  kind: SpriteKind;
  canvases: readonly (readonly [number, number])[];
  anchor: "bc" | "br";
  /** Rows above the canvas bottom of the model origin. */
  ground: number;
  /** Figure height and width ranges (px), when the rule gives them. */
  height?: readonly [number, number];
  width?: readonly [number, number];
}

export const SIZES = {
  /** Rat, bat, beetle: a 16-28 px figure on 32x32, feet centred. */
  smallCreature: {
    kind: "creature",
    canvases: [[32, 32]],
    anchor: "bc",
    ground: 6,
    height: [10, 28],
    width: [12, 30],
  },
  /**
   * Wolf, boar, deer, hound, spider, toad on 64x64, measured against the LPC person
   * (~46 px, ~25 px per metre; docs/17 ART-2 "Animales medianos").
   */
  mediumAnimal: {
    kind: "creature",
    canvases: [[64, 64]],
    anchor: "bc",
    ground: 11,
    height: [16, 50],
    width: [24, 56],
  },
  /** Player, NPC, bandit: 64x64 frames, a 40-48 px figure (1.25 to 1.5 tiles), like LPC. */
  humanoid: {
    kind: "creature",
    canvases: [[64, 64]],
    anchor: "bc",
    ground: 9,
    height: [40, 50],
    width: [16, 48],
  },
  /** Big creature or boss: 64x64 or 96x96, feet centred. */
  bigCreature: {
    kind: "creature",
    canvases: [
      [64, 64],
      [96, 96],
    ],
    anchor: "bc",
    ground: 10,
    height: [36, 90],
  },
  /** Furniture and objects (table, chest, anvil): 32x32 or 32x64, bottom-right of the tile. */
  object: {
    kind: "object",
    canvases: [
      [32, 32],
      [32, 64],
      [64, 64],
    ],
    anchor: "br",
    ground: 10,
  },
} as const satisfies Record<string, SizeClass>;

export type SizeName = keyof typeof SIZES;

/**
 * ANI-2 actions: frames per facing and timing. idle loops by time (ms per frame), walk by
 * distance (spritepack gives it 2 frames per tile: a cycle every 2 steps), the rest play once
 * in `total` ms. ANI-4 names the frames <sprite>/<action>_<dir>_<n>.
 */
export const ACTIONS: Record<
  ActionName,
  {
    frames: readonly [number, number];
    loop: boolean;
    ms?: readonly [number, number];
    total?: readonly [number, number];
  }
> = {
  idle: { frames: [2, 4], loop: true, ms: [400, 600] },
  walk: { frames: [2, 4], loop: true },
  attack: { frames: [3, 4], loop: false, total: [300, 400] },
  shoot: { frames: [3, 3], loop: false, total: [280, 320] },
  cast: { frames: [3, 4], loop: false, total: [360, 440] },
  death: { frames: [4, 6], loop: false, total: [500, 700] },
};

/**
 * ANI-1: four facings. A model is built facing west (its nose toward -x, like the profile
 * drawings) and turned about the vertical by this many degrees for each facing. All four are
 * rendered from the model, so the east one keeps the light on the left (a mirrored west would
 * light it from the right) and no `mirror` hint is needed.
 */
export const FACING_YAW: Record<Dir, number> = { w: 0, s: 90, e: 180, n: 270 };
export const DIRS: readonly Dir[] = ["s", "w", "n", "e"];

/** ANI-4: the atlas name of a frame. */
export const frameName = (sprite: string, action: ActionName, dir: Dir, n: number): string =>
  `${sprite}/${action}_${dir}_${n}`;

/**
 * The renderer's contact shadow and feet line (packages/renderer/src/anim.ts; a test keeps
 * both equal): the contact sheet draws frames the way the client does.
 */
export const CLIENT = { feetLine: 4, shadowW: 20, shadowH: 6, shadowAlpha: 0.35 } as const;
