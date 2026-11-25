// Draws the speech bubbles over the heads (docs/17 UI-11): render/bubbles.ts decides what
// shows, for how long and where; this keeps one Pixi stack per speaker (a dark rounded
// box with a small tail toward the head and a Text per message, oldest on top) and moves
// it with the creature every frame, right above its name. A speaker the canvas does not
// draw (another floor, out of view) keeps its bubbles hidden while they last.
//
// The text is the player's: a plain Text without tag styles, so nothing in it is markup.
// Sizes come from `measure` and a fixed line height, never from Text.width: the layout is
// the same in the tests (no canvas) and in the game.
import { CanvasTextMetrics, Container, Graphics, Text, TextStyle } from "pixi.js";
import { BUBBLE_WIDTH, SpeechBubbles, bubbleAlpha, stackBubbles, wrapBubble } from "./bubbles.ts";
import type { Bubble, BubbleBox, BubbleStyle } from "./bubbles.ts";
import { CANVAS_FONT, CANVAS_FONT_SIZE } from "./canvas-font.ts";

/** Height of a line of bubble text, px. */
export const BUBBLE_LINE_H = 13;
/** Padding inside the box, px. */
const PAD_X = 5;
const PAD_Y = 3;
/** px between two messages of a stack. */
const MESSAGE_GAP = 3;
/** Height of the tail under the box, px. */
const TAIL = 4;

/** Colours of each kind of bubble: a yell is warm with a thick edge, a whisper faint. */
const LOOK: Readonly<
  Record<
    BubbleStyle,
    { text: number; fill: number; fillAlpha: number; edge: number; edgeWidth: number }
  >
> = {
  say: { text: 0xf3ead2, fill: 0x14100c, fillAlpha: 0.74, edge: 0x8c7650, edgeWidth: 1 },
  yell: { text: 0xffc46e, fill: 0x1e0f07, fillAlpha: 0.8, edge: 0xd9822b, edgeWidth: 2 },
  whisper: { text: 0xb9c7da, fill: 0x0e1218, fillAlpha: 0.55, edge: 0x55657a, edgeWidth: 1 },
  npc: { text: 0xd8ecb8, fill: 0x10140c, fillAlpha: 0.74, edge: 0x7f9a5a, edgeWidth: 1 },
};

/** Where a speaker's stack goes: over the top of its name (screen px). */
export interface BubbleAnchor {
  x: number;
  top: number;
  self: boolean;
  distance: number;
}

interface Stack {
  root: Container;
  box: Graphics;
  texts: Map<number, Text>;
  /** What the box was drawn for (redrawn only when it changes). */
  drawn: string;
}

export class BubbleLayer {
  readonly view = new Container({ label: "speech bubbles" });
  private readonly board = new SpeechBubbles();
  private readonly stacks = new Map<number, Stack>();
  private readonly styles: Record<BubbleStyle, TextStyle>;
  private readonly measure: (s: string) => number;
  private readonly boxes: BubbleBox[] = [];

  /** `measure`: a line's width in px (the canvas font's metrics by default). */
  constructor(measure?: (s: string, style: TextStyle) => number) {
    const style = (s: BubbleStyle): TextStyle =>
      new TextStyle({
        fontFamily: CANVAS_FONT,
        fontSize: CANVAS_FONT_SIZE,
        fill: LOOK[s].text,
        lineHeight: BUBBLE_LINE_H,
        align: "center",
      });
    this.styles = {
      say: style("say"),
      yell: style("yell"),
      whisper: style("whisper"),
      npc: style("npc"),
    };
    const m = measure ?? ((s: string, st: TextStyle) => CanvasTextMetrics.measureText(s, st).width);
    // Every style has the same font: one measure serves all.
    this.measure = (s) => m(s, this.styles.say);
  }

  /** A creature said `text` (already the player's language): wrap it and stack it. */
  say(speaker: number, style: BubbleStyle, text: string, now: number): void {
    const lines = wrapBubble(text, BUBBLE_WIDTH, this.measure);
    if (lines.length === 0) return;
    this.board.add(speaker, style, text, lines, now);
  }

  /** Drops every bubble (the option was turned off). */
  clear(): void {
    this.board.clear();
    for (const id of [...this.stacks.keys()]) this.drop(id);
  }

  /** The font arrived late: measure again what is drawn. */
  refresh(): void {
    for (const st of Object.values(this.styles)) st.update();
    CanvasTextMetrics.clearMetrics();
  }

