// Animated creature sprites (docs/17 ANI): the `palettes` and `animations` sections of
// assets/sprites.yaml. An animation either composes frame strips from layered vendor sheets
// (a Liberated Pixel Cup character: body, head, clothes, hair...) and slices them into
// "<sprite>/<action>_<dir>_<n>" atlas frames, or only gives drawing hints for a sprite that
// already exists (a single-frame monster that looks left, a bat that flies). Either way the
// atlas index gets an `anims` entry the client animates from (packages/renderer anim.ts).
import { createImage } from "./image.ts";
import type { Image } from "./image.ts";
import { parseHexColor } from "./image.ts";
import { TILE } from "./placeholder.ts";

export const ANIM_ACTIONS = ["idle", "walk", "attack", "death"] as const;
export type AnimAction = (typeof ANIM_ACTIONS)[number];
export const ANIM_DIRS = ["n", "e", "s", "w"] as const;
export type AnimDir = (typeof ANIM_DIRS)[number];
export type Shadow = "baked" | "ellipse" | "none";

/** Where one action's frames are in a sheet. */
export interface ActionSpec {
  /** Replaces "<sheet>" in the layer files (lpc: walk, idle, slash, hurt). */
  sheet: string;
  frame: { w: number; h: number };
  /** Row (in frames) of each facing; a facing without a row falls back to "s" in the client. */
  rows: Partial<Record<AnimDir, number>>;
  /** First column (in frames) and number of frames. */
  col: number;
  count: number;
  /** Ms per frame (walk: 0, it plays by distance). */
  ms: number;
  /** Walk only: frames per tile walked (a cycle every count / perTile tiles). */
  perTile: number;
}

export interface AnimLayer {
  /** vendor/<pack>/... .png, with "<sheet>" where the action's sheet name goes. */
  file: string;
  pack: string;
  /** Palette swaps, source palette name -> target palette name (same length). */
  recolor: [string, string][];
}

export interface AnimEntry {
  /** Empty: a hints-only entry for a sprite that already exists. */
  layers: AnimLayer[];
  actions: Map<AnimAction, ActionSpec>;
  facing?: "left" | "right";
  flying?: boolean;
  shadow: Shadow;
  /**
   * Frames from files only (no layers): the west frames of an action stand in for its
   * missing east ones mirrored, and the other way round (docs/17 ANI-1, `mirror: true`).
   */
  mirror?: boolean;
  /** Frames from files only: where the frame sits on its tile (default br). */
  anchor?: "br" | "bc";
  /** Frames from files only: ms per frame of idle, attack or death (walk plays by distance). */
  ms?: Partial<Record<AnimAction, number>>;
}

/** What atlas.json says about an animated (or hinted) sprite: see AnimMeta in packages/renderer. */
export interface AnimMeta {
  /** Frame size in pixels. */
  w: number;
  h: number;
  /** br: bottom-right corner on the tile's (as every sprite); bc: centred, feet on the tile. */
  anchor: "br" | "bc";
  /** Transparent rows under the lowest opaque pixel of the frames. */
  foot: number;
  /** Height of the drawing above its feet (lowest to highest opaque row), pixels. */
  top: number;
  shadow: Shadow;
  facing?: "left" | "right";
  flying?: boolean;
  actions: Partial<
    Record<AnimAction, { frames: number; ms: number; perTile?: number; dirs: AnimDir[] }>
  >;
}

const LPC_ROWS = { n: 0, w: 1, s: 2, e: 3 } as const;
const LPC_FRAME = { w: 64, h: 64 } as const;

/**
 * Sheet layouts by name. lpc: the Universal LPC Spritesheet Character Generator's sheets,
 * one file per animation, 64x64 frames, rows north, west, south, east (docs/17 ANI-2).
 */
export const PRESETS: Record<string, Partial<Record<AnimAction, ActionSpec>>> = {
  lpc: {
    // Two breathing frames per facing.
    idle: {
      sheet: "idle",
      frame: LPC_FRAME,
      rows: LPC_ROWS,
      col: 0,
      count: 2,
      ms: 500,
      perTile: 0,
    },
    // Column 0 is the standing pose; 1..8 the cycle, half of it per tile.
    walk: { sheet: "walk", frame: LPC_FRAME, rows: LPC_ROWS, col: 1, count: 8, ms: 0, perTile: 4 },
    // Wind-up, swing, recovery: 6 x 60 ms.
    attack: {
      sheet: "slash",
      frame: LPC_FRAME,
      rows: LPC_ROWS,
      col: 0,
      count: 6,
      ms: 60,
      perTile: 0,
    },
    // The fall (only drawn facing south): 6 x 100 ms, then the corpse.
    death: {
      sheet: "hurt",
      frame: LPC_FRAME,
      rows: { s: 0 },
      col: 0,
      count: 6,
      ms: 100,
      perTile: 0,
    },
  },
};

