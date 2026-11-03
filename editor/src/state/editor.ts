// Editor state and actions, independent of Preact and PixiJS. The UI renders `state` and
// calls the actions; the canvas reads the world and the camera from here.
import {
  OpError,
  applyOps,
  diffWorlds,
  entryAddOp,
  entryRemoveOp,
  rectContains,
} from "@rpg/map-format/ops";
import type {
  BorderRule,
  EntityList,
  EraseLayer,
  Island,
  MapOp,
  NpcPlacement,
  OpOptions,
  Portal,
  Position,
  Rect,
  Spawn,
  TouchedAux,
  TouchedChunk,
  World,
  WorldDiff,
  Zone,
} from "@rpg/map-format/ops";
import { centerOn, pan, zoomAt } from "@rpg/renderer/camera";
import type { Camera, ViewSize } from "@rpg/renderer/camera";
import { History, Stroke } from "../history/history.ts";
import type { Translate } from "../i18n.ts";
import { API_HEADER, auxFile, chunkFile, toWire } from "../io/wire.ts";
import { planImport } from "../review/patch.ts";
import type { ImportConflict } from "../review/patch.ts";
import { MAX_PATCH_SIZE } from "../io/wire.ts";
import type {
  FileChange,
  PaletteItem,
  ParsedPatch,
  PatchExportRequest,
  SaveConflictBody,
  SaveResult,
  ValidateResult,
  WireDiagnostic,
} from "../io/wire.ts";
import {
  autoborderAfter,
  clipToIslands,
  copyRect,
  historyLabel,
  line,
  pasteOps,
  rectOf,
  rectOps,
  toolOps,
} from "../tools/tools.ts";
import type { BrushSize, Clipboard, ToolName, ToolSettings } from "../tools/tools.ts";

/** An entry of one of the auxiliary lists the panels edit. */
export type Entity = Spawn | NpcPlacement | Zone | Portal;

/** Key of an entity in its list: `id`, or `npc` for NPC placements. */
export const entityKey = (e: Entity): string => ("npc" in e ? e.npc : e.id);

/** Tile an entity is shown and centred at (spawn centre, NPC tile, first zone rect, portal origin). */
export function entityPos(e: Entity): Position {
  if ("center" in e) return e.center;
  if ("pos" in e) return e.pos;
  if ("from" in e) return e.from;
  const r = e.rects[0] ?? { x: 0, y: 0, w: 1, h: 1 };
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2), z: e.floors[0] ?? 7 };
}

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
  /** Recompute borders (data/borders.yaml) around every ground change. */
  autoborder: boolean;
  /** Rect being dragged with the rectangle or selection tool (preview). */
  drag: Rect | undefined;
  /** Selected rect (selection tool) on `selectionFloor`. */
  selection: Rect | undefined;
  selectionFloor: number;
  /** Copied tiles; pasted with Ctrl+V on any floor. */
  clipboard: Clipboard | undefined;
  /** Paste mode: the next click pastes the clipboard with its top-left on that tile. */
  pasting: boolean;
  /** Entity panel: list shown and the key of the selected entry. */
  entityTab: EntityList;
  entitySel: string | undefined;
  /** A panel asked for a tile: the next click on the map answers it instead of the tool. */
  picking: boolean;
  hover: { x: number; y: number } | undefined;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  validating: boolean;
  validation: ValidateResult | undefined;
  loadErrors: WireDiagnostic[];
  status: string;
  /** Review panel (map patches, diff against what was loaded) is open. */
  review: boolean;
  /** Which world the canvas shows while reviewing: as loaded ("before") or now ("after"). */
  reviewSide: "before" | "after";
  /** Conflicts of the last patch import (nothing was applied). */
  patchConflicts: ImportConflict[];
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
  /** Builds a .rpgpatch.json (an object, ready to serialise) of the files that differ. */
  exportPatch(req: PatchExportRequest): Promise<unknown>;
  /** Checks and parses a .rpgpatch.json; throws with the server's reason if it is refused. */
  parsePatch(text: string): Promise<ParsedPatch>;
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
  exportPatch: (req) => post<unknown>("/api/patch/export", req),
  parsePatch: (text) => post<ParsedPatch>("/api/patch/parse", { text }),
};

export const VALIDATE_DELAY_MS = 300;

