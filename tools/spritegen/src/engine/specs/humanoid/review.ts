// Review images of the engine humanoid (docs/17 "Humanoides del motor"; look at them with
// Read): composed looks as the client stacks them.
// - the contact sheet of a look: every frame of every action and facing at `scale`x;
// - the lineup: the looks standing, walking and striking at 1x and at 2x, on grass with
//   the 32 px tile grid drawn, next to the engine boar and stag (the animals the owner
//   likes) and, when given, a reference person (the old LPC citizen) for scale.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blit,
  createImage,
  decodePng,
  drawText,
  fillRect,
  GLYPH_H,
  scaleImage,
} from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import { renderSpec } from "../../render.ts";
import { footOf, over, unionBox } from "../../sheet.ts";
import type { SpriteSpec } from "../../spec.ts";
import { CLIENT } from "../../style.ts";
import type { ActionName, Dir } from "../../style.ts";
import { composeFrame } from "./compose.ts";
import type { Look, LookTables, Worn } from "./compose.ts";
import { WALK_FRAMES } from "./skeleton.ts";

const BACKDROP: Rgba = [96, 104, 92, 255];
const PAPER: Rgba = [24, 24, 28, 255];
const LABEL: Rgba = [230, 230, 220, 255];
const GRID: Rgba = [20, 22, 18, 255];

/** A named look to review. */
export interface ReviewLook {
  name: string;
  look: Look;
  worn: Worn;
}

const ROWS: readonly [ActionName, readonly Dir[], number][] = [
  ["idle", ["s", "w", "n", "e"], 2],
  ["walk", ["s", "w", "n", "e"], WALK_FRAMES],
  ["attack", ["s", "w", "n", "e"], 4],
  ["shoot", ["s", "w", "n", "e"], 3],
  ["cast", ["s", "w", "n", "e"], 3],
  ["death", ["s"], 4],
];

/** Every frame of a look at `scale`x, one row per action and facing. */
export function lookSheet(r: ReviewLook, tables: LookTables, scale = 4): Image {
  const frames: { key: string; img: Image }[][] = ROWS.flatMap(([action, dirs, n]) =>
    dirs.map((dir) =>
      Array.from({ length: n }, (_, f) => ({
        key: `${action} ${dir}`,
        img: composeFrame(r.look, r.worn, tables, action, dir, f),
      })),
    ),
  );
  const [x0, y0, x1, y1] = unionBox(frames.flat().map((f) => f.img));
  const m = 2;
  const cw = (x1 - x0 + 1 + 2 * m) * scale;
  const ch = (y1 - y0 + 1 + 2 * m) * scale;
  const labelW = 120;
  const head = GLYPH_H * 2 + 8;
  const cols = Math.max(...frames.map((r) => r.length));
  const sheet = createImage(labelW + cols * (cw + 1) + 1, head + frames.length * (ch + 1) + 1);
  fillRect(sheet, 0, 0, sheet.width, sheet.height, PAPER);
  drawText(sheet, `${r.name.toUpperCase()}  ${scale}X`, 4, 4, 2, LABEL);
  frames.forEach((row, i) => {
    const y = head + i * (ch + 1);
    drawText(
      sheet,
      (row[0]?.key ?? "").toUpperCase(),
      4,
      y + Math.floor(ch / 2) - GLYPH_H,
      2,
      LABEL,
    );
    row.forEach((f, c) => {
      const cell = createImage(x1 - x0 + 1 + 2 * m, y1 - y0 + 1 + 2 * m);
      fillRect(cell, 0, 0, cell.width, cell.height, BACKDROP);
      over(cell, f.img, m - x0, m - y0);
      const big = scaleImage(cell, scale);
      blit(big, 0, 0, big.width, big.height, sheet, labelW + 1 + c * (cw + 1), y + 1);
    });
  });
  return sheet;
}

/** Darkens the client's contact shadow under feet at (cx, cy). */
function shadowAt(img: Image, cx: number, cy: number): void {
  const rx = CLIENT.shadowW / 2;
  const ry = CLIENT.shadowH / 2;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny > 1 || x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++)
        img.data[i + c] = Math.round((img.data[i + c] ?? 0) * (1 - CLIENT.shadowAlpha));
    }
}

/**
 * The lineup at 1x: one tile per figure on grass with the tile grid, each standing on its
 * tile as the client places it (feet FEET_LINE above the tile's bottom over the contact
 * shadow). `figures` are 64x64 frames (bc) with their foot rows.
 */
