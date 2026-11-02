// Editor state and actions, independent of Preact and PixiJS. The UI renders `state` and
// calls the actions; the canvas reads the world and the camera from here.
import { OpError, applyOps } from "@rpg/map-format/ops";
import type { EraseLayer, MapOp, TouchedChunk, World } from "@rpg/map-format/ops";
import { centerOn, pan, zoomAt } from "@rpg/renderer/camera";
import type { Camera, ViewSize } from "@rpg/renderer/camera";
import { History, Stroke } from "../history/history.ts";
import type { Translate } from "../i18n.ts";
import { API_HEADER, chunkFile, toWire } from "../io/wire.ts";
import type {
  FileChange,
  PaletteItem,
  SaveConflictBody,
  SaveResult,
  ValidateResult,
  WireDiagnostic,
} from "../io/wire.ts";
import { historyLabel, line, toolOps } from "../tools/tools.ts";
import type { BrushSize, ToolName, ToolSettings } from "../tools/tools.ts";

export interface EditorState {
  world: World;
  /** Island the camera was last sent to (selector, ?island=). */
  island: string;
  floor: number;
  camera: Camera;
  tool: ToolName;
  ground: string;
  item: string;
  brushSize: BrushSize;
  eraseLayer: EraseLayer;
  grid: boolean;
  hover: { x: number; y: number } | undefined;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  validating: boolean;
  validation: ValidateResult | undefined;
  loadErrors: WireDiagnostic[];
  status: string;
}

/** The save was refused because these files changed on disk since they were loaded. */
export class ConflictError extends Error {
  readonly conflicts: string[];
  constructor(conflicts: string[]) {
    super(conflicts.join(", "));
    this.conflicts = conflicts;
  }
}

/**
 * The save failed after writing some files. `partial` is what reached the disk; the
 * editor moves those files' bases forward so its next save does not conflict with itself.
 */
export class PartialSaveError extends Error {
  readonly partial: SaveResult;
  constructor(message: string, partial: SaveResult) {
    super(message);
    this.partial = partial;
  }
}

export interface Backend {
  validate(world: World): Promise<ValidateResult>;
  /** Throws ConflictError on a 409. */
  save(world: World, changes: FileChange[]): Promise<SaveResult>;
}

async function post<T>(url: string, data: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", [API_HEADER]: "1" },
    body: JSON.stringify(data),
  });
  if (res.status === 409)
    throw new ConflictError(((await res.json()) as SaveConflictBody).conflicts);
  if (!res.ok) {
    const body = (await res.json()) as { error: string; partial?: SaveResult };
    if (body.partial) throw new PartialSaveError(body.error, body.partial);
    throw new Error(body.error);
  }
  return (await res.json()) as T;
}

export const httpBackend: Backend = {
  validate: (world) => post<ValidateResult>("/api/validate", toWire(world)),
  save: (world, changes) => post<SaveResult>("/api/save", { world: toWire(world), changes }),
};

export const VALIDATE_DELAY_MS = 300;

export interface EditorOptions {
  world: World;
  items: PaletteItem[];
  t: Translate;
  loadErrors: WireDiagnostic[];
  /** Hash of each chunk file as loaded (Bootstrap.base). */
  base: Record<string, string>;
  /** Island to open (?island=); the first one in world.yaml otherwise. */
  island?: string | null;
  backend?: Backend;
}

export class EditorController {
  state: EditorState;
  readonly items: Map<string, PaletteItem>;
  readonly t: Translate;
  view: ViewSize = { width: 800, height: 600 };
  private centered = false;
  private readonly history: History;
  private readonly backend: Backend;
  private readonly listeners = new Set<() => void>();
  private stroke:
    | { stroke: Stroke; secondary: boolean; last: { x: number; y: number }; done: Set<string> }
    | undefined;
  private validateTimer: ReturnType<typeof setTimeout> | undefined;
  private validateSeq = 0;
  private saving = false;
  /** Hash of each chunk file as it is on disk, as far as the editor knows. */
  private readonly base: Map<string, string>;
  /** Chunk files changed since the last save → their base hash (null: no file). */
  private readonly pending = new Map<string, string | null>();

