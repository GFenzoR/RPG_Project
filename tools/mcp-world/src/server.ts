// mcp-world: MCP server (stdio, JSON-RPC 2.0) exposing map-format to AI agents
// (docs/04-map-editor-and-ai.md "Herramientas MCP"). The same library as the editor and
// mapcli, so an AI and a human produce the same files.
//
// Safety limits (docs/04):
//   - Writes only inside <root>/world/: map edits go through applyOps + saveApplied (chunk
//     and auxiliary files of world/islands/), patches go to world/patches/. Every path is
//     checked before writing. Renders go to the OS temp directory, outside the repo.
//   - Never modifies data/, never runs git commands that write (only `git diff`, `git
//     ls-files` and `git show` for map_patch_create), never pushes.
//   - map_apply_ops takes at most MAX_OPS ops per call.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  MAX_VIEW_SIZE,
  formatDiagnostic,
  islandInfo,
  loadContent,
  loadWorld,
  renderAsciiView,
  validateWorld,
  viewArea,
  worldInfo,
} from "@rpg/map-format";
import type { MapOp, Rect } from "@rpg/map-format";
import { applyEdit, editContext } from "@rpg/mapcli/edit";
import { createPatch } from "@rpg/mapcli/patch";
import { MAX_RENDER_SIZE, TILE_SIZES, loadFrames, renderArea } from "@rpg/mapcli/render";
import { loadContentIndex, searchContent } from "./content.ts";
import type { ContentKind } from "./content.ts";
import { FIND_KINDS, findInWorld } from "./find.ts";
import type { FindKind } from "./find.ts";

export const SERVER_NAME = "rpg-world";
export const SERVER_VERSION = "0.1.0";
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Most ops a single map_apply_ops call may carry. */
export const MAX_OPS = 200;
/** Most diagnostics returned by map_validate. */
export const MAX_DIAGNOSTICS = 200;

export interface ServerOptions {
  root: string;
  /** Where map_render writes PNGs (default: <tmp>/rpg-mcp-renders). */
  renderDir?: string;
}

type Json = Record<string, unknown>;

interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run(args: Json): ToolResult;
}

/** A tool input that is wrong: reported to the caller as a tool error, not a crash. */
class InputError extends Error {}

const text = (v: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

// ---- input helpers --------------------------------------------------------------------

function str(args: Json, key: string, required: true): string;
function str(args: Json, key: string, required?: false): string | undefined;
function str(args: Json, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || v === "")
    throw new InputError(`"${key}" must be a non-empty string`);
  return v;
}

function int(args: Json, key: string, min: number, max: number, def?: number): number {
  const v = args[key] ?? def;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new InputError(`"${key}" must be an integer ${min}..${max}`);
  return v;
}

function rect(args: Json, key: string): Rect | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  const r = v as Partial<Rect>;
  const ok = [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isInteger(n));
  if (
    !ok ||
    (r.x as number) < 0 ||
    (r.y as number) < 0 ||
    (r.w as number) < 1 ||
    (r.h as number) < 1
  )
    throw new InputError(`"${key}" must be { x, y, w, h } with integers, w and h >= 1`);
  return { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
}

const ID = "^[a-z][a-z0-9_]*$";
const RECT_SCHEMA = {
  type: "object",
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    w: { type: "integer", minimum: 1 },
    h: { type: "integer", minimum: 1 },
  },
  required: ["x", "y", "w", "h"],
  additionalProperties: false,
};

/** Resolved path, guaranteed inside dir (throws otherwise). */
function inside(dir: string, ...parts: string[]): string {
  const base = resolve(dir) + sep;
  const p = resolve(dir, ...parts);
  if (!p.startsWith(base)) throw new InputError(`path escapes ${dir}`);
  return p;
}

// ---- tools ----------------------------------------------------------------------------

