// The game view: a PixiJS canvas over @rpg/renderer's MapView. It shows as much of the
// server's window (31x21 tiles, WorldState.view) as the map's box holds, centred on the
// own creature, scaled by a whole number of device pixels per sprite pixel (pixel-perfect:
// no smoothing, no fractional scale; by default the largest that shows 15x11). It
// draws the creatures interleaved with the item stacks (ground → items → creatures, row by
// row), then effects and floating texts on top, then names and health bars. Input goes
// back to the caller as tile clicks (left: walk) and creature clicks (right: attack); the
// left button held walks toward the cursor (docs/17 MOV-3). The player zooms in or out by
// whole scales (render/zoom.ts: pinch, the +/- buttons, Ctrl+wheel): the canvas stays cut
// to the map's box and centred on the own creature.
// docs/17: a click on a tall creature's head picks it (ART-2, render/creature-hits.ts); a
// creature behind another one is simply covered by it, never drawn again over it (no copy,
// no tint: two bodies that overlap keep their own colours); what stands on a table or a
// crate is raised (ART-8); ambient particles drift over the map (ART-7, A13,
// render/particles.ts).
import {
  Application,
  CanvasTextMetrics,
  Container,
  Graphics,
  Sprite,
  Text,
  TextureStyle,
} from "pixi.js";
import type { Texture } from "pixi.js";
import { CreatureKind, FloatingTextKind, Skull } from "@rpg/protocol";
import type { AttackKind, Direction } from "@rpg/protocol";
import {
  Atlas,
  DEATH_FADE_MS,
  DEATH_MS,
  DecoratedSource,
  HOUSE_DOOR_FRAME,
  LUNGE_BACK_MS,
  LUNGE_OUT_MS,
  MISSING_TEXTURE,
  MapView,
  extrasByChunk,
  animate,
  attackClip,
  attackClipAction,
  clipMs,
  entityZIndex,
  newAnimInput,
  faceTo,
  newAnimState,
  newPose,
  screenToTile,
  screenToWorld,
  startAttack,
  startDeath,
  startHit,
  startVanish,
  tilePixels,
  tileToScreen,
  VANISH_MS,
  walkCyclesPerStep,
} from "@rpg/renderer";
import { slideSize } from "../state/motion.ts";
import type {
  AnimState,
  AtlasIcon,
  AttackAction,
  Camera,
  Look,
  StepKind,
  TileArt,
  WornSlot,
  WorldRect,
} from "@rpg/renderer";
import { dirIndex, legacyOutfitClips, spriteClips } from "./clips.ts";
import type { ClipSet } from "./clips.ts";
import { CreatureBody } from "./creature-body.ts";
import type { BodyLayer } from "./creature-body.ts";
import { dollSprites, dressPlayer, wornFromVisible } from "./look.ts";
import type { Dressed } from "./look.ts";
import { DrawnBoxes } from "./creature-hits.ts";
import { ParticleLayer, stepKindOf } from "./particles.ts";
import { bodyKindOf, creatureGait, kicksUp, mountLivingWorld, newWalkSample } from "./living.ts";
import type { StepVoice } from "./living.ts";
import type { Gait } from "./living.ts";
import { CastShadows, contactOf, poseOf } from "./cast-shadows.ts";
import { LightField, LitObjectShadows } from "./light-shadows.ts";
import { ObjectShadows } from "./object-shadows.ts";
import { TargetHalo } from "./target-halo.ts";
import { roofLookup } from "./roofs.ts";
import type { ObjectShadowHint } from "./object-shadows.ts";
import { NIGHT_PLAYER_LIGHT, SkyView, dimmed, litSurface } from "./sky.ts";
import type { ParticleView } from "./particles.ts";
import {
  attackDir,
  attackerOf,
  DepartureFeed,
  figureAttack,
  isBlowEffect,
  leaveStyle,
  meleeAttacker,
  pushFrom,
} from "./creature-events.ts";
import type { Fighter, Held, LeaveStyle } from "./creature-events.ts";
import { devicePixels, followCamera } from "./viewport.ts";
import {
  WheelZoom,
  pinchZoom,
  shownTiles,
  stepZoom,
  viewPixels,
  zoomPref,
  zoomRange,
  zoomScale,
} from "./zoom.ts";
import type { ZoomRange, ZoomView } from "./zoom.ts";
import { loadCanvasFont } from "./canvas-font.ts";
import {
  fitName,
  labelMaxWidth,
  nameBlockHeight,
  placeLabels,
  stackLabel,
  wrapRole,
} from "./labels.ts";
import {
  DEFAULT_NAME_SIZE,
  LABEL_COLORS,
  LABEL_FONT,
  LABEL_FONT_FAMILY,
  LABEL_NAME_WEIGHT,
  LABEL_OUTLINE,
  LABEL_ROLE_COLOR,
  LABEL_SUB_WEIGHT,
  labelFontPx,
  minNamePx,
  labelScale,
  labelStroke,
  linePitch,
  markScale,
  subFontPx,
} from "./label-style.ts";
import type { NameSize } from "./label-style.ts";
import type { LabelBox, LabelLines } from "./labels.ts";
import { GestureRecognizer, isTouchPointer } from "../input/gestures.ts";
import type { Gesture } from "../input/gestures.ts";
import { LeftPress, mapPress } from "../input/mouse.ts";
import type { PressAnswer } from "../input/mouse.ts";
import type { WalkMark } from "../state/steering.ts";
import { MARK_COLORS, MARK_SQUASH, markRing } from "./walk-mark.ts";
import type { ControlsMode } from "../state/controls.ts";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { delta, samePos } from "../state/geometry.ts";
import type { Pos } from "../state/geometry.ts";
import { creatureName, formatMessage } from "../state/messages.ts";
import { BubbleLayer } from "./bubble-layer.ts";
import type { BubbleAnchor } from "./bubble-layer.ts";
import { admitSpeech } from "./bubbles.ts";
import type { BubbleStyle } from "./bubbles.ts";
import {
  corpseSprite,
  mapItemArt,
  mapItemId,
  mapItemTexture,
  parseMapItemKey,
} from "../state/corpse-art.ts";
import { skullColor } from "../state/pvp.ts";
import { playerLook } from "./cosmetics.ts";
import { MARK_BOX, isMarkArt, markSprite } from "./marks.ts";
import type { OutfitDef } from "../content-types.ts";
import { DEFAULT_OUTFIT, outfitKeys } from "./outfit.ts";
import { EffectLayer } from "./effect-layer.ts";
import { livingEvent, mountLivingObjects } from "./living.ts";
import { SHAKE_MS, shakeOffset } from "./shake.ts";
import {
  AMBIENT,
  FIRE_TINT,
  LightLayer,
  PLAYER_LIGHT,
  PLAYER_TINT,
  glowTexture,
  isDark,
} from "./light-layer.ts";
import type { CreatureState, Walk, WorldState } from "../state/world.ts";
import type { ViewTiles } from "../state/view.ts";

const COLORS = {
  background: 0x000000,
  // Names, guild lines and the fallback blocks use the label tokens (render/label-style.ts).
  self: LABEL_COLORS.self,
  player: LABEL_COLORS.player,
  monster: LABEL_COLORS.monster,
  npc: LABEL_COLORS.npc,
  role: LABEL_ROLE_COLOR,
  guild: LABEL_COLORS.guild,
  marker: 0xffffff,
  outline: 0x101010,
  barBack: 0x101010,
  barHigh: 0x30c030,
  barMid: 0xe0c020,
  barLow: 0xd03020,
};

/** Health bar size in sprite pixels. */
const BAR_W = 26;
const BAR_H = 4;

/**
 * The rectangle (world units) a creature's figure covers: its body sprite, anchored at the
 * bottom centre and placed relative to the creature's container at (bodyX, bodyY).
 */
export function figureRect(
  bodyX: number,
  bodyY: number,
  fig: {
    x: number;
    y: number;
    scale: { x: number; y: number };
    texture: { width: number; height: number };
  },
): WorldRect {
  const w = fig.texture.width * Math.abs(fig.scale.x);
  const h = fig.texture.height * Math.abs(fig.scale.y);
  return { x: bodyX + fig.x - w / 2, y: bodyY + fig.y - h, width: w, height: h };
}

