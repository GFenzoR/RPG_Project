// The game view: a PixiJS canvas over @rpg/renderer's MapView. It shows 15x11 tiles
// centred on the own creature, scaled by a whole number of device pixels per sprite
// pixel (pixel-perfect: no smoothing, no fractional scale), and draws the creatures
// interleaved with the item stacks (ground → items → creatures, row by row), then effects
// and floating texts on top, then names and health bars. Input goes back to the caller as
// tile clicks (left: walk) and creature clicks (right: attack). The player may zoom in by
// whole scales (render/zoom.ts: pinch, the +/- buttons, Ctrl+wheel): the canvas is then
// cut to the map's box and still centred on the own creature.
import { Application, Container, Graphics, Sprite, Text, TextureStyle } from "pixi.js";
import type { Texture } from "pixi.js";
import { CreatureKind, FloatingTextKind, Skull } from "@rpg/protocol";
import type { Direction } from "@rpg/protocol";
import {
  Atlas,
  MISSING_TEXTURE,
  MapView,
  animate,
  newAnimInput,
  newAnimState,
  newPose,
  screenToTile,
  startAttack,
  startDeath,
  startHit,
  tileToScreen,
} from "@rpg/renderer";
import type { AnimState, AtlasIcon, Camera, TileArt } from "@rpg/renderer";
import { dirIndex, legacyOutfitClips, spriteClips } from "./clips.ts";
import type { ClipSet } from "./clips.ts";
import { CreatureBody } from "./creature-body.ts";
import { isBlowEffect, meleeAttacker, pushOf } from "./creature-events.ts";
import type { Fighter } from "./creature-events.ts";
import { VIEW_TILES, devicePixels, followCamera, mapLift } from "./viewport.ts";
import {
  WheelZoom,
  pinchZoom,
  stepZoom,
  viewPixels,
  zoomPref,
  zoomRange,
  zoomScale,
} from "./zoom.ts";
import type { ZoomRange, ZoomView } from "./zoom.ts";
import { labelText, placeLabels } from "./labels.ts";
import type { LabelBox } from "./labels.ts";
import { GestureRecognizer, isTouchPointer } from "../input/gestures.ts";
import type { Gesture } from "../input/gestures.ts";
import { mapPress } from "../input/mouse.ts";
import type { ControlsMode } from "../state/controls.ts";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { delta, samePos } from "../state/geometry.ts";
import type { Pos } from "../state/geometry.ts";
import { creatureName } from "../state/messages.ts";
import { skullColor } from "../state/pvp.ts";
import { lookKey, playerLook } from "./cosmetics.ts";
import { MARK_BOX, isMarkArt, markSprite } from "./marks.ts";
import type { OutfitDef } from "../content-types.ts";
import { DEFAULT_OUTFIT, outfitDir, outfitKeys } from "./outfit.ts";
import { EffectLayer } from "./effect-layer.ts";
import type { CreatureState, WorldState } from "../state/world.ts";

const COLORS = {
  background: 0x000000,
  self: 0x3a7bd5,
  player: 0xd59a3a,
  monster: 0xb03a2e,
  npc: 0x7d4fb0,
  guild: 0xb8e986,
  marker: 0xffffff,
  outline: 0x101010,
  target: 0xff2020,
  barBack: 0x101010,
  barHigh: 0x30c030,
  barMid: 0xe0c020,
  barLow: 0xd03020,
};

/** Health bar size in sprite pixels. */
const BAR_W = 26;
const BAR_H = 4;

/** The own player seen through a wall (ART-3): its sprite, light and translucent. */
const BEHIND_WALL_ALPHA = 0.45;
const BEHIND_WALL_TINT = 0xd6e2ff;

const barColor = (pct: number): number =>
  pct > 50 ? COLORS.barHigh : pct > 25 ? COLORS.barMid : COLORS.barLow;

