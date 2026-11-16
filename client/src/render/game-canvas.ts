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
import { CreatureKind, Skull } from "@rpg/protocol";
import { Atlas, MISSING_TEXTURE, MapView, screenToTile, tileToScreen } from "@rpg/renderer";
import type { AtlasIcon, Camera } from "@rpg/renderer";
import { VIEW_TILES, followCamera } from "./viewport.ts";
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
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { delta } from "../state/geometry.ts";
import type { Pos } from "../state/geometry.ts";
import { creatureName } from "../state/messages.ts";
import { skullColor } from "../state/pvp.ts";
import { lookKey, playerLook } from "./cosmetics.ts";
import { MARK_BOX, isMarkArt, markSprite } from "./marks.ts";
import type { OutfitDef } from "../content-types.ts";
import {
  DEFAULT_OUTFIT,
  outfitDir,
  outfitFrame,
  outfitKey,
  outfitKeys,
  stepProgress,
} from "./outfit.ts";
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

const barColor = (pct: number): number =>
  pct > 50 ? COLORS.barHigh : pct > 25 ? COLORS.barMid : COLORS.barLow;

export interface GameCanvas {
  /** Page coordinates of the centre of tile (x, y) on the current floor (tests, tooling). */
  tileToClient(x: number, y: number): { x: number; y: number };
  /** The tile of the own floor under page coordinates, or undefined outside the canvas. */
  clientToTile(clientX: number, clientY: number): Pos | undefined;
  /** Where an item's sprite is in the atlas, for DOM icons (inventory). */
  itemIcon(itemId: number): AtlasIcon | undefined;
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
  /** A player's outfit sprite (T0.5); its texture follows the facing and the step. */
  outfit: Sprite | undefined;
  /** The outfit drawn (T5.7: the equipped outfit cosmetic, else citizen). */
  outfitDef: OutfitDef | undefined;
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
  const view = new MapView({ source: world, texture, tileSize: T, floor: world.self?.pos.z ?? 7 });
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
  // Monsters and NPCs: their atlas sprite (data/monsters, data/npcs), when there is one.
  const creatureTexture = (c: CreatureState): Texture | undefined => {
    const path =
      c.kind === CreatureKind.MONSTER
        ? content.monsterSprites[c.contentId]
        : c.kind === CreatureKind.NPC
          ? content.npcSprites?.[c.contentId]
          : undefined;
    return path ? atlas.texture(path) : undefined;
  };
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
      ready = outfitKeys(o).every((k) => {
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
  const outfitTexture = (
    outfit: OutfitDef | undefined,
    c: CreatureState,
    now: number,
  ): Texture | undefined =>
    outfit
      ? atlas.texture(
          outfitKey(
            outfit.sprite,
            outfitDir(c.dir),
            outfitFrame(
              world.walking(c, now) ? stepProgress(c.walk, now) : undefined,
              outfit.frames,
            ),
          ),
        )
      : undefined;
  // Sprites bigger than a tile extend up and left from its bottom-right corner, as in
  // MapView.
  const bodySprite = (tex: Texture): Sprite => {
    const sp = new Sprite({ texture: tex, anchor: 1 });
    sp.position.set(T, T);
    return sp;
  };

  // Fallback body without a sprite: a coloured block with a mark on the side it faces.
  const drawShape = (s: CreatureSprite, c: CreatureState): void => {
    const [dx, dy] = delta(c.dir);
    s.drawnDir = c.dir;
    if (s.body.children.some((ch) => ch instanceof Sprite)) return;
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
      const tex = creatureTexture(c);
      if (tex) body.addChild(bodySprite(tex));
      const outfitDef = look ? drawableOutfit(look.outfit) : undefined;
      const outfitTex = outfitTexture(outfitDef, c, now);
      const outfitSprite = outfitTex ? bodySprite(outfitTex) : undefined;
      if (outfitSprite && look) outfitSprite.tint = look.tint;
      if (outfitSprite) body.addChild(outfitSprite);
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
        outfit: outfitSprite,
        outfitDef,
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
    if (s.drawnDir !== c.dir) drawShape(s, c);
    if (s.outfit) {
      const tex = outfitTexture(s.outfitDef, c, now);
      if (tex && s.outfit.texture !== tex) s.outfit.texture = tex;
    }
    if (s.drawnHealth !== c.health) drawBar(s, c.health);
    const targeted = world.target === c.id;
    if (s.drawnTarget !== targeted) drawFrame(s, targeted);
    return s;
  };

  const dropSprite = (id: number): void => {
    const s = sprites.get(id);
    if (!s) return;
    view.removeEntity(s.body);
    s.body.destroy({ children: true });
    s.label.destroy();
    s.guild.destroy();
    s.skull.destroy();
    s.bar.destroy();
    sprites.delete(id);
  };

  // Effects, projectiles and floating numbers (render/effect-layer.ts): pooled, and the
  // effects play their atlas frames; drawn while the world state keeps them (it expires them).
  const effects = new EffectLayer({ world, atlas, effects: effectLayer, texts: textLayer });

  const draw = (now: number): void => {
    const self = world.self;
    if (!self) return;
    if (view.floor !== self.pos.z) view.setFloor(self.pos.z);
    follow(now);
    view.render(cam, { width: app.screen.width, height: app.screen.height });

    const seen = new Set<number>();
    const boxes: LabelBox[] = [];
    for (const c of world.creatures.values()) {
      if (c.pos.z !== self.pos.z) continue;
      seen.add(c.id);
      const s = spriteOf(c, now);
      const p = world.drawPos(c, now);
      s.body.position.set(Math.round(p.x * T), Math.round(p.y * T));
      // Only the invisible player itself is sent its creature: see-through (T3.2).
      s.body.alpha = c.id === world.selfId && world.invisible ? 0.4 : 1;
      // While walking, draw on whichever end of the step comes later in row order, so the
      // creature is never hidden under the items of the tile it is entering or leaving.
      const w = world.walking(c, now) ? c.walk : undefined;
      const later =
        w && (w.from.y > w.to.y || (w.from.y === w.to.y && w.from.x > w.to.x)) ? w.from : c.pos;
      view.placeEntity(s.body, later.x, later.y);
      const head = tileToScreen(cam, p.x + 0.5, p.y, T);
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
    for (const id of [...sprites.keys()]) if (!seen.has(id)) dropSprite(id);
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
    const act = mapPress(e.button, e, c && c.id !== world.selfId ? c.id : undefined);
    if (act.kind === "attack") opts.clickCreature(act.creature);
    else if (act.kind === "use") opts.useTile(tile.x, tile.y, z, act.top);
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
      effects.destroy();
      view.destroy();
      app.destroy(true, { children: true });
    },
  };
}
