import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@rpg/mcp-world", () => {
  it("is wired into the workspace", () => {
    expect(packageName).toBe("@rpg/mcp-world");
  });
});
