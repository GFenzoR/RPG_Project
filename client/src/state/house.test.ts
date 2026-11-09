import { create, HouseUpdateSchema } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { daysLeft, doorKey, houseActions, houseFrom } from "./house.ts";

interface Over {
  owner?: string;
  isOwner?: boolean;
  paidUntil?: bigint;
  guests?: string[];
  transferTo?: string;
  transferPrice?: bigint;
  transferForMe?: boolean;
  readOnly?: boolean;
}
const update = (over: Over = {}) =>
  create(HouseUpdateSchema, {
    open: true,
    houseId: "puerto_house_net",
    name: "house.puerto_house_net.name",
    island: "puerto",
    rent: 800n,
    periodDays: 7,
    size: 32,
    maxGuests: 20,
    items: 3,
    maxItems: 96,
    minLevel: 12,
    maxPeriods: 4,
    money: 1000n,
    ...over,
  });

describe("houseFrom", () => {
  it("closes on open = false", () => {
    expect(houseFrom(create(HouseUpdateSchema, {}))).toBeUndefined();
  });

  it("a free house can be rented", () => {
    const h = houseFrom(update());
    expect(h?.owner).toBe("");
    expect(h && houseActions(h)).toEqual({
      rent: true,
      manage: false,
      accept: false,
      enter: false,
      exit: false,
    });
  });

  it("the owner manages; the one offered the house accepts", () => {
    const own = houseFrom(
      update({ owner: "Ana", isOwner: true, paidUntil: 3n * 86_400_000n, guests: ["Beto"] }),
    );
    expect(own && houseActions(own)).toEqual({
      rent: false,
      manage: true,
      accept: false,
      enter: false,
      exit: false,
    });
    expect(own?.guests).toEqual(["Beto"]);
    expect(own && daysLeft(own, 86_400_000 + 1)).toBe(2);
    const other = houseFrom(
      update({ owner: "Ana", transferTo: "Beto", transferPrice: 80n, transferForMe: true }),
    );
    expect(other?.transfer).toEqual({ to: "Beto", price: 80, forMe: true });
    expect(other && houseActions(other)).toEqual({
      rent: false,
      manage: false,
      accept: true,
      enter: false,
      exit: false,
    });
  });

  it("read-only offers nothing", () => {
    const h = houseFrom(update({ readOnly: true }));
    expect(h && houseActions(h)).toEqual({
      rent: false,
      manage: false,
      accept: false,
      enter: false,
      exit: false,
    });
  });

  it("door keys", () => {
    expect(doorKey(3153, 6401, 7)).toBe("3153,6401,7");
  });
});
