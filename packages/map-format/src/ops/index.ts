// @rpg/map-format/ops: browser-safe entry point (no Node imports) with the edit operations
// and the plain model types. The editor imports this; Node tools can use either entry.
export * from "../types.ts";
export { applyOps } from "./apply.ts";
export type { ApplyResult } from "./apply.ts";
export { MAP_OP_NAMES, OpError } from "./types.ts";
export type {
  Cell,
  EraseLayer,
  EraseOp,
  MapOp,
  MapOpName,
  OpOptions,
  PaintGroundOp,
  PlaceItemOp,
  RemoveItemOp,
} from "./types.ts";
