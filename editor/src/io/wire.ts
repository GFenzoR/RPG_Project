// What travels between the editor's dev server (Node) and the browser. JSON-friendly
// versions of the map-format model (Maps become arrays), plus the content the UI needs.
import { chunkKey } from "@rpg/map-format/ops";
import type {
  AuxList,
  BorderSet,
  Chunk,
  EntityList,
  House,
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
  /** T5.4: player houses, edited in the house panel (house ops). */
  houses: House[];
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
  /**
   * A door (data/items `door`, docs/02 "Puertas con llave"): shut or open. Its lock is part
   * of the item type, not of the tile, so the editor shows it but does not edit it.
   */
  door?: "closed" | "open";
  /** A closed door: the key id that opens it (the `key` of its data/items door block). */
  lock?: string;
  /** A key: the key id of the doors it opens (data/items `key`). */
  key?: string;
  /** docs/17 ART-8: sprite pixels it raises what is stacked on it (data/items `elevation`). */
  elevation?: number;
  /** A ground's surface for the living world (data/items `ground.surface`, livingworld/README.md). */
  surface?: string;
  /** A plant of data/livingworld/plants.yaml: how it reacts to a step. */
  plant?: "bend" | "rustle";
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
  /**
   * Hash of each chunk file and auxiliary list (spawns/npcs/zones/portals/houses.yaml) as loaded
   * (see hashText); the base saves are checked against.
   */
  base: Record<string, string>;
  /** The ladder of data/borders.yaml, for the automatic autoborder. */
  borders: BorderSet;
  /** Monster and NPC IDs of data/monsters and data/npcs, for the entity panels. */
  monsters: string[];
  npcs: string[];
}

/** One chunk or auxiliary file the editor changed, with the hash it had when loaded (null: no file). */
export interface FileChange {
  file: string;
  base: string | null;
}

export interface SaveRequest {
  world: WireWorld;
  changes: FileChange[];
  /** House names to write in i18n/<lang>/world.yaml (T5.4). */
  texts?: NameText[];
}

/**
 * A house name the editor changed (docs/03 "Casas": house.<id>.name in
 * i18n/<lang>/world.yaml). `base` is the text it had when the editor loaded it (null: no
 * text); if the file says something else now, the save is a conflict.
 */
export interface NameText {
  lang: string;
  key: string;
  text: string;
  base: string | null;
}

/** POST /api/validate: the world, plus the i18n keys of names not saved yet. */
export type ValidateRequest = WireWorld & { pendingKeys?: { lang: string; key: string }[] };

/** Longest house name, in characters. */
export const MAX_NAME_LENGTH = 80;

/**
 * Whether `text` can be a house name: 1..MAX_NAME_LENGTH characters on one line, no
 * surrounding spaces, no control characters and no braces (i18n placeholders).
 */
export function isHouseName(text: unknown): text is string {
  return (
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= MAX_NAME_LENGTH &&
    text.trim() === text &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f\u2028\u2029{}]/.test(text)
  );
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

/** Auxiliary lists the editor's entity panels edit (texts.yaml is not edited yet). */
export const EDITABLE_AUX: readonly EntityList[] = ["spawns", "npcs", "zones", "portals"];

/** Auxiliary files the editor saves: the entity lists and houses.yaml (house panel). */
export const SAVED_AUX: readonly AuxList[] = [...EDITABLE_AUX, "houses"];

/** Repository path of an island's auxiliary list. */
export function auxFile(island: string, file: AuxList): string {
  return `world/islands/${island}/${file}.yaml`;
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
      houses: i.houses,
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
      houses: w.houses ?? [],
    });
  }
  return { meta: wire.meta, islands };
}

// ---- map patches (T2.3) ----------------------------------------------------------------

/** POST /api/patch/export: the files that differ, with both worlds to format them from. */
export interface PatchExportRequest {
  /** World as loaded from disk (the patch's base). */
  before: WireWorld;
  /** World as it is now in the editor. */
  after: WireWorld;
  /** Chunk and auxiliary files that differ (chunkFile / auxFile paths). */
  files: string[];
}

/** One file of a patch the editor can apply, parsed and checked by the dev server. */
export interface ParsedPatchFile {
  path: string;
  island: string;
  target: { kind: "chunk"; z: number; cx: number; cy: number } | { kind: "list"; list: EntityList };
  /** Whether `base` is known (format 1 patches whose base is not on disk: false). */
  baseKnown: boolean;
  /** Base version (null: no file); a Chunk or the list's entries. */
  base: Chunk | unknown[] | null;
  /** Version in the patch (null: the patch removes the file). */
  content: Chunk | unknown[] | null;
}

/** POST /api/patch/parse { text } → the patch, checked, ready to merge in the browser. */
export interface ParsedPatch {
  base_ref: string;
  files: ParsedPatchFile[];
}

/** Largest .rpgpatch.json the editor reads (same limit as map-format's MAX_PATCH_SIZE). */
export const MAX_PATCH_SIZE = 32 << 20;
