// Map tile art (docs/17 ART-3, ART-4, ART-7): the `tiles` section of assets/sprites.yaml and
// atlas.json. A map sprite can have, next to it, sprites named
//   <sprite>/var_<n>     alternate looks of a ground (n = 1..), picked per tile by a hash;
//   <sprite>/decal_<n>   sparse details of a ground (n = 1..), transparent, laid flat on a
//                        few of its tiles (a shell, a flower: ground art, not items);
//   <sprite>/frame_<n>   more frames of an animated sprite (n = 1..; the sprite is frame 0);
//   <sprite>/wall_<m>    the 16 pieces of a wall, one per mask of wall neighbours (N=1,
//                        E=2, S=4, W=8), all of them;
//   <sprite>/shadow      its cast shadow, drawn translucent under the items.
// Every sprite under borders/ (the border pieces, gen-borders) is `flat`: a decal on its
// tile's ground that the renderer draws with the grounds, under shadows and creatures.
// spritepack finds them by name (own art or `sprites` entries) and writes what each sprite
// has into atlas.json `tiles`; the `tiles` section of sprites.yaml adds what names cannot
// say: the timing of an animation, a centred anchor, that a door joins the walls, the
// share of the main look, the light it gives, the ambient particles it gives off and what a
// step on it kicks up. packages/renderer tile-art.ts reads it (same TileMeta shape).

export type TileSync = "world" | "tile" | "random";

/** Ambient particles (docs/17 ART-7, A13): same list as PARTICLE_KINDS in tile-art.ts. */
export const PARTICLE_KINDS = ["embers", "pollen", "spray", "dust"] as const;
export type ParticleKind = (typeof PARTICLE_KINDS)[number];
/** What a step on a ground kicks up (docs/17 MOV-7): same list as STEP_KINDS in tile-art.ts. */
export const STEP_KINDS = ["dust", "ripple"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** atlas.json `tiles[sprite]`: see TileMeta in packages/renderer tile-art.ts. */
export interface TileMeta {
  variants?: number;
  decals?: number;
  weight?: number;
  frames?: number;
  ms?: number;
  sync?: TileSync;
  anchor?: "bc";
  wall?: true;
  joins?: true;
  shadow?: true;
  light?: number;
  particles?: ParticleKind;
  steps?: StepKind;
  flat?: true;
}

/** One entry of the `tiles` section of assets/sprites.yaml. */
export interface TileEntry {
  ms?: number;
  sync?: TileSync;
  anchor?: "bc";
  joins?: true;
  weight?: number;
  /** Radius of the light it gives in dark places (caves), tiles. */
  light?: number;
  /** Ambient particles the client spawns around it. */
  particles?: ParticleKind;
  /** A ground: what each step on it kicks up (a puff of dust, a ripple). */
  steps?: StepKind;
}

/**
 * A part's name: <base>/var_<n>, decal_<n>, frame_<n>, wall_<mask> or shadow (same as
 * tile-art.ts).
 */
export const TILE_PART = /^(.+)\/(var|decal|frame|wall|shadow)(?:_([0-9]+))?$/;
export const WALL_PIECES = 16;
/** The sprites under this directory are flat (TileMeta flat): the border pieces. */
export const FLAT_DIR = "borders/";
/** Frame times allowed in sprites.yaml, ms. */
export const MIN_FRAME_MS = 50;
export const MAX_FRAME_MS = 5000;

const ENTRY_KEYS = new Set([
  "ms",
  "sync",
  "anchor",
  "joins_walls",
  "weight",
  "light",
  "particles",
  "steps",
  "notes",
]);
/** Largest light radius, tiles. */
export const MAX_LIGHT = 8;

export function parseTileEntry(
  raw: unknown,
  fail: (message: string) => void,
): TileEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("tile entry must be a mapping");
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!ENTRY_KEYS.has(key)) fail(`unknown key "${key}"`);
  const entry: TileEntry = {};
  if (r["ms"] !== undefined) {
    const ms = r["ms"];
    if (typeof ms !== "number" || !Number.isInteger(ms) || ms < MIN_FRAME_MS || ms > MAX_FRAME_MS)
      fail(`ms must be a whole number of ms from ${MIN_FRAME_MS} to ${MAX_FRAME_MS}`);
    else entry.ms = ms;
  }
  if (r["sync"] !== undefined) {
    const sync = r["sync"];
    if (sync === "world" || sync === "tile" || sync === "random") entry.sync = sync;
    else fail("sync must be world, tile or random");
  }
  if (r["anchor"] !== undefined) {
    if (r["anchor"] === "bc") entry.anchor = "bc";
    else if (r["anchor"] !== "br") fail("anchor must be br or bc");
  }
  if (r["joins_walls"] !== undefined) {
    if (r["joins_walls"] === true) entry.joins = true;
    else if (r["joins_walls"] !== false) fail("joins_walls must be true or false");
  }
  if (r["weight"] !== undefined) {
    const w = r["weight"];
    if (typeof w !== "number" || !(w > 0) || !(w < 1)) fail("weight must be between 0 and 1");
    else entry.weight = w;
  }
  if (r["light"] !== undefined) {
    const l = r["light"];
    if (typeof l !== "number" || !(l > 0) || l > MAX_LIGHT)
      fail(`light must be a radius in tiles, above 0 and up to ${MAX_LIGHT}`);
    else entry.light = l;
  }
  if (r["particles"] !== undefined) {
    const k = PARTICLE_KINDS.find((p) => p === r["particles"]);
    if (k) entry.particles = k;
    else fail(`particles must be one of ${PARTICLE_KINDS.join(", ")}`);
  }
  if (r["steps"] !== undefined) {
    const k = STEP_KINDS.find((p) => p === r["steps"]);
    if (k) entry.steps = k;
    else fail(`steps must be one of ${STEP_KINDS.join(", ")}`);
  }
  if (r["notes"] !== undefined && typeof r["notes"] !== "string") fail("notes must be a string");
  return entry;
}

