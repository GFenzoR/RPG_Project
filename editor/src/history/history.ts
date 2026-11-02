// Undo/redo over map-format ops. Every edit is recorded as the ops it applied and their
// inverse (returned by applyOps), so undo and redo are just applyOps again: the editor
// never snapshots the world.
import { applyOps } from "@rpg/map-format/ops";
import type { MapOp, OpOptions, World } from "@rpg/map-format/ops";

export interface HistoryEntry {
  /** What the user did, for the UI (an i18n key). */
  label: string;
  /** Ops that were applied, in order. */
  forward: MapOp[];
  /** Ops that undo them, in order. */
  inverse: MapOp[];
}

export interface Step {
  world: World;
  touched: string[];
  entry: HistoryEntry;
}

export const MAX_HISTORY = 500;

export class History {
  private readonly done: HistoryEntry[] = [];
  private readonly undone: HistoryEntry[] = [];
  private readonly opts: OpOptions;

  constructor(opts: OpOptions = {}) {
    this.opts = opts;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Number of entries that can be undone. */
  get size(): number {
    return this.done.length;
  }

  /** Records an edit that was already applied. Clears the redo stack. Empty edits are ignored. */
  record(entry: HistoryEntry): void {
    if (entry.forward.length === 0 && entry.inverse.length === 0) return;
    this.done.push(entry);
    if (this.done.length > MAX_HISTORY) this.done.shift();
    this.undone.length = 0;
  }

  /** Applies ops to `world` and records them. */
  apply(world: World, label: string, ops: MapOp[]): Step {
    const r = applyOps(world, ops, this.opts);
    const entry = { label, forward: ops, inverse: r.inverse };
    if (r.inverse.length > 0) this.record(entry);
    return { world: r.world, touched: r.touched, entry };
  }

  undo(world: World): Step | undefined {
    const entry = this.done.pop();
    if (!entry) return undefined;
    const r = applyOps(world, entry.inverse, this.opts);
    this.undone.push(entry);
    return { world: r.world, touched: r.touched, entry };
  }

  redo(world: World): Step | undefined {
    const entry = this.undone.pop();
    if (!entry) return undefined;
    const r = applyOps(world, entry.forward, this.opts);
    this.done.push(entry);
    return { world: r.world, touched: r.touched, entry };
  }
}

/**
 * Collects the ops of one gesture (a brush stroke is many applyOps calls, one per tile)
 * into a single history entry.
 */
export class Stroke {
  readonly label: string;
  private readonly forward: MapOp[] = [];
  private readonly inverses: MapOp[][] = [];

  constructor(label: string) {
    this.label = label;
  }

  add(ops: MapOp[], inverse: MapOp[]): void {
    if (inverse.length === 0) return; // nothing changed
    this.forward.push(...ops);
    this.inverses.push(inverse);
  }

  get empty(): boolean {
    return this.forward.length === 0;
  }

  entry(): HistoryEntry {
    return {
      label: this.label,
      forward: [...this.forward],
      inverse: [...this.inverses].reverse().flat(),
    };
  }
}
