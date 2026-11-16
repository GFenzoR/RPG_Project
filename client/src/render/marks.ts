// PvP marks (T5.2) as pixel art: which atlas sprite shows a skull and how to cut its icon
// out for the DOM. Pure, no Pixi.
//
// The marks are our own icons drawn by tools/spritegen (recipes/ui.ts): ui/marks/<id> with
// the id of state/pvp.ts skullId (crossed swords for the aggressor, a drop of blood for the
// murderer, a broken shield for the outlaw). Each is a 32x32 sprite (the atlas works in
// multiples of 32) with the drawing inside MARK_BOX, which is all the client shows. Without
// the sprite in the atlas the canvas and the battle list fall back to the shapes of before.
import type { Skull } from "@rpg/protocol";
import { skullId } from "../state/pvp.ts";

/**
 * The part of a mark sprite with the drawing: x, y, width, height in sprite pixels. The
 * same numbers as UI_ICON_BOX in tools/spritegen/src/recipe.ts (a test checks it).
 */
export const MARK_BOX = { x: 10, y: 10, w: 12, h: 12 } as const;

/** A sprite's rectangle in its page image, as the renderer's Atlas.icon gives it. */
export interface MarkIcon {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The atlas sprite of a mark (ui/marks/<id>), undefined without one. */
export function markSprite(s: Skull): string | undefined {
  const id = skullId(s);
  return id ? `ui/marks/${id}` : undefined;
}

/**
 * Whether an atlas entry is real art to show: a placeholder square with a label (origin
 * auto or placeholder) would read worse than the fallback shapes.
 */
export function isMarkArt(entry: { origin: string } | undefined): boolean {
  return entry !== undefined && entry.origin !== "auto" && entry.origin !== "placeholder";
}

/**
 * The inline style of a DOM mark: MARK_BOX of the sprite as a CSS background, one CSS pixel
 * per sprite pixel (like the item icons). Undefined when the sprite is missing or is not
 * the size of a mark sprite (a sprite of another size has no MARK_BOX).
 */
export function markIconStyle(icon: MarkIcon | undefined): Record<string, string> | undefined {
  if (!icon || icon.width < MARK_BOX.x + MARK_BOX.w || icon.height < MARK_BOX.y + MARK_BOX.h)
    return undefined;
  return {
    backgroundImage: `url(${icon.url})`,
    backgroundPosition: `-${icon.x + MARK_BOX.x}px -${icon.y + MARK_BOX.y}px`,
    width: `${MARK_BOX.w}px`,
    height: `${MARK_BOX.h}px`,
  };
}
