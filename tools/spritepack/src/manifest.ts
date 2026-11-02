// assets/sprites.yaml: where the pixels of each logical sprite path come from.
import { isMap, isScalar, LineCounter, parseDocument } from "yaml";
import { parseHexColor } from "./image.ts";
import type { Rgba } from "./image.ts";
import { TILE } from "./placeholder.ts";

/** Same rule as common.schema.json#/$defs/sprite in packages/content-schema. */
export const SPRITE_PATH = /^[a-z0-9_]+(\/[a-z0-9_]+)*$/;
/** Placeholder labels use the bitmap font: up to 3 of A-Z, 0-9 (empty = no label). */
const LABEL = /^[A-Z0-9]{0,3}$/;
/** vendor/<pack>/<file>.png, relative to assets/. */
const VENDOR_SOURCE = /^vendor\/([A-Za-z0-9._-]+)\/(?:[A-Za-z0-9._ -]+\/)*[A-Za-z0-9._ -]+\.png$/;

export type SpriteEntry =
  | {
      kind: "placeholder";
      label?: string;
      color?: Rgba;
      /** Size in pixels, multiples of 32. */
      width: number;
      height: number;
    }
  | {
      kind: "source";
      /** Path relative to assets/, always under vendor/<pack>/. */
      source: string;
      pack: string;
      /** Crop rectangle in the source image; undefined = whole image. */
      rect?: { x: number; y: number; w: number; h: number };
    };

export interface Manifest {
  sprites: Map<string, SpriteEntry>;
  /** 1-based line of each sprite key, for error messages. */
  lines: Map<string, number>;
}

export interface ManifestError {
  line?: number;
  sprite?: string;
  message: string;
}

const ENTRY_KEYS = new Set(["placeholder", "source", "rect", "tile", "notes"]);
const PLACEHOLDER_KEYS = new Set(["label", "color", "size"]);

export function parseManifest(text: string): { manifest: Manifest; errors: ManifestError[] } {
  const errors: ManifestError[] = [];
  const manifest: Manifest = { sprites: new Map(), lines: new Map() };
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false });
  for (const err of doc.errors) {
    errors.push({ line: lc.linePos(err.pos[0]).line, message: `invalid YAML: ${err.code}` });
  }
  if (errors.length > 0) return { manifest, errors };

  const root = doc.toJS() as unknown;
  if (!isRecord(root))
    return { manifest, errors: [{ message: "expected a mapping at top level" }] };
  for (const key of Object.keys(root)) {
    if (key !== "sprites") errors.push({ message: `unknown top-level key "${key}"` });
  }
  const sprites = root["sprites"] ?? {};
  if (!isRecord(sprites))
    return { manifest, errors: [...errors, { message: '"sprites" must be a mapping' }] };

  const node = doc.get("sprites", true);
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.range) {
        manifest.lines.set(String(pair.key.value), lc.linePos(pair.key.range[0]).line);
      }
    }
  }

  for (const [sprite, raw] of Object.entries(sprites)) {
    const line = manifest.lines.get(sprite);
    const fail = (message: string): void => {
      errors.push({ sprite, message, ...(line === undefined ? {} : { line }) });
    };
    if (!SPRITE_PATH.test(sprite)) {
      fail("sprite path must be lowercase snake_case segments separated by /");
      continue;
    }
    const entry = parseEntry(raw, fail);
    if (entry) manifest.sprites.set(sprite, entry);
  }
  return { manifest, errors };
}

function parseEntry(raw: unknown, fail: (msg: string) => void): SpriteEntry | undefined {
  if (!isRecord(raw)) {
    fail("entry must be a mapping with either placeholder or source");
    return undefined;
  }
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) fail(`unknown key "${key}"`);
  if (raw["notes"] !== undefined && typeof raw["notes"] !== "string")
    fail("notes must be a string");
  const hasPlaceholder = raw["placeholder"] !== undefined;
  const hasSource = raw["source"] !== undefined;
  if (hasPlaceholder === hasSource) {
    fail("entry needs exactly one of placeholder or source");
    return undefined;
  }

  if (hasPlaceholder) {
    if (raw["rect"] !== undefined || raw["tile"] !== undefined)
      fail("rect/tile only apply to source");
    const p = raw["placeholder"] === null ? {} : raw["placeholder"];
    if (!isRecord(p)) {
      fail("placeholder must be a mapping (or {})");
      return undefined;
    }
    for (const key of Object.keys(p))
      if (!PLACEHOLDER_KEYS.has(key)) fail(`unknown placeholder key "${key}"`);
    const entry: SpriteEntry = { kind: "placeholder", width: TILE, height: TILE };
    if (p["label"] !== undefined) {
      const label = String(p["label"]);
      if (!LABEL.test(label)) fail("placeholder.label must be 0-3 characters of A-Z, 0-9");
      else entry.label = label;
    }
    if (p["color"] !== undefined) {
      const color = typeof p["color"] === "string" ? parseHexColor(p["color"]) : undefined;
      if (!color) fail('placeholder.color must be "#rrggbb"');
      else entry.color = color;
    }
    if (p["size"] !== undefined) {
      const size = intList(p["size"], 2);
      if (!size || size.some((n) => n <= 0 || n % TILE !== 0)) {
        fail(`placeholder.size must be [w, h] in pixels, multiples of ${TILE}`);
      } else {
        entry.width = size[0] ?? TILE;
        entry.height = size[1] ?? TILE;
      }
    }
    return entry;
  }

  const source = raw["source"];
  const m = typeof source === "string" ? VENDOR_SOURCE.exec(source) : null;
  if (typeof source !== "string" || !m?.[1] || source.split("/").includes("..")) {
    fail("source must be a .png path under vendor/<pack>/ (relative to assets/)");
    return undefined;
  }
  const entry: SpriteEntry = { kind: "source", source, pack: m[1] };
  if (raw["rect"] !== undefined && raw["tile"] !== undefined) fail("use rect or tile, not both");
  if (raw["rect"] !== undefined) {
    const r = intList(raw["rect"], 4);
    if (!r || r.some((n) => n < 0)) fail("rect must be [x, y, w, h] in pixels");
    else entry.rect = { x: r[0] ?? 0, y: r[1] ?? 0, w: r[2] ?? 0, h: r[3] ?? 0 };
  }
  if (raw["tile"] !== undefined) {
    const t = intList(raw["tile"], 2);
    if (!t || t.some((n) => n < 0)) fail(`tile must be [column, row] in a ${TILE}px grid`);
    else entry.rect = { x: (t[0] ?? 0) * TILE, y: (t[1] ?? 0) * TILE, w: TILE, h: TILE };
  }
  return entry;
}

function intList(v: unknown, len: number): number[] | undefined {
  if (!Array.isArray(v) || v.length !== len) return undefined;
  return v.every((n) => Number.isInteger(n)) ? (v as number[]) : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
