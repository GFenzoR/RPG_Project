// The look of the portals of portals.yaml (docs/02 "Cambiar de piso"): map objects drawn
// over the ground in 3/4 view, lit from the top-left, like the rest of the decoration. The
// stairs come from the Dungeon Crawl pack; ladders, holes, rope spots and teleports are
// ours. None of them moves anyone: the item only shows where the portal is. The teleport
// is animated (docs/17 ART-7: 6 frames of 100 ms, in step all over the world): its sprite
// is frame 0 and decor/teleport/frame_<n> the others (timing in assets/sprites.yaml
// `tiles`).
import type { Image, Rgba } from "@rpg/spritepack";
import {
  canvas,
  composite,
  cylinderLight,
  eachInEllipse,
  eachInRect,
  hash2,
  line,
  outline,
  px,
  rect,
  shadeOf,
  SHADOW,
  tileNoise,
} from "../draw.ts";
import type { Rng } from "../draw.ts";
import { hex, material, mix, PALETTE } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";

const { wood, darkWood, darkIron, dirt, rock, darkStone } = PALETTE;

/** The dark of a shaft seen from above: warm near-black, never pure black. */
const PIT: Rgba = hex("#140f0c");

/** Light falling from an opening above (rope spot): pale and warm. */
const DAYLIGHT = material("#fbf3cf", "#efe0a6", "#d8c584", "#b8a466");

/** The glow of a teleport: teal light over a violet swirl. */
const ARCANE = material("#d9fbff", "#7fe0ea", "#3fa3c2", "#2b5f93");
const VOID = material("#7a4fb0", "#55348a", "#3a2266", "#241545");

// ---- ladder --------------------------------------------------------------------------

/** One rail of a ladder from (x0, y0) at the bottom to (x1, y1) at the top, 2 px wide. */
function rail(img: Image, x0: number, y0: number, x1: number, y1: number, lit: boolean): void {
  for (let y = y1; y <= y0; y++) {
    const t = (y0 - y) / Math.max(1, y0 - y1);
    const x = Math.round(x0 + (x1 - x0) * t);
    px(img, x, y, lit ? wood.light : wood.base);
    px(img, x + 1, y, lit ? wood.base : wood.shadow);
  }
}

/**
 * A wooden ladder leaning against an opening of the floor above: two rails that narrow a
 * little toward the top (it leans away from the viewer), rungs every 4 px, and where its
 * feet rest, a little shadow on the ground. Climbed by hand (portals.yaml `ladder` leading
 * up).
 */
function ladderUp(img: Image, _rand: Rng, seed: number): void {
  // The feet's shadow first: the ladder covers most of it.
  for (const x of [8, 21]) {
    rect(img, x + 1, 30, 3, 1, SHADOW);
    px(img, x + 2, 29, SHADOW);
  }
  const lad = canvas(32, 32);
  rail(lad, 7, 30, 9, 1, true);
  rail(lad, 23, 30, 21, 1, false);
  for (let y = 4; y <= 28; y += 4) {
    const t = (30 - y) / 29;
    const l = Math.round(9 + 2 * t);
    const r = Math.round(22 - 2 * t);
    for (let x = l; x <= r; x++) {
      const grain = (hash2(x >> 1, y, seed) - 0.5) * 0.2;
      px(lad, x, y, shadeOf(wood, 0.8 + grain));
      px(lad, x, y + 1, wood.shadow);
    }
  }
  // Rope lashings where the top rungs meet the rails.
  for (const y of [4, 8]) {
    px(lad, 9, y, PALETTE.rope.light);
    px(lad, 22, y, PALETTE.rope.shadow);
  }
  outline(lad, { amount: 0.55 });
  composite(img, lad);
}

/** A plank frame around a square opening of (x, y, w, h), its top face lit. */
function hatchFrame(img: Image, x: number, y: number, w: number, h: number, seed: number): void {
  eachInRect(x - 2, y - 2, w + 4, h + 4, (qx, qy) => {
    const inner = qx >= x && qx < x + w && qy >= y && qy < y + h;
    if (inner) return;
    const grain = (tileNoise(qx * 3, qy, 8, 1, seed) - 0.5) * 0.3;
    let level = 0.5 + grain;
    if (qy === y - 2 || qx === x - 2) level = 0.85;
    else if (qy === y + h + 1 || qx === x + w + 1) level = 0.15;
    px(img, qx, qy, shadeOf(darkWood, level));
  });
  for (const [qx, qy] of [
    [x - 1, y - 1],
    [x + w, y - 1],
    [x - 1, y + h],
    [x + w, y + h],
  ] as const)
    px(img, qx, qy, darkIron.light);
}

