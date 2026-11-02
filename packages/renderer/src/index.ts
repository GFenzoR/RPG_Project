// @rpg/renderer: PixiJS v8 tile renderer shared by the game client (T1.5) and the map
// editor (T1.14). Generic on purpose: it draws tiles from a TileSource with textures from
// the spritepack atlas; input, entities and editing live in the apps.
export * from "./camera.ts";
export { Atlas, MISSING_TEXTURE } from "./atlas.ts";
export type { AtlasIndex } from "./atlas.ts";
export { MAX_STACK_ORDER, MapView, itemZIndex } from "./map-view.ts";
export type { ChunkData, MapViewOptions, TextureLookup, TileSource } from "./map-view.ts";
