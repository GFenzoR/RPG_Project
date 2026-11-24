// The living world's trail wear overlays (livingworld/README.md "Desgaste de senderos"):
// grass that players walk over a lot, in three stages, drawn over the grass ground by the
// client (livingworld/client wear.ts):
//   1 trampled   flattened, paler blades with a few specks of earth
//   2 worn       patches of the dirt ground showing through the flattened grass
//   3 bare dirt  the dirt ground, with a fringe of flattened grass at its edge
// Each stage has 16 shapes, one per set of worn neighbours (bits N 1, E 2, S 4, W 8): a
// side whose neighbour is worn too runs to the tile's edge, the others fade out in a
// broken edge (all pixels are opaque or transparent), so a path reads as one strip and a
// lone worn tile as a soft patch. The noise wraps every 32 px, like the grounds, so two
// worn tiles side by side join without a seam. The colours are those of ground/grass and
// ground/dirt (recipes/ground.ts). They are colour art, not masks: the client does not
// tint them. Paths livingworld/fx/trail_<stage>_<mask>.
import type { Image, Rgba } from "@rpg/spritepack";
import { hash2, px, tileNoise } from "../draw.ts";
import { hex } from "../palette.ts";
import type { Recipe, RecipeBook } from "../recipe.ts";

/** ground/dirt's ramp (recipes/ground.ts DIRT), darkest first. */
const DIRT = ["#2f241a", "#3a2d20", "#453626", "#51402d", "#5d4a34"].map(hex);
/** Flattened grass: ground/grass's greens, paler and drier (trodden blades lie flat). */
const TRODDEN = ["#2f4a24", "#3a5329", "#465c2e", "#536634", "#62703b"].map(hex);

/** The stages: how much of the middle is covered, and how much of it is earth. */
export const TRAIL_STAGES = [
  { cover: 0.78, earth: 0.14 },
  { cover: 0.92, earth: 0.5 },
  { cover: 1, earth: 0.9 },
] as const;

/** Worn-neighbour bits of a trail shape. */
export const TRAIL_N = 1;
export const TRAIL_E = 2;
export const TRAIL_S = 4;
export const TRAIL_W = 8;

/** How many pixels an open side takes to fade out. */
const FADE = 10;

function pick(colors: readonly Rgba[], t: number): Rgba {
  return colors[Math.max(0, Math.min(colors.length - 1, Math.floor(t * colors.length)))] as Rgba;
}

const fade = (dist: number): number => Math.min(1, Math.max(0, (dist + 0.5) / FADE));

/**
 * How far into the path (x, y) is, 0 at an open edge and 1 deep inside: each axis fades
 * toward its open sides, and two open sides meet in a rounded corner, not a square one.
 */
function inside(x: number, y: number, mask: number): number {
  let fx = 1;
  let fy = 1;
  if (!(mask & TRAIL_W)) fx = Math.min(fx, fade(x));
  if (!(mask & TRAIL_E)) fx = Math.min(fx, fade(31 - x));
  if (!(mask & TRAIL_N)) fy = Math.min(fy, fade(y));
  if (!(mask & TRAIL_S)) fy = Math.min(fy, fade(31 - y));
  return Math.max(0, 1 - Math.hypot(1 - fx, 1 - fy));
}

/** Draws stage (1..3) of the trail with worn neighbours `mask`. */
export function drawTrail(img: Image, stage: 1 | 2 | 3, mask: number): void {
  const { cover, earth } = TRAIL_STAGES[stage - 1] ?? TRAIL_STAGES[0];
  // Trodden blades lie along the path: streaks north-south on a path that only runs that
  // way, east-west otherwise.
  const upright = (mask & (TRAIL_N | TRAIL_S)) !== 0 && (mask & (TRAIL_E | TRAIL_W)) === 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      // A ragged edge: the noise moves the fade in and out where the side is open.
      const rag = (tileNoise(x, y, 8, 8, 41) - 0.5) * 0.7 + (tileNoise(x, y, 4, 4, 42) - 0.5) * 0.3;
      const deep = inside(x, y, mask);
      const c = Math.max(0, Math.min(1, deep + rag * (1 - deep)));
      // An irregular threshold (not an ordered dither): the edge breaks up like trodden
      // grass, without a grid.
      if (c * cover <= hash2(x, y, 40) * 0.7 + 0.1) continue;
      // Earth shows where the noise is low, more of it deeper inside the path.
      const n = tileNoise(x, y, 8, 8, 43) * 0.6 + tileNoise(x, y, 4, 4, 44) * 0.4;
      const grain = (tileNoise(x, y, 2, 2, 45) - 0.5) * 0.4;
      if (n < earth * (0.45 + 0.55 * c)) {
        px(img, x, y, pick(DIRT.slice(1, 4), (n / Math.max(earth, 0.01)) * 0.6 + grain + 0.2));
        // Clods: a lit pixel here and there.
        if (stage > 1 && hash2(x, y, 46) < 0.04) px(img, x, y, DIRT[4] as Rgba);
      } else {
        const streak = upright ? tileNoise(x, y, 2, 8, 47) : tileNoise(x, y, 8, 2, 47);
        px(img, x, y, pick(TRODDEN, streak * 0.8 + grain + 0.1));
      }
    }
}

const trail = (stage: 1 | 2 | 3, mask: number): Recipe => ({
  kind: "effect",
  draw: (img) => drawTrail(img, stage, mask),
});

export const TRAIL: RecipeBook = Object.fromEntries(
  ([1, 2, 3] as const).flatMap((stage) =>
    Array.from({ length: 16 }, (_, mask) => [
      `livingworld/fx/trail_${stage}_${mask}`,
      trail(stage, mask),
    ]),
  ),
);
