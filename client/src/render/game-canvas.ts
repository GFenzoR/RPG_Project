// The game view: a PixiJS canvas over @rpg/renderer's MapView. It shows 15x11 tiles
// centred on the own creature, scaled by a whole number of device pixels per sprite
// pixel (pixel-perfect: no smoothing, no fractional scale), and draws the creatures
// interleaved with the item stacks (ground → items → creatures, row by row), then effects
// and floating texts on top, then names and health bars. Input goes back to the caller as
// tile clicks (left: walk) and creature clicks (right: attack).
import { Application, Container, Graphics, Sprite, Text, TextureStyle } from "pixi.js";
import type { Texture } from "pixi.js";
import { CreatureKind, FloatingTextKind } from "@rpg/protocol";
import { Atlas, MISSING_TEXTURE, MapView, screenToTile, tileToScreen } from "@rpg/renderer";
import type { AtlasIcon, Camera } from "@rpg/renderer";
import { VIEW_TILES, followCamera, pixelScale } from "./viewport.ts";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { delta } from "../state/geometry.ts";
import type { Pos } from "../state/geometry.ts";
import { creatureName } from "../state/messages.ts";
import { EFFECT_HIT, EFFECT_MS, FLOATING_TEXT_MS } from "../state/world.ts";
import type { CreatureState, EffectState, FloatingTextState, WorldState } from "../state/world.ts";

const COLORS = {
  background: 0x000000,
  self: 0x3a7bd5,
  player: 0xd59a3a,
  monster: 0xb03a2e,
  npc: 0x7d4fb0,
  marker: 0xffffff,
  outline: 0x101010,
  target: 0xff2020,
  barBack: 0x101010,
  barHigh: 0x30c030,
  barMid: 0xe0c020,
  barLow: 0xd03020,
  hit: 0xc01818,
  block: 0x9ab4d8,
  damage: 0xff4040,
  heal: 0x60e060,
  mana: 0x6090ff,
  experience: 0xffffff,
};

/** Health bar size in sprite pixels. */
const BAR_W = 26;
const BAR_H = 4;

const barColor = (pct: number): number =>
  pct > 50 ? COLORS.barHigh : pct > 25 ? COLORS.barMid : COLORS.barLow;

const textColor = (k: FloatingTextKind): number =>
  k === FloatingTextKind.HEAL
    ? COLORS.heal
    : k === FloatingTextKind.MANA
      ? COLORS.mana
      : k === FloatingTextKind.EXPERIENCE
        ? COLORS.experience
        : COLORS.damage;

export interface GameCanvas {
  /** Page coordinates of the centre of tile (x, y) on the current floor (tests, tooling). */
  tileToClient(x: number, y: number): { x: number; y: number };
  /** The tile of the own floor under page coordinates, or undefined outside the canvas. */
  clientToTile(clientX: number, clientY: number): Pos | undefined;
  /** Where an item's sprite is in the atlas, for DOM icons (inventory). */
  itemIcon(itemId: number): AtlasIcon | undefined;
  /** Current device pixels per sprite pixel. */
  readonly scale: number;
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
  /** A tile without a creature was right-clicked (use its top item). */
  useTile(x: number, y: number, z: number): void;
  /** A tile was shift-clicked (look at its top item). */
  lookTile(x: number, y: number, z: number): void;
  /** The left button was pressed on a tile and dragged (move its top item). */
  dragTile(x: number, y: number, z: number, e: PointerEvent): void;
}

/** Pointer travel (canvas pixels) that turns a press into a drag. */
const DRAG_START_PX = 6;

interface CreatureSprite {
  body: Container;
  shape: Graphics;
  frame: Graphics;
  label: Text;
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
  const atlas = await Atlas.load(new URL("atlas/", document.baseURI).href);
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
  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    scale = pixelScale(host.clientWidth, host.clientHeight, dpr, T);
    const w = VIEW_TILES.width * T * scale;
    const h = VIEW_TILES.height * T * scale;
    if (app.renderer.width !== w || app.renderer.height !== h) app.renderer.resize(w, h);
    canvas.style.width = `${w / dpr}px`;
    canvas.style.height = `${h / dpr}px`;
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
  const monsterTexture = (c: CreatureState): Texture | undefined => {
    if (c.kind !== CreatureKind.MONSTER) return undefined;
    const path = content.monsterSprites[c.contentId];
    return path ? atlas.texture(path) : undefined;
  };

  // Placeholder body until outfits land: a coloured block with a mark on the side it
  // faces (monsters use their atlas sprite when there is one).
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