/** What GameCanvas.labels reports (E2E). */
export interface LabelsShown {
  /**
   * The names' font size in device pixels (render/label-style.ts labelFontPx), the map
   * scale and the screen's device pixels per CSS pixel.
   */
  fontPx: number;
  zoom: number;
  dpr: number;
  shown: {
    id: number;
    /** The name as drawn (one line) and the size it is rasterised at, device px. */
    text: string;
    fontPx: number;
    /** What an NPC does, under its name: its lines ("" for a player or a monster). */
    role: string;
    roleFontPx: number;
    fill: number;
    /** The Text's own scale: always 1 (never a blown-up raster). */
    scale: number;
    /** Top of the whole label, where a speech bubble sits (page px). */
    top: number;
    /** Page px. */
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
}

const barColor = (pct: number): number =>
  pct > 50 ? COLORS.barHigh : pct > 25 ? COLORS.barMid : COLORS.barLow;

/** What the E2E hook `footfalls()` tells (GameCanvas.footfalls). */
export interface FootfallHook {
  footprints: number;
  /** How many feet of the own player touched the ground since the canvas was made. */
  total: number;
  /**
   * The last of them (at most OWN_FOOTFALLS), oldest first: which foot, where, the sound
   * event of the ground under it and the rate its take played at.
   */
  own: { side: number; x: number; y: number; sound: string; rate: number }[];
  /**
   * The prints on the ground: which foot left each, where, and how much of it the wind,
   * the waves or other feet have erased (0 fresh, 1 gone).
   */
  prints: { side: number; x: number; y: number; wear: number; surface: string }[];
}

/** How many of the own player's footfalls the E2E hook keeps. */
const OWN_FOOTFALLS = 16;

/** What the E2E hook `gust()` tells (GameCanvas.gust). */
export interface GustHook {
  /** The front reaches the tile in this many ms. */
  at: number;
  /** How hard it blows there (data/livingworld/wind.yaml gusts.strength). */
  strength: number;
  /** No gust is on the map now: every plant stands still. */
  calm: boolean;
}

/** What the E2E hook `sky()` tells (GameCanvas.sky). */
export interface LightShadowHook {
  lights: number;
  shadows: number;
  objectShadows: number;
  /** Whether the tile of the own player is under a roof. */
  selfIndoor: boolean;
  /** Opacity of the own player's contact ellipse (0: none, it casts a shadow). */
  selfContact: number;
  /**
   * Whether a lamp, torch or fire casts the own player's shadow now. `shadows` counts every
   * creature in the server's window, also one under a roof past the edge of the screen.
   */
  selfLit: boolean;
}

export interface SkyHook {
  phase: string;
  ambient: number;
  lamps: number;
  moon: number;
  shadowAlpha: number;
  /** Cast shadow sprites of the creatures drawn this frame (one per paper-doll layer). */
  shadows: number;
  /** Where the tip of a caster one unit high lands: east (+) or west (-), and north. */
  shadowX: number;
  shadowY: number;
  /** Shadow sprites and meshes of the map's objects, and how many objects cast them. */
  objectShadows: number;
  casters: number;
  /** Of those, the plants whose shadow sways with them in the wind (none with reduced motion). */
  swayingShadows: number;
  /** Creatures drawn with their contact ellipse (none of those that cast a shadow). */
  contacts: number;
  /** Whether the own player is drawn with its contact ellipse (indoors, a moonless night). */
  selfContact: boolean;
}

export interface GameCanvas {
  /** Page coordinates of the centre of tile (x, y) on the current floor (tests, tooling). */
  tileToClient(x: number, y: number): { x: number; y: number };
  /** The tile of the own floor under page coordinates, or undefined outside the canvas. */
  clientToTile(clientX: number, clientY: number): Pos | undefined;
  /**
   * The point of the own floor under page coordinates, in fractional tiles (tile x spans
   * [x, x + 1)), also outside the canvas (the mouse held on the map, docs/17 MOV-3). The
   * same object every call (asked every frame of a hold): read it before the next.
   */
  worldAt(clientX: number, clientY: number): { x: number; y: number } | undefined;
  /** Where an item's sprite is in the atlas, for DOM icons (inventory). */
  itemIcon(itemId: number): AtlasIcon | undefined;
  /** An item's minimap colour from the atlas ("#rrggbb", docs/02 "Minimapa"), if it has one. */
  itemColor(itemId: number): string | undefined;
  /** Where any sprite of the atlas is (an NPC's portrait in its dialog), real art or not. */
  spriteIcon(path: string): AtlasIcon | undefined;
  /** Where a PvP mark's sprite is in the atlas (real art only), for the battle list. */
  markIcon(mark: Skull): AtlasIcon | undefined;
  /** Current device pixels per sprite pixel. */
  readonly scale: number;
  /** The scale and the scales the player may choose now. */
  readonly zoom: ZoomView;
  /** The tiles the canvas shows (fractional when cut to the box), at most WorldState.view. */
  readonly shown: ViewTiles;
  /**
   * E2E: the names drawn now (docs/17 UI-3): the label scale and, per shown creature label,
   * its text, fill and box in page px.
   */
  labels(): LabelsShown;
  /**
   * E2E (docs/17 ART-3): the alpha of each wall piece on tile (x, y) of the own floor.
   */
  wallFade(x: number, y: number): { alphas: number[] };
  /** Zooms `steps` whole scales in (+) or out (-), within the range (the +/- buttons). */
  zoomBy(steps: number): void;
  /**
   * E2E: the creatures in an attack pose now (its clip or lunge), the ones falling dead
   * and the ones shimmering away (docs/17 ANI-2, ANI-7): `ms` since it started, `of` its
   * length.
   */
  poses(): { attacking: PoseTime[]; dying: PoseTime[]; vanishing: PoseTime[] };
  /** E2E (docs/17 UI-11): the speech bubbles on screen now, by speaker. */
  bubbles(): { id: number; style: BubbleStyle; lines: string[] }[];
  /**
   * E2E: the sky last drawn (render/sky.ts): its phase, light colour, lamps, moon and how
   * many cast shadow sprites the frame drew; undefined underground or without a day and night.
   */
  sky(): SkyHook | undefined;
  /**
   * E2E: the next gust of wind to reach tile (x, y) blowing at least `min` there
   * (livingworld/README.md "Viento"): in how many ms and how hard, and whether the map is
   * in the calm between two gusts now (no plant moves); undefined without wind.
   */
  gust(x: number, y: number, min?: number): GustHook | undefined;
  /**
   * E2E: the shadows lamps and fires cast now (render/light-shadows.ts), underground too:
   * the lights in view, the shadow sprites of creatures and of map objects, whether the own
   * player stands under a roof and how strong its contact ellipse is drawn.
   */
  lightShadows(): LightShadowHook;
  /**
   * E2E: the footfalls of the walks drawn (livingworld/README.md "Huellas"): the footprints
   * on the ground now, and the last feet of the own player that touched the ground, oldest
   * first (the side, and where: sprite pixels of the map).
   */
  footfalls(): FootfallHook;
  /** E2E: the facing creature `id` was last drawn in, and whether its figure has eight. */
  drawnFacing(id: number): { facing: string; eight: boolean } | undefined;
  /** The creatures showing the target halo now (the E2E: one at most, the target). */
  haloIds(): number[];
  /** The <canvas> element (drop target for items dragged onto the map). */
  readonly element: HTMLCanvasElement;
  destroy(): void;
}

/** How far into an animation a creature is (GameCanvas.poses, for the E2E). */
export interface PoseTime {
  id: number;
  ms: number;
  of: number;
  /** The clip it plays: attack, shoot or cast (lunge: a single image's), death, vanish. */
  action: string;
  /** Its tile (a body falling or shimmering away: where it stays). */
  x: number;
  y: number;
}

export interface GameCanvasOptions {
  world: WorldState;
  content: ClientContent;
  t: Translate;
  /** Called every frame before drawing, with the frame time (ms, performance.now()). */
  frame(now: number): void;
  /** A tile of the own floor was clicked. */
  clickTile(x: number, y: number, z: number): void;
  /** A creature was right-clicked (attack it). */
  clickCreature(id: number): void;
  /**
   * A tile without a creature was right-clicked (use it: climb a ladder, or its top item).
   * `top`: Ctrl was held, use the top item even on a ladder.
   */
  useTile(x: number, y: number, z: number, top: boolean): void;
  /** A tile was shift-clicked (look at its top item). */
  lookTile(x: number, y: number, z: number): void;
  /** Plays a sound of assets/sounds.yaml by id at a tile (the living world's objects). */
  playSound?(id: string, at: { x: number; y: number; z: number }): void;
  /**
   * A foot of the own player touched the ground in the walk drawn (render/living.ts):
   * the sound events of a step on the ground under that foot, most specific first, and
   * how that foot sounds (its take, loudness and pitch). Both are reused.
   */
  footstep?(events: readonly string[], voice: StepVoice | undefined): void;
  /**
   * docs/17 UI-6: the tile's menu with its item's card (a right click in the menu controls,
   * Shift+right click in both), at page coordinates (cx, cy).
   */
  menuTile?(x: number, y: number, z: number, cx: number, cy: number): void;
  /** docs/17 UI-6: a tile was double-clicked with the mouse (its default action). */
  doubleClickTile?(x: number, y: number, z: number): void;
  /** What the right button does on items now (state/controls.ts); "classic" without it. */
  controls?(): ControlsMode;
  /** The tile is a door (a map door item or a house door): right-clicked, it is used. */
  doorAt?(x: number, y: number, z: number): boolean;
  /**
   * ART-2: the tile has something of its own to use (a door, an item, a ladder): the head
   * of a tall creature on the tile below, rising into it, does not take its click or tap.
   */
  ownUse?(x: number, y: number, z: number): boolean;
  /** The left button was pressed on a tile and dragged (move its top item). */
  dragTile(x: number, y: number, z: number, e: PointerEvent): void;
  /**
   * docs/17 MOV-3, MOV-7: the left button went down on a tile (no Shift): whether a drag
   * moves its item, whether holding it walks toward the cursor, and whether the walk there
   * already started (then its release is no click). Without it: a click on release, a drag
   * moves the item, no hold.
   */
  pressTile?(x: number, y: number, z: number): PressAnswer;
  /**
   * docs/17 MOV-3: the left button is held on the map: walk toward the cursor, at page
   * coordinates (cx, cy); called again each time it moves.
   */
  holdAt?(cx: number, cy: number): void;
  /** The held left button was let go (or the hold was lost): stop walking toward it. */
  holdEnd?(): void;
  /** docs/17 MOV-7: the last click-to-walk's mark (a ring on its tile for MARK_MS). */
  walkMark?(): WalkMark | undefined;
  /**
   * docs/17 MOV-7, UI-5: the default action on a tile, shown beside the mouse over it
   * ("" = nothing to show).
   */
  hoverText?(x: number, y: number, z: number): string;
  /**
   * docs/17 UI-6: the mouse came over tile (x, y, z) at page (cx, cy) (the card of what lies
   * there shows at once, as in Diablo II), or left the map, pressed or scrolled
   * (`undefined`: it goes). Called again only when the tile under the mouse changes.
   */
  restTile?(at: { x: number; y: number; z: number; cx: number; cy: number } | undefined): void;
  /**
   * docs/17 UI-9: whether a heavy hit shakes the camera now (the option, and never with
   * reduced motion). Asked at each frame of a shake; without it, never.
   */
  shake?(): boolean;
  /**
   * docs/17 UI-11: whether what creatures say shows over their heads (Options →
   * Interface). Asked every frame; without it, it does.
   */
  bubbles?(): boolean;
  /**
   * docs/17 UI-3: how big the names are (Options → Interface), asked at each frame; without
   * it, DEFAULT_NAME_SIZE.
   */
  nameSize?(): NameSize;
  /** T5.6: a finger tapped a tile (walk, attack or talk to its creature, place an item). */
  tapTile(x: number, y: number, z: number): void;
  /** T5.6: a finger held a tile still (the contextual menu), at page coordinates (cx, cy). */
  longPressTile(x: number, y: number, z: number, cx: number, cy: number): void;
  /** T5.6: a finger went down on the canvas. */
  touched(): void;
  /** The zoom this device remembers (render/zoom.ts loadZoom); undefined = fit the view. */
  zoom?: number | undefined;
  /** The player zoomed (pinch, Ctrl+wheel, zoomBy): remember `pref` (undefined = fit). */
  zoomed?(pref: number | undefined): void;
  /** The scale or its limits changed (a zoom, a resize): refresh the zoom buttons. */
  zoomView?(view: ZoomView): void;
}

/** How long after a finger press a contextmenu event is that finger's long press, ms. */
const TOUCH_MENU_MS = 1500;

/** Pointer travel (canvas pixels) that turns a press into a drag. */
const DRAG_START_PX = 6;

/** How often the text beside the cursor is asked again while the tile under it stays. */
const HINT_REFRESH_MS = 250;

/** Where the text beside the cursor goes, from the cursor (CSS px). */
const HINT_OFFSET = { x: 14, y: 18 } as const;

/** Half the width of a PvP mark beside a name (T5.2), in screen pixels. */
const MARK_HALF = MARK_BOX.w / 2;

/**
 * Draws the PvP mark of a skull centred on the container (none = empty): its sprite
 * (render/marks.ts) at one screen pixel per sprite pixel, like the 12 px names, or without
 * it the old placeholder, a skull of the mark's colour drawn with shapes.
 */
function drawSkull(g: Container, mark: Skull, art: Texture | undefined): void {
  for (const child of g.removeChildren()) child.destroy();
  if (mark === Skull.UNSPECIFIED) return;
  if (art) {
    // Anchored at the centre of MARK_BOX, the part of the sprite with the drawing.
    const anchor = {
      x: (MARK_BOX.x + MARK_HALF) / art.width,
      y: (MARK_BOX.y + MARK_BOX.h / 2) / art.height,
    };
    g.addChild(new Sprite({ texture: art, anchor, roundPixels: true }));
    return;
  }
  const fill = skullColor(mark);
  const shapes = new Graphics();
  shapes
    .circle(0, -1, MARK_HALF - 1)
    .fill(fill)
    .stroke({ color: 0x000000, width: 1 });
  shapes.rect(-3, 2, 6, 3).fill(fill).stroke({ color: 0x000000, width: 1 });
  shapes.circle(-2, -1, 1.3).fill(0x000000);
  shapes.circle(2, -1, 1.3).fill(0x000000);
  g.addChild(shapes);
}

interface CreatureSprite {
  body: Container;
  shape: Graphics;
  /** The red ring on the ground under the attacked target (render/target-halo.ts). */
  halo: TargetHalo;
  label: Text;
  /** What an NPC does, under its name (docs/17 UI-3); empty for the rest. */
  role: Text;
  /** The guild name, between the name and the health bar (T5.1); empty = hidden. */
  guild: Text;
  /** What the lines were fitted for (fitted again only when one changes). */
  fitName: string;
  fitRole: string;
  fitPx: number;
  fitMax: number;
  /** The floor the name was fitted with (minNamePx of the screen's density). */
  fitMin: number;
  /** The sizes the lines are drawn at (render/labels.ts stackLabel). */
  lines: LabelLines;
  /** Top of the label as drawn last, canvas px (the E2E hook). */
  top: number;
  /** The PvP mark left of the name (T5.2): its sprite, or shapes without one (drawSkull). */
  skull: Container;
  drawnSkull: Skull;
  /**
   * The animated body (docs/17 ANI): a monster's or NPC's sprite, or a player's outfit
   * (T0.5; T5.7: the equipped outfit cosmetic, else citizen). Undefined = the coloured block.
   */
  figure: CreatureBody | undefined;
  /** How it walks (render/living.ts creatureGait): where its feet leave their marks. */
  gait: Gait | undefined;
  /**
   * CreatureState.lookRev the sprites were built with: the cosmetics (T5.7), the body or
   * the visible equipment changed since, and they are built again.
   */
  drawnLook: number;
  /**
   * What a paper doll (render/look.ts) holds: its attacks play that weapon's clip.
   * Undefined for a sprite that is no doll: its attacks play by their kind.
   */
  held: Held | undefined;
  bar: Graphics;
  drawnDir: number;
  drawnHealth: number;
}

export async function createGameCanvas(
  host: HTMLElement,
  opts: GameCanvasOptions,
): Promise<GameCanvas> {
  const { world, content, t } = opts;
  TextureStyle.defaultOptions.scaleMode = "nearest";
  // The pixel font of the names and numbers (render/canvas-font.ts) loads with the atlas:
  // a Text drawn before it would keep the fallback. If it comes after the wait, the labels
  // are measured and drawn again (redrawLabels, set once the sprites exist).
  let redrawLabels = (): void => {};
  // From the site root: the game page lives in /play/ (T4.3).
  const [atlas] = await Promise.all([
    Atlas.load(new URL("/atlas/", document.baseURI).href),
    loadCanvasFont(document.fonts, { onLate: () => redrawLabels() }),
    // The names' font (render/label-style.ts), in the weights of the name and of the
    // lines under it.
    ...[LABEL_NAME_WEIGHT, LABEL_SUB_WEIGHT].map((w) =>
      loadCanvasFont(document.fonts, {
        onLate: () => redrawLabels(),
        font: `${w} 16px "${LABEL_FONT_FAMILY}"`,
      }),
    ),
  ]);
  const T = atlas.tileSize;
  const app = new Application();
  await app.init({
    width: world.view.width * T,
    height: world.view.height * T,
    background: COLORS.background,
    antialias: false,
    roundPixels: true,
    resolution: 1,
    autoDensity: false,
    preference: "webgl",
  });
  const canvas = app.canvas;
  canvas.dataset["testid"] = "game-canvas";
  canvas.style.imageRendering = "pixelated";
  host.appendChild(canvas);

  // A tile item's key is its number, or "<number>@<monster>" for the remains of a monster,
  // drawn as that monster's own corpse when the atlas has it (state/corpse-art.ts).
  const textures = new Map<string, Texture>();
  const texture = (id: string): Texture => {
    let tex = textures.get(id);
    if (!tex) {
      tex = mapItemTexture(id, content.items, atlas) ?? MISSING_TEXTURE;
      textures.set(id, tex);
    }
    return tex;
  };
  // Tile art (docs/17 ART-3, ART-4, ART-7): ground looks, wall pieces, animated tiles, anchors
  // and cast shadows, resolved once per item. A corpse is centred on its tile, as the
  // creature stood (its sprite is the creature's frame, wider than a tile for most).
  const arts = new Map<string, TileArt<Texture> | null>();
  const art = (id: string): TileArt<Texture> | undefined => {
    let a = arts.get(id);
    if (a === undefined) {
      a = mapItemArt(id, content.items, atlas) ?? null;
      arts.set(id, a);
    }
    return a ?? undefined;
  };
  // docs/17 A11: the timber frame of every house door (a gap in the wall the server knows by
  // its tile), drawn by the renderer only: the world state never holds it.
  const frameId = Object.entries(content.items).find(([, d]) => d.id === HOUSE_DOOR_FRAME)?.[0];
  const frames = extrasByChunk(
    frameId
      ? (content.houseDoors ?? []).map((key) => {
          const [x = -1, y = -1, z = -1] = key.split(",").map(Number);
          return { x, y, z, id: frameId };
        })
      : [],
  );
  const view = new MapView({
    source: new DecoratedSource(world, (z, cx, cy) => frames.get(`${z}/${cx}/${cy}`)),
    texture,
    art,
    // ART-8: tables and crates raise what is stacked on them (data/items elevation).
    elevation: (id) => content.items[mapItemId(id)]?.elevation ?? 0,
    tileSize: T,
    floor: world.self?.pos.z ?? 7,
    // Under the sky, the sun's shadows stay out of the buildings (docs/17 ART-5).
    indoors: content.livingWorld?.dayNight ? (z) => !isDark(z) : undefined,
    // Which tiles those are comes with the build (client/vite/roofs.ts), not from the view.
    roofs: roofLookup(content.roofs),
  });
  // Ambient particles (A13), in world space under the silhouettes.
  const particles = new ParticleLayer(T);
  const particleView: ParticleView = { x: 0, y: 0, width: 0, height: 0 };
  // The living world's frame, reused (docs/07: a frame allocates nothing for it).
  const livingSelf = { x: 0, y: 0 };
  const livingView = { x: 0, y: 0, width: 0, height: 0, z: 0, self: livingSelf, zoom: 1 };
  /** The trail wear version the living world has (state/trail-wear.ts). */
  let livingWear = -1;
  const emitters = (fn: Parameters<MapView["forEachEmitter"]>[0]): void => view.forEachEmitter(fn);
  const motionQuery =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  /** Reduced motion (Options or the system, state/ui-prefs.ts): no particles. */
  const reducedMotion = (): boolean =>
    document.documentElement.dataset["motion"] === "reduced" || (motionQuery?.matches ?? false);
  // Where each creature was drawn this frame (ART-2): clicks on heads.
  const drawnBoxes = new DrawnBoxes();
  view.overlay.addChild(particles.view);
  // The living world (livingworld/README.md, render/living.ts): footprints on the ground
  // overlay, plants that bend, ripples, leaves and critters; nothing with reduced motion.
  // The day and night (livingworld/README.md "Día y noche", render/sky.ts): the world clock
  // the server sent, run on every frame into the sky's light and the sun's angle.
  const sky = new SkyView(content.livingWorld?.dayNight, world.worldClock);
  const living = mountLivingWorld(
    view,
    world,
    content,
    atlas,
    reducedMotion,
    () => sky.night(),
    // No wind underground (livingworld/README.md "Viento").
    () => isDark(world.self?.pos.z ?? 0),
    // A foot on the ground (livingworld gait.ts): the ground's motes (MOV-7) fly from
    // under it, and the own player's is the step's sound.
    (fall, events, voice) => {
      if (kicksUp(fall)) kickUp(fall.x, fall.y, fall.z);
      if (!fall.self) return;
      opts.footstep?.(events, voice);
      // A ring of the last ones, written over (nothing made per footfall).
      const slot = ownFalls[ownFallCount++ % OWN_FOOTFALLS];
      if (slot) {
        slot.side = fall.side;
        slot.x = fall.x;
        slot.y = fall.y;
        slot.sound = events[0] ?? "";
        slot.rate = voice?.rate ?? 1;
      }
    },
    // The gusts of wind run on the server's clock (livingworld/README.md "Viento"): two
    // players side by side see the same gust bend the same trees.
    () => Date.now() + world.clockOffset,
  );
  const ownFalls = Array.from({ length: OWN_FOOTFALLS }, () => ({
    side: 0,
    x: 0,
    y: 0,
    sound: "",
    rate: 1,
  }));
  let ownFallCount = 0;
  /** The creature drawn, as the living world reads its walk (reused: docs/07). */
  const walkSample = newWalkSample();
  /** A drawing gliding over a correction further than this (sprite px) leaves no prints. */
  const slidePx = content.livingWorld?.gaits?.slidePx ?? 0;
  // The creatures' cast shadows (render/cast-shadows.ts): over the ground and the living
  // world's footprints, under the items and the creatures; none underground or indoors (no
  // sun there: the contact ellipse stays).
  const castShadows = new CastShadows();
  view.groundOverlay.addChild(castShadows.root);
  // The map objects' (render/object-shadows.ts), in the same layer: how each item casts is
  // its ItemDef.shadow (data/livingworld/shadows.yaml), and its base the row its drawing
  // ends on (atlas.json `feet`; a corpse's is its own sprite's).
  const shadowHints = new Map<string, ObjectShadowHint | null>();
  const shadowHint = (key: string): ObjectShadowHint | undefined => {
    let h = shadowHints.get(key);
    if (h === undefined) {
      const { itemId, remainsOf } = parseMapItemKey(key);
      const def = content.items[itemId];
      const corpse = remainsOf ? corpseSprite(remainsOf) : undefined;
      const sprite = corpse !== undefined && atlas.has(corpse) ? corpse : def?.sprite;
      h = def?.shadow
        ? { ...def.shadow, foot: sprite === undefined ? 0 : atlas.foot(sprite) }
        : null;
      shadowHints.set(key, h);
    }
    return h ?? undefined;
  };
  const objectShadows = new ObjectShadows(T, shadowHint);
  castShadows.mount(objectShadows.root);
  // The shadows of lamps, torches and fires (render/light-shadows.ts): a second layer of the
  // same kind over the indoor floors, for under a roof, underground and the night.
  const lightRules = content.livingWorld?.shadows?.lights;
  const lightField = lightRules ? new LightField(lightRules) : undefined;
  const lightShadows = new CastShadows();
  view.litOverlay.addChild(lightShadows.root);
  const litObjects = new LitObjectShadows(shadowHint);
  lightShadows.mount(litObjects.root);
  const litPose = poseOf(0, 0, 0);
  /** What the contact ellipse keeps where nothing casts a shadow (shadows.yaml unlit_contact). */
  const unlitContact = lightRules?.unlitContact ?? 1;
  /** This frame: the lights cast, how much they show under the open sky, the sun's alpha. */
  let lit = false;
  let litOpen = 0;
  let sunAlpha = 0;
  /** What `shade` answered for the own player in the last frame (the E2E hook). */
  let selfShade = 0;
  /**
   * The shadows of a body at tile (x, y) this frame: sets its contact ellipse and answers
   * whether the sun casts (1), a light does (2), both (3) or none (0). After a 2 or a 3
   * lightShadows is aimed for it.
   */
  const shade = (figure: CreatureBody, x: number, y: number): number => {
    const indoor = view.indoorAt(Math.round(x), Math.round(y));
    const sun = sunAlpha > 0 && !indoor;
    const glow = lit && lightField ? lightField.at(x, y, indoor, litOpen) : 0;
    figure.contactRest = unlitContact;
    figure.contact = contactOf(sun ? sunAlpha : 0, glow * litPose.alpha, unlitContact);
    if (glow > 0 && lightField)
      lightShadows.aim(lightField.pose.skewX, lightField.pose.scaleY, glow);
    return (sun ? 1 : 0) | (glow > 0 ? 2 : 0);
  };
  const shadowWind = living
    ? {
        version: () => living.windVersion(),
        strips: (sprite: Sprite) => living.windStrips(sprite),
      }
    : undefined;
  // The living objects' effects (render/living.ts): over the map.
  const livingObjects = mountLivingObjects(view.overlay, {
    tileSize: T,
    items: content.items,
    tile: (x, y, z) => world.tile(x, y, z),
    elevationAt: (x, y) => view.elevationAt(x, y),
    texture: (sprite) => atlas.texture(sprite),
    ...(opts.playSound ? { playSound: opts.playSound } : {}),
    reducedMotion: () => reducedMotion(),
  });
  const effectLayer = new Container({ label: "effects" });
  const textLayer = new Container({ label: "floating texts" });
  const labels = new Container({ label: "labels" });
  // docs/17 UI-11: what creatures say, over their names (render/bubble-layer.ts).
  const speech = new BubbleLayer();
  const anchors = new Map<number, BubbleAnchor>();
  // Caves are dark (ART-7): a light map over the map, under effects and names.
  const lights = new LightLayer(glowTexture());
  // docs/17 MOV-7: the ring of a click-to-walk, over the light (seen in a cave too).
  const walkMark = new Graphics({ label: "walk mark" });
  let walkMarkDrawn = false;
  app.stage.addChild(view.root, lights.view, walkMark, effectLayer, labels, speech.view, textLayer);
  /** Pixels per tile of the frame being lit, for addFireLight (made once: no per-frame closure). */
  let lightTile = 0;
  /** The fires' colour this frame: full in a cave, by how dark it is on the surface. */
  let fireTint = FIRE_TINT;
  const addFireLight = (x: number, y: number, radius: number): void =>
    lights.add(
      (x + 0.5 - cam.x) * lightTile,
      (y + 0.5 - cam.y) * lightTile,
      radius * lightTile,
      fireTint,
    );

  let scale = 1;
  // Screen pixels per font cell of the floating numbers this frame (labelScale), and the
  // font sizes of the names and of the lines under them, in device pixels: the labels are
  // rasterised at the size they show (render/label-style.ts labelFontPx).
  let nameScale = 1;
  let namePx = 12;
  let nameMinPx = minNamePx(1);
  let subPx = 10;
  let labelMax = 144;
  // Line widths, measured with a 2D context of the names' font (kept: a name is measured
  // once per size, not per frame).
  const measureCtx = document.createElement("canvas").getContext("2d");
  const widths = new Map<string, number>();
  const measurer =
    (weight: string) =>
    (text: string, px: number): number => {
      const key = `${weight}|${px}|${text}`;
      let w = widths.get(key);
      if (w === undefined) {
        if (widths.size > 2000) widths.clear();
        if (measureCtx) {
          measureCtx.font = `${weight} ${px}px ${LABEL_FONT}`;
          w = measureCtx.measureText(text).width + labelStroke(px);
        } else w = text.length * px * 0.55;
        widths.set(key, w);
      }
      return w;
    };
  const measureName = measurer(LABEL_NAME_WEIGHT);
  const measureSub = measurer(LABEL_SUB_WEIGHT);
  /** Sets a label line to `px`: its outline and line height follow. */
  const sizeLine = (text: Text, px: number): void => {
    const st = text.style;
    if (st.fontSize === px) return;
    st.fontSize = px;
    st.lineHeight = linePitch(px);
    // The outline keeps its colour (a name effect's, render/cosmetics.ts) at the new width.
    const k: unknown = st.stroke;
    const color =
      typeof k === "object" && k !== null && "color" in k && typeof k.color === "number"
        ? k.color
        : LABEL_OUTLINE;
    st.stroke = { color, width: labelStroke(px), join: "round" };
  };
  /** What an NPC does (its role's text, @rpg/content-schema npcRoleKey), "" for the rest. */
  const roleOf = (c: CreatureState): string => {
    if (c.kind !== CreatureKind.NPC) return "";
    const key = content.npcRoles?.[c.contentId];
    return key ? t(key) : "";
  };
  let cam: Camera = { x: 0, y: 0, zoom: 1 };
  // The zoom the player chose (undefined = the fitted view) and what the map's box
  // allows; `scale` is the one drawn.
  let pref = opts.zoom;
  let range: ZoomRange = { min: 1, fit: 1, max: 1 };
  let shown: ZoomView | undefined;
  // The server's window the canvas was sized for (WorldState.view, from Welcome).
  let sizedFor = world.view;
  /**
   * Centres the camera on the player as drawn at `now`. Cut to the box or zoomed in, the
   * canvas shows fewer (and fractional) tiles: centre those.
   */
  const follow = (now: number): void => {
    const self = world.self;
    if (!self) return;
    const sp = world.drawPos(self, now);
    cam = followCamera(
      sp.x,
      sp.y,
      scale,
      T,
      shownTiles(app.screen.width, app.screen.height, scale, T),
    );
  };
  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    // The map's box is the host's content box: a padding keeps the canvas off a strip of
    // controls (portrait with the touch pad, touch.css).
    const style = getComputedStyle(host);
    const px = (v: string): number => parseFloat(v) || 0;
    const boxW = Math.max(0, host.clientWidth - px(style.paddingLeft) - px(style.paddingRight));
    const boxH = Math.max(0, host.clientHeight - px(style.paddingTop) - px(style.paddingBottom));
    sizedFor = world.view;
    // The full-screen desktop map covers its box (--map-cover: 1 in windows.css, docs/17
    // UI-4); its box is the screen above the bottom bar (the viewport's bottom padding).
    const cover = style.getPropertyValue("--map-cover").trim() === "1";
    range = zoomRange(boxW, boxH, dpr, T, sizedFor, cover);
    scale = zoomScale(pref, range);
    const { width: w, height: h } = viewPixels(
      Math.floor(boxW * dpr),
      Math.floor(boxH * dpr),
      scale,
      T,
      sizedFor,
    );
    if (app.renderer.width !== w || app.renderer.height !== h) app.renderer.resize(w, h);
    canvas.style.width = `${w / dpr}px`;
    canvas.style.height = `${h / dpr}px`;
    // The camera follows at once, not from the next frame: clicks and tileToClient read it
    // meanwhile. On creation this is what sets it before the game says it is ready: Pixi's
    // ticker skips a first frame whose time predates its start (a busy page), so the first
    // draw may come a frame or more later, and until then every tile sat at camera (0, 0),
    // far off the canvas (an e2e Shift+click right after `ready` read nothing on CI).
    follow(performance.now());
    if (
      !shown ||
      shown.scale !== scale ||
      shown.min !== range.min ||
      shown.fit !== range.fit ||
      shown.max !== range.max
    ) {
      shown = { scale, ...range };
      opts.zoomView?.(shown);
    }
  };
  /**
   * The player chose `p` (undefined = fit the view): draw it and remember it. A choice that
   * draws the same scale is dropped (a remembered zoom larger than this window allows
   * stays), except going back to fit.
   */
  const choose = (p: number | undefined): void => {
    if (p === pref || (p !== undefined && zoomScale(p, range) === scale)) return;
    pref = p;
    resize();
    opts.zoomed?.(pref);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  window.addEventListener("resize", resize);
  resize();

  const sprites = new Map<number, CreatureSprite>();
  const colorOf = (c: CreatureState): number =>
    c.id === world.selfId
      ? COLORS.self
      : c.kind === CreatureKind.MONSTER
        ? COLORS.monster
        : c.kind === CreatureKind.NPC
          ? COLORS.npc
          : COLORS.player;
  const nameOf = (c: CreatureState): string => creatureName(c, t);
  // Clip sets (render/clips.ts), built once per sprite: its frames by action and facing
  // when atlas.json animates it, else its single texture (moved procedurally).
  const clipCache = new Map<string, ClipSet<Texture> | null>();
  const lookup = (key: string): Texture | undefined => atlas.texture(key);
  const cachedClips = (
    key: string,
    build: () => ClipSet<Texture> | undefined,
  ): ClipSet<Texture> | undefined => {
    let clips = clipCache.get(key);
    if (clips === undefined) {
      clips = build() ?? null;
      clipCache.set(key, clips);
    }
    return clips ?? undefined;
  };
  // Monsters and NPCs: their atlas sprite (data/monsters, data/npcs), when there is one.
  const creatureClips = (c: CreatureState): ClipSet<Texture> | undefined => {
    const path =
      c.kind === CreatureKind.MONSTER
        ? content.monsterSprites[c.contentId]
        : c.kind === CreatureKind.NPC
          ? content.npcSprites?.[c.contentId]
          : undefined;
    return path ? cachedClips(path, () => spriteClips(path, atlas.index.anims, lookup)) : undefined;
  };
  /** An outfit animated in atlas.json (docs/17 ANI-6), not T0.5 frames. */
  const animatedOutfit = (o: OutfitDef): boolean =>
    Object.keys(atlas.index.anims?.[o.sprite]?.actions ?? {}).length > 0;
  const outfitClips = (o: OutfitDef): ClipSet<Texture> | undefined =>
    cachedClips(`outfit:${o.id}`, () => {
      if (animatedOutfit(o)) return spriteClips(o.sprite, atlas.index.anims, lookup);
      const first = atlas.texture(`${o.sprite}/s_0`);
      return legacyOutfitClips(o.sprite, o.frames, lookup, {
        w: first?.width ?? T,
        h: first?.height ?? T,
      });
    });
  // PvP marks (T5.2): their sprite when the atlas has real art for it (render/marks.ts).
  const markPath = (mark: Skull): string | undefined => {
    const path = markSprite(mark);
    return path && atlas.has(path) && isMarkArt(atlas.index.sprites[path]) ? path : undefined;
  };
  const markTexture = (mark: Skull): Texture | undefined => {
    const path = markPath(mark);
    return path ? atlas.texture(path) : undefined;
  };
  // Players: the outfit's frames (T0.5), only when the atlas has real art for every one of
  // them (an automatic placeholder per frame would look worse than the block). T5.7: the
  // outfit is the player's equipped outfit cosmetic; one without art falls back to citizen.
  const readyOutfits = new Map<string, boolean>();
  const outfitReady = (o: OutfitDef): boolean => {
    let ready = readyOutfits.get(o.id);
    if (ready === undefined) {
      ready =
        animatedOutfit(o) ||
        outfitKeys(o).every((k) => {
          const origin = atlas.index.sprites[k]?.origin;
          return atlas.has(k) && origin !== "auto" && origin !== "placeholder";
        });
      readyOutfits.set(o.id, ready);
    }
    return ready;
  };
  const citizen = content.outfits?.find((o) => o.id === DEFAULT_OUTFIT);
  const drawableOutfit = (o: OutfitDef | undefined): OutfitDef | undefined =>
    o && outfitReady(o) ? o : citizen && outfitReady(citizen) ? citizen : undefined;

  // Engine humanoids (docs/17 "Humanoides del motor", render/look.ts): a person is a paper
  // doll, a body and layers over it (packages/renderer look.ts), when the content has its
  // look and the atlas its body. A player's outfit without a look, or an atlas without the
  // layers, falls back to the outfit's sprite, then to the coloured block.
  const tables = content.looks;
  /** The paper doll of a look dressed so: the body's clips and every layer's. */
  const dollOf = (
    look: Look,
    dressed: Dressed,
    outfitTint: number,
  ): { clips: ClipSet<Texture>; layers: BodyLayer[] } | undefined => {
    if (!tables) return undefined;
    const layers: BodyLayer[] = [];
    let body: ClipSet<Texture> | undefined;
    for (const { slot, sprite, tint } of dollSprites(look, dressed, tables, outfitTint)) {
      const clips = cachedClips(sprite, () => spriteClips(sprite, atlas.index.anims, lookup));
      if (!clips?.meta) {
        if (slot === "body") return undefined;
        continue;
      }
      if (slot === "body") body = clips;
      layers.push({ slot, clips, tint });
    }
    return body ? { clips: body, layers } : undefined;
  };
  const NO_CLOTHES: ReadonlySet<WornSlot> = new Set();
  /**
   * A person's look, what it wears and the outfit colour, or undefined (not a person: a
   * beast, or a server that sends no looks). All of it comes from the server
   * (CreatureState.look, equipment and worn, docs/05 "Apariencia y equipo visible"): a
   * player wears the items of its visible slots over its outfit's clothes; an NPC or a
   * monster, the pieces of its data. What a person holds is what it attacks with.
   */
  const personOf = (
    c: CreatureState,
    player: { outfit: OutfitDef | undefined; tint: number } | undefined,
  ): { look: Look; dressed: Dressed; tint: number } | undefined => {
    const look = c.look;
    if (!look) return undefined;
    if (player) {
      const dressed = dressPlayer(player.outfit, wornFromVisible(c.equipment, content.items));
      return { look, dressed, tint: player.tint };
    }
    const dressed = { worn: c.worn ?? {}, clothes: NO_CLOTHES };
    return { look, dressed, tint: 0xffffff };
  };
  /** The clip an attack of `kind` plays: a paper doll's comes from the weapon it holds. */
  const attackActionOf = (id: number, kind: AttackKind): AttackAction =>
    figureAttack(kind, sprites.get(id)?.held);

  // Animation (packages/renderer anim.ts): one state per creature, kept while it is in
  // view (a cosmetic change rebuilds the sprites, not the state), and one input and pose
  // reused for every creature, so a frame allocates nothing for it (docs/07).
  const animStates = new Map<number, AnimState>();
  const animInput = newAnimInput();
  const pose = newPose();
  const stateOf = (id: number, now: number): AnimState => {
    let st = animStates.get(id);
    if (!st) {
      st = newAnimState(id, now);
      animStates.set(id, st);
    }
    return st;
  };
  // Steps (docs/17 MOV-7): what a step kicks up on each ground, by ground item, from the
  // `steps` of its sprite in atlas.json `tiles` (assets/sprites.yaml): a puff of dust, a
  // ripple. Particles of render/particles.ts, under the foot that touches the ground at
  // (px, py) sprite pixels (the living world's footfall, render/living.ts).
  const stepKinds = new Map<number, StepKind | null>();
  const kickUp = (px: number, py: number, z: number): void => {
    const ground = world.tile(Math.floor(px / T), Math.floor(py / T), z)?.[0];
    if (ground === undefined) return;
    let kind = stepKinds.get(ground);
    if (kind === undefined) {
      kind = stepKindOf(ground, content.items, atlas.index.tiles) ?? null;
      stepKinds.set(ground, kind);
    }
    if (kind) particles.kick(kind, px, py);
  };
  /**
   * Draws a creature's body for `now` (its step, facing and what happened to it). Its
   * tile's top-left is drawn at (bx, by) sprite pixels on the ground (not raised on a
   * table): the living world follows its feet from there.
   */
  const animateBody = (
    figure: CreatureBody,
    st: AnimState,
    c: CreatureState,
    now: number,
    gait: Gait | undefined,
    bx: number,
    by: number,
  ): boolean => {
    const w = world.activeWalk(c, now);
    const moving = w && now >= w.start && now < w.start + w.duration ? w : undefined;
    animInput.now = now;
    // docs/17 ANI-1: it faces its attack while that plays and until it walks or turns, else
    // its step or its own direction; a figure with diagonals turns to them, one without
    // keeps the half of a diagonal it already faces (faceTo, turnTo).
    const [fx, fy] = delta(world.facing(c, now));
    animInput.dir = faceTo(st, figure.clips.meta, now, fx, fy, moving !== undefined, figure.eight);
    animInput.walkStart = moving?.start;
    animInput.walkMs = moving?.duration ?? 0;
    animInput.moveDx = moving ? Math.sign(moving.to.x - moving.from.x) : 0;
    animInput.moveDy = moving ? Math.sign(moving.to.y - moving.from.y) : 0;
    const stepBefore = st.walkStart;
    animate(st, figure.clips.meta, animInput, pose);
    figure.draw(pose, dirIndex(animInput.dir));
    if (living) {
      // The walk cycle drawn and where the feet are: each foot that touches the ground
      // leaves its print, kicks up the ground (MOV-7) and, the own player's, sounds.
      const meta = figure.clips.meta;
      const w = walkSample;
      w.id = c.id;
      w.x = bx + figure.feetX;
      w.y = by + figure.feetY;
      w.z = c.pos.z;
      w.phase = pose.walk;
      w.frames = meta?.actions.walk?.frames ?? 0;
      w.dx = animInput.moveDx;
      w.dy = animInput.moveDy;
      w.cyclePx =
        (T * Math.hypot(animInput.moveDx, animInput.moveDy)) / walkCyclesPerStep(meta, animInput);
      w.gait = gait;
      w.sliding = slideSize(c.slide, now) * T > slidePx;
      w.self = c.id === world.selfId;
      w.stepMs = animInput.walkMs;
      living.onCreatureWalk(w);
    }
    // A step starting now: the plants of the tile it enters bend (a flier brushes none).
    if (moving && st.walkStart !== stepBefore) {
      const flying = figure.clips.meta?.flying === true;
      living?.onCreatureStep(
        { id: c.id, from: moving.from, to: moving.to, grounded: !flying },
        now,
      );
      if (!flying) livingObjects.onStep(moving.from, moving.to, now);
    }
    return pose.done;
  };

  // Who attacks and who gets hit (render/creature-events.ts): what arrived since the last
  // frame starts attack clips or lunges, flashes and pushes. A server with attack events
  // (A9) names the attacker and its target; for an older one the client works it out from
  // the effects, projectiles and damage numbers.
  let seenEvents = Number.NEGATIVE_INFINITY;
  const fighters = (): Iterable<Fighter> => world.creatures.values();
  const react = (now: number): void => {
    let newest = seenEvents;
    const z = world.self?.pos.z;
    if (world.attackEvents) {
      for (const a of world.attacks) {
        if (a.start <= seenEvents) continue;
        newest = Math.max(newest, a.start);
        const by = world.creatures.get(a.id);
        if (!by || by.pos.z !== z) continue;
        const target = a.targetId !== 0 ? world.creatures.get(a.targetId) : undefined;
        const [dx, dy] = attackDir(by, target, a.to);
        // Its own clip by kind (the bow, the spell), else the swing (docs/17 ANI-2).
        startAttack(stateOf(by.id, now), now, dx, dy, attackActionOf(by.id, a.kind));
      }
    } else newest = Math.max(newest, inferAttacks(now, z));
    for (const f of world.floatingTexts) {
      if (f.start <= seenEvents) continue;
      newest = Math.max(newest, f.start);
      if (f.kind !== FloatingTextKind.DAMAGE || f.pos.z !== z) continue;
      const victim = world.creatureAt(f.pos.x, f.pos.y, f.pos.z);
      if (!victim) continue;
      let from: Pos | undefined;
      if (world.attackEvents) {
        const a = attackerOf(victim, world.attacks, f.start);
        from = a && (a.radius > 0 ? a.to : world.creatures.get(a.id)?.pos);
      } else {
        const shot = world.projectiles.find((p) => p.start === f.start && samePos(p.to, f.pos));
        from = shot
          ? shot.from
          : meleeAttacker(victim, fighters(), world.selfId, world.target)?.pos;
      }
      const [dx, dy] = pushFrom(victim, from);
      startHit(stateOf(victim.id, now), now, dx, dy);
    }
    seenEvents = newest;
  };
  /**
   * An older server's fights: the attackers of its projectiles and blows, guessed. Returns
   * the newest time it looked at.
   */
  const inferAttacks = (now: number, z: number | undefined): number => {
    let newest = seenEvents;
    for (const p of world.projectiles) {
      if (p.start <= seenEvents) continue;
      newest = Math.max(newest, p.start);
      const shooter = p.from.z === z ? world.creatureAt(p.from.x, p.from.y, p.from.z) : undefined;
      if (shooter) startAttack(stateOf(shooter.id, now), now, p.to.x - p.from.x, p.to.y - p.from.y);
    }
    for (const e of world.effects) {
      if (e.start <= seenEvents || !isBlowEffect(e.effectId)) continue;
      newest = Math.max(newest, e.start);
      // A projectile that landed there in the same batch already animated its shooter.
      if (world.projectiles.some((p) => p.start === e.start && samePos(p.to, e.pos))) continue;
      const victim = e.pos.z === z ? world.creatureAt(e.pos.x, e.pos.y, e.pos.z) : undefined;
      const by = victim && meleeAttacker(victim, fighters(), world.selfId, world.target);
      if (victim && by)
        startAttack(stateOf(by.id, now), now, victim.pos.x - by.pos.x, victim.pos.y - by.pos.y);
    }
    return newest;
  };

  // Fallback body without a sprite: a coloured block with a mark on the side it faces.
  const drawShape = (s: CreatureSprite, c: CreatureState, dir: Direction): void => {
    const [dx, dy] = delta(dir);
    s.drawnDir = dir;
    if (s.figure) return;
    s.shape
      .clear()
      .rect(8, 5, 16, 24)
      .fill(colorOf(c))
      .stroke({ width: 1, color: COLORS.outline, alignment: 1 })
      .rect(14 + dx * 7, 15 + dy * 9, 4, 4)
      .fill(COLORS.marker);
  };

  const drawBar = (s: CreatureSprite, pct: number): void => {
    const w = Math.max(0, Math.min(100, pct));
    s.bar
      .clear()
      .rect(-BAR_W / 2 - 1, 0, BAR_W + 2, BAR_H)
      .fill(COLORS.barBack)
      .rect(-BAR_W / 2, 1, Math.round((BAR_W * w) / 100), BAR_H - 2)
      .fill(barColor(w));
    s.drawnHealth = pct;
  };

  const spriteOf = (c: CreatureState, now: number): CreatureSprite => {
    let s = sprites.get(c.id);
    const isPlayer = c.kind === CreatureKind.PLAYER;
    // The cosmetics (T5.7), the body or the visible equipment changed (CreatureCosmetics,
    // CreatureLook): build the sprites again. A number: no string per creature per frame.
    const lk = c.lookRev;
    if (s && s.drawnLook !== lk) {
      dropSprite(c.id);
      s = undefined;
    }
    if (!s) {
      const look = isPlayer ? playerLook(c.cosmetics, content, colorOf(c)) : undefined;
      const shape = new Graphics();
      const halo = new TargetHalo();
      const body = new Container({ label: `creature ${c.id}` });
      body.addChild(halo.graphic); // on the ground: the figure and the shape cover it
      body.addChild(shape);
      const person = personOf(c, look);
      const doll = person && dollOf(person.look, person.dressed, person.tint);
      let figure: CreatureBody | undefined;
      if (doll) figure = new CreatureBody(doll.clips, T, 0xffffff, doll.layers);
      else {
        const outfitDef = look ? drawableOutfit(look.outfit) : undefined;
        const clips = outfitDef ? outfitClips(outfitDef) : creatureClips(c);
        figure = clips ? new CreatureBody(clips, T, look?.tint) : undefined;
      }
      if (figure) body.addChild(figure.root);
      const bar = new Graphics();
      labels.addChild(bar);
      // Rasterised at the size it shows, in device pixels, and drawn 1:1 on whole pixels
      // (never scaled): sharp at any zoom and pixel density (render/label-style.ts).
      const line = (text: string, weight: string, px: number, fill: number, more?: object): Text =>
        new Text({
          text,
          style: {
            fontFamily: LABEL_FONT,
            fontWeight: weight as "500" | "700",
            fontSize: px,
            lineHeight: linePitch(px),
            align: "center",
            fill,
            stroke: { color: LABEL_OUTLINE, width: labelStroke(px), join: "round" },
            ...more,
          },
          anchor: { x: 0.5, y: 1 },
          roundPixels: true,
          textureStyle: { scaleMode: "nearest" },
        });
      // A name effect (T5.7) brings its fill, the outline's colour and a glow.
      const fx = look?.name;
      const label = line("", LABEL_NAME_WEIGHT, namePx, fx?.fill ?? colorOf(c), {
        ...(fx ? { stroke: { ...fx.stroke, width: labelStroke(namePx), join: "round" } } : {}),
        ...(fx?.dropShadow ? { dropShadow: fx.dropShadow } : {}),
      });
      labels.addChild(label);
      const role = line("", LABEL_SUB_WEIGHT, subPx, COLORS.role);
      labels.addChild(role);
      const guild = line(c.guild, LABEL_SUB_WEIGHT, subPx, COLORS.guild);
      labels.addChild(guild);
      const skull = new Container();
      labels.addChild(skull);
      s = {
        body,
        shape,
        halo,
        label,
        role,
        guild,
        fitName: "",
        fitRole: "",
        fitPx: 0,
        fitMax: 0,
        fitMin: 0,
        lines: { name: namePx, role: subPx, roleLines: 0, guild: subPx },
        top: 0,
        skull,
        drawnSkull: Skull.UNSPECIFIED,
        figure,
        gait: figure
          ? creatureGait(
              content,
              isPlayer ? undefined : c.contentId,
              bodyKindOf(
                isPlayer || c.look !== undefined,
                figure.clips.meta?.flying === true,
                figure.lift,
              ),
            )
          : undefined,
        drawnLook: lk,
        held: doll && person ? { weapon: person.dressed.worn.weapon?.shape } : undefined,
        bar,
        drawnDir: -1,
        drawnHealth: -1,
      };
      sprites.set(c.id, s);
    }
    // The language can change during the game (T1.13).
    // The lines (render/labels.ts): a long name shrinks, never cut; an NPC shows
    // what it does under its name, wrapped by its words and never cut. Fitted again only
    // when the text, the size (a zoom) or the room changed.
    const name = nameOf(c);
    const what = roleOf(c);
    if (
      s.fitName !== name ||
      s.fitRole !== what ||
      s.fitPx !== namePx ||
      s.fitMax !== labelMax ||
      s.fitMin !== nameMinPx
    ) {
      s.fitName = name;
      s.fitRole = what;
      s.fitPx = namePx;
      s.fitMax = labelMax;
      s.fitMin = nameMinPx;
      const fit = fitName(name, namePx, labelMax, measureName, nameMinPx);
      sizeLine(s.label, fit.fontPx);
      if (s.label.text !== fit.text) s.label.text = fit.text;
      const wrapped = wrapRole(what, subPx, labelMax, measureSub);
      sizeLine(s.role, wrapped.fontPx);
      const roleText = wrapped.lines.join("\n");
      if (s.role.text !== roleText) s.role.text = roleText;
      s.role.visible = wrapped.lines.length > 0;
      sizeLine(s.guild, subPx);
      s.lines.name = fit.fontPx;
      s.lines.role = wrapped.fontPx;
      s.lines.roleLines = wrapped.lines.length;
      s.lines.guild = subPx;
    }
    if (s.guild.text !== c.guild) s.guild.text = c.guild;
    if (s.drawnSkull !== c.skull) drawSkull(s.skull, c.skull, markTexture(c.skull));
    s.drawnSkull = c.skull;
    const facing = world.facing(c, now);
    if (s.drawnDir !== facing) drawShape(s, c, facing);
    if (s.drawnHealth !== c.health) drawBar(s, c.health);
    // The target's halo (render/target-halo.ts): under the body, on its feet's line.
    s.halo.update(
      world.target === c.id
        ? (s.figure?.stand() ?? { x: T / 2, y: T - 4, width: T - 8 })
        : undefined,
      now,
      reducedMotion(),
    );
    return s;
  };

  redrawLabels = (): void => {
    CanvasTextMetrics.clearMetrics();
    speech.refresh();
    widths.clear();
    for (const s of sprites.values()) {
      s.fitPx = 0; // measured with the fallback: fit the lines again
      s.label.style.update();
      s.role.style.update();
      s.guild.style.update();
    }
  };

  const dropLabels = (s: CreatureSprite): void => {
    s.label.destroy();
    s.role.destroy();
    s.guild.destroy();
    s.skull.destroy();
    s.bar.destroy();
  };
  const dropSprite = (id: number): void => {
    const s = sprites.get(id);
    if (!s) return;
    view.removeEntity(s.body);
    s.figure?.release(); // a paper doll's layers go back to the pool
    s.body.destroy({ children: true });
    dropLabels(s);
    sprites.delete(id);
  };

  // Leaving the view (ANI-2, ANI-5, ANI-7), as CreatureDisappear.reason says
  // (render/creature-events.ts leaveStyle): a creature that died stays where it fell,
  // without name or bar, while its death plays (an LPC body its clip, a single image the
  // procedural fall), over the corpse the server already put on the tile; one that left by
  // a teleport or a logout shimmers away where it was (VANISH_MS). Any other way out of the
  // view drops it. Each departure plays once, also when the creature is already back: a
  // player that dies in view and wakes up at a temple in view leaves its falling body at
  // the death spot and appears (fading in) at the temple.
  interface Ghost {
    id: number;
    body: Container;
    figure: CreatureBody;
    state: AnimState;
    dir: CreatureState["dir"];
  }
  const ghosts: Ghost[] = [];
  const lastSeen = new Map<number, CreatureState["dir"]>();
  const departures = new DepartureFeed();
  const dropGhost = (i: number): void => {
    const g = ghosts[i];
    if (!g) return;
    view.removeEntity(g.body);
    g.figure.release();
    g.body.destroy({ children: true });
    const last = ghosts.pop();
    if (last && last !== g) ghosts[i] = last;
  };
  /** A creature left the view: `style` says whether it falls, shimmers away or just goes. */
  const leave = (id: number, now: number, style: LeaveStyle): void => {
    const s = sprites.get(id);
    const state = animStates.get(id);
    animStates.delete(id);
    living?.forgetCreature(id);
    const dir = lastSeen.get(id);
    lastSeen.delete(id);
    if (!s || !s.figure || !state || style === "drop" || dir === undefined) {
      dropSprite(id);
      return;
    }
    dropLabels(s);
    sprites.delete(id);
    s.halo.update(undefined, now, false);
    if (style === "fall") startDeath(state, now);
    else startVanish(state, now);
    ghosts.push({ id, body: s.body, figure: s.figure, state, dir });
  };
  /** Plays the departures that arrived since the last frame on the bodies drawn then. */
  const depart = (now: number): void => {
    for (const d of departures.take(world.departures)) {
      const s = sprites.get(d.id);
      if (s) leave(d.id, now, leaveStyle(d.reason, s.drawnHealth));
    }
  };
  /**
   * A falling body keeps its shadows until it fades (the sun's, unless it fell indoors, and
   * the lights').
   */
  const drawGhosts = (now: number): void => {
    for (let i = ghosts.length - 1; i >= 0; i--) {
      const g = ghosts[i] as Ghost;
      const shaded = shade(g.figure, g.body.x / T, g.body.y / T);
      animInput.now = now;
      const [gx, gy] = delta(g.dir);
      animInput.dir = faceTo(g.state, g.figure.clips.meta, now, gx, gy, false, g.figure.eight);
      animInput.walkStart = undefined;
      animInput.walkMs = 0;
      animInput.moveDx = 0;
      animInput.moveDy = 0;
      animate(g.state, g.figure.clips.meta, animInput, pose);
      g.figure.draw(pose, dirIndex(animInput.dir));
      if (pose.done) dropGhost(i);
      else {
        if (shaded & 1) g.figure.castShadow(castShadows, g.body.x, g.body.y);
        if (shaded & 2) g.figure.castShadow(lightShadows, g.body.x, g.body.y);
      }
    }
  };

  /** The ring of the last click-to-walk while it lasts (docs/17 MOV-7). */
  const drawWalkMark = (now: number, z: number): void => {
    const mark = opts.walkMark?.();
    const ring = mark && mark.pos.z === z ? markRing(now - mark.at) : undefined;
    if (!mark || !ring) {
      if (walkMarkDrawn) walkMark.clear();
      walkMarkDrawn = false;
      return;
    }
    const c = tileToScreen(cam, mark.pos.x + 0.5, mark.pos.y + 0.5, T);
    const r = ring.radius * tilePixels(cam, T);
    walkMark
      .clear()
      .ellipse(Math.round(c.x), Math.round(c.y), r, r * MARK_SQUASH)
      .stroke({
        width: Math.max(1, scale),
        color: mark.reachable ? MARK_COLORS.reachable : MARK_COLORS.blocked,
        alpha: ring.alpha,
      });
    walkMarkDrawn = true;
  };

  // Effects, projectiles and floating numbers (render/effect-layer.ts): pooled, and the
  // effects play their atlas frames; drawn while the world state keeps them (it expires them).
  const effects = new EffectLayer({ world, atlas, effects: effectLayer, texts: textLayer, t });

  /**
   * ART-8: how many sprite pixels a creature drawn at `p` is raised: the elevation of its
   * tile, or between the two tiles of the step it is taking.
   */
  const raisedBy = (p: { x: number; y: number }, w: Walk | undefined, now: number): number => {
    if (!w || now < w.start || now >= w.start + w.duration)
      return view.elevationAt(Math.round(p.x), Math.round(p.y));
    const from = view.elevationAt(w.from.x, w.from.y);
    const to = view.elevationAt(w.to.x, w.to.y);
    return from === to ? from : Math.round(from + ((to - from) * (now - w.start)) / w.duration);
  };

  /** docs/17 UI-11: takes what was said since the last frame and draws the bubbles. */
  const drawSpeech = (now: number): void => {
    const on = opts.bubbles?.() ?? true;
    for (const said of world.takeSpeech()) {
      const style = admitSpeech(said.kind, on);
      if (!style) continue;
      const text = said.localized
        ? formatMessage(
            { key: said.localized.key, params: said.localized.params, at: now },
            content,
            t,
          )
        : (said.text ?? "");
      speech.say(said.speakerId, style, text, now);
    }
    if (!on) speech.clear();
    speech.setDensity(window.devicePixelRatio || 1);
    speech.draw(anchors, now);
    anchors.clear();
  };

  const draw = (now: number): void => {
    const self = world.self;
    if (!self) return;
    if (view.floor !== self.pos.z) view.setFloor(self.pos.z);
    // The server's window came with the Welcome, before the canvas; should it change, the
    // canvas fits the new one at once.
    if (world.view !== sizedFor) resize();
    follow(now);
    // A heavy hit to the player shakes the camera a little (render/shake.ts).
    const hitAt = world.heavyHitAt;
    if (hitAt !== undefined && now - hitAt < SHAKE_MS && opts.shake?.() === true) {
      const unit = tilePixels(cam, T);
      const o = shakeOffset(now - hitAt, window.devicePixelRatio || 1);
      cam = { ...cam, x: cam.x + o.x / unit, y: cam.y + o.y / unit };
    }
    view.render(cam, { width: app.screen.width, height: app.screen.height }, now);
    // ART-3: the wall pieces in front of the own player that cover it fade (the wall gives
    // way, never the player); the others stay hidden: hiding behind a wall is part of the game.
    let reveal: WorldRect | undefined;
    let revealRow = 0;
    const tilePx = tilePixels(cam, T);
    particleView.x = cam.x;
    particleView.y = cam.y;
    particleView.width = app.screen.width / tilePx;
    particleView.height = app.screen.height / tilePx;
    particles.update(now, particleView, emitters, isDark(self.pos.z), reducedMotion());
    livingView.x = cam.x;
    livingView.y = cam.y;
    livingView.width = particleView.width;
    livingView.height = particleView.height;
    livingView.z = self.pos.z;
    // The wind moves the plants in whole screen pixels at this zoom.
    livingView.zoom = cam.zoom;
    livingSelf.x = self.pos.x;
    livingSelf.y = self.pos.y;
    // Trail wear (state/trail-wear.ts): handed over whole, only when it changed.
    if (living && world.trailWear.version !== livingWear) {
      livingWear = world.trailWear.version;
      living.applyWear(world.trailWear.list(), true);
    }
    living?.onTick(now, livingView);
    for (const { event, at } of world.takeLiving()) {
      const e = livingEvent(event);
      if (e) livingObjects.onObjectEvent(e, at);
    }
    livingObjects.onTick(now, self.pos.z);
    drawnBoxes.reset();
    const skyNow = isDark(self.pos.z) ? sky.none() : sky.update(now);
    view.castShadowStrength = sky.staticShadows();
    const shadowPose = sky.shadowPose(skyNow);
    const casting = castShadows.begin(shadowPose);
    // After the map's render and the living world's tick: the chunks and the wind's strips
    // of this frame exist. Placed again only when the map or the sun moved.
    objectShadows.update(view, shadowPose, shadowWind);
    // A creature casts a shadow (the sun's, the moon's, a lamp's) or stands on its contact
    // ellipse, never both (shade).
    sunAlpha = casting && shadowPose ? shadowPose.alpha : 0;
    litOpen = isDark(self.pos.z) ? 1 : (skyNow?.lamps ?? 0);
    lit = false;
    if (lightField) {
      lightField.sync(view);
      litPose.alpha = lightField.alpha(now, reducedMotion());
      lit = lightField.count > 0 && lightShadows.begin(litPose);
    }
    if (!lit) lightShadows.hide();
    litObjects.update(view, lit ? lightField : undefined, litOpen);

    const seen = new Set<number>();
    const boxes: LabelBox[] = [];
    const stackLines: LabelLines = { name: 0, role: 0, roleLines: 0, guild: 0 };
    const nameSize = opts.nameSize?.() ?? DEFAULT_NAME_SIZE;
    const dpr = window.devicePixelRatio || 1;
    nameScale = labelScale(scale, nameSize);
    namePx = labelFontPx(scale, dpr, nameSize);
    nameMinPx = minNamePx(dpr);
    subPx = subFontPx(namePx, dpr);
    labelMax = labelMaxWidth(T * scale, namePx);
    const mark = markScale(namePx);
    const labelGap = Math.max(1, Math.round(namePx / 11));
    react(now);
    depart(now);
    for (const c of world.creatures.values()) {
      if (c.pos.z !== self.pos.z) continue;
      seen.add(c.id);
      const s = spriteOf(c, now);
      const p = world.drawPos(c, now);
      const w = world.activeWalk(c, now);
      // ART-8: on a table or a crate (between two tiles, between their heights), in tiles.
      const raised = raisedBy(p, w, now) / T;
      // Whole device pixels, like the camera (render/viewport.ts): smooth at any zoom.
      s.body.position.set(devicePixels(p.x, T, scale), devicePixels(p.y - raised, T, scale));
      // Only the invisible player itself is sent its creature: see-through (T3.2). A body
      // fades as one figure (CreatureBody.opacity): the container's alpha would fade a paper
      // doll layer by layer, the skin showing through the tunic.
      const see = c.id === world.selfId && world.invisible ? 0.4 : 1;
      if (s.figure) {
        s.figure.opacity = see;
        // No sun under a roof: there, underground and at night the lights cast instead.
        const shaded = shade(s.figure, p.x, p.y);
        if (c.id === world.selfId) selfShade = shaded;
        animateBody(
          s.figure,
          stateOf(c.id, now),
          c,
          now,
          s.gait,
          s.body.x,
          devicePixels(p.y, T, scale),
        );
        if (shaded & 1) s.figure.castShadow(castShadows, s.body.x, s.body.y);
        if (shaded & 2) s.figure.castShadow(lightShadows, s.body.x, s.body.y);
      }
      s.body.alpha = s.figure ? 1 : see;
      if (lastSeen.get(c.id) !== c.dir) lastSeen.set(c.id, c.dir);
      // While walking, draw on whichever end of the step comes later in row order, so the
      // creature is never hidden under the items of the tile it is entering or leaving.
      const step = w && now < w.start + w.duration ? w : undefined;
      const later = !step
        ? c.pos
        : step.from.y > step.to.y || (step.from.y === step.to.y && step.from.x > step.to.x)
          ? step.from
          : step.to;
      view.placeEntity(s.body, later.x, later.y);
      const lift = s.figure?.lift ?? 0;
      drawnBoxes.add(c.id, p.x, p.y - raised, lift / T, entityZIndex(later.x, later.y));
      if (c.id === world.selfId && s.figure) {
        reveal = figureRect(s.body.x, s.body.y, s.figure.sprite);
        revealRow = Math.max(later.y, Math.round(p.y));
      }
      // Over the head of a figure taller than its tile (ART-2).
      const head = tileToScreen(cam, p.x + 0.5, p.y - raised - lift / T, T);
      const barTop = Math.round(head.y) - BAR_H * scale;
      s.bar.position.set(Math.round(head.x), barTop);
      s.bar.scale.set(scale);
      // The names are drawn at their own size (docs/17 UI-3: never a scaled raster); the
      // skull, pixel art, grows in whole steps with them.
      s.skull.scale.set(mark);
      const hasGuild = c.guild !== "";
      const hasSkull = s.drawnSkull !== Skull.UNSPECIFIED;
      boxes.push({
        id: c.id,
        x: Math.round(head.x),
        y: barTop - labelGap,
        width:
          Math.max(
            s.label.width,
            s.lines.roleLines > 0 ? s.role.width : 0,
            hasGuild ? s.guild.width : 0,
          ) + (hasSkull ? (MARK_BOX.w + 2) * mark : 0),
        nameHeight: nameBlockHeight(s.lines),
        guildHeight: hasGuild ? linePitch(s.lines.guild) : 0,
        self: c.id === world.selfId,
        target: c.id === world.target,
        distance: Math.max(Math.abs(c.pos.x - self.pos.x), Math.abs(c.pos.y - self.pos.y)),
      });
    }
    view.revealBehind(reveal, revealRow, now);
    // Names, guild lines and skulls (T5.6): at small zoom neighbours would overlap, so
    // render/labels.ts drops guild lines and lifts or hides the labels of far creatures.
    const placements = placeLabels(boxes, T * scale, namePx);
    for (const b of boxes) {
      const s = sprites.get(b.id);
      const at = placements.get(b.id);
      if (!s || !at) continue;
      s.label.visible = at.show;
      s.role.visible = at.show && s.lines.roleLines > 0;
      s.guild.visible = at.show && at.guild;
      s.skull.visible = at.show;
      // From the bar up (render/labels.ts stackLabel): the guild line, an NPC's role and,
      // on top, the name; all on whole pixels.
      stackLines.name = s.lines.name;
      stackLines.role = s.lines.role;
      stackLines.roleLines = s.lines.roleLines;
      stackLines.guild = s.guild.visible ? s.lines.guild : 0;
      const stack = stackLabel(b.y - at.lift, stackLines);
      s.guild.position.set(b.x, stack.guild);
      s.role.position.set(b.x, stack.role);
      s.label.position.set(b.x, stack.name);
      s.top = stack.top;
      if (s.drawnSkull !== Skull.UNSPECIFIED) {
        s.skull.position.set(
          Math.round(s.label.x - s.label.width / 2 - (MARK_HALF + 2) * mark),
          Math.round(stack.name - linePitch(s.lines.name) / 2),
        );
      }
      // docs/17 UI-11: a speech bubble goes right over the name, the top line of the
      // label (or over the bar, without one).
      anchors.set(b.id, {
        x: b.x,
        top: at.show ? stack.top - 1 : b.y,
        self: b.self,
        distance: b.distance,
      });
    }
    drawSpeech(now);
    // Gone without a departure of its own (another floor, a new map view): it just goes.
    for (const id of [...sprites.keys()]) if (!seen.has(id)) leave(id, now, "drop");
    for (const id of animStates.keys())
      if (!seen.has(id)) {
        animStates.delete(id);
        living?.forgetCreature(id);
      }
    // The bodies falling or shimmering away cast their shadow too, until they fade below
    // half (CreatureBody.castShadow): it does not vanish the moment a creature dies.
    drawGhosts(now);
    if (casting) castShadows.end();
    if (lit) lightShadows.end();
    world.expire(now);
    drawWalkMark(now, self.pos.z);
    effects.draw(now, self.pos.z, cam, scale, nameScale);
    // Caves are dark; the surface takes the sky's colour at dawn, dusk and night, and its
    // lamps, fires and windows glow by how dark it is (render/sky.ts). By day: no pass.
    const cave = isDark(self.pos.z);
    if (cave || litSurface(skyNow)) {
      const lamps = cave ? 1 : (skyNow?.lamps ?? 0);
      lightTile = tilePixels(cam, T);
      fireTint = cave ? FIRE_TINT : dimmed(FIRE_TINT, lamps);
      const sp = world.drawPos(self, now);
      lights.begin(app.screen.width, app.screen.height, cave ? AMBIENT : skyNow?.ambient);
      if (lamps > 0)
        lights.add(
          (sp.x + 0.5 - cam.x) * lightTile,
          (sp.y + 0.5 - cam.y) * lightTile,
          PLAYER_LIGHT * lightTile,
          cave ? PLAYER_TINT : dimmed(PLAYER_TINT, lamps * NIGHT_PLAYER_LIGHT),
        );
      if (lamps > 0) view.forEachLight(addFireLight);
      lights.end(app.renderer);
    } else lights.hide();
  };

  app.ticker.add(() => {
    const now = performance.now();
    // A left press held still long enough walks toward the cursor (docs/17 MOV-3), in
    // time for this frame's step.
    if (press?.lp.tick(now) === "hold") startHold(press);
    opts.frame(now);
    draw(now);
    showHint(now);
  });

  /** worldAt's answer, reused. */
  const heldPoint = { x: 0, y: 0 };
  const toCanvas = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((clientX - r.left) * canvas.width) / r.width,
      y: ((clientY - r.top) * canvas.height) / r.height,
    };
  };
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // T5.6, fingers and pens (pointerType touch/pen; the mouse below is unchanged): a tap
  // walks or targets the creature (talks to an NPC), a long press opens the contextual
  // menu, a drag moves the top item. The page must not pan or zoom under the map.
  canvas.style.touchAction = "none";
  const gestures = new GestureRecognizer();
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;
  /** The tile under the finger that went down (a drag moves its item). */
  let touchTile: Pos | undefined;
  /** What that finger aimed at (the tile of a creature when it went down on its head; ART-2). */
  let touchAim: Pos | undefined;
  /** The last finger press on the canvas: when, and whether it already opened the menu. */
  let touchPress = { at: Number.NEGATIVE_INFINITY, menu: false };
  const tileUnder = (clientX: number, clientY: number): Pos | undefined => {
    const self = world.self;
    if (!self) return undefined;
    const p = toCanvas(clientX, clientY);
    const tile = screenToTile(cam, p.x, p.y, T);
    return { x: tile.x, y: tile.y, z: self.pos.z };
  };
  /**
   * ART-2: the creature drawn on top at canvas point p (its head may rise over the tile
   * above its own, unless that tile has something of its own to use), other than the own
   * player.
   */
  const creatureUnder = (p: { x: number; y: number }): CreatureState | undefined => {
    const w = screenToWorld(cam, p.x, p.y, T);
    const own = opts.ownUse;
    const z = world.self?.pos.z ?? 0;
    const box = drawnBoxes.pick(w.x, w.y, world.selfId, own && ((x, y) => own(x, y, z)));
    return box ? world.creatures.get(box.id) : undefined;
  };
  /** The tile a finger meant: the tile of the creature under it (its head counts), else its own. */
  const aimUnder = (clientX: number, clientY: number): Pos | undefined => {
    const at = tileUnder(clientX, clientY);
    return (at && creatureUnder(toCanvas(clientX, clientY))?.pos) ?? at;
  };
  /** The scale when the current pinch started (two fingers zoom by whole scales). */
  let pinchFrom: number | undefined;
  const onGestures = (gs: Gesture[], e: PointerEvent | undefined): void => {
    for (const g of gs) {
      if (g.kind === "pinchStart") {
        pinchFrom = scale;
      } else if (g.kind === "pinch") {
        if (pinchFrom !== undefined) choose(zoomPref(pinchZoom(pinchFrom, g.scale, range), range));
      } else if (g.kind === "pinchEnd") {
        pinchFrom = undefined;
      } else if (g.kind === "tap") {
        const at = aimUnder(g.x, g.y);
        if (at) opts.tapTile(at.x, at.y, at.z);
      } else if (g.kind === "longPress") {
        const at = touchAim;
        touchPress.menu = true;
        if (at) opts.longPressTile(at.x, at.y, at.z, g.x, g.y);
      } else if (g.kind === "dragStart" && e) {
        const at = touchTile;
        if (at) opts.dragTile(at.x, at.y, at.z, e);
      }
    }
    clearTimeout(longPressTimer);
    longPressTimer = undefined;
    const due = gestures.deadline();
    if (due !== undefined) {
      longPressTimer = setTimeout(
        () => onGestures(gestures.tick(performance.now()), undefined),
        Math.max(0, due - performance.now()),
      );
    }
  };
  const touchDown = (e: PointerEvent): void => {
    opts.touched();
    if (!gestures.active) {
      touchTile = tileUnder(e.clientX, e.clientY);
      touchAim = aimUnder(e.clientX, e.clientY);
      touchPress = { at: performance.now(), menu: false };
    }
    // Pointer event times share performance.now()'s clock.
    onGestures(gestures.down(e.pointerId, e.clientX, e.clientY, e.timeStamp), e);
  };
  canvas.addEventListener("pointercancel", (e) => {
    if (isTouchPointer(e.pointerType)) onGestures(gestures.cancel(e.pointerId), e);
  });
  // Mobile browsers announce their own long press with a contextmenu event, and may cancel
  // the pointer for it before our timer fires: take it as the long press of that finger.
  canvas.addEventListener("contextmenu", (e) => {
    const recent = performance.now() - touchPress.at < TOUCH_MENU_MS;
    if (!recent || touchPress.menu || !touchAim) return;
    touchPress.menu = true;
    gestures.reset();
    clearTimeout(longPressTimer);
    longPressTimer = undefined;
    opts.longPressTile(touchAim.x, touchAim.y, touchAim.z, e.clientX, e.clientY);
  });

  // Left: a click walks (on a tile without an item to drag, from the press on), shift+click
  // looks, a drag moves the top item, a press held walks toward the cursor (docs/17 MOV-3,
  // input/mouse.ts LeftPress). Right: attack the creature on the tile, or use the tile (a
  // ladder climbs); Ctrl+right uses its top item even on a ladder. The rule is
  // input/mouse.ts mapPress.
  interface Press {
    x: number;
    y: number;
    z: number;
    lp: LeftPress;
    /** The walk there started on the press: the release is no click. */
    walked: boolean;
    /**
     * A Shift press (docs/17 UI-6): released where it was it looks at this tile (a creature's
     * head too, ART-2); dragged, it moves part of the top item's stack.
     */
    look?: Pos | undefined;
    pointerId: number;
    /** Where the cursor is now (page coordinates). */
    cx: number;
    cy: number;
  }
  let press: Press | undefined;
  /** Captures the pointer so the hold goes on outside the canvas, and walks toward it. */
  const startHold = (p: Press): void => {
    try {
      canvas.setPointerCapture(p.pointerId);
    } catch {
      // The pointer is gone already (lostpointercapture or the next move ends the hold).
    }
    hideHint();
    opts.holdAt?.(p.cx, p.cy);
  };
  const endHold = (): void => {
    const p = press;
    press = undefined;
    if (p?.lp.holding) opts.holdEnd?.();
  };

  // docs/17 MOV-7, UI-5: the default action on the tile under the mouse, beside it, as soon
  // as the mouse moves over it (no wait for it to rest).
  // Its text is a CSS attr(): not text of the page (no locator or screen reader finds it).
  const hint = document.createElement("div");
  hint.className = "map-hint";
  hint.setAttribute("aria-hidden", "true");
  hint.hidden = true;
  document.body.appendChild(hint);
  let hover: { x: number; y: number } | undefined;
  let hintTile: Pos | undefined;
  let hintAt = Number.NEGATIVE_INFINITY;
  const hideHint = (): void => {
    hintTile = undefined;
    if (!hint.hidden) hint.hidden = true;
  };
  // docs/17 UI-6: the card of the item on the tile under the mouse (ui/ItemTooltip.tsx), at
  // once (the owner on 2026-11-18: "como en diablo"). From one tile to the next the Game
  // swaps the card in a single update: no gap, no flicker while sweeping the map.
  let restAt: Pos | undefined;
  let resting = false;
  const stopRest = (): void => {
    restAt = undefined;
    if (resting) opts.restTile?.(undefined);
    resting = false;
  };
  const watchRest = (cx: number, cy: number): void => {
    if (!opts.restTile || press) return;
    const tile = tileUnder(cx, cy);
    if (tile && restAt && samePos(tile, restAt)) return; // still on it: the card stays
    if (!tile) {
      stopRest();
      return;
    }
    restAt = tile;
    resting = true;
    opts.restTile({ ...tile, cx, cy });
  };
  const showHint = (now: number): void => {
    if (!hover || press || !opts.hoverText) {
      hideHint();
      return;
    }
    const tile = tileUnder(hover.x, hover.y);
    if (!tile) {
      hideHint();
      return;
    }
    // The map moved under a still mouse (the player walks): the card of the old tile goes
    // and the rest starts again on the new one.
    if (restAt && !samePos(tile, restAt)) watchRest(hover.x, hover.y);
    if (hintTile && samePos(tile, hintTile) && now - hintAt < HINT_REFRESH_MS) return;
    hintTile = tile;
    hintAt = now;
    const text = opts.hoverText(tile.x, tile.y, tile.z);
    if (hint.dataset["text"] !== text) hint.dataset["text"] = text;
    const hidden = text === "";
    if (hint.hidden !== hidden) hint.hidden = hidden;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (isTouchPointer(e.pointerType)) {
      touchDown(e);
      return;
    }
    hideHint();
    stopRest();
    if (e.button !== 0 && e.button !== 2) return;
    const self = world.self;
    if (!self) return;
    const p = toCanvas(e.clientX, e.clientY);
    const tile = screenToTile(cam, p.x, p.y, T);
    const z = self.pos.z;
    // ART-2: the drawn creatures first (a click on the head of a tall one), then the tile.
    const hit = e.button === 2 || e.shiftKey ? creatureUnder(p) : undefined;
    const at = hit?.pos ?? tile;
    const c = e.button === 2 ? (hit ?? world.creatureAt(tile.x, tile.y, z)) : undefined;
    const other = c && c.id !== world.selfId ? c : undefined;
    const inDoor = other?.kind === CreatureKind.PLAYER && (opts.doorAt?.(at.x, at.y, z) ?? false);
    const act = mapPress(e.button, e, other?.id, inDoor, opts.controls?.() ?? "classic");
    if (act.kind === "attack") opts.clickCreature(act.creature);
    else if (act.kind === "use")
      opts.useTile(inDoor ? at.x : tile.x, inDoor ? at.y : tile.y, z, act.top);
    else if (act.kind === "menu") opts.menuTile?.(at.x, at.y, z, e.clientX, e.clientY);
    else if (act.kind === "look" && e.button === 0) {
      endHold();
      press = {
        x: tile.x,
        y: tile.y,
        z,
        lp: new LeftPress(performance.now(), p.x, p.y, { drag: true, hold: false }, DRAG_START_PX),
        walked: false,
        look: { x: at.x, y: at.y, z },
        pointerId: e.pointerId,
        cx: e.clientX,
        cy: e.clientY,
      };
    } else if (act.kind === "look") opts.lookTile(at.x, at.y, z);
    else if (act.kind === "press") {
      endHold(); // a press left over (its release went elsewhere)
      const can = opts.pressTile?.(tile.x, tile.y, z) ?? { walked: false, drag: true, hold: false };
      press = {
        x: tile.x,
        y: tile.y,
        z,
        lp: new LeftPress(performance.now(), p.x, p.y, can, DRAG_START_PX),
        walked: can.walked,
        pointerId: e.pointerId,
        cx: e.clientX,
        cy: e.clientY,
      };
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (isTouchPointer(e.pointerType)) {
      onGestures(gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp), e);
      return;
    }
    hover = { x: e.clientX, y: e.clientY };
    hint.style.transform = `translate(${e.clientX + HINT_OFFSET.x}px, ${e.clientY + HINT_OFFSET.y}px)`;
    watchRest(e.clientX, e.clientY);
    if (!press) return;
    if ((e.buttons & 1) === 0) {
      endHold(); // the button went up where no pointerup reached the canvas
      return;
    }
    press.cx = e.clientX;
    press.cy = e.clientY;
    if (press.lp.holding) {
      opts.holdAt?.(e.clientX, e.clientY);
      return;
    }
    const p = toCanvas(e.clientX, e.clientY);
    const change = press.lp.move(p.x, p.y);
    if (change === "drag") {
      const from = press;
      press = undefined;
      opts.dragTile(from.x, from.y, from.z, e);
    } else if (change === "hold") startHold(press);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (isTouchPointer(e.pointerType)) {
      onGestures(gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp), e);
      return;
    }
    if (!press || e.button !== 0) return;
    const from = press;
    const end = from.lp.up();
    press = undefined;
    if (end === "hold") opts.holdEnd?.();
    else if (end === "click" && from.look) opts.lookTile(from.look.x, from.look.y, from.look.z);
    else if (end === "click" && !from.walked) opts.clickTile(from.x, from.y, from.z);
  });
  // A hold captures the pointer: it ends with its pointerup, or here if the capture is lost
  // (the window lost the focus, the canvas went away).
  canvas.addEventListener("lostpointercapture", () => {
    if (press?.lp.holding) endHold();
  });
  canvas.addEventListener("pointerleave", () => {
    hover = undefined;
    hideHint();
    stopRest();
    // A hold has the pointer captured: it goes on outside the canvas.
    if (press && !press.lp.holding) press = undefined;
  });
  // docs/17 UI-6: a double click does the tile's default action (the Game decides whether
  // it counts: only in the menu controls, and never right after a finger).
  canvas.addEventListener("dblclick", (e) => {
    const self = world.self;
    if (!self || e.button !== 0 || e.shiftKey) return;
    const p = toCanvas(e.clientX, e.clientY);
    const tile = screenToTile(cam, p.x, p.y, T);
    opts.doubleClickTile?.(tile.x, tile.y, self.pos.z);
  });

  // Ctrl+wheel (and a trackpad pinch, which browsers send as Ctrl+wheel) zooms the map
  // instead of the page; a plain wheel does nothing, as before.
  const wheel = new WheelZoom();
  const onWheel = (e: WheelEvent): void => {
    stopRest();
    if (!e.ctrlKey) return;
    e.preventDefault();
    const steps = wheel.add(e.deltaY, e.deltaMode, e.timeStamp);
    if (steps !== 0) choose(stepZoom(scale, steps, range));
  };
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return {
    get scale() {
      return scale;
    },
    get zoom() {
      return { scale, ...range };
    },
    get shown() {
      return shownTiles(app.screen.width, app.screen.height, scale, T);
    },
    labels() {
      const r = canvas.getBoundingClientRect();
      const k = r.width / (app.screen.width || 1);
      const shown: LabelsShown["shown"] = [];
      for (const [id, s] of sprites) {
        if (!s.label.visible || s.label.destroyed) continue;
        const b = s.label.getBounds();
        shown.push({
          id,
          text: s.label.text,
          fontPx: s.lines.name,
          role: s.lines.roleLines > 0 ? s.role.text : "",
          roleFontPx: s.lines.role,
          fill: Number(s.label.style.fill),
          scale: s.label.scale.x,
          top: r.top + s.top * k,
          x: r.left + b.x * k,
          y: r.top + b.y * k,
          width: b.width * k,
          height: b.height * k,
        });
      }
      return { fontPx: namePx, zoom: scale, dpr: window.devicePixelRatio || 1, shown };
    },
    wallFade(x, y) {
      return { alphas: view.wallAlphaAt(x, y) };
    },
    zoomBy(steps) {
      choose(stepZoom(scale, steps, range));
    },
    bubbles() {
      return speech.shown();
    },
    footfalls() {
      const n = Math.min(ownFallCount, OWN_FOOTFALLS);
      const own = [];
      for (let i = ownFallCount - n; i < ownFallCount; i++) {
        const f = ownFalls[i % OWN_FOOTFALLS];
        if (f) own.push({ ...f });
      }
      const prints = (living?.footprints() ?? []).map((p) => ({
        side: p.side,
        x: p.x,
        y: p.y,
        wear: p.wear,
        surface: p.surface,
      }));
      return { footprints: prints.length, total: ownFallCount, own, prints };
    },
    gust(x, y, min) {
      const g = living?.nextGust(x, y, performance.now(), min);
      return g && living && { at: g.at, strength: g.strength, calm: !living.stats().gusting };
    },
    lightShadows() {
      const me = world.self;
      return {
        lights: lightField?.count ?? 0,
        shadows: lightShadows.root.visible ? lightShadows.count : 0,
        objectShadows: lightShadows.root.visible ? litObjects.count : 0,
        selfIndoor: me ? view.indoorAt(me.pos.x, me.pos.y) : false,
        selfContact: sprites.get(world.selfId)?.figure?.contactAlpha ?? 0,
        selfLit: lightShadows.root.visible && (selfShade & 2) !== 0,
      };
    },
    sky() {
      const s = sky.current;
      if (!s || isDark(world.self?.pos.z ?? 0)) return undefined;
      return {
        phase: s.phase,
        ambient: s.ambient,
        lamps: s.lamps,
        moon: s.moon,
        shadowAlpha: s.shadow.alpha,
        shadows: castShadows.root.visible ? castShadows.count : 0,
        shadowX: s.shadow.x,
        shadowY: s.shadow.y,
        objectShadows: castShadows.root.visible ? objectShadows.count : 0,
        casters: castShadows.root.visible ? objectShadows.casters : 0,
        swayingShadows: castShadows.root.visible ? objectShadows.swaying : 0,
        contacts: [...sprites.values()].filter((sp) => sp.figure?.contactShown).length,
        selfContact: sprites.get(world.selfId)?.figure?.contactShown === true,
      };
    },
    haloIds() {
      return [...sprites].filter(([, sp]) => sp.halo.graphic.visible).map(([id]) => id);
    },
    drawnFacing(id) {
      const st = animStates.get(id);
      const figure = sprites.get(id)?.figure;
      return st && figure ? { facing: st.facing, eight: figure.eight } : undefined;
    },
    poses() {
      const now = performance.now();
      const attacking: PoseTime[] = [];
      for (const [id, st] of animStates) {
        const meta = sprites.get(id)?.figure?.clips.meta;
        const c = world.creatures.get(id);
        const dir = st.facing;
        const clip = attackClip(meta, st.attackAction, dir);
        const action = clip ? attackClipAction(meta, st.attackAction, dir) : "lunge";
        const of = clip ? clip.frames * clip.ms : LUNGE_OUT_MS + LUNGE_BACK_MS;
        const ms = now - st.attackAt;
        if (ms >= 0 && ms < of)
          attacking.push({ id, ms, of, action, x: c?.pos.x ?? 0, y: c?.pos.y ?? 0 });
      }
      const dying: PoseTime[] = [];
      const vanishing: PoseTime[] = [];
      for (const g of ghosts) {
        // Where its body stays: the tile it was drawn on last.
        const x = Math.round(g.body.x / T);
        const y = Math.round(g.body.y / T);
        if (Number.isNaN(g.state.diedAt)) {
          const ms = now - g.state.vanishAt;
          vanishing.push({ id: g.id, ms, of: VANISH_MS, action: "vanish", x, y });
          continue;
        }
        const clip = clipMs(g.figure.clips.meta, "death");
        dying.push({
          id: g.id,
          ms: now - g.state.diedAt,
          of: clip ? clip + DEATH_FADE_MS : DEATH_MS,
          action: "death",
          x,
          y,
        });
      }
      return { attacking, dying, vanishing };
    },
    element: canvas,
    clientToTile(clientX, clientY) {
      const self = world.self;
      const r = canvas.getBoundingClientRect();
      if (!self || clientX < r.left || clientY < r.top || clientX >= r.right || clientY >= r.bottom)
        return undefined;
      const p = toCanvas(clientX, clientY);
      const tile = screenToTile(cam, p.x, p.y, T);
      return { x: tile.x, y: tile.y, z: self.pos.z };
    },
    worldAt(clientX, clientY) {
      if (!world.self) return undefined;
      // No object of its own (toCanvas makes one): a hold asks every frame (docs/07).
      const r = canvas.getBoundingClientRect();
      const sx = ((clientX - r.left) * canvas.width) / r.width;
      const sy = ((clientY - r.top) * canvas.height) / r.height;
      return screenToWorld(cam, sx, sy, T, heldPoint);
    },
    markIcon(mark) {
      const path = markPath(mark);
      return path ? atlas.icon(path) : undefined;
    },
    itemColor(itemId) {
      const sprite = content.items[itemId]?.sprite;
      return sprite ? atlas.index.minimap?.[sprite] : undefined;
    },
    itemIcon(itemId) {
      const sprite = content.items[itemId]?.sprite;
      return sprite ? atlas.icon(sprite) : undefined;
    },
    spriteIcon(path) {
      return atlas.icon(path);
    },
    tileToClient(x, y) {
      const s = tileToScreen(cam, x + 0.5, y + 0.5, T);
      const r = canvas.getBoundingClientRect();
      return {
        x: r.left + (s.x * r.width) / canvas.width,
        y: r.top + (s.y * r.height) / canvas.height,
      };
    },
    destroy() {
      redrawLabels = () => {};
      clearTimeout(longPressTimer);
      hint.remove();
      gestures.reset();
      observer.disconnect();
      window.removeEventListener("resize", resize);
      for (const id of [...sprites.keys()]) dropSprite(id);
      while (ghosts.length > 0) dropGhost(ghosts.length - 1);
      effects.destroy();
      speech.destroy();
      lights.destroy();
      // Before the living world: the trees' shadow meshes share its strips.
      objectShadows.destroy();
      castShadows.destroy();
      litObjects.destroy();
      lightShadows.destroy();
      living?.destroy();
      livingObjects.destroy();
      view.destroy();
      app.destroy(true, { children: true });
    },
  };
}
