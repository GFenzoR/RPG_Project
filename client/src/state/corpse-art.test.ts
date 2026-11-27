import { describe, expect, it } from "vitest";
import { Direction } from "@rpg/protocol";
import {
  bodyCorpse,
  corpseArt,
  corpseDir,
  corpseSprite,
  corpseSpriteIn,
  keyFallDir,
  laidRemains,
  mapItemArt,
  mapItemId,
  mapItemKey,
  mapItemTexture,
  parseMapItemKey,
  plainItemKey,
  remainsKeys,
} from "./corpse-art.ts";

const plain = { attribute: "", value: 0, refine: 0 };

describe("remainsKeys", () => {
  it("lists the remains among a tile's items: what a monster left and a player's body", () => {
    expect(remainsKeys([1, 9], undefined)).toBeUndefined();
    expect(remainsKeys(undefined, undefined)).toBeUndefined();
    expect(remainsKeys([1, 9], [undefined, plain])).toBeUndefined();
    expect(
      remainsKeys(
        [1, 40, 9, 41],
        [undefined, { ...plain, remainsOf: "wolf" }, undefined, { ...plain, bodyOf: "Ana" }],
      ),
    ).toEqual(["40@wolf", "41@body_male"]);
  });
});

describe("laidRemains", () => {
  it("says which remains a tile got, and nothing when none came", () => {
    expect(laidRemains(undefined, ["40@wolf"])).toBe("40@wolf");
    expect(laidRemains(["40@wolf"], ["40@wolf", "40@wolf"])).toBe("40@wolf");
    expect(laidRemains(["40@wolf"], ["40@wolf", "40@boar"])).toBe("40@boar");
    expect(laidRemains(["40@wolf"], ["40@wolf"])).toBeUndefined();
    expect(laidRemains(["40@wolf", "41"], ["41"])).toBeUndefined();
    expect(laidRemains(["41"], undefined)).toBeUndefined();
  });
});

