import { describe, expect, it } from "vitest";
import {
  CARDINALS,
  CLICK_SLOP_PX,
  MINIMAP_SCALES,
  MinimapState,
  REQUEST_RETRY_MS,
  SECTOR_BYTES,
  clickTile,
  colourItem,
  edgeArrow,
  hintMarker,
  isMinimapClick,
  minimapPassable,
  paintTerrain,
  panBy,
  parseHex,
  pixelToTile,
  roughDistance,
  sectorId,
  tileToPixel,
  viewTiles,
} from "./minimap.ts";
import type { MinimapView, Pixels } from "./minimap.ts";

const view = (over: Partial<MinimapView> = {}): MinimapView => ({
  cx: 100.5,
  cy: 200.5,
  scale: 2,
  width: 64,
  height: 64,
  ...over,
});

const bits = (...tiles: [number, number][]): Uint8Array => {
  const b = new Uint8Array(SECTOR_BYTES);
  for (const [x, y] of tiles) {
    const i = y * 32 + x;
    b[i >> 3] = (b[i >> 3] ?? 0) | (1 << (i & 7));
  }
  return b;
};

describe("projection", () => {
  it("puts the centre tile in the middle and round-trips", () => {
    const v = view();
    expect(tileToPixel(v, 100, 200)).toEqual({ px: 32, py: 32 });
    expect(pixelToTile(v, 32, 32)).toEqual({ x: 100, y: 200 });
    expect(pixelToTile(v, 0, 0)).toEqual({ x: 84, y: 184 });
    expect(viewTiles(v)).toEqual({ x0: 84, y0: 184, x1: 116, y1: 216 });
    // North is up, east is right.
    expect(tileToPixel(v, 101, 200).px).toBeGreaterThan(32);
    expect(tileToPixel(v, 100, 199).py).toBeLessThan(32);
  });
  it("pans against the drag (the map follows the pointer)", () => {
    expect(panBy({ x: 0, y: 0 }, 10, -4, 2)).toEqual({ x: -5, y: 2 });
  });
});