  const spriteOf = (c: CreatureState): CreatureSprite => {
    let s = sprites.get(c.id);
    if (!s) {
      const shape = new Graphics();
      const frame = new Graphics();
      const body = new Container({ label: `creature ${c.id}` });
      body.addChild(shape);
      const tex = monsterTexture(c);
      if (tex) body.addChild(new Sprite(tex));
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
        },
        anchor: { x: 0.5, y: 1 },
        roundPixels: true,
      });
      labels.addChild(label);
      s = { body, shape, frame, label, bar, drawnDir: -1, drawnHealth: -1, drawnTarget: false };
      sprites.set(c.id, s);
    }
    if (s.drawnDir !== c.dir) drawShape(s, c);
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
    s.bar.destroy();
    sprites.delete(id);
  };

  // Effects and floating texts: drawn while the world state keeps them (it expires them).
  const effectGfx = new Map<EffectState, Graphics>();
  const textObjs = new Map<FloatingTextState, Text>();
  const drawEffects = (now: number, floor: number): void => {
    const live = new Set(world.effects);
    for (const [e, g] of effectGfx)
      if (!live.has(e)) {
        g.destroy();
        effectGfx.delete(e);
      }
    for (const e of world.effects) {
      if (e.pos.z !== floor) continue;
      let g = effectGfx.get(e);
      if (!g) {
        g = new Graphics();
        if (e.effectId === EFFECT_HIT)
          g.circle(16, 16, 7)
            .fill(COLORS.hit)
            .circle(9, 11, 3)
            .fill(COLORS.hit)
            .circle(23, 21, 3)
            .fill(COLORS.hit);
        else g.circle(16, 16, 9).stroke({ width: 3, color: COLORS.block });
        effectLayer.addChild(g);
        effectGfx.set(e, g);
      }
      const p = tileToScreen(cam, e.pos.x, e.pos.y, T);
      g.position.set(Math.round(p.x), Math.round(p.y));
      g.scale.set(scale);
      g.alpha = 1 - Math.min(1, (now - e.start) / EFFECT_MS) * 0.6;
    }
    const liveTexts = new Set(world.floatingTexts);
    for (const [f, o] of textObjs)
      if (!liveTexts.has(f)) {
        o.destroy();
        textObjs.delete(f);
      }
    for (const f of world.floatingTexts) {
      if (f.pos.z !== floor) continue;
      let o = textObjs.get(f);
      if (!o) {
        o = new Text({
          text: String(f.amount),
          style: {
            fontFamily: "sans-serif",
            fontSize: 13,
            fontWeight: "bold",
            fill: textColor(f.kind),
            stroke: { color: 0x000000, width: 3 },
          },
          anchor: { x: 0.5, y: 1 },
          roundPixels: true,
        });
        textLayer.addChild(o);
        textObjs.set(f, o);
      }
      const k = Math.min(1, (now - f.start) / FLOATING_TEXT_MS);
      const p = tileToScreen(cam, f.pos.x + 0.5, f.pos.y + 0.6 - k * 0.9, T);
      o.position.set(Math.round(p.x), Math.round(p.y));
    }
  };

  const draw = (now: number): void => {
    const self = world.self;
    if (!self) return;
    if (view.floor !== self.pos.z) view.setFloor(self.pos.z);
    const sp = world.drawPos(self, now);
    cam = followCamera(sp.x, sp.y, scale, T);
    view.render(cam, { width: app.screen.width, height: app.screen.height });

    const seen = new Set<number>();
    for (const c of world.creatures.values()) {
      if (c.pos.z !== self.pos.z) continue;
      seen.add(c.id);
      const s = spriteOf(c);
      const p = world.drawPos(c, now);
      s.body.position.set(Math.round(p.x * T), Math.round(p.y * T));
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
      s.label.position.set(Math.round(head.x), barTop - 1);
    }
    for (const id of [...sprites.keys()]) if (!seen.has(id)) dropSprite(id);
    world.expire(now);
    drawEffects(now, self.pos.z);
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
  // Left: a click walks, shift+click looks, a drag moves the top item. Right: attack the
  // creature on the tile, or use the tile's top item.
  let press: { x: number; y: number; z: number; px: number; py: number } | undefined;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    const self = world.self;
    if (!self) return;
    const p = toCanvas(e.clientX, e.clientY);
    const tile = screenToTile(cam, p.x, p.y, T);
    const z = self.pos.z;
    if (e.button === 2) {
      const c = world.creatureAt(tile.x, tile.y, z);
      if (c && c.id !== world.selfId) opts.clickCreature(c.id);
      else opts.useTile(tile.x, tile.y, z);
      return;
    }
    if (e.shiftKey) {
      opts.lookTile(tile.x, tile.y, z);
      return;
    }
    press = { x: tile.x, y: tile.y, z, px: p.x, py: p.y };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!press) return;
    const p = toCanvas(e.clientX, e.clientY);
    if (Math.hypot(p.x - press.px, p.y - press.py) < DRAG_START_PX) return;
    const from = press;
    press = undefined;
    opts.dragTile(from.x, from.y, from.z, e);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!press || e.button !== 0) return;
    const from = press;
    press = undefined;
    opts.clickTile(from.x, from.y, from.z);
  });
  canvas.addEventListener("pointerleave", () => {
    press = undefined;
  });

  return {
    get scale() {
      return scale;
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
      observer.disconnect();
      window.removeEventListener("resize", resize);
      for (const id of [...sprites.keys()]) dropSprite(id);
      for (const g of effectGfx.values()) g.destroy();
      for (const o of textObjs.values()) o.destroy();
      view.destroy();
      app.destroy(true, { children: true });
    },
  };
}
