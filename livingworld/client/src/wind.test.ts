import { Container, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { createLivingWorld, parseLivingWorldData } from "./index.ts";
import type { PlantSprite, Surface } from "./index.ts";
import { BEND } from "./sway.ts";
import { WindMesh } from "./wind-mesh.ts";
import {
  exposureOf,
  flutterOf,
  gustAt,
  MAX_STRIPS,
  parseWind,
  parseWindSprites,
  resolveWind,
  rowWeight,
  snapSteps,
  strengthAt,
  stripLayout,
  stripOffsets,
  swayAt,
  WIND_KINDS,
} from "./wind.ts";
import type { PlantWind, WindData } from "./wind.ts";

const kind = (stiffness: number, amplitude: number, flutter: number, period_ms: number) => ({
  stiffness,
  amplitude,
  flutter,
  period_ms,
  pivot: 0.25,
});

const WIND_YAML = {
  field: {
    direction: 0,
    speed: 2,
    gust_tiles: 8,
    calm: 0.2,
    exposure: { sand: 1.4, grass: 1, wood: 0 },
    forest: 0.5,
    night: 0.5,
  },
  kinds: {
    tree: kind(0.45, 2, 0.7, 3400),
    palm: kind(0.3, 3, 0.8, 3000),
    bush: kind(0.35, 1, 0.6, 2200),
    tall_grass: kind(0.1, 2, 0.5, 1500),
    reed: kind(0.2, 2, 0.3, 1900),
    flower: kind(0.15, 1.5, 0.4, 1600),
    vine: kind(0.3, 1, 0.5, 2400),
    cactus: kind(0.9, 0.5, 0, 2600),
    dead_tree: kind(0.8, 0.6, 0, 2800),
  },
};

const wind = parseWind(WIND_YAML) as WindData;
const field = wind.field;
const windOf = (k: (typeof WIND_KINDS)[number]): PlantWind =>
  resolveWind(wind, { kind: k }, undefined) as PlantWind;

/** The largest sway of a plant over a minute, sampled every 50 ms on a few tiles. */
function peak(w: PlantWind, exposure = 1): number {
  let max = 0;
  for (let tile = 0; tile < 6; tile++)
    for (let ms = 0; ms < 60000; ms += 50)
      max = Math.max(max, Math.abs(swayAt(field, w, tile * 7, tile * 3, ms, exposure)));
  return max;
}

describe("the wind field", () => {
  it("is deterministic and stays between a lull and a full gust", () => {
    let low = 1;
    let high = 0;
    for (let i = 0; i < 4000; i++) {
      const g = gustAt(field, (i * 13) % 97, (i * 7) % 61, i * 37);
      expect(g).toBe(gustAt(field, (i * 13) % 97, (i * 7) % 61, i * 37));
      low = Math.min(low, g);
      high = Math.max(high, g);
    }
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
    // Real lulls and real gusts, not a grey hum.
    expect(low).toBeLessThan(0.05);
    expect(high).toBeGreaterThan(0.95);
  });

  it("is coherent: neighbouring tiles feel almost the same gust, far ones do not", () => {
    let near = 0;
    let far = 0;
    const n = 500;
    for (let i = 0; i < n; i++) {
      const x = (i * 17) % 200;
      const y = (i * 29) % 200;
      const g = gustAt(field, x, y, 5000);
      near += Math.abs(g - gustAt(field, x + 1, y, 5000));
      far += Math.abs(g - gustAt(field, x + 40, y + 23, 5000));
    }
    expect(near / n).toBeLessThan(0.12);
    expect(far / n).toBeGreaterThan((near / n) * 2.5);
  });

  it("travels in the wind direction at the wind speed", () => {
    // Direction 0 (east), 2 tiles a second: what blows on a tile now blows two tiles east
    // of it a second later, and so on down the line of trees.
    for (const [x, y, ms] of [
      [10, 4, 0],
      [33, 18, 7300],
      [5, 60, 123456],
    ] as const) {
      const g = gustAt(field, x, y, ms);
      expect(gustAt(field, x + 2, y, ms + 1000)).toBeCloseTo(g, 9);
      expect(gustAt(field, x + 5, y, ms + 2500)).toBeCloseTo(g, 9);
    }
    // Any direction: south-west here.
    const sw = (
      parseWind({ ...WIND_YAML, field: { ...WIND_YAML.field, direction: 135 } }) as WindData
    ).field;
    const step = 2 * Math.SQRT1_2;
    expect(gustAt(sw, 20 - step, 20 + step, 9000)).toBeCloseTo(gustAt(sw, 20, 20, 8000), 9);
    // Across the wind the pattern does not travel: it is another gust front.
    let moved = 0;
    for (let i = 0; i < 50; i++)
      moved += Math.abs(gustAt(field, i * 9, 4, 0) - gustAt(field, i * 9, 4 + 30, 0));
    expect(moved).toBeGreaterThan(1);
  });

  it("blows harder on a coast, softer in a forest, not at all indoors, softer at night", () => {
    const sand = Array<string>(25).fill("sand");
    const grass = Array<string>(25).fill("grass");
    const wood = Array<string>(25).fill("wood");
    expect(exposureOf(field, sand, 0, 24)).toBeCloseTo(1.4);
    expect(exposureOf(field, grass, 0, 24)).toBeCloseTo(1);
    expect(exposureOf(field, wood, 0, 24)).toBe(0);
    // A surface the data does not list, and tiles not loaded yet: open air.
    expect(exposureOf(field, ["marble", undefined], 0, 24)).toBeCloseTo(1);
    expect(exposureOf(field, [], 0, 24)).toBeCloseTo(1);
    // The edge of a beach: between both.
    const edge = exposureOf(field, [...sand.slice(0, 10), ...grass.slice(0, 15)], 0, 24);
    expect(edge).toBeGreaterThan(1);
    expect(edge).toBeLessThan(1.4);
    // Trees all round calm it by `forest`; a lone tree in a field feels it whole.
    expect(exposureOf(field, grass, 24, 24)).toBeCloseTo(0.5);
    expect(exposureOf(field, grass, 2, 24)).toBeGreaterThan(0.85);
    expect(strengthAt(field, 1, 1)).toBeCloseTo(1);
    expect(strengthAt(field, 0, 1)).toBeCloseTo(0.2);
    expect(field.night).toBe(0.5);
  });
});

describe("the sway of a plant", () => {
  it("moves the top of a tree a pixel or two, never past its amplitude", () => {
    const tree = windOf("tree");
    const p = peak(tree);
    expect(p).toBeGreaterThan(1);
    expect(p).toBeLessThanOrEqual(tree.amplitude);
    // Even on the windiest coast.
    expect(peak(tree, 2)).toBeLessThanOrEqual(tree.amplitude);
    expect(swayAt(field, tree, 3, 4, 777, 1)).toBe(swayAt(field, tree, 3, 4, 777, 1));
  });

  it("moves bushes less than trees, and stiff plants barely", () => {
    const tree = peak(windOf("tree"));
    const bush = peak(windOf("bush"));
    const cactus = peak(windOf("cactus"));
    const dead = peak(windOf("dead_tree"));
    expect(bush).toBeLessThan(tree);
    expect(cactus).toBeLessThanOrEqual(0.5);
    expect(dead).toBeLessThan(0.75);
    expect(cactus).toBeLessThan(bush);
    // A stiff plant ignores a breeze that already moves a limp one.
    const stiff = { ...windOf("tree"), stiffness: 0.9 };
    const limp = { ...windOf("tree"), stiffness: 0.1 };
    expect(peak(stiff, 0.4)).toBeLessThan(peak(limp, 0.4) * 0.5);
  });

  it("does not move in still air or indoors", () => {
    const tree = windOf("tree");
    for (let ms = 0; ms < 5000; ms += 250) expect(swayAt(field, tree, 2, 2, ms, 0)).toBe(0);
    expect(flutterOf(tree, 0)).toBe(0);
  });

  it("gives each plant its own phase and size: neighbours never move like a choir", () => {
    const tree = windOf("tree");
    let apart = 0;
    for (let ms = 0; ms < 20000; ms += 100)
      apart += Math.abs(swayAt(field, tree, 10, 10, ms, 1) - swayAt(field, tree, 11, 10, ms, 1));
    expect(apart / 200).toBeGreaterThan(0.15);
  });

  it("keeps the flutter under a pixel, stronger in a gust", () => {
    const tree = windOf("tree");
    expect(flutterOf(tree, 1.5)).toBeLessThan(1);
    expect(flutterOf(tree, 1)).toBeGreaterThan(flutterOf(tree, 0.2));
    expect(flutterOf(windOf("cactus"), 1)).toBe(0);
  });
});

describe("the displacement of a sprite", () => {
  it("is zero at the base and grows with the square of the height", () => {
    expect(rowWeight(0, 28, 80)).toBe(0);
    expect(rowWeight(28, 28, 80)).toBe(0);
    expect(rowWeight(54, 28, 80)).toBeCloseTo(0.25);
    expect(rowWeight(80, 28, 80)).toBe(1);
    expect(rowWeight(96, 28, 80)).toBe(1);
    let last = 0;
    for (let h = 28; h <= 80; h++) {
      const w = rowWeight(h, 28, 80);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });

  it("cuts a tree into a planted trunk and a few moving strips", () => {
    // A 64x96 oak: the trunk ends 28 px up, the crown tops out at 81.
    const l = stripLayout(96, 28, 81);
    expect(l.count).toBeLessThanOrEqual(MAX_STRIPS + 1);
    expect(l.count).toBeGreaterThan(8);
    // Top to bottom, covering every row once.
    expect(l.edges[0]).toBe(0);
    expect(l.edges[l.count]).toBe(96);
    for (let i = 0; i < l.count; i++)
      expect(l.edges[i + 1] as number).toBeGreaterThan(l.edges[i] as number);
    // The last strip is the trunk: it never moves. The top one takes the whole sway.
    expect(l.edges[l.count - 1]).toBe(96 - 28);
    expect(l.weights[l.count - 1]).toBe(0);
    expect(l.weights[0]).toBe(1);
    for (let i = 1; i < l.count; i++)
      expect(l.weights[i] as number).toBeLessThan(l.weights[i - 1] as number);
    // A tuft of grass bends from the ground: no rigid base.
    const grass = stripLayout(32, 0, 20);
    expect(grass.weights[grass.count - 1]).toBeGreaterThan(0);
    expect(grass.edges[grass.count]).toBe(32);
  });

  it("snaps every strip to whole screen pixels at the zoom", () => {
    const l = stripLayout(96, 28, 81);
    const out = new Int16Array(l.count);
    // Zoom 1: whole sprite pixels.
    expect(snapSteps(1)).toBe(1);
    expect(snapSteps(0.4)).toBe(1);
    expect(snapSteps(2)).toBe(2);
    expect(snapSteps(2.9)).toBe(3);
    expect(stripOffsets(out, l, 1.7, 0, 0, 1)).toBe(true);
    expect(out[0]).toBe(2);
    expect(out[l.count - 1]).toBe(0);
    for (let i = 1; i < l.count; i++)
      expect(out[i] as number).toBeLessThanOrEqual(out[i - 1] as number);
    // Zoom 2: half sprite pixels, which are whole screen pixels.
    stripOffsets(out, l, 1.7, 0, 0, 2);
    expect(out[0]).toBe(3); // 1.5 sprite px
    // The same pose again changes nothing: nothing to upload.
    expect(stripOffsets(out, l, 1.7, 0, 0, 2)).toBe(false);
    // A sway too small for a screen pixel leaves the sprite alone.
    stripOffsets(out, l, 0.2, 0, 0, 1);
    expect([...out].every((v) => v === 0)).toBe(true);
  });

  it("flutters the canopy by under a pixel and never the trunk", () => {
    const l = stripLayout(96, 28, 81);
    const still = new Int16Array(l.count);
    const out = new Int16Array(l.count);
    let moved = 0;
    for (let phase = 0; phase < 40; phase += 0.37) {
      stripOffsets(out, l, 0, 0.7, phase, 4);
      expect(out[l.count - 1]).toBe(0);
      for (let i = 0; i < l.count; i++) {
        // Under one sprite pixel: under 4 steps at zoom 4.
        expect(Math.abs(out[i] as number)).toBeLessThan(4);
        if (out[i] !== still[i]) moved++;
      }
    }
    expect(moved).toBeGreaterThan(100);
  });
});

describe("the wind's data", () => {
  it("gives every plant type its defaults, with what a sprite and an item say on top", () => {
    for (const k of WIND_KINDS) expect(wind.kinds[k].periodMs).toBeGreaterThan(0);
    expect(parseWind(undefined)).toBeUndefined();
    const sprites = parseWindSprites({
      sprites: {
        "decor/oak_tree": { kind: "tree", pivot: 28, top: 81 },
        "decor/odd": { kind: "balloon" },
      },
    });
    expect(Object.keys(sprites)).toEqual(["decor/oak_tree"]);
    const oak = resolveWind(wind, sprites["decor/oak_tree"], undefined);
    expect(oak).toMatchObject({ kind: "tree", pivotPx: 28, topPx: 81, amplitude: 2 });
    // The item's own numbers win over the sprite's; the sprite's pivot stays.
    expect(
      resolveWind(wind, sprites["decor/oak_tree"], { kind: "tree", amplitude: 1.2 }),
    ).toMatchObject({ pivotPx: 28, amplitude: 1.2, stiffness: 0.45 });
    // Another type in the item starts over from that type.
    expect(resolveWind(wind, sprites["decor/oak_tree"], { kind: "dead_tree" })).toMatchObject({
      kind: "dead_tree",
      pivotPx: undefined,
      amplitude: 0.6,
    });
    expect(resolveWind(wind, undefined, undefined)).toBeUndefined();
  });

  it("joins plants.yaml, the sprites' metadata and the items", () => {
    const d = parseLivingWorldData(
      {},
      {
        plants: [
          { item: "oak_tree", reaction: "rustle", leaves: true },
          { item: "old_stump", wind: "none" },
          { item: "statue_ivy", reaction: "bend", wind: "none" },
          { item: "potted_fern", wind: { kind: "bush", amplitude: 0.5 } },
          { item: "reeds", wind: "reed" },
        ],
      },
      undefined,
      {
        wind: WIND_YAML,
        sprites: {
          sprites: {
            "decor/oak_tree": { kind: "tree", pivot: 28, top: 81 },
            "plants/jungle_palm": { kind: "palm", pivot: 10 },
            "decor/old_stump": { kind: "dead_tree", pivot: 4 },
          },
        },
        itemSprites: {
          oak_tree: "decor/oak_tree",
          jungle_palm: "plants/jungle_palm",
          old_stump: "decor/old_stump",
          anvil: "decor/anvil",
        },
      },
    );
    expect(d.wind?.field.speed).toBe(2);
    expect(d.plants["oak_tree"]).toMatchObject({
      reaction: "rustle",
      leaves: true,
      wind: { kind: "tree", pivotPx: 28 },
    });
    // A new plant sprite with metadata sways with no line in plants.yaml.
    expect(d.plants["jungle_palm"]).toMatchObject({
      reaction: "rustle",
      wind: { kind: "palm", pivotPx: 10, amplitude: 3 },
    });
    // wind: none wins over the sprite; with no reaction either it is no plant at all.
    expect(d.plants["old_stump"]).toBeUndefined();
    expect(d.plants["statue_ivy"]).toEqual({ reaction: "bend", leaves: false, trample: false });
    expect(d.plants["potted_fern"]).toMatchObject({ reaction: "bend", wind: { amplitude: 0.5 } });
    expect(d.plants["reeds"]?.wind?.kind).toBe("reed");
    expect(d.plants["anvil"]).toBeUndefined();
    // Without the wind files nothing sways, and the plants still react.
    const bare = parseLivingWorldData({}, { plants: [{ item: "oak_tree", reaction: "rustle" }] });
    expect(bare.wind).toBeUndefined();
    expect(bare.plants["oak_tree"]?.wind).toBeUndefined();
  });
});

// The living world over real Pixi sprites, as the map hands them.

const data = parseLivingWorldData(
  { surfaces: { grass: {}, sand: {}, wood: {} } },
  {
    plants: [
      { item: "oak_tree", reaction: "rustle", wind: { kind: "tree", pivot: 28, top: 81 } },
      { item: "bush", reaction: "bend", wind: { kind: "bush", pivot: 5, top: 26 } },
      { item: "grass_tuft", reaction: "bend", wind: "none" },
    ],
  },
  undefined,
  { wind: WIND_YAML, sprites: {}, itemSprites: {} },
);

function texture(w: number, h: number): Texture {
  return new Texture({
    source: Texture.WHITE.source,
    frame: { x: 0, y: 0, width: w, height: h } as never,
  });
}

const TREE = { w: 64, h: 96 };

function forest(
  cols: number,
  rows: number,
  opts: { reduced?: () => boolean; sheltered?: () => boolean; surface?: Surface } = {},
) {
  const layer = new Container({ sortableChildren: false });
  const stage = { ground: new Container(), air: new Container() };
  const tex = texture(TREE.w, TREE.h);
  const sprites: { x: number; y: number; sprite: Sprite }[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const sprite = new Sprite({ texture: tex, anchor: { x: 0.5, y: 1 } });
      sprite.position.set((x + 0.5) * 32, (y + 1) * 32);
      sprite.zIndex = y * 1000 + x;
      layer.addChild(sprite);
      sprites.push({ x, y, sprite });
    }
  let version = 1;
  const lw = createLivingWorld(stage, () => opts.surface ?? "grass", {
    tileSize: 32,
    data,
    plants: {
      version: () => version,
      forEach: (fn) => {
        for (const s of sprites) fn(s.x, s.y, "oak_tree", s.sprite as unknown as PlantSprite);
      },
    },
    reduced: opts.reduced,
    sheltered: opts.sheltered,
  });
  const view = { x: 0, y: 0, width: cols, height: rows, z: 7, zoom: 2 };
  return { lw, layer, sprites, view, bump: () => version++ };
}

/** The x of a mesh's top-left vertex minus where it rests: the top strip's offset, px. */
const topOffset = (mesh: Container, anchorLeft: number): number =>
  ((mesh as unknown as { geometry: { positions: Float32Array } }).geometry.positions[0] as number) -
  anchorLeft;

describe("the wind over the map's sprites", () => {
  it("draws a tree as strips in its sprite's place and slides them in screen pixels", () => {
    const { lw, layer, sprites, view } = forest(6, 4);
    lw.onTick(0, view);
    expect(lw.stats()).toMatchObject({ plants: 24, windMeshes: 24 });
    expect(layer.children.length).toBe(48);
    const first = sprites[0]?.sprite as Sprite;
    expect(first.visible).toBe(false);
    const mesh = layer.children.find(
      (c) => c !== first && c.zIndex === first.zIndex && c.x === first.x,
    );
    expect(mesh?.y).toBe(first.y);
    // In draw order, each mesh right after its sprite.
    for (let i = 0; i < layer.children.length; i += 2)
      expect(layer.children[i + 1]?.zIndex).toBe(layer.children[i]?.zIndex);
    let moved = 0;
    for (let ms = 100; ms < 30000; ms += 100) {
      lw.onTick(ms, view);
      const dx = topOffset(mesh as Container, -32);
      // Whole screen pixels at zoom 2, within the tree's amplitude plus its flutter.
      expect(Math.abs(dx * 2 - Math.round(dx * 2))).toBeLessThan(1e-6);
      expect(Math.abs(dx)).toBeLessThanOrEqual(3);
      if (dx !== 0) moved++;
      // The trunk's strip, the last one, never moves.
      const p = (mesh as unknown as { geometry: { positions: Float32Array } }).geometry.positions;
      expect(p[p.length - 8]).toBe(-32);
      // The map's sprite is never touched.
      expect(first.skew.x).toBe(0);
      expect(first.x).toBe(16);
    }
    expect(moved).toBeGreaterThan(50);
  });

  it("composes a creature brushing a bush with the wind: one continuous motion", () => {
    const layer = new Container();
    const stage = { ground: new Container(), air: new Container() };
    const sprite = new Sprite({ texture: texture(32, 32), anchor: { x: 1, y: 1 } });
    sprite.position.set(6 * 32, 6 * 32);
    layer.addChild(sprite);
    const lw = createLivingWorld(stage, () => "grass", {
      tileSize: 32,
      data,
      plants: {
        version: () => 1,
        forEach: (fn) => fn(5, 5, "bush", sprite as unknown as PlantSprite),
      },
    });
    const view = { x: 0, y: 0, width: 12, height: 12, z: 7, zoom: 4 };
    lw.onTick(0, view);
    const mesh = layer.children[1] as Container;
    const at = (ms: number): number => {
      lw.onTick(ms, view);
      return topOffset(mesh, -32);
    };
    const before = at(1000);
    lw.onCreatureStep(
      {
        id: 1,
        from: { x: 4, y: 5, z: 7 },
        to: { x: 5, y: 5, z: 7 },
        durationMs: 300,
        print: "feet",
      },
      1000,
    );
    // The push leans it well past what the wind alone does, the way the walker goes.
    const pushed = at(1016);
    expect(pushed - before).toBeGreaterThan(2);
    expect(BEND).toBeGreaterThan(0);
    // It springs back with no jump: frame to frame it never leaps (60 fps).
    let last = pushed;
    for (let ms = 1032; ms < 2200; ms += 16) {
      const v = at(ms);
      expect(Math.abs(v - last)).toBeLessThan(1.6);
      last = v;
    }
    // Settled: only the wind is left, a pixel at most for a bush.
    expect(Math.abs(at(2300))).toBeLessThanOrEqual(1.75);
    expect(sprite.skew.x).toBe(0);
  });

  it("turns off with reduced effects: the still sprites show again, and come back", () => {
    const reduced = { on: false };
    const { lw, layer, sprites, view } = forest(4, 3, { reduced: () => reduced.on });
    lw.onTick(0, view);
    lw.onTick(500, view);
    expect(lw.stats().windMeshes).toBe(12);
    reduced.on = true;
    lw.onTick(516, view);
    expect(lw.stats().windMeshes).toBe(0);
    expect(layer.children.length).toBe(12);
    for (const s of sprites) expect(s.sprite.visible).toBe(true);
    reduced.on = false;
    lw.onTick(532, view);
    expect(lw.stats().windMeshes).toBe(12);
    lw.destroy();
    expect(layer.children.length).toBe(12);
    for (const s of sprites) expect(s.sprite.visible).toBe(true);
  });

  it("does not blow in a cave or on a floor indoors", () => {
    for (const opts of [{ sheltered: () => true }, { surface: "wood" as const }]) {
      const { lw, layer, view } = forest(3, 2, opts);
      for (let ms = 0; ms < 8000; ms += 200) lw.onTick(ms, view);
      for (const c of layer.children) if (!(c instanceof Sprite)) expect(topOffset(c, -32)).toBe(0);
    }
  });

  it("keeps the strips of the sprites that stay and drops those of a chunk that left", () => {
    const { lw, layer, sprites, view, bump } = forest(4, 2);
    lw.onTick(0, view);
    const kept = layer.children.filter((c) => !(c instanceof Sprite));
    // The map drops a chunk: two of its sprites are destroyed.
    for (const gone of sprites.splice(0, 2)) gone.sprite.destroy();
    bump();
    lw.onTick(16, view);
    expect(lw.stats()).toMatchObject({ plants: 6, windMeshes: 6 });
    const now = layer.children.filter((c) => !(c instanceof Sprite));
    expect(now.length).toBe(6);
    for (const m of now) expect(kept).toContain(m);
  });

  it("a plant with wind: none, and a stub sprite, still bend the old way", () => {
    const stage = { ground: new Container(), air: new Container() };
    const tuft: PlantSprite = { x: 5 * 32 + 16, skew: { x: 0 } };
    const lw = createLivingWorld(stage, () => "grass", {
      tileSize: 32,
      data,
      plants: { version: () => 1, forEach: (fn) => fn(5, 5, "grass_tuft", tuft) },
    });
    const view = { x: 0, y: 0, width: 12, height: 12, z: 7 };
    for (let ms = 0; ms < 3000; ms += 100) {
      lw.onTick(ms, view);
      expect(tuft.skew.x).toBe(0);
    }
    lw.onCreatureStep(
      {
        id: 1,
        from: { x: 4, y: 5, z: 7 },
        to: { x: 5, y: 5, z: 7 },
        durationMs: 300,
        print: "feet",
      },
      3000,
    );
    lw.onTick(3001, view);
    expect(Math.abs(tuft.skew.x)).toBeGreaterThan(0.1);
    expect(lw.stats().windMeshes).toBe(0);
  });

  it("stays inside the frame budget on a screen full of trees (docs/07)", () => {
    // The worst case: a tree on every tile of the 31x21 view and its margin.
    const { lw, view } = forest(37, 27);
    lw.onTick(0, view);
    expect(lw.stats().windMeshes).toBe(999);
    // The best of a few batches: the machine running the whole suite at once is not the
    // game's frame.
    let perFrame = Infinity;
    let f = 1;
    for (let batch = 0; batch < 6; batch++) {
      const start = performance.now();
      for (let n = 0; n < 60; n++) lw.onTick(f++ * 16.7, view);
      perFrame = Math.min(perFrame, (performance.now() - start) / 60);
    }
    expect(perFrame).toBeLessThan(2);
  });
});

describe("the strip mesh", () => {
  it("draws the texture exactly as the sprite does while at rest", () => {
    const m = new WindMesh(texture(64, 96), 0.5, 28, 81);
    const g = m.view.geometry;
    const p = g.positions;
    const uv = g.uvs;
    expect(g.batchMode).toBe("batch");
    // Top-left of the first strip and bottom-right of the last: the sprite's own box.
    expect([p[0], p[1]]).toEqual([-32, -96]);
    expect([p[p.length - 4], p[p.length - 3]]).toEqual([32, 0]);
    expect([uv[0], uv[1]]).toEqual([0, 0]);
    expect([uv[uv.length - 4], uv[uv.length - 3]]).toEqual([1, 1]);
    // Every strip samples the rows it covers, whatever its offset: texels never stretch.
    for (let i = 0; i < m.layout.count; i++) {
      expect(uv[i * 8 + 1]).toBeCloseTo(((p[i * 8 + 1] as number) + 96) / 96);
      expect(uv[i * 8 + 5]).toBeCloseTo(((p[i * 8 + 5] as number) + 96) / 96);
    }
    expect(m.reach).toBe(53);
    m.offsets[0] = 3;
    m.apply(2);
    expect(p[0]).toBe(-30.5);
    expect(p[2]).toBe(33.5);
    expect(p[1]).toBe(-96);
    m.destroy();
  });
});
