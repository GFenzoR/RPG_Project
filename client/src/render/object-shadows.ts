// Cast shadows of the map's objects (owner, 2026-11-25: "this dynamic shadow for every
// object, trees included"): every map item with height (ItemDef.shadow, resolved from
// data/livingworld/shadows.yaml) casts a shadow in the same sun or moon pose as the
// creatures (render/sky.ts, render/cast-shadows.ts), in the creatures' own layer: one
// container, opaque dark sprites, faded as a whole through one AlphaFilter, so a tree's
// shadow crossing a wall's or a creature's makes one even shade and never a darker patch.
// They replace the baked <sprite>/shadow art in the game (MapView.castShadowStrength 0).
//
// - silhouette: the item's own texture laid on the ground from its base (the row its
//   drawing ends on: atlas.json `feet`), skewed and squashed like a creature's.
// - a plant in the wind (livingworld wind-mesh.ts): a second mesh on the plant's own strip
//   geometry, so the crown's shadow sways with the crown and the trunk's stays; it costs
//   nothing per frame here (the geometry is the plant's).
// - block (walls, gates): the box over the tile, drawn as the two sides of its sweep that
//   show (its north edge and its east or west edge swept along the shadow). Neighbouring
//   walls' sweeps overlap exactly, so a building's shadow is one piece without gaps.
//
// Indoors (MapView.indoorAt) nothing casts, and what falls in from outside is hidden by the
// indoor ground, which MapView draws over this layer. A shadow that reaches a wall is drawn
// under it (the layer is under the items): it is cut by the wall's drawing, not bent up it.
//
// Cheap (docs/07): shadows are made when their chunk is built and freed when it goes
// (sprites from a pool, textures the items' own), and placed again only when the sun has
// moved POSE_STEP or the map changed; a frame in between touches nothing.
import { Container, Mesh, Sprite, Texture } from "pixi.js";
import type { MeshGeometry } from "pixi.js";
import { CAST_SHADOW_TINT } from "@rpg/renderer";
import { feetAnchor } from "./cast-shadows.ts";
import type { ShadowPose } from "./cast-shadows.ts";

/** How an item casts (ItemDef.shadow) and where its drawing ends. */
export interface ObjectShadowHint {
  cast: "silhouette" | "block";
  /** silhouette: share of the full length. */
  length: number;
  /** block: the box's height, sprite px (absent: what the texture rises over a tile). */
  height?: number | undefined;
  /** silhouette: transparent rows under the drawing (atlas.json `feet`). */
  foot: number;
}

/** The map as the shadows read it (packages/renderer MapView). */
export interface ShadowMap {
  readonly version: number;
  forEachItemSprite(fn: (x: number, y: number, key: string, sprite: Sprite) => void): void;
  indoorAt(x: number, y: number): boolean;
}

/** The wind's strips of a map sprite, when it sways now (livingworld windStrips). */
export interface ShadowWind {
  version(): number;
  strips(sprite: Sprite): { view: { geometry: MeshGeometry } } | undefined;
}

/** The sun must move this far (shadow length per unit of height) to place the shadows again. */
export const POSE_STEP = 1 / 64;
/** A box lower than this casts no block shadow, sprite px. */
const MIN_BLOCK_PX = 2;

interface Entry {
  item: Sprite;
  x: number;
  y: number;
  hint: ObjectShadowHint;
  /** silhouette: the sprite or the wind mesh. block: the north edge's sweep. */
  main: Sprite | Mesh | undefined;
  /** silhouette: the strips its mesh draws (undefined: a sprite). */
  geometry: MeshGeometry | undefined;
  /** block: the east or west edge's sweep. */
  side: Sprite | undefined;
  seen: number;
}

const tileKey = (x: number, y: number): number => y * 65536 + x;

/**
 * Where the north edge's sweep of a box `height` px high over tile (x, y) lies: a
 * `tile` x `height` upright rectangle on the tile's north edge, laid down by the pose.
 */
export function blockNorth(
  x: number,
  y: number,
  tile: number,
  height: number,
  pose: ShadowPose,
  out: { x: number; y: number; scaleX: number; scaleY: number; skewX: number },
): void {
  out.x = x * tile;
  out.y = y * tile;
  out.scaleX = tile;
  out.scaleY = height * pose.scaleY;
  out.skewX = pose.skewX;
}

