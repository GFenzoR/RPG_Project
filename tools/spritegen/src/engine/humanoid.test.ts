// The engine humanoid (docs/17 "Humanoides del motor"): proportions, the planted foot of the
// walk against the client's frames per tile, the held pieces' places in the stack against the
// model drawn as one figure, the composed figure on the ground, and data/looks.yaml against
// the layers drawn.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { LAYER_ORDER, lookLayers } from "../../../../packages/renderer/src/look.ts";
import type { LayerSlot } from "../../../../packages/renderer/src/look.ts";
import { recipePaths, recipesAt } from "../index.ts";
import { box } from "./gates.ts";
import { renderSpec } from "./render.ts";
import type { SpriteSpec } from "./spec.ts";
import { composeFrame, layerFrame } from "./specs/humanoid/compose.ts";
import type { Look, Worn } from "./specs/humanoid/compose.ts";
import {
  BEARDS,
  BUILDS,
  HAIR_STYLES,
  SEXES,
  HUMANOID_LAYERS,
  HUMANOID_PER_TILE,
  HUMANOID_PER_TILE_NS,
  HUMANOID_PER_TILE_DIAG,
  HUMANOID_DIRS,
  SHAPES,
  STRIDE,
  WALK_FRAMES,
  walkPerTile,
} from "./specs/humanoid/index.ts";
import { lookPreviews, lookTables, REPO_ROOT } from "./specs/humanoid/previews.ts";
import { BODY_PARTS } from "./specs/humanoid/skeleton.ts";
import type { Build, Sex } from "./specs/humanoid/skeleton.ts";
import { DIAGONAL_DIRS, DIAGONAL_TURN, DIRS, FACING_YAW, PROJECTION, SIZES } from "./style.ts";
import type { ActionName, Dir } from "./style.ts";

const ROOT = new URL("../../../../", import.meta.url);
const LOOKS = parseYaml(readFileSync(new URL("data/looks.yaml", ROOT), "utf8")) as Record<
  string,
  unknown
>;
const TABLES = lookTables(LOOKS);

const bodyOf = (build: string, sex: Sex = "male"): SpriteSpec => {
  const l = HUMANOID_LAYERS.find((x) => x.slot === "body" && x.shape === build && x.sex === sex);
  if (!l) throw new Error(`${sex} ${build}`);
  return l.spec;
};

/** Some parts of the body alone, nothing hiding them (the outline included). */
const partsAlone = (
  spec: SpriteSpec,
  parts: string[],
  dir: Dir,
  action = "idle",
  frame = 0,
): Image =>
  renderSpec(
    { ...spec, sprite: "test/parts", layer: { draw: parts, occlude: [] } },
    { action: action as "idle", dir, frame },
  );

const heightOf = (img: Image): number => {
  const b = box(img);
  return b ? b[3] - b[1] + 1 : 0;
};
const widthOf = (img: Image): number => {
  const b = box(img);
  return b ? b[2] - b[0] + 1 : 0;
};

