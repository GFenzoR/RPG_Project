// Creature labels (docs/17 UI-3 "Nombres"), pure and unit-tested: what each line says and
// how big, and where the blocks go when they crowd.
//
// Lines. A player or a monster has one line, its name. A long name first shrinks a little
// (fitName, down to SHRINK_MIN of its size) and is cut with an ellipsis only past the hard
// width. An NPC has two: its name and, under it, smaller and paler, what it does
// ("Tilde Varga" / "Provisiones": the role text of data/npcs, @rpg/content-schema
// npcRoleKey). Neither is ever cut: the name shrinks, the role wraps onto a second line
// by its words (wrapRole); make validate keeps both short enough for that.
//
// Crowding (T5.6). At zoom 1 a tile is 32 px and a name is wider than that, so the names,
// guild lines and skulls of creatures side by side overlap. The rule, in priority order
// (own creature, target, then nearest first): place a label where it fits; if it overlaps
// one already placed, drop its guild line, then lift it above the other one (at most one
// line); if it still overlaps, only the ones next to the player stay (on top), the rest
// hide. What counts is how big the labels are next to a tile: every label shows untouched
// only when a name is at most a quarter of a tile tall (labelsFull).
import { SHRINK_MIN, linePitch } from "./label-style.ts";

/** A tile is at least this many name heights tall when every label shows untouched. */
export const LABEL_FULL_TILE = 4;

/** Whether labels of `fontPx` show untouched on tiles of `tilePx` (both device px). */
export const labelsFull = (tilePx: number, fontPx: number): boolean =>
  tilePx >= LABEL_FULL_TILE * Math.max(1, fontPx);
/** The hard width of a line, in font sizes: roomy when labelsFull, tight when crowded. */
export const MAX_WIDTH_FULL = 12;
export const MAX_WIDTH_CROWDED = 7.5;
/** Creatures this close (tiles, Chebyshev) keep their label even when it overlaps. */
export const NEAR_TILES = 1;
/** Lines of an NPC's role at most. */
export const ROLE_LINES = 2;

/** The widest a line of a label may be, device px. */
export const labelMaxWidth = (tilePx: number, fontPx: number): number =>
  Math.round(fontPx * (labelsFull(tilePx, fontPx) ? MAX_WIDTH_FULL : MAX_WIDTH_CROWDED));

/** Width of `text` set at `fontPx` (the canvas measures it; the tests inject one). */
export type MeasureLine = (text: string, fontPx: number) => number;

export interface FittedLine {
  text: string;
  /** The size to draw it at: `fontPx`, or less for a long line. */
  fontPx: number;
}

/**
 * A name on one line of at most `maxWidth`: as it is when it fits; else smaller, down to
 * SHRINK_MIN of `fontPx`; and only when that is still too wide, cut with an ellipsis at
 * the smallest size. With `cut` false (an NPC) it is never cut: it keeps the smallest size.
 */
export function fitName(
  name: string,
  fontPx: number,
  maxWidth: number,
  measure: MeasureLine,
  cut = true,
): FittedLine {
  if (measure(name, fontPx) <= maxWidth) return { text: name, fontPx };
  const min = Math.max(1, Math.ceil(fontPx * SHRINK_MIN));
  for (let px = fontPx - 1; px >= min; px--)
    if (measure(name, px) <= maxWidth) return { text: name, fontPx: px };
  if (!cut) return { text: name, fontPx: min };
  const chars = [...name];
  for (let n = chars.length - 1; n >= 1; n--) {
    const text = `${chars.slice(0, n).join("").trimEnd()}…`;
    if (measure(text, min) <= maxWidth) return { text, fontPx: min };
  }
  return { text: `${chars[0] ?? ""}…`, fontPx: min };
}

export interface WrappedRole {
  /** One or two lines (more only for a text make validate would refuse). */
  lines: string[];
  fontPx: number;
}

function wrapWords(words: readonly string[], px: number, max: number, m: MeasureLine): string[] {
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line === "" ? w : `${line} ${w}`;
    if (line !== "" && m(next, px) > max) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * What an NPC does, under its name: on one line when it fits in `maxWidth`, else wrapped by
 * its words onto ROLE_LINES lines, shrinking down to SHRINK_MIN if that takes it. Never
 * cut and never with an ellipsis: a text too long even so keeps every word, on more lines.
 */
export function wrapRole(
  role: string,
  fontPx: number,
  maxWidth: number,
  measure: MeasureLine,
): WrappedRole {
  const words = role.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return { lines: [], fontPx };
  const min = Math.max(1, Math.ceil(fontPx * SHRINK_MIN));
  let last: string[] = [];
  for (let px = fontPx; px >= min; px--) {
    last = wrapWords(words, px, maxWidth, measure);
    if (last.length <= ROLE_LINES && last.every((l) => measure(l, px) <= maxWidth))
      return { lines: last, fontPx: px };
  }
  return { lines: last, fontPx: min };
}

/** The lines of one label, top to bottom, each with the size it is drawn at. */
export interface LabelLines {
  /** The name's size. */
  name: number;
  /** The role's size and how many lines it takes (0: no role). */
  role: number;
  roleLines: number;
  /** The guild line's size (0: none shown). */
  guild: number;
}

export interface LabelStack {
  /** Bottom edge of the name, of the role block and of the guild line, device px. */
  name: number;
  role: number;
  guild: number;
  /** Top of the whole block: a speech bubble sits right above it. */
  top: number;
}

/** Height of a label's name and role lines together (LabelBox.nameHeight). */
export const nameBlockHeight = (l: LabelLines): number =>
  linePitch(l.name) + l.roleLines * linePitch(l.role);

/**
 * Stacks a label up from `bottom` (just over the health bar): the guild line lowest, the
 * role over it and the name on top, each a line pitch of its own size tall.
 */
export function stackLabel(bottom: number, l: LabelLines): LabelStack {
  const guild = bottom;
  const role = guild - (l.guild > 0 ? linePitch(l.guild) : 0);
  const name = role - l.roleLines * linePitch(l.role);
  return { name, role, guild, top: name - linePitch(l.name) };
}

/**
 * One creature's label block: its name (and an NPC's role under it), the guild line under
 * them and the skull left of the name.
 */
export interface LabelBox {
  id: number;
  /** Centre of the block's bottom edge, screen px (where the label is anchored now). */
  x: number;
  y: number;
  /** Width of the widest line, skull included, px. */
  width: number;
  /** Height of the name line and of the role lines under it (nameBlockHeight), px. */
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
 * Where each label goes this frame (keyed by creature id), for names of `fontPx` on tiles
 * of `tilePx` (device px).
 */
export function placeLabels(
  boxes: readonly LabelBox[],
  tilePx: number,
  fontPx: number,
): Map<number, LabelPlacement> {
  const out = new Map<number, LabelPlacement>();
  const gap = Math.max(1, Math.round(fontPx / 11));
  if (labelsFull(tilePx, fontPx)) {
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