export interface GameCanvas {
  /** Page coordinates of the centre of tile (x, y) on the current floor (tests, tooling). */
  tileToClient(x: number, y: number): { x: number; y: number };
  /** The tile of the own floor under page coordinates, or undefined outside the canvas. */
  clientToTile(clientX: number, clientY: number): Pos | undefined;
  /** Where an item's sprite is in the atlas, for DOM icons (inventory). */
  itemIcon(itemId: number): AtlasIcon | undefined;
  /** Where any sprite of the atlas is (an NPC's portrait in its dialog), real art or not. */
  spriteIcon(path: string): AtlasIcon | undefined;
  /** Where a PvP mark's sprite is in the atlas (real art only), for the battle list. */
  markIcon(mark: Skull): AtlasIcon | undefined;
  /** Current device pixels per sprite pixel. */
  readonly scale: number;
  /** The scale and the scales the player may choose now. */
  readonly zoom: ZoomView;
  /** Zooms `steps` whole scales in (+) or out (-), within the range (the +/- buttons). */
  zoomBy(steps: number): void;
  /** The <canvas> element (drop target for items dragged onto the map). */
  readonly element: HTMLCanvasElement;
  destroy(): void;
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
  /** The left button was pressed on a tile and dragged (move its top item). */
  dragTile(x: number, y: number, z: number, e: PointerEvent): void;
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
  frame: Graphics;
  label: Text;
  /** The guild name, between the name and the health bar (T5.1); empty = hidden. */
  guild: Text;
  /** The PvP mark left of the name (T5.2): its sprite, or shapes without one (drawSkull). */
  skull: Container;
  drawnSkull: Skull;
  /**
   * The animated body (docs/17 ANI): a monster's or NPC's sprite, or a player's outfit
   * (T0.5; T5.7: the equipped outfit cosmetic, else citizen). Undefined = the coloured block.
   */
  figure: CreatureBody | undefined;
  /** lookKey of the cosmetics the sprites were built with (T5.7): a change rebuilds them. */
  drawnLook: string;
  bar: Graphics;
  drawnDir: number;
  drawnHealth: number;
  drawnTarget: boolean;
}

