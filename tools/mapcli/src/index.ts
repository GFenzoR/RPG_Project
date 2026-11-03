// mapcli: map tooling over @rpg/map-format (tools/CLAUDE.md). Output is JSON on stdout
// unless --format text is given, so humans, scripts and AIs can chain it.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  MAX_COORD,
  MAX_FLOOR,
  MAX_VIEW_SIZE,
  RECIPES,
  ZONE_TYPES,
  formatDiagnostic,
  generate,
  islandInfo,
  loadContent,
  loadWorld,
  renderAsciiView,
  validateWorld,
  viewArea,
  worldInfo,
} from "@rpg/map-format";
import type { Diagnostic, MapOp, Position, Rect, Recipe, ZoneType } from "@rpg/map-format";
import { applyEdit, editContext, parseOps } from "./edit.ts";
import type { EditOutcome } from "./edit.ts";
import { createPatch, diffPatch, parsePatch, planPatch, writePlanned } from "./patch.ts";
import { MAX_RENDER_SIZE, TILE_SIZES, loadFrames, renderArea } from "./render.ts";
import { prCheck } from "./prcheck.ts";

export const USAGE = `usage: mapcli <command> [options]   (global: --root DIR, default ".")
 read:
  info [island]                                 world or island summary
  validate [island] [--format json|text]        same validator as the editor and make validate
  view <island> --floor Z --area x,y,w,h [--format json|text]   ASCII view (max ${MAX_VIEW_SIZE}x${MAX_VIEW_SIZE})
  render <island> --floor Z [--area x,y,w,h] --out FILE.png [--tile 4|8|16|32] [--no-overlays] [--no-grid]
                                                PNG for review (area default: the island; max ${MAX_RENDER_SIZE}x${MAX_RENDER_SIZE})
 edit (atomic; writes only the touched files; --dry-run checks without writing):
  fmt [island] [--check]                        rewrite map files in canonical form
  paint <island> --floor Z --rect x,y,w,h --ground ID
  erase <island> --floor Z --rect x,y,w,h [--layer ground|items|all]
  fill <island> --pos x,y,z --ground ID
  place <island> --pos x,y,z --item ID [--index N]
  remove <island> --pos x,y,z --item ID [--index N]
  autoborder <island> --floor Z [--rect x,y,w,h]  (rect default: the island)
  stamp <island> --pos x,y,z --prefab ID
  spawn add <island> --pos x,y,z --monster ID [--count N] [--radius R] [--respawn S] [--id ID]
  spawn remove <island> --id ID
  zone add <island> --rect x,y,w,h --floor Z[,Z...] --type ${ZONE_TYPES.join("|")} [--id ID]
  zone remove <island> --id ID
  npc place <island> --pos x,y,z --npc ID
  npc remove <island> --npc ID
  ops apply <file.json|-> [--island ID]         op list (docs/04), all or nothing
  generate <island> --recipe ${RECIPES.join("|")} --seed N --size N [--floor Z] [--force]
 patches (.rpgpatch.json):
  patch create [island] [--against REF] [--out FILE]   world/ changes vs a git ref (default HEAD)
  patch diff <file>                             what applying it would change
  patch apply <file> [--dry-run] [--partial]     merge tile by tile / entry by entry with the
                                                current files; all or nothing unless --partial
                                                (writes the rest, keeps the current conflicts)
 pull requests (CI, docs/04 "PR de mapas en CI"):
  pr-check --base REF --head REF --out DIR [--author LOGIN] [--association A]
                [--head-repo O/R --repo O/R] [--pr N]
                                                plots, patch diff, validation and before/after
                                                PNGs of a branch; writes DIR/report.json`;

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const stdio: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
};

class UsageError extends Error {}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function parseArea(s: string | undefined, flag = "--area"): Rect {
  const parts = (s ?? "").split(",");
  const [x, y, w, h] = parts.map((p) => (DECIMAL.test(p) ? Number(p) : NaN));
  if (
    parts.length !== 4 ||
    x === undefined ||
    y === undefined ||
    w === undefined ||
    h === undefined ||
    [x, y, w, h].some((n) => !Number.isSafeInteger(n))
  )
    throw new UsageError(`${flag} must be x,y,w,h with non-negative decimal integers`);
  if (
    x > MAX_COORD ||
    y > MAX_COORD ||
    w < 1 ||
    h < 1 ||
    x + w > MAX_COORD + 1 ||
    y + h > MAX_COORD + 1
  )
    throw new UsageError(
      `${flag} must stay inside the world: x,y in 0..${MAX_COORD}, w,h >= 1, x+w and y+h <= ${MAX_COORD + 1}`,
    );
  return { x, y, w, h };
}

