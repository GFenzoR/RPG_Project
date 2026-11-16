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
  return undefined;
}
