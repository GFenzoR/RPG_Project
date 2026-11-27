import { Mesh, MeshGeometry, Sprite, Texture } from "pixi.js";
import type { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { CAST_SHADOW_TINT, MapView } from "@rpg/renderer";
import type { ChunkData, TileArt } from "@rpg/renderer";
import { DEFAULT_DAY_NIGHT } from "./sky.ts";
import { SkyView } from "./sky.ts";
import { WorldClockState } from "../state/world-clock.ts";
import { CastShadows, poseOf } from "./cast-shadows.ts";
import type { ShadowPose } from "./cast-shadows.ts";
import { ObjectShadows, POSE_STEP, blockNorth, blockSide } from "./object-shadows.ts";
import type { ObjectShadowHint, ShadowMap } from "./object-shadows.ts";

const T = 32;
const tex = (w: number, h: number): Texture => {
  const t = new Texture();
  t.frame.width = w;
  t.frame.height = h;
  t.orig.width = w;
  t.orig.height = h;
  return t;
};

/** The pose that sends the tip of a caster one px high (x, y): east and north. */
const cast = (x: number, y: number, alpha = 0.4): ShadowPose => ({
  skewX: Math.atan2(-x, y),
  scaleY: Math.hypot(x, y),
  alpha,
  x,
  y,
});

interface Item {
  x: number;
  y: number;
  key: string;
  sprite: Sprite;
}

/** A map of loose item sprites, as MapView hands them. */
class FakeMap implements ShadowMap {
  version = 0;
  items: Item[] = [];
  indoor = new Set<string>();
  add(key: string, x: number, y: number, t: Texture, anchorX = 1): Sprite {
    const sprite = new Sprite({ texture: t, anchor: { x: anchorX, y: 1 } });
    sprite.position.set((x + anchorX) * T, (y + 1) * T);
    this.items.push({ x, y, key, sprite });
    this.version++;
    return sprite;
  }
  remove(sprite: Sprite): void {
    this.items = this.items.filter((i) => i.sprite !== sprite);
    this.version++;
  }
  forEachItemSprite(fn: (x: number, y: number, key: string, sprite: Sprite) => void): void {
    for (const i of this.items) fn(i.x, i.y, i.key, i.sprite);
  }
  indoorAt(x: number, y: number): boolean {
    return this.indoor.has(`${x},${y}`);
  }
}

const HINTS: Record<string, ObjectShadowHint> = {
  tree: { cast: "silhouette", length: 1, foot: 5 },
  barrel: { cast: "silhouette", length: 1, foot: 0 },
  corpse: { cast: "silhouette", length: 0.4, foot: 4 },
  wall: { cast: "block", length: 1, foot: 0 },
  gate: { cast: "block", length: 1, height: 20, foot: 0 },
};
const layer = (): ObjectShadows => new ObjectShadows(T, (key) => HINTS[key]);

/** The world position of a sprite's local point (u, v), each 0..1 of its texture. */
function corner(s: Sprite, u: number, v: number): { x: number; y: number } {
  const lx = (u - s.anchor.x) * s.texture.width;
  const ly = (v - s.anchor.y) * s.texture.height;
  // Pixi's local transform: x axis (cos sky, sin sky) * sx, y axis (sin skx, cos skx) * sy.
  const ax = Math.cos(s.skew.y) * s.scale.x;
  const ay = Math.sin(s.skew.y) * s.scale.x;
  const bx = Math.sin(s.skew.x) * s.scale.y;
  const by = Math.cos(s.skew.x) * s.scale.y;
  return { x: s.x + lx * ax + ly * bx, y: s.y + lx * ay + ly * by };
}

describe("ObjectShadows: silhouettes", () => {
  it("lays an object's own texture on the ground from its base, in the sun's pose", () => {
    const map = new FakeMap();
    const t = tex(64, 96);
    const tree = map.add("tree", 10, 20, t, 0.5);
    const shadows = layer();
    const pose = cast(-1.2, 0.3); // a morning: long to the west
    shadows.update(map, pose);
    expect(shadows.count).toBe(1);
    expect(shadows.casters).toBe(1);
    expect(shadows.swaying).toBe(0);
    const s = shadows.root.children[0] as Sprite;
    expect(s.texture).toBe(t);
    expect(s.tint).toBe(CAST_SHADOW_TINT);
    // The base (5 empty rows over the bottom edge) is the pivot: it stays under the trunk.
    expect(s.anchor.x).toBe(0.5);
    expect(s.anchor.y).toBeCloseTo(1 - 5 / 96);
    expect(s.position).toMatchObject({ x: tree.x, y: tree.y - 5 });
    expect(s.skew.x).toBeCloseTo(pose.skewX);
    expect(s.scale.y).toBeCloseTo(pose.scaleY);
    // Its top lands where the sun sends the tip of something 91 px high: west and north.
    const tip = corner(s, 0.5, 0);
    expect(tip.x - s.x).toBeCloseTo(91 * -1.2);
    expect(tip.y - s.y).toBeCloseTo(91 * -0.3);
    // The base does not move with the sun.
    const base = corner(s, 0.5, 1 - 5 / 96);
    shadows.update(map, cast(1.2, 0.3));
    expect(corner(s, 0.5, 1 - 5 / 96)).toEqual(base);
    expect(corner(s, 0.5, 0).x - s.x).toBeCloseTo(91 * 1.2); // the afternoon: east
  });

  it("casts for every object with a hint and for nothing without one", () => {
    const map = new FakeMap();
    map.add("tree", 1, 1, tex(64, 96), 0.5);
    map.add("barrel", 2, 1, tex(32, 32));
    map.add("rug", 3, 1, tex(32, 32)); // flat: no hint
    map.add("sword", 4, 1, tex(32, 32)); // a loose item: no hint
    const shadows = layer();
    shadows.update(map, cast(0.5, 0.3));
    expect(shadows.casters).toBe(2);
    expect(shadows.count).toBe(2);
  });

  it("draws a body lying down at the share of the length its hint gives", () => {
    const map = new FakeMap();
    map.add("corpse", 5, 5, tex(64, 64), 0.5);
    const shadows = layer();
    const pose = cast(1, 0.4);
    shadows.update(map, pose);
    const s = shadows.root.children[0] as Sprite;
    expect(s.scale.y).toBeCloseTo(pose.scaleY * 0.4);
    expect(s.skew.x).toBeCloseTo(pose.skewX);
  });

  it("casts nothing for an item hidden for now (remains under a body still falling)", () => {
    const map = new FakeMap();
    const corpse = map.add("corpse", 5, 5, tex(64, 64), 0.5);
    const shadows = layer();
    shadows.update(map, cast(1, 0.4));
    const s = shadows.root.children[0] as Sprite;
    expect(s.visible).toBe(true);
    corpse.renderable = false; // no new map version: the veil only hides the sprite
    shadows.update(map, cast(1, 0.4));
    expect(s.visible).toBe(false);
    corpse.renderable = true;
    shadows.update(map, cast(1, 0.4));
    expect(s.visible).toBe(true);
  });

  it("casts nothing indoors", () => {
    const map = new FakeMap();
    map.add("barrel", 2, 2, tex(32, 32));
    map.add("barrel", 8, 8, tex(32, 32));
    map.indoor.add("2,2");
    const shadows = layer();
    shadows.update(map, cast(0.5, 0.3));
    expect(shadows.casters).toBe(1);
    expect((shadows.root.children[0] as Sprite).x).toBe(9 * T);
  });

  it("hides them all with no sun or moon over the floor (underground, a moonless night)", () => {
    const map = new FakeMap();
    map.add("tree", 1, 1, tex(64, 96), 0.5);
    const shadows = layer();
    shadows.update(map, cast(0.5, 0.3));
    expect(shadows.root.visible).toBe(true);
    shadows.update(map, undefined);
    expect(shadows.root.visible).toBe(false);
    expect(shadows.count).toBe(0);
    expect(shadows.casters).toBe(0);
    shadows.update(map, cast(0.5, 0.3));
    expect(shadows.count).toBe(1);
  });
});

describe("ObjectShadows: cost", () => {
  it("places the shadows when the map or the sun moved, not every frame", () => {
    const map = new FakeMap();
    for (let i = 0; i < 50; i++) map.add("tree", i, 3, tex(64, 96), 0.5);
    const shadows = layer();
    const pose = cast(0.5, 0.3);
    for (let f = 0; f < 100; f++) shadows.update(map, pose);
    expect(shadows.placed).toBe(1);
    // The sun creeping less than a step: nothing is touched.
    pose.x += POSE_STEP / 2;
    shadows.update(map, pose);
    expect(shadows.placed).toBe(1);
    pose.x += POSE_STEP;
    shadows.update(map, pose);
    expect(shadows.placed).toBe(2);
    // A staff /time: at once.
    shadows.update(map, cast(-1.3, 0.2));
    expect(shadows.placed).toBe(3);
    // The opacity is the layer's filter, not the sprites': the fade at dusk places nothing.
    const dusk = cast(-1.3, 0.2, 0.1);
    shadows.update(map, dusk);
    expect(shadows.placed).toBe(3);
  });

  it("pools its sprites: a chunk leaving gives them to the chunk that comes", () => {
    const map = new FakeMap();
    const first: Sprite[] = [];
    for (let i = 0; i < 40; i++) first.push(map.add("tree", i, 3, tex(64, 96), 0.5));
    const shadows = layer();
    const pose = cast(0.5, 0.3);
    shadows.update(map, pose);
    expect(shadows.made).toBe(40);
    // Walking on: those leave, as many others come, over and over.
    for (let round = 0; round < 10; round++) {
      for (const s of first.splice(0)) map.remove(s);
      for (let i = 0; i < 40; i++) first.push(map.add("barrel", i, 9 + round, tex(32, 32)));
      shadows.update(map, pose);
      expect(shadows.count).toBe(40);
    }
    expect(shadows.made).toBe(40);
  });

  it("keeps the shadows of the chunks that stay when another is built", () => {
    const map = new FakeMap();
    map.add("tree", 1, 1, tex(64, 96), 0.5);
    const shadows = layer();
    shadows.update(map, cast(0.5, 0.3));
    const kept = shadows.root.children[0];
    map.add("tree", 40, 1, tex(64, 96), 0.5);
    shadows.update(map, cast(0.5, 0.3));
    expect(shadows.root.children[0]).toBe(kept);
    expect(shadows.count).toBe(2);
  });

  // docs/07: a dense forest in view (600 objects) costs a frame nothing between two
  // placements, and placing them all again (the sun moved, a chunk came) is well under a
  // millisecond of JS. A wide ceiling: only real work per sprite per frame trips it.
  it("stays inside the frame budget with a forest in view", () => {
    const map = new FakeMap();
    const t = tex(64, 96);
    for (let i = 0; i < 600; i++) map.add("tree", i % 40, Math.floor(i / 40), t, 0.5);
    const shadows = layer();
    const pose = cast(0.5, 0.3);
    shadows.update(map, pose);
    const frames = 2000;
    let start = performance.now();
    for (let f = 0; f < frames; f++) shadows.update(map, pose);
    const idle = (performance.now() - start) / frames;
    expect(idle).toBeLessThan(0.05);
    start = performance.now();
    for (let f = 0; f < 200; f++) shadows.update(map, cast(0.5 + (f + 1) * POSE_STEP, 0.3));
    const placing = (performance.now() - start) / 200;
    expect(placing).toBeLessThan(2);
    expect(shadows.made).toBe(600);
  });
});

describe("ObjectShadows: walls", () => {
  const WALL = tex(32, 64); // rises 32 px over its tile

  it("sweeps a wall's box along the shadow: its north edge and the edge on the far side", () => {
    const map = new FakeMap();
    map.add("wall", 10, 10, WALL);
    const shadows = layer();
    const pose = cast(1, 0.25); // afternoon: 32 px east, 8 px north
    shadows.update(map, pose);
    expect(shadows.casters).toBe(1);
    const [north, side] = shadows.root.children as Sprite[];
    expect(north?.texture).toBe(Texture.WHITE);
    expect(north?.tint).toBe(CAST_SHADOW_TINT);
    // North edge (320..352, 320) swept to (352..384, 312).
    expect(corner(north as Sprite, 0, 1)).toMatchObject({ x: 320, y: 320 });
    expect(corner(north as Sprite, 1, 1)).toMatchObject({ x: 352, y: 320 });
    expect(corner(north as Sprite, 0, 0).x).toBeCloseTo(352);
    expect(corner(north as Sprite, 0, 0).y).toBeCloseTo(312);
    expect(corner(north as Sprite, 1, 0).x).toBeCloseTo(384);
    // East edge (352, 320..352) swept to (384, 312..344).
    expect(corner(side as Sprite, 0, 0)).toMatchObject({ x: 352, y: 320 });
    expect(corner(side as Sprite, 0, 1).y).toBeCloseTo(352);
    expect(corner(side as Sprite, 1, 0).x).toBeCloseTo(384);
    expect(corner(side as Sprite, 1, 0).y).toBeCloseTo(312);
    expect(corner(side as Sprite, 1, 1).y).toBeCloseTo(344);
    // In the morning the west edge casts instead.
    shadows.update(map, cast(-1, 0.25));
    expect(corner(side as Sprite, 0, 0)).toMatchObject({ x: 320, y: 320 });
    expect(corner(side as Sprite, 1, 0).x).toBeCloseTo(288);
  });

  it("joins a row of walls into one shadow: each sweep ends where the next begins", () => {
    const map = new FakeMap();
    for (let x = 10; x < 14; x++) map.add("wall", x, 10, WALL); // a wall running east
    const shadows = layer();
    shadows.update(map, cast(0.6, 0.3));
    const norths = (shadows.root.children as Sprite[]).filter((s) => s.anchor.y === 1);
    expect(norths).toHaveLength(4);
    norths.sort((a, b) => a.x - b.x);
    for (let i = 0; i + 1 < norths.length; i++) {
      const a = norths[i] as Sprite;
      const b = norths[i + 1] as Sprite;
      // The right edge of one is the left edge of the next, top and bottom: no gap.
      expect(corner(a, 1, 1)).toEqual(corner(b, 0, 1));
      expect(corner(a, 1, 0).x).toBeCloseTo(corner(b, 0, 0).x);
      expect(corner(a, 1, 0).y).toBeCloseTo(corner(b, 0, 0).y);
    }
  });

  it("joins a wall running north the same way, without the sweeps a wall hides", () => {
    const map = new FakeMap();
    for (let y = 10; y < 14; y++) map.add("wall", 10, y, WALL);
    const shadows = layer();
    shadows.update(map, cast(1, 0.25));
    const all = shadows.root.children as Sprite[];
    const sides = all.filter((s) => s.anchor.y === 0).sort((a, b) => a.y - b.y);
    // Only the northmost wall shows its north sweep: the others' lie under a wall.
    expect(all.filter((s) => s.anchor.y === 1)).toHaveLength(1);
    expect(sides).toHaveLength(4);
    for (let i = 0; i + 1 < sides.length; i++) {
      const a = sides[i] as Sprite;
      const b = sides[i + 1] as Sprite;
      expect(corner(a, 0, 1)).toEqual(corner(b, 0, 0));
      expect(corner(a, 1, 1).x).toBeCloseTo(corner(b, 1, 0).x);
      expect(corner(a, 1, 1).y).toBeCloseTo(corner(b, 1, 0).y);
    }
  });

  it("takes the box's height from the hint, else from the drawing over its tile", () => {
    const pose = cast(1, 0.25);
    const n = { x: 0, y: 0, scaleX: 0, scaleY: 0, skewX: 0 };
    blockNorth(3, 4, T, 20, pose, n);
    expect(n).toMatchObject({ x: 96, y: 128, scaleX: 32 });
    expect(n.scaleY).toBeCloseTo(20 * pose.scaleY);
    const s = { x: 0, y: 0, width: 0, skewY: 0 };
    blockSide(3, 4, T, 20, pose, s);
    expect(s.x).toBe(128);
    expect(s.width).toBeCloseTo(Math.hypot(20, 5));
    // Noon, straight north: no side to sweep.
    blockSide(3, 4, T, 20, cast(0, 0.23), s);
    expect(s.width).toBe(0);

    const map = new FakeMap();
    map.add("gate", 1, 1, WALL);
    map.add("wall", 5, 1, tex(32, 32)); // a wall no higher than its tile: nothing to cast
    const shadows = layer();
    shadows.update(map, pose);
    const north = (shadows.root.children as Sprite[]).find((sp) => sp.anchor.y === 1);
    expect(north?.scale.y).toBeCloseTo(20 * pose.scaleY);
    expect(shadows.count).toBe(2);
  });
});

describe("ObjectShadows: the wind", () => {
  /** The wind's strips of some sprites, as the living world hands them. */
  const windOf = (): {
    strips: Map<Sprite, { view: { geometry: MeshGeometry } }>;
    v: number;
    wind: {
      version(): number;
      strips(s: Sprite): { view: { geometry: MeshGeometry } } | undefined;
    };
  } => {
    const strips = new Map<Sprite, { view: { geometry: MeshGeometry } }>();
    const state = {
      strips,
      v: 0,
      wind: { version: () => state.v, strips: (s: Sprite) => strips.get(s) },
    };
    return state;
  };
  const geometry = (): MeshGeometry =>
    new MeshGeometry({
      positions: new Float32Array([-32, -96, 32, -96, 32, 0, -32, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });

  it("draws a swaying plant's shadow on the plant's own strips, so its crown sways too", () => {
    const map = new FakeMap();
    const tree = map.add("tree", 10, 20, tex(64, 96), 0.5);
    const w = windOf();
    const g = geometry();
    w.strips.set(tree, { view: { geometry: g } });
    w.v++;
    const shadows = layer();
    const pose = cast(0.8, 0.3);
    shadows.update(map, pose, w.wind);
    const m = shadows.root.children[0] as Mesh<MeshGeometry>;
    expect(m).toBeInstanceOf(Mesh);
    // The very geometry the wind slides: whatever the crown does, its shadow does, and
    // the rows under the pivot (the trunk) stay in both.
    expect(m.geometry).toBe(g);
    expect(m.tint).toBe(CAST_SHADOW_TINT);
    // Turned round the plant's base: the strips hang from the bottom edge.
    expect(m.pivot.y).toBe(-5);
    expect(m.position).toMatchObject({ x: tree.x, y: tree.y - 5 });
    expect(m.skew.x).toBeCloseTo(pose.skewX);
    expect(m.scale.y).toBeCloseTo(pose.scaleY);
  });

  it("goes back to a still sprite when the wind's strips go (Animaciones reducidas)", () => {
    const map = new FakeMap();
    const tree = map.add("tree", 10, 20, tex(64, 96), 0.5);
    const w = windOf();
    const g = geometry();
    w.strips.set(tree, { view: { geometry: g } });
    w.v++;
    const shadows = layer();
    const pose = cast(0.8, 0.3);
    shadows.update(map, pose, w.wind);
    expect(shadows.root.children[0]).toBeInstanceOf(Mesh);
    expect(shadows.swaying).toBe(1);
    // Reduced motion: the living world drops its strips; the shadow stays, still.
    w.strips.delete(tree);
    w.v++;
    shadows.update(map, pose, w.wind);
    expect(shadows.count).toBe(1);
    const s = shadows.root.children[0] as Sprite;
    expect(s).toBeInstanceOf(Sprite);
    expect(s.skew.x).toBeCloseTo(pose.skewX);
    expect(s.position).toMatchObject({ x: tree.x, y: tree.y - 5 });
    // The plant's geometry is the wind's to destroy, never the shadow's.
    expect(g.attributes).toBeTruthy();
    // And with the wind back, a mesh again.
    w.strips.set(tree, { view: { geometry: g } });
    w.v++;
    shadows.update(map, pose, w.wind);
    expect(shadows.root.children[0]).toBeInstanceOf(Mesh);
    shadows.destroy();
    expect(g.attributes).toBeTruthy();
  });
});

describe("ObjectShadows on a real MapView", () => {
  const G = "g";
  const art = (id: string): TileArt<Texture> | undefined => {
    const base = { ms: 250, sync: "world" as const, joinsWalls: false, light: 0 };
    if (id === "wall")
      return {
        ...base,
        base: WALL,
        anchorX: 1,
        joinsWalls: true,
        wall: Array.from({ length: 16 }, () => WALL),
      };
    if (id === "tree") return { ...base, base: TREE, anchorX: 0.5, shadow: BAKED };
    return undefined;
  };
  const WALL = tex(32, 64);
  const TREE = tex(64, 96);
  const BAKED = tex(64, 32);
  const chunk = (): ChunkData => {
    const ground = new Array<string | null>(32 * 32).fill(G);
    const items: { x: number; y: number; stack: string[] }[] = [];
    // A house: walls round (10..15, 10..14), a barrel inside and a tree and a barrel outside.
    for (let x = 10; x <= 15; x++)
      for (let y = 10; y <= 14; y++)
        if (x === 10 || x === 15 || y === 10 || y === 14) items.push({ x, y, stack: ["wall"] });
    items.push({ x: 12, y: 12, stack: ["barrel"] });
    items.push({ x: 20, y: 12, stack: ["barrel"] });
    items.push({ x: 22, y: 20, stack: ["tree"] });
    return { ground, items };
  };
  const mapView = (): MapView => {
    const data = chunk();
    const view = new MapView({
      source: { chunk: (z, cx, cy) => (z === 7 && cx === 0 && cy === 0 ? data : undefined) },
      texture: (id) => (id === "wall" ? WALL : id === "tree" ? TREE : tex(32, 32)),
      art,
      tileSize: T,
      floor: 7,
      indoors: (z) => z < 8,
    });
    view.render({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 });
    return view;
  };

  it("gives every object outdoors one shadow, none indoors, and switches the baked art off", () => {
    const view = mapView();
    expect(view.indoorAt(12, 12)).toBe(true);
    expect(view.indoorAt(20, 12)).toBe(false);
    const sky = new SkyView(DEFAULT_DAY_NIGHT, new WorldClockState());
    const pose = sky.shadowPose(sky.update(0)); // noon, before the first WorldClock
    expect(pose).toBeDefined();
    view.castShadowStrength = sky.staticShadows();
    const shadows = layer();
    const creatures = new CastShadows(() => ({ alpha: 1, destroy() {} }) as never);
    creatures.mount(shadows.root);
    creatures.begin(pose);
    shadows.update(view, pose);
    creatures.end();
    // 18 walls, the barrel outside and the tree: the barrel in the house casts none.
    expect(shadows.casters).toBe(20);
    // One layer for everything that casts, shown with objects alone in view.
    expect(creatures.root.visible).toBe(true);
    expect(creatures.root.children[0]).toBe(shadows.root);
    // The tree has its dynamic shadow and its baked one is not drawn: never two.
    const world = view.root.children[0] as Container;
    const baked = world.children.find((c) => c.label === "shadows");
    expect(baked?.visible).toBe(false);
    const treeShadows = (shadows.root.children as Sprite[]).filter((s) => s.texture === TREE);
    expect(treeShadows).toHaveLength(1);
    view.destroy();
  });

  it("draws the indoor ground over the shadow layer: nothing of the sun shows in there", () => {
    const view = mapView();
    const world = view.root.children[0] as Container;
    const order = world.children.map((c) => c.label);
    expect(order.indexOf("indoor ground")).toBeGreaterThan(order.indexOf("ground overlay"));
    expect(order.indexOf("indoor ground")).toBeGreaterThan(order.indexOf("shadows"));
    expect(order.indexOf("indoor ground")).toBeLessThan(order.indexOf("items"));
    const indoor = world.children.find((c) => c.label === "indoor ground") as Container;
    // The 4 x 3 tiles inside the walls.
    expect(indoor.children[0]?.children).toHaveLength(12);
    view.destroy();
  });

  it("casts nothing at all underground", () => {
    const view = mapView();
    const sky = new SkyView(DEFAULT_DAY_NIGHT, new WorldClockState());
    const shadows = layer();
    shadows.update(view, sky.shadowPose(sky.none()));
    expect(shadows.count).toBe(0);
    expect(poseOf(0, 0.2, 0.3).y).toBeCloseTo(0.2);
    view.destroy();
  });
});
