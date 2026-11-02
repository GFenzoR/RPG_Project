// One play session: the WebSocket, the world state, the keyboard and the canvas wired
// together. The client only sends intents (Walk, WalkPath, Turn, Logout) and draws what
// the server says; the one thing it predicts is the next own step.
import { Direction } from "@rpg/protocol";
import type { DisconnectReason } from "@rpg/protocol";
import type { ClientContent } from "./content-types.ts";
import type { Translate } from "./i18n/i18n.ts";
import { MovementKeys, typingInField } from "./input/keyboard.ts";
import { Connection } from "./net/connection.ts";
import { createGameCanvas } from "./render/game-canvas.ts";
import type { GameCanvas } from "./render/game-canvas.ts";
import { findPath } from "./state/path.ts";
import type { Pos } from "./state/geometry.ts";
import { WorldState } from "./state/world.ts";

/** Read-only hooks for the E2E tests (client/e2e). */
export interface ClientTestHooks {
  /** The first FullMapView arrived and the canvas is drawing. */
  ready: boolean;
  self(): { x: number; y: number; z: number; pending: boolean; walking: boolean } | undefined;
  walkable(x: number, y: number, z: number): boolean;
  tileToClient(x: number, y: number): { x: number; y: number };
  scale(): number;
}

declare global {
  interface Window {
    __rpgClient?: ClientTestHooks;
  }
}

export interface GameOptions {
  host: HTMLElement;
  content: ClientContent;
  t: Translate;
  locale: string;
  sessionToken: string;
  /** The world is on screen. */
  entered(): void;
  /** The session ended (Disconnect or lost connection). */
  ended(reason: DisconnectReason | undefined): void;
}

export class Game {
  private readonly world: WorldState;
  private readonly conn: Connection;
  private readonly keys = new MovementKeys();
  private canvas: GameCanvas | undefined;
  private starting = false;
  private destroyed = false;
  /** A click that arrived while a predicted step was unconfirmed. */
  private clickTarget: Pos | undefined;
  private readonly opts: GameOptions;

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.world = new WorldState(opts.content);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.conn = new Connection(opts.sessionToken, opts.locale, {
      batch: (batch) => {
        const now = performance.now();
        for (const e of batch.events) this.world.apply(e.message, now);
        if (this.world.self && !this.canvas && !this.starting) void this.startCanvas();
      },
      closed: (reason) => {
        if (this.destroyed) return;
        this.destroy();
        opts.ended(reason);
      },
    });
  }

  logout(): void {
    this.conn.logout();
  }

  destroy(): void {
    this.destroyed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.conn.close();
    this.canvas?.destroy();
    this.canvas = undefined;
    delete window.__rpgClient;
  }

  private async startCanvas(): Promise<void> {
    this.starting = true;
    const canvas = await createGameCanvas(this.opts.host, {
      world: this.world,
      content: this.opts.content,
      t: this.opts.t,
      frame: (now) => this.frame(now),
      clickTile: (x, y, z) => {
        this.clickTarget = { x, y, z };
      },
    });
    if (this.destroyed) {
      canvas.destroy();
      return;
    }
    this.canvas = canvas;
    const world = this.world;
    window.__rpgClient = {
      ready: true,
      self() {
        const s = world.self;
        if (!s) return undefined;
        const now = performance.now();
        return { ...s.pos, pending: world.pending !== undefined, walking: world.walking(s, now) };
      },
      walkable: (x, y, z) => world.free(x, y, z),
      tileToClient: (x, y) => canvas.tileToClient(x, y),
      scale: () => canvas.scale,
    };
    this.opts.entered();
  }

  private frame(now: number): void {
    const self = this.world.self;
    if (!self || this.world.pending) return;
    const target = this.clickTarget;
    if (target) {
      this.clickTarget = undefined;
      const steps = findPath(self.pos, target, (x, y) => this.world.free(x, y, target.z), {
        diagonalCost: this.opts.content.movement.diagonalCost,
        maxSteps: this.opts.content.movement.maxPathTiles,
      });
      if (steps && steps.length > 0) this.conn.send({ case: "walkPath", value: { steps } });
      return;
    }
    if (!this.world.canStep(now)) return;
    const dir = this.keys.take();
    if (dir === undefined) return;
    const before = self.dir;
    if (this.world.predictStep(dir, now)) this.conn.send({ case: "walk", value: { dir } });
    else if (before !== dir && dir !== Direction.UNSPECIFIED)
      this.conn.send({ case: "turn", value: { dir } });
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (typingInField(e)) return;
    if (this.keys.down(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.up(e.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}
