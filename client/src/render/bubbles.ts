// Speech bubbles over the heads (docs/17 UI-11), pure and unit-tested. What a creature
// says on the local channels (say, yell, whisper) and what an NPC says in its dialog also
// shows over its head: word-wrapped to a width, for a time that grows with its length, then
// it fades. A speaker's newer lines stack under the older ones (at most BUBBLE_STACK, the
// oldest dropped), and the bubbles of speakers side by side are lifted so they do not
// cover each other. Global, party, guild, staff and system lines never get one.
// game-canvas.ts draws them; the text is the player's, drawn as plain text (a Pixi Text
// without tag styles), never parsed as markup.
import { MessageKind } from "@rpg/protocol";

/** How a bubble looks and lasts: the channel it was said on. */
export type BubbleStyle = "say" | "yell" | "whisper" | "npc";

/** The widest line of a bubble's text, CSS px (about 30 characters of the 13 px font). */
export const BUBBLE_WIDTH = 180;
/** The bubble text, CSS px: 2 more than the 11 px of lote 19 (owner, 2026-11-26). */
export const BUBBLE_FONT_CSS_PX = 13;

/** Every size of a bubble in device pixels (the canvas backing store is device pixels). */
export interface BubbleMetrics {
  fontPx: number;
  lineH: number;
  padX: number;
  padY: number;
  gap: number;
  tail: number;
  width: number;
}

/**
 * The bubble's sizes on a screen of `dpr` device pixels per CSS pixel: the text is
 * rasterised at the size it shows (whole device pixels, never scaled), so it is as crisp
 * at 125 % or 150 % display scaling as at 100 % and looks the same size.
 */
export function bubbleMetrics(dpr: number): BubbleMetrics {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const px = (css: number): number => Math.round(css * d);
  const fontPx = px(BUBBLE_FONT_CSS_PX);
  return {
    fontPx,
    lineH: Math.round(fontPx * 1.15),
    padX: px(6),
    padY: px(3),
    gap: px(3),
    tail: px(4),
    width: px(BUBBLE_WIDTH),
  };
}
/** Lines of one message at most; a longer one ends with an ellipsis. */
export const BUBBLE_LINES = 4;
/** Messages of one speaker shown at once; a new one drops the oldest. */
export const BUBBLE_STACK = 3;
/** Lines of one speaker at most (all its messages): the oldest messages go first. */
export const BUBBLE_STACK_LINES = 6;
/** A bubble fades out over its last ms. */
export const BUBBLE_FADE_MS = 600;
/** How long a bubble stays: this much plus BUBBLE_MS_PER_CHAR per character, clamped. */
export const BUBBLE_BASE_MS = 2500;
export const BUBBLE_MS_PER_CHAR = 60;
export const BUBBLE_MIN_MS = 3500;
export const BUBBLE_MAX_MS = 9000;
/** A yell stays longer, a whisper less, an NPC's dialog line a little longer. */
const LIFE_FACTOR: Readonly<Record<BubbleStyle, number>> = {
  say: 1,
  yell: 1.5,
  whisper: 0.8,
  npc: 1.2,
};
/** px between two bubbles lifted apart. */
export const BUBBLE_GAP = 2;

const ELLIPSIS = "…";

/**
 * The bubble of a chat line's kind: only what is said aloud around the player. Undefined
 * for the channels heard from anywhere (global, party, guild), staff broadcasts and the
 * system's messages.
 */
export function bubbleStyle(kind: MessageKind): BubbleStyle | undefined {
  switch (kind) {
    case MessageKind.SAY:
      return "say";
    case MessageKind.YELL:
      return "yell";
    case MessageKind.WHISPER:
      return "whisper";
    case MessageKind.NPC:
      return "npc";
    default:
      return undefined;
  }
}

/** The bubble a line gets with the option (Options → Interface) on or off. */
export function admitSpeech(kind: MessageKind, enabled: boolean): BubbleStyle | undefined {
  return enabled ? bubbleStyle(kind) : undefined;
}

/** How long a bubble with this text stays, ms (its fade included). */
export function bubbleLife(text: string, style: BubbleStyle): number {
  const chars = [...text].length;
  const ms = Math.min(
    BUBBLE_MAX_MS,
    Math.max(BUBBLE_MIN_MS, BUBBLE_BASE_MS + chars * BUBBLE_MS_PER_CHAR),
  );
  return Math.round(ms * LIFE_FACTOR[style]);
}

/** Cuts a word wider than the line into pieces that fit (at least one character each). */
function splitWord(word: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  let piece = "";
  for (const ch of word) {
    if (piece !== "" && measure(piece + ch) > maxWidth) {
      out.push(piece);
      piece = ch;
    } else piece += ch;
  }
  if (piece !== "") out.push(piece);
  return out;
}

/**
 * Word-wraps `text` to lines no wider than `maxWidth` (as `measure` says): words keep
 * together, a word wider than a line is cut, runs of spaces collapse. More than `maxLines`
 * lines: the last one kept ends with an ellipsis.
 */