/**
 * The top of a ladder: an open hatch in the floor, its lid swung back to the north on
 * iron hinges, and the ladder going down into the dark. Climbed down by hand (portals.yaml
 * `ladder` leading down).
 */
function ladderDown(img: Image, _rand: Rng, seed: number): void {
  const hx = 9;
  const hy = 15;
  const hw = 14;
  const hh = 12;
  // The lid, open and lying back: its planks seen from above, with the hinges below.
  eachInRect(hx - 1, 3, hw + 2, 9, (x, y) => {
    const plank = Math.floor((x - hx + 1) / 4);
    const tone = (hash2(plank, 1, seed) - 0.5) * 0.2;
    let level = 0.5 + tone + (tileNoise(x, y * 3, 2, 8, seed) - 0.5) * 0.2;
    if ((x - hx + 1) % 4 === 3) level = 0.2;
    if (y === 3) level = 0.85;
    if (y === 11) level = 0.12;
    px(img, x, y, shadeOf(wood, level));
  });
  for (const x of [hx + 2, hx + hw - 3]) {
    rect(img, x, 10, 2, 3, darkIron.base);
    px(img, x, 10, darkIron.light);
  }
  outline(img, { amount: 0.5 });
  const hatch = canvas(32, 32);
  hatchFrame(hatch, hx, hy, hw, hh, seed);
  // The shaft: the far (north) wall in light, then the dark below.
  eachInRect(hx, hy, hw, hh, (x, y) => {
    const d = y - hy;
    const c =
      d === 0
        ? darkStone.shadow
        : d < 3
          ? darkStone.deep
          : mix(darkStone.deep, PIT, Math.min(1, (d - 2) / 4));
    px(hatch, x, y, c);
  });
  // The ladder inside: rails and rungs fading into the dark.
  for (let y = hy; y < hy + hh; y++) {
    const fade = (y - hy) / hh;
    const c = mix(wood.base, PIT, fade * 1.1 > 1 ? 1 : fade * 1.1);
    px(hatch, hx + 3, y, c);
    px(hatch, hx + hw - 4, y, mix(wood.shadow, PIT, Math.min(1, fade * 1.1)));
  }
  for (const y of [hy + 1, hy + 4, hy + 7, hy + 10]) {
    const fade = Math.min(1, ((y - hy) / hh) * 1.15);
    line(hatch, hx + 4, y, hx + hw - 5, y, mix(wood.light, PIT, fade));
  }
  outline(hatch, { amount: 0.45 });
  composite(img, hatch);
}

// ---- hole ----------------------------------------------------------------------------

/**
 * A hole in the ground: an uneven dark opening whose far (north) wall shows earth and
 * rock in the light, a crumbling lip of loose earth and pebbles around it. Stepped into
 * (portals.yaml `hole`, it only leads down).
 */
