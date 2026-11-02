// The game view: a PixiJS canvas over @rpg/renderer's MapView. It shows 15x11 tiles
// centred on the own creature, scaled by a whole number of device pixels per sprite
// pixel (pixel-perfect: no smoothing, no fractional scale), and draws the creatures
// interleaved with the item stacks (ground → items → creatures, row by row; effects and
// floating texts arrive with T1.6). Input goes back to the caller as tile clicks.
import { Application, Container, Graphics, Text, TextureStyle } from "pixi.js";
import type { Texture } from "pixi.js";
import { CreatureKind } from "@rpg/protocol";
import { Atlas, MISSING_TEXTURE, MapView, screenToTile, tileToScreen } from "@rpg/renderer";
import type { Camera } from "@rpg/renderer";
import { VIEW_TILES, followCamera, pixelScale } from "./viewport.ts";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { delta } from "../state/geometry.ts";
import type { CreatureState, WorldState } from "../state/world.ts";

const COLORS = {
  background: 0x000000,
  self: 0x3a7bd5,
  player: 0xd59a3a,
  monster: 0xb03a2e,
  npc: 0x7d4fb0,
  marker: 0xffffff,
  outline: 0x101010,
};

export interface GameCanvas {
  /** Page coordinates of the centre of tile (x, y) on the current floor (tests, tooling). */
  tileToClient(x: number, y: number): { x: number; y: number };
  /** Current device pixels per sprite pixel. */
  readonly scale: number;
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
}

interface CreatureSprite {
  body: Container;
  shape: Graphics;
  label: Text;
  drawnDir: number;
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
  const labels = new Container({ label: "labels" });
  app.stage.addChild(view.root, labels);

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
  const nameOf = (c: CreatureState): string =>
    c.kind === CreatureKind.MONSTER
      ? t(`monster.${c.contentId}.name`)
      : c.kind === CreatureKind.NPC
        ? t(`npc.${c.contentId}.name`)
        : c.name;

  // Placeholder body until outfits and creature sprites land: a coloured block with a mark
  // on the side it faces.
  const drawShape = (s: CreatureSprite, c: CreatureState): void => {
    const [dx, dy] = delta(c.dir);
    s.shape
      .clear()
      .rect(8, 5, 16, 24)
      .fill(colorOf(c))
      .stroke({ width: 1, color: COLORS.outline, alignment: 1 })
      .rect(14 + dx * 7, 15 + dy * 9, 4, 4)
      .fill(COLORS.marker);
    s.drawnDir = c.dir;
  };

  const spriteOf = (c: CreatureState): CreatureSprite => {
    let s = sprites.get(c.id);
    if (!s) {
      const shape = new Graphics();
      const body = new Container({ label: `creature ${c.id}` });
      body.addChild(shape);
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
      s = { body, shape, label, drawnDir: -1 };
      sprites.set(c.id, s);
    }
    if (s.drawnDir !== c.dir) drawShape(s, c);
    return s;
  };

  const dropSprite = (id: number): void => {
    const s = sprites.get(id);
    if (!s) return;
    view.removeEntity(s.body);
    s.body.destroy({ children: true });
    s.label.destroy();
    sprites.delete(id);
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
      s.label.position.set(Math.round(head.x), Math.round(head.y));
    }
    for (const id of [...sprites.keys()]) if (!seen.has(id)) dropSprite(id);
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
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const self = world.self;
    if (!self) return;
    const p = toCanvas(e.clientX, e.clientY);
    const tile = screenToTile(cam, p.x, p.y, T);
    opts.clickTile(tile.x, tile.y, self.pos.z);
  });

  return {
    get scale() {
      return scale;
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
      view.destroy();
      app.destroy(true, { children: true });
    },
  };
}
