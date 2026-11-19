// Review images of an engine sprite (look at them with Read):
// - the contact sheet: every frame at 4x in a grid, one row per action and facing, every
//   cell cropped to the box all the frames share, on a flat backdrop;
// - the lineup: the sprite at 1x and 2x as the client draws it (bc: feet FEET_LINE px above
//   the tile's bottom, the contact shadow under them; br: bottom-right of its tile) on a
//   ground, beside reference sprites (a Gemini wolf, a person: the citizen outfit) for scale;
//   an item icon also in the client's inventory slots, at 1x and at 2x (the big slots of the
//   equipment figure);
// - the icon board: many item icons in rows (a line of the catalog per row, a level band per
//   column), each in a slot at 2x and 1x and on a tile of grass, or each at 4x.
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
import { engineFrames } from "./book.ts";
import { canvasOf } from "./render.ts";
import type { SpriteSpec } from "./spec.ts";
import { CLIENT } from "./style.ts";

const BACKDROP: Rgba = [96, 104, 92, 255];
const GRID: Rgba = [40, 42, 46, 255];
const LABEL: Rgba = [230, 230, 220, 255];
const PAPER: Rgba = [24, 24, 28, 255];

/** The opaque box shared by a set of same-sized images: [x0, y0, x1, y1] inclusive. */
export function unionBox(imgs: readonly Image[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (const img of imgs)
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++)
        if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) !== 0) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
  return x1 < 0 ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** Draws src over dst at (dx, dy), only its opaque pixels. */
export function over(dst: Image, src: Image, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4;
      if ((src.data[i + 3] ?? 0) === 0) continue;
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      const j = (ty * dst.width + tx) * 4;
      for (let c = 0; c < 4; c++) dst.data[j + c] = src.data[i + c] ?? 0;
    }
}

/** Every frame at `scale`x, one row per action and facing, cells cropped to the union box. */
export function contactSheet(spec: SpriteSpec, scale = 4): Image {
  const frames = engineFrames(spec);
  const [x0, y0, x1, y1] = unionBox(frames.map((f) => f.image));
  const m = 2;
  const cw = (x1 - x0 + 1 + 2 * m) * scale;
  const ch = (y1 - y0 + 1 + 2 * m) * scale;
  const rows = new Map<string, typeof frames>();
  for (const f of frames) {
    const key = f.ref ? `${f.ref.action} ${f.ref.dir}` : f.loop !== undefined ? "loop" : "still";
    rows.set(key, [...(rows.get(key) ?? []), f]);
  }
  const cols = Math.max(...[...rows.values()].map((r) => r.length));
  const labelW = 132;
  const head = GLYPH_H * 2 + 8;
  const sheet = createImage(labelW + cols * (cw + 1) + 1, head + rows.size * (ch + 1) + 1);
  fillRect(sheet, 0, 0, sheet.width, sheet.height, PAPER);
  drawText(sheet, `${spec.sprite.toUpperCase()}  ${scale}X`, 4, 4, 2, LABEL);
  let r = 0;
  for (const [key, list] of rows) {
    const y = head + r * (ch + 1);
    drawText(sheet, key.toUpperCase(), 4, y + Math.floor(ch / 2) - GLYPH_H, 2, LABEL);
    fillRect(sheet, labelW, y, cols * (cw + 1) + 1, ch + 2, GRID);
    list.forEach((f, c) => {
      const cell = createImage(x1 - x0 + 1 + 2 * m, y1 - y0 + 1 + 2 * m);
      fillRect(cell, 0, 0, cell.width, cell.height, BACKDROP);
      over(cell, f.image, m - x0, m - y0);
      const big = scaleImage(cell, scale);
      blit(big, 0, 0, big.width, big.height, sheet, labelW + 1 + c * (cw + 1), y + 1);
    });
    r++;
  }
  return sheet;
}

/** A ground tile repeated over w x h. */
function groundField(ground: Image, w: number, h: number): Image {
  const out = createImage(w, h);
  for (let y = 0; y < h; y += 32)
    for (let x = 0; x < w; x += 32)
      blit(ground, 0, 0, Math.min(32, w - x), Math.min(32, h - y), out, x, y);
  return out;
}

