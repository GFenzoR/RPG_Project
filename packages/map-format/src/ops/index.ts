// @rpg/map-format/ops: browser-safe entry point (no Node imports) with the edit operations
// and the plain model types. The editor imports this; Node tools can use either entry.
export * from "../types.ts";
export { applyOps } from "./apply.ts";
export type { ApplyResult, TouchedAux, TouchedChunk } from "./apply.ts";
export type { EntityList } from "./draft.ts";
export {
  BORDER_CORNERS,
  BORDER_SIDES,
  borderItems,
  borderPieces,
  orderedRules,
} from "./borders.ts";
export type { BorderCorner, BorderPieceName, BorderRule, BorderSide } from "./borders.ts";
export { prefabSize } from "./prefab.ts";
export type { Prefab, PrefabLegendEntry } from "./prefab.ts";
export { seededRandom } from "./rng.ts";
export { MAP_OP_NAMES, OpError } from "./types.ts";
export type {
  AddPortalOp,
  AddSpawnOp,
  AddZoneOp,
  AutoborderOp,
  Cell,
  EraseLayer,
  EraseOp,
  FillOp,
  MapOp,
  MapOpName,
  OpOptions,
  PaintGroundOp,
  PlaceItemOp,
  PlaceNpcOp,
  RemoveItemOp,
  RemoveNpcOp,
  RemovePortalOp,
  RemoveSpawnOp,
  RemoveZoneOp,
  ScatterOp,
  StampOp,
} from "./types.ts";
