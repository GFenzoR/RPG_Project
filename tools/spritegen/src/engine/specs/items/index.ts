// The item icons of the engine (docs/17 "Íconos de items"), and the rows of their review
// board (spritegen sheet: one row per line of the catalog, one column per level band).
import type { SpriteSpec } from "../../spec.ts";
import type { IconRow } from "../../sheet.ts";
import {
  ARMOR_ICONS,
  FEET,
  HEAVY_TORSO,
  HELMS,
  LEGS,
  RETIRED_BODY,
  RETIRED_SHIELDS,
  ROBES,
  SHIELDS,
} from "./armor.ts";
import { AMMO, AMULETS, JEWELRY_ICONS, RINGS } from "./jewelry.ts";
import {
  AXES,
  BOWS,
  CROSSBOWS,
  MACES,
  RETIRED_MACES,
  RETIRED_SWORDS,
  STAFFS,
  SWORDS,
  WANDS,
  WEAPON_ICONS,
} from "./weapons.ts";

export const ITEM_ICONS: readonly SpriteSpec[] = [
  ...WEAPON_ICONS,
  ...ARMOR_ICONS,
  ...JEWELRY_ICONS,
  ...AMMO,
];

const none = undefined;

/** The review board: a row per line, a column per band (an empty cell where a line has none). */
export const ICON_ROWS: readonly IconRow[] = [
  { label: "swords", specs: SWORDS },
  { label: "axes", specs: AXES },
  { label: "maces", specs: MACES },
  { label: "bows", specs: BOWS },
  { label: "crossbows", specs: [none, none, ...CROSSBOWS] },
  { label: "wands", specs: WANDS },
  { label: "staffs", specs: STAFFS },
  { label: "shields", specs: SHIELDS },
  { label: "heavy torso", specs: [none, none, ...HEAVY_TORSO] },
  { label: "robes", specs: [ROBES[0], none, ...ROBES.slice(1)] },
  { label: "head", specs: [HELMS[0], none, ...HELMS.slice(1)] },
  { label: "legs", specs: [LEGS[0], none, ...LEGS.slice(1)] },
  { label: "feet", specs: [FEET[0], none, ...FEET.slice(1)] },
  { label: "amulets", specs: [none, none, ...AMULETS] },
  { label: "rings", specs: [none, none, ...RINGS] },
  { label: "ammunition", specs: AMMO },
  {
    label: "retired",
    specs: [...RETIRED_SWORDS, ...RETIRED_MACES, ...RETIRED_SHIELDS, ...RETIRED_BODY],
  },
];