export function createTools(o: ServerOptions): Tool[] {
  const root = resolve(o.root);
  const world = resolve(root, "world");
  const renderDir = o.renderDir ?? join(tmpdir(), "rpg-mcp-renders");
  const island = (args: Json, required: boolean) => {
    const id = required ? str(args, "island", true) : str(args, "island");
    if (id !== undefined && !new RegExp(ID).test(id)) throw new InputError(`bad island id "${id}"`);
    return id;
  };
  const loadIsland = (id: string) => {
    const loaded = loadWorld(root);
    const found = loaded.world.islands.get(id);
    if (!found) throw new InputError(`island "${id}" not found or failed to load`);
    return { loaded, found };
  };

  return [
    {
      name: "map_info",
      description:
        "Summary of the world (islands, rects, chunk counts) or of one island: size, floors, temple, spawns, NPCs, zones, portals. Start here.",
      inputSchema: {
        type: "object",
        properties: {
          island: {
            type: "string",
            pattern: ID,
            description: "Island ID; omit for the whole world.",
          },
        },
        additionalProperties: false,
      },
      run(args) {
        const id = island(args, false);
        const loaded = loadWorld(root);
        const errors = loaded.diagnostics
          .filter((d) => d.severity === "error")
          .map(formatDiagnostic);
        if (id === undefined) return text({ ...worldInfo(loaded.world), load_errors: errors });
        const found = loaded.world.islands.get(id);
        if (!found) throw new InputError(`island "${id}" not found or failed to load`);
        return text({ ...islandInfo(found), load_errors: errors });
      },
    },
    {
      name: "map_view",
      description: `ASCII view of one floor of an area (max ${MAX_VIEW_SIZE}x${MAX_VIEW_SIZE} tiles), one character per tile with a generated legend and markers for spawns, NPCs, portals, signs and the temple. Cheap in tokens; use map_render to check the look.`,
      inputSchema: {
        type: "object",
        properties: {
          island: { type: "string", pattern: ID },
          floor: {
            type: "integer",
            minimum: 0,
            maximum: 15,
            description: "7 = sea level, 8+ underground.",
          },
          area: { ...RECT_SCHEMA, description: "Global tile coordinates." },
        },
        required: ["island", "floor", "area"],
        additionalProperties: false,
      },
      run(args) {
        const { found } = loadIsland(island(args, true) as string);
        const area = rect(args, "area") as Rect;
        if (!area) throw new InputError('"area" is required');
        try {
          return text(renderAsciiView(viewArea(found, int(args, "floor", 0, 15), area)));
        } catch (e) {
          if (e instanceof RangeError) throw new InputError(e.message);
          throw e;
        }
      },
    },
    {
      name: "map_render",
      description: `PNG of one floor of an area with the game sprites, coordinate rulers and overlays (zones, spawns, NPCs, portals, signs, temple). Returns the image and its file path (in the OS temp dir). Max ${MAX_RENDER_SIZE}x${MAX_RENDER_SIZE} tiles. Use it after every edit to review the result.`,
      inputSchema: {
        type: "object",
        properties: {
          island: { type: "string", pattern: ID },
          floor: { type: "integer", minimum: 0, maximum: 15 },
          area: { ...RECT_SCHEMA, description: "Default: the whole island." },
          tile: {
            type: "integer",
            enum: [...TILE_SIZES],
            description: "Pixels per tile; default by area size.",
          },
          overlays: { type: "boolean", description: "Default true." },
        },
        required: ["island", "floor"],
        additionalProperties: false,
      },
      run(args) {
        const id = island(args, true) as string;
        const { loaded, found } = loadIsland(id);
        const floor = int(args, "floor", 0, 15);
        const area = rect(args, "area") ?? found.meta.rect;
        if (area.w > MAX_RENDER_SIZE || area.h > MAX_RENDER_SIZE)
          throw new InputError(`area is at most ${MAX_RENDER_SIZE}x${MAX_RENDER_SIZE} tiles`);
        const tile = args["tile"] === undefined ? undefined : int(args, "tile", 4, 32);
        if (tile !== undefined && !(TILE_SIZES as readonly number[]).includes(tile))
          throw new InputError(`"tile" must be one of ${TILE_SIZES.join(", ")}`);
        const overlays = args["overlays"] !== false;
        const r = renderArea(loaded.world, loadContent(root), loadFrames(root), {
          floor,
          area,
          overlays,
          ...(tile === undefined ? {} : { tile }),
        });
        mkdirSync(renderDir, { recursive: true });
        const file = inside(
          renderDir,
          `${id}-z${floor}-${area.x}_${area.y}_${area.w}x${area.h}.png`,
        );
        writeFileSync(file, r.png);
        const info = {
          path: file,
          width: r.width,
          height: r.height,
          tile: r.tile,
          legend: r.legend,
          missing_sprites: r.missing,
        };
        return {
          content: [
            { type: "text", text: JSON.stringify(info, null, 2) },
            { type: "image", data: r.png.toString("base64"), mimeType: "image/png" },
          ],
        };
      },
    },
    {
      name: "map_apply_ops",
      description: `Applies a list of map ops atomically (all or none) and saves only the touched files of world/. Ops (docs/04-map-editor-and-ai.md): paint_ground {floor, rect|cells, item}, erase {floor, rect|cells, layer: ground|items|all}, place_item {pos, item, index?}, remove_item {pos, item, index?}, fill {pos, item}, autoborder {floor, rect}, scatter {floor, rect, items[], density 0..1, seed, on_ground[]?}, stamp {pos, prefab}, add_spawn {id, center, radius, monsters:[{monster,count}], respawn_seconds}, remove_spawn {id}, add_zone {id, type, floors[], rects[]}, remove_zone {id}, add_portal {id, kind, from, to}, remove_portal {id}, place_npc {npc, pos}, remove_npc {npc}. Positions are global {x, y, z}. At most ${MAX_OPS} ops per call. Returns the files written and the validation of the islands touched. dry_run checks without writing.`,
      inputSchema: {
        type: "object",
        properties: {
          ops: {
            type: "array",
            minItems: 1,
            maxItems: MAX_OPS,
            items: { type: "object", properties: { op: { type: "string" } }, required: ["op"] },
          },
          island: {
            type: "string",
            pattern: ID,
            description: "If given, ops touching any other island are rejected.",
          },
          dry_run: { type: "boolean" },
        },
        required: ["ops"],
        additionalProperties: false,
      },
      run(args) {
        const ops = args["ops"];
        if (!Array.isArray(ops) || ops.length === 0)
          throw new InputError('"ops" must be a non-empty list');
        if (ops.length > MAX_OPS)
          throw new InputError(`at most ${MAX_OPS} ops per call (got ${ops.length})`);
        for (const [i, op] of ops.entries())
          if (typeof op !== "object" || op === null || typeof (op as Json)["op"] !== "string")
            throw new InputError(`op ${i} must be an object with an "op" field`);
        const id = island(args, false);
        const outcome = applyEdit(editContext(root), ops as MapOp[], {
          ...(id ? { islands: [id] } : {}),
          dryRun: args["dry_run"] === true,
        });
        // saveApplied only builds paths under world/islands/<id>/; double-check anyway.
        for (const f of [...outcome.written, ...outcome.removed])
          inside(world, f.replace(/^world\//, ""));
        return { ...text(outcome), isError: !outcome.ok };
      },
    },
    {
      name: "map_validate",
      description:
        "Validates one island or the whole world with the same rules as the editor and the CI. Returns errors and warnings with file:line and world position.",
      inputSchema: {
        type: "object",
        properties: { island: { type: "string", pattern: ID } },
        additionalProperties: false,
      },
      run(args) {
        const id = island(args, false);
        const report = validateWorld(root, id === undefined ? {} : { island: id });
        return text({
          errors: report.errors,
          warnings: report.warnings,
          diagnostics: report.diagnostics.slice(0, MAX_DIAGNOSTICS).map(formatDiagnostic),
          truncated: report.diagnostics.length > MAX_DIAGNOSTICS,
        });
      },
    },
    {
      name: "map_find",
      description:
        'Finds things on the map. kind "item" needs id (ground or stack item) and returns positions; "spawn" (id = spawn or monster), "npc", "zone" (id = zone or type), "portal", "text" return the entries. Filter by island, floor and area.',
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...FIND_KINDS] },
          id: { type: "string" },
          island: { type: "string", pattern: ID },
          floor: { type: "integer", minimum: 0, maximum: 15 },
          area: RECT_SCHEMA,
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      run(args) {
        const kind = str(args, "kind", true);
        if (!(FIND_KINDS as readonly string[]).includes(kind))
          throw new InputError(`"kind" must be one of ${FIND_KINDS.join(", ")}`);
        const id = str(args, "id");
        const isl = island(args, false);
        const area = rect(args, "area");
        try {
          return text(
            findInWorld(loadWorld(root).world, {
              kind: kind as FindKind,
              ...(id === undefined ? {} : { id }),
              ...(isl === undefined ? {} : { island: isl }),
              ...(args["floor"] === undefined ? {} : { floor: int(args, "floor", 0, 15) }),
              ...(area === undefined ? {} : { area }),
              limit: int(args, "limit", 1, 500, 100),
            }),
          );
        } catch (e) {
          if (e instanceof RangeError) throw new InputError(e.message);
          throw e;
        }
      },
    },
    {
      name: "content_search",
      description:
        "Searches data/ (read only): items, monsters and NPCs by text (ID or name in any language), kind, item kind (ground, decoration, wall...) or tag. Use it to pick IDs for ops.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          kind: { type: "string", enum: ["item", "monster", "npc"] },
          item_kind: { type: "string" },
          tag: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      run(args) {
        const kind = str(args, "kind");
        if (kind !== undefined && !["item", "monster", "npc"].includes(kind))
          throw new InputError('"kind" must be item, monster or npc');
        const t = str(args, "text");
        const itemKind = str(args, "item_kind");
        const tag = str(args, "tag");
        const results = searchContent(loadContentIndex(root), {
          ...(t === undefined ? {} : { text: t }),
          ...(kind === undefined ? {} : { kind: kind as ContentKind }),
          ...(itemKind === undefined ? {} : { item_kind: itemKind }),
          ...(tag === undefined ? {} : { tag }),
          limit: int(args, "limit", 1, 200, 50),
        });
        return text({ count: results.length, results });
      },
    },
    {
      name: "map_patch_create",
      description:
        "Packs the current changes of world/ (against a git ref, default HEAD) into world/patches/<name>.rpgpatch.json, ready to review or send. Returns the path and the files it contains. Does not commit or push.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]*$", maxLength: 64 },
          island: { type: "string", pattern: ID },
          against: { type: "string", pattern: "^[A-Za-z0-9._/~^-]+$", maxLength: 100 },
        },
        required: ["name"],
        additionalProperties: false,
      },
      run(args) {
        const name = str(args, "name", true);
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(name) || name.length > 64)
          throw new InputError('"name" must be lowercase letters, digits, "-" or "_"');
        const against = str(args, "against") ?? "HEAD";
        if (!/^[A-Za-z0-9._/~^-]+$/.test(against) || against.startsWith("-"))
          throw new InputError('"against" must be a git ref');
        const patch = createPatch(root, against, island(args, false));
        const dir = inside(world, "patches");
        mkdirSync(dir, { recursive: true });
        const file = inside(dir, `${name}.rpgpatch.json`);
        writeFileSync(file, `${JSON.stringify(patch, null, 2)}\n`);
        return text({
          path: file.slice(root.length + 1),
          base_ref: patch.base_ref,
          files: patch.files.map((f) => ({
            path: f.path,
            change: f.base === null ? "added" : f.content === null ? "removed" : "modified",
          })),
        });
      },
    },
  ];
}

