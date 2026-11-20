import { BORDER_PIECES, CHUNK_SIZE, NO_BORDERS } from "@rpg/map-format/ops";
import type { Chunk, Island, World } from "@rpg/map-format/ops";
import { describe, expect, it } from "vitest";
import { screenToTile } from "@rpg/renderer/camera";
import type {
  FileChange,
  NameText,
  PaletteItem,
  ParsedPatch,
  PatchExportRequest,
  SaveResult,
  ValidateResult,
} from "../io/wire.ts";
import type { BorderSet, House } from "@rpg/map-format/ops";
import { tileAt } from "../tools/tools.ts";
import { ConflictError, EditorController, PartialSaveError, entityProblem } from "./editor.ts";
import type { Backend, PendingKey } from "./editor.ts";

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
    houses: [],
  };
}

function world(): World {
  return {
    meta: { format: 1, islands: [] },
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
  // Border pieces are real items (data/items), so pasted stacks that carry them are valid.
  ...BORDER_PIECES.map((n) => ({
    id: `b_${n}`,
    kind: "decoration",
    sprite: `border/${n}`,
    name: `item.b_${n}.name`,
  })),
];

// Grass's fringe (pieces b_<piece>) goes over sand.
const borders: BorderSet = { ladder: [{ ground: "sand" }, { ground: "grass", pieces: "b" }] };
/** A lone sand tile in grass: its four concave corners. */
const HOLE = ["b_inner_nw", "b_inner_ne", "b_inner_se", "b_inner_sw"];

class FakeBackend implements Backend {
  saves: FileChange[][] = [];
  /** House names sent with each save. */
  texts: NameText[][] = [];
  /** Pending keys sent with each validation. */
  pending: PendingKey[][] = [];
  conflict = false;
  async validate(_world: World, pendingKeys: PendingKey[] = []): Promise<ValidateResult> {
    this.pending.push(pendingKeys);
    return { diagnostics: [], errors: 0, warnings: 0 };
  }
  async save(_world: World, changes: FileChange[], texts: NameText[] = []): Promise<SaveResult> {
    this.saves.push(changes);
    this.texts.push(texts);
    if (this.conflict) throw new ConflictError(changes.map((c) => c.file));
    return {
      written: changes.map((c) => c.file),
      removed: [],
      base: Object.fromEntries(changes.map((c) => [c.file, "f".repeat(64)])),
    };
  }
  exported: PatchExportRequest[] = [];
  async exportPatch(req: PatchExportRequest): Promise<unknown> {
    this.exported.push(req);
    return { format: 2, files: req.files };
  }
  parsed: ParsedPatch | Error = { base_ref: "editor", files: [] };
  async parsePatch(): Promise<ParsedPatch> {
    if (this.parsed instanceof Error) throw this.parsed;
    return this.parsed;
  }
}

function editor(
  opts: { island?: string; backend?: Backend; borders?: BorderSet } = {},
): EditorController {
  return new EditorController({
    world: world(),
    borders: opts.borders ?? NO_BORDERS,
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
    e.setTool("brush");
    e.setBrushSize(1);
    e.strokeStart(10, 10, false);
    e.strokeEnd();
    // Sand surrounded by grass gets the four inner corners; its neighbours stay clean.
    expect(tileAt(e.state.world, 10, 10, 7)?.stack).toEqual(HOLE);
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

describe("EditorController, review fixes", () => {
  const spawn = {
    id: "a_wolves",
    center: { x: 5, y: 5, z: 7 },
    radius: 2,
    monsters: [{ monster: "wolf", count: 2 }],
    respawn_seconds: 60,
  };

  it("a pending pick is cancelled by switching tab or entity; the click uses the tool", () => {
    for (const change of [
      (e: EditorController) => e.setEntityTab("zones"),
      (e: EditorController) => e.selectEntity("a_wolves"),
    ]) {
      const e = editor();
      let fired = false;
      e.requestPick(() => (fired = true));
      change(e);
      expect(e.state.picking).toBe(false);
      e.strokeStart(3, 3, false);
      e.strokeEnd();
      expect(fired).toBe(false);
      expect(tileAt(e.state.world, 3, 3, 7)?.ground).toBe("grass");
    }
  });

  it("pasting recomputes borders over the pasted area, where the ground did not change", () => {
    const e = editor({ borders });
    e.setTool("fill");
    e.pick("grass");
    e.strokeStart(0, 0, false);
    e.strokeEnd();
    e.setTool("brush");
    e.setBrushSize(1);
    e.pick("sand");
    e.strokeStart(10, 10, false); // sand in grass: 4 border pieces
    e.strokeEnd();
    e.setTool("rect");
    e.strokeStart(20, 20, false); // a sand beach
    e.strokeMove(26, 26);
    e.strokeEnd();
    e.setTool("select");
    e.strokeStart(10, 10, false);
    e.strokeEnd();
    e.copy();
    e.startPaste();
    e.strokeStart(23, 23, false); // middle of the beach: no borders there
    expect(tileAt(e.state.world, 23, 23, 7)).toEqual({ ground: "sand", stack: [] });
    // Plain sand pasted on the bordered tile keeps the borders its neighbours call for.
    e.setTool("select");
    e.strokeStart(24, 24, false);
    e.strokeEnd();
    e.copy();
    e.startPaste();
    e.strokeStart(10, 10, false);
    expect(tileAt(e.state.world, 10, 10, 7)?.stack).toEqual(HOLE);
  });

  it("fill is one click: moving while pressed does not flood other regions", () => {
    const e = editor();
    e.setTool("rect");
    e.strokeStart(0, 0, false); // grass on the left half; the right half stays empty
    e.strokeMove(9, 31);
    e.strokeEnd();
    e.pick("sand");
    expect(e.state.tool).toBe("rect");
    e.setTool("fill");
    e.strokeStart(2, 2, false);
    e.strokeMove(12, 2);
    e.strokeEnd();
    expect(tileAt(e.state.world, 0, 0, 7)?.ground).toBe("sand");
    expect(tileAt(e.state.world, 12, 2, 7)?.ground ?? null).toBeNull();
  });

  it("picking a ground keeps fill and rectangle, and switches the others to the brush", () => {
    const e = editor();
    for (const tool of ["fill", "rect"] as const) {
      e.setTool(tool);
      e.pick("sand");
      expect(e.state.tool).toBe(tool);
    }
    e.setTool("eraser");
    e.pick("grass");
    expect(e.state.tool).toBe("brush");
  });

  it("cut removes ground and items whatever the eraser's layer, so paste moves them", () => {
    const e = editor();
    e.strokeStart(1, 1, false);
    e.strokeEnd();
    e.pick("crate");
    e.strokeStart(1, 1, false);
    e.strokeEnd();
    e.setEraseLayer("items");
    e.setTool("select");
    e.strokeStart(1, 1, false);
    e.strokeEnd();
    e.cut();
    expect(tileAt(e.state.world, 1, 1, 7)).toBeUndefined();
    e.startPaste();
    e.strokeStart(70, 1, false);
    expect(tileAt(e.state.world, 70, 1, 7)).toEqual({ ground: "grass", stack: ["crate"] });
  });

  it("the forms' mistakes are reported with translated messages before any op runs", () => {
    const e = editor();
    expect(e.addEntity("spawns", { ...spawn, id: "Bad ID" })).toBe(false);
    expect(e.state.status).toBe('editor.entity.err.id {"id":"Bad ID"}');
    expect(e.addEntity("spawns", spawn)).toBe(true);
    expect(e.addEntity("spawns", spawn)).toBe(false);
    expect(e.state.status).toBe('editor.entity.err.duplicate {"id":"a_wolves"}');
    // Editing keeps its own ID; moving off the islands or to an unlisted floor is refused.
    expect(e.updateEntity("spawns", "a_wolves", { ...spawn, radius: 3 })).toBe(true);
    expect(e.updateEntity("spawns", "a_wolves", { ...spawn, center: { x: 40, y: 5, z: 7 } })).toBe(
      false,
    );
    expect(e.state.status).toBe('editor.entity.err.outside {"what":"editor.entity.center"}');
    expect(e.updateEntity("spawns", "a_wolves", { ...spawn, center: { x: 5, y: 5, z: 8 } })).toBe(
      false,
    );
    expect(e.addEntity("spawns", { ...spawn, id: "a_x", monsters: [] })).toBe(false);
    expect(e.state.status).toMatch(/^editor.entity.err.monsters/);
    const w = e.state.world;
    expect(entityProblem(w, "spawns", { ...spawn, id: "a_y", radius: 40 }, undefined)?.key).toBe(
      "editor.entity.err.radius",
    );
    expect(
      entityProblem(w, "zones", { id: "a_z", type: "pvp", floors: [7], rects: [] }, undefined)?.key,
    ).toBe("editor.entity.err.zone");
    // A zone spanning two islands, a portal to nowhere, an NPC without ID.
    const across = {
      id: "a_z",
      type: "pvp" as const,
      floors: [7],
      rects: [{ x: 30, y: 0, w: 40, h: 2 }],
    };
    expect(entityProblem(w, "zones", across, undefined)?.key).toBe("editor.entity.err.outside");
    const portal = {
      id: "a_p",
      kind: "hole" as const,
      from: { x: 1, y: 1, z: 7 },
      to: { x: 40, y: 1, z: 7 },
    };
    expect(entityProblem(w, "portals", portal, undefined)?.params).toEqual({
      what: "editor.entity.to",
    });
    expect(entityProblem(w, "npcs", { npc: "", pos: { x: 1, y: 1, z: 7 } }, undefined)?.key).toBe(
      "editor.entity.err.required",
    );
    expect(entityProblem(w, "spawns", { ...spawn, id: "a_ok" }, undefined)).toBeUndefined();
    expect(
      e.addEntity("zones", {
        id: "a_z",
        type: "pvp",
        floors: [7, 7],
        rects: [{ x: 1, y: 1, w: 2, h: 2 }],
      }),
    ).toBe(false);
    expect(e.state.status).toMatch(/^editor.entity.err.zone_floors_repeat/);
  });
});

describe("map patches", () => {
  const CH = "world/islands/a/chunks/z07/c0000_0000.json";
  const grassChunk = (): Chunk => ({
    cx: 0,
    cy: 0,
    z: 7,
    ground: new Array<string | null>(CHUNK_SIZE * CHUNK_SIZE).fill("grass"),
    items: [],
  });
  const withTile = (c: Chunk, x: number, y: number, g: string, stack: string[] = []): Chunk => {
    const out = { ...c, ground: [...c.ground], items: c.items.map((s) => ({ ...s })) };
    out.ground[y * CHUNK_SIZE + x] = g;
    if (stack.length > 0) out.items.push({ x, y, stack });
    return out;
  };
  function patched(): { e: EditorController; backend: FakeBackend } {
    const backend = new FakeBackend();
    const w = world();
    (w.islands.get("a") as Island).chunks.set("7/0/0", grassChunk());
    const e = new EditorController({
      world: w,
      items,
      t,
      loadErrors: [],
      base: {},
      monsters: ["wolf"],
      borders,
      backend,
    });
    return { e, backend };
  }

  it("exports the files changed since loading, with both worlds", async () => {
    const { e, backend } = patched();
    expect(await e.exportPatch()).toBeUndefined();
    expect(e.state.status).toBe("editor.patch.empty");
    e.setTool("brush");
    e.pick("sand");
    e.strokeStart(3, 3, false);
    e.strokeEnd();
    e.addEntity("spawns", {
      id: "den",
      center: { x: 4, y: 4, z: 7 },
      radius: 1,
      monsters: [{ monster: "wolf", count: 1 }],
      respawn_seconds: 30,
    });
    const text = await e.exportPatch();
    expect(JSON.parse(text ?? "")).toEqual({
      format: 2,
      files: [CH, "world/islands/a/spawns.yaml"],
    });
    expect(backend.exported[0]?.before.islands[0]?.chunks[0]?.ground[3 * 32 + 3]).toBe("grass");
    expect(e.diff().chunks[0]?.tiles.length).toBeGreaterThan(0);
    expect(e.diff().lists).toEqual([
      { island: "a", list: "spawns", added: ["den"], removed: [], changed: [] },
    ]);
  });

  it("imports a patch as one undoable step, merging with local edits", async () => {
    const { e, backend } = patched();
    // Local edit on another tile (autoborder off so only that tile changes).
    e.toggleAutoborder();
    e.pick("sand");
    e.strokeStart(10, 10, false);
    e.strokeEnd();
    const base = grassChunk();
    backend.parsed = {
      base_ref: "editor",
      files: [
        {
          path: CH,
          island: "a",
          target: { kind: "chunk", z: 7, cx: 0, cy: 0 },
          baseKnown: true,
          base,
          content: withTile(base, 2, 2, "sand", ["crate"]),
        },
        {
          path: "world/islands/a/spawns.yaml",
          island: "a",
          target: { kind: "list", list: "spawns" },
          baseKnown: true,
          base: null,
          content: [
            {
              id: "den",
              center: { x: 4, y: 4, z: 7 },
              radius: 1,
              monsters: [{ monster: "wolf", count: 1 }],
              respawn_seconds: 30,
            },
          ],
        },
      ],
    };
    expect(await e.importPatch("{}")).toBe(true);
    expect(tileAt(e.state.world, 2, 2, 7)).toEqual({ ground: "sand", stack: ["crate"] });
    expect(tileAt(e.state.world, 10, 10, 7)?.ground).toBe("sand");
    // The patch's own tiles are not autobordered (the toggle is back on).
    e.toggleAutoborder();
    expect(tileAt(e.state.world, 1, 2, 7)).toEqual({ ground: "grass", stack: [] });
    expect(e.entities("spawns").map((s) => ("id" in s ? s.id : ""))).toEqual(["den"]);
    expect(e.state.review).toBe(true);
    expect(e.changes().map((c) => c.file)).toEqual([CH, "world/islands/a/spawns.yaml"]);
    e.undo();
    expect(tileAt(e.state.world, 2, 2, 7)).toEqual({ ground: "grass", stack: [] });
    expect(tileAt(e.state.world, 10, 10, 7)?.ground).toBe("sand");
    expect(e.entities("spawns")).toEqual([]);
  });

  it("applies nothing and lists the conflicts when a tile changed on both sides", async () => {
    const { e, backend } = patched();
    e.toggleAutoborder();
    e.pick("sand");
    e.strokeStart(2, 2, false);
    e.strokeEnd();
    const before = e.state.world;
    const base = grassChunk();
    backend.parsed = {
      base_ref: "editor",
      files: [
        {
          path: CH,
          island: "a",
          target: { kind: "chunk", z: 7, cx: 0, cy: 0 },
          baseKnown: true,
          base,
          content: withTile(withTile(base, 2, 2, "grass", ["crate"]), 5, 5, "sand"),
        },
      ],
    };
    expect(await e.importPatch("{}")).toBe(false);
    expect(e.state.world).toBe(before);
    expect(e.state.patchConflicts).toEqual([{ kind: "tile", x: 2, y: 2, z: 7, path: CH }]);
    expect(e.state.status).toBe('editor.patch.conflicts {"count":1}');
  });

  it("refuses list entries placed in another island than their file's", async () => {
    const { e, backend } = patched();
    const before = e.state.world;
    const path = "world/islands/a/spawns.yaml";
    backend.parsed = {
      base_ref: "editor",
      files: [
        {
          path,
          island: "a",
          target: { kind: "list", list: "spawns" },
          baseKnown: true,
          base: null,
          content: [
            {
              id: "sneaky",
              center: { x: 70, y: 4, z: 7 }, // inside island b
              radius: 1,
              monsters: [{ monster: "wolf", count: 1 }],
              respawn_seconds: 30,
            },
          ],
        },
      ],
    };
    expect(await e.importPatch("{}")).toBe(false);
    expect(e.state.world).toBe(before);
    expect(e.state.patchConflicts).toEqual([
      { path, kind: "file", reason: 'spawns entry "sneaky" is outside island "a"' },
    ]);
  });

  it("the before view refuses every edit path: delete, cut, paste, undo, redo, panels", () => {
    const { e } = patched();
    e.toggleAutoborder();
    e.pick("sand");
    e.strokeStart(3, 3, false);
    e.strokeEnd();
    e.setTool("select");
    e.strokeStart(1, 1, false);
    e.strokeMove(4, 4);
    e.strokeEnd();
    // Something to redo: paint, undo it (in "after"), then look at "before".
    e.setTool("brush");
    e.strokeStart(6, 6, false);
    e.strokeEnd();
    e.undo();
    expect(e.state.canRedo).toBe(true);
    e.setTool("select");
    e.setReviewSide("before");
    const w = e.state.world;
    e.deleteSelection();
    e.cut();
    e.pasteAt(10, 10);
    e.undo();
    e.redo();
    e.addEntity("spawns", {
      id: "den",
      center: { x: 4, y: 4, z: 7 },
      radius: 1,
      monsters: [{ monster: "wolf", count: 1 }],
      respawn_seconds: 30,
    });
    expect(e.state.world).toBe(w);
    expect(e.state.status).toBe("editor.review.before_readonly");
    e.setReviewSide("after");
    e.redo();
    expect(e.state.world).not.toBe(w);
  });

  it("an import started from the before view switches to after and applies", async () => {
    const { e, backend } = patched();
    const base = grassChunk();
    backend.parsed = {
      base_ref: "editor",
      files: [
        {
          path: CH,
          island: "a",
          target: { kind: "chunk", z: 7, cx: 0, cy: 0 },
          baseKnown: true,
          base,
          content: withTile(base, 2, 2, "sand"),
        },
      ],
    };
    e.setReviewSide("before");
    expect(await e.importPatch("{}")).toBe(true);
    expect(e.state.reviewSide).toBe("after");
    expect(tileAt(e.state.world, 2, 2, 7)?.ground).toBe("sand");
  });

  it("reports refused patches and keeps the before view read-only", async () => {
    const { e, backend } = patched();
    backend.parsed = new Error('patch touches "data/x.yaml", outside the map files of world/');
    expect(await e.importPatch("{}")).toBe(false);
    expect(e.state.status).toMatch(/^editor.patch.invalid/);
    e.setReviewSide("before");
    const w = e.state.world;
    e.strokeStart(1, 1, false);
    e.strokeEnd();
    expect(e.state.world).toBe(w);
    expect(e.state.status).toBe("editor.review.before_readonly");
    expect(e.viewWorld()).toBe(e.baseline);
  });
});

describe("house panel", () => {
  const H = "world/islands/a/houses.yaml";
  const OLD: House = {
    id: "a_old",
    name: "house.a_old.name",
    rent: 700,
    rects: [{ x: 20, y: 20, z: 7, w: 3, h: 3 }],
    doors: [{ x: 21, y: 22, z: 7 }],
    exit: { x: 21, y: 23, z: 7 },
  };
  function houses(withOld = false): { e: EditorController; backend: FakeBackend } {
    const backend = new FakeBackend();
    const w = world();
    if (withOld) (w.islands.get("a") as Island).houses.push(OLD);
    const e = new EditorController({
      world: w,
      items,
      t,
      loadErrors: [],
      base: withOld ? { [H]: "c".repeat(64) } : {},
      houseNames: {
        es: withOld ? { "house.a_old.name": "Casa Vieja" } : {},
        en: withOld ? { "house.a_old.name": "Old House" } : {},
      },
      backend,
    });
    return { e, backend };
  }
  const click = (e: EditorController, x: number, y: number, secondary = false): void => {
    e.strokeStart(x, y, secondary);
    e.strokeEnd();
  };
  const codes = (e: EditorController): string[] => e.houseIssues().map((i) => i.code);

  it("draws a new house on the map, lists its problems and applies it as one undoable step", async () => {
    const { e, backend } = houses();
    e.newHouse();
    expect(e.state.tool).toBe("house");
    expect(e.state.houseDraft?.id).toBe("a_house_1");
    expect(e.applyHouse()).toBe(false);
    expect(e.state.status).toMatch(/^editor\.house\.cant_apply .*no_tiles/);
    expect(e.state.world.islands.get("a")?.houses).toEqual([]);

    // Tiles: a dragged 4x3 room, a doorway, and a stray tile taken away again.
    e.strokeStart(2, 2, false);
    e.strokeMove(5, 4);
    expect(e.state.drag).toEqual({ x: 2, y: 2, w: 4, h: 3 });
    e.strokeEnd();
    click(e, 3, 5);
    click(e, 9, 9);
    click(e, 9, 9, true);
    expect(e.state.houseDraft?.tiles).toHaveLength(13);
    // Doors: inside the room is refused by the checks; right-click takes it away.
    e.setHouseMode("doors");
    click(e, 3, 3);
    expect(codes(e)).toContain("door_not_on_edge");
    click(e, 3, 3, true);
    click(e, 3, 5);
    e.setHouseMode("exit");
    click(e, 3, 6);
    e.editHouse({ rent: 650, names: { es: "Casa del Faro", en: "Lighthouse House" } });
    // Only warnings left (the test world has no ground): it can be applied.
    expect(codes(e)).toEqual(["no_ground"]);
    expect(e.state.world).toBe(e.baseline);

    expect(e.applyHouse()).toBe(true);
    expect(e.state.world.islands.get("a")?.houses).toEqual([
      {
        id: "a_house_1",
        name: "house.a_house_1.name",
        rent: 650,
        rects: [
          { x: 2, y: 2, z: 7, w: 4, h: 3 },
          { x: 3, y: 5, z: 7, w: 1, h: 1 },
        ],
        doors: [{ x: 3, y: 5, z: 7 }],
        exit: { x: 3, y: 6, z: 7 },
      },
    ]);
    expect(e.state.houseSel).toBe("a_house_1");
    expect(e.state.houseDraft?.key).toBe("a_house_1");
    expect(e.changes()).toEqual([{ file: H, base: null }]);
    expect(e.houseName("a_house_1", "es")).toBe("Casa del Faro");
    // The validator is told about the names that are not on disk yet.
    await e.validateNow();
    expect(backend.pending.at(-1)).toEqual([
      { lang: "en", key: "house.a_house_1.name" },
      { lang: "es", key: "house.a_house_1.name" },
    ]);

    // Undo takes the house away (and closes it); redo brings it back.
    e.undo();
    expect(e.state.world.islands.get("a")?.houses).toEqual([]);
    expect(e.state.houseDraft).toBeUndefined();
    e.redo();
    expect(e.houses().map((h) => h.id)).toEqual(["a_house_1"]);

    await e.save();
    expect(backend.saves).toEqual([[{ file: H, base: null }]]);
    expect(backend.texts).toEqual([
      [
        { lang: "en", key: "house.a_house_1.name", text: "Lighthouse House", base: null },
        { lang: "es", key: "house.a_house_1.name", text: "Casa del Faro", base: null },
      ],
    ]);
    expect(e.state.dirty).toBe(false);
  });

  it("edits a house in place: fixed id, set_house for the fields, a rename alone is saved too", async () => {
    const { e, backend } = houses(true);
    e.setTool("house");
    click(e, 21, 21); // the house tool opens the house under the cursor
    expect(e.state.houseSel).toBe("a_old");
    expect(e.state.houseDraft?.names).toEqual({ es: "Casa Vieja", en: "Old House" });
    expect(codes(e)).toEqual(["no_ground"]); // its own tiles and id are not taken
    e.editHouse({ id: "renamed", names: { es: "Casa Nueva" } });
    expect(e.state.houseDraft?.id).toBe("a_old");

    // Only the name changed: no op, no file, but the name is pending and saved.
    expect(e.applyHouse()).toBe(true);
    expect(e.state.canUndo).toBe(false);
    expect(e.changes()).toEqual([]);
    expect(e.state.dirty).toBe(true);
    await e.save();
    expect(backend.texts[0]).toEqual([
      { lang: "es", key: "house.a_old.name", text: "Casa Nueva", base: "Casa Vieja" },
    ]);
    expect(e.state.dirty).toBe(false);
    expect(e.applyHouse()).toBe(true);
    expect(e.state.status).toBe("editor.house.unchanged");

    e.editHouse({ rent: 900 });
    expect(e.applyHouse()).toBe(true);
    expect(e.houses()[0]?.rent).toBe(900);
    expect(e.changes()).toEqual([{ file: H, base: "c".repeat(64) }]);
    e.undo();
    expect(e.houses()[0]?.rent).toBe(700);
    expect(e.state.houseDraft?.rent).toBe(700); // the open house follows the world

    expect(e.removeHouse("a_old")).toBe(true);
    expect(e.houses()).toEqual([]);
    expect(e.state.houseDraft).toBeUndefined();
    e.undo();
    expect(e.houses()[0]).toEqual(OLD);
  });

  it("refuses a house over another one, outside the island or with its exit inside", () => {
    const { e } = houses(true);
    e.newHouse();
    e.strokeStart(18, 18, false);
    e.strokeMove(20, 20); // one tile of a_old
    e.strokeEnd();
    e.setHouseMode("doors");
    click(e, 18, 18);
    e.setHouseMode("exit");
    click(e, 19, 19); // inside the new house (next to the door, so not "far")
    e.editHouse({ names: { es: "Casa", en: "House" } });
    expect(codes(e)).toEqual(["overlap", "exit_in_house", "no_ground"]);
    expect(e.applyHouse()).toBe(false);
    expect(e.state.status).toMatch(/^editor\.house\.cant_apply .*overlap/);
    // Tiles off every island are not added at all.
    e.setHouseMode("tiles");
    e.strokeStart(30, 30, false);
    e.strokeMove(40, 30);
    e.strokeEnd();
    expect(e.state.houseDraft?.tiles.filter((p) => p.x >= 32)).toEqual([]);
  });

  it("houses.yaml and the house names never go in a map patch", async () => {
    const { e, backend } = houses(true);
    e.selectHouse("a_old");
    e.editHouse({ rent: 800 });
    e.applyHouse();
    expect(e.changedFiles()).toEqual([]);
    expect(await e.exportPatch()).toBeUndefined();
    expect(e.state.status).toBe("editor.patch.empty editor.patch.houses_skipped");
    expect(backend.exported).toEqual([]);
  });
});