function parseFloor(s: string | undefined): number {
  const z = s !== undefined && DECIMAL.test(s) ? Number(s) : NaN;
  if (!(z >= 0 && z <= MAX_FLOOR))
    throw new UsageError(`--floor must be an integer 0..${MAX_FLOOR}`);
  return z;
}

function parseFloors(s: string | undefined): number[] {
  return (s ?? "").split(",").map((f) => parseFloor(f));
}

function parsePos(s: string | undefined): Position {
  const parts = (s ?? "").split(",");
  const [x, y, z] = parts.map((p) => (DECIMAL.test(p) ? Number(p) : NaN));
  if (
    parts.length !== 3 ||
    x === undefined ||
    y === undefined ||
    z === undefined ||
    !(x <= MAX_COORD && y <= MAX_COORD && z <= MAX_FLOOR)
  )
    throw new UsageError(`--pos must be x,y,z (x,y in 0..${MAX_COORD}, z in 0..${MAX_FLOOR})`);
  return { x, y, z };
}

function parseCount(s: string | undefined, flag: string, def: number, min = 0): number {
  if (s === undefined) return def;
  const n = DECIMAL.test(s) ? Number(s) : NaN;
  if (!(Number.isSafeInteger(n) && n >= min))
    throw new UsageError(`${flag} must be an integer >= ${min}`);
  return n;
}

function need(v: string | undefined, flag: string): string {
  if (v === undefined || v === "") throw new UsageError(`missing ${flag}`);
  return v;
}

