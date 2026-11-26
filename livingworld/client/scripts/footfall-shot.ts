// A frame capture of the footprints under the feet (livingworld/README.md "Huellas"),
// without a browser: the engine humanoid's real walk frames (tools/spritegen) slide over
// sand the way the client draws them (packages/renderer anim.ts), the footfall tracker
// (src/gait.ts) drops the prints from data/livingworld/gaits.yaml, and the frames in which
// a foot lands are saved zoomed, the character solid on the left and see-through on the
// right, so each print can be checked against the foot over it.
// Usage: node --experimental-strip-types livingworld/client/scripts/footfall-shot.ts
//          [--out DIR] [--scale N]
// Writes footfalls-<path>.png for a walk east, south, south-east and north-west.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  animate,
  dirOf,
  newAnimInput,
  newAnimState,
  newPose,
  walkCyclesPerStep,
} from "../../../packages/renderer/src/anim.ts";
import type { AnimDir, AnimMeta } from "../../../packages/renderer/src/anim.ts";
import { parseYaml } from "../../../tools/spritepack/src/content.ts";
import {
  createImage,
  decodePng,
  encodePng,
  fillRect,
  scaleImage,
} from "../../../tools/spritepack/src/image.ts";
import type { Image } from "../../../tools/spritepack/src/image.ts";
import { box } from "../../../tools/spritegen/src/engine/gates.ts";
import { renderSpec } from "../../../tools/spritegen/src/engine/render.ts";
import {
  HUMANOID_DIRS,
  HUMANOID_LAYERS,
  HUMANOID_PER_TILE,
  HUMANOID_PER_TILE_NS,
  WALK_FRAMES,
} from "../../../tools/spritegen/src/engine/specs/humanoid/index.ts";
import { FootfallTracker, newWalkSample, parseGaits, printOffset } from "../src/gait.ts";

const ROOT = new URL("../../../", import.meta.url);
const T = 32;
const FEET_LINE = 4;
const SAND = [0xc9, 0xb0, 0x7a, 0xff] as const;
const TINT = [0x6e, 0x56, 0x34] as const; // data/livingworld/surfaces.yaml sand

const { values } = parseArgs({
  options: { out: { type: "string", default: "." }, scale: { type: "string", default: "5" } },
});
const scale = Number(values.scale);

const data = parseGaits(
  parseYaml(readFileSync(new URL("data/livingworld/gaits.yaml", ROOT), "utf8")),
);
const gait = data?.gaits["biped"];
if (!data || !gait) throw new Error("no biped gait in data/livingworld/gaits.yaml");
const print = decodePng(
  readFileSync(new URL("assets/livingworld/sprites/fx/footprint_feet.png", ROOT)),
);

const body = HUMANOID_LAYERS.find(
  (l) => l.slot === "body" && l.shape === "sturdy" && l.sex === "male",
);
if (!body) throw new Error("no body layer");
const spec = body.spec;
const frames = new Map<string, Image>();
const frameOf = (dir: AnimDir, f: number): Image => {
  const key = `${dir}:${f}`;
  let img = frames.get(key);
  if (!img) {
    img = renderSpec(spec, {
      action: "walk",
      dir: dir as (typeof HUMANOID_DIRS)[number],
      frame: f,
    });
    frames.set(key, img);
  }
  return img;
};
/** Empty rows under the lowest pixel of the walk frames (atlas.json `foot`). */
let foot = 64;
for (const dir of HUMANOID_DIRS)
  for (let f = 0; f < WALK_FRAMES; f++) {
    const b = box(frameOf(dir, f));
    if (b) foot = Math.min(foot, 63 - b[3]);
  }

const META: AnimMeta = {
  w: 64,
  h: 64,
  anchor: "bc",
  foot,
  top: 38,
  shadow: "none",
  actions: {
    walk: {
      frames: WALK_FRAMES,
      ms: 0,
      perTile: HUMANOID_PER_TILE,
      perTileNS: HUMANOID_PER_TILE_NS,
      dirs: [...HUMANOID_DIRS],
    },
  },
};

/** Source over: `src` onto `dst` at (dx, dy) with `alpha`, optionally tinted. */
function over(
  dst: Image,
  src: Image,
  dx: number,
  dy: number,
  alpha = 1,
  tint?: readonly [number, number, number],
): void {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      const ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      const s = (y * src.width + x) * 4;
      const a = ((src.data[s + 3] ?? 0) / 255) * alpha;
      if (a <= 0) continue;
      const d = (ty * dst.width + tx) * 4;
      for (let c = 0; c < 3; c++) {
        const v = ((src.data[s + c] ?? 0) * (tint ? tint[c as 0 | 1 | 2] : 255)) / 255;
        dst.data[d + c] = Math.round(v * a + (dst.data[d + c] ?? 0) * (1 - a));
      }
      dst.data[d + 3] = 255;
    }
}

