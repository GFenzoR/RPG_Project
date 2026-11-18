// The drawn body of a creature (docs/17 ANI): its contact shadow (ART-5, for sprites that
// do not paint one) and its sprite, which follows a Pose from packages/renderer anim.ts
// every frame: clip frame, offset, squash, lean, mirror, fade and hit flash. Placed in the
// creature's container, whose origin is the top-left of its tile (sprite pixels). Sprites
// sit with their bottom-centre on their anchor point: br sprites keep the bottom-right
// corner on the tile's (as MapView does), bc sprites stand with their feet FEET_LINE px
// above the tile's bottom edge. Updating allocates nothing.
import { Container, Graphics, GraphicsContext, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { FEET_LINE, MISSING_TEXTURE, SHADOW_ALPHA, SHADOW_H, SHADOW_W } from "@rpg/renderer";
import type { Pose } from "@rpg/renderer";
import { clipTexture, headLift } from "./clips.ts";
import type { ClipSet } from "./clips.ts";

/** Tint of a hit flash (multiplied: the sprite turns red for HIT_FLASH_MS). */
export const FLASH_TINT = 0xff6a6a;

let shadowContext: GraphicsContext | undefined;
/** One ellipse shared by every contact shadow. */
const shadowShape = (): GraphicsContext =>
  (shadowContext ??= new GraphicsContext()
    .ellipse(0, 0, SHADOW_W / 2, SHADOW_H / 2)
    .fill({ color: 0x000000, alpha: SHADOW_ALPHA }));

export class CreatureBody {
  readonly root = new Container({ label: "body" });
  readonly sprite: Sprite;
  /** How far the drawing rises above the tile (labels go over it), sprite pixels. */
  readonly lift: number;
  private readonly shadow: Graphics | undefined;
  private readonly baseX: number;
  private readonly baseY: number;
  private tint: number;

  constructor(
    readonly clips: ClipSet<Texture>,
    tile: number,
    tint = 0xffffff,
  ) {
    const meta = clips.meta;
    const first = clipTexture(clips, "idle", 2, 0);
    const w = meta?.w ?? first?.width ?? tile;
    const h = meta?.h ?? first?.height ?? tile;
    const bc = meta?.anchor === "bc";
    this.baseX = bc ? tile / 2 : tile - w / 2;
    this.baseY = bc ? tile - FEET_LINE + (meta?.foot ?? 0) : tile;
    this.lift = headLift(meta, { w, h }, tile, FEET_LINE);
    if (meta?.shadow === "ellipse") {
      this.shadow = new Graphics(shadowShape());
      this.shadow.position.set(tile / 2, tile - FEET_LINE);
      this.root.addChild(this.shadow);
    }
    this.sprite = new Sprite({
      texture: first ?? MISSING_TEXTURE,
      anchor: { x: 0.5, y: 1 },
      roundPixels: true,
    });
    this.sprite.position.set(this.baseX, this.baseY);
    this.tint = tint;
    this.sprite.tint = tint;
    this.root.addChild(this.sprite);
  }

  /** The cosmetic tint (T5.7) the sprite goes back to after a flash. */
  setTint(tint: number): void {
    this.tint = tint;
  }

  /** Draws `pose` facing `dir` (index in ANIM_DIRS). */
  draw(pose: Pose, dir: number): void {
    const sp = this.sprite;
    const tex = clipTexture(this.clips, pose.action, dir, pose.frame);
    if (tex && sp.texture !== tex) sp.texture = tex;
    sp.position.set(this.baseX + pose.x, this.baseY + pose.y);
    sp.scale.set(pose.scaleX, pose.scaleY);
    sp.skew.x = pose.skewX;
    sp.alpha = pose.alpha;
    sp.tint = pose.flash ? FLASH_TINT : this.tint;
    if (this.shadow) {
      this.shadow.scale.set(pose.shadow * Math.abs(pose.scaleX));
      this.shadow.alpha = pose.alpha;
    }
  }
}
