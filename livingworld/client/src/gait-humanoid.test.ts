// The biped gait of data/livingworld/gaits.yaml against the engine humanoid as it is
// really drawn (tools/spritegen specs/humanoid): each foot's print must sit where that
// foot stands on the ground while it is planted, in the eight directions. The foot is
// rendered alone, frame by frame, and the middle of its drawing compared with the place
// the footfall tracker gives its print.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYaml } from "../../../tools/spritepack/src/content.ts";
import { box } from "../../../tools/spritegen/src/engine/gates.ts";
import { renderSpec } from "../../../tools/spritegen/src/engine/render.ts";
import {
  HUMANOID_DIRS,
  HUMANOID_LAYERS,
  HUMANOID_PER_TILE,
  HUMANOID_PER_TILE_DIAG,
  HUMANOID_PER_TILE_NS,
  HUMANOID_PER_TILE_NS_HOLD,
  WALK_FRAMES,
} from "../../../tools/spritegen/src/engine/specs/humanoid/index.ts";
import { PROJECTION } from "../../../tools/spritegen/src/engine/style.ts";
import { footOffset, parseGaits } from "./gait.ts";
import type { Gait, GaitData } from "./gait.ts";

const DATA = parseGaits(
  parseYaml(readFileSync(new URL("../../../data/livingworld/gaits.yaml", import.meta.url), "utf8")),
) as GaitData;
const BIPED = DATA.gaits["biped"] as Gait;

const body = HUMANOID_LAYERS.find(
  (l) => l.slot === "body" && l.shape === "sturdy" && l.sex === "male",
);
if (!body) throw new Error("no body layer");
const spec = body.spec;

/** A foot drawn alone: the middle of its drawing (the ground it covers), canvas pixels. */
function sole(foot: string, dir: (typeof HUMANOID_DIRS)[number], frame: number) {
  const img = renderSpec(
    { ...spec, sprite: "test/foot", layer: { draw: [foot], occlude: [] } },
    { action: "walk", dir, frame },
  );
  const b = box(img);
  if (!b) throw new Error(`no ${foot}`);
  return { x: (b[0] + b[2] + 1) / 2, y: (b[1] + b[3] + 1) / 2, width: img.width };
}

/** The lowest opaque row of the body's walk frames: the client's feet line (meta.foot). */
function feetLine(): number {
  let max = 0;
  for (const dir of HUMANOID_DIRS)
    for (let f = 0; f < WALK_FRAMES; f++) {
      const b = box(renderSpec(spec, { action: "walk", dir, frame: f }));
      if (b) max = Math.max(max, b[3]);
    }
  return max + 1;
}

describe("the biped gait against the engine humanoid's feet", () => {
  it("uses the sprite engine's view depth", () => {
    expect(DATA.viewDepth).toBeCloseTo(PROJECTION.depth, 3);
  });

  const line = feetLine();
  const FEET: [string, number][] = [
    ["foot_r", 1],
    ["foot_l", -1],
  ];
  for (const dir of HUMANOID_DIRS)
    it(`walking ${dir}: each print lies under its planted foot`, () => {
      const dx = dir.includes("e") ? 1 : dir.includes("w") ? -1 : 0;
      const dy = dir.includes("s") ? 1 : dir.includes("n") ? -1 : 0;
      const per =
        dx !== 0 && dy !== 0
          ? HUMANOID_PER_TILE_DIAG
          : dy !== 0
            ? HUMANOID_PER_TILE_NS
            : HUMANOID_PER_TILE;
      // Sprite px the body slides per walk frame, and per whole cycle, along (dx, dy).
      const len = Math.hypot(dx, dy);
      const perFrame = (32 * len) / per;
      const cyclePx = perFrame * WALK_FRAMES;
      // One cadence in every direction (specs/humanoid HUMANOID_PER_TILE_NS): facing north
      // or south, and on a diagonal, the planted foot slides forward under the body by what
      // the cadence that would hold it differs, per frame. The print lies in the middle of
      // that slide: the foot starts up to two frames of it behind and ends as far ahead.
      const hold =
        dx !== 0 && dy !== 0
          ? Math.hypot(HUMANOID_PER_TILE, HUMANOID_PER_TILE_NS_HOLD)
          : dy !== 0
            ? HUMANOID_PER_TILE_NS_HOLD
            : HUMANOID_PER_TILE;
      const near = 2.5 + 2 * Math.abs(perFrame - (32 * len) / hold);
      const print = { x: 0, y: 0 };
      for (const [foot, side] of FEET) {
        const contact = BIPED.contacts.find((c) => c.side === side);
        if (!contact) throw new Error("no contact");
        const first = Math.round(contact.at * WALK_FRAMES);
        // The print, from the body's place when the foot landed (the tracker's maths).
        footOffset(dx, dy, BIPED.reach * cyclePx, 0, side, BIPED.stance, DATA.viewDepth, print);
        print.y -= BIPED.rise;
        // The foot on the ground through its planted half of the cycle: where it is drawn
        // in each frame plus what the body has moved since the contact (the frame's middle).
        let mx = 0;
        let my = 0;
        const planted = WALK_FRAMES / 2;
        for (let k = 0; k < planted; k++) {
          const s = sole(foot, dir, (first + k) % WALK_FRAMES);
          const moved = (k + 0.5) * perFrame;
          const gx = s.x - s.width / 2 + (dx / len) * moved;
          const gy = s.y - line + (dy / len) * moved;
          // Frame by frame the sole stays by the print (east and west the stride rule holds
          // it there, within 2.5 px).
          expect(Math.abs(gx - print.x), `${dir} ${foot} frame ${k} x`).toBeLessThanOrEqual(near);
          expect(Math.abs(gy - print.y), `${dir} ${foot} frame ${k} y`).toBeLessThanOrEqual(near);
          mx += gx / planted;
          my += gy / planted;
        }
        expect(Math.abs(mx - print.x), `${dir} ${foot} x`).toBeLessThanOrEqual(1.75);
        expect(Math.abs(my - print.y), `${dir} ${foot} y`).toBeLessThanOrEqual(1.75);
      }
    });
});