export async function createGameCanvas(
  host: HTMLElement,
  opts: GameCanvasOptions,
): Promise<GameCanvas> {
  const { world, content, t } = opts;
  TextureStyle.defaultOptions.scaleMode = "nearest";
  // From the site root: the game page lives in /play/ (T4.3).
  const atlas = await Atlas.load(new URL("/atlas/", document.baseURI).href);
  const T = atlas.tileSize;
  const app = new Application();
  await app.init({
    width: VIEW_TILES.width * T,
    height: VIEW_TILES.height * T,
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

  const textures = new Map<string, Texture>();
  const texture = (id: string): Texture => {
    let tex = textures.get(id);
    if (!tex) {
      const sprite = content.items[Number(id)]?.sprite;
      tex = (sprite && atlas.texture(sprite)) || MISSING_TEXTURE;
      textures.set(id, tex);
    }
    return tex;
  };
  // Tile art (docs/17 ART-3, ART-4, ART-7): ground looks, wall pieces, animated tiles, anchors
  // and cast shadows, resolved once per item.
  const arts = new Map<string, TileArt<Texture> | null>();
  const art = (id: string): TileArt<Texture> | undefined => {
    let a = arts.get(id);
    if (a === undefined) {
      const sprite = content.items[Number(id)]?.sprite;
      a = (sprite && atlas.tileArt(sprite)) || null;
      arts.set(id, a);
    }
    return a ?? undefined;
  };
  const view = new MapView({
    source: world,
    texture,
    art,
    tileSize: T,
    floor: world.self?.pos.z ?? 7,
  });
  // ART-3: when a wall hides the own player (the wall right south of it covers its tile), a
  // see-through copy of its sprite is drawn over the map, so the player never loses itself.
  // The others stay hidden: hiding behind a wall is part of the game.
  const behindWall = new Sprite({
    anchor: { x: 0.5, y: 1 },
    alpha: BEHIND_WALL_ALPHA,
    tint: BEHIND_WALL_TINT,
    visible: false,
    roundPixels: true,
  });
  view.overlay.addChild(behindWall);
  const effectLayer = new Container({ label: "effects" });
  const textLayer = new Container({ label: "floating texts" });
  const labels = new Container({ label: "labels" });
  app.stage.addChild(view.root, effectLayer, labels, textLayer);

  let scale = 1;
  let cam: Camera = { x: 0, y: 0, zoom: 1 };
  // The zoom the player chose (undefined = fit the whole view) and what the map's box
  // allows; `scale` is the one drawn.
  let pref = opts.zoom;
  let range: ZoomRange = { min: 1, max: 1 };
  let shown: ZoomView | undefined;
  /**
   * Centres the camera on the player as drawn at `now`. Zoomed in, the canvas shows fewer
   * (and fractional) tiles: centre those.
   */
  const follow = (now: number): void => {
    const self = world.self;
    if (!self) return;
    const sp = world.drawPos(self, now);
    const tilePx = T * scale;
    cam = followCamera(sp.x, sp.y, scale, T, {
      width: app.screen.width / tilePx,
      height: app.screen.height / tilePx,
    });
  };
  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    // The map's box is the host's content box: a padding keeps the canvas off a strip of
    // controls (portrait with the touch pad, touch.css).
    const style = getComputedStyle(host);
    const px = (v: string): number => parseFloat(v) || 0;
    const boxW = Math.max(0, host.clientWidth - px(style.paddingLeft) - px(style.paddingRight));
    const boxH = Math.max(0, host.clientHeight - px(style.paddingTop) - px(style.paddingBottom));
    range = zoomRange(boxW, boxH, dpr, T);
    scale = zoomScale(pref, range);
    const { width: w, height: h } = viewPixels(
      Math.floor(boxW * dpr),
      Math.floor(boxH * dpr),
      scale,
      T,
    );
    if (app.renderer.width !== w || app.renderer.height !== h) app.renderer.resize(w, h);
    canvas.style.width = `${w / dpr}px`;
    canvas.style.height = `${h / dpr}px`;
    // A strip at the bottom of the box that the canvas keeps clear when it can: the desktop
    // hotbar (--map-reserve-bottom in client.css, px). A click on the last row of tiles
    // cast F1 at 1280x800.
    const lift = mapLift(boxH, h / dpr, px(style.getPropertyValue("--map-reserve-bottom")));
    canvas.style.marginBottom = lift > 0 ? `${lift}px` : "";
    // The camera follows at once, not from the next frame: clicks and tileToClient read it
    // meanwhile. On creation this is what sets it before the game says it is ready: Pixi's
    // ticker skips a first frame whose time predates its start (a busy page), so the first
    // draw may come a frame or more later, and until then every tile sat at camera (0, 0),
    // far off the canvas (an e2e Shift+click right after `ready` read nothing on CI).
    follow(performance.now());
    if (!shown || shown.scale !== scale || shown.min !== range.min || shown.max !== range.max) {
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
  /** Draws a creature's body for `now` (its step, facing and what happened to it). */
  const animateBody = (
    figure: CreatureBody,
    st: AnimState,
    c: CreatureState,
    now: number,
  ): boolean => {
    const w = world.activeWalk(c, now);
    const moving = w && now >= w.start && now < w.start + w.duration ? w : undefined;
    animInput.now = now;
    animInput.dir = outfitDir(world.facing(c, now));
    animInput.walkStart = moving?.start;
    animInput.walkMs = moving?.duration ?? 0;
    animInput.moveDx = moving ? Math.sign(moving.to.x - moving.from.x) : 0;
    animate(st, figure.clips.meta, animInput, pose);
    figure.draw(pose, dirIndex(animInput.dir));
    return pose.done;
  };

  // Who attacks and who gets hit (render/creature-events.ts): the effects, projectiles and
  // damage numbers that arrived since the last frame start lunges, flashes and pushes.
  let seenEvents = Number.NEGATIVE_INFINITY;
  const fighters = (): Iterable<Fighter> => world.creatures.values();
  const react = (now: number): void => {
    let newest = seenEvents;
    const z = world.self?.pos.z;
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
    for (const f of world.floatingTexts) {
      if (f.start <= seenEvents) continue;
      newest = Math.max(newest, f.start);
      if (f.kind !== FloatingTextKind.DAMAGE || f.pos.z !== z) continue;
      const victim = world.creatureAt(f.pos.x, f.pos.y, f.pos.z);
      if (!victim) continue;
      const shot = world.projectiles.find((p) => p.start === f.start && samePos(p.to, f.pos));
      const by = shot
        ? world.creatureAt(shot.from.x, shot.from.y, shot.from.z)
        : meleeAttacker(victim, fighters(), world.selfId, world.target);
      const [dx, dy] = pushOf(victim, by);
      startHit(stateOf(victim.id, now), now, dx, dy);
    }
    seenEvents = newest;
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

  const drawFrame = (s: CreatureSprite, on: boolean): void => {
    s.frame.clear();
    if (on)
      s.frame.rect(1, 1, T - 2, T - 2).stroke({ width: 2, color: COLORS.target, alignment: 1 });
    s.drawnTarget = on;
  };

  const spriteOf = (c: CreatureState, now: number): CreatureSprite => {
    // A creature that died in view and is back (a player's respawn) ends its fall at once.
    if (ghosts.has(c.id)) dropGhost(c.id);
    let s = sprites.get(c.id);
    const isPlayer = c.kind === CreatureKind.PLAYER;
    const lk = isPlayer ? lookKey(c.cosmetics) : "";
    // T5.7: equipped cosmetics changed (CreatureCosmetics): build the sprites again.
    if (s && s.drawnLook !== lk) {
      dropSprite(c.id);
      s = undefined;
    }
    if (!s) {
      const look = isPlayer ? playerLook(c.cosmetics, content, colorOf(c)) : undefined;
      const shape = new Graphics();
      const frame = new Graphics();
      const body = new Container({ label: `creature ${c.id}` });
      body.addChild(shape);
      const outfitDef = look ? drawableOutfit(look.outfit) : undefined;
      const clips = outfitDef ? outfitClips(outfitDef) : creatureClips(c);
      const figure = clips ? new CreatureBody(clips, T, look?.tint) : undefined;
      if (figure) body.addChild(figure.root);
      body.addChild(frame); // the target frame goes over the body
      const bar = new Graphics();
      labels.addChild(bar);
      const label = new Text({
        text: nameOf(c),
        style: {
          fontFamily: "sans-serif",
          fontSize: 12,
          fontWeight: "bold",
          fill: colorOf(c),
          stroke: { color: 0x000000, width: 3 },
          ...look?.name,
        },
        anchor: { x: 0.5, y: 1 },
        roundPixels: true,
      });
      labels.addChild(label);
      const guild = new Text({
        text: c.guild,
        style: {
          fontFamily: "sans-serif",
          fontSize: 10,
          fill: COLORS.guild,
          stroke: { color: 0x000000, width: 3 },
        },
        anchor: { x: 0.5, y: 1 },
        roundPixels: true,
      });
      labels.addChild(guild);
      const skull = new Container();
      labels.addChild(skull);
      s = {
        body,
        shape,
        frame,
        label,
        guild,
        skull,
        drawnSkull: Skull.UNSPECIFIED,
        figure,
        drawnLook: lk,
        bar,
        drawnDir: -1,
        drawnHealth: -1,
        drawnTarget: false,
      };
      sprites.set(c.id, s);
    }
    // The language can change during the game (T1.13).
    // Shortened at small zoom (T5.6, render/labels.ts); the zoom follows the window size.
    const name = labelText(nameOf(c), scale);
    if (s.label.text !== name) s.label.text = name;
    if (s.guild.text !== c.guild) s.guild.text = c.guild;
    if (s.drawnSkull !== c.skull) drawSkull(s.skull, c.skull, markTexture(c.skull));
    s.drawnSkull = c.skull;
    const facing = world.facing(c, now);
    if (s.drawnDir !== facing) drawShape(s, c, facing);
    if (s.drawnHealth !== c.health) drawBar(s, c.health);
    const targeted = world.target === c.id;
    if (s.drawnTarget !== targeted) drawFrame(s, targeted);
    return s;
  };

  const dropLabels = (s: CreatureSprite): void => {
    s.label.destroy();
    s.guild.destroy();
    s.skull.destroy();
    s.bar.destroy();
  };
  const dropSprite = (id: number): void => {
    const s = sprites.get(id);
    if (!s) return;
    view.removeEntity(s.body);
    s.body.destroy({ children: true });
    dropLabels(s);
    sprites.delete(id);
  };

  // Deaths (ANI-2, ANI-5): a creature that leaves the view with an empty health bar died
  // there (the server sends CreatureHealth 0 before CreatureDisappear; ANI-7 would say so
  // outright). Its body stays where it fell, without name or bar, while its death plays,
  // over the corpse the server already put on the tile.
  interface Ghost {
    body: Container;
    figure: CreatureBody;
    state: AnimState;
    dir: CreatureState["dir"];
  }
  const ghosts = new Map<number, Ghost>();
  const lastSeen = new Map<number, CreatureState["dir"]>();
  const dropGhost = (id: number): void => {
    const g = ghosts.get(id);
    if (!g) return;
    view.removeEntity(g.body);
    g.body.destroy({ children: true });
    ghosts.delete(id);
  };
  /** A creature left the view: it falls if it died with a body to animate, else it goes. */
  const leave = (id: number, now: number): void => {
    const s = sprites.get(id);
    const state = animStates.get(id);
    animStates.delete(id);
    const dir = lastSeen.get(id);
    lastSeen.delete(id);
    if (!s || !s.figure || !state || s.drawnHealth > 0 || dir === undefined) {
      dropSprite(id);
      return;
    }
    dropLabels(s);
    sprites.delete(id);
    s.frame.clear();
    startDeath(state, now);
    ghosts.set(id, { body: s.body, figure: s.figure, state, dir });
  };
  const drawGhosts = (now: number): void => {
    for (const [id, g] of ghosts) {
      animInput.now = now;
      animInput.dir = outfitDir(g.dir);
      animInput.walkStart = undefined;
      animInput.walkMs = 0;
      animInput.moveDx = 0;
      animate(g.state, g.figure.clips.meta, animInput, pose);
      g.figure.draw(pose, dirIndex(animInput.dir));
      if (pose.done) dropGhost(id);
    }
  };

  // Effects, projectiles and floating numbers (render/effect-layer.ts): pooled, and the
  // effects play their atlas frames; drawn while the world state keeps them (it expires them).
  const effects = new EffectLayer({ world, atlas, effects: effectLayer, texts: textLayer });

  const draw = (now: number): void => {
    const self = world.self;
    if (!self) return;
    if (view.floor !== self.pos.z) view.setFloor(self.pos.z);
    follow(now);
    view.render(cam, { width: app.screen.width, height: app.screen.height }, now);
    behindWall.visible = false;

    const seen = new Set<number>();
    const boxes: LabelBox[] = [];
    react(now);
    for (const c of world.creatures.values()) {
      if (c.pos.z !== self.pos.z) continue;
      seen.add(c.id);
      const s = spriteOf(c, now);
      const p = world.drawPos(c, now);
      const w = world.activeWalk(c, now);
      // Whole device pixels, like the camera (render/viewport.ts): smooth at any zoom.
      s.body.position.set(devicePixels(p.x, T, scale), devicePixels(p.y, T, scale));
      if (s.figure) animateBody(s.figure, stateOf(c.id, now), c, now);
      if (lastSeen.get(c.id) !== c.dir) lastSeen.set(c.id, c.dir);
      // Only the invisible player itself is sent its creature: see-through (T3.2).
      s.body.alpha = c.id === world.selfId && world.invisible ? 0.4 : 1;
      // While walking, draw on whichever end of the step comes later in row order, so the
      // creature is never hidden under the items of the tile it is entering or leaving.
      const step = w && now < w.start + w.duration ? w : undefined;
      const later = !step
        ? c.pos
        : step.from.y > step.to.y || (step.from.y === step.to.y && step.from.x > step.to.x)
          ? step.from
          : step.to;
      view.placeEntity(s.body, later.x, later.y);
      if (c.id === world.selfId && s.figure && view.wallAt(Math.round(p.x), Math.round(p.y) + 1)) {
        const fig = s.figure.sprite;
        behindWall.texture = fig.texture;
        behindWall.position.set(s.body.x + fig.x, s.body.y + fig.y);
        behindWall.scale.copyFrom(fig.scale);
        behindWall.skew.copyFrom(fig.skew);
        behindWall.visible = s.body.alpha === 1;
      }
      // Over the head of a figure taller than its tile (ART-2).
      const head = tileToScreen(cam, p.x + 0.5, p.y - (s.figure?.lift ?? 0) / T, T);
      const barTop = Math.round(head.y) - BAR_H * scale;
      s.bar.position.set(Math.round(head.x), barTop);
      s.bar.scale.set(scale);
      const hasGuild = c.guild !== "";
      const hasSkull = s.drawnSkull !== Skull.UNSPECIFIED;
      boxes.push({
        id: c.id,
        x: Math.round(head.x),
        y: barTop - 1,
        width:
          Math.max(s.label.width, hasGuild ? s.guild.width : 0) + (hasSkull ? MARK_BOX.w + 2 : 0),
        nameHeight: s.label.height,
        guildHeight: hasGuild ? s.guild.height : 0,
        self: c.id === world.selfId,
        target: c.id === world.target,
        distance: Math.max(Math.abs(c.pos.x - self.pos.x), Math.abs(c.pos.y - self.pos.y)),
      });
    }
    // Names, guild lines and skulls (T5.6): at small zoom neighbours would overlap, so
    // render/labels.ts drops guild lines and lifts or hides the labels of far creatures.
    const placements = placeLabels(boxes, scale);
    for (const b of boxes) {
      const s = sprites.get(b.id);
      const at = placements.get(b.id);
      if (!s || !at) continue;
      s.label.visible = at.show;
      s.guild.visible = at.show && at.guild;
      s.skull.visible = at.show;
      const bottom = b.y - at.lift;
      if (s.guild.visible) {
        // The guild name goes right above the bar and the player's name above it.
        s.guild.position.set(b.x, bottom);
        s.label.position.set(b.x, bottom - Math.round(s.guild.height));
      } else {
        s.label.position.set(b.x, bottom);
      }
      if (s.drawnSkull !== Skull.UNSPECIFIED) {
        s.skull.position.set(
          Math.round(s.label.x - s.label.width / 2 - MARK_HALF - 2),
          Math.round(s.label.y - s.label.height / 2),
        );
      }
    }
    for (const id of [...sprites.keys()]) if (!seen.has(id)) leave(id, now);
    for (const id of animStates.keys()) if (!seen.has(id)) animStates.delete(id);
    drawGhosts(now);
    world.expire(now);
    effects.draw(now, self.pos.z, cam, scale);
  };

  app.ticker.add(() => {
    const now = performance.now();
    opts.frame(now);
    draw(now);
  });

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
  /** The last finger press on the canvas: when, and whether it already opened the menu. */
  let touchPress = { at: Number.NEGATIVE_INFINITY, menu: false };
  const tileUnder = (clientX: number, clientY: number): Pos | undefined => {
    const self = world.self;
    if (!self) return undefined;
    const p = toCanvas(clientX, clientY);
    const tile = screenToTile(cam, p.x, p.y, T);
    return { x: tile.x, y: tile.y, z: self.pos.z };
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
        const at = tileUnder(g.x, g.y);
        if (at) opts.tapTile(at.x, at.y, at.z);
      } else if (g.kind === "longPress") {
        const at = touchTile;
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
    if (!recent || touchPress.menu || !touchTile) return;
    touchPress.menu = true;
    gestures.reset();
    clearTimeout(longPressTimer);
    longPressTimer = undefined;
    opts.longPressTile(touchTile.x, touchTile.y, touchTile.z, e.clientX, e.clientY);
  });

  // Left: a click walks, shift+click looks, a drag moves the top item. Right: attack the
  // creature on the tile, or use the tile (a ladder climbs); Ctrl+right uses its top item
  // even on a ladder. The rule is input/mouse.ts mapPress.
  let press: { x: number; y: number; z: number; px: number; py: number } | undefined;
  canvas.addEventListener("pointerdown", (e) => {
    if (isTouchPointer(e.pointerType)) {
      touchDown(e);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    const self = world.self;
    if (!self) return;
    const p = toCanvas(e.clientX, e.clientY);
    const tile = screenToTile(cam, p.x, p.y, T);
    const z = self.pos.z;
    const c = e.button === 2 ? world.creatureAt(tile.x, tile.y, z) : undefined;
    const other = c && c.id !== world.selfId ? c : undefined;
    const inDoor =
      other?.kind === CreatureKind.PLAYER && (opts.doorAt?.(tile.x, tile.y, z) ?? false);
    const act = mapPress(e.button, e, other?.id, inDoor, opts.controls?.() ?? "classic");
    if (act.kind === "attack") opts.clickCreature(act.creature);
    else if (act.kind === "use") opts.useTile(tile.x, tile.y, z, act.top);
    else if (act.kind === "menu") opts.menuTile?.(tile.x, tile.y, z, e.clientX, e.clientY);
    else if (act.kind === "look") opts.lookTile(tile.x, tile.y, z);
    else if (act.kind === "press") press = { x: tile.x, y: tile.y, z, px: p.x, py: p.y };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (isTouchPointer(e.pointerType)) {
      onGestures(gestures.move(e.pointerId, e.clientX, e.clientY, e.timeStamp), e);
      return;
    }
    if (!press) return;
    const p = toCanvas(e.clientX, e.clientY);
    if (Math.hypot(p.x - press.px, p.y - press.py) < DRAG_START_PX) return;
    const from = press;
    press = undefined;
    opts.dragTile(from.x, from.y, from.z, e);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (isTouchPointer(e.pointerType)) {
      onGestures(gestures.up(e.pointerId, e.clientX, e.clientY, e.timeStamp), e);
      return;
    }
    if (!press || e.button !== 0) return;
    const from = press;
    press = undefined;
    opts.clickTile(from.x, from.y, from.z);
  });
  canvas.addEventListener("pointerleave", () => {
    press = undefined;
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
    zoomBy(steps) {
      choose(stepZoom(scale, steps, range));
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
    markIcon(mark) {
      const path = markPath(mark);
      return path ? atlas.icon(path) : undefined;
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
      clearTimeout(longPressTimer);
      gestures.reset();
      observer.disconnect();
      window.removeEventListener("resize", resize);
      for (const id of [...sprites.keys()]) dropSprite(id);
      for (const id of [...ghosts.keys()]) dropGhost(id);
      effects.destroy();
      view.destroy();
      app.destroy(true, { children: true });
    },
  };
}
