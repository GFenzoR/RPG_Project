import { describe, expect, it } from "vitest";
import { laidRemains, remainsKeys } from "./corpse-art.ts";

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
