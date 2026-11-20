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
import { LAYER_ORDER } from "../../../../packages/renderer/src/look.ts";
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
  HUMANOID_LAYERS,
  HUMANOID_PER_TILE,
  HUMANOID_PER_TILE_NS,
  SHAPES,
  STRIDE,
  WALK_FRAMES,
  walkPerTile,
} from "./specs/humanoid/index.ts";
import { lookPreviews, lookTables, REPO_ROOT } from "./specs/humanoid/previews.ts";
import { BODY_PARTS } from "./specs/humanoid/skeleton.ts";
import { DIRS, FACING_YAW, PROJECTION, SIZES } from "./style.ts";
import type { ActionName, Dir } from "./style.ts";

const ROOT = new URL("../../../../", import.meta.url);
const LOOKS = parseYaml(readFileSync(new URL("data/looks.yaml", ROOT), "utf8")) as Record<
  string,
  unknown
>;
const TABLES = lookTables(LOOKS);

const bodyOf = (build: string): SpriteSpec => {
  const l = HUMANOID_LAYERS.find((x) => x.slot === "body" && x.shape === build);
  if (!l) throw new Error(build);
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
  for (const build of BUILDS)
    it(`${build}: 36-40 px from the feet to the crown, the head a sixth, shoulders 11-13`, () => {
      const spec = bodyOf(build);
      for (const dir of ["s", "w"] as const) {
        // Without the 1 px outline above and below.
        const figure = heightOf(renderSpec(spec, { action: "idle", dir, frame: 0 })) - 2;
        expect(figure, `${build} ${dir}`).toBeGreaterThanOrEqual(36);
        expect(figure, `${build} ${dir}`).toBeLessThanOrEqual(40);
        const head = heightOf(partsAlone(spec, ["head"], dir)) - 2;
        expect(head, `${build} ${dir} head`).toBeGreaterThanOrEqual(6);
        expect(head, `${build} ${dir} head`).toBeLessThanOrEqual(7);
        expect(head / figure).toBeGreaterThan(0.14);
        expect(head / figure).toBeLessThan(0.2);
      }
      const shoulders = widthOf(partsAlone(spec, ["torso", "arm_r", "arm_l"], "s")) - 2;
      expect(shoulders).toBeGreaterThanOrEqual(11);
      expect(shoulders).toBeLessThanOrEqual(13);
    });

  it("the slender build is narrower than the sturdy one, on the same joints", () => {
    const trunk = (b: string): number => widthOf(partsAlone(bodyOf(b), ["torso", "pelvis"], "s"));
    expect(trunk("slender")).toBeLessThan(trunk("sturdy"));
    // Same skeleton: the heads stand on the same rows.
    const top = (b: string): number => box(partsAlone(bodyOf(b), ["head"], "s"))?.[1] ?? -1;
    expect(top("slender")).toBe(top("sturdy"));
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
  for (const dir of DIRS)
    it(`facing ${dir}: within 1 px of its ground point while the body passes`, () => {
      const ns = dir === "n" || dir === "s";
      const step = 32 / (ns ? HUMANOID_PER_TILE_NS : HUMANOID_PER_TILE);
      for (const [foot, frames] of planted) {
        const ground = frames.map((f) => {
          const c = contact(foot, dir, f);
          // Where it stands on the map: the sprite has moved f steps the way it faces.
          const along = dir === "w" ? -1 : dir === "e" ? 1 : dir === "n" ? -1 : 1;
          return ns ? c.y + along * f * step : c.x + along * f * step;
        });
        const first = ground[0] ?? 0;
        for (const g of ground)
          expect(Math.abs(g - first), `${dir} ${foot}`).toBeLessThanOrEqual(1);
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

describe("engine humanoid: the held pieces in the stack (LAYER_ORDER)", () => {
  const HELD: Record<"weapon" | "shield", readonly string[]> = {
    weapon: SHAPES.weapon.map((s) => `worn/weapon_${s}`),
    shield: SHAPES.shield.map((s) => `worn/shield_${s}`),
  };
  for (const dir of DIRS)
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
          const best = Math.min(...errors);
          expect(
            errors[place],
            `${slot} on the ${look} facing ${dir}: ${errors.join("/")}`,
          ).toBeLessThanOrEqual(best * 1.1);
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
      look: { body: "sturdy", skin: "fair", hair: "short", hairColor: "brown", beard: "none" },
      worn: {
        torso: { shape: "tunic", tint: "linen" },
        legs: { shape: "trousers", tint: "brown" },
        feet: { shape: "shoes", tint: "tar" },
      },
    },
    {
      name: "knight",
      look: { body: "sturdy", skin: "deep", hair: "crop", hairColor: "black", beard: "full" },
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
      look: { body: "slender", skin: "tan", hair: "long", hairColor: "grey", beard: "none" },
      worn: {
        head: { shape: "hood", tint: "moss" },
        torso: { shape: "robe", tint: "moss" },
        weapon: { shape: "staff", tint: "sapling" },
      },
    },
    {
      name: "archer",
      look: { body: "slender", skin: "olive", hair: "ponytail", hairColor: "red", beard: "none" },
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
      for (const dir of DIRS)
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
    expect(list("builds")).toEqual([...BUILDS]);
    expect(list("hair_styles")).toEqual([...HAIR_STYLES]);
    expect(list("beards")).toEqual([...BEARDS]);
    const shapes = LOOKS["shapes"] as Record<string, string[]>;
    for (const [slot, names] of Object.entries(SHAPES))
      expect([...(shapes[slot] ?? [])].sort(), slot).toEqual([...names].sort());
    // Every layer drawn is one of them (the torso per build).
    for (const l of HUMANOID_LAYERS) {
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
          "  look: { body: slender, skin: tan, hair: crop, hair_color: red, beard: none }\n",
      );
      const guide =
        "id: guide\nsprite: npcs/guide\n" +
        "look: { body: sturdy, skin: fair, hair: short, hair_color: brown, beard: full }\n";
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
