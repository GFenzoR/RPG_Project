import { Texture } from "pixi.js";
import type { Renderer, Sprite } from "pixi.js";
import { describe, expect, it, vi } from "vitest";
import { GLOW_RADIUS, LIGHT_SCALE, LightLayer, UNDERGROUND, isDark } from "./light-layer.ts";

describe("isDark", () => {
  it("darkens the floors under the surface only", () => {
    expect(isDark(7)).toBe(false);
    expect(isDark(6)).toBe(false);
    expect(isDark(UNDERGROUND)).toBe(true);
    expect(isDark(12)).toBe(true);
  });
});

describe("LightLayer", () => {
  const glow = new Texture();
  const renderer = (): Renderer & { render: ReturnType<typeof vi.fn> } =>
    ({ render: vi.fn() }) as unknown as Renderer & { render: ReturnType<typeof vi.fn> };
  /** The glow sprites of the light map (after the ambient fill), as drawn. */
  const glows = (l: LightLayer): Sprite[] =>
    (l as unknown as { scene: { children: Sprite[] } }).scene.children.slice(1);

  it("draws a quarter-size light map with a glow per light, over the whole screen", () => {
    const l = new LightLayer(glow);
    const r = renderer();
    l.begin(1280, 720);
    l.add(640, 360, 4 * 64, 0xffffff);
    l.add(100, 40, 3 * 64, 0xffb060);
    l.end(r);
    expect(r.render).toHaveBeenCalledTimes(1);
    expect(l.view.visible).toBe(true);
    expect(l.view.width).toBe(1280);
    expect(l.view.height).toBe(720);
    expect(l.count).toBe(2);
    const [a, b] = glows(l);
    expect(a?.position.x).toBe(640 / LIGHT_SCALE);
    expect(a?.scale.x).toBe((4 * 64) / LIGHT_SCALE / GLOW_RADIUS);
    expect(b?.tint).toBe(0xffb060);
  });

  it("reuses its glows frame after frame and hides the ones it did not use", () => {
    const l = new LightLayer(glow);
    const r = renderer();
    l.begin(640, 480);
    for (let i = 0; i < 3; i++) l.add(i * 10, 0, 32, 0xffffff);
    l.end(r);
    const before = glows(l);
    l.begin(640, 480);
    l.add(5, 5, 32, 0xffffff);
    l.end(r);
    expect(glows(l)).toEqual(before);
    expect(glows(l).map((s) => s.visible)).toEqual([true, false, false]);
    l.hide();
    expect(l.view.visible).toBe(false);
  });
});