export function wrapBubble(
  text: string,
  maxWidth: number,
  measure: (s: string) => number,
  maxLines = BUBBLE_LINES,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    const joined = line === "" ? word : `${line} ${word}`;
    if (measure(joined) <= maxWidth) {
      line = joined;
      continue;
    }
    if (line !== "") lines.push(line);
    const pieces = splitWord(word, maxWidth, measure);
    line = pieces.pop() ?? "";
    lines.push(...pieces);
  }
  if (line !== "") lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  let last = [...(kept[kept.length - 1] ?? "")];
  while (last.length > 0 && measure(`${last.join("").trimEnd()}${ELLIPSIS}`) > maxWidth) {
    last = last.slice(0, -1);
  }
  kept[kept.length - 1] = `${last.join("").trimEnd()}${ELLIPSIS}`;
  return kept;
}

/** One message over a speaker's head. */
export interface Bubble {
  /** Unique per board: the canvas keys its Text by it. */
  id: number;
  speaker: number;
  style: BubbleStyle;
  lines: string[];
  /** When it was said and when it is gone, ms (the frame clock). */
  start: number;
  end: number;
}

/** How opaque a bubble is at `now`: 1, then fading over its last BUBBLE_FADE_MS, then 0. */
export function bubbleAlpha(b: Pick<Bubble, "end">, now: number): number {
  const left = b.end - now;
  if (left <= 0) return 0;
  return left < BUBBLE_FADE_MS ? left / BUBBLE_FADE_MS : 1;
}

/** The bubbles of every speaker, oldest first per speaker. */
export class SpeechBubbles {
  private readonly bySpeaker = new Map<number, Bubble[]>();
  private next = 1;

  /** A speaker said something (its lines already wrapped); lasts bubbleLife of `text`. */
  add(speaker: number, style: BubbleStyle, text: string, lines: string[], now: number): Bubble {
    const b: Bubble = {
      id: this.next++,
      speaker,
      style,
      lines,
      start: now,
      end: now + bubbleLife(text, style),
    };
    const list = this.bySpeaker.get(speaker) ?? [];
    list.push(b);
    while (list.length > BUBBLE_STACK) list.shift();
    let total = list.reduce((n, x) => n + x.lines.length, 0);
    while (list.length > 1 && total > BUBBLE_STACK_LINES) {
      total -= list.shift()?.lines.length ?? 0;
    }
    this.bySpeaker.set(speaker, list);
    return b;
  }

  /** Drops the bubbles gone by `now`, and the speakers left without any. */
  prune(now: number): void {
    for (const [id, list] of this.bySpeaker) {
      const live = list.filter((b) => b.end > now);
      if (live.length === 0) this.bySpeaker.delete(id);
      else if (live.length !== list.length) this.bySpeaker.set(id, live);
    }
  }

  /** A speaker's bubbles, oldest first (empty when it says nothing now). */
  of(speaker: number): readonly Bubble[] {
    return this.bySpeaker.get(speaker) ?? [];
  }

  /** The speakers with bubbles. */
  speakers(): IterableIterator<number> {
    return this.bySpeaker.keys();
  }

  clear(): void {
    this.bySpeaker.clear();
  }
}

/** One speaker's whole stack of bubbles on screen this frame. */
export interface BubbleBox {
  id: number;
  /** Centre of the stack's bottom edge, screen px (right over the speaker's name). */
  x: number;
  y: number;
  width: number;
  height: number;
  self: boolean;
  /** Tiles from the own creature (Chebyshev). */
  distance: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** Own creature first, then by distance; ties by id (stable frames). */
const rank = (a: BubbleBox, b: BubbleBox): number =>
  Number(b.self) - Number(a.self) || a.distance - b.distance || a.id - b.id;

/**
 * Where the bottom of each stack goes this frame (keyed by speaker id): the own one and
 * the nearest stay over their heads, and one that would cover a stack already placed is
 * lifted right above it (again, while it hits another). None goes above `minTop` (the top
 * of the canvas), even if it then overlaps.
 */
export function stackBubbles(boxes: readonly BubbleBox[], minTop = 0): Map<number, number> {
  const out = new Map<number, number>();
  const placed: Rect[] = [];
  for (const b of [...boxes].sort(rank)) {
    let bottom = b.y;
    const rect = (): Rect => ({
      left: b.x - b.width / 2,
      right: b.x + b.width / 2,
      top: bottom - b.height,
      bottom,
    });
    // Each lift goes above one placed stack: at most one per stack.
    for (let i = 0; i <= placed.length; i++) {
      const r = rect();
      const hit = placed.find((p) => overlaps(p, r));
      if (!hit) break;
      bottom = hit.top - BUBBLE_GAP;
    }
    if (bottom - b.height < minTop) bottom = minTop + b.height;
    placed.push(rect());
    out.set(b.id, bottom);
  }
  return out;
}