describe("fog", () => {
  it("only explored tiles are coloured, the rest is black", () => {
    const m = new MinimapState();
    m.applyIndex([{ z: 7, sectors: [sectorId(3, 6)] }]);
    // Sector (3,6) is tiles 96..127, 192..223: (100,200) is local (4,8).
    m.applySectors(
      [
        {
          z: 7,
          sector: sectorId(3, 6),
          explored: bits([4, 8]),
          palette: [42],
          tiles: new Uint8Array(1024).fill(1),
        },
      ],
      true,
    );
    expect(m.isExplored(100, 200, 7)).toBe(true);
    expect(m.isExplored(101, 200, 7)).toBe(false);
    expect(m.isExplored(100, 200, 8)).toBe(false);
    const out: Pixels = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
    paintTerrain(
      out,
      view(),
      7,
      (x, y, z) => m.isExplored(x, y, z),
      (x, y, z) => m.item(x, y, z),
      (item) => (item === 42 ? [10, 200, 30] : [255, 255, 255]),
    );
    const px = (x: number, y: number): number[] => [
      ...out.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4),
    ];
    expect(px(32, 32)).toEqual([10, 200, 30, 255]);
    expect(px(31, 31)).toEqual([10, 200, 30, 255]); // 2 px per tile
    expect(px(33, 32)).toEqual([0, 0, 0, 255]); // (101,200): known to the server, unexplored
    expect(px(0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("explores its own view like the server and ORs the server's bits in", () => {
    const m = new MinimapState();
    const v0 = m.version;
    expect(m.revealView(50, 50, 7, 31, 21)).toBe(true);
    expect(m.version).toBeGreaterThan(v0);
    expect(m.isExplored(35, 40, 7)).toBe(true);
    expect(m.isExplored(65, 60, 7)).toBe(true);
    expect(m.isExplored(34, 50, 7)).toBe(false);
    expect(m.isExplored(50, 61, 7)).toBe(false);
    expect(m.revealView(50, 50, 7, 31, 21)).toBe(false);
    // A delta (explored only) adds bits and keeps the local ones.
    m.applySectors(
      [
        {
          z: 7,
          sector: sectorId(1, 1),
          explored: bits([0, 0]),
          palette: [],
          tiles: new Uint8Array(),
        },
      ],
      false,
    );
    expect(m.isExplored(32, 32, 7)).toBe(true);
    expect(m.isExplored(40, 40, 7)).toBe(true);
    // A new login's index forgets the old state.
    m.applyIndex([]);
    expect(m.isExplored(40, 40, 7)).toBe(false);
  });

  it("asks once for the indexed sectors in view, nearest first, at most 16", () => {
    const m = new MinimapState();
    const ids: number[] = [];
    for (let sx = 0; sx < 6; sx++) for (let sy = 0; sy < 6; sy++) ids.push(sectorId(sx, sy));
    m.applyIndex([{ z: 7, sectors: ids }]);
    const first = m.wanted(7, 0, 0, 191, 191, 0);
    expect(first).toHaveLength(16);
    expect(first.slice(0, 4).sort()).toEqual(
      [sectorId(2, 2), sectorId(2, 3), sectorId(3, 2), sectorId(3, 3)].sort(),
    );
    const second = m.wanted(7, 0, 0, 191, 191, 10);
    expect(second).toHaveLength(16);
    expect(second.some((id) => first.includes(id))).toBe(false);
    expect(m.wanted(7, 0, 0, 191, 191, 20)).toHaveLength(4);
    expect(m.wanted(7, 0, 0, 191, 191, 30)).toEqual([]);
    expect(m.wanted(8, 0, 0, 191, 191, 30)).toEqual([]); // nothing explored there
  });

  it("asks again for a sector the server never answered, never for an answered one", () => {
    const m = new MinimapState();
    m.applyIndex([{ z: 7, sectors: [sectorId(0, 0), sectorId(1, 0)] }]);
    expect(m.wanted(7, 0, 0, 63, 31, 1000)).toHaveLength(2);
    expect(m.retryIn(1000)).toBe(REQUEST_RETRY_MS);
    // The server answers (0,0) only: it dropped the part of the request... or all of it.
    m.applySectors(
      [
        {
          z: 7,
          sector: sectorId(0, 0),
          explored: bits([0, 0]),
          palette: [],
          tiles: new Uint8Array(),
        },
      ],
      true,
    );
    expect(m.wanted(7, 0, 0, 63, 31, 1000 + REQUEST_RETRY_MS - 1)).toEqual([]);
    expect(m.retryIn(1000 + REQUEST_RETRY_MS - 1)).toBe(1);
    expect(m.wanted(7, 0, 0, 63, 31, 1000 + REQUEST_RETRY_MS)).toEqual([sectorId(1, 0)]);
    // Out of view and past its wait: no timer spins for it.
    expect(m.retryIn(1000 + 3 * REQUEST_RETRY_MS)).toBeUndefined();
    m.applySectors(
      [
        {
          z: 7,
          sector: sectorId(1, 0),
          explored: bits([0, 0]),
          palette: [],
          tiles: new Uint8Array(),
        },
      ],
      true,
    );
    expect(m.retryIn(0)).toBeUndefined();
    expect(m.wanted(7, 0, 0, 63, 31, 1e9)).toEqual([]);
  });
});

describe("deltas and answers", () => {
  const delta = (sx: number, sy: number, ...tiles: [number, number][]) => ({
    z: 7,
    sector: sectorId(sx, sy),
    explored: bits(...tiles),
    palette: [],
    tiles: new Uint8Array(),
  });
  it("still asks for a sector that only came in a delta", () => {
    const m = new MinimapState();
    // Explored in an earlier login; the minimap is folded, so nothing was asked.
    m.applyIndex([{ z: 7, sectors: [sectorId(0, 0)] }]);
    // Walking sends deltas: of the indexed sector and of a new one.
    m.applySectors([delta(0, 0, [1, 1]), delta(1, 0, [0, 0])], false);
    expect(m.isExplored(1, 1, 7)).toBe(true);
    // The minimap opens: both are asked for (the old tiles of (0,0) are still unknown).
    expect(m.wanted(7, 0, 0, 63, 31, 0).sort()).toEqual([sectorId(0, 0), sectorId(1, 0)].sort());
  });
  it("a delta that overtakes the answer does not settle the request", () => {
    const m = new MinimapState();
    m.applyIndex([{ z: 7, sectors: [sectorId(0, 0)] }]);
    expect(m.wanted(7, 0, 0, 31, 31, 0)).toEqual([sectorId(0, 0)]);
    m.applySectors([delta(0, 0, [1, 1])], false);
    // Still in flight: the server dropped the request, so it is asked again after the wait.
    expect(m.wanted(7, 0, 0, 31, 31, REQUEST_RETRY_MS - 1)).toEqual([]);
    expect(m.wanted(7, 0, 0, 31, 31, REQUEST_RETRY_MS)).toEqual([sectorId(0, 0)]);
    m.applySectors([delta(0, 0, [1, 1])], true);
    expect(m.wanted(7, 0, 0, 31, 31, 1e9)).toEqual([]);
  });
});

describe("remembered colours", () => {
  it("keeps the colour item of a tile it was sent, whatever the map holds later", () => {
    const m = new MinimapState();
    const v0 = m.version;
    m.noteTile(100, 200, 7, 5);
    expect(m.version).toBeGreaterThan(v0);
    expect(m.item(100, 200, 7)).toBe(5);
    expect(m.item(101, 200, 7)).toBe(0);
    expect(m.item(100, 200, 8)).toBe(0);
    // The same item again changes nothing (no repaint); a tile with nothing keeps the last.
    const v1 = m.version;
    m.noteTile(100, 200, 7, 5);
    m.noteTile(100, 200, 7, 0);
    expect(m.version).toBe(v1);
    expect(m.item(100, 200, 7)).toBe(5);
    // A door that opened: the newer stack wins.
    m.noteTile(100, 200, 7, 6);
    expect(m.item(100, 200, 7)).toBe(6);
  });
  it("the answer's item wins over the noted one, and only where it gives one", () => {
    const m = new MinimapState();
    m.noteTile(100, 200, 7, 5); // local (4,8) of sector (3,6)
    m.noteTile(101, 200, 7, 5);
    const tiles = new Uint8Array(1024);
    tiles[8 * 32 + 4] = 2;
    m.applySectors(
      [{ z: 7, sector: sectorId(3, 6), explored: bits([4, 8]), palette: [41, 42], tiles }],
      true,
    );
    expect(m.item(100, 200, 7)).toBe(42);
    expect(m.item(101, 200, 7)).toBe(5); // explored after the answer's snapshot: kept
    m.noteTile(100, 200, 7, 5);
    m.noteTile(101, 200, 7, 7);
    expect(m.item(100, 200, 7)).toBe(42);
    expect(m.item(101, 200, 7)).toBe(7);
    // A new login's index forgets what was explored, not the map's colours (the login's
    // first view arrives before it).
    m.applyIndex([]);
    expect(m.isExplored(100, 200, 7)).toBe(false);
    expect(m.item(101, 200, 7)).toBe(7);
  });
});

describe("colours", () => {
  const items: Record<number, { blocks: boolean }> = {
    1: { blocks: false },
    2: { blocks: true },
    3: { blocks: false },
  };
  const item = (id: number) => items[id] as never;
  it("takes the topmost blocking item, else the ground", () => {
    expect(colourItem([1, 2, 3], item)).toBe(2);
    expect(colourItem([1, 3], item)).toBe(1);
    expect(colourItem([], item)).toBe(0);
    expect(colourItem(undefined, item)).toBe(0);
  });
  it("parses the atlas colours", () => {
    expect(parseHex("#0a10ff")).toEqual([10, 16, 255]);
    expect(parseHex("nope")).toEqual([96, 96, 96]);
  });
});

describe("objective hint", () => {
  const self = { x: 100, y: 200, z: 7 };
  it("draws the circle when its centre is on the minimap", () => {
    const m = hintMarker(
      view(),
      { questId: "q", stepId: "s", x: 105, y: 198, z: 7, radius: 6 },
      self,
    );
    expect(m).toEqual({ kind: "area", px: 42, py: 28, r: 12, floor: undefined });
  });
  it("points from the edge toward it with a rough distance when it is off", () => {
    const m = hintMarker(
      view(),
      { questId: "q", stepId: "s", x: 100, y: 120, z: 7, radius: 8 },
      self,
    );
    expect(m.kind).toBe("arrow");
    if (m.kind !== "arrow") return;
    expect(m.px).toBeCloseTo(32);
    expect(m.py).toBeCloseTo(8); // the top edge, inset 8 px
    expect(m.angle).toBeCloseTo(-Math.PI / 2);
    expect(m.distance).toBe(80);
  });
  it("says up or down for another floor", () => {
    expect(
      hintMarker(view(), { questId: "q", stepId: "s", x: 100, y: 200, z: 8, radius: 6 }, self)
        .floor,
    ).toBe("down");
    expect(
      hintMarker(view(), { questId: "q", stepId: "s", x: 100, y: 200, z: 6, radius: 6 }, self)
        .floor,
    ).toBe("up");
  });
  it("puts the edge arrow on the edge it crosses", () => {
    const v = view();
    expect(edgeArrow(v, 101, 201)).toBeUndefined();
    const e = edgeArrow(v, 300, 200);
    expect(e?.px).toBeCloseTo(56);
    expect(e?.py).toBeCloseTo(32);
    const se = edgeArrow(v, 300, 400);
    expect(se?.px).toBeCloseTo(56);
    expect(se?.py).toBeCloseTo(56);
    expect(se?.angle).toBeCloseTo(Math.PI / 4);
  });
  it("rounds distances: an estimate, not a count", () => {
    expect(roughDistance(1)).toBe(5);
    expect(roughDistance(23)).toBe(25);
    expect(roughDistance(64)).toBe(60);
    expect(roughDistance(146)).toBe(150);
  });
});

describe("cardinal labels", () => {
  it("has north up, east right, south down and west left, each translated", () => {
    expect(CARDINALS.map((c) => c.side)).toEqual(["top", "right", "bottom", "left"]);
    expect(CARDINALS.map((c) => c.key)).toEqual([
      "client.minimap.north",
      "client.minimap.east",
      "client.minimap.south",
      "client.minimap.west",
    ]);
  });
});

describe("a click on the minimap", () => {
  const box = { left: 300, top: 40, width: 160, height: 160 };
  it("maps the pointer to the tile under it at every zoom, panned or not", () => {
    for (const scale of MINIMAP_SCALES)
      for (const pan of [0, 7.25]) {
        const v = view({ scale, width: 160, height: 160, cx: 100.5 + pan, cy: 200.5 - pan });
        // The centre of the box is the tile at the view's centre.
        expect(clickTile(v, box, 380, 120)).toEqual({
          x: Math.floor(v.cx),
          y: Math.floor(v.cy),
        });
        // Every pixel of a tile's square on the map gives that tile back.
        for (const [tx, ty] of [
          [100, 200],
          [100 - Math.floor(60 / scale), 200 + Math.floor(50 / scale)],
          [100 + Math.floor(70 / scale), 200 - Math.floor(70 / scale)],
        ] as const) {
          const { px, py } = tileToPixel(v, tx, ty);
          const half = scale / 2 - 0.01;
          for (const [ox, oy] of [
            [0, 0],
            [-half, -half],
            [half, half],
          ] as const) {
            const cx = box.left + px + ox;
            const cy = box.top + py + oy;
            if (px + ox < 0 || py + oy < 0 || px + ox >= 160 || py + oy >= 160) continue;
            expect(clickTile(v, box, cx, cy)).toEqual({ x: tx, y: ty });
          }
        }
      }
  });
  it("follows a minimap drawn at another size than its pixels, and ignores the outside", () => {
    const v = view({ scale: 2, width: 160, height: 160 });
    const big = { left: 0, top: 0, width: 320, height: 320 };
    expect(clickTile(v, big, 160, 160)).toEqual({ x: 100, y: 200 });
    expect(clickTile(v, big, 164, 160)).toEqual({ x: 101, y: 200 });
    expect(clickTile(v, big, -1, 10)).toBeUndefined();
    expect(clickTile(v, big, 10, 320)).toBeUndefined();
    expect(clickTile(v, { ...big, width: 0 }, 10, 10)).toBeUndefined();
  });
  it("a press that moved is a drag, not a click", () => {
    expect(isMinimapClick(10, 10, 10, 10)).toBe(true);
    expect(isMinimapClick(10, 10, 12, 12)).toBe(true);
    expect(isMinimapClick(10, 10, 10 + CLICK_SLOP_PX, 10)).toBe(false);
    expect(isMinimapClick(10, 10, 4, 18)).toBe(false);
  });
  it("routes only over explored tiles that can be walked", () => {
    const m = new MinimapState();
    m.revealView(100, 200, 7, 5, 5);
    m.noteTile(100, 200, 7, 1);
    m.noteTile(101, 200, 7, 2);
    m.noteTile(102, 200, 7, 3);
    const defs: Record<number, { ground: boolean; walkable: boolean; blocks: boolean }> = {
      1: { ground: true, walkable: true, blocks: false },
      2: { ground: false, walkable: false, blocks: true },
      3: { ground: true, walkable: false, blocks: false },
    };
    const item = (id: number) => defs[id] as never;
    expect(minimapPassable(m, item, 100, 200, 7)).toBe(true);
    expect(minimapPassable(m, item, 101, 200, 7)).toBe(false); // a wall
    expect(minimapPassable(m, item, 102, 200, 7)).toBe(false); // water
    expect(minimapPassable(m, item, 100, 201, 7)).toBe(false); // explored, colour unknown
    expect(minimapPassable(m, item, 300, 200, 7)).toBe(false); // unexplored
    expect(minimapPassable(m, item, 100, 200, 8)).toBe(false); // another floor
  });
});
