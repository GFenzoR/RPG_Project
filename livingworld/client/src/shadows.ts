// What casts a shadow under the sun and the moon (livingworld/README.md "Día y noche",
// data/livingworld/shadows.yaml): every map object with height. The file names the rule, not
// the objects: a default by the item's kind (data/items `kind`), then by family (a word of
// the item's id: a new barrel or sign casts with nothing written), then one item's own word.
// Pure and free of Pixi: the client's Vite plugin resolves each item's shadow at build time
// (client/vite/content.ts) and the canvas draws it (client/src/render/object-shadows.ts).

/**
 * How an object casts: `silhouette`, its own drawing laid on the ground from its base (a
 * tree, a barrel, a sign); `block`, the box that fills its tile, so a row of them makes one
 * continuous shadow (walls, gates).
 */
export type ShadowCastKind = "silhouette" | "block";

/** The shadow of one map object. */
export interface ObjectShadow {
  cast: ShadowCastKind;
  /**
   * silhouette: the share of the full length it is drawn at (1 by default; a body lying on
   * the ground is as wide as a standing one is tall, and casts a short shadow).
   */
  length: number;
  /** block: how high the box is, sprite px; absent: what its drawing rises over its tile. */
  height?: number;
}

/** data/livingworld/shadows.yaml as the client uses it; null: it casts none. */
export interface ShadowRules {
  kinds: Readonly<Record<string, ObjectShadow | null>>;
  families: Readonly<Record<string, ObjectShadow | null>>;
  items: Readonly<Record<string, ObjectShadow | null>>;
}

/** What shadowOf reads of an item of data/items. */
export interface ShadowItem {
  id: string;
  kind: string;
  /** It stands on the map (pickupable: false, or a wall): only those cast by kind or family. */
  fixed: boolean;
}

export const SHADOW_CASTS = ["none", "silhouette", "block"] as const;
/** The shortest and the longest `length` of a silhouette. */
export const MIN_SHADOW_LENGTH = 0.1;
export const MAX_SHADOW_LENGTH = 1.5;
/** The highest `height` of a block, sprite px. */
export const MAX_BLOCK_HEIGHT = 96;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One entry of the file: a cast's name, or { cast, length, height }. Undefined: malformed. */
export function parseObjectShadow(raw: unknown): ObjectShadow | null | undefined {
  const cast = isObj(raw) ? raw["cast"] : raw;
  if (cast === "none") return null;
  if (cast !== "silhouette" && cast !== "block") return undefined;
  const out: ObjectShadow = { cast, length: 1 };
  if (isObj(raw)) {
    const length = raw["length"];
    if (typeof length === "number" && Number.isFinite(length))
      out.length = Math.min(MAX_SHADOW_LENGTH, Math.max(MIN_SHADOW_LENGTH, length));
    const height = raw["height"];
    if (typeof height === "number" && height > 0)
      out.height = Math.min(MAX_BLOCK_HEIGHT, Math.round(height));
  }
  return out;
}

/**
 * The client's view of data/livingworld/shadows.yaml (already parsed YAML), or undefined
 * without the file. Lenient: make validate checks the schema; a malformed entry is skipped.
 */
export function parseShadows(raw: unknown): ShadowRules | undefined {
  if (!isObj(raw)) return undefined;
  const table = (v: unknown): Record<string, ObjectShadow | null> => {
    const out: Record<string, ObjectShadow | null> = {};
    if (!isObj(v)) return out;
    for (const [key, entry] of Object.entries(v)) {
      const s = parseObjectShadow(entry);
      if (s !== undefined) out[key] = s;
    }
    return out;
  };
  return {
    kinds: table(raw["kinds"]),
    families: table(raw["families"]),
    items: table(raw["items"]),
  };
}

/**
 * The families of `rules` an item id belongs to, in the order of its words: the id split at
 * "_", each word as written or without its plural "s" (stacked_crates has "crate").
 */
export function shadowFamilies(families: Readonly<Record<string, unknown>>, id: string): string[] {
  const out: string[] = [];
  for (const word of id.split("_")) {
    // Own keys only: "constructor" in {} is true, and no id word is a family for that.
    const hit = [word, word.replace(/s$/, "")].find(
      (w) => w.length > 0 && Object.hasOwn(families, w),
    );
    if (hit !== undefined && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * The shadow `item` casts, or undefined for none: its own entry in `items`; else, for an
 * object that stands on the map, its first family's, else its kind's. A loose item (one a
 * player can pick up) lies flat on the ground and casts none unless `items` names it.
 */
export function shadowOf(rules: ShadowRules, item: ShadowItem): ObjectShadow | undefined {
  if (Object.hasOwn(rules.items, item.id)) return rules.items[item.id] ?? undefined;
  if (!item.fixed) return undefined;
  const family = shadowFamilies(rules.families, item.id)[0];
  if (family !== undefined) return rules.families[family] ?? undefined;
  return Object.hasOwn(rules.kinds, item.kind) ? (rules.kinds[item.kind] ?? undefined) : undefined;
}
