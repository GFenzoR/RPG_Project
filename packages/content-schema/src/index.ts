// Content schemas and validator for data/ and i18n/ (docs/06-content-data.md).
export { LANGUAGES, validateContent } from "./validate.ts";
export type { ValidateOptions, ValidationReport } from "./validate.ts";
export {
  CREATURE_NAME_MAX_CHARS,
  KNOWN_NAME_MAX_CHARS,
  NPC_ROLE_KINDS,
  NPC_ROLE_MAX_CHARS,
  npcRoleDefaultKey,
  npcRoleKey,
  npcRoleKind,
} from "./npc-role.ts";
export type { NpcRoleKind } from "./npc-role.ts";
export { checkIdsLock, generateIdsLock, renderIdsLock } from "./ids.ts";
export type { ChestsLock, IdsLock } from "./ids.ts";
export { SCHEMA_DIR, SchemaSet } from "./schemas.ts";
export type { RefKind, SchemaName } from "./schemas.ts";
export { formatDiagnostic } from "./source.ts";
export type { Diagnostic, PathSegment } from "./source.ts";