function field(root: string, figures: readonly Image[]): Image {
  const tiles = figures.length + 1;
  const w = tiles * 32 + 32;
  const h = 96;
  const out = createImage(w, h);
  const grassFile = join(root, "assets/sprites/ground/grass.png");
  const grass = existsSync(grassFile) ? decodePng(readFileSync(grassFile)) : undefined;
  for (let y = 0; y < h; y += 32)
    for (let x = 0; x < w; x += 32)
      if (grass) blit(grass, 0, 0, Math.min(32, w - x), Math.min(32, h - y), out, x, y);
      else fillRect(out, x, y, 32, 32, BACKDROP);
  for (let x = 0; x < w; x += 32) fillRect(out, x, 0, 1, h, GRID);
  for (let y = 0; y < h; y += 32) fillRect(out, 0, y, w, 1, GRID);
  figures.forEach((img, i) => {
    const tx = 32 + i * 32;
    const tileBottom = 64;
    shadowAt(out, tx + 16, tileBottom - CLIENT.feetLine);
    const bottom = tileBottom - CLIENT.feetLine + footOf([img]);
    over(out, img, Math.round(tx + 16 - img.width / 2), bottom - img.height);
  });
  return out;
}

/**
 * The lineup of the looks among the engine animals and a reference person, at 1x (top)
 * and 2x (below), with each figure's name.
 */
export function humanoidLineup(
  root: string,
  looks: readonly ReviewLook[],
  tables: LookTables,
  animals: readonly SpriteSpec[],
  reference?: Image,
): Image {
  const figures: Image[] = [];
  if (reference) figures.push(reference);
  for (const a of animals) figures.push(renderSpec(a, { action: "walk", dir: "w", frame: 0 }));
  const poses: [ActionName, Dir, number][] = [
    ["idle", "s", 0],
    ["walk", "w", 1],
    ["walk", "e", 5],
    ["walk", "n", 2],
    ["attack", "w", 1],
  ];
  for (const l of looks)
    for (const [a, d, f] of poses) figures.push(composeFrame(l.look, l.worn, tables, a, d, f));
  const one = field(root, figures);
  const two = scaleImage(one, 2);
  const out = createImage(two.width, one.height + two.height + GLYPH_H * 2 + 12);
  fillRect(out, 0, 0, out.width, out.height, PAPER);
  drawText(
    out,
    `${reference ? "LPC PERSON, " : ""}BOAR, STAG, THEN ${looks.map((l) => l.name.toUpperCase()).join(", ")} (IDLE S, WALK W E N, ATTACK W)  1X AND 2X`,
    4,
    4,
    1,
    LABEL,
  );
  const top = GLYPH_H * 2 + 8;
  over(out, one, 0, top);
  over(out, two, 0, top + one.height + 4);
  return out;
}

/** Looks the review sheets show: the default player and the catalog's lines by band. */
export const REVIEW_LOOKS: readonly ReviewLook[] = [
  {
    name: "citizen",
    look: { body: "sturdy", skin: "fair", hair: "short", hairColor: "brown", beard: "none" },
    worn: {
      torso: { shape: "tunic", tint: "linen" },
      legs: { shape: "trousers", tint: "brown" },
      feet: { shape: "shoes", tint: "dark_leather" },
    },
  },
  {
    name: "guardian",
    look: { body: "sturdy", skin: "brown", hair: "crop", hairColor: "black", beard: "full" },
    worn: {
      head: { shape: "open_helm", tint: "embersteel" },
      torso: { shape: "plate", tint: "embersteel" },
      legs: { shape: "greaves", tint: "embersteel" },
      feet: { shape: "sabatons", tint: "embersteel" },
      shield: { shape: "kite", tint: "embersteel" },
      weapon: { shape: "sword", tint: "steel" },
    },
  },
  {
    name: "ranger",
    look: { body: "slender", skin: "tan", hair: "ponytail", hairColor: "auburn", beard: "none" },
    worn: {
      head: { shape: "hood", tint: "stagleather" },
      torso: { shape: "leather", tint: "stagleather" },
      legs: { shape: "trousers", tint: "stagleather" },
      feet: { shape: "boots", tint: "stagleather" },
      weapon: { shape: "bow", tint: "yew" },
    },
  },
  {
    name: "arcanist",
    look: { body: "slender", skin: "pale", hair: "long", hairColor: "blond", beard: "none" },
    worn: {
      torso: { shape: "robe", tint: "dusk" },
      feet: { shape: "shoes", tint: "tar" },
      weapon: { shape: "staff", tint: "ice" },
    },
  },
  {
    name: "tidesteel",
    look: { body: "sturdy", skin: "olive", hair: "short", hairColor: "dark_brown", beard: "short" },
    worn: {
      head: { shape: "full_helm", tint: "tidesteel" },
      torso: { shape: "plate", tint: "tidesteel" },
      legs: { shape: "greaves", tint: "tidesteel" },
      feet: { shape: "sabatons", tint: "tidesteel" },
      shield: { shape: "tower", tint: "wyrmscale" },
      weapon: { shape: "axe", tint: "tidesteel" },
    },
  },
];
