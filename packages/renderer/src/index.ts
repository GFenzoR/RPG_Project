// @rpg/renderer: PixiJS v8 tile renderer shared by the game client (T1.5) and the map
// editor (T1.14). Generic on purpose: it draws tiles from a TileSource with textures from
// the spritepack atlas; input, entities and editing live in the apps.
export * from "./anim.ts";
export * from "./camera.ts";
export * from "./look.ts";
export { Atlas, MISSING_TEXTURE } from "./atlas.ts";
export type { AtlasIcon, AtlasIndex, AtlasLoadOptions } from "./atlas.ts";
export {
  CAST_SHADOW_ALPHA,
  CAST_SHADOW_TINT,
  MAX_STACK_ORDER,
  MapView,
  REVEAL_ALPHA,
  REVEAL_FADE_MS,
  entityZIndex,
  itemZIndex,
  overlaps,
} from "./map-view.ts";
export type {
  ChunkData,
  ElevationLookup,
  MapViewOptions,
  TextureLookup,
  TileSource,
  WorldRect,
} from "./map-view.ts";
export * from "./retry.ts";
export * from "./tile-art.ts";
export { DecoratedSource, HOUSE_DOOR_FRAME, extrasByChunk, withExtras } from "./decorated.ts";
export type { ExtraItem } from "./decorated.ts";