describe("engine humanoid: proportions (the owner, 2026-11-19)", () => {
  for (const sex of SEXES)
    for (const build of BUILDS)
      it(`${sex} ${build}: 36-40 px from the feet to the crown, the head a sixth, shoulders`, () => {
        const spec = bodyOf(build, sex);
        for (const dir of ["s", "w"] as const) {
          // Without the 1 px outline above and below.
          const figure = heightOf(renderSpec(spec, { action: "idle", dir, frame: 0 })) - 2;
          expect(figure, `${sex} ${build} ${dir}`).toBeGreaterThanOrEqual(36);
          expect(figure, `${sex} ${build} ${dir}`).toBeLessThanOrEqual(40);
          const head = heightOf(partsAlone(spec, ["head"], dir)) - 2;
          expect(head, `${build} ${dir} head`).toBeGreaterThanOrEqual(6);
          expect(head, `${build} ${dir} head`).toBeLessThanOrEqual(7);
          expect(head / figure).toBeGreaterThan(0.14);
          expect(head / figure).toBeLessThan(0.2);
        }
        // A man's shoulders 11-13 px across; a woman's a pixel or two narrower.
        const shoulders = widthOf(partsAlone(spec, ["torso", "arm_r", "arm_l"], "s")) - 2;
        expect(shoulders).toBeGreaterThanOrEqual(sex === "male" ? 11 : 10);
        expect(shoulders).toBeLessThanOrEqual(sex === "male" ? 13 : 12);
      });

  it("the slender build is narrower than the sturdy one, on the same joints", () => {
    const trunk = (b: string): number => widthOf(partsAlone(bodyOf(b), ["torso", "pelvis"], "s"));
    expect(trunk("slender")).toBeLessThan(trunk("sturdy"));
    // Same skeleton: the heads stand on the same rows.
    const top = (b: string): number => box(partsAlone(bodyOf(b), ["head"], "s"))?.[1] ?? -1;
    expect(top("slender")).toBe(top("sturdy"));
  });

  // The owner, 2026-11-20: a man or a woman, told apart at a glance at the game's scale.
  for (const build of BUILDS)
    it(`a ${build} woman reads apart from a ${build} man: narrower shoulders, a waist, wider hips, on the same joints`, () => {
      const man = bodyOf(build, "male");
      const woman = bodyOf(build, "female");
      // The trunk facing south, row by row (pixels across), shoulders to hips.
      const rows = (spec: SpriteSpec): number[] => {
        const img = partsAlone(spec, ["torso", "pelvis"], "s");
        const b = box(img);
        const out: number[] = [];
        if (b)
          for (let y = b[1]; y <= b[3]; y++) {
            let n = 0;
            for (let x = 0; x < img.width; x++) if (img.data[(y * img.width + x) * 4 + 3]) n++;
            out.push(n);
          }
        return out;
      };
      const his = rows(man);
      const hers = rows(woman);
      // The arms hang from the same joints (a shield or a sword fits both), so her
      // shoulders are the trunk's top: a line well inside his, and never wider arms.
      const top = (r: number[]): number => r.slice(0, 4).reduce((a, n) => a + n, 0);
      expect(top(hers), `shoulders ${hers.join(",")} vs ${his.join(",")}`).toBeLessThanOrEqual(
        top(his) - 4,
      );
      const arms = (spec: SpriteSpec): number =>
        widthOf(partsAlone(spec, ["torso", "arm_r", "arm_l"], "s"));
      expect(arms(woman), "with the arms").toBeLessThanOrEqual(arms(man));
      // An hourglass: her hips (the widest row of the lower half) stand out of her waist
      // (the narrowest row above them) by more than his do, and her waist is narrower.
      const shape = (r: number[]): { waist: number; hips: number } => {
        const half = Math.floor(r.length / 2);
        const hips = Math.max(...r.slice(half));
        const at = half + r.slice(half).indexOf(hips);
        return { waist: Math.min(...r.slice(2, at)), hips };
      };
      const h = shape(his);
      const w = shape(hers);
      expect(w.waist, "waist").toBeLessThan(h.waist);
      expect(w.hips - w.waist, "hips over waist").toBeGreaterThan(h.hips - h.waist);
      // Same skeleton: the heads and the feet stand on the same rows, walking too.
      for (const part of ["head", "foot_r"])
        for (const frame of [0, 3])
          expect(box(partsAlone(woman, [part], "w", "walk", frame))?.[3], part).toBe(
            box(partsAlone(man, [part], "w", "walk", frame))?.[3],
          );
      // And the silhouettes differ by more than a few stray pixels, facing south.
      const a = renderSpec(man, { action: "idle", dir: "s", frame: 0 });
      const b = renderSpec(woman, { action: "idle", dir: "s", frame: 0 });
      let differ = 0;
      for (let i = 0; i < a.width * a.height; i++)
        if ((a.data[i * 4 + 3] ?? 0) > 0 !== (b.data[i * 4 + 3] ?? 0) > 0) differ++;
      expect(differ, "silhouette pixels that differ").toBeGreaterThanOrEqual(12);
    });

  it("is smaller than the 46 px LPC person it replaces and fits the humanoid size class", () => {
    expect(SIZES.humanoid.height[1]).toBeLessThan(46);
  });
});

