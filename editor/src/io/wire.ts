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
}

export interface SaveResult {
  /** Files written or removed, relative to the repository root. */
  written: string[];
  removed: string[];
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