describe("a corpse per direction (docs/17)", () => {
  const wolf = { ...plain, remainsOf: "wolf" };
  const ana = { ...plain, bodyOf: "Ana" };

  it("reduces the facing the server sent to the four ways a corpse lies", () => {
    expect(corpseDir(Direction.NORTH)).toBe("n");
    expect(corpseDir(Direction.EAST)).toBe("e");
    expect(corpseDir(Direction.SOUTH)).toBe("s");
    expect(corpseDir(Direction.WEST)).toBe("w");
    // The server already turns a diagonal east or west; a client does the same anyway.
    expect(corpseDir(Direction.NORTH_EAST)).toBe("e");
    expect(corpseDir(Direction.SOUTH_EAST)).toBe("e");
    expect(corpseDir(Direction.SOUTH_WEST)).toBe("w");
    expect(corpseDir(Direction.NORTH_WEST)).toBe("w");
    // An older server says nothing: south, as every corpse lay before.
    expect(corpseDir(Direction.UNSPECIFIED)).toBe("s");
    expect(corpseDir(undefined)).toBe("s");
    expect(corpseDir(99 as Direction)).toBe("s");
  });

  it("keys the remains by who fell and the way: south keeps the key it always had", () => {
    expect(mapItemKey(40, wolf)).toBe("40@wolf");
    expect(mapItemKey(40, { ...wolf, facing: Direction.SOUTH })).toBe("40@wolf");
    expect(mapItemKey(40, { ...wolf, facing: Direction.EAST })).toBe("40@wolf/e");
    expect(mapItemKey(40, { ...wolf, facing: Direction.NORTH })).toBe("40@wolf/n");
    expect(mapItemKey(40, { ...wolf, facing: Direction.WEST })).toBe("40@wolf/w");
    expect(mapItemKey(41, { ...ana, bodySex: "female", facing: Direction.WEST })).toBe(
      "41@body_female/w",
    );
    expect(mapItemKey(41, { ...ana, facing: Direction.NORTH })).toBe("41@body_male/n");
    // A plain item has no way to lie, whatever its mods say.
    expect(mapItemKey(9, { ...plain, facing: Direction.EAST })).toBe("9");
    expect(bodyCorpse("female")).toBe("body_female");
    expect(bodyCorpse(undefined)).toBe("body_male");
    expect(bodyCorpse("")).toBe("body_male");
  });

  it("reads a key back: the item, who fell and the way", () => {
    expect(parseMapItemKey("40@wolf")).toEqual({ itemId: 40, remainsOf: "wolf", dir: "s" });
    expect(parseMapItemKey("40@wolf/e")).toEqual({ itemId: 40, remainsOf: "wolf", dir: "e" });
    expect(parseMapItemKey("41@body_female/w")).toEqual({
      itemId: 41,
      remainsOf: "body_female",
      dir: "w",
    });
    expect(parseMapItemKey("40@wolf/x")).toEqual({ itemId: 40, remainsOf: "wolf", dir: "s" });
    expect(parseMapItemKey("48")).toEqual({ itemId: 48 });
    expect(keyFallDir("40@wolf")).toBe("s");
    expect(keyFallDir("40@wolf/n")).toBe("n");
    expect(keyFallDir("40@body_male/w")).toBe("w");
    expect(keyFallDir("48")).toBeUndefined();
    // Code that knows items by their number gets the number, whatever follows.
    expect(mapItemId("40@wolf/e")).toBe(40);
    expect(plainItemKey("40@wolf/e")).toBe("40");
    // Remains dragged to another tile keep their key: the same sprite, the same way.
    expect(laidRemains(undefined, ["40@wolf/e"])).toBe("40@wolf/e");
    expect(laidRemains(["40@wolf"], ["40@wolf", "40@wolf/e"])).toBe("40@wolf/e");
  });

  it("names the corpse sprite of each way, the south one with the plain path", () => {
    expect(corpseSprite("wolf")).toBe("corpses/wolf");
    expect(corpseSprite("wolf", "s")).toBe("corpses/wolf");
    expect(corpseSprite("wolf", "e")).toBe("corpses/wolf_e");
    expect(corpseSprite("body_female", "n")).toBe("corpses/body_female_n");
  });

  it("draws the corpse of the way sent, by sex, with every fallback", () => {
    const items = { 40: { sprite: "decor/remains_fur" }, 41: { sprite: "decor/remains_humanoid" } };
    const atlasOf = (...sprites: string[]) => {
      const has = new Set(sprites);
      return {
        has: (s: string) => has.has(s),
        texture: (s: string) => (has.has(s) ? `tex:${s}` : undefined),
        tileArt: () => undefined,
      };
    };
    const full = atlasOf(
      "decor/remains_fur",
      "decor/remains_humanoid",
      ...["wolf", "body_male", "body_female"].flatMap((who) =>
        (["s", "e", "n", "w"] as const).map((d) => corpseSprite(who, d)),
      ),
    );
    for (const [facing, d] of [
      [Direction.SOUTH, "s"],
      [Direction.EAST, "e"],
      [Direction.NORTH, "n"],
      [Direction.WEST, "w"],
    ] as const) {
      const key = mapItemKey(40, { ...wolf, facing });
      expect(mapItemTexture(key, items, full)).toBe(`tex:${corpseSprite("wolf", d)}`);
      expect(mapItemArt(key, items, full)).toEqual(corpseArt(`tex:${corpseSprite("wolf", d)}`));
      for (const sex of ["male", "female"]) {
        const body = mapItemKey(41, { ...ana, bodySex: sex, facing });
        expect(mapItemTexture(body, items, full)).toBe(`tex:${corpseSprite(`body_${sex}`, d)}`);
      }
      // A body of unknown sex is a man's, lying the way it fell.
      expect(mapItemTexture(mapItemKey(41, { ...ana, facing }), items, full)).toBe(
        `tex:${corpseSprite("body_male", d)}`,
      );
    }
    // An atlas from before the four ways: the south corpse for any of them.
    const old = atlasOf("decor/remains_fur", "decor/remains_humanoid", "corpses/wolf");
    expect(mapItemTexture("40@wolf/e", items, old)).toBe("tex:corpses/wolf");
    expect(mapItemArt("40@wolf/w", items, old)).toEqual(corpseArt("tex:corpses/wolf"));
    expect(corpseSpriteIn("wolf", "e", old.has)).toBe("corpses/wolf");
    expect(corpseSpriteIn("wolf", "e", full.has)).toBe("corpses/wolf_e");
    expect(corpseSpriteIn("wolf", undefined, full.has)).toBe("corpses/wolf");
    // No corpse of that monster at all: the family's remains, as before.
    expect(mapItemTexture("40@boar/n", items, old)).toBe("tex:decor/remains_fur");
    expect(mapItemTexture("41@body_female/w", items, old)).toBe("tex:decor/remains_humanoid");
    expect(corpseSpriteIn("boar", "n", old.has)).toBeUndefined();
    expect(mapItemTexture("40@boar/n", items, atlasOf())).toBeUndefined();
  });
});