/** vendor/<pack>/<path with <sheet>>.png, relative to assets/. */
const LAYER_FILE = /^vendor\/([A-Za-z0-9._-]+)\/(?:[A-Za-z0-9._ <>-]+\/)*[A-Za-z0-9._ <>-]+\.png$/;
const PALETTE_NAME = /^[a-z0-9_]+$/;
const ENTRY_KEYS = new Set([
  "preset",
  "layers",
  "actions",
  "facing",
  "flying",
  "shadow",
  "mirror",
  "anchor",
  "ms",
  "notes",
]);
/** The actions whose frames play by time (walk plays by the distance walked). */
const TIMED_ACTIONS: readonly AnimAction[] = ["idle", "attack", "death"];
const SPEC_KEYS = new Set(["sheet", "frame", "rows", "col", "count", "ms", "per_tile"]);

/** Parses the `palettes` section: name -> list of "#rrggbb" (light to dark). */
export function parsePalettes(
  raw: unknown,
  fail: (message: string) => void,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    fail('"palettes" must be a mapping of name -> ["#rrggbb", ...]');
    return out;
  }
  for (const [name, colors] of Object.entries(raw)) {
    if (!PALETTE_NAME.test(name)) fail(`palette ${name}: name must be lowercase snake_case`);
    const list = Array.isArray(colors)
      ? colors.map((c) => (typeof c === "string" ? parseHexColor(c) : undefined))
      : [];
    if (list.length === 0 || list.some((c) => !c)) {
      fail(`palette ${name}: must be a list of "#rrggbb" colours`);
      continue;
    }
    out.set(
      name,
      list.map((c) => ((c?.[0] ?? 0) << 16) | ((c?.[1] ?? 0) << 8) | (c?.[2] ?? 0)),
    );
  }
  return out;
}

/** Parses one `animations` entry; `fail` gets every problem. */
export function parseAnimEntry(
  raw: unknown,
  palettes: Map<string, number[]>,
  fail: (message: string) => void,
): AnimEntry | undefined {
  if (!isRecord(raw)) {
    fail("animation must be a mapping");
    return undefined;
  }
  for (const key of Object.keys(raw)) if (!ENTRY_KEYS.has(key)) fail(`unknown key "${key}"`);
  const entry: AnimEntry = { layers: [], actions: new Map(), shadow: "baked" };
  const facing = raw["facing"];
  if (facing !== undefined) {
    if (facing === "left" || facing === "right") entry.facing = facing;
    else fail("facing must be left or right");
  }
  if (raw["flying"] !== undefined) {
    if (typeof raw["flying"] === "boolean") entry.flying = raw["flying"];
    else fail("flying must be true or false");
  }
  const layers = raw["layers"];
  if (layers === undefined) {
    if (raw["preset"] !== undefined || raw["actions"] !== undefined)
      fail("preset and actions need layers (an entry without layers only gives hints)");
  } else if (!Array.isArray(layers) || layers.length === 0) {
    fail("layers must be a non-empty list");
  } else {
    entry.shadow = "ellipse";
    for (const l of layers) {
      const layer = parseLayer(l, palettes, fail);
      if (layer) entry.layers.push(layer);
    }
    parseActions(raw, entry, fail);
  }
  const shadow = raw["shadow"];
  if (shadow !== undefined) {
    if (shadow === "baked" || shadow === "ellipse" || shadow === "none") entry.shadow = shadow;
    else fail("shadow must be baked, ellipse or none");
  }
  parseFileHints(raw, entry, fail);
  return entry;
}

/** `mirror`, `anchor` and `ms`: hints for frames that come from files (no layers). */
function parseFileHints(
  raw: Record<string, unknown>,
  entry: AnimEntry,
  fail: (message: string) => void,
): void {
  const given = ["mirror", "anchor", "ms"].filter((k) => raw[k] !== undefined);
  if (given.length === 0) return;
  if (entry.layers.length > 0 || raw["layers"] !== undefined) {
    fail(`${given.join(", ")}: only for frames from files (an entry without layers)`);
    return;
  }
  const mirror = raw["mirror"];
  if (mirror !== undefined) {
    if (typeof mirror === "boolean") entry.mirror = mirror;
    else fail("mirror must be true or false");
  }
  const anchor = raw["anchor"];
  if (anchor !== undefined) {
    if (anchor === "br" || anchor === "bc") entry.anchor = anchor;
    else fail("anchor must be br or bc");
  }
  const ms = raw["ms"];
  if (ms !== undefined) {
    if (!isRecord(ms)) {
      fail("ms must map idle, attack or death to ms per frame");
      return;
    }
    const out: Partial<Record<AnimAction, number>> = {};
    for (const [action, value] of Object.entries(ms)) {
      if (!(TIMED_ACTIONS as readonly string[]).includes(action))
        fail(`ms.${action}: only ${TIMED_ACTIONS.join(", ")} play by time`);
      else if (!Number.isInteger(value) || (value as number) < 1)
        fail(`ms.${action} must be an integer >= 1`);
      else out[action as AnimAction] = value as number;
    }
    entry.ms = out;
  }
}

