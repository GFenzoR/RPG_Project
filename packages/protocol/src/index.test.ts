import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@rpg/protocol", () => {
  it("is wired into the workspace", () => {
    expect(packageName).toBe("@rpg/protocol");
  });
});
