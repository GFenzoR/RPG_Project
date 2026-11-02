// Sprite atlas packer and placeholder generator (tools/CLAUDE.md, assets/README.md).
export { buildAtlas, writeAtlas, DEFAULT_OUT_DIR, MANIFEST_FILE, SPRITES_DIR } from "./build.ts";
export type {
  AtlasIndex,
  AtlasPageJson,
  BuildOptions,
  BuildResult,
  Diagnostic,
  Origin,
} from "./build.ts";
export { collectSpriteRefs } from "./content.ts";
export type { SpriteRef } from "./content.ts";
export { registeredPacks } from "./credits.ts";
export { parseManifest } from "./manifest.ts";
export type { Manifest, SpriteEntry } from "./manifest.ts";
export { packSprites } from "./pack.ts";
export { defaultColor, defaultLabel, renderPlaceholder, TILE } from "./placeholder.ts";
