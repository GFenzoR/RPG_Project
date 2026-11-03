import { CHUNK_SIZE } from "@rpg/map-format/ops";
import type { Chunk, Island, World } from "@rpg/map-format/ops";
import { describe, expect, it } from "vitest";
import { screenToTile } from "@rpg/renderer/camera";
import type { FileChange, PaletteItem, SaveResult, ValidateResult } from "../io/wire.ts";
import type { BorderRule } from "@rpg/map-format/ops";
import { tileAt } from "../tools/tools.ts";
import { ConflictError, EditorController, PartialSaveError } from "./editor.ts";
import type { Backend } from "./editor.ts";

const T = 32;
const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key} ${JSON.stringify(params)}` : key;

function island(id: string, x: number): Island {
  return {
    meta: {
      id,
      name: `island.${id}.name`,
      rect: { x, y: 0, w: CHUNK_SIZE, h: CHUNK_SIZE },
      floors: [7],
      temple: { x: x + 5, y: 6, z: 7 },
      level_hint: [1, 1],
    },
    chunks: new Map<string, Chunk>(),
    spawns: [],
    npcs: [],
    zones: [],
    portals: [],
    texts: [],
  };
}

function world(): World {
  return {
    meta: { format: 1, islands: [], boat_routes: [] },
    islands: new Map([
      ["a", island("a", 0)],
      ["b", island("b", 64)],
    ]),
  };
}

const items: PaletteItem[] = [
  { id: "grass", kind: "ground", sprite: "ground/grass", name: "item.grass.name" },
  { id: "crate", kind: "decoration", sprite: "decor/crate", name: "item.crate.name" },
  { id: "sand", kind: "ground", sprite: "ground/sand", name: "item.sand.name" },
];

const piece = (n: string): string => `b_${n}`;
const borders: BorderRule[] = [
  {
    id: "grass_sand",
    from: "grass",
    to: "sand",
    pieces: {
      n: piece("n"),
      s: piece("s"),
      e: piece("e"),
      w: piece("w"),
      ne: piece("ne"),
      nw: piece("nw"),
      se: piece("se"),
      sw: piece("sw"),
    },
  },
];

class FakeBackend implements Backend {
  saves: FileChange[][] = [];
  conflict = false;
  async validate(): Promise<ValidateResult> {
    return { diagnostics: [], errors: 0, warnings: 0 };
  }
  async save(_world: World, changes: FileChange[]): Promise<SaveResult> {
    this.saves.push(changes);
    if (this.conflict) throw new ConflictError(changes.map((c) => c.file));
    return {
      written: changes.map((c) => c.file),
      removed: [],
      base: Object.fromEntries(changes.map((c) => [c.file, "f".repeat(64)])),
    };
  }
}

function editor(
  opts: { island?: string; backend?: Backend; borders?: BorderRule[] } = {},
): EditorController {
  return new EditorController({
    world: world(),
    borders: opts.borders ?? [],
    monsters: ["wolf"],
    npcs: ["harbor_master"],
    items,
    t,
    loadErrors: [],
    base: { "world/islands/a/chunks/z07/c0000_0000.json": "a".repeat(64) },
    island: opts.island ?? null,
    backend: opts.backend ?? new FakeBackend(),
  });
}

const centre = (e: EditorController): { x: number; y: number } =>
  screenToTile(e.state.camera, e.view.width / 2, e.view.height / 2, T);

describe("EditorController", () => {
  it("centres the temple on the first view size, even when it is exactly 800x600", () => {
    const e = editor();
    e.setView({ width: 800, height: 600 }, T);
    expect(centre(e)).toEqual({ x: 5, y: 6 });
    e.pan(64, 0, T);
    e.setView({ width: 1000, height: 700 }, T); // resizing later does not re-centre
    expect(centre(e)).not.toEqual({ x: 5, y: 6 });
  });

  it("opens the island from ?island= and the selector moves to a temple", () => {
    const e = editor({ island: "b" });
    e.setView({ width: 640, height: 480 }, T);
    expect(e.state.island).toBe("b");
    expect(centre(e)).toEqual({ x: 69, y: 6 });
    e.selectIsland("a", T);
    expect(centre(e)).toEqual({ x: 5, y: 6 });
    expect(editor({ island: "nope" }).state.island).toBe("a");
  });

  it("saves only the chunk files it touched, against their base", async () => {
    const backend = new FakeBackend();
    const e = editor({ backend });
    e.strokeStart(1, 1, false);
    e.strokeEnd();
    e.strokeStart(70, 1, false);
    e.strokeEnd();
    expect(e.changes()).toEqual([
      { file: "world/islands/a/chunks/z07/c0000_0000.json", base: "a".repeat(64) },
      { file: "world/islands/b/chunks/z07/c0002_0000.json", base: null },
    ]);
    await e.save();
    expect(backend.saves).toHaveLength(1);
    expect(e.state.dirty).toBe(false);
    expect(e.changes()).toEqual([]);
    e.undo();
    expect(e.changes()).toEqual([
      { file: "world/islands/b/chunks/z07/c0002_0000.json", base: "f".repeat(64) },
    ]);
  });

  it("reports a conflict and keeps the changes pending", async () => {
    const backend = new FakeBackend();
    backend.conflict = true;
    const e = editor({ backend });
    e.strokeStart(1, 1, false);
    e.strokeEnd();
    await e.save();
    expect(e.state.status).toBe(
      'editor.save_conflict {"count":1,"files":"a/chunks/z07/c0000_0000.json"}',
    );
    expect(e.state.dirty).toBe(true);
    expect(e.changes()).toHaveLength(1);
  });

  it("after a half-way save, the next save only retries what did not reach the disk", async () => {
    const backend = new FakeBackend();
    const e = editor({ backend });
    e.strokeStart(1, 1, false); // island a, existing chunk
    e.strokeEnd();
    e.strokeStart(70, 1, false); // island b, new chunk
    e.strokeEnd();
    const A = "world/islands/a/chunks/z07/c0000_0000.json";
    const B = "world/islands/b/chunks/z07/c0002_0000.json";
    backend.save = async () => {
      throw new PartialSaveError("save stopped half-way: EIO", {
        written: [A],
        removed: [],
        base: { [A]: "b".repeat(64), [B]: null },
      });
    };
    await e.save();
    expect(e.state.status).toMatch(/^editor.save_failed/);
    expect(e.state.dirty).toBe(true);
    // A moved to its new base and is no longer pending; B keeps its old base (none).
    expect(e.changes()).toEqual([{ file: B, base: null }]);
    e.strokeStart(2, 2, false); // editing A again saves against the base written above
    e.strokeEnd();
    expect(e.changes()).toEqual([
      { file: A, base: "b".repeat(64) },
      { file: B, base: null },
    ]);
  });

  it("shows an undo that cannot be applied in the status bar instead of throwing", () => {
    const e = editor();
    e.strokeStart(1, 1, false); // paint grass
    e.strokeEnd();
    e.pick("crate");
    e.strokeStart(1, 1, false); // place crate
    e.strokeEnd();
    // The world loses its islands under the editor (e.g. a broken reload): undo cannot apply.
    e.state = { ...e.state, world: { ...e.state.world, islands: new Map() } };
    expect(() => e.undo()).not.toThrow();
    expect(e.state.status).toMatch(/^editor.op_rejected/);
    expect(e.state.canUndo).toBe(true);
  });
});

describe("EditorController, hito 2", () => {
  const ground = (e: EditorController, x: number, y: number, z = 7): string | null | undefined =>
    tileAt(e.state.world, x, y, z)?.ground;

  it("rectangle: drag paints on release as one undoable entry", () => {
    const e = editor();
    e.setTool("rect");
    e.strokeStart(2, 2, false);
    e.strokeMove(4, 3);
    expect(e.state.drag).toEqual({ x: 2, y: 2, w: 3, h: 2 });
    expect(ground(e, 2, 2)).toBeUndefined();
    e.strokeEnd();
    expect(e.state.drag).toBeUndefined();
    expect(ground(e, 4, 3)).toBe("grass");
    e.undo();
    expect(e.state.world.islands.get("a")?.chunks.size).toBe(0);
    e.redo();
    expect(ground(e, 2, 2)).toBe("grass");
  });

  it("fill is one entry and autoborder runs around every ground change, undo included", () => {
    const e = editor({ borders });
    e.setTool("fill");
    e.strokeStart(3, 3, false); // grass over the whole (empty) island a
    e.strokeEnd();
    expect(ground(e, 0, 0)).toBe("grass");
    expect(ground(e, 31, 31)).toBe("grass");
    e.pick("sand");
    e.setBrushSize(1);
    e.strokeStart(10, 10, false);
    e.strokeEnd();
    // Sand surrounded by grass gets the four side pieces; its neighbours stay clean.
    expect(tileAt(e.state.world, 10, 10, 7)?.stack).toEqual(["b_n", "b_e", "b_s", "b_w"]);
    expect(tileAt(e.state.world, 11, 10, 7)?.stack).toEqual([]);
    e.undo();
    expect(tileAt(e.state.world, 10, 10, 7)).toEqual({ ground: "grass", stack: [] });
    e.redo();
    expect(tileAt(e.state.world, 10, 10, 7)?.stack).toHaveLength(4);
    // With autoborder off, painting leaves the stacks alone.
    e.toggleAutoborder();
    e.strokeStart(20, 20, false);
    e.strokeEnd();
    expect(tileAt(e.state.world, 20, 20, 7)).toEqual({ ground: "sand", stack: [] });
  });

  it("select, copy and paste on another island; Delete erases the selection", () => {
    const e = editor();
    e.strokeStart(1, 1, false); // grass
    e.strokeEnd();
    e.pick("crate");
    e.strokeStart(1, 1, false);
    e.strokeEnd();
    e.setTool("select");
    e.strokeStart(0, 0, false);
    e.strokeMove(1, 1);
    e.strokeEnd();
    expect(e.state.selection).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(e.state.canUndo).toBe(true);
    expect(e.copy()).toBe(true);
    expect(e.startPaste()).toBe(true);
    e.strokeStart(70, 5, false); // the click pastes instead of using the tool
    expect(e.state.pasting).toBe(false);
    expect(tileAt(e.state.world, 71, 6, 7)).toEqual({ ground: "grass", stack: ["crate"] });
    expect(e.state.selection).toEqual({ x: 70, y: 5, w: 2, h: 2 });
    e.deleteSelection();
    expect(tileAt(e.state.world, 71, 6, 7)).toBeUndefined();
    e.undo(); // undo the delete
    e.undo(); // undo the paste
    expect(tileAt(e.state.world, 71, 6, 7)).toBeUndefined();
    expect(tileAt(e.state.world, 1, 1, 7)).toEqual({ ground: "grass", stack: ["crate"] });
  });

  it("entities: add, edit and remove are undoable and mark the island's YAML pending", () => {
    const e = editor();
    const spawn = {
      id: "a_wolves",
      center: { x: 5, y: 5, z: 7 },
      radius: 2,
      monsters: [{ monster: "wolf", count: 2 }],
      respawn_seconds: 60,
    };
    expect(e.addEntity("spawns", spawn)).toBe(true);
    expect(e.entities("spawns")).toEqual([spawn]);
    expect(e.state.entitySel).toBe("a_wolves");
    expect(e.changes()).toEqual([{ file: "world/islands/a/spawns.yaml", base: null }]);
    expect(e.updateEntity("spawns", "a_wolves", { ...spawn, id: "a_pack", radius: 3 })).toBe(true);
    expect(e.entities("spawns")).toEqual([{ ...spawn, id: "a_pack", radius: 3 }]);
    // An invalid entry is rejected by the op and changes nothing.
    expect(
      e.addEntity("spawns", { ...spawn, id: "a_bad", monsters: [{ monster: "dragon", count: 1 }] }),
    ).toBe(false);
    expect(e.state.status).toMatch(/unknown monster/);
    expect(e.removeEntity("spawns", "a_pack")).toBe(true);
    expect(e.entities("spawns")).toEqual([]);
    e.undo();
    expect(e.entities("spawns")).toEqual([{ ...spawn, id: "a_pack", radius: 3 }]);
    e.undo();
    expect(e.entities("spawns")).toEqual([spawn]);
    // NPCs, zones and portals go to their own files; moving to island b moves the entry.
    expect(e.addEntity("npcs", { npc: "harbor_master", pos: { x: 3, y: 3, z: 7 } })).toBe(true);
    expect(
      e.updateEntity("npcs", "harbor_master", { npc: "harbor_master", pos: { x: 70, y: 3, z: 7 } }),
    ).toBe(true);
    expect(e.entities("npcs", "b")).toEqual([{ npc: "harbor_master", pos: { x: 70, y: 3, z: 7 } }]);
    expect(
      e.addEntity("zones", {
        id: "a_safe",
        type: "protection",
        floors: [7],
        rects: [{ x: 1, y: 1, w: 3, h: 3 }],
      }),
    ).toBe(true);
    expect(
      e.addEntity("portals", {
        id: "a_hole",
        kind: "hole",
        from: { x: 2, y: 2, z: 7 },
        to: { x: 70, y: 2, z: 7 },
      }),
    ).toBe(true);
    expect(e.changes().map((c) => c.file)).toEqual([
      "world/islands/a/npcs.yaml",
      "world/islands/a/portals.yaml",
      "world/islands/a/spawns.yaml",
      "world/islands/a/zones.yaml",
      "world/islands/b/npcs.yaml",
    ]);
  });

  it("a pick request takes the next map click instead of the tool", () => {
    const e = editor();
    let got: unknown;
    e.requestPick((p) => (got = p));
    expect(e.state.picking).toBe(true);
    e.strokeStart(4, 5, false);
    e.strokeEnd();
    expect(got).toEqual({ x: 4, y: 5, z: 7 });
    expect(e.state.picking).toBe(false);
    expect(e.state.canUndo).toBe(false);
  });
});
