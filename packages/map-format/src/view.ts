// ASCII view of an area for humans and AIs (docs/04, "Vista ASCII"): one character per
// tile, legend generated from what is visible. Markers (temple, spawns, NPCs, portals,
// texts) win over the top item of the stack, which wins over the ground.
import { TileMap } from "./tiles.ts";
import { MAX_COORD, MAX_FLOOR, rectContains } from "./types.ts";
import type { Island, Rect } from "./types.ts";

export const MAX_VIEW_SIZE = 64;

/** Preferred characters; anything else gets its initial or a free symbol. */
const PREFERRED: Record<string, string> = {
  grass: ".",
  sand: ",",
  dirt: ":",
  stone_floor: "_",
  water_shallow: "~",
};
const MARKERS = {
  temple: "@",
  spawn: "M",
  npc: "N",
  portalDown: ">",
  portalUp: "<",
  portal: "O",
  text: "?",
} as const;
const EMPTY = " ";
const POOL = "#%&*+=^!$;|/0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface ViewMarker {
  x: number;
  y: number;
  char: string;
  what: string;
}

export interface AsciiView {
  island: string;
  floor: number;
  area: Rect;
  /** Character → item ID, marker category ("temple", "spawn"...) or "(no tile)". */
  legend: Record<string, string>;
  /** One string per row, area.w characters each, starting at area.y. */
  rows: string[];
  /** Each marker in the area with its details, in row order. */
  markers: ViewMarker[];
}

interface Marker {
  char: string;
  category: string;
  what: string;
}

export function viewArea(island: Island, floor: number, area: Rect): AsciiView {
  if (area.w > MAX_VIEW_SIZE || area.h > MAX_VIEW_SIZE)
    throw new RangeError(`view area is limited to ${MAX_VIEW_SIZE}x${MAX_VIEW_SIZE} tiles`);
  const ints = [area.x, area.y, area.w, area.h].every(Number.isSafeInteger);
  if (!ints || area.x < 0 || area.y < 0 || area.w < 1 || area.h < 1)
    throw new RangeError("view area needs integer x,y >= 0 and w,h >= 1");
  if (area.x + area.w > MAX_COORD + 1 || area.y + area.h > MAX_COORD + 1)
    throw new RangeError(`view area leaves the world (coordinates go up to ${MAX_COORD})`);
  if (!Number.isInteger(floor) || floor < 0 || floor > MAX_FLOOR)
    throw new RangeError(`floor must be an integer 0..${MAX_FLOOR}`);
  const tiles = new TileMap([island]);
  const legend = new Map<string, string>();
  const itemChars = new Map<string, string>();
  const reserved = new Set<string>([EMPTY, ...Object.values(MARKERS)]);
  const charForItem = (id: string): string => {
    const known = itemChars.get(id);
    if (known) return known;
    const candidates = [PREFERRED[id], id[0], id[0]?.toUpperCase(), ...POOL];
    const ch = candidates.find((c) => c !== undefined && !legend.has(c) && !reserved.has(c)) ?? "?";
    legend.set(ch, id);
    itemChars.set(id, ch);
    return ch;
  };

  const markers = new Map<string, Marker>();
  const mark = (x: number, y: number, z: number, m: Marker): void => {
    const k = `${x},${y}`;
    if (z === floor && rectContains(area, x, y) && !markers.has(k)) markers.set(k, m);
  };
  const t = island.meta.temple;
  mark(t.x, t.y, t.z, { char: MARKERS.temple, category: "temple", what: "temple" });
  for (const n of island.npcs)
    mark(n.pos.x, n.pos.y, n.pos.z, { char: MARKERS.npc, category: "npc", what: `npc ${n.npc}` });
  for (const s of island.spawns) {
    const monsters = s.monsters.map((m) => `${m.count} ${m.monster}`).join(", ");
    mark(s.center.x, s.center.y, s.center.z, {
      char: MARKERS.spawn,
      category: "spawn",
      what: `spawn ${s.id}: ${monsters}, radius ${s.radius}`,
    });
  }
  for (const p of island.portals) {
    const [char, category] =
      p.to.z > p.from.z
        ? [MARKERS.portalDown, "portal down"]
        : p.to.z < p.from.z
          ? [MARKERS.portalUp, "portal up"]
          : [MARKERS.portal, "portal"];
    const what = `${p.kind} ${p.id} to ${p.to.x},${p.to.y},${p.to.z}`;
    mark(p.from.x, p.from.y, p.from.z, { char, category, what });
  }
  for (const tx of island.texts)
    mark(tx.pos.x, tx.pos.y, tx.pos.z, {
      char: MARKERS.text,
      category: "text",
      what: `${tx.kind} ${tx.id}: ${tx.text}`,
    });

  const rows: string[] = [];
  const listed: ViewMarker[] = [];
  for (let y = area.y; y < area.y + area.h; y++) {
    let row = "";
    for (let x = area.x; x < area.x + area.w; x++) {
      const m = markers.get(`${x},${y}`);
      if (m) {
        legend.set(m.char, m.category);
        listed.push({ x, y, char: m.char, what: m.what });
        row += m.char;
        continue;
      }
      const tile = tiles.tile(x, y, floor);
      const top = tile?.stack[tile.stack.length - 1] ?? tile?.ground ?? null;
      if (top === null) legend.set(EMPTY, "(no tile)");
      row += top === null ? EMPTY : charForItem(top);
    }
    rows.push(row);
  }
  const sorted = Object.fromEntries([...legend].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { island: island.meta.id, floor, area, legend: sorted, rows, markers: listed };
}

/** Text rendering: legend, x ruler every 10 tiles, rows prefixed with y, then markers. */
export function renderAsciiView(view: AsciiView): string {
  const legend = Object.entries(view.legend)
    .map(([ch, meaning]) => `${ch === EMPTY ? "' '" : ch} ${meaning}`)
    .join("  ");
  const yWidth = Math.max(3, String(view.area.y + view.area.h - 1).length);
  let ruler = "";
  for (let i = 0; i < view.area.w; i += 10) ruler += String(view.area.x + i).padEnd(10);
  const lines = [`legend: ${legend}`, `${"y\\x".padEnd(yWidth)} ${ruler.trimEnd()}`];
  view.rows.forEach((r, i) => lines.push(`${String(view.area.y + i).padStart(yWidth)} ${r}`));
  for (const m of view.markers) lines.push(`${m.char} ${m.x},${m.y}: ${m.what}`);
  return `${lines.join("\n")}\n`;
}