function hole(img: Image, _rand: Rng, seed: number): void {
  const cx = 16;
  const cy = 18;
  const rx = 12;
  const ry = 9;
  // Uneven edge: the radius wobbles with the angle.
  const edge = (nx: number, ny: number): number => {
    const a = Math.atan2(ny, nx);
    return 1 + Math.sin(a * 3 + (seed % 7)) * 0.08 + Math.sin(a * 5 + 1.3) * 0.06;
  };
  // The lip: a ring of loose earth, lit on the far side, darker at the front.
  eachInEllipse(cx, cy, rx + 2.5, ry + 2.5, (x, y, nx, ny) => {
    const r = Math.hypot(nx, ny) / edge(nx, ny);
    if (r > 1) return;
    const n = tileNoise(x, y, 2, 2, seed) - 0.5;
    const level = 0.5 - ny * 0.25 + n * 0.5;
    px(img, x, y, shadeOf(dirt, level));
  });
  // The opening: in each column, the far (north) wall seen in the light just under the
  // lip, darker the deeper it goes, then the dark of the shaft.
  const open = (x: number, y: number): boolean => {
    const nx = (x + 0.5 - cx) / rx;
    const ny = (y + 0.5 - cy) / ry;
    return Math.hypot(nx, ny) / edge(nx, ny) <= 1;
  };
  for (let x = cx - rx - 1; x <= cx + rx + 1; x++) {
    let top = -1;
    for (let y = cy - ry - 1; y <= cy + ry + 1; y++) {
      if (!open(x, y)) continue;
      if (top < 0) top = y;
      const d = y - top;
      const strata = tileNoise(x * 2, y * 4, 8, 2, seed + 3) - 0.5;
      const level = 0.62 - d * 0.16 + strata * 0.3;
      px(img, x, y, d > 4 || level < 0.08 ? PIT : shadeOf(dirt, level));
    }
  }
  // Pebbles on the lip.
  for (let i = 0; i < 9; i++) {
    const a = hash2(i, 5, seed) * Math.PI * 2;
    const x = Math.round(cx + Math.cos(a) * (rx + 2));
    const y = Math.round(cy + Math.sin(a) * (ry + 2));
    px(img, x, y, rock.light);
    px(img, x + 1, y, rock.shadow);
  }
  // A root hanging over the far edge.
  for (const [x, y] of [
    [19, 10],
    [20, 11],
    [20, 12],
    [21, 13],
  ] as const)
    px(img, x, y, PALETTE.bark.base);
  outline(img, { amount: 0.5 });
}

// ---- rope spot -------------------------------------------------------------------------

/**
 * Under an opening of the floor above: a patch of daylight on the ground, dithered toward
 * its edge (sprites have no alpha), a few long rays falling into it from above, and grit
 * and pebbles fallen through. A rope climbs it (portals.yaml `rope_spot`, it only leads up).
 */
function ropeSpot(img: Image, _rand: Rng, seed: number): void {
  const cx = 16;
  const cy = 22;
  const rx = 12;
  const ry = 7;
  // The rays: a few slanted streaks from the top of the tile down to the patch (the light
  // comes from the top-left, like every other light).
  const rays: [number, number][] = [
    [-7, 2],
    [-3, 4],
    [1, 2],
    [5, 3],
    [8, 1],
  ];
  for (const [dx, gap] of rays) {
    for (let y = 2; y < cy; y++) {
      const t = y / cy; // 0 at the top, 1 at the patch
      const x = Math.round(cx + dx + (t - 1) * 3);
      if ((y + dx) % (gap + 1) === 0 && t < 0.35) continue; // thinner far up
      if (hash2(x, y, seed) < 0.25 - t * 0.2) continue;
      px(img, x, y, t > 0.55 ? DAYLIGHT.light : DAYLIGHT.base);
    }
  }
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) => {
    const r = Math.hypot(nx, ny);
    const n = (hash2(x, y, seed + 1) - 0.5) * 0.15;
    if (r < 0.6) px(img, x, y, shadeOf(DAYLIGHT, 1 - r * 0.45 + n));
    else if (r < 0.82) {
      if ((x + y) % 2 === 0 || r < 0.68) px(img, x, y, shadeOf(DAYLIGHT, 0.55 + n));
    } else if ((x + y) % 2 === 0 && (x + (y >> 1)) % 2 === 0) px(img, x, y, DAYLIGHT.shadow);
  });
  // Grit and pebbles fallen through, on the patch.
  for (const [x, y] of [
    [11, 23],
    [20, 24],
  ] as const) {
    px(img, x, y, rock.light);
    px(img, x + 1, y, rock.shadow);
  }
  px(img, 17, 20, DAYLIGHT.deep);
  px(img, 14, 25, DAYLIGHT.deep);
}

// ---- teleport --------------------------------------------------------------------------