export interface EditorOptions {
  world: World;
  items: PaletteItem[];
  t: Translate;
  loadErrors: WireDiagnostic[];
  /** Hash of each chunk and auxiliary file as loaded (Bootstrap.base). */
  base: Record<string, string>;
  borders?: BorderRule[];
  monsters?: string[];
  npcs?: string[];
  /** Island to open (?island=); the first one in world.yaml otherwise. */
  island?: string | null;
  backend?: Backend;
}

export class EditorController {
  state: EditorState;
  readonly items: Map<string, PaletteItem>;
  readonly t: Translate;
  readonly monsters: string[];
  readonly npcs: string[];
  private readonly borders: BorderRule[];
  private pickCallback: ((pos: Position) => void) | undefined;
  view: ViewSize = { width: 800, height: 600 };
  private centered = false;
  private readonly history: History;
  private readonly backend: Backend;
  private readonly listeners = new Set<() => void>();
  private stroke:
    | {
        stroke: Stroke;
        secondary: boolean;
        start: { x: number; y: number };
        last: { x: number; y: number };
        done: Set<string>;
      }
    | undefined;
  private validateTimer: ReturnType<typeof setTimeout> | undefined;
  private validateSeq = 0;
  private saving = false;
  /** Hash of each chunk/auxiliary file as it is on disk, as far as the editor knows. */
  private readonly base: Map<string, string>;
  /** Files changed since the last save → their base hash (null: no file). */
  private readonly pending = new Map<string, string | null>();
  /** The world as loaded from disk: the base of exported patches and of the diff view. */
  readonly baseline: World;
  private diffCache: { world: World; diff: WorldDiff } | undefined;

  constructor(opts: EditorOptions) {
    this.items = new Map(opts.items.map((i) => [i.id, i]));
    this.t = opts.t;
    this.backend = opts.backend ?? httpBackend;
    this.base = new Map(Object.entries(opts.base));
    this.baseline = opts.world;
    this.borders = opts.borders ?? [];
    this.monsters = opts.monsters ?? [];
    this.npcs = opts.npcs ?? [];
    this.history = new History(this.opOptions(), { borders: this.borders });
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
      autoborder: true,
      drag: undefined,
      selection: undefined,
      selectionFloor: temple.z,
      clipboard: undefined,
      pasting: false,
      entityTab: "spawns",
      entitySel: undefined,
      picking: false,
      hover: undefined,
      dirty: false,
      canUndo: false,
      canRedo: false,
      validating: false,
      validation: undefined,
      loadErrors: opts.loadErrors,
      status: "",
      review: false,
      reviewSide: "after",
      patchConflicts: [],
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
    this.set({ tool, pasting: false });
  }

  /** Shows a message in the status bar. */
  reportStatus(status: string): void {
    this.set({ status });
  }

  /** The island the camera was last sent to. */
  island(): Island | undefined {
    return this.state.world.islands.get(this.state.island);
  }

  toggleAutoborder(): void {
    this.set({ autoborder: !this.state.autoborder });
  }