describe("engine humanoid: the stride rule (the planted foot holds)", () => {
  it("derives the frames per tile from the stride: a cycle per tile, longer facing north or south", () => {
    expect(HUMANOID_PER_TILE).toBe(walkPerTile(WALK_FRAMES, STRIDE));
    expect(HUMANOID_PER_TILE).toBe(8);
    expect(HUMANOID_PER_TILE_NS).toBeCloseTo(HUMANOID_PER_TILE / PROJECTION.depth, 1);
    // A diagonal step: a tile across and a tile down, by distance (packages/renderer anim.ts).
    expect(HUMANOID_PER_TILE_DIAG).toBeCloseTo(Math.hypot(8, HUMANOID_PER_TILE_NS), 5);
  });

  it("draws every layer in eight facings, the diagonals along the map diagonal", () => {
    expect(HUMANOID_DIRS).toEqual([...DIRS, ...DIAGONAL_DIRS]);
    for (const l of HUMANOID_LAYERS)
      for (const [action, a] of Object.entries(l.spec.actions ?? {}))
        expect(a?.dirs, `${l.sprite} ${action}`).toEqual(
          action === "death" ? ["s"] : HUMANOID_DIRS,
        );
    // One tile east and one south is 1 unit across for 1/depth of depth: 60°, not 45°.
    expect(DIAGONAL_TURN).toBeCloseTo(60, 5);
    expect(FACING_YAW.se).toBeCloseTo(120, 5);
    expect(FACING_YAW.sw).toBeCloseTo(60, 5);
    expect(FACING_YAW.nw).toBeCloseTo(300, 5);
    expect(FACING_YAW.ne).toBeCloseTo(240, 5);
  });

  // The client draws walk frame floor((steps + t) * perTile) % frames while it slides the
  // sprite 32 px per tile (packages/renderer anim.ts): between two frames the sprite moves
  // 32 / perTile px. The planted foot (its lowest rows, alone) must move back as much.
  const spec = bodyOf("sturdy");
  const contact = (foot: string, dir: Dir, frame: number): { x: number; y: number } => {
    const img = partsAlone(spec, [foot], dir, "walk", frame);
    const b = box(img);
    if (!b) throw new Error("no foot");
    let sx = 0;
    let n = 0;
    for (let y = b[3] - 1; y <= b[3]; y++)
      for (let x = 0; x < img.width; x++)
        if (img.data[(y * img.width + x) * 4 + 3]) {
          sx += x;
          n++;
        }
    return { x: sx / n, y: b[3] };
  };
  // Right foot planted in frames 0-3, the left in 4-7 (skeleton.ts walkKeys).
  const planted: [string, number[]][] = [
    ["foot_r", [0, 1, 2, 3]],
    ["foot_l", [4, 5, 6, 7]],
  ];
  for (const dir of HUMANOID_DIRS)
    it(`facing ${dir}: within 1 px of its ground point while the body passes`, () => {
      // The way the sprite slides on screen, and the frames a tile of that takes.
      const sx = dir.includes("e") ? 1 : dir.includes("w") ? -1 : 0;
      const sy = dir.includes("s") ? 1 : dir.includes("n") ? -1 : 0;
      const per =
        sx !== 0 && sy !== 0
          ? HUMANOID_PER_TILE_DIAG
          : sy !== 0
            ? HUMANOID_PER_TILE_NS
            : HUMANOID_PER_TILE;
      const step = 32 / per;
      for (const [foot, frames] of planted) {
        // Where it stands on the map: the sprite has moved f frames the way it faces.
        const ground = frames.map((f) => {
          const c = contact(foot, dir, f);
          return { x: c.x + sx * f * step, y: c.y + sy * f * step };
        });
        const first = ground[0] ?? { x: 0, y: 0 };
        for (const g of ground) {
          if (sx !== 0) expect(Math.abs(g.x - first.x), `${dir} ${foot} x`).toBeLessThanOrEqual(1);
          if (sy !== 0) expect(Math.abs(g.y - first.y), `${dir} ${foot} y`).toBeLessThanOrEqual(1);
        }
      }
    });

  it("dips at contact and rises as the leg passes under the body", () => {
    const top = (f: number): number =>
      box(renderSpec(spec, { action: "walk", dir: "w", frame: f }))?.[1] ?? 0;
    // Frames 0 and 3: the planted foot furthest from the hips; 1 and 2: under them.
    expect(top(0)).toBeGreaterThan(top(1));
    expect(top(3)).toBeGreaterThan(top(2));
  });
});

