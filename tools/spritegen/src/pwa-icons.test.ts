import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng } from "@rpg/spritepack";
import { ICON_BACKGROUND, icon, pwaIcons } from "./pwa-icons.ts";

const pixel = (img: { width: number; data: Uint8Array }, x: number, y: number): number[] =>
  Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe("pwa icons", () => {
  it("has the sizes the manifest lists, fully opaque", () => {
    const icons = pwaIcons();
    expect([...icons.keys()].sort()).toEqual([
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
    ]);
    const sizes = Object.fromEntries([...icons].map(([n, i]) => [n, [i.width, i.height]]));
    expect(sizes["icon-192.png"]).toEqual([192, 192]);
    expect(sizes["icon-512.png"]).toEqual([512, 512]);
    expect(sizes["icon-maskable-512.png"]).toEqual([512, 512]);
    expect(sizes["apple-touch-icon.png"]).toEqual([180, 180]);
    for (const img of icons.values())
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(255);
  });

  it("keeps the maskable emblem inside the 80% safe circle", () => {
    const img = icon(512, 0.56);
    const c = 256;
    const r = 0.4 * 512;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const outside = (x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 > r * r;
        if (outside) expect(pixel(img, x, y)).toEqual([...ICON_BACKGROUND]);
      }
    }
  });

  it("matches the committed PNGs (run the script after changing the drawing)", () => {
    for (const [name, img] of pwaIcons()) {
      const file = new URL(`../../../client/public/icons/${name}`, import.meta.url);
      const committed = decodePng(readFileSync(file));
      expect(Buffer.from(encodePng(committed)).equals(encodePng(img)), name).toBe(true);
    }
  });
});
