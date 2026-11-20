// The paper doll outside the game (docs/02 "Apariencia"): frames from the atlas pages,
// the layers in the game's order, and the tinting on a 2D canvas.
import { describe, expect, it } from "vitest";
import type { Look, LookTables } from "@rpg/renderer/look";
import { clipFrames, drawDoll, pageFrames, previewDraws, turn } from "./look-preview.ts";
import type { Ctx2D, PreviewAtlas, PreviewFrame } from "./look-preview.ts";

const LOOK: Look = {
  sex: "male",
  body: "sturdy",
  skin: "fair",
  hair: "short",
  hairColor: "red",
  beard: "none",
};
const TABLES: LookTables = {
  skins: { fair: 0xecc4a2 },
  hairColors: { red: 0xb8502c },
  tints: { iron: 0xa8aeb6 },
};

const frame = (x: number): PreviewFrame => ({
  page: "p.png",
  x,
  y: 0,
  w: 10,
  h: 20,
  ox: 27,
  oy: 30,
  sw: 64,
  sh: 64,
});

describe("the atlas frames of the doll", () => {
  it("keeps the layers' frames with where they sit in the whole frame", () => {
    const out = new Map<string, PreviewFrame>();
    pageFrames(
      "http://x/atlas/atlas-0.json",
      {
        meta: { image: "atlas-0.png" },
        frames: {
          "humans/body_sturdy/walk_s_0": {
            frame: { x: 5, y: 6, w: 20, h: 40 },
            spriteSourceSize: { x: 22, y: 18 },
            sourceSize: { w: 64, h: 64 },
          },
          "worn/weapon_sword/idle_e_1": { frame: { x: 1, y: 2, w: 3, h: 4 } },
          "ground/grass": { frame: { x: 0, y: 0, w: 32, h: 32 } },
        },
      },
      out,
    );
    expect([...out.keys()].sort()).toEqual([
      "humans/body_sturdy/walk_s_0",
      "worn/weapon_sword/idle_e_1",
    ]);
    expect(out.get("humans/body_sturdy/walk_s_0")).toEqual({
      page: "http://x/atlas/atlas-0.png",
      x: 5,
      y: 6,
      w: 20,
      h: 40,
      ox: 22,
      oy: 18,
      sw: 64,
      sh: 64,
    });
    // An untrimmed frame is the whole frame.
    expect(out.get("worn/weapon_sword/idle_e_1")).toMatchObject({ ox: 0, oy: 0, sw: 3, sh: 4 });
  });

  it("turns through the four facings both ways", () => {
    expect(turn("s", 1)).toBe("w");
    expect(turn("e", 1)).toBe("s");
    expect(turn("s", -1)).toBe("e");
    expect(turn("n", -8)).toBe("n");
    expect(turn("n", -6)).toBe("s");
  });

  it("draws the layers of the game's order that the atlas has, with their tints", () => {
    const atlas: PreviewAtlas = {
      frames: new Map([
        ["humans/body_sturdy/walk_s_3", frame(0)],
        ["humans/hair_short/walk_s_3", frame(10)],
        ["worn/weapon_sword/walk_s_3", frame(20)],
      ]),
      anims: {
        "humans/body_sturdy": {
          w: 64,
          h: 64,
          anchor: "bc",
          foot: 4,
          top: 50,
          shadow: "ellipse",
          actions: { walk: { frames: 8, ms: 0, dirs: ["n", "e", "s", "w"] } },
        },
      },
    };
    expect(clipFrames(atlas, LOOK, "walk")).toBe(8);
    expect(clipFrames(atlas, LOOK, "idle")).toBe(1);
    expect(clipFrames(atlas, { ...LOOK, body: "slender" }, "walk")).toBe(1);
    const worn = {
      weapon: { shape: "sword", tint: "iron" },
      torso: { shape: "tunic", tint: "iron" },
    };
    const draws = previewDraws(atlas, LOOK, worn, "s", "walk", 3, TABLES);
    // Facing south: body, hair, (no torso frame in this atlas), weapon.
    expect(draws.map((d) => [d.frame.x, d.tint])).toEqual([
      [0, 0xecc4a2],
      [10, 0xb8502c],
      [20, 0xa8aeb6],
    ]);
  });
});

describe("drawing the doll", () => {
  function recorder(): { ctx: Ctx2D; calls: string[] } {
    const calls: string[] = [];
    const ctx = {
      globalCompositeOperation: "source-over",
      fillStyle: "",
      imageSmoothingEnabled: true,
      clearRect: (...a: number[]) => calls.push(`clear ${a.join(",")}`),
      fillRect: () => calls.push(`fill ${String(ctx.fillStyle)} ${ctx.globalCompositeOperation}`),
      drawImage: (_img: unknown, ...a: number[]) =>
        calls.push(`draw ${ctx.globalCompositeOperation} ${a.join(",")}`),
    };
    return { ctx, calls };
  }

  it("tints each layer on the scratch canvas and lays it at the scale, unsmoothed", () => {
    const main = recorder();
    const scratch = recorder();
    const img = {} as CanvasImageSource;
    const draws = [
      { frame: frame(0), tint: 0xffffff },
      { frame: frame(10), tint: 0xb8502c },
      { frame: { ...frame(20), page: "missing.png" }, tint: 0xffffff },
    ];
    drawDoll(
      main.ctx,
      { ctx: scratch.ctx, canvas: {} as CanvasImageSource },
      draws,
      (p) => (p === "p.png" ? img : undefined),
      3,
      192,
      192,
    );
    expect(main.ctx.imageSmoothingEnabled).toBe(false);
    expect(main.calls).toEqual([
      "clear 0,0,192,192",
      // The view of the frame only (PREVIEW_VIEW), 48 px at 3x.
      "draw source-over 8,14,48,48,0,0,144,144",
      "draw source-over 8,14,48,48,0,0,144,144",
    ]);
    expect(scratch.calls).toEqual([
      // An untinted layer: drawn as it is, where it sits in the whole frame.
      "clear 0,0,64,64",
      "draw source-over 0,0,10,20,27,30,10,20",
      // A tinted one: multiplied, then cut back to its own shape.
      "clear 0,0,64,64",
      "draw source-over 10,0,10,20,27,30,10,20",
      "fill #b8502c multiply",
      "draw destination-in 10,0,10,20,27,30,10,20",
    ]);
    expect(scratch.ctx.globalCompositeOperation).toBe("source-over");
  });
});
