// Applying op lists to world/ on disk: shared by the mapcli edit commands and mcp-world.
// Loads the world, applies the ops atomically with the content rules (item kinds, known
// monsters and NPCs, border rules, prefabs), writes back only the touched files and
// validates the result.
import {
  OpError,
  applyOps,
  formatDiagnostic,
  loadContent,
  loadWorld,
  saveApplied,
  validateWorld,
} from "@rpg/map-format";
import type {
  ContentIndex,
  LoadResult,
  MapOp,
  MapReport,
  OpOptions,
  Prefab,
  World,
} from "@rpg/map-format";

export interface EditContext {
  root: string;
  loaded: LoadResult;
  content: ContentIndex;
  opts: OpOptions;
}

export function opOptions(content: ContentIndex, prefabs: Map<string, Prefab>): OpOptions {
  return {
    itemKind: (id) => content.items.get(id)?.kind,
    monsterKnown: (id) => content.monsters.has(id),
    npcKnown: (id) => content.npcs.has(id),
    borders: content.borders,
    prefab: (id) => prefabs.get(id),
  };
}

export function editContext(root: string): EditContext {
  const loaded = loadWorld(root);
  const content = loadContent(root);
  return { root, loaded, content, opts: opOptions(content, loaded.prefabs) };
}

export interface EditOutcome {
  ok: boolean;
  /** Why nothing was applied (bad op, load errors, wrong island). */
  error?: string;
  /** Index of the op that failed, when one did. */
  op_index?: number;
  ops: number;
  dry_run: boolean;
  /** Islands whose files changed. */
  islands: string[];
  written: string[];
  removed: string[];
  /** Ops that undo the edit (apply them with `ops apply` to revert). */
  inverse_ops: number;
  validation?: { errors: number; warnings: number; diagnostics: string[] };
}

/** Diagnostics shown in an outcome; the full list is one `mapcli validate` away. */
export const MAX_REPORTED = 50;

function summary(report: MapReport): NonNullable<EditOutcome["validation"]> {
  return {
    errors: report.errors,
    warnings: report.warnings,
    diagnostics: report.diagnostics.slice(0, MAX_REPORTED).map(formatDiagnostic),
  };
}

export interface ApplyEditOptions {
  /** Only these islands may change; an op that touches another one fails the edit. */
  islands?: string[];
  dryRun?: boolean;
  /** Called with the edited world before it is saved (to keep the inverse, render...). */
  onApplied?: (world: World, inverse: MapOp[]) => void;
}

/**
 * Applies `ops` to world/ under ctx.root. Nothing is written when the world has load
 * errors (a file that failed to parse could be overwritten), when an op is invalid, or
 * when an op touches an island outside `islands`.
 */
export function applyEdit(ctx: EditContext, ops: MapOp[], o: ApplyEditOptions = {}): EditOutcome {
  const base: EditOutcome = {
    ok: false,
    ops: ops.length,
    dry_run: o.dryRun === true,
    islands: [],
    written: [],
    removed: [],
    inverse_ops: 0,
  };
  const loadErrors = ctx.loaded.diagnostics.filter((d) => d.severity === "error");
  if (loadErrors.length > 0)
    return {
      ...base,
      error: `world/ has load errors; fix them first (mapcli validate): ${loadErrors
        .slice(0, 5)
        .map(formatDiagnostic)
        .join("; ")}`,
    };
  let result;
  try {
    result = applyOps(ctx.loaded.world, ops, ctx.opts);
  } catch (e) {
    if (e instanceof OpError) return { ...base, error: e.message, op_index: e.index };
    throw e;
  }
  const islands = [
    ...new Set([...result.touched, ...result.touchedAux].map((t) => t.island)),
  ].sort();
  const outside = o.islands ? islands.filter((i) => !o.islands?.includes(i)) : [];
  if (outside.length > 0)
    return {
      ...base,
      islands,
      error: `the ops touch island(s) ${outside.join(", ")}, not ${o.islands?.join(", ")}`,
    };
  o.onApplied?.(result.world, result.inverse);
  let written: string[] = [];
  let removed: string[] = [];
  if (!o.dryRun) ({ written, removed } = saveApplied(ctx.root, result.world, result));
  const out: EditOutcome = {
    ...base,
    ok: true,
    islands,
    written,
    removed,
    inverse_ops: result.inverse.length,
  };
  if (!o.dryRun) {
    // Validate from disk, so findings carry file:line, scoped to the islands that changed.
    const all = islands.map((island) => validateWorld(ctx.root, { island, content: ctx.content }));
    const diagnostics = all.flatMap((r) => r.diagnostics);
    out.validation = summary({
      diagnostics,
      errors: all.reduce((n, r) => n + r.errors, 0),
      warnings: all.reduce((n, r) => n + r.warnings, 0),
    });
  }
  return out;
}

/** Parses an op list file: a JSON array of ops, or { "ops": [...] }. */
export function parseOps(text: string): MapOp[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new RangeError(`ops file is not JSON: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  const list = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null && Array.isArray((data as { ops?: unknown }).ops)
      ? (data as { ops: unknown[] }).ops
      : undefined;
  if (!list) throw new RangeError('ops file must be a JSON array of ops or { "ops": [...] }');
  for (const [i, op] of list.entries())
    if (typeof op !== "object" || op === null || typeof (op as { op?: unknown }).op !== "string")
      throw new RangeError(`op ${i} must be an object with an "op" field`);
  return list as MapOp[];
}
