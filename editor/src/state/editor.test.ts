import { CHUNK_SIZE } from "@rpg/map-format/ops";
import type { Chunk, Island, World } from "@rpg/map-format/ops";
import { describe, expect, it } from "vitest";
import { screenToTile } from "@rpg/renderer/camera";
import type { FileChange, PaletteItem, SaveResult, ValidateResult } from "../io/wire.ts";
import { ConflictError, EditorController } from "./editor.ts";
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

function editor(opts: { island?: string; backend?: Backend } = {}): EditorController {
  return new EditorController({
    world: world(),
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
