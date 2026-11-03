// Importing a map patch in the editor: the dev server checks and parses the file
// (/api/patch/parse); here it is merged into the in-memory world with the same three-way
// merge mapcli uses (map-format: tile by tile, entry by entry) and turned into ops, so the
// import is one history entry that undo reverts in a single step.
import {
  SyncError,
  chunkKey,
  chunkSyncOps,
  listSyncOps,
  mergeChunk,
  mergeList,
  stableJson,
} from "@rpg/map-format/ops";
import type { Chunk, ListEntry, MapOp, MergeConflict, World } from "@rpg/map-format/ops";
import type { ParsedPatch } from "../io/wire.ts";

/** A conflict of an import, with the file it is in. */
export type ImportConflict = MergeConflict & { path: string };

export interface ImportPlan {
  /** Ops that apply the merged patch (removals of entries first, then the rest). */
  ops: MapOp[];
  conflicts: ImportConflict[];
  /** Files the import changes. */
  files: string[];
}

/** Merges `patch` into `world`; nothing is applied (conflicts → apply nothing). */
export function planImport(world: World, patch: ParsedPatch): ImportPlan {
  const removes: MapOp[] = [];
  const rest: MapOp[] = [];
  const conflicts: ImportConflict[] = [];
  const files: string[] = [];
  const fileConflict = (path: string, reason: string): void => {
    conflicts.push({ path, kind: "file", reason });
  };
  for (const f of patch.files) {
    const island = world.islands.get(f.island);
    if (!island) {
      fileConflict(f.path, `island "${f.island}" is not loaded`);
      continue;
    }
    if (f.target.kind === "chunk") {
      const t = f.target;
      const ours = island.chunks.get(chunkKey(t.z, t.cx, t.cy));
      const theirs = (f.content ?? undefined) as Chunk | undefined;
      if (stableJson(ours ?? null) === stableJson(theirs ?? null)) continue;
      if (!f.baseKnown) {
        fileConflict(f.path, "the base is not available to merge");
        continue;
      }
      const m = mergeChunk((f.base ?? undefined) as Chunk | undefined, ours, theirs, t);
      for (const c of m.conflicts) conflicts.push({ ...c, path: f.path });
      try {
        const ops = chunkSyncOps(island, ours, m.result, t);
        if (ops.length > 0) files.push(f.path);
        rest.push(...ops);
      } catch (e) {
        if (!(e instanceof SyncError)) throw e;
        fileConflict(f.path, e.message);
      }
      continue;
    }
    const list = f.target.list;
    const ours = island[list] as ListEntry[];
    const theirs = (f.content ?? []) as ListEntry[];
    if (stableJson(ours) === stableJson(theirs)) continue;
    if (!f.baseKnown) {
      fileConflict(f.path, "the base is not available to merge");
      continue;
    }
    const m = mergeList((f.base ?? []) as ListEntry[], ours, theirs);
    for (const c of m.conflicts) conflicts.push({ ...c, path: f.path });
    let ops: MapOp[];
    try {
      ops = listSyncOps(island, list, ours, m.result);
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      fileConflict(f.path, e.message);
      continue;
    }
    if (ops.length > 0) files.push(f.path);
    for (const op of ops) (op.op.startsWith("remove_") ? removes : rest).push(op);
  }
  return { ops: [...removes, ...rest], conflicts, files };
}
