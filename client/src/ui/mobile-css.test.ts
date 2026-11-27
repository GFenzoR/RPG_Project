// What the style sheets promise a finger (lote 21 QA, docs/15) that only a browser sees
// otherwise: the fixes the touch audit (e2e/touch-audit.ts) asked for stay in the CSS.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const mobileCss = css("mobile.css");
const touchCss = css("touch.css");
const clientCss = css("client.css");

/** The body of the rule whose selector list is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return sheet.slice(at, sheet.indexOf("}", at));
}

/** The part of client.css under `@media (pointer: coarse)`. */
function coarse(): string {
  const at = clientCss.indexOf("@media (pointer: coarse) {");
  expect(at).toBeGreaterThanOrEqual(0);
  return clientCss.slice(at, clientCss.indexOf("\n}\n", at));
}

describe("the mobile style sheets", () => {
  it("stack the presence check and the invitations in one column, the check first", () => {
    // Each stood at a fixed height: two that came together drew one over the other.
    expect(rule(clientCss, ".alerts")).toMatch(/display:\s*contents/);
    const box = rule(mobileCss, '.game[data-ui="mobile"] .alerts');
    expect(box).toMatch(/display:\s*flex/);
    expect(box).toMatch(/flex-direction:\s*column/);
    expect(box).toMatch(/overflow-y:\s*auto/);
    expect(rule(mobileCss, '.game[data-ui="mobile"] .alerts > *')).toMatch(/position:\s*static/);
    expect(rule(mobileCss, '.game[data-ui="mobile"] .alerts > .presence')).toMatch(/order:\s*-1/);
    // On its side the column stands clear of the pad (left) and the action buttons (right).
    const side = rule(mobileCss, '.game[data-ui="mobile"][data-flow="row"] .alerts');
    expect(side).toMatch(/left:\s*11\.5rem/);
    expect(side).toMatch(/right:\s*12\.5rem/);
    // Nothing places them one by one any more.
    expect(mobileCss).not.toContain('[data-flow="row"] .guild-invitations');
    expect(mobileCss).not.toContain('[data-flow="row"] .presence');
  });

  it("take the action buttons away while the sheet or the drawer is open", () => {
    // They floated over the sheet and took the taps meant for its tabs.
    const hidden = rule(touchCss, '.game[data-ui="mobile"][data-sheet] .touch-cluster');
    expect(hidden).toMatch(/visibility:\s*hidden/);
    expect(hidden).toMatch(/pointer-events:\s*none/);
  });

  it("keep the left-handed buttons off the stick on a phone on its side", () => {
    // The row's rule set `right`; the mirror's `left` alone stretched the box across the map.
    const mirrored = rule(
      touchCss,
      '.game[data-mirror][data-ui="mobile"][data-flow="row"] .touch-cluster',
    );
    expect(mirrored).toMatch(/right:\s*auto/);
    expect(mirrored).toMatch(/left:\s*8px/);
  });

  it("hang the tutorial's hints at the left of the action buttons on a phone on its side", () => {
    const hints = rule(
      mobileCss,
      '.game[data-ui="mobile"][data-flow="row"][data-cluster] .tutorial',
    );
    expect(hints).toMatch(/right:\s*12\.5rem/);
  });

  it("move the chat log beside the pad when a phone on its side is very short", () => {
    // 748x298 on a real phone with the address bar: over the pad it left the screen.
    const at = mobileCss.indexOf("@media (max-height: 350px) {");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = mobileCss.slice(at, mobileCss.indexOf("\n}\n", at));
    expect(block).toContain('[data-flow="row"][data-pad] .chat-glance');
    expect(block).toMatch(/bottom:\s*6px/);
    expect(block).toMatch(/left:\s*196px/);
  });

  it("lay the corner of the login out as a strip above the title on a phone", () => {
    // Fixed to the corner it covered the title and the form on a real 384 px phone.
    const at = touchCss.indexOf("@media (max-width: 640px), (max-height: 500px) {");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = touchCss.slice(at, touchCss.indexOf("\n}\n", at));
    expect(block).toMatch(/\.corner \{\s*position:\s*static/);
    expect(block).toContain("env(safe-area-inset-top, 0px)");
    expect(touchCss).toMatch(
      /\.corner button,\s*\.corner select,\s*\.corner summary \{\s*min-height:\s*44px/,
    );
  });

  it("make what a finger presses 44 px wide as well as tall", () => {
    const block = coarse();
    const wide = /\.game button,\s*\.game summary,\s*\.panel button \{\s*min-width:\s*44px;/;
    expect(block).toMatch(wide);
    expect(block).toMatch(/button\.look-choice\.swatch \{\s*width:\s*44px;\s*min-width:\s*44px;/);
    // A checkbox or a radio is pressed through its label.
    expect(block).toMatch(
      /\.game label:has\(> input\[type="checkbox"\]\),[^{]*\{[^}]*min-height:\s*44px;/,
    );
    expect(block).toMatch(/\.panel summary \{\s*min-height:\s*44px;|\.panel summary \{/);
  });
});
