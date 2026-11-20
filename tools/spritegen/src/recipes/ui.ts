// Client interface icons (kind "ui"): drawn inside their group's box at the centre of a
// 32x32 sprite (uiIconBox: UI_ICON_BOX for the marks, UI_SLOT_BOX for the slots), which is
// all the client shows of them. The client finds them by path, not by a data/ field:
// ui/marks/<id> are the PvP marks of client/src/render/marks.ts, ui/slots/<slot> the empty
// equipment slots of client/src/ui/Inventory.tsx, ui/status/<id> the icons of the status
// tray (client/src/ui/StatusTray.tsx: one per condition of balance.yaml and per status the
// server sends).
//
// PvP marks (T5.2): original sigils, one silhouette per mark so they read without colour
// too, in the colours of docs/02 "Marcas": amber crossed blades for the aggressor (drew
// steel on someone), a crimson drop for the murderer (spilled blood), a violet broken shield
// for the outlaw (lost the protection of the law). Tiny, so they are hand-placed pixel maps
// instead of shapes, lit from the top-left with a near-black outline like the creatures'.
import type { Image, Rgba } from "@rpg/spritepack";
import { opaque, px } from "../draw.ts";
import { hex, material } from "../palette.ts";
import type { Material } from "../palette.ts";
import type { RecipeBook } from "../recipe.ts";
import { UI_ICON_BOX, UI_SLOT_BOX, UI_STATUS_BOX } from "../recipe.ts";

/** The outline of every mark: near black, warm, like the cast shadows. */
const INK: Rgba = hex("#140e0c");

const AMBER = material("#ffe3a0", "#f2b233", "#b97f1c", "#7a4f0d");
const STEEL_GRIP = material("#9a7a5a", "#6e5238", "#4e3926", "#33241a");
const CRIMSON = material("#ff8f86", "#d23a3a", "#9a2426", "#641517");
const VIOLET = material("#c9a2f2", "#8e4fd6", "#6533a3", "#41206b");

/**
 * Draws a pixel map: one string per row, one character per pixel, at the icon box's
 * inner corner (the box minus the 1 px left for the outline). Characters: "." nothing,
 * L/B/S/D the light, base, shadow and deep shades of `m`, g/G a second material's base and
 * light (`m2`), W a white glint. Then outlines the result (outside, 8-neighbour) in INK.
 */
function pixelMap(img: Image, rows: readonly string[], m: Material, m2: Material = m): void {
  const x0 = UI_ICON_BOX.x + 1;
  const y0 = UI_ICON_BOX.y + 1;
  const colours: Record<string, Rgba> = {
    L: m.light,
    B: m.base,
    S: m.shadow,
    D: m.deep,
    g: m2.base,
    G: m2.light,
    W: hex("#fffaf0"),
  };
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = colours[ch];
      if (c) px(img, x0 + x, y0 + y, c);
    });
  });
  outsideOutline(img, INK);
}

/** A 1 px outline around every shape, outside it (thin details keep their colour). */
function outsideOutline(img: Image, c: Rgba): void {
  const marks: [number, number][] = [];
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      if (opaque(img, x, y)) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1 && !near; dx++) near = opaque(img, x + dx, y + dy);
      if (near) marks.push([x, y]);
    }
  for (const [x, y] of marks) px(img, x, y, c);
}

// The maps are 10x10: the outline makes them 12x12, the icon box.

/**
 * Aggressor: two swords crossed, amber, points up: 2 px blades (lit edge, base edge) that
 * meet in the middle, a crossguard across each blade's end, leather grips and pommels.
 */
const AGGRESSOR = [
  "LB......BL",
  ".LB....BL.",
  "..LB..BL..",
  "...LBBL...",
  "....LB....",
  "..SBLLBS..",
  "...S..S...",
  "..G.SS.G..",
  ".G......G.",
  "B........B",
];

