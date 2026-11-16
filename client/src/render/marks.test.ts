import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Skull } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { UI_ICON_BOX } from "../../../tools/spritegen/src/recipe.ts";
import { MARK_BOX, isMarkArt, markIconStyle, markSprite } from "./marks.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

describe("PvP mark sprites", () => {
  it("name one ui/marks sprite per mark and none without a mark", () => {
    expect(markSprite(Skull.AGGRESSOR)).toBe("ui/marks/aggressor");
    expect(markSprite(Skull.MURDERER)).toBe("ui/marks/murderer");
    expect(markSprite(Skull.OUTLAW)).toBe("ui/marks/outlaw");
    expect(markSprite(Skull.UNSPECIFIED)).toBeUndefined();
  });

  it("have committed art drawn by spritegen inside the box the client shows", () => {
    // The box spritegen draws the marks in (recipes/ui.ts) is the one the client cuts out.
    expect(MARK_BOX).toEqual(UI_ICON_BOX);
    for (const s of [Skull.AGGRESSOR, Skull.MURDERER, Skull.OUTLAW]) {
      const path = markSprite(s) ?? "";
      expect(existsSync(resolve(root, "assets/sprites", `${path}.png`)), path).toBe(true);
    }
  });

  it("use only real art: a placeholder square falls back to the drawn shapes", () => {
    expect(isMarkArt({ origin: "file" })).toBe(true);
    expect(isMarkArt({ origin: "vendor" })).toBe(true);
    expect(isMarkArt({ origin: "placeholder" })).toBe(false);
    expect(isMarkArt({ origin: "auto" })).toBe(false);
    expect(isMarkArt(undefined)).toBe(false);
  });

  it("cut the mark box out of the atlas page as a CSS background", () => {
    const icon = { url: "/atlas/atlas-0.png", x: 64, y: 96, width: 32, height: 32 };
    expect(markIconStyle(icon)).toEqual({
      backgroundImage: "url(/atlas/atlas-0.png)",
      backgroundPosition: "-74px -106px",
      width: "12px",
      height: "12px",
    });
    expect(markIconStyle(undefined)).toBeUndefined();
    // A sprite smaller than a mark sprite has no box to cut out.
    expect(markIconStyle({ ...icon, width: 16, height: 16 })).toBeUndefined();
  });
});