// The held pieces against the model: the figure drawn as one (the held piece's parts with
// the body and the clothes as occluders, one depth buffer) shows exactly the pixels of the
// piece a viewer should see. The client stacks layers instead (LAYER_ORDER), each with only
// the body baked in as occluder; a held piece in a place of the stack shows its pixels
// that no layer above it covers.
const layerBySprite = (sprite: string): (typeof HUMANOID_LAYERS)[number] => {
  const l = HUMANOID_LAYERS.find((x) => x.sprite === sprite);
  if (!l) throw new Error(sprite);
  return l;
};
/** Close clothes and hair; a robe and a hood; plate and a full helm. */
const HELD_ON: Record<string, string[]> = {
  citizen: [
    "worn/torso_tunic_sturdy",
    "worn/legs_trousers",
    "worn/feet_shoes",
    "humans/hair_short",
  ],
  druid: ["worn/torso_robe_sturdy", "worn/head_hood"],
  knight: [
    "worn/torso_plate_sturdy",
    "worn/legs_greaves",
    "worn/feet_sabatons",
    "worn/head_full_helm",
  ],
};
const HELD_CLIPS: ActionName[] = ["idle", "walk", "attack", "shoot", "cast"];
const opaque = (img: Image | undefined, i: number): boolean => (img?.data[i * 4 + 3] ?? 0) > 0;

interface HeldMeasure {
  /** Where the held slot is in the stack (LAYER_ORDER), among the look's layers. */
  place: number;
  /** Per place in the stack (0 = under everything), the pixels that differ from the model. */
  errors: number[];
  /** The most pixels the model shows of the piece that the stack covers, in one frame. */
  hidden: number;
}

