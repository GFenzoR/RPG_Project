// The sprite engine (docs/17 "Motor de sprites", tools/CLAUDE.md "spritegen: el motor"):
// style rules as data, declarative specs of parts with depth, a creature rig with keyframed
// actions, quality gates and contact sheets. Engine specs become spritegen recipes.
export { ACTION_ORDER, engineFrames, engineRecipes, framePaths, frameImage } from "./book.ts";
export { engineProblems, hintProblems } from "./check.ts";
export { gateProblems, GATES } from "./gates.ts";
export { allowedColors, canvasOf, renderSpec } from "./render.ts";
export type { FrameRef } from "./render.ts";
export { contactSheet, lineup } from "./sheet.ts";
export { specMaterials, validateSpec } from "./spec.ts";
export type {
  ActionSpec,
  JointPose,
  KeySpec,
  MarkSpec,
  PartSpec,
  ShapeSpec,
  SpriteSpec,
  TextureSpec,
} from "./spec.ts";
export { ENGINE_SPECS } from "./specs/index.ts";
export * as STYLE from "./style.ts";
