// What travels between the editor's dev server (Node) and the browser. JSON-friendly
// versions of the map-format model (Maps become arrays), plus the content the UI needs.
import { chunkKey } from "@rpg/map-format/ops";
import type {
  Chunk,
  Island,
  IslandMeta,
  MapText,
  NpcPlacement,
  Portal,
  Spawn,
  World,
  WorldMeta,
  Zone,
} from "@rpg/map-format/ops";

export interface WireIsland {
  meta: IslandMeta;
  chunks: Chunk[];
  spawns: Spawn[];
  npcs: NpcPlacement[];
  zones: Zone[];
  portals: Portal[];
  texts: MapText[];
}

export interface WireWorld {
  meta: WorldMeta;
  islands: WireIsland[];
}

/** One entry of data/items, as the palette and the renderer need it. */
export interface PaletteItem {
  id: string;
  kind: string;
  /** Sprite path in the atlas (data/items `sprite`). */
  sprite: string;
  /** i18n key of the name. */
  name: string;
}

/** Same shape as map-format's Diagnostic (that module pulls in Node). */
export interface WireDiagnostic {
  severity: "error" | "warning";
  file: string;
  line?: number;
  path: (string | number)[];
  pos?: { x: number; y: number; z: number };
  message: string;
}

export interface Bootstrap {
  world: WireWorld;
  items: PaletteItem[];
  /** Language → key → text, for editor.* and item.* keys. */
  i18n: Record<string, Record<string, string>>;
  /** Problems found while loading world/ (files that did not parse are not editable). */
  loadErrors: WireDiagnostic[];
  /** Hash of each chunk file as loaded (see hashText); the base saves are checked against. */
  base: Record<string, string>;
}

/** One chunk file the editor changed, with the hash it had when loaded (null: no file). */
export interface FileChange {
  file: string;
  base: string | null;
}

export interface SaveRequest {
  world: WireWorld;
  changes: FileChange[];
}

export interface SaveResult {
  /** Files written or removed, relative to the repository root. */
  written: string[];
  removed: string[];
  /** New base hash of every file in the request (null: the file does not exist now). */
  base: Record<string, string | null>;
}

/** 409 body: files that changed on disk since the editor loaded them; nothing was saved. */
export interface SaveConflictBody {
  error: string;
  conflicts: string[];
}

/**
 * Header every API call sends. Other origins can only set it after a CORS preflight, and
 * the editor's dev server never approves one (CORS is off in vite.config.ts).
 */
export const API_HEADER = "x-rpg-editor";

/** Repository path of a chunk file (docs/03-world-and-maps.md, "Estructura en disco"). */
export function chunkFile(island: string, z: number, cx: number, cy: number): string {
  const p = (n: number, w: number): string => String(n).padStart(w, "0");
  return `world/islands/${island}/chunks/z${p(z, 2)}/c${p(cx, 4)}_${p(cy, 4)}.json`;
}

export interface ValidateResult {
  diagnostics: WireDiagnostic[];
  errors: number;
  warnings: number;
}

export function toWire(world: World): WireWorld {
  return {
    meta: world.meta,
    islands: [...world.islands.values()].map((i) => ({
      meta: i.meta,
      chunks: [...i.chunks.values()],
      spawns: i.spawns,
      npcs: i.npcs,
      zones: i.zones,
      portals: i.portals,
      texts: i.texts,
    })),
  };
}

export function fromWire(wire: WireWorld): World {
  const islands = new Map<string, Island>();
  for (const w of wire.islands) {
    const chunks = new Map<string, Chunk>();
    for (const c of w.chunks) chunks.set(chunkKey(c.z, c.cx, c.cy), c);
    islands.set(w.meta.id, {
      meta: w.meta,
      chunks,
      spawns: w.spawns,
      npcs: w.npcs,
      zones: w.zones,
      portals: w.portals,
      texts: w.texts,
    });
  }
  return { meta: wire.meta, islands };
}
