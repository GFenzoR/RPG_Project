// mapcli: map tooling over @rpg/map-format (tools/CLAUDE.md). Output is JSON on stdout
// unless --format text is given, so humans, scripts and AIs can chain it.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  MAX_VIEW_SIZE,
  formatDiagnostic,
  islandInfo,
  loadWorld,
  renderAsciiView,
  validateWorld,
  viewArea,
  worldInfo,
} from "@rpg/map-format";
import type { Rect } from "@rpg/map-format";

export const USAGE = `usage: mapcli <command> [options]   (global: --root DIR, default ".")
  info [island]                                 world or island summary
  fmt [island] [--check]                        rewrite map files in canonical form
  validate [island] [--format json|text]        same validator as the editor and make validate
  view <island> --floor Z --area x,y,w,h [--format json|text]   ASCII view (max ${MAX_VIEW_SIZE}x${MAX_VIEW_SIZE})`;

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

function parseArea(s: string | undefined): Rect {
  const parts = (s ?? "").split(",").map((p) => Number(p.trim()));
  const [x, y, w, h] = parts;
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n)) ||
    x === undefined ||
    y === undefined ||
    w === undefined ||
    h === undefined ||
    w < 1 ||
    h < 1
  )
    throw new UsageError("--area must be x,y,w,h with integers and w,h >= 1");
  return { x, y, w, h };
}

function parseFloor(s: string | undefined): number {
  const z = Number(s);
  if (s === undefined || !Number.isInteger(z) || z < 0 || z > 15)
    throw new UsageError("--floor must be an integer 0..15");
  return z;
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
    },
  });
  const [command, island, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  if (values.format !== "json" && values.format !== "text")
    throw new UsageError("--format must be json or text");
  const root = resolve(values.root);

  switch (command) {
    case "info": {
      const { world, diagnostics } = loadWorld(root);
      if (island === undefined) {
        io.out(
          json({
            ...worldInfo(world),
            load_errors: diagnostics.filter((d) => d.severity === "error").length,
          }),
        );
        return 0;
      }
      const found = world.islands.get(island);
      if (!found) return missingIsland(io, island, diagnostics.map(formatDiagnostic));
      io.out(json(islandInfo(found)));
      return 0;
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
      const found = world.islands.get(island);
      if (!found) return missingIsland(io, island, diagnostics.map(formatDiagnostic));
      const view = viewArea(found, floor, area);
      io.out(values.format === "text" ? renderAsciiView(view) : json(view));
      return 0;
    }
    case undefined:
      throw new UsageError("missing command");
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

function missingIsland(io: Io, island: string, errors: string[]): number {
  io.out(json({ error: `island "${island}" not found or failed to load`, errors }));
  return 1;
}
