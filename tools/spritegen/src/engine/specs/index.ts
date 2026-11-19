// Every engine spec. Add a new one here (and its frames show up as spritegen recipes).
import type { SpriteSpec } from "../spec.ts";
import { ANVIL } from "./anvil.ts";
import { BOAR } from "./boar.ts";
import { CRATE } from "./crate.ts";
import { FORGE_ECHO } from "./forge-echo.ts";
import { MARKET_BOARD } from "./market-board.ts";
import { REMAINS } from "./remains.ts";
import { SIGNPOST } from "./signpost.ts";
import { STAG } from "./stag.ts";

export const ENGINE_SPECS: readonly SpriteSpec[] = [
  BOAR,
  STAG,
  FORGE_ECHO,
  ANVIL,
  MARKET_BOARD,
  SIGNPOST,
  CRATE,
  ...REMAINS,
];