/** Murderer: a drop of blood, crimson, with a glint on its lit side. */
const MURDERER = [
  "....BB....",
  "....BB....",
  "...LBBS...",
  "...LBBS...",
  "..LWBBBS..",
  ".LWBBBBSS.",
  ".LBBBBBSS.",
  ".BBBBBSSD.",
  "..SBSSSD..",
  "...SDDD...",
];

/** Outlaw: a heater shield split by a jagged crack, violet, its halves pushed apart. */
const OUTLAW = [
  "LLLL..BBBS",
  "LBBB..BBBS",
  "LBBBB.BBBS",
  "LBBB.BBBBS",
  "LBBB..BBBS",
  ".BBBB.BBS.",
  ".BBB.BBBS.",
  "..BB..BS..",
  "...B.BS...",
  "....DD....",
];

// ---- Empty equipment slots (docs/17 UI-5) ----------------------------------------------
// What each slot of the equipment window takes, as a silhouette cut in the stone: the
// client draws it faded under a slot that holds nothing (client/src/ui/Inventory.tsx), so
// a new player sees where the helmet or the shield goes. One shape per slot, no colour of
// its own: bone white lit from the top-left (an edge with nothing above or left of it),
// shaded on the bottom-right edges, flat in between. 20x20 masks ("#"), placed at
// UI_SLOT_BOX.

/** Light, flat and shaded bone of the slot silhouettes. */
const BONE = { light: hex("#e3d8bf"), base: hex("#b3a68a"), shadow: hex("#76694f") } as const;

/** Draws a 20x20 mask at UI_SLOT_BOX, lit from the top-left like an engraving. */
function slotMask(img: Image, rows: readonly string[]): void {
  const on = (x: number, y: number): boolean => rows[y]?.[x] === "#";
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== "#") return;
      const c =
        !on(x, y - 1) || !on(x - 1, y)
          ? BONE.light
          : !on(x, y + 1) || !on(x + 1, y)
            ? BONE.shadow
            : BONE.base;
      px(img, UI_SLOT_BOX.x + x, UI_SLOT_BOX.y + y, c);
    });
  });
}

/** Head: a closed helm, its eye slits split by the nose guard. */
const SLOT_HEAD = [
  "....................",
  "......########......",
  "....############....",
  "...##############...",
  "..################..",
  "..################..",
  ".##################.",
  ".##################.",
  ".##################.",
  ".####....##....####.",
  ".####....##....####.",
  ".######..##..######.",
  ".######..##..######.",
  "..#####..##..#####..",
  "..#####......#####..",
  "...####......####...",
  "....###......###....",
  "....................",
  "....................",
  "....................",
];

/** Neck: an amulet on its chain. */
const SLOT_NECK = [
  "....................",
  "..#..............#..",
  "..#..............#..",
  "...#............#...",
  "...#............#...",
  "....#..........#....",
  "....#..........#....",
  ".....#........#.....",
  "......#......#......",
  ".......#....#.......",
  "........####........",
  ".......######.......",
  "......########......",
  "......###..###......",
  "......###..###......",
  "......########......",
  ".......######.......",
  "........####........",
  "....................",
  "....................",
];

/** Backpack: a sack with its handle, its flap and a pocket. */
const SLOT_BACKPACK = [
  "....................",
  ".......######.......",
  "......##....##......",
  "......#......#......",
  "...##############...",
  "..################..",
  "..################..",
  "..#######..#######..",
  "..################..",
  "..################..",
  "..################..",
  "..####........####..",
  "..####.######.####..",
  "..####.######.####..",
  "..####.######.####..",
  "..####........####..",
  "..################..",
  "...##############...",
  "....................",
  "....................",
];

/** Armor: a tunic with its sleeves and the neck cut. */
const SLOT_ARMOR = [
  "....................",
  "....####....####....",
  "...######..######...",
  "..#######..#######..",
  ".##################.",
  "####################",
  "####################",
  "###.############.###",
  "##..############..##",
  "#...############...#",
  "....############....",
  "....############....",
  "....############....",
  "....############....",
  "....############....",
  "....############....",
  "....############....",
  ".....##########.....",
  "....................",
  "....................",
];

