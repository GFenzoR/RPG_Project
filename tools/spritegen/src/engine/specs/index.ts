// Every engine spec. Add a new one here (and its frames show up as spritegen recipes).
import type { SpriteSpec } from "../spec.ts";
import { ANVIL } from "./anvil.ts";
import { BOAR } from "./boar.ts";
import { CRATE } from "./crate.ts";
import { FORGE_ECHO } from "./forge-echo.ts";
import { FORGE_MATERIALS } from "./forge-materials.ts";
import { HUMANOID_SPECS } from "./humanoid/index.ts";
import { ITEM_ICONS } from "./items/index.ts";
import {
  BOOK_CLOSED,
  LECTERN_BOOK,
  REWARD_CHEST,
  SCROLL,
  SIGIL_PLATES,
  STASH_CHEST,
} from "./lore.ts";
import { MARKET_BOARD } from "./market-board.ts";
import { REMAINS } from "./remains.ts";
import { SIGNPOST } from "./signpost.ts";
import { STAG } from "./stag.ts";
import { TOWN_PROPS } from "./town.ts";

export const ENGINE_SPECS: readonly SpriteSpec[] = [
  BOAR,
  STAG,
  FORGE_ECHO,
  ANVIL,
  MARKET_BOARD,
  SIGNPOST,
  CRATE,
  ...REMAINS,
  ...ITEM_ICONS,
  ...FORGE_MATERIALS,
  BOOK_CLOSED,
  LECTERN_BOOK,
  SCROLL,
  REWARD_CHEST,
  STASH_CHEST,
  ...SIGIL_PLATES,
  ...TOWN_PROPS,
  ...HUMANOID_SPECS,
];
