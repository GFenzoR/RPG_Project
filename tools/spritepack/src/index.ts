// Sprite atlas packer and placeholder generator (tools/CLAUDE.md, assets/README.md).
export {
  buildAtlas,
  legacyFrame,
  writeAtlas,
  DEFAULT_OUT_DIR,
  MANIFEST_FILE,
  SPRITES_DIR,
} from "./build.ts";
export { ANIM_ACTIONS, ANIM_DIRS, PRESETS, frameName } from "./anims.ts";
export type { AnimAction, AnimDir, AnimEntry, AnimMeta } from "./anims.ts";
export type {
  AtlasIndex,
  AtlasPageJson,
  BuildOptions,
  BuildResult,
  Diagnostic,
  Origin,
} from "./build.ts";
export { TILE_PART, WALL_PIECES, WIND_HINT_KINDS, parseTileEntry, tileMetas } from "./tiles.ts";
export type { TileEntry, TileMeta, TileSync, WindHint } from "./tiles.ts";
export { collectSpriteRefs, lookSprites, LOOKS_FILE, outfitFrames, parseYaml } from "./content.ts";
export type { SpriteRef } from "./content.ts";
export {
  markdownSection,
  markdownTableRows,
  parseCreditsRows,
  plainCell,
  registeredPacks,
  usedLicense,
} from "./credits.ts";
export type { FileCreditRow } from "./credits.ts";
export { parseManifest } from "./manifest.ts";
export type { Manifest, SpriteEntry } from "./manifest.ts";
export { packSprites } from "./pack.ts";
export { defaultColor, defaultLabel, renderPlaceholder, TILE } from "./placeholder.ts";
export {
  blit,
  createImage,
  decodePng,
  encodePng,
  fillRect,
  parseHexColor,
  scaleImage,
} from "./image.ts";
export type { Image, Rgba } from "./image.ts";
export { drawText, GLYPH_H, GLYPH_W, textWidth } from "./font.ts";
