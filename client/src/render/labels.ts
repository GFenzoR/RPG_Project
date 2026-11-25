// Creature labels at small zoom (T5.6), pure and unit-tested. At zoom 1 a tile is 32 px and
// a name is wider than that, so the names, guild lines and skulls of creatures side by
// side overlap. The rule, in priority order (own creature, target, then nearest first):
// place a label where it fits; if it overlaps one already placed, drop its guild line,
// then lift it above the other one (at most one line); if it still overlaps, only the
// ones next to the player stay (on top), the rest hide. Long names are shortened. What
// counts is how big the labels are next to a tile: labels drawn at `labelScale` screen
// pixels per font cell (render/label-style.ts) at map scale `zoom` show untouched only
// when zoom >= LABEL_FULL_ZOOM * labelScale (a name at most half as tall, next to its
// tile, as at zoom 2 with the 11 px font). Large names keep the rules at every zoom.

/** Zoom per label scale from which every label shows untouched. */
export const LABEL_FULL_ZOOM = 2;

/** Whether labels at `labelScale` show untouched at map scale `zoom`. */
export const labelsFull = (zoom: number, labelScale = 1): boolean =>
  zoom >= LABEL_FULL_ZOOM * Math.max(1, labelScale);
/** Longest name at small zoom, in characters (the ellipsis included). */
export const SHORT_NAME_CHARS = 12;
/** Creatures this close (tiles, Chebyshev) keep their label even when it overlaps. */
export const NEAR_TILES = 1;

/** One creature's label block: its name, the guild line under it and the skull left of it. */
export interface LabelBox {
  id: number;
  /** Centre of the block's bottom edge, screen px (where the label is anchored now). */
  x: number;
  y: number;
  /** Width of the widest line, skull included, px. */
  width: number;
  /** Height of the name line, px. */
  nameHeight: number;
  /** Height of the guild line, px; 0 when the creature shows no guild. */
  guildHeight: number;
  self: boolean;
  target: boolean;
  /** Tiles from the own creature (Chebyshev). */
  distance: number;
}

export interface LabelPlacement {
  show: boolean;
  /** Draw the guild line. */
  guild: boolean;
  /** Move the whole block up by this many px (0 = where it is now). */
  lift: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const rectOf = (b: LabelBox, guild: boolean, lift: number): Rect => {
  const h = b.nameHeight + (guild ? b.guildHeight : 0);
  return {
    left: b.x - b.width / 2,
    right: b.x + b.width / 2,
    top: b.y - lift - h,
    bottom: b.y - lift,
  };
};

/** Own creature first, then the target, then by distance; ties by id (stable frames). */
const rank = (a: LabelBox, b: LabelBox): number =>
  Number(b.self) - Number(a.self) ||
  Number(b.target) - Number(a.target) ||
  a.distance - b.distance ||
  a.id - b.id;

/**
 * Where each label goes this frame (keyed by creature id). `labelScale` is the label's
 * screen pixels per font cell: the gap left above a label it is lifted over.
 */
export function placeLabels(
  boxes: readonly LabelBox[],
  zoom: number,
  labelScale = 1,
): Map<number, LabelPlacement> {
  const out = new Map<number, LabelPlacement>();
  const gap = Math.max(1, labelScale);
  if (labelsFull(zoom, labelScale)) {
    for (const b of boxes) out.set(b.id, { show: true, guild: b.guildHeight > 0, lift: 0 });
    return out;
  }
  const placed: Rect[] = [];
  const free = (r: Rect): Rect | undefined => placed.find((p) => overlaps(p, r));
  for (const b of [...boxes].sort(rank)) {
    const hasGuild = b.guildHeight > 0;
    const tries: { guild: boolean; lift: number }[] = [{ guild: hasGuild, lift: 0 }];
    if (hasGuild) tries.push({ guild: false, lift: 0 });
    let chosen: { guild: boolean; lift: number } | undefined;
    for (const t of tries) {
      if (!free(rectOf(b, t.guild, t.lift))) {
        chosen = t;
        break;
      }
    }
    if (!chosen) {
      // Lift the name-only block just above the label it hits, at most one line up.
      const hit = free(rectOf(b, false, 0));
      const lift = hit ? b.y - hit.top + gap : 0;
      if (lift > 0 && lift <= b.nameHeight + gap && !free(rectOf(b, false, lift))) {
        chosen = { guild: false, lift };
      }
    }
    if (!chosen && (b.self || b.target || b.distance <= NEAR_TILES)) {
      chosen = { guild: false, lift: 0 };
    }
    if (!chosen) {
      out.set(b.id, { show: false, guild: false, lift: 0 });
      continue;
    }
    placed.push(rectOf(b, chosen.guild, chosen.lift));
    out.set(b.id, { show: true, ...chosen });
  }
  return out;
}

/** The name to draw at this zoom and label scale: shortened with an ellipsis unless labelsFull. */
export function labelText(
  name: string,
  zoom: number,
  max = SHORT_NAME_CHARS,
  labelScale = 1,
): string {
  if (labelsFull(zoom, labelScale)) return name;
  const chars = [...name];
  if (chars.length <= max) return name;
  return `${chars
    .slice(0, Math.max(1, max - 1))
    .join("")
    .trimEnd()}…`;
}