/** Darkens the pixels of the client's contact shadow (an ellipse at SHADOW_ALPHA black). */
function contactShadow(img: Image, cx: number, cy: number): void {
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

/** Empty rows under the lowest opaque pixel of a set of frames (spritepack's `foot`). */
export function footOf(frames: readonly Image[]): number {
  const [, , , y1] = unionBox(frames);
  return (frames[0]?.height ?? 0) - 1 - y1;
}

/**
 * Sprites standing in a row of tiles as the client places them: a bc sprite with its lowest
 * walk row `foot` on the feet line and the contact shadow under it; a br one at its tile's
 * bottom-right corner. Each entry is one tile wide plus what overhangs.
 */
export function lineup(
  root: string,
  entries: readonly { image: Image; anchor: "bc" | "br"; foot: number; shadow: boolean }[],
  ground = "assets/sprites/ground/grass.png",
): Image {
  const tile = 32;
  const step = 48;
  const tallest = Math.max(64, ...entries.map((e) => e.image.height));
  const w = step * entries.length + 32;
  const h = tallest + 32;
  const field = groundField(decodePng(readFileSync(join(root, ground))), w, h);
  entries.forEach((e, i) => {
    const tx = 16 + i * step;
    const tileBottom = h - 8;
    if (e.anchor === "bc") {
      if (e.shadow) contactShadow(field, tx + tile / 2, tileBottom - CLIENT.feetLine);
      const bottom = tileBottom - CLIENT.feetLine + e.foot;
      over(field, e.image, Math.round(tx + tile / 2 - e.image.width / 2), bottom - e.image.height);
    } else {
      over(field, e.image, tx + tile - e.image.width, tileBottom - e.image.height);
    }
  });
  return field;
}

/** A frame from a PNG in assets/sprites, if it is there. */
export function spriteFrame(root: string, path: string): Image | undefined {
  const file = join(root, "assets", "sprites", `${path}.png`);
  return existsSync(file) ? decodePng(readFileSync(file)) : undefined;
}

/** A sprite out of the packed atlas (assets/atlas, after make sprites), if it is there. */
export function atlasFrame(root: string, name: string): Image | undefined {
  const dir = join(root, "assets", "atlas");
  if (!existsSync(join(dir, "atlas.json"))) return undefined;
  const index = JSON.parse(readFileSync(join(dir, "atlas.json"), "utf8")) as {
    pages: string[];
    sprites: Record<string, { page: number }>;
  };
  const s = index.sprites[name];
  const pageJson = s ? index.pages[s.page] : undefined;
  if (!s || !pageJson) return undefined;
  const page = JSON.parse(readFileSync(join(dir, pageJson), "utf8")) as {
    frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
    meta: { image: string };
  };
  const f = page.frames[name]?.frame;
  if (!f) return undefined;
  const png = decodePng(readFileSync(join(dir, page.meta.image)));
  const out = createImage(f.w, f.h);
  blit(png, f.x, f.y, f.w, f.h, out, 0, 0);
  return out;
}

/** The client's inventory slot (client/src/ui/client.css `.inventory .slot`): a near-black
 * well (--ui-stone-950) in a dark iron rim (--ui-iron-900) with a lighter inner line. */
const SLOT_WELL: Rgba = [15, 13, 11, 255];
const SLOT_RIM: Rgba = [26, 24, 22, 255];
const SLOT_INNER: Rgba = [56, 53, 49, 255];

/**
 * An icon in an inventory slot at `scale` (1: a 36 px slot; 2: the 2x big slots of the
 * equipment figure), drawn as the client does: centred, pixel for pixel.
 */
export function slotCell(icon: Image, scale: number): Image {
  const side = icon.width * scale + 4;
  const out = createImage(side, side);
  fillRect(out, 0, 0, side, side, SLOT_RIM);
  fillRect(out, 1, 1, side - 2, side - 2, SLOT_INNER);
  fillRect(out, 2, 2, side - 4, side - 4, SLOT_WELL);
  over(out, scale === 1 ? icon : scaleImage(icon, scale), 2, 2);
  return out;
}

/** The frames a lineup shows of a creature: one per facing walking, the strongest attack and death. */
const LINEUP_FRAMES = ["idle_s_0", "walk_s_1", "walk_w_0", "walk_w_1", "walk_n_2", "walk_e_3"];

/**
 * The review lineup of a spec at 1x (scale it up to look): a Gemini wolf and a person (the
 * citizen outfit, drawn by the engine humanoid) for scale, then the sprite's frames as the client places them,
 * on the ground it is seen on.
 */
export function reviewLineup(root: string, spec: SpriteSpec): Image {
  const frames = engineFrames(spec);
  const ground = spec.seenOn ? `assets/sprites/${spec.seenOn}.png` : undefined;
  const { size } = canvasOf(spec);
  const refs: { image: Image; anchor: "bc" | "br"; foot: number; shadow: boolean }[] = [];
  const wolf = spriteFrame(root, "creatures/wolf/walk_w_0");
  if (wolf) refs.push({ image: wolf, anchor: "bc", foot: footOf([wolf]), shadow: true });
  const person = spriteFrame(root, "outfits/citizen/s_0");
  if (person) refs.push({ image: person, anchor: "bc", foot: footOf([person]), shadow: true });
  if (!spec.actions) {
    // An object: its one image, or every frame of its loop.
    const own = frames.map((f) => ({
      image: f.image,
      anchor: size.anchor,
      foot: 0,
      shadow: false,
    }));
    const field = lineup(root, [...refs, ...own], ground);
    const icon = frames[0]?.image;
    if (size.kind !== "item" || !icon) return field;
    // An item: also in an inventory slot at 1x and at 2x, under the ground row.
    const one = slotCell(icon, 1);
    const two = slotCell(icon, 2);
    const out = createImage(
      Math.max(field.width, one.width + two.width + 24),
      field.height + two.height + 8,
    );
    fillRect(out, 0, 0, out.width, out.height, PAPER);
    over(out, field, 0, 0);
    over(out, one, 8, field.height + 4 + two.height - one.height);
    over(out, two, 16 + one.width, field.height + 4);
    return out;
  }
  const foot = footOf(frames.filter((f) => f.ref?.action === "walk").map((f) => f.image));
  const pick = (name: string): Image | undefined =>
    frames.find((f) => f.path === `${spec.sprite}/${name}`)?.image;
  const names = [...LINEUP_FRAMES];
  const attack = spec.actions.attack;
  if (attack) names.push(`attack_w_${Math.min(1, attack.frames - 1)}`);
  const death = spec.actions.death;
  if (death) names.push(`death_s_${death.frames - 1}`);
  const own = names
    .map(pick)
    .filter((img): img is Image => img !== undefined)
    .map((image) => ({ image, anchor: "bc" as const, foot, shadow: true }));
  return lineup(root, [...refs, ...own], ground);
}

/** One row of an icon board: a label and the icons of that row (undefined: an empty cell). */
export interface IconRow {
  label: string;
  specs: readonly (SpriteSpec | undefined)[];
}

const boardLabel = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ");

/**
 * Item icons in rows, as the player meets them: each one in an inventory slot at 2x (the
 * equipment figure), at 1x (the backpack) and on a tile of grass (dropped on the ground);
 * or, with `detail`, each at 4x on the sheet's backdrop to read its pixels.
 */
export function iconBoard(
  root: string,
  rows: readonly IconRow[],
  detail = false,
  title = "ITEM ICONS",
): Image {
  const grassFile = join(root, "assets/sprites/ground/grass.png");
  const grass = existsSync(grassFile) ? decodePng(readFileSync(grassFile)) : undefined;
  const cellW = detail ? 32 * 4 + 6 : 68 + 4 + 36 + 6;
  const cellH = detail ? 32 * 4 + 6 : 68 + 6;
  const labelW = 150;
  const cols = Math.max(1, ...rows.map((r) => r.specs.length));
  const head = GLYPH_H * 2 + 10;
  const sheet = createImage(labelW + cols * cellW, head + rows.length * cellH);
  fillRect(sheet, 0, 0, sheet.width, sheet.height, PAPER);
  drawText(sheet, boardLabel(title), 4, 4, 2, LABEL);
  rows.forEach((row, r) => {
    const y = head + r * cellH;
    drawText(sheet, boardLabel(row.label), 4, y + Math.floor(cellH / 2) - 4, 1, LABEL);
    row.specs.forEach((spec, c) => {
      if (!spec) return;
      const icon = engineFrames(spec)[0]?.image;
      if (!icon) return;
      const x = labelW + c * cellW;
      if (detail) {
        const cell = createImage(icon.width, icon.height);
        fillRect(cell, 0, 0, cell.width, cell.height, BACKDROP);
        over(cell, icon, 0, 0);
        over(sheet, scaleImage(cell, 4), x, y);
        return;
      }
      over(sheet, slotCell(icon, 2), x, y);
      over(sheet, slotCell(icon, 1), x + 72, y);
      const tile = createImage(32, 32);
      if (grass) blit(grass, 0, 0, 32, 32, tile, 0, 0);
      over(tile, icon, 0, 0);
      over(sheet, tile, x + 74, y + 36);
    });
  });
  return sheet;
}

/** The canvas of a spec (re-exported for the CLI). */
export { canvasOf };

/**
 * Props on the floors of the towns (docs/17 "Kit de props de pueblo"): one row per ground,
 * each starting with a person (the citizen outfit) and then the frame 0 of every
 * prop, at 1x as the client places them. A one-tile prop is judged by how it stands off each
 * floor it is put on, next to a person, so every floor of the towns gets its row.
 */
export function floorBoard(
  root: string,
  specs: readonly SpriteSpec[],
  grounds: readonly string[],
): Image {
  const person = spriteFrame(root, "outfits/citizen/s_0");
  const refs = person
    ? [{ image: person, anchor: "bc" as const, foot: footOf([person]), shadow: true }]
    : [];
  const props = specs.flatMap((spec) => {
    const image = engineFrames(spec)[0]?.image;
    return image ? [{ image, anchor: canvasOf(spec).size.anchor, foot: 0, shadow: false }] : [];
  });
  const rows = grounds
    .filter((g) => existsSync(join(root, "assets", "sprites", `${g}.png`)))
    .map((g) => ({
      label: g,
      image: lineup(root, [...refs, ...props], `assets/sprites/${g}.png`),
    }));
  const labelW = 120;
  const w = labelW + Math.max(0, ...rows.map((r) => r.image.width));
  const out = createImage(
    w,
    rows.reduce((h, r) => h + r.image.height + 2, 0),
  );
  fillRect(out, 0, 0, out.width, out.height, PAPER);
  let y = 0;
  for (const r of rows) {
    drawText(
      out,
      boardLabel(r.label.replace(/^ground\//, "")),
      4,
      y + Math.floor(r.image.height / 2),
      1,
      LABEL,
    );
    over(out, r.image, labelW, y);
    y += r.image.height + 2;
  }
  return out;
}
