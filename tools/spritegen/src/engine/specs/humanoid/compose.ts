// A whole engine humanoid as the client draws it (packages/renderer look.ts): its layers'
// frames stacked in LAYER_ORDER, each multiplied by its tint. For the review sheets and the
// tests that judge the figure (proportions, the planted foot, the order per facing); the
// game never uses these images, it stacks the layers itself.
import { createImage } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import {
  lookSprites,
  LAYER_ORDER,
  actionDir,
} from "../../../../../../packages/renderer/src/look.ts";
import type { Look, LookTables, Worn } from "../../../../../../packages/renderer/src/look.ts";
import { frameImage } from "../../book.ts";
import { frameName } from "../../style.ts";
import type { ActionName, Dir } from "../../style.ts";
import { HUMANOID_LAYERS } from "./index.ts";

export type { Look, LookTables, Worn };

const BY_SPRITE = new Map(HUMANOID_LAYERS.map((l) => [l.sprite, l]));

/** Multiplies `src`'s colour by `tint` (0xrrggbb) and draws its opaque pixels over `dst`. */
export function tintOver(dst: Image, src: Image, tint: number): void {
  const r = (tint >> 16) & 0xff;
  const g = (tint >> 8) & 0xff;
  const b = tint & 0xff;
  for (let i = 0; i < src.data.length; i += 4) {
    if ((src.data[i + 3] ?? 0) === 0) continue;
    dst.data[i] = Math.round(((src.data[i] ?? 0) * r) / 255);
    dst.data[i + 1] = Math.round(((src.data[i + 1] ?? 0) * g) / 255);
    dst.data[i + 2] = Math.round(((src.data[i + 2] ?? 0) * b) / 255);
    dst.data[i + 3] = 255;
  }
}

/** One frame of a layer by its sprite path (rendered once per process). */
export function layerFrame(
  sprite: string,
  action: ActionName,
  dir: Dir,
  frame: number,
): Image | undefined {
  const l = BY_SPRITE.get(sprite);
  if (!l) return undefined;
  const d = actionDir(action, dir);
  return frameImage(l.spec, frameName(sprite, action, d, frame), { action, dir: d, frame });
}

/**
 * The look wearing `worn`, one frame of `action` facing `dir`, as the client stacks it.
 */
export function composeFrame(
  look: Look,
  worn: Worn,
  tables: LookTables,
  action: ActionName,
  dir: Dir,
  frame: number,
): Image {
  const sprites = lookSprites(look, worn, tables);
  const out = createImage(64, 64);
  for (const slot of LAYER_ORDER[actionDir(action, dir)]) {
    const s = sprites[slot];
    if (!s) continue;
    const img = layerFrame(s.sprite, action, dir, frame);
    if (img) tintOver(out, img, s.tint);
  }
  return out;
}