  /** Picks a palette entry: grounds go to the brush, everything else to the item tool. */
  pick(id: string): void {
    const kind = this.items.get(id)?.kind;
    if (kind === undefined) return;
    if (kind === "ground") {
      // Fill and rectangle paint grounds too: picking one keeps them.
      const keep = this.state.tool === "fill" || this.state.tool === "rect";
      this.set({ ground: id, tool: keep ? this.state.tool : "brush" });
    } else this.set({ item: id, tool: "item" });
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

  /** What applyOps checks for new edits: known items, monsters, NPCs; border rules. */
  private opOptions(): OpOptions {
    const monsters = new Set(this.monsters);
    const npcs = new Set(this.npcs);
    return {
      itemKind: (id) => this.items.get(id)?.kind,
      ...(this.monsters.length > 0 ? { monsterKnown: (id: string) => monsters.has(id) } : {}),
      ...(this.npcs.length > 0 ? { npcKnown: (id: string) => npcs.has(id) } : {}),
      borders: this.borders,
    };
  }

  private reject(e: unknown): void {
    if (!(e instanceof OpError)) throw e;
    this.set({ status: this.t("editor.op_rejected", { error: e.message }) });
  }

  /**
   * Applies ops to the current world, followed by the autoborder of the area whose ground
   * changed (when enabled). Returns the edit or undefined if nothing changed; throws
   * OpError (and changes nothing) if an op is invalid.
   */
  private edit(
    ops: MapOp[],
    autoborder = true,
  ): { forward: MapOp[]; inverse: MapOp[] } | undefined {
    if (ops.length === 0) return undefined;
    const opts = this.opOptions();
    const r = applyOps(this.state.world, ops, opts);
    if (r.inverse.length === 0) return undefined;
    let world = r.world;
    const forward = [...ops];
    let inverse = r.inverse;
    const touched = [...r.touched];
    const touchedAux = [...r.touchedAux];
    if (autoborder && this.state.autoborder && this.borders.length > 0) {
      const ab = autoborderAfter(world, r.inverse);
      if (ab.length > 0) {
        const b = applyOps(world, ab, opts);
        world = b.world;
        forward.push(...ab);
        inverse = [...b.inverse, ...r.inverse];
        touched.push(...b.touched);
      }
    }
    this.changed(world, touched, touchedAux);
    return { forward, inverse };
  }

  /** Applies ops for the current stroke; reports rejected ops in the status bar. */
  private applyToStroke(ops: MapOp[]): void {
    if (!this.stroke || ops.length === 0) return;
    try {
      const e = this.edit(ops);
      if (e) this.stroke.stroke.add(e.forward, e.inverse);
    } catch (e) {
      this.reject(e);
    }
  }

  /** One-shot edit (rectangle, paste, panels) recorded as one history entry. */
  private commit(label: string, ops: MapOp[], autoborder = true): boolean {
    this.strokeEnd();
    try {
      const e = this.edit(ops, autoborder);
      if (!e) return false;
      this.history.record({ label, ...e });
      this.syncHistory();
      return true;
    } catch (e) {
      this.reject(e);
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

  /** Whether the current tool works on a dragged rect instead of tile by tile. */
  private get dragging(): boolean {
    return this.state.tool === "rect" || this.state.tool === "select";
  }

  strokeStart(x: number, y: number, secondary: boolean): void {
    this.strokeEnd();
    if (this.state.review && this.state.reviewSide === "before") {
      this.set({ status: this.t("editor.review.before_readonly") });
      return;
    }
    if (this.pickCallback) {
      const cb = this.pickCallback;
      this.pickCallback = undefined;
      this.set({ picking: false });
      cb({ x, y, z: this.state.floor });
      return;
    }
    if (this.state.pasting) {
      if (!secondary) this.pasteAt(x, y);
      this.set({ pasting: false });
      return;
    }
    const label = historyLabel(this.state.tool, secondary);
    const at = { x, y };
    this.stroke = { stroke: new Stroke(label), secondary, start: at, last: at, done: new Set() };
    if (this.dragging) this.set({ drag: rectOf(at, at) });
    else this.useAt(x, y);
  }

  strokeMove(x: number, y: number): void {
    const st = this.stroke;
    if (!st || (st.last.x === x && st.last.y === y)) return;
    if (this.dragging) this.set({ drag: rectOf(st.start, { x, y }) });
    else if (this.state.tool === "fill") {
      // Fill is one click: moving while pressed must not flood the regions crossed.
    } else for (const c of line(st.last, { x, y }).slice(1)) this.useAt(c.x, c.y);
    st.last = { x, y };
  }

  strokeEnd(): void {
    const st = this.stroke;
    this.stroke = undefined;
    if (!st) return;
    const drag = this.state.drag;
    if (drag) {
      this.set({ drag: undefined });
      if (this.state.tool === "select")
        this.set({ selection: drag, selectionFloor: this.state.floor });
      else if (this.state.tool === "rect") {
        try {
          const e = this.edit(rectOps(this.state.world, this.settings(), drag, st.secondary));
          if (e) st.stroke.add(e.forward, e.inverse);
        } catch (e) {
          this.reject(e);
        }
      }
    }
    if (st.stroke.empty) return;
    this.history.record(st.stroke.entry());
    this.syncHistory();
  }

  // ---- selection and clipboard ---------------------------------------------------------

  clearSelection(): void {
    this.set({ selection: undefined, pasting: false, drag: undefined });
    this.cancelPick();
  }

  /** Copies the selected tiles (ground and stacks); false when there is no selection. */
  copy(): boolean {
    const sel = this.state.selection;
    if (!sel) return false;
    const clipboard = copyRect(this.state.world, this.state.selectionFloor, sel);
    this.set({
      clipboard,
      status: this.t("editor.copied", { w: clipboard.w, h: clipboard.h }),
    });
    return true;
  }

  /** Erases the selected tiles (the eraser's layer by default). */
  deleteSelection(layer: EraseLayer = this.state.eraseLayer): void {
    const sel = this.state.selection;
    if (!sel) return;
    const s = { ...this.settings(), floor: this.state.selectionFloor, eraseLayer: layer };
    this.commit("editor.history.erase", rectOps(this.state.world, s, sel, true));
  }

  cut(): void {
    // Copy takes ground and items, so cut removes both whatever the eraser's layer is.
    if (this.copy()) this.deleteSelection("all");
  }

  /** Enters paste mode (the next click pastes); false when the clipboard is empty. */
  startPaste(): boolean {
    if (!this.state.clipboard) return false;
    this.set({ pasting: true, status: this.t("editor.paste_hint") });
    return true;
  }

  /** Pastes the clipboard with its top-left at (x, y) on the current floor. */
  pasteAt(x: number, y: number): void {
    const clip = this.state.clipboard;
    if (!clip) return;
    const z = this.state.floor;
    const ops = pasteOps(this.state.world, clip, x, y, z);
    // Pasted stacks may carry border pieces of the source: recompute the pasted area even
    // where the ground did not change (edit() only covers cells whose ground changed).
    if (ops.length > 0 && this.state.autoborder && this.borders.length > 0)
      for (const rect of clipToIslands(this.state.world, { x, y, w: clip.w, h: clip.h }, z))
        ops.push({ op: "autoborder", floor: z, rect });
    if (this.commit("editor.history.paste", ops))
      this.set({ selection: { x, y, w: clip.w, h: clip.h }, selectionFloor: z });
  }

  // ---- entity panels -------------------------------------------------------------------

  /** A pick asked for by one form never lands in another: switching cancels it. */
  setEntityTab(entityTab: EntityList): void {
    this.cancelPick();
    this.set({ entityTab, entitySel: undefined });
  }

  selectEntity(key: string | undefined): void {
    this.cancelPick();
    this.set({ entitySel: key });
  }

  /** The next click on the map calls `cb` with that tile instead of using the tool. */
  requestPick(cb: (pos: Position) => void): void {
    this.pickCallback = cb;
    this.set({ picking: true, status: this.t("editor.pick_hint") });
  }

  cancelPick(): void {
    if (!this.pickCallback) return;
    this.pickCallback = undefined;
    this.set({ picking: false });
  }

  /** Entries of `file` in `island` (the current one by default). */
  entities(file: EntityList, island = this.state.island): Entity[] {
    return (this.state.world.islands.get(island)?.[file] ?? []) as Entity[];
  }

  /** Island and index of the entity with `key` in `file`, in any island. */
  private findEntity(file: EntityList, key: string): { island: string; index: number } | undefined {
    for (const [id, isl] of this.state.world.islands) {
      const index = (isl[file] as Entity[]).findIndex((e) => entityKey(e) === key);
      if (index >= 0) return { island: id, index };
    }
    return undefined;
  }

  private islandOf(p: Position): string | undefined {
    for (const [id, isl] of this.state.world.islands)
      if (rectContains(isl.meta.rect, p.x, p.y)) return id;
    return undefined;
  }

  /**
   * Checks the mistakes a person makes in the forms, so the status bar says what is wrong
   * in their language; the op still validates everything (its raw message only shows up
   * for what slips through). Reports and returns false on a problem.
   */
  private checkEntity(file: EntityList, entry: Entity, oldKey: string | undefined): boolean {
    const p = entityProblem(this.state.world, file, entry, oldKey);
    if (!p) return true;
    const params = { ...p.params };
    if (typeof params["what"] === "string") params["what"] = this.t(params["what"]);
    this.set({ status: this.t(p.key, params) });
    return false;
  }

  /** Creates an entity; returns false (and reports why) if it is rejected. */
  addEntity(file: EntityList, entry: Entity): boolean {
    if (!this.checkEntity(file, entry, undefined)) return false;
    const ok = this.commit("editor.history.entity_add", [addOp(file, entry, undefined)]);
    if (ok)
      this.set({
        entitySel: entityKey(entry),
        island: this.islandOf(entityPos(entry)) ?? this.state.island,
      });
    return ok;
  }

  /**
   * Replaces the entity `key` with `entry` (it may be renamed or moved): one history entry
   * made of the remove and the add, at the same index when it stays in the same island.
   */
  updateEntity(file: EntityList, key: string, entry: Entity): boolean {
    const at = this.findEntity(file, key);
    if (!at) return this.addEntity(file, entry);
    if (!this.checkEntity(file, entry, key)) return false;
    const index = this.islandOf(entityPos(entry)) === at.island ? at.index : undefined;
    const ok = this.commit("editor.history.entity_edit", [
      removeOp(file, key),
      addOp(file, entry, index),
    ]);
    if (ok) this.set({ entitySel: entityKey(entry) });
    return ok;
  }

  removeEntity(file: EntityList, key: string): boolean {
    const ok = this.commit("editor.history.entity_remove", [removeOp(file, key)]);
    if (ok && this.state.entitySel === key) this.set({ entitySel: undefined });
    return ok;
  }

  // ---- review: map patches and diff -------------------------------------------------------

  /** World the canvas draws: the loaded one while reviewing "before", else the current one. */
  viewWorld(): World {
    return this.state.review && this.state.reviewSide === "before"
      ? this.baseline
      : this.state.world;
  }

  /** What changed since the world was loaded (chunks with their tiles, list entries). */
  diff(): WorldDiff {
    const world = this.state.world;
    if (this.diffCache?.world !== world)
      this.diffCache = { world, diff: diffWorlds(this.baseline, world) };
    return this.diffCache.diff;
  }

  toggleReview(): void {
    this.set({ review: !this.state.review, reviewSide: "after" });
  }

  setReviewSide(reviewSide: "before" | "after"): void {
    this.set({ review: true, reviewSide });
  }

  /** Paths of the chunk and auxiliary files that differ from what was loaded. */
  changedFiles(): string[] {
    const d = this.diff();
    return [
      ...d.chunks.map((c) => chunkFile(c.island, c.z, c.cx, c.cy)),
      ...d.lists
        .filter((l) => l.list !== "texts")
        .map((l) => auxFile(l.island, l.list as EntityList)),
    ].sort();
  }

  /**
   * The changes against what was loaded from disk as a .rpgpatch.json text (format 2),
   * or undefined (and a status message) when there is nothing to export or it failed.
   * Writes nothing to world/.
   */
  async exportPatch(): Promise<string | undefined> {
    this.strokeEnd();
    const files = this.changedFiles();
    if (files.length === 0) {
      this.set({ status: this.t("editor.patch.empty") });
      return undefined;
    }
    try {
      const patch = await this.backend.exportPatch({
        before: toWire(this.baseline),
        after: toWire(this.state.world),
        files,
      });
      this.set({ status: this.t("editor.patch.exported", { files: files.length }) });
      return `${JSON.stringify(patch, null, 2)}\n`;
    } catch (e) {
      this.set({
        status: this.t("editor.patch.export_failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
      return undefined;
    }
  }

  /**
   * Imports a .rpgpatch.json: merges it into the current world tile by tile and entry by
   * entry (the same merge as mapcli patch apply) and applies it as one history entry.
   * With conflicts nothing is applied and they are listed in the review panel.
   */
  async importPatch(text: string): Promise<boolean> {
    this.strokeEnd();
    if (text.length > MAX_PATCH_SIZE) {
      this.set({ status: this.t("editor.patch.too_big", { mb: MAX_PATCH_SIZE >> 20 }) });
      return false;
    }
    let parsed: ParsedPatch;
    try {
      parsed = await this.backend.parsePatch(text);
    } catch (e) {
      this.set({
        patchConflicts: [],
        status: this.t("editor.patch.invalid", {
          error: e instanceof Error ? e.message : String(e),
        }),
      });
      return false;
    }
    const plan = planImport(this.state.world, parsed);
    if (plan.conflicts.length > 0) {
      this.set({
        review: true,
        reviewSide: "after",
        patchConflicts: plan.conflicts,
        status: this.t("editor.patch.conflicts", { count: plan.conflicts.length }),
      });
      return false;
    }
    this.set({ patchConflicts: [] });
    if (plan.ops.length === 0) {
      this.set({ status: this.t("editor.patch.nothing") });
      return true;
    }
    // The patch carries its own borders: no automatic autoborder on top.
    if (!this.commit("editor.history.patch_import", plan.ops, false)) return false;
    this.set({
      review: true,
      reviewSide: "after",
      status: this.t("editor.patch.imported", { files: plan.files.length }),
    });
    return true;
  }

  undo(): void {
    this.strokeEnd();
    try {
      const step = this.history.undo(this.state.world);
      if (!step) return;
      this.changed(step.world, step.touched, step.touchedAux);
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
      this.changed(step.world, step.touched, step.touchedAux);
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

  private changed(world: World, touched: TouchedChunk[], touchedAux: TouchedAux[] = []): void {
    const files = [
      ...touched.map((t) => chunkFile(t.island, t.z, t.cx, t.cy)),
      ...touchedAux.map((a) => auxFile(a.island, a.file)),
    ];
    for (const file of files)
      if (!this.pending.has(file)) this.pending.set(file, this.base.get(file) ?? null);
    this.set({ world, dirty: true });
    this.scheduleValidation();
  }

  /** Files changed since the last save, with the base they are saved against. */
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

// ---- entity ops -------------------------------------------------------------------------

/** The add op for an entry of `file` (shared with the patch import, map-format). */
export const addOp: (file: EntityList, e: Entity, index: number | undefined) => MapOp = entryAddOp;

export const removeOp: (file: EntityList, key: string) => MapOp = entryRemoveOp;

// ---- entity checks for the forms --------------------------------------------------------

export interface EntityProblem {
  /** i18n key (editor.entity.err.*). */
  key: string;
  /** `what` is itself an i18n key (the field), translated by the caller. */
  params?: Record<string, string | number>;
}

const ENTITY_ID = /^[a-z][a-z0-9_]*$/;

/** Island whose rect holds (x, y) and lists floor z. */
function islandHolding(world: World, p: Position): string | undefined {
  for (const [id, isl] of world.islands)
    if (rectContains(isl.meta.rect, p.x, p.y))
      return isl.meta.floors.includes(p.z) ? id : undefined;
  return undefined;
}

const isInt = (n: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean =>
  typeof n === "number" && Number.isInteger(n) && n >= min && n <= max;

/**
 * The first problem a person can cause in an entity form (bad or repeated ID, missing
 * field, position outside the islands), or undefined. `oldKey` is the entry being edited.
 */
export function entityProblem(
  world: World,
  file: EntityList,
  e: Entity,
  oldKey: string | undefined,
): EntityProblem | undefined {
  const key = entityKey(e);
  if ("npc" in e) {
    if (!key) return { key: "editor.entity.err.required", params: { what: "editor.entity.npc" } };
  } else if (!ENTITY_ID.test(key) || key.length > 64)
    return { key: "editor.entity.err.id", params: { id: key } };
  if (key !== oldKey)
    for (const isl of world.islands.values())
      if ((isl[file] as Entity[]).some((x) => entityKey(x) === key))
        return { key: "editor.entity.err.duplicate", params: { id: key } };
  const inside = (p: Position, what: string): EntityProblem | undefined =>
    [p.x, p.y, p.z].every((n) => isInt(n, 0, 65535)) && islandHolding(world, p) !== undefined
      ? undefined
      : { key: "editor.entity.err.outside", params: { what } };
  if ("center" in e) {
    if (!isInt(e.radius, 0, 32)) return { key: "editor.entity.err.radius" };
    if (!isInt(e.respawn_seconds, 1)) return { key: "editor.entity.err.respawn" };
    if (e.monsters.length === 0 || e.monsters.some((m) => !m.monster || !isInt(m.count, 1)))
      return { key: "editor.entity.err.monsters" };
    return inside(e.center, "editor.entity.center");
  }
  if ("rects" in e) {
    const r0 = e.rects[0];
    if (!r0 || e.floors.length === 0) return { key: "editor.entity.err.zone" };
    if (new Set(e.floors).size !== e.floors.length)
      return { key: "editor.entity.err.zone_floors_repeat" };
    for (const r of e.rects) {
      if (!isInt(r.w, 1) || !isInt(r.h, 1)) return { key: "editor.entity.err.zone" };
      for (const z of e.floors) {
        const a = inside({ x: r.x, y: r.y, z }, "editor.entity.rects");
        const b = inside({ x: r.x + r.w - 1, y: r.y + r.h - 1, z }, "editor.entity.rects");
        if (a || b) return a ?? b;
        // Both corners in the island of the first rect: the zone belongs to one island.
        const home = islandHolding(world, { x: r0.x, y: r0.y, z });
        const corners = [
          { x: r.x, y: r.y, z },
          { x: r.x + r.w - 1, y: r.y + r.h - 1, z },
        ];
        if (corners.some((c) => islandHolding(world, c) !== home))
          return { key: "editor.entity.err.outside", params: { what: "editor.entity.rects" } };
      }
    }
    return undefined;
  }
  if ("from" in e) return inside(e.from, "editor.entity.from") ?? inside(e.to, "editor.entity.to");
  return inside(e.pos, "editor.entity.pos");
}