/** One held layer (`sprite`) worn over a look's `clothes`, facing `dir`, every frame. */
function measureHeld(sprite: string, clothes: string[], dir: Dir): HeldMeasure {
  const held = layerBySprite(sprite);
  const worn = clothes.map(layerBySprite);
  const model: SpriteSpec = {
    ...held.spec,
    sprite: "test/held",
    parts: [...held.spec.parts, ...worn.flatMap((l) => l.parts)],
    layer: {
      draw: held.parts.map((p) => p.name),
      occlude: [...BODY_PARTS, ...worn.flatMap((l) => l.parts.map((p) => p.name))],
    },
  };
  // The look's layers back to front without the held one, and the held one's place.
  const order = LAYER_ORDER[dir];
  const below = [layerBySprite("humans/body_sturdy"), ...worn].sort(
    (a, b) => order.indexOf(a.slot as LayerSlot) - order.indexOf(b.slot as LayerSlot),
  );
  const place = below.filter(
    (l) => order.indexOf(l.slot as LayerSlot) < order.indexOf(held.slot as LayerSlot),
  ).length;
  const errors = new Array<number>(below.length + 1).fill(0);
  let hidden = 0;
  for (const action of HELD_CLIPS)
    for (let f = 0; f < (held.spec.actions?.[action]?.frames ?? 0); f++) {
      const truth = renderSpec(model, { action, dir, frame: f });
      const piece = layerFrame(sprite, action, dir, f);
      const stack = below.map((l) => layerFrame(l.sprite, action, dir, f));
      if (!piece) throw new Error(`${sprite} ${action} ${dir} ${f}`);
      let covered = 0;
      for (let i = 0; i < piece.width * piece.height; i++) {
        const shown = opaque(truth, i);
        // The topmost layer of the look over this pixel: the piece shows above it.
        let top = -1;
        for (let k = stack.length - 1; k >= 0 && top < 0; k--) if (opaque(stack[k], i)) top = k;
        const has = opaque(piece, i);
        for (let p = 0; p < errors.length; p++)
          if ((has && p > top) !== shown) errors[p] = (errors[p] ?? 0) + 1;
        if (shown && has && place <= top) covered++;
      }
      hidden = Math.max(hidden, covered);
    }
  return { place, errors, hidden };
}

// Each direction renders every held piece over every look, frame by frame: 3.5-6 s on a
// dev machine while the whole suite runs, past vitest's 5 s default.
describe("engine humanoid: the held pieces in the stack (LAYER_ORDER)", { timeout: 30_000 }, () => {
  const HELD: Record<"weapon" | "shield", readonly string[]> = {
    weapon: SHAPES.weapon.map((s) => `worn/weapon_${s}`),
    shield: SHAPES.shield.map((s) => `worn/shield_${s}`),
  };
  for (const dir of HUMANOID_DIRS)
    it(`facing ${dir}: each held piece where the stack shows it closest to the model`, () => {
      for (const [slot, sprites] of Object.entries(HELD))
        for (const [look, clothes] of Object.entries(HELD_ON)) {
          let place = -1;
          let errors: number[] = [];
          for (const sprite of sprites) {
            const m = measureHeld(sprite, clothes, dir);
            place = m.place;
            errors = m.errors.map((e, p) => e + (errors[p] ?? 0));
            // Nothing in front of the body disappears under it or under the clothes (the
            // bow facing west, a blade raised facing north): a pixel or two of seam at most.
            if (slot === "weapon")
              expect(m.hidden, `${sprite} on the ${look} facing ${dir}`).toBeLessThanOrEqual(2);
          }
          // Over every shape of the slot and every frame, no other place in the stack draws
          // the piece more than 10 % closer to the model. The good places differ by a few
          // per cent from look to look; the weapon under the body facing west or north, as
          // it was, cost 1.3 to 3.7 times as much.
          // Facing north-west the weapon is in the far hand, mostly behind the trunk: the
          // robe and the plate would rather have it under them (over them it draws 1.35-1.45
          // times the best count of wrong pixels, the skirt over the hilt), but there a
          // raised spear vanishes 12 px into a tunic. Over everything, as facing north.
          const slack = dir === "nw" && slot === "weapon" ? 1.5 : 1.1;
          const best = Math.min(...errors);
          expect(
            errors[place],
            `${slot} on the ${look} facing ${dir}: ${errors.join("/")}`,
          ).toBeLessThanOrEqual(best * slack);
        }
    });

  it("holds the bow in the left hand and every other weapon in the right", () => {
    // What the stack has to cover in both hands (the left one is near facing west).
    for (const shape of SHAPES.weapon)
      expect(layerBySprite(`worn/weapon_${shape}`).grip?.hand, shape).toBe(
        shape === "bow" ? "l" : "r",
      );
    // Built facing west (FACING_YAW): the right hand is north, behind, facing west.
    expect(FACING_YAW.w).toBe(0);
  });
});