/** Right hand (the weapon's): a sword, point up and to the right. */
const SLOT_RIGHT_HAND = [
  "....................",
  ".................##.",
  "................###.",
  "...............###..",
  "..............###...",
  ".............###....",
  "............###.....",
  "...........###......",
  "..........###.......",
  ".........###........",
  "....#...###.........",
  ".....#.###..........",
  "......###...........",
  ".....####...........",
  "....##..##..........",
  "...##....#..........",
  "..##................",
  ".###................",
  ".##.................",
  "....................",
];

/** Left hand (the shield's): a heater shield with a cross. */
const SLOT_LEFT_HAND = [
  "....................",
  "...##############...",
  "..################..",
  "..#######..#######..",
  "..#######..#######..",
  "..#######..#######..",
  "..##............##..",
  "..################..",
  "..#######..#######..",
  "..#######..#######..",
  "..#######..#######..",
  "...######..######...",
  "...######..######...",
  "....#####..#####....",
  ".....####..####.....",
  "......###..###......",
  ".......##..##.......",
  "........#..#........",
  "....................",
  "....................",
];

/** Legs: a pair of trousers. */
const SLOT_LEGS = [
  "....................",
  "....############....",
  "....############....",
  "....############....",
  "...##############...",
  "...######..######...",
  "...######..######...",
  "...#####....#####...",
  "...#####....#####...",
  "..######....######..",
  "..#####......#####..",
  "..#####......#####..",
  "..#####......#####..",
  "..#####......#####..",
  "..#####......#####..",
  ".######......######.",
  ".######......######.",
  "....................",
  "....................",
  "....................",
];

/** Feet: a boot, toe to the right. */
const SLOT_FEET = [
  "....................",
  "....................",
  "......#######.......",
  "......#######.......",
  "......#######.......",
  "......#######.......",
  "......#######.......",
  "......#######.......",
  "......#######.......",
  "......#######.......",
  "......########......",
  ".....##########.....",
  ".....############...",
  ".....#############..",
  ".....##############.",
  ".....##############.",
  ".....##############.",
  "....................",
  "....................",
  "....................",
];

/** Ring: a band with its stone on top. */
const SLOT_RING = [
  "....................",
  "....................",
  "........####........",
  ".......######.......",
  "........####........",
  "......########......",
  ".....###....###.....",
  "....##........##....",
  "....##........##....",
  "...##..........##...",
  "...##..........##...",
  "...##..........##...",
  "....##........##....",
  "....##........##....",
  ".....###....###.....",
  "......########......",
  "....................",
  "....................",
  "....................",
  "....................",
];

/** Ammo: three arrows, points up. */
const SLOT_AMMO = [
  "....................",
  "....#.....#.....#...",
  "...###...###...###..",
  "..#####.#####.#####.",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "....#.....#.....#...",
  "...#.#...#.#...#.#..",
  "...#.#...#.#...#.#..",
  "...#.#...#.#...#.#..",
  "....#.....#.....#...",
  "....................",
  "....................",
  "....................",
];

/** The silhouette of each equipment slot (client/src/ui/Inventory.tsx SLOT_KEYS). */
export const SLOT_MASKS: Readonly<Record<string, readonly string[]>> = {
  head: SLOT_HEAD,
  neck: SLOT_NECK,
  backpack: SLOT_BACKPACK,
  armor: SLOT_ARMOR,
  right_hand: SLOT_RIGHT_HAND,
  left_hand: SLOT_LEFT_HAND,
  legs: SLOT_LEGS,
  feet: SLOT_FEET,
  ring: SLOT_RING,
  ammo: SLOT_AMMO,
};