  constructor(opts: EditorOptions) {
    this.items = new Map(opts.items.map((i) => [i.id, i]));
    this.t = opts.t;
    this.backend = opts.backend ?? httpBackend;
    this.base = new Map(Object.entries(opts.base));
    this.history = new History({ itemKind: (id) => this.items.get(id)?.kind });
    const island =
      (opts.island && opts.world.islands.get(opts.island)) ||
      opts.world.islands.values().next().value;
    const temple = island?.meta.temple ?? { x: 0, y: 0, z: 7 };
    const grounds = opts.items.filter((i) => i.kind === "ground");
    const others = opts.items.filter((i) => i.kind !== "ground");
    this.state = {
      world: opts.world,
      island: island?.meta.id ?? "",
      floor: temple.z,
      camera: { x: temple.x, y: temple.y, zoom: 1 },
      tool: "brush",
      ground: grounds.find((g) => g.id === "grass")?.id ?? grounds[0]?.id ?? "",
      item: others[0]?.id ?? "",
      brushSize: 1,
      eraseLayer: "all",
      grid: true,
      hover: undefined,
      dirty: false,
      canUndo: false,
      canRedo: false,
      validating: false,
      validation: undefined,
      loadErrors: opts.loadErrors,
      status: "",
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---- view --------------------------------------------------------------------------

  /** Called with the canvas size; the first call centres the initial island's temple. */
  setView(view: ViewSize, tileSize: number): void {
    this.view = view;
    if (this.centered) return;
    this.centered = true;
    // Until now the camera's x/y hold the tile to centre (the temple), not the corner.
    this.centerTile(this.state.camera.x, this.state.camera.y, this.state.floor, tileSize);
  }

  centerTile(x: number, y: number, z: number, tileSize: number): void {
    this.set({ floor: z, camera: centerOn(this.state.camera, x, y, this.view, tileSize) });
  }

  /** Moves the camera to an island's temple. */
  selectIsland(id: string, tileSize: number): void {
    const island = this.state.world.islands.get(id);
    if (!island) return;
    const t = island.meta.temple;
    this.set({ island: id });
    this.centerTile(t.x, t.y, t.z, tileSize);
  }

  zoom(factor: number, sx: number, sy: number, tileSize: number): void {
    this.set({ camera: zoomAt(this.state.camera, factor, sx, sy, tileSize) });
  }

  pan(dx: number, dy: number, tileSize: number): void {
    this.set({ camera: pan(this.state.camera, dx, dy, tileSize) });
  }

  setHover(hover: { x: number; y: number } | undefined): void {
    const h = this.state.hover;
    if (h?.x === hover?.x && h?.y === hover?.y) return;
    this.set({ hover });
  }

  changeFloor(delta: number): void {
    const floor = Math.min(15, Math.max(0, this.state.floor + delta));
    if (floor !== this.state.floor) this.set({ floor });
  }

  // ---- settings ----------------------------------------------------------------------

  setTool(tool: ToolName): void {
    this.set({ tool });
  }

  /** Picks a palette entry: grounds go to the brush, everything else to the item tool. */
  pick(id: string): void {
    const kind = this.items.get(id)?.kind;
    if (kind === undefined) return;
    if (kind === "ground") this.set({ ground: id, tool: "brush" });
    else this.set({ item: id, tool: "item" });
  }

  setBrushSize(brushSize: BrushSize): void {
    this.set({ brushSize });
  }

  setEraseLayer(eraseLayer: EraseLayer): void {
    this.set({ eraseLayer });
  }

  toggleGrid(): void {
    this.set({ grid: !this.state.grid });
  }

  // ---- editing -----------------------------------------------------------------------

  private settings(): ToolSettings {
    const s = this.state;
    return {
      tool: s.tool,
      floor: s.floor,
      ground: s.ground,
      item: s.item,
      brushSize: s.brushSize,
      eraseLayer: s.eraseLayer,
    };
  }

  private reject(e: unknown): void {
    if (!(e instanceof OpError)) throw e;
    this.set({ status: this.t("editor.op_rejected", { error: e.message }) });
  }

  /** Applies ops for the current stroke; reports rejected ops in the status bar. */
  private applyToStroke(ops: MapOp[]): void {
    if (!this.stroke || ops.length === 0) return;
    try {
      const r = applyOps(this.state.world, ops, { itemKind: (id) => this.items.get(id)?.kind });
      this.stroke.stroke.add(ops, r.inverse);
      if (r.inverse.length > 0) this.changed(r.world, r.touched);
    } catch (e) {
      this.reject(e);
    }
  }

  private useAt(x: number, y: number): void {
    const st = this.stroke;
    if (!st) return;
    // The item tool acts once per tile per stroke; the others are idempotent anyway.
    const key = `${x},${y}`;
    if (st.done.has(key)) return;
    st.done.add(key);
    this.applyToStroke(toolOps(this.state.world, this.settings(), x, y, st.secondary));
  }

  strokeStart(x: number, y: number, secondary: boolean): void {
    this.strokeEnd();
    const label = historyLabel(this.state.tool, secondary);
    this.stroke = { stroke: new Stroke(label), secondary, last: { x, y }, done: new Set() };
    this.useAt(x, y);
  }

  strokeMove(x: number, y: number): void {
    const st = this.stroke;
    if (!st || (st.last.x === x && st.last.y === y)) return;
    for (const c of line(st.last, { x, y }).slice(1)) this.useAt(c.x, c.y);
    st.last = { x, y };
  }

  strokeEnd(): void {
    const st = this.stroke;
    this.stroke = undefined;
    if (!st || st.stroke.empty) return;
    this.history.record(st.stroke.entry());
    this.syncHistory();
  }

  undo(): void {
    this.strokeEnd();
    try {
      const step = this.history.undo(this.state.world);
      if (!step) return;
      this.changed(step.world, step.touched);
      this.syncHistory(this.t("editor.undone", { action: this.t(step.entry.label) }));
    } catch (e) {
      this.reject(e);
    }
  }

  redo(): void {
    this.strokeEnd();
    try {
      const step = this.history.redo(this.state.world);
      if (!step) return;
      this.changed(step.world, step.touched);
      this.syncHistory(this.t("editor.redone", { action: this.t(step.entry.label) }));
    } catch (e) {
      this.reject(e);
    }
  }

  private syncHistory(status?: string): void {
    this.set({
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      ...(status === undefined ? {} : { status }),
    });
  }

  private changed(world: World, touched: TouchedChunk[]): void {
    for (const t of touched) {
      const file = chunkFile(t.island, t.z, t.cx, t.cy);
      if (!this.pending.has(file)) this.pending.set(file, this.base.get(file) ?? null);
    }
    this.set({ world, dirty: true });
    this.scheduleValidation();
  }

  /** Chunk files changed since the last save, with the base they are saved against. */
  changes(): FileChange[] {
    return [...this.pending]
      .map(([file, base]) => ({ file, base }))
      .sort((a, b) => (a.file < b.file ? -1 : 1));
  }

  // ---- validation and saving -----------------------------------------------------------

  scheduleValidation(delay = VALIDATE_DELAY_MS): void {
    if (this.validateTimer !== undefined) clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => void this.validateNow(), delay);
  }

  async validateNow(): Promise<void> {
    this.validateTimer = undefined;
    const seq = ++this.validateSeq;
    this.set({ validating: true });
    try {
      const validation = await this.backend.validate(this.state.world);
      if (seq === this.validateSeq) this.set({ validation, validating: false });
    } catch (e) {
      if (seq === this.validateSeq)
        this.set({ validating: false, status: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Moves bases forward after a save. On a partial save only the files that were written
   * or removed move; the others keep their old base, so a change made on disk meanwhile
   * is still detected as a conflict.
   */
  private settle(r: SaveResult, saved: World, partial: boolean): void {
    const editedSince = this.state.world !== saved;
    const done = new Set([...r.written, ...r.removed]);
    for (const [file, hash] of Object.entries(r.base)) {
      if (partial && !done.has(file)) continue;
      if (hash === null) this.base.delete(file);
      else this.base.set(file, hash);
      // Files edited again while saving stay pending, now against the new base.
      if (editedSince) this.pending.set(file, hash);
      else this.pending.delete(file);
    }
  }

  async save(): Promise<void> {
    this.strokeEnd();
    if (this.saving) return;
    this.saving = true;
    const world = this.state.world;
    const changes = this.changes();
    try {
      const r = await this.backend.save(world, changes);
      this.settle(r, world, false);
      this.set({
        dirty: this.state.world !== world || this.pending.size > 0,
        status: this.t("editor.saved", { written: r.written.length, removed: r.removed.length }),
      });
    } catch (e) {
      if (e instanceof PartialSaveError) this.settle(e.partial, world, true);
      const status =
        e instanceof ConflictError
          ? this.t("editor.save_conflict", {
              count: e.conflicts.length,
              files: e.conflicts.map((f) => f.replace(/^world\/islands\//, "")).join(", "),
            })
          : this.t("editor.save_failed", { error: e instanceof Error ? e.message : String(e) });
      this.set({ status });
    } finally {
      this.saving = false;
    }
  }
}