/**
 * What every map sprite has, from the names of the sprites in the atlas and the `tiles`
 * entries. Problems are returned (as `sprite: message`) for the caller to report.
 */
export function tileMetas(
  names: Iterable<string>,
  entries: Map<string, TileEntry>,
): { tiles: Record<string, TileMeta>; problems: { sprite: string; message: string }[] } {
  const all = new Set(names);
  const problems: { sprite: string; message: string }[] = [];
  const parts = new Map<string, { kind: string; n: number | undefined; name: string }[]>();
  for (const name of all) {
    const m = TILE_PART.exec(name);
    if (!m?.[1] || !m[2]) continue;
    const kind = m[2];
    const n = m[3] === undefined ? undefined : Number(m[3]);
    // shadow takes no number, the others need one (a plain <sprite>/frame is just a sprite).
    if ((kind === "shadow") !== (n === undefined)) continue;
    const list = parts.get(m[1]) ?? [];
    list.push({ kind, n, name });
    parts.set(m[1], list);
  }
  const tiles: Record<string, TileMeta> = {};
  const bases = [...new Set([...parts.keys(), ...entries.keys()])].sort();
  for (const base of bases) {
    const list = parts.get(base) ?? [];
    const entry = entries.get(base);
    const fail = (message: string): void => {
      problems.push({ sprite: base, message });
    };
    if (!all.has(base)) {
      fail(
        list.length > 0
          ? `${list[0]?.name ?? base} needs the sprite ${base} itself`
          : "a tiles entry needs a sprite of that name",
      );
      continue;
    }
    const numbers = (kind: string): number[] =>
      list
        .filter((p) => p.kind === kind)
        .map((p) => p.n ?? 0)
        .sort((a, b) => a - b);
    const meta: TileMeta = {};
    const run = (kind: string): number => {
      const ns = numbers(kind);
      if (ns.length === 0) return 0;
      if (ns.some((n, i) => n !== i + 1))
        fail(`${kind}_<n> must be ${kind}_1..${kind}_${ns.length} without gaps`);
      return ns.length;
    };
    const variants = run("var");
    if (variants > 0) meta.variants = variants;
    const decals = run("decal");
    if (decals > 0) meta.decals = decals;
    const frames = run("frame");
    if (frames > 0) meta.frames = frames + 1;
    const walls = numbers("wall");
    if (walls.length > 0) {
      if (walls.length !== WALL_PIECES || walls.some((n, i) => n !== i))
        fail(`a wall needs all ${WALL_PIECES} pieces wall_0..wall_${WALL_PIECES - 1}`);
      else meta.wall = true;
    }
    if (numbers("shadow").length > 0) meta.shadow = true;
    if (entry) {
      if ((entry.ms !== undefined || entry.sync !== undefined) && frames === 0)
        fail("ms and sync need frames (<sprite>/frame_1..)");
      if (entry.weight !== undefined && variants === 0)
        fail("weight needs variants (<sprite>/var_1..)");
      if (entry.ms !== undefined) meta.ms = entry.ms;
      if (entry.sync !== undefined) meta.sync = entry.sync;
      if (entry.weight !== undefined) meta.weight = entry.weight;
      if (entry.anchor) meta.anchor = entry.anchor;
      if (entry.light !== undefined) meta.light = entry.light;
      if (entry.particles) meta.particles = entry.particles;
      if (entry.steps) meta.steps = entry.steps;
      if (entry.joins) {
        if (meta.wall) fail("a wall already joins its neighbours: drop joins_walls");
        else meta.joins = true;
      }
    }
    if (Object.keys(meta).length > 0) tiles[base] = meta;
  }
  // An animated sprite with looks (the surf, docs/17 ART-4): every look plays its own frames,
  // <sprite>/var_<n>/frame_<m>, as many as the sprite's. They are part of the sprite's entry.
  const folded = new Set<string>();
  for (const [base, meta] of Object.entries(tiles)) {
    const m = TILE_PART.exec(base);
    if (m?.[2] !== "var" || !m[1] || meta.frames === undefined) continue;
    if (tiles[m[1]]?.frames !== meta.frames)
      problems.push({
        sprite: base,
        message: `a look's frames go with the sprite's: ${m[1]} needs frame_1..frame_${meta.frames - 1} too`,
      });
    if (Object.keys(meta).length === 1) folded.add(base);
  }
  for (const [base, meta] of Object.entries(tiles)) {
    if (!meta.variants || !meta.frames) continue;
    const frames = meta.frames;
    const missing = Array.from({ length: meta.variants }, (_, i) => i + 1)
      .flatMap((n) =>
        Array.from({ length: frames - 1 }, (_, f) => `${base}/var_${n}/frame_${f + 1}`),
      )
      .find((name) => !all.has(name));
    if (missing)
      problems.push({
        sprite: base,
        message: `an animated sprite's looks need their frames: ${missing} is missing`,
      });
  }
  // The border pieces lie flat on their tile's ground (the renderer draws them with it).
  for (const name of all)
    if (name.startsWith(FLAT_DIR) && !isPart(name)) tiles[name] = { ...tiles[name], flat: true };
  return {
    tiles: Object.fromEntries(
      Object.entries(tiles)
        .filter(([base]) => !folded.has(base))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    problems,
  };
}

/** Whether a sprite name is a part of another sprite (a look, a frame, a wall piece, a shadow). */
function isPart(name: string): boolean {
  const m = TILE_PART.exec(name);
  return m?.[2] !== undefined && (m[2] === "shadow") === (m[3] === undefined);
}
