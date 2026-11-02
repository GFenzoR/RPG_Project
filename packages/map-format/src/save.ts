// Writes back only what an op list changed (ApplyResult.touched / touchedAux), in canonical
// form. Every new file is written to a temporary name first and renamed once all of them
// are on disk, so a failure halfway leaves world/ as it was (as far as the OS allows).
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chunkFileName, floorDir, formatChunk } from "./chunk.ts";
import { islandDir } from "./io.ts";
import type { TouchedAux, TouchedChunk } from "./ops/draft.ts";
import { chunkKey } from "./types.ts";
import type { World } from "./types.ts";
import { formatYaml } from "./yaml.ts";

export interface SaveResult {
  /** Files written (relative to root). */
  written: string[];
  /** Files removed: chunks left empty, auxiliary lists left empty. */
  removed: string[];
}

/** Path and canonical text (undefined = remove) of every file the edit changed. */
export function changedFiles(
  world: World,
  edit: { touched: readonly TouchedChunk[]; touchedAux: readonly TouchedAux[] },
): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const t of edit.touched) {
    const isl = world.islands.get(t.island);
    if (!isl) continue;
    const file = `${islandDir(t.island)}/chunks/${floorDir(t.z)}/${chunkFileName(t.cx, t.cy)}`;
    const c = isl.chunks.get(chunkKey(t.z, t.cx, t.cy));
    out.set(file, c ? formatChunk(c) : undefined);
  }
  for (const a of edit.touchedAux) {
    const isl = world.islands.get(a.island);
    if (!isl) continue;
    const list = isl[a.file];
    out.set(
      `${islandDir(a.island)}/${a.file}.yaml`,
      list.length > 0 ? formatYaml(list) : undefined,
    );
  }
  return out;
}

export function saveApplied(
  root: string,
  world: World,
  edit: { touched: readonly TouchedChunk[]; touchedAux: readonly TouchedAux[] },
): SaveResult {
  const files = changedFiles(world, edit);
  const written: string[] = [];
  const removed: string[] = [];
  const staged: [string, string][] = [];
  try {
    for (const [file, text] of files) {
      if (text === undefined) continue;
      const abs = join(root, file);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}`;
      writeFileSync(tmp, text);
      staged.push([tmp, abs]);
      written.push(file);
    }
  } catch (err) {
    for (const [tmp] of staged) rmSync(tmp, { force: true });
    throw err;
  }
  for (const [tmp, abs] of staged) renameSync(tmp, abs);
  for (const [file, text] of files) {
    if (text !== undefined) continue;
    rmSync(join(root, file), { force: true });
    removed.push(file);
  }
  return { written: written.sort(), removed: removed.sort() };
}
