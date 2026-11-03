import { describe, expect, it } from "vitest";
import { formatChunk } from "../chunk.ts";
import { formatYaml } from "../yaml.ts";
import { emptyChunk } from "../types.ts";
import type { Chunk, Portal, Spawn, Zone } from "../types.ts";
import { changeBoxes, checkPlots, inPlot, renderAreas } from "./plots.ts";
import type { Plot } from "./plots.ts";

const CHUNK = "world/islands/isle/chunks/z07/c0001_0001.json";
const ZONES = "world/islands/isle/zones.yaml";

/** Chunk 1/1 on floor 7 (tiles 32..63) with grass plus the given ground overrides. */
function chunk(tiles: Record<string, string> = {}): string {
  const c: Chunk = emptyChunk(1, 1, 7);
  c.ground.fill("grass");
  for (const [k, g] of Object.entries(tiles)) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    c.ground[(y - 32) * 32 + (x - 32)] = g;
  }
  return formatChunk(c);
}

// Plot: x 40..49, y 40..49 on floor 7.
const PLOTS: Plot[] = [
  { island: "isle", id: "isle_plot", floors: [7], rects: [{ x: 40, y: 40, w: 10, h: 10 }] },
];

const spawn = (id: string, x: number, y: number): Spawn => ({
  id,
  center: { x, y, z: 7 },
  radius: 2,
  monsters: [{ monster: "wolf", count: 1 }],
  respawn_seconds: 60,
});
const zone = (id: string, type: Zone["type"], x: number, w = 2): Zone => ({
  id,
  type,
  floors: [7],
  rects: [{ x, y: 42, w, h: 2 }],
});
const yaml = (v: unknown): string => formatYaml(v);

describe("inPlot", () => {
  it("checks rect and floor", () => {
    expect(inPlot(PLOTS, 40, 40, 7)).toBe(true);
    expect(inPlot(PLOTS, 49, 49, 7)).toBe(true);
    expect(inPlot(PLOTS, 50, 49, 7)).toBe(false);
    expect(inPlot(PLOTS, 45, 45, 8)).toBe(false);
  });
});

describe("checkPlots", () => {
  it("accepts tiles changed inside a plot", () => {
    const v = checkPlots(PLOTS, [
      { path: CHUNK, before: chunk(), after: chunk({ "41,41": "sand", "49,49": "sand" }) },
    ]);
    expect(v).toEqual([]);
  });

  it("lists tiles changed outside every plot", () => {
    const v = checkPlots(PLOTS, [
      {
        path: CHUNK,
        before: chunk(),
        after: chunk({ "41,41": "sand", "50,41": "sand", "33,60": "sand" }),
      },
    ]);
    expect(v).toEqual([{ kind: "tiles", path: CHUNK, tiles: 2, at: ["50,41,7", "33,60,7"] }]);
  });

  it("counts a chunk created or removed tile by tile", () => {
    const [v] = checkPlots(PLOTS, [{ path: CHUNK, before: null, after: chunk() }]);
    expect(v).toMatchObject({ kind: "tiles", tiles: 32 * 32 - 100 });
    expect(checkPlots(PLOTS, [{ path: CHUNK, before: chunk(), after: null }])).toHaveLength(1);
  });

  it("checks spawns by centre, portals by both ends and zones by every tile", () => {
    const portal = (id: string, tx: number): Portal => ({
      id,
      kind: "teleport",
      from: { x: 41, y: 41, z: 7 },
      to: { x: tx, y: 41, z: 7 },
    });
    const v = checkPlots(PLOTS, [
      {
        path: "world/islands/isle/spawns.yaml",
        before: yaml([spawn("kept", 10, 10)]),
        after: yaml([spawn("kept", 10, 10), spawn("in", 45, 45), spawn("out", 51, 45)]),
      },
      {
        path: "world/islands/isle/portals.yaml",
        before: null,
        after: yaml([portal("ok", 48), portal("leaves", 60)]),
      },
      {
        path: ZONES,
        before: yaml([zone("moved", "protection", 41)]),
        after: yaml([zone("moved", "protection", 49), zone("inside", "no_logout", 42, 8)]),
      },
    ]);
    expect(v).toEqual([
      {
        kind: "entry",
        path: "world/islands/isle/spawns.yaml",
        entry: "out",
        change: "added",
        reason: "outside_plot",
      },
      {
        kind: "entry",
        path: "world/islands/isle/portals.yaml",
        entry: "leaves",
        change: "added",
        reason: "outside_plot",
      },
      // Moved from inside to a rect that sticks out (49..50).
      { kind: "entry", path: ZONES, entry: "moved", change: "changed", reason: "outside_plot" },
    ]);
  });

  it("treats removing an entry by its old position", () => {
    const v = checkPlots(PLOTS, [
      {
        path: "world/islands/isle/npcs.yaml",
        before: yaml([{ npc: "a", pos: { x: 1, y: 1, z: 7 } }]),
        after: null,
      },
    ]);
    expect(v).toEqual([
      {
        kind: "entry",
        path: "world/islands/isle/npcs.yaml",
        entry: "a",
        change: "removed",
        reason: "outside_plot",
      },
    ]);
  });

  it("never lets a plot be defined, moved or removed without a maintainer", () => {
    const v = checkPlots(PLOTS, [
      { path: ZONES, before: null, after: yaml([zone("new_plot", "community_plot", 42)]) },
    ]);
    expect(v).toEqual([
      { kind: "entry", path: ZONES, entry: "new_plot", change: "added", reason: "plot_definition" },
    ]);
  });

  it("flags island/world files, non-map files and unparsable files, but not credits", () => {
    const v = checkPlots(PLOTS, [
      { path: "world/islands/isle/island.yaml", before: "a", after: "b" },
      { path: "world/notes.txt", before: null, after: "x" },
      { path: CHUNK, before: chunk(), after: "{not json" },
      { path: "world/CONTRIBUTORS.md", before: "a", after: "b" },
      { path: "world/islands/isle/texts.yaml", before: "[]", after: "[]" },
    ]);
    expect(v.map((x) => (x.kind === "file" ? x.reason : x.kind))).toEqual([
      "island_meta",
      "not_map_file",
      "invalid",
    ]);
  });
});

