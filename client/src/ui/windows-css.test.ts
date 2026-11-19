// What windows.css promises the desktop screen (docs/17 UI-5) that no browser-free test
// can see otherwise: the stacking of the windows against what floats over the map, the
// default place of the containers and where the invitations go.
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
    expect(body).toMatch(/--container-top:\s*min\([^;]*calc\(100% - \d+(\.\d+)?rem\)\s*\)/);
    expect(body).toMatch(/top:\s*var\(--container-top\)/);
    expect(body).toMatch(/max-height:\s*calc\(100% - var\(--container-top\)\)/);
  });

  it("opens the containers under the equipment as tall as it is now, not a guess", () => {
    // The equipment of feat/equipment-d2 is about 500 px tall: the old 15rem opened every
    // container over its backpack. GameView measures it (--containers-top, containersTop).
    const body = rule(windowsCss, '.gwin:not([data-placed])[data-window^="container-"]');
    expect(body).toMatch(/--container-top:\s*min\(\s*calc\(var\(--containers-top, 0px\) \+/);
    expect(body).not.toContain("15rem");
  });

  it("keeps the guild's invitations above the party's, and both over the windows", () => {
    // Without its own rule on the desktop, the guild's took the party's place (the
    // windowed rule is more specific than .guild-invitations) and covered its buttons.
    const party = rule(windowsCss, '.game[data-ui="windows"] .invitations');
    const guild = rule(windowsCss, '.game[data-ui="windows"] .guild-invitations');
    const bottom = (body: string): number => {
      const m = /bottom:\s*calc\(var\(--bar-px\) \+ (\d+(?:\.\d+)?)rem\)/.exec(body);
      expect(m, body).not.toBeNull();
      return Number(m?.[1]);
    };
    // One invitation is about 2.4rem tall: 3.5rem apart, as elsewhere (client.css).
    expect(bottom(guild) - bottom(party)).toBeGreaterThanOrEqual(3.5);
    // The chat at its default place reaches under them at 1280 and 960 px wide.
    expect(zIndex(windowsCss, '.game[data-ui="windows"] .invitations')).toBeGreaterThan(
      zIndex(windowsCss, ".win-layer"),
    );
  });
});
