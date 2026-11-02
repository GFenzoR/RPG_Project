// Prefab files (world/prefabs/<id>.yaml) on disk: canonical text and the checks that need
// content. The model and the stamp op are in ops/ (browser-safe).
//
// Canonical form (written by `mapcli fmt`): keys id, notes, legend, rows; one legend entry
// per line in flow style; one row per line, double-quoted so spaces stay visible.
import type { ContentIndex } from "./content.ts";
import type { Prefab } from "./ops/prefab.ts";

export const PREFAB_DIR = "world/prefabs";

const q = (s: string): string => JSON.stringify(s);
const PLAIN = /^[a-z][a-z0-9_]*$/;
const id = (s: string): string => (PLAIN.test(s) ? s : q(s));

export function formatPrefab(p: Prefab): string {
  const out = [`id: ${id(p.id)}`];
  if (p.notes !== undefined) out.push(`notes: ${q(p.notes)}`);
  out.push("legend:");
  for (const e of p.legend) {
    const parts = [`char: ${q(e.char)}`];
    if (e.ground !== undefined) parts.push(`ground: ${id(e.ground)}`);
    if (e.items !== undefined) parts.push(`items: [${e.items.map(id).join(", ")}]`);
    out.push(`  - { ${parts.join(", ")} }`);
  }
  out.push("rows:");
  for (const r of p.rows) out.push(`  - ${q(r)}`);
  return `${out.join("\n")}\n`;
}

export interface PrefabProblem {
  path: (string | number)[];
  message: string;
}

/** Rules beyond the schema: legend and rows agree, items exist and fit their layer. */
export function checkPrefab(p: Prefab, content: ContentIndex): PrefabProblem[] {
  const out: PrefabProblem[] = [];
  const chars = new Set<string>();
  p.legend.forEach((e, i) => {
    if (chars.has(e.char))
      out.push({ path: ["legend", i, "char"], message: `"${e.char}" is defined twice` });
    chars.add(e.char);
    if (e.ground !== undefined) {
      const kind = content.items.get(e.ground)?.kind;
      if (kind === undefined)
        out.push({ path: ["legend", i, "ground"], message: `unknown item "${e.ground}"` });
      else if (kind !== "ground")
        out.push({
          path: ["legend", i, "ground"],
          message: `"${e.ground}" is a ${kind}, not a ground item`,
        });
    }
    (e.items ?? []).forEach((item, j) => {
      const kind = content.items.get(item)?.kind;
      if (kind === undefined)
        out.push({ path: ["legend", i, "items", j], message: `unknown item "${item}"` });
      else if (kind === "ground")
        out.push({
          path: ["legend", i, "items", j],
          message: `ground item "${item}" belongs in "ground"`,
        });
    });
  });
  p.rows.forEach((row, y) => {
    const unknown = [...new Set([...row].filter((ch) => ch !== " " && !chars.has(ch)))];
    if (unknown.length > 0)
      out.push({
        path: ["rows", y],
        message: `uses ${unknown.map(q).join(", ")}, not in the legend`,
      });
  });
  return out;
}