/** A copy of `src` flipped left to right. */
export function mirrorImage(src: Image): Image {
  const out = createImage(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const s = (y * src.width + x) * 4;
      const d = (y * src.width + (src.width - 1 - x)) * 4;
      for (let c = 0; c < 4; c++) out.data[d + c] = src.data[s + c] ?? 0;
    }
  }
  return out;
}

function parseLayer(
  raw: unknown,
  palettes: Map<string, number[]>,
  fail: (message: string) => void,
): AnimLayer | undefined {
  const obj = typeof raw === "string" ? { file: raw } : raw;
  if (!isRecord(obj)) {
    fail("a layer is a file path or { file, recolor }");
    return undefined;
  }
  for (const key of Object.keys(obj))
    if (key !== "file" && key !== "recolor") fail(`unknown layer key "${key}"`);
  const file = obj["file"];
  const m = typeof file === "string" ? LAYER_FILE.exec(file) : null;
  if (typeof file !== "string" || !m?.[1] || file.split("/").includes("..")) {
    fail("layer file must be a .png path under vendor/<pack>/ (relative to assets/)");
    return undefined;
  }
  const layer: AnimLayer = { file, pack: m[1], recolor: [] };
  const recolor = obj["recolor"];
  if (recolor !== undefined) {
    if (!isRecord(recolor)) {
      fail(`${file}: recolor must map a source palette to a target palette`);
      return layer;
    }
    for (const [from, to] of Object.entries(recolor)) {
      const a = palettes.get(from);
      const b = typeof to === "string" ? palettes.get(to) : undefined;
      if (!a || !b) fail(`${file}: unknown palette in recolor ${from} -> ${String(to)}`);
      else if (a.length !== b.length)
        fail(`${file}: palettes ${from} and ${String(to)} have different lengths`);
      else layer.recolor.push([from, String(to)]);
    }
  }
  return layer;
}

function parseActions(
  raw: Record<string, unknown>,
  entry: AnimEntry,
  fail: (message: string) => void,
): void {
  const presetName = raw["preset"];
  let preset: Partial<Record<AnimAction, ActionSpec>> = {};
  if (presetName !== undefined) {
    const p = typeof presetName === "string" ? PRESETS[presetName] : undefined;
    if (!p)
      fail(`unknown preset ${String(presetName)} (known: ${Object.keys(PRESETS).join(", ")})`);
    else preset = p;
  }
  const actions = raw["actions"];
  if (actions === undefined) {
    for (const a of ANIM_ACTIONS) {
      const spec = preset[a];
      if (spec) entry.actions.set(a, spec);
    }
  } else if (Array.isArray(actions)) {
    for (const a of actions) {
      const spec = typeof a === "string" ? preset[a as AnimAction] : undefined;
      if (!spec) fail(`action ${String(a)} is not in the preset`);
      else entry.actions.set(a as AnimAction, spec);
    }
  } else if (isRecord(actions)) {
    for (const [a, rawSpec] of Object.entries(actions)) {
      if (!(ANIM_ACTIONS as readonly string[]).includes(a)) {
        fail(`unknown action ${a} (known: ${ANIM_ACTIONS.join(", ")})`);
        continue;
      }
      const spec = parseSpec(a as AnimAction, rawSpec, preset[a as AnimAction], fail);
      if (spec) entry.actions.set(a as AnimAction, spec);
    }
  } else {
    fail("actions must be a list of preset actions or a mapping of action -> spec");
  }
  if (entry.actions.size === 0) fail("an animation needs at least one action");
}