/**
 * Where the side edge's sweep lies: the tile's east edge when the shadow falls east, its
 * west edge when west, swept `height` times the pose's cast. `width` 0: nothing to draw.
 */
export function blockSide(
  x: number,
  y: number,
  tile: number,
  height: number,
  pose: ShadowPose,
  out: { x: number; y: number; width: number; skewY: number },
): void {
  const vx = height * pose.x;
  const vy = -height * pose.y;
  out.x = (vx > 0 ? x + 1 : x) * tile;
  out.y = y * tile;
  out.width = Math.abs(vx) < 0.5 ? 0 : Math.hypot(vx, vy);
  out.skewY = Math.atan2(vy, vx);
}

export class ObjectShadows {
  /** Mounted in the creatures' shadow layer (CastShadows.mount), under their sprites. */
  readonly root = new Container({ label: "object shadows" });
  private readonly entries = new Map<Sprite, Entry>();
  private readonly free: Sprite[] = [];
  private readonly blocks = new Map<number, number>();
  private mapVersion = -1;
  private windVersion = -1;
  private pass = 0;
  private stale = true;
  private poseX = Number.NaN;
  private poseY = Number.NaN;
  private readonly north = { x: 0, y: 0, scaleX: 0, scaleY: 0, skewX: 0 };
  private readonly sideBox = { x: 0, y: 0, width: 0, skewY: 0 };
  /** Sprites and meshes made since the layer was created (tests, perf). */
  made = 0;
  /** How many times the shadows were placed (tests: not every frame). */
  placed = 0;

  constructor(
    private readonly tile: number,
    private readonly hintOf: (key: string) => ObjectShadowHint | undefined,
  ) {}

  /** Shadows drawn now: sprites and meshes (tests, perf, the E2E hook). */
  get count(): number {
    return this.root.visible ? this.root.children.length : 0;
  }

  /** Objects that cast now (a wall counts once, with one or two sprites). */
  get casters(): number {
    return this.root.visible ? this.entries.size : 0;
  }

  /** Shadows that sway with their plant now: the meshes on the wind's strips. */
  get swaying(): number {
    if (!this.root.visible) return 0;
    let n = 0;
    for (const e of this.entries.values()) if (e.geometry) n++;
    return n;
  }

  /**
   * A frame: `pose` undefined (underground, no sun or moon up) hides them all. Otherwise
   * the shadows of the chunks built since the last frame are made, the ones of the chunks
   * gone are freed, and all are placed again if the map changed or the sun moved POSE_STEP.
   * Call after the map's render and the living world's tick (the wind's strips exist).
   */
  update(map: ShadowMap, pose: ShadowPose | undefined, wind?: ShadowWind): void {
    if (!pose) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    const wv = wind?.version() ?? 0;
    if (map.version !== this.mapVersion || wv !== this.windVersion) {
      this.mapVersion = map.version;
      this.windVersion = wv;
      this.sync(map, wind);
      this.stale = true;
    }
    if (
      this.stale ||
      Math.abs(pose.x - this.poseX) >= POSE_STEP ||
      Math.abs(pose.y - this.poseY) >= POSE_STEP
    ) {
      this.poseX = pose.x;
      this.poseY = pose.y;
      this.stale = false;
      this.place(pose);
    }
  }

