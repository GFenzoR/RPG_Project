// @rpg/map-format/ops: browser-safe entry point (no Node imports) with the edit operations
// and the plain model types. The editor imports this; Node tools can use either entry.
export * from "../types.ts";
export { applyOps } from "./apply.ts";
export type { ApplyResult, TouchedAux, TouchedChunk } from "./apply.ts";
export type { AuxList, EntityList } from "./draft.ts";
export {
  HOUSE_ISSUE_CODES,
  MAX_HOUSE_RENT,
  disconnectedFloors,
  houseIssues,
  houseNameKey,
  houseTiles,
  isHouseId,
  onHouseEdge,
  sortTiles,
  tilesToRects,
} from "../houses.ts";
export type { HouseInput, HouseIssue, HouseIssueCode, HouseIssueOptions } from "../houses.ts";
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
  AddHouseOp,
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
  RemoveHouseOp,
  RemoveItemOp,
  RemoveNpcOp,
  RemovePortalOp,
  RemoveSpawnOp,
  RemoveZoneOp,
  ScatterOp,
  SetHouseOp,
  StampOp,
} from "./types.ts";
// Patch merge and diff on the model (browser-safe; the text side is in the "." entry).
export * from "../patch/merge.ts";
