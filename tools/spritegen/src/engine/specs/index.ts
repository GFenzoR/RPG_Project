// Every engine spec. Add a new one here (and its frames show up as spritegen recipes).
import type { SpriteSpec } from "../spec.ts";
import { BOAR } from "./boar.ts";
import { STAG } from "./stag.ts";

export const ENGINE_SPECS: readonly SpriteSpec[] = [BOAR, STAG];