/** `src` turned `rot` radians about its middle (nearest), as Pixi turns the print. */
function rotated(src: Image, rot: number): Image {
  const out = createImage(src.width, src.height);
  const c = src.width / 2;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;
      const sx = Math.floor(px * cos - py * sin + c);
      const sy = Math.floor(px * sin + py * cos + c);
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      out.data.set(
        src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4),
        (y * out.width + x) * 4,
      );
    }
  return out;
}

interface Mark {
  x: number;
  y: number;
  rot: number;
}

/** Walks `tiles` tiles along (dx, dy) and returns the scene at each footfall. */
function capture(name: string, dx: number, dy: number, tiles: number): void {
  const W = (Math.abs(dx) * tiles + 3) * T;
  const H = (Math.abs(dy) * tiles + 3) * T;
  const x0 = dx < 0 ? tiles + 1 : 1;
  const y0 = dy < 0 ? tiles + 1 : 1;
  const st = newAnimState(1, 0);
  const input = newAnimInput();
  const pose = newPose();
  const sample = newWalkSample();
  const tracker = new FootfallTracker(data?.viewDepth ?? 1);
  const marks: Mark[] = [];
  const spread = { x: 0, y: 0 };
  const shots: Image[] = [];
  const stepMs = 400;
  const dir = dirOf(dx, dy);
  for (let now = 0; now < tiles * stepMs; now += 1000 / 60) {
    const step = Math.floor(now / stepMs);
    const t = now / stepMs - step;
    const bx = Math.round((x0 + dx * (step + t)) * T);
    const by = Math.round((y0 + dy * (step + t)) * T);
    input.now = now;
    input.dir = dir;
    input.walkStart = step * stepMs;
    input.walkMs = stepMs;
    input.moveDx = dx;
    input.moveDy = dy;
    animate(st, META, input, pose);
    tracker.tick();
    sample.id = 1;
    sample.x = bx + T / 2;
    sample.y = by + T - FEET_LINE;
    sample.phase = pose.walk;
    sample.frames = WALK_FRAMES;
    sample.dx = dx;
    sample.dy = dy;
    sample.cyclePx = (T * Math.hypot(dx, dy)) / walkCyclesPerStep(META, input);
    sample.gait = gait;
    let landed = false;
    tracker.sample(sample, (f) => {
      // The print is drawn a little out to its foot's side (Gait.spread), as index.ts does.
      printOffset(f.dx, f.dy, f.side, f.gait.spread, spread);
      marks.push({ x: f.x + spread.x, y: f.y + spread.y, rot: f.rot });
      landed = true;
    });
    if (!landed || marks.length <= 2) continue;
    // The scene: sand, the prints so far, the character (solid, then see-through).
    for (const alpha of [1, 0.35]) {
      const scene = createImage(W, H);
      fillRect(scene, 0, 0, W, H, SAND);
      for (const m of marks)
        over(
          scene,
          rotated(print, m.rot),
          Math.round(m.x) - print.width / 2,
          Math.round(m.y) - print.height / 2,
          gait?.depth ?? 1,
          TINT,
        );
      const img = frameOf(dir, pose.frame);
      over(scene, img, bx + T / 2 - img.width / 2, by + T - FEET_LINE + foot - img.height, alpha);
      shots.push(scene);
    }
  }
  // The last four footfalls: one row each, solid on the left, see-through on the right.
  const rows = shots.slice(-8);
  const sheet = createImage(W * 2 + 2, (H + 2) * (rows.length / 2));
  fillRect(sheet, 0, 0, sheet.width, sheet.height, [20, 20, 20, 255]);
  rows.forEach((s, i) => over(sheet, s, (i % 2) * (W + 2), Math.floor(i / 2) * (H + 2)));
  const file = join(values.out, `footfalls-${name}.png`);
  mkdirSync(values.out, { recursive: true });
  writeFileSync(file, encodePng(scaleImage(sheet, scale)));
  console.log(`${file}: ${marks.length} footfalls over ${tiles} tiles`);
}

capture("east", 1, 0, 3);
capture("south", 0, 1, 3);
capture("south-east", 1, 1, 3);
capture("north-west", -1, -1, 3);
