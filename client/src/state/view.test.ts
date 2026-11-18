import { describe, expect, it } from "vitest";
import { CLASSIC_VIEW, serverView } from "./view.ts";

describe("serverView", () => {
  it("takes the window the server says", () => {
    expect(serverView(31, 21)).toEqual({ width: 31, height: 21 });
    expect(serverView(15, 11)).toEqual({ width: 15, height: 11 });
  });

  it("falls back to the classic 15x11 for a server from before the wide view, or junk", () => {
    expect(serverView(0, 0)).toBe(CLASSIC_VIEW);
    expect(serverView(31, 0)).toBe(CLASSIC_VIEW);
    expect(serverView(1000, 21)).toBe(CLASSIC_VIEW);
    expect(serverView(31.5, 21)).toBe(CLASSIC_VIEW);
  });
});