describe("engine humanoid: the paper doll", () => {
  const LOOKS_TO_TRY: { name: string; look: Look; worn: Worn }[] = [
    {
      name: "citizen",
      look: {
        sex: "male",
        body: "sturdy",
        skin: "fair",
        hair: "short",
        hairColor: "brown",
        beard: "none",
      },
      worn: {
        torso: { shape: "tunic", tint: "linen" },
        legs: { shape: "trousers", tint: "brown" },
        feet: { shape: "shoes", tint: "tar" },
      },
    },
    {
      name: "knight",
      look: {
        sex: "male",
        body: "sturdy",
        skin: "deep",
        hair: "crop",
        hairColor: "black",
        beard: "full",
      },
      worn: {
        head: { shape: "full_helm", tint: "steel" },
        torso: { shape: "plate", tint: "steel" },
        legs: { shape: "greaves", tint: "steel" },
        feet: { shape: "sabatons", tint: "steel" },
        shield: { shape: "tower", tint: "oak" },
        weapon: { shape: "spear", tint: "iron" },
      },
    },
    {
      name: "druid",
      look: {
        sex: "female",
        body: "slender",
        skin: "tan",
        hair: "long",
        hairColor: "grey",
        beard: "none",
      },
      worn: {
        head: { shape: "hood", tint: "moss" },
        torso: { shape: "robe", tint: "moss" },
        weapon: { shape: "staff", tint: "sapling" },
      },
    },
    {
      name: "archer",
      look: {
        sex: "female",
        body: "slender",
        skin: "olive",
        hair: "ponytail",
        hairColor: "red",
        beard: "none",
      },
      worn: {
        torso: { shape: "leather", tint: "stagleather" },
        legs: { shape: "trousers", tint: "green" },
        feet: { shape: "boots", tint: "tar" },
        weapon: { shape: "bow", tint: "yew" },
      },
    },
  ];
  for (const t of LOOKS_TO_TRY)
    it(`${t.name}: stands on the feet line, stays in its frame, reads as one figure`, () => {
      for (const dir of HUMANOID_DIRS)
        for (let f = 0; f < WALK_FRAMES; f++) {
          const img = composeFrame(t.look, t.worn, TABLES, "walk", dir, f);
          const b = box(img);
          expect(b, `${t.name} ${dir} ${f}`).toBeDefined();
          if (!b) continue;
          // Not clipped, feet on the ground row (size class `ground`), a person's height.
          expect(b[0] > 0 && b[1] > 0 && b[2] < 63 && b[3] < 63).toBe(true);
          const foot = 63 - b[3];
          expect(foot, `${t.name} ${dir} ${f} rows under the feet`).toBeGreaterThanOrEqual(1);
          expect(foot).toBeLessThanOrEqual(SIZES.humanoid.ground);
          expect(b[3] - b[1] + 1).toBeLessThanOrEqual(46);
        }
      // An attack in the weapon's hand reaches out of the standing silhouette.
      const rest = box(composeFrame(t.look, t.worn, TABLES, "idle", "w", 0));
      const swing = box(composeFrame(t.look, t.worn, TABLES, "attack", "w", 1));
      expect(swing && rest && swing[0] < rest[0]).toBe(true);
    });

  it("draws what data/looks.yaml lists, and nothing else", () => {
    const list = (k: string): string[] => (LOOKS[k] as string[] | undefined) ?? [];
    expect(list("sexes")).toEqual([...SEXES]);
    expect(list("builds")).toEqual([...BUILDS]);
    expect(list("hair_styles")).toEqual([...HAIR_STYLES]);
    expect(list("beards")).toEqual([...BEARDS]);
    const shapes = LOOKS["shapes"] as Record<string, string[]>;
    for (const [slot, names] of Object.entries(SHAPES))
      expect([...(shapes[slot] ?? [])].sort(), slot).toEqual([...names].sort());
    // Every layer drawn is one of them (the body and the torso per sex and build).
    for (const l of HUMANOID_LAYERS) {
      expect(list("sexes")).toContain(l.sex);
      if (l.slot === "body") expect(list("builds")).toContain(l.shape);
      else if (l.slot === "hair") expect(list("hair_styles")).toContain(l.shape);
      else if (l.slot === "beard") expect(list("beards")).toContain(l.shape);
      else expect(shapes[l.slot], l.sprite).toContain(l.shape);
    }
    // What a head piece hides is the client's rule, as data.
    expect((LOOKS["hides"] as Record<string, string[]>)["full_helm"]).toEqual(["hair", "beard"]);
  });
});