// ---- Status tray (docs/17 "Bandeja de estados") ----------------------------------------
// One icon per condition (balance.yaml conditions) and per status the server sends
// (server/internal/session/status.go), shown in the tray by the chat at 2x: 14x14 maps of
// our own, each with its own silhouette and colours, lit from the top-left and outlined in
// INK to 16x16 (UI_STATUS_BOX). Whether it helps or harms is the client's frame (green or
// red), not the drawing. The characters are each map's own palette; "." is nothing.

/** A status map: its rows (14x14) and the colour of each character. */
export interface StatusArt {
  rows: readonly string[];
  colours: Readonly<Record<string, string>>;
}

/** Draws a status map at UI_STATUS_BOX's inner corner and outlines it in INK. */
function statusIcon(img: Image, art: StatusArt): void {
  const x0 = UI_STATUS_BOX.x + 1;
  const y0 = UI_STATUS_BOX.y + 1;
  art.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const c = art.colours[ch];
      if (c) px(img, x0 + x, y0 + y, hex(c));
    });
  });
  outsideOutline(img, INK);
}

/** poison: a drop of venom, green, with bubbles rising beside it. */
const POISON: StatusArt = {
  rows: [
    "......BS......",
    "......BS...G..",
    ".....LBBS.....",
    ".....LBBS..GG.",
    "....LBBBBS.GG.",
    "....LWBBBS....",
    "...LWBBBBBS...",
    "...LWBBdBBS...",
    "..LWBBBBBBBS..",
    "..LBBdBBBBBS..",
    "..LBBBBBBdBS..",
    "...BBBBBBBS...",
    "....SBBBSD....",
    ".....SDDD.....",
  ],
  colours: {
    L: "#d2f07a",
    B: "#7cc22a",
    S: "#46881c",
    D: "#24500e",
    W: "#f2ffe0",
    G: "#b8ea5a",
    d: "#3a7a16",
  },
};

/** burning: a flame with a tongue on its side, red outside, yellow and white in its heart. */
const BURNING: StatusArt = {
  rows: [
    ".....D........",
    ".....OD.......",
    "....OOD....D..",
    "....OOOD..OD..",
    "...OOYOOD.OD..",
    "...OYYOOOOOD..",
    "..OOYYYOOOOD..",
    "..OYYWYYOOOOD.",
    ".OOYWWWYYOOOD.",
    ".OYYWWWWYYOOD.",
    ".OYYWWWWWYYOD.",
    ".OOYYWWWYYOOD.",
    "..DOOYYYOOODD.",
    "...DDDDDDDD...",
  ],
  colours: { D: "#a8281a", O: "#ee6a1c", Y: "#ffc93a", W: "#fff4c2" },
};

/** shocked: a bolt of lightning, yellow with a white edge, and two sparks. */
const SHOCKED: StatusArt = {
  rows: [
    "......LBBBB...",
    ".....LBBBBS...",
    ".....LBBBS..c.",
    "....LBBBS.....",
    "....LBBS......",
    "...LBBBBBBBB..",
    "...LWWWBBBBS..",
    "......LBBBS...",
    "..c..LBBBS....",
    ".....LBBS.....",
    "....LBBS......",
    "....LBS.......",
    "...LBS........",
    "...BS.........",
  ],
  colours: { L: "#fffbe0", W: "#fff3a0", B: "#ffd23c", S: "#c28e12", c: "#8fe0ff" },
};

/** slowed: a snail, its spiral shell on its back, crawling to the right. */
const SLOWED: StatusArt = {
  rows: [
    "..............",
    "......SSSS....",
    ".....SBBBBS...",
    "....SBLLLLBS..",
    "....SBLSSLBBS.",
    "....SBLSLSLBS.",
    "....SBLSSSLBS.",
    "g.g.SBBLLLBBS.",
    ".g.g.SBBBBBS..",
    ".ghh..SSSSS...",
    ".hhhhhhhhhhhh.",
    "..kkkkkkkkkkkk",
    "..............",
    "..............",
  ],
  colours: {
    L: "#f0c27a",
    B: "#b9782e",
    S: "#6e4318",
    g: "#c9d6a0",
    h: "#8fa064",
    k: "#566238",
  },
};

