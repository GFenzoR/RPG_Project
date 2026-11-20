// The live figure of a look (docs/02 "Apariencia"): the creation screen and the Apariencia
// window show what the pickers choose, walking in place (standing with reduced motion),
// turned with the arrows. Drawn by render/look-preview.ts from the game's atlas; until it
// arrives (or if it cannot), an empty frame of the same size.
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AnimDir } from "@rpg/renderer";
import type { Look, LookTables, Worn } from "@rpg/renderer/look";
import type { Translate } from "../i18n/i18n.ts";
import {
  PREVIEW_VIEW,
  clipFrames,
  drawDoll,
  loadPreviewAtlas,
  previewDraws,
  turn,
} from "../render/look-preview.ts";
import { stableWorn } from "../state/look.ts";
import type { PreviewAtlas } from "../render/look-preview.ts";

/** The engine humanoids' frames are 64x64 (docs/17 "Humanoides del motor"). */
const FRAME_PX = 64;
/** Whole screen pixels per sprite pixel by default (the view, 48 px, at 192). */
const SCALE = 4;
/** Ms per frame of the walk in place (the game plays it by distance). */
const WALK_FRAME_MS = 110;

const reducedMotion = (): boolean =>
  document.documentElement.dataset["motion"] === "reduced" ||
  (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);

export function LookPreview(props: {
  t: Translate;
  look: Look;
  worn: Worn;
  tables: LookTables | undefined;
  testid?: string;
  /** Whole screen pixels per sprite pixel (default 4). */
  scale?: number;
}): JSX.Element {
  const { t } = props;
  const scale = props.scale ?? SCALE;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [dir, setDir] = useState<AnimDir>("s");
  const [atlas, setAtlas] = useState<PreviewAtlas | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const images = useRef(new Map<string, HTMLImageElement>());
  // The canvas each layer is tinted on (one frame), made once.
  const scratchRef = useRef<HTMLCanvasElement | undefined>(undefined);
  // The same pieces in a new object (a parent that builds it on each render) draw nothing.
  const wornRef = useRef<Worn | undefined>(undefined);
  const worn = stableWorn(wornRef.current, props.worn);
  wornRef.current = worn;

  useEffect(() => {
    let live = true;
    loadPreviewAtlas().then(
      (a) => live && setAtlas(a),
      () => live && setFailed(true), // no figure: the frame stays empty
    );
    return () => {
      live = false;
    };
  }, []);

  // The walk in place: one frame every WALK_FRAME_MS, none with reduced motion.
  useEffect(() => {
    if (reducedMotion()) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), WALK_FRAME_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx || !atlas || !props.tables) return;
    const still = reducedMotion();
    const action = still ? "idle" : "walk";
    const frame = tick % clipFrames(atlas, props.look, action);
    const draws = previewDraws(atlas, props.look, worn, dir, action, frame, props.tables);
    let scratch = scratchRef.current;
    if (!scratch) {
      scratch = document.createElement("canvas");
      scratch.width = FRAME_PX;
      scratch.height = FRAME_PX;
      scratchRef.current = scratch;
    }
    const sctx = scratch.getContext("2d");
    if (!sctx) return;
    // Page images load once; the figure is drawn again when one arrives.
    const image = (page: string): HTMLImageElement | undefined => {
      let img = images.current.get(page);
      if (!img) {
        img = new Image();
        img.onload = () => setTick((n) => n + 1);
        img.src = page;
        images.current.set(page, img);
      }
      return img.complete && img.naturalWidth > 0 ? img : undefined;
    };
    drawDoll(ctx, { ctx: sctx, canvas: scratch }, draws, image, scale, el.width, el.height);
  }, [atlas, tick, dir, scale, props.look, worn, props.tables]);

  return (
    <div
      class="look-preview"
      data-testid={props.testid ?? "look-preview"}
      data-dir={dir}
      data-atlas={atlas ? "ready" : failed ? "failed" : "loading"}
    >
      <button
        type="button"
        class="look-turn"
        aria-label={t("client.look.turn_left")}
        data-testid="look-turn-left"
        onClick={() => setDir((d) => turn(d, -1))}
      >
        ‹
      </button>
      <canvas
        ref={canvas}
        width={PREVIEW_VIEW.w * scale}
        height={PREVIEW_VIEW.h * scale}
        style={{ width: `${PREVIEW_VIEW.w * scale}px`, height: `${PREVIEW_VIEW.h * scale}px` }}
        role="img"
        aria-label={t("client.look.preview")}
      />
      <button
        type="button"
        class="look-turn"
        aria-label={t("client.look.turn_right")}
        data-testid="look-turn-right"
        onClick={() => setDir((d) => turn(d, 1))}
      >
        ›
      </button>
    </div>
  );
}
