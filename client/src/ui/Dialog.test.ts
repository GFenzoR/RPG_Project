import { describe, expect, it } from "vitest";
import { shopCount } from "./Dialog.tsx";

describe("shopCount (playtest m8)", () => {
  it("keeps the count of a shop line between 1 and the limit, whole", () => {
    expect(shopCount("5", 100)).toBe(5);
    expect(shopCount("250", 100)).toBe(100); // the field then shows 100, not 250
    expect(shopCount("0", 100)).toBe(1);
    expect(shopCount("-3", 100)).toBe(1);
    expect(shopCount("2.7", 100)).toBe(2);
    expect(shopCount("abc", 100)).toBe(1);
    expect(shopCount("9", 4)).toBe(4); // selling: no more than owned
    expect(shopCount("9", 0)).toBe(1); // nothing owned: the button is disabled anyway
  });
});
