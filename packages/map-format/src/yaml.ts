// Canonical YAML for island.yaml, world.yaml and the auxiliary files. Like chunks, these
// are machine-written (editor, mapcli, MCP), so the writer fixes the layout:
//   - keys in KEY_ORDER, unknown keys after it alphabetically
//   - maps/lists whose values are all scalars go in flow style: { x: 1, y: 2, z: 7 }
//   - top-level list entries are separated by a blank line
//   - plain strings when unambiguous, JSON double quotes otherwise
// Comments are not preserved: use the `notes` field instead.
import { LineCounter, parseDocument } from "yaml";
import { Reporter } from "./diagnostics.ts";
import type { Diagnostic, PathSegment } from "./diagnostics.ts";

const KEY_ORDER = [
  "format",
  "id",
  "npc",
  "name",
  "type",
  "kind",
  "from_npc",
  "island",
  "rect",
  "floors",
  "temple",
  "center",
  "radius",
  "monster",
  "monsters",
  "count",
  "respawn_seconds",
  "rects",
  "from",
  "to",
  "pos",
  "text",
  "level_hint",
  "price",
  "requires",
  "level",
  "islands",
  "x",
  "y",
  "z",
  "w",
  "h",
  "notes",
];
const RANK = new Map(KEY_ORDER.map((k, i) => [k, i]));

type Scalar = string | number | boolean | null;
const isScalar = (v: unknown): v is Scalar =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function sortedKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort((a, b) => {
      const ra = RANK.get(a) ?? KEY_ORDER.length;
      const rb = RANK.get(b) ?? KEY_ORDER.length;
      return ra - rb || (a < b ? -1 : a > b ? 1 : 0);
    });
}

const PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|y|n|~)$/i;

function scalar(v: Scalar): string {
  if (v === null) return "null";
  if (typeof v === "string") return PLAIN.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
  return String(v);
}

const isFlow = (v: unknown): boolean =>
  (Array.isArray(v) && v.every(isScalar)) || (isObj(v) && Object.values(v).every(isScalar));

function flow(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((e) => scalar(e as Scalar)).join(", ")}]`;
  const o = v as Record<string, unknown>;
  const keys = sortedKeys(o);
  return keys.length === 0
    ? "{}"
    : `{ ${keys.map((k) => `${k}: ${scalar(o[k] as Scalar)}`).join(", ")} }`;
}

/** Lines for a value placed after "key:" or "- " at the given indentation. */
function block(v: unknown, indent: string, out: string[], first: string): void {
  if (isScalar(v) || isFlow(v)) {
    out.push(`${first}${isScalar(v) ? scalar(v) : flow(v)}`);
    return;
  }
  if (Array.isArray(v)) {
    out.push(first.trimEnd());
    for (const e of v) block(e, `${indent}  `, out, `${indent}- `);
    return;
  }
  const o = v as Record<string, unknown>;
  const keys = sortedKeys(o);
  if (first.endsWith(": ")) {
    out.push(first.trimEnd());
    for (const k of keys) field(k, o[k], indent, out);
    return;
  }
  // List entry: the first key shares the "- " line.
  keys.forEach((k, i) => field(k, o[k], indent, out, i === 0 ? first : indent));
}

function field(k: string, v: unknown, indent: string, out: string[], prefix = indent): void {
  block(v, `${indent}  `, out, `${prefix}${k}: `);
}

export function formatYaml(data: unknown): string {
  const out: string[] = [];
  if (Array.isArray(data)) {
    if (data.length === 0) return "[]\n";
    data.forEach((e, i) => {
      if (i > 0) out.push("");
      block(e, "  ", out, "- ");
    });
  } else if (isObj(data)) {
    for (const k of sortedKeys(data)) field(k, data[k], "", out);
  } else {
    out.push(scalar(data as Scalar));
  }
  return `${out.join("\n")}\n`;
}

export interface ParsedYaml {
  data: unknown;
  /** 1-based line of the node at path (or its closest parent). */
  lineOf(path: PathSegment[]): number | undefined;
}

export function parseYamlText(
  text: string,
  file: string,
  diags: Diagnostic[],
): ParsedYaml | undefined {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    const r = new Reporter(diags);
    for (const err of doc.errors) {
      r.error(
        file,
        [],
        `invalid YAML: ${err.message.split("\n")[0] ?? err.code}`,
        undefined,
        lineCounter.linePos(err.pos[0]).line,
      );
    }
    return undefined;
  }
  let data: unknown;
  try {
    // toJS() throws on alias bombs ("Excessive alias count") and similar; report, never throw.
    data = doc.toJS({ maxAliasCount: 100 }) as unknown;
  } catch (err) {
    new Reporter(diags).error(
      file,
      [],
      `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  return {
    data,
    lineOf(path) {
      for (let n = path.length; n >= 0; n--) {
        const node: unknown = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);
        const range = (node as { range?: [number, number, number] } | null)?.range;
        if (range) return lineCounter.linePos(range[0]).line;
      }
      return undefined;
    },
  };
}