/** hasted: a winged boot with speed lines behind it. */
const HASTED: StatusArt = {
  rows: [
    "..............",
    "......LBBBS...",
    "......LBBBS...",
    "WW....LBBBS...",
    ".WWW..LBBBS...",
    "WWWWW.LBBBS...",
    ".WWWwwLBBBS...",
    "..WWwwLBBBBS..",
    "....wwLBBBBBS.",
    "gg....LBBBBBBS",
    "..ggg.LBBBBBBS",
    "gg....SSSSSSSD",
    "..............",
    "..............",
  ],
  colours: {
    W: "#fffaf0",
    w: "#cfd8e8",
    L: "#d89a5a",
    B: "#9a5f2c",
    S: "#5e3816",
    D: "#3a220c",
    g: "#a8e0ff",
  },
};

/** invisible: an open eye struck through, pale violet. */
const INVISIBLE: StatusArt = {
  rows: [
    "............D.",
    "...........D..",
    "....SSSSS.D...",
    "..SSWWWWWDSS..",
    ".SWWWBBBDWWWS.",
    "SWWWBBBDBBWWWS",
    "SWWWBBDkBBWWWS",
    "SWWWBDBBBBWWWS",
    ".SWWDBBBBWWWS.",
    "..SDWWWWWWSS..",
    "..DSSSSSSS....",
    ".D............",
    "D.............",
    "..............",
  ],
  colours: { W: "#f4eeff", B: "#9a78e0", S: "#6a54a0", D: "#3a2a66", k: "#1c1430" },
};

/** keen_eye: a target, red and white rings, with an arrow in its gold heart. */
const KEEN_EYE: StatusArt = {
  rows: [
    "....SSSSS..fa.",
    "..SSWWWWWSSfa.",
    ".SWWRRRRRWfa..",
    ".SWRRWWWRRa...",
    "SWRRWWRWWa....",
    "SWRWWRRRa.....",
    "SWRWRRGa......",
    "SWRWWRRRWWRWS.",
    "SWRRWWRWWRRWS.",
    ".SWRRWWWRRWS..",
    ".SWWRRRRRWWS..",
    "..SSWWWWWSS...",
    "....SSSSS.....",
    "..............",
  ],
  colours: { W: "#f4eee0", R: "#d23a3a", S: "#8a7f6a", G: "#ffd23c", a: "#8a5a2c", f: "#e8e2d0" },
};

/** well_fed: a roast drumstick, its bone end down to the left. */
const WELL_FED: StatusArt = {
  rows: [
    "........LBBS..",
    "......LLBBBBS.",
    ".....LBBBBBBS.",
    "....LBBBBBBBS.",
    "....LBBBBBBSS.",
    "....LBBBBBSSD.",
    ".....BBBBSSD..",
    "....wSSSSDD...",
    "...wwD........",
    "..wwW.........",
    ".WwW..........",
    "WWW...........",
    ".W............",
    "..............",
  ],
  colours: { L: "#f0b070", B: "#c26a2c", S: "#8a4418", D: "#5a2a0c", W: "#fffaf0", w: "#e0d6c0" },
};

/** in_combat: a sword held up in front of a round shield. */
const IN_COMBAT: StatusArt = {
  rows: [
    "LS..........SL",
    ".LS........SL.",
    "..LS......SL..",
    "...LS....SL...",
    "....LS..SL....",
    ".....LSSL.....",
    "......LL......",
    ".....SLLS.....",
    "...gSL..LSg...",
    "....g....g....",
    "...h.g..g.h...",
    "..h........h..",
    ".G..........G.",
    "..............",
  ],
  colours: { L: "#f4f6fa", S: "#9aa4b4", g: "#e2b84a", G: "#c9962e", h: "#7a4a22" },
};

