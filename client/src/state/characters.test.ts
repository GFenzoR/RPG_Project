import { describe, expect, it } from "vitest";
import { canCreate, canGoBack, firstView, kitLabel, ownKit } from "./characters.ts";

describe("characters screen flow", () => {
  it("goes straight to the form with no characters and to the list with one or more", () => {
    expect(firstView(0)).toBe("create");
    expect(firstView(1)).toBe("list");
    expect(firstView(3)).toBe("list");
  });

  it("offers the way back only when there is a list", () => {
    expect(canGoBack(0)).toBe(false);
    expect(canGoBack(1)).toBe(true);
  });

  it("stops creating at the account's limit", () => {
    expect(canCreate(1, 2)).toBe(true);
    expect(canCreate(2, 2)).toBe(false);
    expect(canCreate(5, undefined)).toBe(true); // unknown: the server decides
  });
});

describe("starting kit line", () => {
  const common = [
    { item: "patched_tunic", count: 1 },
    { item: "ship_biscuit", count: 5 },
  ];
  const kits = {
    guardian: [
      { item: "rusty_cutlass", count: 1 },
      { item: "barrel_lid_shield", count: 1 },
      ...common,
    ],
    ranger: [{ item: "short_bow", count: 1 }, { item: "arrow", count: 60 }, ...common],
  };

  it("lists the vocation's own pieces, not the ones every vocation gets", () => {
    expect(ownKit(kits, "guardian").map((e) => e.item)).toEqual([
      "rusty_cutlass",
      "barrel_lid_shield",
    ]);
    expect(ownKit(kits, "ranger").map((e) => e.item)).toEqual(["short_bow", "arrow"]);
    expect(ownKit(kits, "druid")).toEqual([]);
  });

  it("labels counts", () => {
    const name = (id: string): string => `<${id}>`;
    expect(kitLabel({ item: "arrow", count: 60 }, name)).toBe("60 × <arrow>");
    expect(kitLabel({ item: "short_bow", count: 1 }, name)).toBe("<short_bow>");
  });
});
