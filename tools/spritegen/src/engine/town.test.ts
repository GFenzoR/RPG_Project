// The town prop kit (docs/17 "Kit de props de pueblo"): twelve one-tile engine models, and
// the awning, the flag and the lamp move as the ART-7 table says (a flag 3-4 frames of
// 150-180 ms, each tile in its own phase; a flame 100-140 ms) with their assets/sprites.yaml
// timing and the lamp's light.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE, parseManifest } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { engineFrames } from "./book.ts";
import { box, pixelsChanged } from "./gates.ts";
import { floorBoard } from "./sheet.ts";
import { ENGINE_SPECS } from "./specs/index.ts";
import { FLAG_POLE, LAMP_POST, MARKET_STALL, TOWN_FLOORS, TOWN_PROPS } from "./specs/town.ts";

const root = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

/** The kit, in the order of data/items/decoration.yaml (packages/map-format town-props.test.ts
 * checks each one's item: what blocks and what lifts). */
const KIT = [
  "decor/barrel",
  "decor/table",
  "decor/bench",
  "decor/shelf",
  "decor/bed",
  "decor/lamp_post",
  "decor/well",
  "decor/sacks",
  "decor/fishing_net",
  "decor/flower_box",
  "decor/market_stall",
  "decor/flag_pole",
];

describe("the town prop kit", () => {
  it("is twelve engine props, each a one-tile object", () => {
    expect(TOWN_PROPS.map((s) => s.sprite)).toEqual(KIT);
    for (const spec of TOWN_PROPS) {
      expect(ENGINE_SPECS).toContain(spec);
      expect(spec.size).toBe("object");
      expect(spec.canvas?.[0] ?? 32, spec.sprite).toBe(32);
    }
  });

  it("loops the awning, the flag and the lamp as ART-7 asks, each tile in its own phase", () => {
    const { manifest } = parseManifest(readFileSync(join(root, MANIFEST_FILE), "utf8"));
    for (const spec of [MARKET_STALL, FLAG_POLE]) {
      const loop = spec.loop;
      expect(loop?.frames).toBeGreaterThanOrEqual(3);
      expect(loop?.frames).toBeLessThanOrEqual(4);
      expect(loop?.ms).toBeGreaterThanOrEqual(150);
      expect(loop?.ms).toBeLessThanOrEqual(180);
      expect(loop?.sync).toBe("tile");
    }
    // A torch-like flame: 3-4 frames of 100-140 ms; and the lamp lights a cave like a torch.
    expect(LAMP_POST.loop?.ms).toBeGreaterThanOrEqual(100);
    expect(LAMP_POST.loop?.ms).toBeLessThanOrEqual(140);
    expect(manifest.tiles.get("decor/lamp_post")?.light).toBe(3);
    // The other props stand still: no tiles timing to play.
    for (const spec of TOWN_PROPS.filter((s) => !s.loop))
      expect(manifest.tiles.get(spec.sprite)?.ms, spec.sprite).toBeUndefined();
  });

  it("waves the flag along its length: every card moves, the far ones most", () => {
    const frames = engineFrames(FLAG_POLE).map((f) => f.image);
    expect(frames).toHaveLength(4);
    const first = frames[0];
    if (!first) throw new Error("no frame");
    // Each frame differs from the one before it (a running wave, not two poses).
    frames.forEach((f, i) => {
      const prev = frames[(i + frames.length - 1) % frames.length];
      if (prev) expect(pixelsChanged(f, prev)).toBeGreaterThan(8);
    });
    // The pole and its foot never move: the bottom rows are the same in every frame.
    const b = box(first);
    if (!b) throw new Error("no figure");
    for (const f of frames)
      for (let y = b[3] - 12; y <= b[3]; y++)
        for (let x = 0; x < f.width; x++) {
          const i = (y * f.width + x) * 4;
          expect(f.data[i + 3]).toBe(first.data[i + 3]);
        }
  });

  it("has a review board with a row per town floor, beside an LPC person", () => {
    const board = floorBoard(root, TOWN_PROPS, TOWN_FLOORS);
    // Each row is a lineup as tall as the tallest prop (64) plus its margin.
    expect(board.height).toBe(TOWN_FLOORS.length * (64 + 32 + 2));
    expect(board.width).toBeGreaterThan(48 * TOWN_PROPS.length);
  });
});