// ---- JSON-RPC ---------------------------------------------------------------------------

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

export interface Response {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const INSTRUCTIONS =
  "Map tools for the RPG Project world (docs/04-map-editor-and-ai.md). Flow: map_info and content_search to see what exists; map_apply_ops to edit (atomic, reversible ops; paint, autoborder, scatter, stamp prefabs, spawns, NPCs, zones, portals); map_validate until there are no errors; map_render each touched area and look at the image; map_patch_create to package the change. Writes only world/; never data/.";

export class McpServer {
  private readonly tools: Map<string, Tool>;
  constructor(o: ServerOptions) {
    this.tools = new Map(createTools(o).map((t) => [t.name, t]));
  }

  /** Handles one message; undefined for notifications. */
  handle(raw: unknown): Response | undefined {
    const msg = raw as Partial<Request>;
    const id = msg?.id ?? null;
    if (
      typeof msg !== "object" ||
      msg === null ||
      msg.jsonrpc !== "2.0" ||
      typeof msg.method !== "string"
    )
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    const isNotification = msg.id === undefined;
    const ok = (result: unknown): Response | undefined =>
      isNotification ? undefined : { jsonrpc: "2.0", id, result };
    const fail = (code: number, message: string): Response | undefined =>
      isNotification ? undefined : { jsonrpc: "2.0", id, error: { code, message } };
    const params = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        const asked = params["protocolVersion"];
        const version =
          typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const name = params["name"];
        const tool = typeof name === "string" ? this.tools.get(name) : undefined;
        if (!tool) return fail(-32602, `unknown tool ${JSON.stringify(name)}`);
        const args = params["arguments"] ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args))
          return fail(-32602, "arguments must be an object");
        try {
          return ok(tool.run(args as Json));
        } catch (e) {
          // Bad input is the caller's to fix; anything else is reported, never crashes the server.
          const message = e instanceof Error ? e.message : String(e);
          return ok({ content: [{ type: "text", text: `error: ${message}` }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith("notifications/")) return undefined;
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }
}