/** A short carved standing stone with a glowing rune, its base at (x, y); `lit` brightens it. */
function runeStone(img: Image, x: number, y: number, seed: number, lit: boolean): void {
  const s = canvas(32, 32);
  eachInRect(x - 1, y - 5, 3, 6, (qx, qy) => {
    const u = (qx + 0.5 - x - 0.5) / 1.5;
    const level = cylinderLight(u) + (hash2(qx, qy, seed) - 0.5) * 0.2 - (qy === y ? 0.2 : 0);
    px(s, qx, qy, shadeOf(darkStone, level));
  });
  px(s, x, y - 6, darkStone.light); // rounded top
  px(s, x, y - 3, lit ? ARCANE.light : ARCANE.base); // the rune
  px(s, x, y - 2, lit ? ARCANE.base : ARCANE.shadow);
  outline(s, { amount: 0.5 });
  composite(img, s);
}

/** Frames of the teleport's loop (docs/17 ART-7: 6–8 of 100 ms, `sync: world`). */
export const TELEPORT_FRAMES = 6;
/** One seed for every frame (each frame's path would give its own): only the motion changes. */
const TELEPORT_SEED = 0x7e1e;

/**
 * A ring of carved stones around a swirl of light: a violet whirl with teal arms that
 * turn toward a white heart. Stepped into (portals.yaml `teleport`). Frame `f` of
 * TELEPORT_FRAMES: the arms turn half a turn over the loop (two arms: it closes), the
 * sparks rise and the heart and the runes pulse.
 */
function teleport(img: Image, f: number): void {
  const seed = TELEPORT_SEED;
  const phase = (f / TELEPORT_FRAMES) * Math.PI * 2;
  const cx = 16;
  const cy = 19;
  const rx = 10;
  const ry = 7;
  // The floor of the circle: worn dark flagstones.
  eachInEllipse(cx, cy, rx + 2, ry + 2, (x, y) => {
    const n = tileNoise(x, y, 4, 3, seed) - 0.5;
    px(img, x, y, shadeOf(darkStone, 0.3 + n * 0.4));
  });
  // The swirl: two spiral arms over a violet whirl, brighter toward the heart.
  eachInEllipse(cx, cy, rx, ry, (x, y, nx, ny) => {
    const r = Math.hypot(nx, ny);
    const a = Math.atan2(ny, nx);
    const arm = Math.cos(2 * a - r * 7 + 0.6 - phase); // two arms, turning inward
    const heart = 0.18 + 0.05 * Math.cos(phase * 2);
    if (r < heart) px(img, x, y, ARCANE.light);
    else if (arm > 0.55 - r * 0.2) px(img, x, y, shadeOf(ARCANE, 0.9 - r * 0.9));
    else px(img, x, y, shadeOf(VOID, 0.75 - r * 0.6 + (hash2(x, y, seed) - 0.5) * 0.15));
  });
  // Sparks rising from the whirl: 2 px a frame, back down after 12 (the loop's length).
  for (const [x, y] of [
    [13, 11],
    [19, 9],
    [17, 13],
    [11, 15],
    [22, 14],
    [16, 7],
  ] as const) {
    const up = y - ((f * 2 + (x % 3) * 4) % 12) + 4;
    if (up < 2) continue;
    px(img, x, up, up < 9 ? ARCANE.light : ARCANE.base);
  }
  // The stones: around the ellipse, the far ones first so the near ones cover them.
  const stones: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 6 + Math.PI / 6;
    stones.push([Math.round(cx + Math.cos(a) * (rx + 2)), Math.round(cy + Math.sin(a) * (ry + 2))]);
  }
  stones.sort((a, b) => a[1] - b[1]);
  // The runes light one after the other around the ring.
  stones.forEach(([x, y], i) => runeStone(img, x, y, seed, i % 3 === f % 3));
}

/** The teleport and its frames (decor/teleport is frame 0). */
function teleportFrames(): RecipeBook {
  const book: RecipeBook = {};
  for (let f = 0; f < TELEPORT_FRAMES; f++)
    book[f === 0 ? "decor/teleport" : `decor/teleport/frame_${f}`] = {
      kind: "object",
      draw: (img) => teleport(img, f),
    };
  return book;
}

export const PORTALS: RecipeBook = {
  "decor/ladder_up": { kind: "object", draw: ladderUp },
  "decor/ladder_down": { kind: "object", draw: ladderDown },
  "decor/hole": { kind: "object", draw: hole },
  "decor/rope_spot": { kind: "object", draw: ropeSpot },
  ...teleportFrames(),
};
