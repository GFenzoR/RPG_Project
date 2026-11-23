import type { Translate } from "../i18n.ts";
import type { PaletteItem, WireDiagnostic } from "../io/wire.ts";

/** "error testisle/island.yaml:5 (1056,1056,7) temple is not on a walkable tile" */
export function formatDiagnosticShort(d: WireDiagnostic): string {
  const file = d.file.replace(/^world\/islands\//, "");
  const where = d.line === undefined ? file : `${file}:${d.line}`;
  const pos = d.pos ? ` (${d.pos.x},${d.pos.y},${d.pos.z})` : "";
  return `${where}${pos} ${d.message}`;
}

/**
 * What a door or a key is, for the palette and the tile info ("door locked with key
 * forge_gate"; docs/02 "Puertas con llave"), or undefined for any other item. The lock is
 * part of the item type (data/items), so the editor only shows it.
 */
export function doorNote(item: PaletteItem | undefined, t: Translate): string | undefined {
  if (item?.door === "closed") {
    return item.lock ? t("editor.door_locked", { key: item.lock }) : t("editor.door_closed");
  }
  if (item?.door === "open") return t("editor.door_open");
  if (item?.key) return t("editor.key_item", { key: item.key });
  const l = item?.living;
  if (l?.kind === "breakable")
    return t("editor.living_breakable", { by: (l.by ?? []).join(", "), hp: l.hp ?? 0 });
  if (l?.kind === "plate") return t("editor.living_plate", { radius: l.radius ?? 0 });
  if (l) return t(`editor.living_${l.kind}`);
  return undefined;
}

/**
 * What the living world makes of an item (livingworld/README.md): a ground's surface
 * ("surface: sand") or a plant's reaction, or undefined.
 */
export function livingNote(item: PaletteItem | undefined, t: Translate): string | undefined {
  if (item?.surface) return t("editor.surface", { surface: item.surface });
  if (item?.plant === "bend") return t("editor.plant_bend");
  if (item?.plant === "rustle") return t("editor.plant_rustle");
  return undefined;
}

/** The palette's and the tile info's note on an item: a door or key, else the living world's. */
export function itemNote(item: PaletteItem | undefined, t: Translate): string | undefined {
  return doorNote(item, t) ?? livingNote(item, t);
}