/** pvp_locked: a padlock, an iron shackle over a crimson body with its keyhole. */
const PVP_LOCKED: StatusArt = {
  rows: [
    ".....SSSSS....",
    "....SLLLLLS...",
    "...SL.....LS..",
    "...SL.....LS..",
    "...SL.....LS..",
    "..GGGGGGGGGGG.",
    "..GLLLLLLLLLG.",
    "..GLBBDDDBBBG.",
    "..GLBBDDDBBBG.",
    "..GLBBBDBBBBG.",
    "..GLBBBDBBBBG.",
    "..GLBBBBBBBBG.",
    "..GSSSSSSSSSG.",
    "...GGGGGGGGG..",
  ],
  colours: { S: "#5a5650", L: "#c8c2b8", G: "#b8923f", B: "#a3201b", D: "#2a0606" },
};

/** protection_zone: a shield with a gold rim and a white cross on blue. */
const PROTECTION_ZONE: StatusArt = {
  rows: [
    ".GGGGGGGGGGGG.",
    ".GLLLLLLLLLLG.",
    ".GLBBBBWBBBSG.",
    ".GLBBBBWBBBSG.",
    ".GLBBWWWWWBSG.",
    ".GLBBBBWBBBSG.",
    ".GLBBBBWBBBSG.",
    ".GLBBBBBBBBSG.",
    "..GLBBBBBBSG..",
    "..GLBBBBBBSG..",
    "...GLBBBBSG...",
    "....GLBBSG....",
    ".....GSSG.....",
    "......GG......",
  ],
  colours: { G: "#e2c47a", L: "#7fb0f0", B: "#2f5fb8", S: "#1c3a78", W: "#fffaf0" },
};

/** party_bonus: two companions side by side, one in blue and one in gold. */
const PARTY_BONUS: StatusArt = {
  rows: [
    "..............",
    "...SS....ss...",
    "..SHHS..shhs..",
    "..SHHS..shhs..",
    "...SS....ss...",
    "..BBBB..GGGG..",
    ".BBLBBBGGgGGG.",
    ".BBLBBBGGgGGG.",
    ".BBLBBBGGgGGG.",
    ".BBBBBBGGGGGG.",
    "..BBBB..GGGG..",
    "..BB.BB.GG.GG.",
    "..DD.DD.DD.DD.",
    "..............",
  ],
  colours: {
    S: "#b07a50",
    H: "#f0c8a0",
    s: "#a06a40",
    h: "#e8b888",
    B: "#2f6fc8",
    L: "#7fb0f0",
    G: "#c8962e",
    g: "#f2d27a",
    D: "#3a2a1c",
  },
};

/** The art of each status tray icon, by condition or status id. */
export const STATUS_ART: Readonly<Record<string, StatusArt>> = {
  poison: POISON,
  burning: BURNING,
  shocked: SHOCKED,
  slowed: SLOWED,
  hasted: HASTED,
  invisible: INVISIBLE,
  keen_eye: KEEN_EYE,
  well_fed: WELL_FED,
  in_combat: IN_COMBAT,
  pvp_locked: PVP_LOCKED,
  protection_zone: PROTECTION_ZONE,
  party_bonus: PARTY_BONUS,
};

export const UI: RecipeBook = {
  "ui/marks/aggressor": { kind: "ui", draw: (img) => pixelMap(img, AGGRESSOR, AMBER, STEEL_GRIP) },
  "ui/marks/murderer": { kind: "ui", draw: (img) => pixelMap(img, MURDERER, CRIMSON) },
  "ui/marks/outlaw": { kind: "ui", draw: (img) => pixelMap(img, OUTLAW, VIOLET) },
  ...Object.fromEntries(
    Object.entries(SLOT_MASKS).map(([slot, rows]) => [
      `ui/slots/${slot}`,
      { kind: "ui" as const, draw: (img: Image) => slotMask(img, rows) },
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(STATUS_ART).map(([id, art]) => [
      `ui/status/${id}`,
      { kind: "ui" as const, draw: (img: Image) => statusIcon(img, art) },
    ]),
  ),
};