function parseSpec(
  action: AnimAction,
  raw: unknown,
  base: ActionSpec | undefined,
  fail: (message: string) => void,
): ActionSpec | undefined {
  if (!isRecord(raw)) {
    fail(`${action}: spec must be a mapping`);
    return undefined;
  }
  for (const key of Object.keys(raw))
    if (!SPEC_KEYS.has(key)) fail(`${action}: unknown key "${key}"`);
  const num = (key: string, fallback: number | undefined, min: number): number | undefined => {
    const v = raw[key];
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || (v as number) < min) {
      fail(`${action}: ${key} must be an integer >= ${min}`);
      return undefined;
    }
    return v as number;
  };
  const sheet = raw["sheet"] ?? base?.sheet;
  const frameRaw = raw["frame"];
  let frame = base?.frame;
  if (frameRaw !== undefined) {
    const f = Array.isArray(frameRaw) && frameRaw.length === 2 ? frameRaw : undefined;
    if (!f || f.some((n) => !Number.isInteger(n) || n <= 0 || n % TILE !== 0)) {
      fail(`${action}: frame must be [w, h], multiples of ${TILE}`);
      return undefined;
    }
    frame = { w: f[0] as number, h: f[1] as number };
  }
  let rows = base?.rows;
  if (raw["rows"] !== undefined) {
    const r = raw["rows"];
    if (!isRecord(r) || Object.keys(r).length === 0) {
      fail(`${action}: rows must map facings (n, e, s, w) to rows`);
      return undefined;
    }
    const out: Partial<Record<AnimDir, number>> = {};
    for (const [d, row] of Object.entries(r)) {
      if (
        !(ANIM_DIRS as readonly string[]).includes(d) ||
        !Number.isInteger(row) ||
        (row as number) < 0
      )
        fail(`${action}: rows.${d} must be a facing (n, e, s, w) with a row >= 0`);
      else out[d as AnimDir] = row as number;
    }
    rows = out;
  }
  const col = num("col", base?.col ?? 0, 0);
  const count = num("count", base?.count, 1);
  const ms = num("ms", base?.ms ?? (action === "walk" ? 0 : undefined), action === "walk" ? 0 : 1);
  const perTile = num("per_tile", base?.perTile ?? (action === "walk" ? count : 0), 0);
  if (
    typeof sheet !== "string" ||
    !frame ||
    !rows ||
    col === undefined ||
    !count ||
    ms === undefined ||
    perTile === undefined
  ) {
    fail(`${action}: needs sheet, frame, rows and count (or a preset that has them)`);
    return undefined;
  }
  if (action === "walk" && perTile < 1) {
    fail("walk: per_tile must be >= 1");
    return undefined;
  }
  return { sheet, frame, rows, col, count, ms, perTile };
}

/** The atlas name of one frame (docs/17 ANI-4). */
export const frameName = (sprite: string, action: AnimAction, dir: AnimDir, n: number): string =>
  `${sprite}/${action}_${dir}_${n}`;

/**
 * Applies palette swaps to a copy of `src`: every pixel whose colour is in a source palette
 * gets the colour at the same place of its target palette.
 */
export function recolorImage(src: Image, swaps: [number[], number[]][]): Image {
  if (swaps.length === 0) return src;
  const map = new Map<number, number>();
  for (const [from, to] of swaps) from.forEach((c, i) => map.set(c, to[i] ?? c));
  const out = createImage(src.width, src.height);
  out.data.set(src.data);
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] === 0) continue;
    const c = ((out.data[i] ?? 0) << 16) | ((out.data[i + 1] ?? 0) << 8) | (out.data[i + 2] ?? 0);
    const to = map.get(c);
    if (to === undefined) continue;
    out.data[i] = (to >> 16) & 0xff;
    out.data[i + 1] = (to >> 8) & 0xff;
    out.data[i + 2] = to & 0xff;
  }
  return out;
}

/**
 * Draws the (sx, sy, w, h) rectangle of `src` over `dst` at (0, 0): pixels at least half
 * opaque replace what is under them and become fully opaque, the rest is dropped (sprites
 * keep alpha 0 or 255, assets/README.md).
 */
export function layerOver(src: Image, sx: number, sy: number, dst: Image): void {
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < dst.width; x++) {
      const s = ((sy + y) * src.width + sx + x) * 4;
      if ((src.data[s + 3] ?? 0) < 128) continue;
      const d = (y * dst.width + x) * 4;
      dst.data[d] = src.data[s] ?? 0;
      dst.data[d + 1] = src.data[s + 1] ?? 0;
      dst.data[d + 2] = src.data[s + 2] ?? 0;
      dst.data[d + 3] = 255;
    }
  }
}

/**
 * The opaque rows of a set of frames of the same size: `foot` = empty rows under the
 * lowest opaque pixel, `top` = rows from that pixel up to the highest one. All empty: the
 * whole frame.
 */
export function measureFrames(frames: Image[]): { foot: number; top: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const img of frames) {
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if ((img.data[(y * img.width + x) * 4 + 3] ?? 0) === 0) continue;
        if (y < min) min = y;
        if (y > max) max = y;
        break;
      }
    }
  }
  const h = frames[0]?.height ?? 0;
  if (min === Infinity) return { foot: 0, top: h };
  return { foot: h - 1 - max, top: max - min + 1 };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
