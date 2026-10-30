// Compiles the JSON Schemas in ../schemas with two project keywords:
//   x-ref: "<kind>"  the string is an ID that must exist (checked after loading everything)
//   x-i18n: true     the string is a translation key that must exist in every language
import { readFileSync, readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import type { PathSegment } from "./source.ts";

export const SCHEMA_DIR = new URL("../schemas/", import.meta.url);
const SCHEMA_BASE = "https://rpg-project.local/schemas/";

export type RefKind = "item" | "monster" | "npc" | "quest" | "vocation" | "spell" | "shop";

export type SchemaName =
  | "balance"
  | "vocations"
  | "items"
  | "monster"
  | "npc"
  | "quest"
  | "spells"
  | "recipes"
  | "borders"
  | "i18n"
  | "ids-lock";

export interface Usage {
  path: PathSegment[];
  value: string;
}

export interface Collected {
  refs: (Usage & { kind: RefKind })[];
  i18nKeys: Usage[];
}

export interface SchemaResult extends Collected {
  errors: { path: PathSegment[]; message: string }[];
}

export class SchemaSet {
  private readonly ajv: Ajv2020;
  private readonly validators = new Map<SchemaName, ValidateFunction>();
  private collected: Collected = { refs: [], i18nKeys: [] };

  constructor() {
    this.ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
    this.ajv.addKeyword({
      keyword: "x-ref",
      schemaType: "string",
      validate: (
        kind: RefKind,
        data: unknown,
        _parent: unknown,
        cxt?: { instancePath: string },
      ) => {
        if (typeof data === "string" && cxt) {
          this.collected.refs.push({ kind, value: data, path: parsePointer(cxt.instancePath) });
        }
        return true;
      },
    });
    this.ajv.addKeyword({
      keyword: "x-i18n",
      schemaType: "boolean",
      validate: (on: boolean, data: unknown, _parent: unknown, cxt?: { instancePath: string }) => {
        if (on && typeof data === "string" && cxt) {
          this.collected.i18nKeys.push({ value: data, path: parsePointer(cxt.instancePath) });
        }
        return true;
      },
    });
    for (const file of readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith(".schema.json"))
      .sort()) {
      this.ajv.addSchema(JSON.parse(readFileSync(new URL(file, SCHEMA_DIR), "utf8")) as object);
    }
  }

  validate(name: SchemaName, data: unknown): SchemaResult {
    let fn = this.validators.get(name);
    if (!fn) {
      fn = this.ajv.getSchema(`${SCHEMA_BASE}${name}.schema.json`);
      if (!fn) throw new Error(`content-schema: missing schema ${name}`);
      this.validators.set(name, fn);
    }
    this.collected = { refs: [], i18nKeys: [] };
    const ok = fn(data);
    const result: SchemaResult = {
      errors: ok ? [] : summarizeErrors(fn.errors ?? []),
      // Keywords also run inside anyOf branches that failed; keep one entry per location.
      refs: dedupe(this.collected.refs, (r) => `${r.kind}|${r.path.join("/")}`),
      i18nKeys: dedupe(this.collected.i18nKeys, (k) => k.path.join("/")),
    };
    return result;
  }
}

function dedupe<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parsePointer(pointer: string): PathSegment[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/**
 * Turns raw Ajv errors into one readable message per problem. anyOf failures report
 * every branch; we keep only errors below the anyOf location (the branch that matched
 * the shape) and fall back to a single "none of the accepted forms" message.
 */
function summarizeErrors(errors: ErrorObject[]): { path: PathSegment[]; message: string }[] {
  const anyOfPaths = new Set(
    errors.filter((e) => e.keyword === "anyOf" || e.keyword === "oneOf").map((e) => e.instancePath),
  );
  const out = new Map<string, { path: PathSegment[]; message: string }>();
  for (const e of errors) {
    if (e.keyword === "if") continue;
    const at = e.instancePath;
    const isBranchNoise = e.keyword !== "anyOf" && e.keyword !== "oneOf" && anyOfPaths.has(at);
    if (isBranchNoise) continue;
    if (e.keyword === "anyOf" || e.keyword === "oneOf") {
      const deeper = errors.some(
        (o) => o.instancePath.startsWith(`${at}/`) && o.keyword !== "if" && o.keyword !== "anyOf",
      );
      if (deeper) continue;
    }
    let path = parsePointer(at);
    let message = describe(e);
    if (e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties") {
      const params = e.params as { additionalProperty?: string; unevaluatedProperty?: string };
      const prop = String(params.additionalProperty ?? params.unevaluatedProperty);
      path = [...path, prop];
      message = `unknown field "${prop}"`;
    }
    out.set(`${path.join("/")}|${message}`, { path, message });
  }
  return [...out.values()];
}

function describe(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return `missing required field "${String(p["missingProperty"])}"`;
    case "enum":
      return `must be one of: ${(p["allowedValues"] as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "const":
      return `must be ${JSON.stringify(p["allowedValue"])}`;
    case "pattern":
      return `must match ${String(p["pattern"])} (snake_case ids, dotted i18n keys)`;
    case "minProperties":
      return p["limit"] === 1 ? "must not be empty" : (e.message ?? e.keyword);
    case "maxProperties":
      return p["limit"] === 1 ? "must have exactly one key" : (e.message ?? e.keyword);
    case "anyOf":
    case "oneOf":
      return "does not match any of the accepted forms (see docs/06-content-data.md)";
    case "propertyNames":
      return `invalid key ${JSON.stringify(p["propertyName"])}`;
    default:
      return e.message ?? e.keyword;
  }
}