/** Runs one mapcli invocation; returns the process exit code. */
export function run(argv: string[], io: Io = stdio): number {
  try {
    return dispatch(argv, io);
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && "code" in e)) {
      io.err(`mapcli: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof RangeError) {
      io.err(`mapcli: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

const WITH_SUBCOMMAND = new Set(["spawn", "zone", "npc", "ops", "patch"]);

function dispatch(argv: string[], io: Io): number {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string", default: "." },
      check: { type: "boolean", default: false },
      format: { type: "string", default: "json" },
      floor: { type: "string" },
      area: { type: "string" },
      rect: { type: "string" },
      pos: { type: "string" },
      ground: { type: "string" },
      item: { type: "string" },
      index: { type: "string" },
      layer: { type: "string" },
      prefab: { type: "string" },
      monster: { type: "string" },
      count: { type: "string" },
      radius: { type: "string" },
      respawn: { type: "string" },
      id: { type: "string" },
      type: { type: "string" },
      npc: { type: "string" },
      island: { type: "string" },
      recipe: { type: "string" },
      seed: { type: "string" },
      size: { type: "string" },
      force: { type: "boolean", default: false },
      out: { type: "string" },
      tile: { type: "string" },
      "no-overlays": { type: "boolean", default: false },
      "no-grid": { type: "boolean", default: false },
      against: { type: "string", default: "HEAD" },
      "dry-run": { type: "boolean", default: false },
      partial: { type: "boolean", default: false },
      base: { type: "string" },
      head: { type: "string" },
      author: { type: "string" },
      association: { type: "string" },
      "head-repo": { type: "string" },
      repo: { type: "string" },
      pr: { type: "string" },
    },
  });
  const [command, ...args] = positionals;
  const sub = command !== undefined && WITH_SUBCOMMAND.has(command) ? args.shift() : undefined;
  const [island, ...rest] = args;
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  if (values.format !== "json" && values.format !== "text")
    throw new UsageError("--format must be json or text");
  const root = resolve(values.root);
  const dryRun = values["dry-run"];
  const needIsland = (): string => {
    if (island === undefined)
      throw new UsageError(`${command}${sub ? ` ${sub}` : ""} needs an island`);
    return island;
  };
  /** Applies ops limited to the named island and prints the outcome. */
  const edit = (ops: MapOp[], only?: string[]): number => {
    const outcome = applyEdit(editContext(root), ops, {
      ...(only ? { islands: only } : {}),
      dryRun,
    });
    return report(io, outcome);
  };

  switch (command) {
    case "info": {
      const { world, diagnostics } = loadWorld(root);
      const loadErrors = errorsAbout(diagnostics, island);
      const found = island === undefined ? undefined : world.islands.get(island);
      if (island !== undefined && !found) return missingIsland(io, island, loadErrors);
      const info = found ? islandInfo(found) : worldInfo(world);
      io.out(json({ ...info, load_errors: loadErrors }));
      return loadErrors.length > 0 ? 1 : 0;
    }
    case "fmt": {
      const { world, files, diagnostics } = loadWorld(root);
      if (island !== undefined && !world.islands.has(island))
        return missingIsland(io, island, diagnostics.map(formatDiagnostic));
      const prefix = island === undefined ? "" : `world/islands/${island}/`;
      const changed = files.filter((f) => f.file.startsWith(prefix) && f.text !== f.canonical);
      if (!values.check) for (const f of changed) writeFileSync(join(root, f.file), f.canonical);
      // Files that failed to parse cannot be formatted; they are reported, not touched.
      const unparsed = diagnostics
        .filter((d) => d.severity === "error" && d.file.startsWith(prefix))
        .map(formatDiagnostic);
      io.out(json({ check: values.check, changed: changed.map((f) => f.file), errors: unparsed }));
      return unparsed.length > 0 || (values.check && changed.length > 0) ? 1 : 0;
    }
    case "validate": {
      const report = validateWorld(root, island === undefined ? {} : { island });
      if (values.format === "text") {
        for (const d of report.diagnostics) io.out(`${formatDiagnostic(d)}\n`);
        io.out(`maps: ${report.errors} error(s), ${report.warnings} warning(s)\n`);
      } else {
        io.out(json(report));
      }
      return report.errors > 0 ? 1 : 0;
    }
    case "view": {
      if (island === undefined) throw new UsageError("view needs an island");
      const floor = parseFloor(values.floor);
      const area = parseArea(values.area);
      const { world, diagnostics } = loadWorld(root);
      const loadErrors = errorsAbout(diagnostics, island);
      const found = world.islands.get(island);
      if (!found) return missingIsland(io, island, loadErrors);
      const view = viewArea(found, floor, area);
      if (values.format === "text") {
        io.out(renderAsciiView(view));
        for (const e of loadErrors) io.err(`${e}\n`);
      } else {
        io.out(json({ ...view, load_errors: loadErrors }));
      }
      return loadErrors.length > 0 ? 1 : 0;
    }
    case "render": {
      const id = needIsland();
      const floor = parseFloor(values.floor);
      const out = need(values.out, "--out FILE.png");
      const tile = values.tile === undefined ? undefined : parseCount(values.tile, "--tile", 32, 1);
      if (tile !== undefined && !(TILE_SIZES as readonly number[]).includes(tile))
        throw new UsageError(`--tile must be one of ${TILE_SIZES.join(", ")}`);
      const { world, diagnostics } = loadWorld(root);
      const loadErrors = errorsAbout(diagnostics, id);
      const found = world.islands.get(id);
      if (!found) return missingIsland(io, id, loadErrors);
      const area = values.area === undefined ? found.meta.rect : parseArea(values.area);
      if (area.w > MAX_RENDER_SIZE || area.h > MAX_RENDER_SIZE)
        throw new UsageError(`--area is at most ${MAX_RENDER_SIZE}x${MAX_RENDER_SIZE} for render`);
      const r = renderArea(world, loadContent(root), loadFrames(root), {
        floor,
        area,
        ...(tile === undefined ? {} : { tile }),
        overlays: !values["no-overlays"],
        grid: !values["no-grid"],
      });
      writeFileSync(out, r.png);
      io.out(
        json({
          out,
          island: id,
          floor,
          area,
          width: r.width,
          height: r.height,
          tile: r.tile,
          legend: r.legend,
          missing_sprites: r.missing,
          load_errors: loadErrors,
        }),
      );
      return loadErrors.length > 0 ? 1 : 0;
    }
    case "paint":
      return edit(
        [
          {
            op: "paint_ground",
            floor: parseFloor(values.floor),
            rect: parseArea(need(values.rect, "--rect"), "--rect"),
            item: need(values.ground, "--ground"),
          },
        ],
        [needIsland()],
      );
    case "erase": {
      const layer = values.layer ?? "all";
      if (layer !== "ground" && layer !== "items" && layer !== "all")
        throw new UsageError("--layer must be ground, items or all");
      return edit(
        [
          {
            op: "erase",
            floor: parseFloor(values.floor),
            rect: parseArea(need(values.rect, "--rect"), "--rect"),
            layer,
          },
        ],
        [needIsland()],
      );
    }
    case "fill":
      return edit(
        [{ op: "fill", pos: parsePos(values.pos), item: need(values.ground, "--ground") }],
        [needIsland()],
      );
    case "place":
    case "remove": {
      const index =
        values.index === undefined ? {} : { index: parseCount(values.index, "--index", 0) };
      const op = command === "place" ? "place_item" : "remove_item";
      return edit(
        [{ op, pos: parsePos(values.pos), item: need(values.item, "--item"), ...index }],
        [needIsland()],
      );
    }
    case "autoborder": {
      const id = needIsland();
      const floor = parseFloor(values.floor);
      const rect =
        values.rect === undefined ? islandRect(root, id) : parseArea(values.rect, "--rect");
      return edit([{ op: "autoborder", floor, rect }], [id]);
    }
    case "stamp":
      return edit(
        [{ op: "stamp", pos: parsePos(values.pos), prefab: need(values.prefab, "--prefab") }],
        [needIsland()],
      );
    case "spawn": {
      const id = needIsland();
      if (sub === "add") {
        const pos = parsePos(values.pos);
        const monster = need(values.monster, "--monster");
        return edit(
          [
            {
              op: "add_spawn",
              id: values.id ?? `${id}_${monster}_${pos.x}_${pos.y}`,
              center: pos,
              radius: parseCount(values.radius, "--radius", 3),
              monsters: [{ monster, count: parseCount(values.count, "--count", 1, 1) }],
              respawn_seconds: parseCount(values.respawn, "--respawn", 60, 1),
            },
          ],
          [id],
        );
      }
      if (sub === "remove")
        return edit([{ op: "remove_spawn", id: need(values.id, "--id") }], [id]);
      throw new UsageError("spawn needs add or remove");
    }
    case "zone": {
      const id = needIsland();
      if (sub === "add") {
        const rect = parseArea(need(values.rect, "--rect"), "--rect");
        const type = need(values.type, "--type");
        if (!(ZONE_TYPES as readonly string[]).includes(type))
          throw new UsageError(`--type must be one of ${ZONE_TYPES.join(", ")}`);
        return edit(
          [
            {
              op: "add_zone",
              id: values.id ?? `${id}_${type}_${rect.x}_${rect.y}`,
              type: type as ZoneType,
              floors: parseFloors(values.floor),
              rects: [rect],
            },
          ],
          [id],
        );
      }
      if (sub === "remove") return edit([{ op: "remove_zone", id: need(values.id, "--id") }], [id]);
      throw new UsageError("zone needs add or remove");
    }
    case "npc": {
      const id = needIsland();
      if (sub === "place")
        return edit(
          [{ op: "place_npc", npc: need(values.npc, "--npc"), pos: parsePos(values.pos) }],
          [id],
        );
      if (sub === "remove")
        return edit([{ op: "remove_npc", npc: need(values.npc, "--npc") }], [id]);
      throw new UsageError("npc needs place or remove");
    }
    case "ops": {
      if (sub !== "apply") throw new UsageError("ops needs apply");
      const file = island ?? "";
      if (file === "") throw new UsageError("ops apply needs a file (or - for stdin)");
      const text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
      return edit(parseOps(text), values.island === undefined ? undefined : [values.island]);
    }
    case "generate": {
      const id = needIsland();
      const recipe = need(values.recipe, "--recipe");
      if (!(RECIPES as readonly string[]).includes(recipe))
        throw new UsageError(`--recipe must be one of ${RECIPES.join(", ")}`);
      const floor = values.floor === undefined ? 7 : parseFloor(values.floor);
      const seed = parseCount(need(values.seed, "--seed"), "--seed", 0);
      const size = parseCount(need(values.size, "--size"), "--size", 0, 1);
      const { world } = loadWorld(root);
      const found = world.islands.get(id);
      if (!found) return missingIsland(io, id, []);
      const area = found.meta.rect;
      const hasTiles = [...found.chunks.keys()].some((k) => k.startsWith(`${floor}/`));
      if (hasTiles && !values.force) {
        io.out(
          json({
            ok: false,
            error: `island "${id}" already has tiles on floor ${floor}; pass --force to overwrite them`,
          }),
        );
        return 1;
      }
      let ops: MapOp[];
      try {
        ops = generate({ recipe: recipe as Recipe, area, floor, seed, size });
      } catch (e) {
        if (e instanceof RangeError) throw new UsageError(e.message);
        throw e;
      }
      // --force: clear the floor's items first, so old decoration does not float on water.
      if (hasTiles) ops.unshift({ op: "erase", floor, rect: { ...area }, layer: "items" });
      return edit(ops, [id]);
    }
    case "pr-check": {
      if (island !== undefined) throw new UsageError(`unexpected argument "${island}"`);
      const r = prCheck({
        root,
        base: need(values.base, "--base REF"),
        head: need(values.head, "--head REF"),
        out: resolve(need(values.out, "--out DIR")),
        ...(values.author === undefined ? {} : { author: values.author }),
        ...(values.association === undefined ? {} : { association: values.association }),
        ...(values["head-repo"] === undefined ? {} : { headRepo: values["head-repo"] }),
        ...(values.repo === undefined ? {} : { repo: values.repo }),
        ...(values.pr === undefined ? {} : { pr: parseCount(values.pr, "--pr", 0, 1) }),
      });
      io.out(
        json({
          ok: r.ok,
          failures: r.failures,
          files: r.files.length,
          plot_violations: r.plots.violations.length,
          areas: r.areas.length,
          out: values.out,
        }),
      );
      return r.ok ? 0 : 1;
    }
    case "patch": {
      if (sub === "create") {
        const patch = createPatch(root, values.against, island);
        const text = `${JSON.stringify(patch, null, 2)}\n`;
        if (values.out !== undefined) {
          writeFileSync(values.out, text);
          io.out(
            json({
              out: values.out,
              base_ref: patch.base_ref,
              files: patch.files.map((f) => f.path),
            }),
          );
        } else io.out(text);
        return 0;
      }
      const file = island;
      if (file === undefined) throw new UsageError(`patch ${sub ?? ""} needs a patch file`);
      const patch = parsePatch(readFileSync(file, "utf8"));
      if (sub === "diff") {
        const files = diffPatch(root, patch);
        io.out(json({ base_ref: patch.base_ref, files }));
        return files.every((f) => !f.conflicts) ? 0 : 1;
      }
      if (sub === "apply") {
        const plan = planPatch(root, patch);
        const files = plan.files.map((f) => ({ path: f.path, merged: f.merged }));
        if (plan.conflicts.length > 0 && !values.partial) {
          io.out(
            json({
              ok: false,
              error: "the patch conflicts with the current files; nothing was written",
              conflicts: plan.conflicts,
            }),
          );
          return 1;
        }
        if (dryRun) {
          io.out(json({ ok: true, dry_run: true, files, conflicts: plan.conflicts }));
          return 0;
        }
        const done = writePlanned(root, plan.files);
        const v = validateWorld(root);
        io.out(
          json({
            ok: true,
            ...done,
            merged: files.filter((f) => f.merged).map((f) => f.path),
            conflicts: plan.conflicts,
            validation: {
              errors: v.errors,
              warnings: v.warnings,
              diagnostics: v.diagnostics.slice(0, 50).map(formatDiagnostic),
            },
          }),
        );
        return 0;
      }
      throw new UsageError("patch needs create, diff or apply");
    }
    case undefined:
      throw new UsageError("missing command");
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

function islandRect(root: string, id: string): Rect {
  const found = loadWorld(root).world.islands.get(id);
  if (!found) throw new UsageError(`island "${id}" not found or failed to load`);
  return { ...found.meta.rect };
}

function report(io: Io, outcome: EditOutcome): number {
  io.out(json(outcome));
  return outcome.ok ? 0 : 1;
}

/** Load errors (formatted) for the whole world, or for one island's files and world.yaml. */
function errorsAbout(diagnostics: Diagnostic[], island: string | undefined): string[] {
  const prefix = island === undefined ? "" : `world/islands/${island}/`;
  return diagnostics
    .filter(
      (d) => d.severity === "error" && (d.file.startsWith(prefix) || d.file === "world/world.yaml"),
    )
    .map(formatDiagnostic);
}

function missingIsland(io: Io, island: string, errors: string[]): number {
  io.out(json({ error: `island "${island}" not found or failed to load`, errors }));
  return 1;
}
