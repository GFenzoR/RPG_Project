// Still pictures of the engine humanoids of data/, composed from the paper doll's layers
// with the tints of data/looks.yaml, standing:
// - each player outfit (data/outfits.yaml `sprite`/<dir>_0), its look in its clothes, one
//   per facing: the shop shows the south one;
// - each NPC that is a person (data/npcs `sprite` with a `look`), facing south: the
//   dialog's portrait.
// The client falls back to them when the layers are missing. Data drives them: a changed
// tint is a stale PNG (the committed-PNG test asks for make spritegen). They read data/ of
// the repo, or of the root the CLI is given (--root, recipes/index.ts recipesAt).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "@rpg/spritepack";
import type { Recipe, RecipeBook } from "../../../recipe.ts";
import type { Look, LookTables, Worn } from "./compose.ts";
import { composeFrame } from "./compose.ts";

/** The repo this tool lives in: where data/ is unless the CLI says another root. */
export const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));

/** A content file: YAML, as tools/spritepack reads data/ (anything else there is not data). */
const isYaml = (file: string): boolean => /\.ya?ml$/.test(file);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hex = (v: unknown): number =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? parseInt(v.slice(1), 16) : 0xffffff;

/** data/looks.yaml as the paper doll's tables (packages/renderer look.ts LookTables). */
export function lookTables(looks: unknown): LookTables {
  const l = isObj(looks) ? looks : {};
  const colors = (v: unknown): Record<string, number> =>
    Object.fromEntries(
      Object.entries(isObj(v) ? v : {}).map(([k, c]) => [k, hex(isObj(c) ? c["color"] : c)]),
    );
  const hides = isObj(l["hides"]) ? l["hides"] : {};
  return {
    skins: colors(l["skins"]),
    hairColors: colors(l["hair_colors"]),
    tints: colors(l["tints"]),
    hides: Object.fromEntries(
      Object.entries(hides).map(([k, v]) => [k, Array.isArray(v) ? (v as never[]) : []]),
    ),
  };
}

/** A data/ look (snake_case) as a Look. */
export function lookOf(v: unknown): Look {
  const l = isObj(v) ? v : {};
  const s = (k: string): string => (typeof l[k] === "string" ? (l[k] as string) : "");
  return {
    sex: s("sex"),
    body: s("body"),
    skin: s("skin"),
    hair: s("hair"),
    hairColor: s("hair_color"),
    beard: s("beard"),
  };
}

/** A data/ worn set (head, torso, ... -> {shape, tint}). */
export function wornOf(v: unknown): Worn {
  const out: Worn = {};
  for (const [slot, p] of Object.entries(isObj(v) ? v : {}))
    if (isObj(p) && typeof p["shape"] === "string" && typeof p["tint"] === "string")
      out[slot as keyof Worn] = { shape: p["shape"], tint: p["tint"] };
  return out;
}

const still = (look: Look, worn: Worn, tables: LookTables, dir: "n" | "e" | "s" | "w"): Recipe => ({
  kind: "creature",
  width: 64,
  height: 64,
  shadow: false,
  draw: (img) => img.data.set(composeFrame(look, worn, tables, "idle", dir, 0).data),
});

/**
 * One recipe per outfit and facing (<sprite>/<dir>_0) and per NPC person (<sprite>), from
 * data/ under `root`.
 */
export function lookPreviews(root: string = REPO_ROOT): RecipeBook {
  const read = (file: string): unknown => parseYaml(readFileSync(join(root, file), "utf8"));
  const tables = lookTables(read("data/looks.yaml"));
  const outfits = read("data/outfits.yaml");
  const book: RecipeBook = {};
  for (const o of Array.isArray(outfits) ? outfits : []) {
    if (!isObj(o) || typeof o["sprite"] !== "string") continue;
    const look = lookOf(o["look"]);
    const worn = wornOf(o["clothes"]);
    for (const dir of ["n", "e", "s", "w"] as const)
      book[`${o["sprite"]}/${dir}_0`] = still(look, worn, tables, dir);
  }
  const npcs = join(root, "data", "npcs");
  for (const file of readdirSync(npcs).filter(isYaml).sort()) {
    const n = parseYaml(readFileSync(join(npcs, file), "utf8"));
    if (!isObj(n) || typeof n["sprite"] !== "string" || !isObj(n["look"])) continue;
    book[n["sprite"]] = still(lookOf(n["look"]), wornOf(n["look"]["worn"]), tables, "s");
  }
  return book;
}