describe("engine humanoid: the previews of data/ (previews.ts)", () => {
  it("reads data/ under the root it is given (the CLI's --root), and only its YAML", () => {
    const root = mkdtempSync(join(tmpdir(), "spritegen-looks-"));
    try {
      mkdirSync(join(root, "data", "npcs"), { recursive: true });
      const write = (file: string, text: string): void =>
        writeFileSync(join(root, "data", file), text);
      write("looks.yaml", readFileSync(new URL("data/looks.yaml", ROOT), "utf8"));
      write(
        "outfits.yaml",
        "- id: tester\n  sprite: outfits/tester\n" +
          "  look: { sex: female, body: slender, skin: tan, hair: crop, hair_color: red, beard: none }\n",
      );
      const guide =
        "id: guide\nsprite: npcs/guide\n" +
        "look: { sex: male, body: sturdy, skin: fair, hair: short, hair_color: brown, beard: full }\n";
      write("npcs/guide.yaml", guide);
      // An editor's backup beside the NPCs is no NPC: no portrait for it.
      write("npcs/retired.yaml.bak", guide.replace("npcs/guide", "npcs/retired"));
      const outfit = ["n", "e", "s", "w"].map((d) => `outfits/tester/${d}_0`);
      expect(Object.keys(lookPreviews(root)).sort()).toEqual([...outfit, "npcs/guide"].sort());
      // The CLI builds and checks that root's recipes, not the repo's previews.
      const paths = recipePaths(undefined, recipesAt(root));
      expect(paths).toEqual(expect.arrayContaining([...outfit, "npcs/guide"]));
      expect(paths).not.toContain("outfits/citizen/s_0");
      expect(recipePaths(undefined, recipesAt(REPO_ROOT))).toContain("outfits/citizen/s_0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Every worn layer fits the four bodies (docs/17 "Humanoides del motor"): the shared ones
// are drawn on the sturdy man, so on another body a pixel the man hid and that body does
// not cover is a hole in the figure. Few, and only at the trunk's edge.
/**
 * The most holes a shared layer may leave in one frame (measured 2026-11-20: none on the
 * sturdy man, 2 on the slender one, as before the sex; 2 on the sturdy woman and 3 on the
 * slender one, a hood's or a staff's edge against the trunk).
 *
 * It measures one side only: a hole is a pixel where the layer is cut away because the
 * sturdy man's body covers it there and this body does not. It does not measure this body
 * showing outside a shared layer (a woman's hip under the trousers): that was checked by
 * hand (the trouser seat's radius covers both hips) and is left to the screenshots.
 */
const MAX_HOLES = 3;
/**
 * The same in a diagonal facing (measured 2026-11-24): the spear held upright facing
 * north-east, its shaft behind the trunk's edge, leaves 4 on the sturdy woman and 6 on the
 * slender one; everything else stays within MAX_HOLES.
 */
const MAX_HOLES_DIAGONAL = 6;
// Eight facings of every shared layer on four bodies: 6-8 s each on a dev machine.
describe("engine humanoid: the shared layers fit the four bodies", { timeout: 60_000 }, () => {
  const BODIES: { sex: Sex; build: Build }[] = SEXES.flatMap((sex) =>
    BUILDS.map((build) => ({ sex, build })),
  );
  const shared = HUMANOID_LAYERS.filter((l) => l.slot !== "body" && l.slot !== "torso");
  for (const { sex, build } of BODIES)
    it(`${sex} ${build}: the shared layers leave at most a few holes where the man's body hid them`, () => {
      const body = bodyOf(build, sex);
      const man = bodyOf("sturdy", "male");
      let worst = 0;
      let where = "";
      let worstDiagonal = 0;
      let whereDiagonal = "";
      for (const l of shared)
        for (const dir of HUMANOID_DIRS)
          for (const [action, frame] of [
            ["idle", 0],
            ["walk", 2],
            ["attack", 1],
            ["cast", 1],
          ] as const) {
            const piece = layerFrame(l.sprite, action, dir, frame);
            if (!piece) throw new Error(l.sprite);
            // What the layer would show over nothing: its parts drawn alone.
            const whole = renderSpec(
              {
                ...l.spec,
                sprite: "test/whole",
                layer: { draw: l.parts.map((p) => p.name), occlude: [] },
              },
              { action, dir, frame },
            );
            const his = renderSpec(man, { action, dir, frame });
            const hers = renderSpec(body, { action, dir, frame });
            let holes = 0;
            for (let i = 0; i < piece.width * piece.height; i++)
              if (opaque(whole, i) && !opaque(piece, i) && opaque(his, i) && !opaque(hers, i))
                holes++;
            if (DIAGONAL_DIRS.includes(dir)) {
              if (holes > worstDiagonal) {
                worstDiagonal = holes;
                whereDiagonal = `${l.sprite} ${action} ${dir} ${frame}`;
              }
            } else if (holes > worst) {
              worst = holes;
              where = `${l.sprite} ${action} ${dir} ${frame}`;
            }
          }
      expect(worst, `worst: ${where}`).toBeLessThanOrEqual(MAX_HOLES);
      expect(worstDiagonal, `worst: ${whereDiagonal}`).toBeLessThanOrEqual(MAX_HOLES_DIAGONAL);
    });
});

// Every look a player can pick has its frames: each sex, build, hair style and beard, in
// every torso shape, in every action and facing the client asks for.
// Renders every layer for every choice of data/looks.yaml: about 4.3 s while the whole
// suite runs, close to vitest's 5 s default.
describe("engine humanoid: every look has its frames", { timeout: 30_000 }, () => {
  it("draws every layer lookSprites names for every choice of data/looks.yaml", () => {
    const list = (k: string): string[] => (LOOKS[k] as string[] | undefined) ?? [];
    const shapes = LOOKS["shapes"] as Record<string, string[]>;
    const drawn = new Set(HUMANOID_LAYERS.map((l) => l.sprite));
    let looks = 0;
    for (const sex of list("sexes"))
      for (const body of list("builds"))
        for (const hair of list("hair_styles"))
          for (const beard of list("beards"))
            for (const torso of shapes["torso"] ?? []) {
              const look: Look = { sex, body, skin: "fair", hair, hairColor: "brown", beard };
              const worn: Worn = { torso: { shape: torso, tint: "linen" } };
              for (const dir of HUMANOID_DIRS) {
                const layers = lookLayers(look, worn, dir, "walk", 0, TABLES);
                for (const l of layers) expect(drawn.has(l.sprite), l.sprite).toBe(true);
              }
              looks++;
            }
    expect(looks).toBe(2 * 2 * 7 * 3 * 5);
    // And each of those layers has every frame of every clip (164 a layer: 20 per facing
    // in eight facings, and death facing south).
    for (const l of HUMANOID_LAYERS)
      for (const [action, a] of Object.entries(l.spec.actions ?? {}))
        for (const dir of a?.dirs ?? DIRS)
          for (let f = 0; f < (a?.frames ?? 0); f++)
            expect(
              layerFrame(l.sprite, action as ActionName, dir, f),
              `${l.sprite} ${action} ${dir} ${f}`,
            ).toBeDefined();
  });
});
