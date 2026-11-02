// Editor state and actions, independent of Preact and PixiJS. The UI renders `state` and
// calls the actions; the canvas reads the world and the camera from here.
import { OpError, applyOps } from "@rpg/map-format/ops";
import type { EraseLayer, MapOp, World } from "@rpg/map-format/ops";
import { centerOn, pan, zoomAt } from "@rpg/renderer/camera";
import type { Camera, ViewSize } from "@rpg/renderer/camera";
import { History, Stroke } from "../history/history.ts";
import type { Translate } from "../i18n.ts";
import { toWire } from "../io/wire.ts";
import type { PaletteItem, SaveResult, ValidateResult, WireDiagnostic } from "../io/wire.ts";
import { historyLabel, line, toolOps } from "../tools/tools.ts";
import type { BrushSize, ToolName, ToolSettings } from "../tools/tools.ts";

export interface EditorState {
  world: World;
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

export interface Backend {
  validate(world: World): Promise<ValidateResult>;
  save(world: World): Promise<SaveResult>;
}

export const httpBackend: Backend = {
  async validate(world) {
    const res = await fetch("/api/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toWire(world)),
    });
    if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
    return (await res.json()) as ValidateResult;
  },
  async save(world) {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toWire(world)),
    });
    if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
    return (await res.json()) as SaveResult;
  },
};

export const VALIDATE_DELAY_MS = 300;

export class EditorController {
  state: EditorState;
  readonly items: Map<string, PaletteItem>;
  readonly t: Translate;
  view: ViewSize = { width: 800, height: 600 };
  private readonly history: History;
  private readonly backend: Backend;
  private readonly listeners = new Set<() => void>();
  private stroke:
    | { stroke: Stroke; secondary: boolean; last: { x: number; y: number }; done: Set<string> }
    | undefined;
  private validateTimer: ReturnType<typeof setTimeout> | undefined;
  private validateSeq = 0;
  private saving = false;

  constructor(opts: {
    world: World;
    items: PaletteItem[];
    t: Translate;
    loadErrors: WireDiagnostic[];
    backend?: Backend;
  }) {
    this.items = new Map(opts.items.map((i) => [i.id, i]));
    this.t = opts.t;
    this.backend = opts.backend ?? httpBackend;
    this.history = new History({ itemKind: (id) => this.items.get(id)?.kind });
    const first = opts.world.islands.values().next().value;
    const temple = first?.meta.temple ?? { x: 0, y: 0, z: 7 };
    const grounds = opts.items.filter((i) => i.kind === "ground");
    const others = opts.items.filter((i) => i.kind !== "ground");
    this.state = {
      world: opts.world,
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

  setView(view: ViewSize, tileSize: number): void {
    const first = this.view.width === 800 && this.view.height === 600;
    this.view = view;
    if (first)
      this.centerTile(this.state.camera.x, this.state.camera.y, this.state.floor, tileSize);
  }

  centerTile(x: number, y: number, z: number, tileSize: number): void {
    this.set({ floor: z, camera: centerOn(this.state.camera, x, y, this.view, tileSize) });
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

  /** Applies ops for the current stroke; returns false (and reports) if they were rejected. */
  private applyToStroke(ops: MapOp[]): boolean {
    if (!this.stroke || ops.length === 0) return true;
    try {
      const r = applyOps(this.state.world, ops, { itemKind: (id) => this.items.get(id)?.kind });
      this.stroke.stroke.add(ops, r.inverse);
      if (r.inverse.length > 0) this.changed(r.world);
      return true;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      this.set({ status: this.t("editor.op_rejected", { error: e.message }) });
      return false;
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
    const step = this.history.undo(this.state.world);
    if (!step) return;
    this.changed(step.world);
    this.syncHistory(this.t("editor.undone", { action: this.t(step.entry.label) }));
  }

  redo(): void {
    this.strokeEnd();
    const step = this.history.redo(this.state.world);
    if (!step) return;
    this.changed(step.world);
    this.syncHistory(this.t("editor.redone", { action: this.t(step.entry.label) }));
  }

  private syncHistory(status?: string): void {
    this.set({
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      ...(status === undefined ? {} : { status }),
    });
  }

  private changed(world: World): void {
    this.set({ world, dirty: true });
    this.scheduleValidation();
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

  async save(): Promise<void> {
    this.strokeEnd();
    if (this.saving) return;
    this.saving = true;
    const world = this.state.world;
    try {
      const r = await this.backend.save(world);
      this.set({
        dirty: this.state.world !== world,
        status: this.t("editor.saved", { written: r.written.length, removed: r.removed.length }),
      });
    } catch (e) {
      this.set({
        status: this.t("editor.save_failed", { error: e instanceof Error ? e.message : String(e) }),
      });
    } finally {
      this.saving = false;
    }
  }
}
