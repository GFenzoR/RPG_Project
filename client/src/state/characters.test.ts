import { describe, expect, it } from "vitest";
import {
  canCreate,
  canGoBack,
  firstView,
  kitLabel,
  kitLine,
  listLook,
  showsAccount,
} from "./characters.ts";

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

  it("keeps the account panel in reach: under the list and under the first form", () => {
    expect(showsAccount("list", 2)).toBe(true);
    expect(showsAccount("create", 0)).toBe(true); // a new account has no list to go back to
    expect(showsAccount("create", 2)).toBe(false);
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

  const name = (id: string): string => `<${id}>`;

  it("names every piece of the vocation's kit, in the data's order", () => {
    expect(kitLine(kits, "ranger", name)).toBe(
      "<short_bow>, 60 × <arrow>, <patched_tunic>, 5 × <ship_biscuit>",
    );
    expect(kitLine(kits, "guardian", name)).toBe(
      "<rusty_cutlass>, <barrel_lid_shield>, <patched_tunic>, 5 × <ship_biscuit>",
    );
  });

  it("has no line without a kit, or with an empty one", () => {
    expect(kitLine(kits, "druid", name)).toBeUndefined();
    expect(kitLine({ druid: [] }, "druid", name)).toBeUndefined();
    expect(kitLine(undefined, "ranger", name)).toBeUndefined();
  });

  it("labels counts", () => {
    const name = (id: string): string => `<${id}>`;
    expect(kitLabel({ item: "arrow", count: 60 }, name)).toBe("60 × <arrow>");
    expect(kitLabel({ item: "short_bow", count: 1 }, name)).toBe("<short_bow>");
  });
});

describe("the look of a listed character", () => {
  const choices = {
    sexes: ["male", "female"],
    builds: ["lean", "sturdy"],
    skins: ["tan", "pale"],
    hairStyles: ["crop", "long"],
    hairColors: ["grey", "black"],
    beards: ["none", "full"],
  };
  const sent = {
    sex: "female",
    body: "sturdy",
    skin: "pale",
    hair: "long",
    hair_color: "black",
    beard: "none",
  };
  it("is the server's when the content knows every id", () => {
    expect(listLook(sent, choices)).toEqual({
      sex: "female",
      body: "sturdy",
      skin: "pale",
      hair: "long",
      hairColor: "black",
      beard: "none",
    });
  });
  it("replaces an id the content no longer has by the first choice", () => {
    const look = listLook({ ...sent, skin: "retired_skin", hair: "retired_hair" }, choices);
    expect(look.skin).toBe("tan");
    expect(look.hair).toBe("crop");
    expect(look.body).toBe("sturdy");
  });
  it("passes the server's through without the choices (fixtures)", () => {
    expect(listLook({ ...sent, skin: "retired_skin" }, undefined).skin).toBe("retired_skin");
  });
});
