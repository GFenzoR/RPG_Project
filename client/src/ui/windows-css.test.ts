// What windows.css promises the desktop screen (docs/17 UI-5) that no browser-free test
// can see otherwise: the stacking of the windows against what floats over the map, and
// the default place of the containers.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const windowsCss = css("windows.css");
const clientCss = css("client.css");

/** The body of the rule whose selector list is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sheet.slice(at, sheet.indexOf("}", at));
}

function zIndex(sheet: string, selector: string): number {
  const m = /z-index:\s*(-?\d+)/.exec(rule(sheet, selector));
  expect(m, `z-index of ${selector}`).not.toBeNull();
  return Number(m?.[1]);
}

describe("windows.css", () => {
  it("draws the presence check and the death screen over every window", () => {
    // The layer is a stacking context of its own (positioned, with a z-index): a window's
    // z-index (20 + its place in the stack, GameWindow) never takes it past the layer.
    expect(rule(windowsCss, ".win-layer")).toMatch(/position:\s*absolute/);
    const layer = zIndex(windowsCss, ".win-layer");
    expect(zIndex(windowsCss, '.game[data-ui="windows"] .presence')).toBeGreaterThan(layer);
    expect(zIndex(windowsCss, '.game[data-ui="windows"] .death')).toBeGreaterThan(layer);
    // Elsewhere (tablets, phones) they keep theirs.
    expect(zIndex(clientCss, ".presence")).toBeLessThan(layer);
    // The bar stays under the windows, as before.
    expect(zIndex(windowsCss, ".hud-bar")).toBeLessThan(layer);
  });

  it("keeps the title bar of a container at its default place on the screen", () => {
    // The n-th container steps down from the last: never lower than the area's bottom
    // minus a title bar, however many are open.
    const body = rule(windowsCss, '.gwin:not([data-placed])[data-window^="container-"]');
    expect(body).toMatch(/--container-top:\s*min\([^;]*calc\(100% - \d+(\.\d+)?rem\)\)/);
    expect(body).toMatch(/top:\s*var\(--container-top\)/);
    expect(body).toMatch(/max-height:\s*calc\(100% - var\(--container-top\)\)/);
  });
});