describe("checkPlots: spawn radius", () => {
  it("counts the whole square centre ± radius of a spawn, not only its centre", () => {
    const wide = { ...spawn("wide", 45, 45), radius: 6 }; // 39..51: sticks out of 40..49
    const fits = { ...spawn("fits", 45, 45), radius: 4 }; // 41..49
    const v = checkPlots(PLOTS, [
      { path: "world/islands/isle/spawns.yaml", before: null, after: yaml([wide, fits]) },
    ]);
    expect(v).toEqual([
      {
        kind: "entry",
        path: "world/islands/isle/spawns.yaml",
        entry: "wide",
        change: "added",
        reason: "outside_plot",
      },
    ]);
  });
});

describe("changeBoxes", () => {
  it("boxes changed tiles per chunk and changed entries (before and after)", () => {
    const boxes = changeBoxes([
      { path: CHUNK, before: chunk(), after: chunk({ "41,42": "sand", "45,50": "sand" }) },
      {
        path: "world/islands/isle/spawns.yaml",
        before: yaml([spawn("s", 10, 10)]),
        after: yaml([spawn("s", 12, 10)]),
      },
    ]);
    expect(boxes).toEqual([
      { x: 41, y: 42, w: 5, h: 9, z: 7 },
      { x: 8, y: 8, w: 5, h: 5, z: 7 },
      { x: 10, y: 8, w: 5, h: 5, z: 7 },
    ]);
  });

  it("ignores files that did not change", () => {
    expect(changeBoxes([{ path: CHUNK, before: chunk(), after: chunk() }])).toEqual([]);
  });
});

describe("renderAreas", () => {
  it("adds the margin, clips at 0 and merges overlapping boxes per floor", () => {
    const r = renderAreas(
      [
        { x: 2, y: 2, w: 1, h: 1, z: 7 },
        { x: 8, y: 2, w: 1, h: 1, z: 7 },
        { x: 8, y: 2, w: 1, h: 1, z: 8 },
        { x: 100, y: 100, w: 2, h: 2, z: 7 },
      ],
      { margin: 3 },
    );
    expect(r).toEqual({
      areas: [
        { x: 0, y: 0, w: 12, h: 6, z: 7 },
        { x: 97, y: 97, w: 8, h: 8, z: 7 },
        { x: 5, y: 0, w: 7, h: 6, z: 8 },
      ],
      omitted: 0,
    });
  });

  it("merges transitively (a box joining two others)", () => {
    const r = renderAreas(
      [
        { x: 0, y: 0, w: 2, h: 2, z: 7 },
        { x: 10, y: 0, w: 2, h: 2, z: 7 },
        { x: 2, y: 0, w: 8, h: 1, z: 7 },
      ],
      { margin: 0 },
    );
    expect(r.areas).toEqual([{ x: 0, y: 0, w: 12, h: 2, z: 7 }]);
  });

  it("splits areas larger than maxSide and caps the count", () => {
    const r = renderAreas([{ x: 0, y: 0, w: 100, h: 30, z: 7 }], {
      margin: 0,
      maxSide: 40,
      maxAreas: 2,
    });
    expect(r).toEqual({
      areas: [
        { x: 0, y: 0, w: 40, h: 30, z: 7 },
        { x: 40, y: 0, w: 40, h: 30, z: 7 },
      ],
      omitted: 1,
    });
    for (const a of renderAreas([{ x: 5, y: 5, w: 300, h: 300, z: 7 }], { maxAreas: 100 }).areas)
      expect(Math.max(a.w, a.h)).toBeLessThanOrEqual(64);
  });
});