  /** Draws the bubbles of the speakers in `anchors` (the ones drawn this frame). */
  draw(anchors: ReadonlyMap<number, BubbleAnchor>, now: number, minTop = 0): void {
    this.board.prune(now);
    this.boxes.length = 0;
    for (const id of [...this.stacks.keys()]) if (this.board.of(id).length === 0) this.drop(id);
    for (const id of this.board.speakers()) {
      const list = this.board.of(id);
      const stack = this.stackOf(id);
      const at = anchors.get(id);
      if (!at) {
        stack.root.visible = false;
        continue;
      }
      const { width, height } = this.layout(stack, list, now);
      this.boxes.push({
        id,
        x: at.x,
        y: at.top,
        width,
        height: height + TAIL,
        self: at.self,
        distance: at.distance,
      });
    }
    const bottoms = stackBubbles(this.boxes, minTop);
    for (const b of this.boxes) {
      const s = this.stacks.get(b.id);
      if (!s) continue;
      s.root.visible = true;
      s.root.position.set(Math.round(b.x), Math.round(bottoms.get(b.id) ?? b.y));
    }
  }

  /** E2E: the bubbles on screen now, by speaker, each message's lines. */
  shown(): { id: number; style: BubbleStyle; lines: string[] }[] {
    const out: { id: number; style: BubbleStyle; lines: string[] }[] = [];
    for (const [id, s] of this.stacks) {
      if (!s.root.visible) continue;
      for (const b of this.board.of(id)) out.push({ id, style: b.style, lines: [...b.lines] });
    }
    return out;
  }

  destroy(): void {
    for (const id of [...this.stacks.keys()]) this.drop(id);
    this.view.destroy({ children: true });
  }

  private stackOf(id: number): Stack {
    let s = this.stacks.get(id);
    if (!s) {
      const root = new Container({ label: `bubbles ${id}` });
      const box = new Graphics();
      root.addChild(box);
      s = { root, box, texts: new Map(), drawn: "" };
      this.view.addChild(root);
      this.stacks.set(id, s);
    }
    return s;
  }

  private drop(id: number): void {
    const s = this.stacks.get(id);
    if (!s) return;
    s.root.destroy({ children: true });
    this.stacks.delete(id);
  }

  /** Lays out a stack (root at the tail's tip); returns the box's size without the tail. */
  private layout(
    s: Stack,
    list: readonly Bubble[],
    now: number,
  ): { width: number; height: number } {
    const live = new Set<number>();
    let textW = 0;
    let textH = 0;
    for (const b of list) {
      live.add(b.id);
      for (const line of b.lines) textW = Math.max(textW, this.measure(line));
      textH += b.lines.length * BUBBLE_LINE_H;
    }
    textH += MESSAGE_GAP * Math.max(0, list.length - 1);
    for (const [bid, text] of s.texts) {
      if (live.has(bid)) continue;
      text.destroy();
      s.texts.delete(bid);
    }
    const width = Math.ceil(textW) + 2 * PAD_X;
    const height = textH + 2 * PAD_Y;
    let y = -(TAIL + height) + PAD_Y;
    let alpha = 0;
    for (const b of list) {
      let text = s.texts.get(b.id);
      if (!text) {
        text = new Text({
          text: b.lines.join("\n"),
          style: this.styles[b.style],
          anchor: { x: 0.5, y: 0 },
          roundPixels: true,
        });
        s.texts.set(b.id, text);
        s.root.addChild(text);
      }
      const a = bubbleAlpha(b, now);
      text.alpha = a;
      alpha = Math.max(alpha, a);
      text.position.set(0, y);
      y += b.lines.length * BUBBLE_LINE_H + MESSAGE_GAP;
    }
    const newest = list[list.length - 1];
    const style = newest?.style ?? "say";
    const key = `${width}x${height}:${style}`;
    if (s.drawn !== key) {
      drawBox(s.box, width, height, style);
      s.drawn = key;
    }
    s.box.alpha = alpha;
    return { width, height };
  }
}

/** The rounded box with its tail, the tail's tip at (0, 0). */
function drawBox(g: Graphics, width: number, height: number, style: BubbleStyle): void {
  const look = LOOK[style];
  const left = -Math.round(width / 2);
  const top = -(TAIL + height);
  g.clear();
  g.roundRect(left, top, width, height, 3)
    .fill({ color: look.fill, alpha: look.fillAlpha })
    .stroke({ color: look.edge, width: look.edgeWidth, alignment: 1 });
  g.poly([-TAIL, -TAIL, TAIL, -TAIL, 0, 0]).fill({ color: look.fill, alpha: look.fillAlpha });
}
