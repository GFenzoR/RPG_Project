// What `spritegen check` and the tests ask of every engine spec: a valid spec, frames that
// pass the quality gates, and assets/sprites.yaml hints that match the rig, so the client
// plays the frames as the spec means them (no client change: atlas.json `anims`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE, parseManifest } from "@rpg/spritepack";
import type { AnimEntry, TileEntry } from "@rpg/spritepack";
import { gateProblems } from "./gates.ts";
import { canvasOf } from "./render.ts";
import type { SpriteSpec } from "./spec.ts";
import { ENGINE_SPECS } from "./specs/index.ts";
import type { ActionName } from "./style.ts";

/**
 * What the manifest must say about an engine sprite. A creature: an `animations` entry with
 * no layers, `anchor` of its size class, `shadow: ellipse` (the frames paint none), `flying`
 * as the spec, no `facing` or `mirror` (the four facings are drawn) and the `ms` of every
 * action that plays by time. An animated prop (an object with a loop, ART-7): a `tiles`
 * entry with the loop's `ms` and `sync`; an object without one has no timing there. Any
 * sprite: no `sprites` entry (its pixels are files).
 */
export function hintProblems(
  spec: SpriteSpec,
  entry: AnimEntry | undefined,
  inSprites: boolean,
  tile?: TileEntry,
): string[] {
  const out: string[] = [];
  const bad = (msg: string): void => {
    out.push(`${spec.sprite}: ${MANIFEST_FILE} ${msg}`);
  };
  if (inSprites) bad("must not list it under sprites: the engine draws its files");
  const { size } = canvasOf(spec);
  if (!spec.actions) {
    if (entry) bad("has animations hints for an object (only creatures have them)");
    const loop = spec.loop;
    if (loop && (tile?.ms !== loop.ms || tile.sync !== loop.sync))
      bad(`needs tiles: ${spec.sprite}: { ms: ${loop.ms}, sync: ${loop.sync} } (its loop's)`);
    if (!loop && (tile?.ms !== undefined || tile?.sync !== undefined))
      bad("has tiles ms or sync for an object the engine draws as one image");
    return out;
  }
  if (!entry) {
    bad(`needs animations: ${spec.sprite}: { anchor: ${size.anchor}, shadow: ellipse, ms: {...} }`);
    return out;
  }
  if (entry.layers.length) bad("animations entry must have no layers");
  if ((entry.anchor ?? "br") !== size.anchor) bad(`anchor must be ${size.anchor}`);
  // A paper-doll layer casts no shadow of its own: the body's ellipse is the figure's.
  const shadow = spec.layer ? "none" : "ellipse";
  if (entry.shadow !== shadow)
    bad(
      `shadow must be ${shadow}${spec.layer ? " (a layer over the body)" : " (the frames paint none)"}`,
    );
  if (entry.perTile !== spec.perTile)
    bad(
      `per_tile must be ${String(spec.perTile)} (the rig's stride${spec.perTile ? "" : ": none"})`,
    );
  if (entry.perTileNS !== spec.perTileNS)
    bad(`per_tile_ns must be ${String(spec.perTileNS)} (per_tile over the 3/4 depth)`);
  const trim = Boolean(spec.trim);
  if (Boolean(entry.trim) !== trim)
    bad(`trim must be ${trim}${trim ? " (paper-doll frames are packed cropped, docs/07)" : ""}`);
  if (entry.facing) bad("must not have facing: the four facings are drawn");
  if (entry.mirror) bad("must not have mirror: the four facings are drawn (and keep the light)");
  if (Boolean(entry.flying) !== Boolean(spec.flying)) bad(`flying must be ${Boolean(spec.flying)}`);
  for (const [action, a] of Object.entries(spec.actions) as [ActionName, { ms?: number }][]) {
    if (action === "walk") continue;
    if (entry.ms?.[action] !== a.ms) bad(`ms.${action} must be ${a.ms} (the rig's)`);
  }
  for (const action of Object.keys(entry.ms ?? {}))
    if (!(action in spec.actions)) bad(`ms.${action} for an action the rig does not have`);
  return out;
}

/** Every problem of the engine specs against the repo at root. */
export function engineProblems(
  root: string,
  specs: readonly SpriteSpec[] = ENGINE_SPECS,
): string[] {
  const { manifest, errors } = parseManifest(readFileSync(join(root, MANIFEST_FILE), "utf8"));
  const out = errors.map((e) => `${MANIFEST_FILE}: ${e.message}`);
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.sprite)) out.push(`${spec.sprite}: two engine specs draw it`);
    seen.add(spec.sprite);
    out.push(...gateProblems(spec));
    out.push(
      ...hintProblems(
        spec,
        manifest.animations.get(spec.sprite),
        manifest.sprites.has(spec.sprite),
        manifest.tiles.get(spec.sprite),
      ),
    );
  }
  return out;
}
