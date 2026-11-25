// A plant's sprite cut into horizontal strips that slide sideways (livingworld/README.md
// "Viento"): the base stays planted and the canopy moves, which a skew or a rotation of the
// whole sprite cannot do. One Pixi mesh per plant, four vertices per strip, made once; a
// frame only rewrites the x of the strips that moved a whole screen pixel, and nothing at all
// while the plant holds still. The texture is never redrawn and every strip keeps its own
// texels, so the pixel art stays crisp. Batched with the map's sprites (same atlas).
import { Mesh, MeshGeometry } from "pixi.js";
import type { Texture } from "pixi.js";
import { stripLayout } from "./wind.ts";
import type { StripLayout } from "./wind.ts";

export class WindMesh {
  readonly view: Mesh<MeshGeometry>;
  readonly layout: StripLayout;
  /** Each strip's offset in steps (wind.ts stripOffsets writes it; apply() shows it). */
  readonly offsets: Int16Array;
  /** The sprite's height, px. */
  readonly height: number;
  /** The rows that move, px (pivot to top): what a passing creature's bend scales by. */
  readonly reach: number;
  private readonly left: number;
  private readonly right: number;

  /**
   * A mesh that draws `texture` exactly as a sprite anchored at (anchorX, bottom) does.
   * `pivot` and `top` are px over the sprite's bottom edge (wind.ts PlantWind).
   */
  constructor(texture: Texture, anchorX: number, pivot: number, top: number) {
    const w = texture.width;
    const h = texture.height;
    this.height = h;
    this.layout = stripLayout(h, pivot, top);
    const n = this.layout.count;
    this.offsets = new Int16Array(n);
    this.left = -anchorX * w;
    this.right = this.left + w;
    const positions = new Float32Array(n * 8);
    const uvs = new Float32Array(n * 8);
    const indices = new Uint32Array(n * 6);
    const e = this.layout.edges;
    for (let i = 0; i < n; i++) {
      const y0 = e[i] as number;
      const y1 = e[i + 1] as number;
      const v = i * 8;
      positions.set(
        [this.left, y0 - h, this.right, y0 - h, this.right, y1 - h, this.left, y1 - h],
        v,
      );
      uvs.set([0, y0 / h, 1, y0 / h, 1, y1 / h, 0, y1 / h], v);
      const q = i * 4;
      indices.set([q, q + 1, q + 2, q, q + 2, q + 3], i * 6);
    }
    const geometry = new MeshGeometry({ positions, uvs, indices });
    // Always with the sprites' batch: one draw call for the map, however many trees.
    geometry.batchMode = "batch";
    this.view = new Mesh({ geometry, texture, roundPixels: true });
    this.reach = Math.max(1, Math.min(h, Math.round(top)) - Math.max(0, Math.round(pivot)));
  }

  /** Slides the strips to `offsets`, in steps of 1 / `steps` sprite px. */
  apply(steps: number): void {
    const g = this.view.geometry;
    const p = g.positions;
    for (let i = 0; i < this.layout.count; i++) {
      const dx = (this.offsets[i] as number) / steps;
      const v = i * 8;
      p[v] = this.left + dx;
      p[v + 2] = this.right + dx;
      p[v + 4] = this.right + dx;
      p[v + 6] = this.left + dx;
    }
    g.getBuffer("aPosition").update();
  }

  destroy(): void {
    const g = this.view.geometry;
    this.view.destroy();
    g.destroy();
  }
}