  /**
   * Makes the shadows of the item sprites that are new and frees those of the ones gone:
   * the gone first, so the chunk that comes draws with the sprites of the chunk that left.
   */
  private sync(map: ShadowMap, wind: ShadowWind | undefined): void {
    const pass = ++this.pass;
    this.blocks.clear();
    map.forEachItemSprite((x, y, key, item) => {
      const hint = this.hintOf(key);
      if (!hint) return;
      if (hint.cast === "block") this.blocks.set(tileKey(x, y), 1);
      // Indoors nothing casts (a bed, a table); a wall always does, toward the outside.
      else if (map.indoorAt(x, y)) return;
      let e = this.entries.get(item);
      if (!e) {
        e = { item, x, y, hint, main: undefined, geometry: undefined, side: undefined, seen: 0 };
        this.entries.set(item, e);
      }
      e.seen = pass;
    });
    for (const [item, e] of this.entries) {
      if (e.seen === pass) continue;
      this.drop(e);
      this.entries.delete(item);
    }
    for (const e of this.entries.values()) {
      if (e.hint.cast !== "silhouette") continue;
      // A plant that sways: its shadow is a mesh on the plant's own strips.
      const geometry = wind?.strips(e.item)?.view.geometry;
      if (e.main && e.geometry === geometry) continue;
      this.drop(e);
      e.geometry = geometry;
      if (geometry) {
        const mesh = new Mesh({ geometry, texture: e.item.texture });
        mesh.tint = CAST_SHADOW_TINT;
        this.made++;
        e.main = mesh;
        this.root.addChild(mesh);
      } else e.main = this.take(e.item.texture);
    }
  }

  private take(texture: Texture): Sprite {
    let s = this.free.pop();
    if (!s) {
      s = new Sprite({ texture, tint: CAST_SHADOW_TINT });
      this.made++;
    } else if (s.texture !== texture) s.texture = texture;
    s.skew.set(0);
    s.scale.set(1);
    s.visible = true;
    this.root.addChild(s);
    return s;
  }

  private give(s: Sprite): void {
    this.root.removeChild(s);
    this.free.push(s);
  }

  /** Frees what an entry draws (a sprite back to the pool; a mesh, never its geometry). */
  private drop(e: Entry): void {
    if (e.main instanceof Mesh) {
      this.root.removeChild(e.main);
      e.main.destroy();
    } else if (e.main) this.give(e.main);
    if (e.side) this.give(e.side);
    e.main = undefined;
    e.side = undefined;
    e.geometry = undefined;
  }

  private place(pose: ShadowPose): void {
    this.placed++;
    for (const e of this.entries.values()) {
      if (e.hint.cast === "block") this.placeBlock(e, pose);
      else if (e.main) {
        const item = e.item;
        const tex = item.texture;
        const main = e.main;
        const foot = Math.min(e.hint.foot, Math.max(0, tex.height - 1));
        if (main.texture !== tex) main.texture = tex;
        if (main instanceof Sprite) main.anchor.set(item.anchor.x, feetAnchor(foot, tex.height));
        // The strips hang from the plant's bottom edge (y 0): turn them round its base.
        else main.pivot.set(0, -foot);
        main.position.set(item.x, item.y - foot);
        main.skew.x = pose.skewX;
        main.scale.set(1, pose.scaleY * e.hint.length);
      }
    }
  }

  private placeBlock(e: Entry, pose: ShadowPose): void {
    const T = this.tile;
    const height = e.hint.height ?? Math.max(0, e.item.texture.height - T);
    if (height < MIN_BLOCK_PX) {
      this.drop(e);
      return;
    }
    // Under the wall to its north its own north sweep cannot show: that wall's side sweep
    // already covers what of it sticks out sideways.
    const covered = this.blocks.has(tileKey(e.x, e.y - 1));
    if (covered && e.main) {
      this.give(e.main as Sprite);
      e.main = undefined;
    } else if (!covered) {
      const n = this.north;
      blockNorth(e.x, e.y, T, height, pose, n);
      const s = (e.main ??= this.take(Texture.WHITE)) as Sprite;
      s.anchor.set(0, 1);
      s.position.set(n.x, n.y);
      s.scale.set(n.scaleX, n.scaleY);
      s.skew.set(n.skewX, 0);
    }
    const b = this.sideBox;
    blockSide(e.x, e.y, T, height, pose, b);
    if (b.width === 0) {
      if (e.side) this.give(e.side);
      e.side = undefined;
      return;
    }
    const s = (e.side ??= this.take(Texture.WHITE));
    s.anchor.set(0, 0);
    s.position.set(b.x, b.y);
    s.scale.set(b.width, T);
    s.skew.set(0, b.skewY);
  }

  /** Before the living world is destroyed: the meshes here share its geometry. */
  destroy(): void {
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
    for (const s of this.free) s.destroy();
    this.free.length = 0;
    this.root.destroy({ children: true });
  }
}
