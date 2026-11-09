// JSON Schemas for world/ files (schemas/*.schema.json): structure only; the rules that
// need the whole world (references, walkability, connectivity) live in validate.ts.
import { readFileSync, readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv/dist/2020.js";
import type { PathSegment } from "./diagnostics.ts";

export const SCHEMA_DIR = new URL("../schemas/", import.meta.url);
const SCHEMA_BASE = "https://rpg-project.local/map-schemas/";

export type MapSchemaName =
  | "chunk"
  | "world"
  | "island"
  | "spawns"
  | "npcs"
  | "zones"
  | "portals"
  | "texts"
  | "houses"
  | "prefab";

export interface SchemaError {
  path: PathSegment[];
  message: string;
}

let ajv: Ajv2020 | undefined;
const validators = new Map<MapSchemaName, ValidateFunction>();

function compiled(name: MapSchemaName): ValidateFunction {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const file of readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith(".schema.json"))
      .sort()) {
      ajv.addSchema(JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), "utf8")) as object);
    }
  }
  let fn = validators.get(name);
  if (!fn) {
    const found = ajv.getSchema(`${SCHEMA_BASE}${name}.schema.json`);
    if (!found) throw new Error(`map schema "${name}" not found in ${SCHEMA_DIR.pathname}`);
    fn = found;
    validators.set(name, fn);
  }
  return fn;
}

/** Validates data against a schema; returns at most one error per instance path. */
export function checkSchema(name: MapSchemaName, data: unknown): SchemaError[] {
  const fn = compiled(name);
  if (fn(data)) return [];
  const seen = new Set<string>();
  const out: SchemaError[] = [];
  for (const err of fn.errors ?? []) {
    if (seen.has(err.instancePath)) continue;
    seen.add(err.instancePath);
    let message = err.message ?? "is invalid";
    const params = err.params as Record<string, unknown>;
    if (err.keyword === "additionalProperties")
      message = `unknown field "${String(params["additionalProperty"])}"`;
    else if (err.keyword === "enum")
      message = `${message}: ${(params["allowedValues"] as unknown[]).join(", ")}`;
    out.push({ path: parsePointer(err.instancePath), message });
  }
  return out;
}

function parsePointer(pointer: string): PathSegment[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}
