// @rpg/map-format: read/write world/ in canonical form, validate it, and view it
// (docs/03-world-and-maps.md, docs/04-map-editor-and-ai.md).
export * from "./types.ts";
export {
  CHUNK_FORMAT,
  chunkFileName,
  floorDir,
  formatChunk,
  groundAt,
  normalizeChunk,
  parseChunk,
  parseChunkPath,
  pushItem,
  setGround,
  stackAt,
} from "./chunk.ts";
export { loadContent } from "./content.ts";
export type { ContentIndex, ItemInfo } from "./content.ts";
export { Reporter, formatDiagnostic, formatPath } from "./diagnostics.ts";
export type { Diagnostic, PathSegment } from "./diagnostics.ts";
export { islandInfo, worldInfo } from "./info.ts";
export type { IslandInfo, WorldInfo } from "./info.ts";
export { AUX_FILES, islandDir, loadWorld, worldFile, writeIsland, writeWorldMeta } from "./io.ts";
export type { AuxFile, FileState, LoadResult } from "./io.ts";
export { PREFAB_DIR, checkPrefab, formatPrefab } from "./prefabs.ts";
export type { PrefabProblem } from "./prefabs.ts";
export { SCHEMA_DIR, checkSchema } from "./schemas.ts";
export type { MapSchemaName, SchemaError } from "./schemas.ts";
export { TileMap, isWalkable } from "./tiles.ts";
export type { Tile } from "./tiles.ts";
export { MAX_SPAWN_DENSITY, summarize, validateLoaded, validateWorld } from "./validate.ts";
export type { MapReport, ValidateLoadedOptions, ValidateWorldOptions } from "./validate.ts";
export { MAX_VIEW_SIZE, renderAsciiView, viewArea } from "./view.ts";
export type { AsciiView } from "./view.ts";
export { formatYaml, parseYamlText } from "./yaml.ts";
export type { ParsedYaml } from "./yaml.ts";
export { changedFiles, saveApplied } from "./save.ts";
export type { SaveResult } from "./save.ts";
export type {
  ApplyResult,
  BorderRule,
  MapOp,
  OpOptions,
  Prefab,
  PrefabLegendEntry,
  TouchedAux,
  TouchedChunk,
} from "./ops/index.ts";
export { applyOps, MAP_OP_NAMES, OpError, prefabSize } from "./ops/index.ts";
export { generate, RECIPES } from "./generate.ts";
export type { GenerateOptions, Recipe } from "./generate.ts";
