// The house panel's draft (docs/04 "Casas en el editor"): the tiles, doors and exit a person
// draws on the map, plus the id, rent, notes and the name in every language. Pure functions
// from draft to draft; the controller keeps the draft in its state (the canvas draws it) and
// turns it into a house op when it is applied. The rects of houses.yaml are computed from
// the tiles (tilesToRects), so a person never types them.
import {
  MAX_HOUSE_DOORS,
  MAX_HOUSE_RECTS,
  MAX_HOUSE_SIDE,
  houseIssues,
  houseNameKey,
  houseTiles,
  rectContains,
  samePos,
  sortTiles,
  tilesToRects,
} from "@rpg/map-format/ops";
import type { House, HouseInput, HouseIssue, Position, Rect, World } from "@rpg/map-format/ops";
import type { Translate } from "../i18n.ts";
import { MAX_NAME_LENGTH, isHouseName } from "../io/wire.ts";

/** What a click on the map does to the draft with the house tool. */
export type HouseMode = "tiles" | "doors" | "exit";
export const HOUSE_MODES: readonly HouseMode[] = ["tiles", "doors", "exit"];

/** Rent of a new house (copper per period; the existing ones go from 500 to 1000). */
export const DEFAULT_RENT = 500;

/** Most tiles a draft takes: far more than any house, small enough to stay responsive. */
export const MAX_DRAFT_TILES = 4096;

export interface HouseDraft {
  /** Id of the house being edited, undefined for a new one (its id can still change). */
  key: string | undefined;
  id: string;
  rent: number;
  notes: string;
  /** Sorted by floor, row and column, each once. */
  tiles: Position[];
  doors: Position[];
  exit: Position | undefined;
  /** Name in each language (house.<id>.name of i18n/<lang>/world.yaml). */
  names: Record<string, string>;
}

/** A problem of the draft: one of houseIssues, or a missing or invalid name. */
export type DraftIssue = HouseIssue | { code: "name"; severity: "error"; lang: string };

const copyPos = (p: Position): Position => ({ x: p.x, y: p.y, z: p.z });

/** Draft of an existing house, with its names. */
export function draftOf(h: House, names: Record<string, string>): HouseDraft {
  return {
    key: h.id,
    id: h.id,
    rent: h.rent,
    notes: h.notes ?? "",
    tiles: houseTiles(h.rects),
    doors: h.doors.map(copyPos),
    exit: copyPos(h.exit),
    names: { ...names },
  };
}

/** A first free id for a house of `island`: <island>_house_<n>. */
export function newHouseId(world: World, island: string): string {
  const used = new Set<string>();
  for (const isl of world.islands.values()) for (const h of isl.houses) used.add(h.id);
  let n = 1;
  while (used.has(`${island}_house_${n}`)) n++;
  return `${island}_house_${n}`;
}

/** An empty draft for a new house of `island`. */
export function newDraft(world: World, island: string, languages: readonly string[]): HouseDraft {
  return {
    key: undefined,
    id: newHouseId(world, island),
    rent: DEFAULT_RENT,
    notes: "",
    tiles: [],
    doors: [],
    exit: undefined,
    names: Object.fromEntries(languages.map((l) => [l, ""])),
  };
}

const has = (list: readonly Position[], p: Position): boolean => list.some((q) => samePos(q, p));

/**
 * Adds the tiles of `rect` on floor z that `keep` accepts (inside an island), or removes
 * them with `remove`; a door on a removed tile goes too. Returns the same draft when nothing
 * changes, or undefined when the draft would pass MAX_DRAFT_TILES.
 */
export function paintTiles(
  d: HouseDraft,
  rect: Rect,
  z: number,
  remove: boolean,
  keep: (p: Position) => boolean = () => true,
): HouseDraft | undefined {
  if (remove) {
    const out = (p: Position): boolean => p.z === z && rectContains(rect, p.x, p.y);
    const tiles = d.tiles.filter((p) => !out(p));
    if (tiles.length === d.tiles.length) return d;
    return { ...d, tiles, doors: d.doors.filter((p) => !out(p)) };
  }
  if (rect.w * rect.h > MAX_DRAFT_TILES) return undefined;
  const added: Position[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const p = { x, y, z };
      if (keep(p)) added.push(p);
    }
  const tiles = sortTiles([...d.tiles, ...added]);
  if (tiles.length === d.tiles.length) return d;
  if (tiles.length > MAX_DRAFT_TILES) return undefined;
  return { ...d, tiles };
}

/** Puts a door on tile p, or takes it away if there is one (`remove`: only takes away). */
export function toggleDoor(d: HouseDraft, p: Position, remove = false): HouseDraft {
  if (has(d.doors, p)) return { ...d, doors: d.doors.filter((q) => !samePos(q, p)) };
  if (remove) return d;
  return { ...d, doors: [...d.doors, copyPos(p)] };
}

/** Sets the exit (undefined clears it). */
export function setExit(d: HouseDraft, p: Position | undefined): HouseDraft {
  return { ...d, exit: p && copyPos(p) };
}

/** The house the draft describes, with the rects computed from its tiles. */
export function draftHouse(d: HouseDraft): HouseInput {
  const h: HouseInput = {
    id: d.id,
    name: houseNameKey(d.id),
    rent: d.rent,
    rects: tilesToRects(d.tiles),
    doors: d.doors.map(copyPos),
    exit: d.exit && copyPos(d.exit),
  };
  const notes = d.notes.trim();
  if (notes !== "") h.notes = notes;
  return h;
}

/** Everything wrong with the draft: the house checks plus a valid name in every language. */
export function draftIssues(
  world: World,
  d: HouseDraft,
  languages: readonly string[],
): DraftIssue[] {
  const out: DraftIssue[] = houseIssues(
    world,
    draftHouse(d),
    d.key === undefined ? {} : { replacing: d.key },
  );
  for (const lang of languages)
    if (!isHouseName(d.names[lang] ?? "")) out.push({ code: "name", severity: "error", lang });
  return out;
}

/** Limits some issues talk about. */
const MAX: Partial<Record<DraftIssue["code"], number>> = {
  too_many_rects: MAX_HOUSE_RECTS,
  rect_too_big: MAX_HOUSE_SIDE,
  too_many_doors: MAX_HOUSE_DOORS,
  name: MAX_NAME_LENGTH,
};

/** The issue in the editor's language (editor.house.err.<code>). */
export function issueText(t: Translate, i: DraftIssue): string {
  const params: Record<string, string | number> = { max: MAX[i.code] ?? 0 };
  if ("pos" in i && i.pos) Object.assign(params, i.pos);
  if ("other" in i && i.other !== undefined) params["other"] = i.other;
  if ("lang" in i) params["lang"] = i.lang;
  return t(`editor.house.err.${i.code}`, params);
}

/** Tile to centre the camera on for a house: the middle of its first rect. */
export function housePos(h: Pick<House, "rects">): Position | undefined {
  const r = h.rects[0];
  return r && { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2), z: r.z };
}
