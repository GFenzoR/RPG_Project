// Real map patches for the worker's tests, built from the repo's own world/ (Puerto's
// community plot, puerto_north_shore_plot: x 3200–3215, y 6296–6307, floor 7).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_SIZE, formatChunk, parseChunk, patchHash } from "@rpg/map-format";
import type { Submission } from "../src/build.ts";

export const ROOT = join(import.meta.dirname, "..", "..", "..");
export const PLOT_CHUNK = "world/islands/puerto/chunks/z07/c0100_0196.json";

/** A file of the repo (null when it does not exist): the fake GitHub's base. */
export function readRepo(path: string): string | null {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch {
    return null;
  }
}

/** The chunk's text with the ground of (x, y) changed. */
export function paint(text: string, x: number, y: number, ground: string): string {
  const c = parseChunk(text, "chunk");
  if (!c) throw new Error("fixture chunk does not parse");
  const lx = x - c.cx * CHUNK_SIZE;
  const ly = y - c.cy * CHUNK_SIZE;
  c.ground[ly * CHUNK_SIZE + lx] = ground;
  return formatChunk(c);
}

/** A format 2 patch of one file from `base` to `content`. */
export function patchOf(
  path: string,
  base: string | null,
  content: string | null,
  extra = {},
): string {
  return JSON.stringify({
    format: 2,
    kind: "rpg-map-patch",
    base_ref: "0123456789abcdef0123456789abcdef01234567",
    files: [
      base === null
        ? { path, base: null, content }
        : { path, base: patchHash(base), base_text: base, content },
    ],
    ...extra,
  });
}

/** A submission painting grass on a tile of the plot. */
export function plotSubmission(id = 7, x = 3202, y = 6298): Submission {
  const base = readRepo(PLOT_CHUNK);
  if (base === null) throw new Error("fixture chunk missing");
  return {
    id,
    title: "Pasto en la playa norte",
    description: "Un rincón de pasto.\n@everyone mira esto ``` y [un link](https://example.com)",
    author: "Cartographer Aria",
    sha256: "a".repeat(64),
    baseRef: "0123456789abcdef0123456789abcdef01234567",
    patch: patchOf(PLOT_CHUNK, base, paint(base, x, y, "grass")),
    reviewedAt: new Date("2026-11-05T12:00:00Z"),
  };
}
